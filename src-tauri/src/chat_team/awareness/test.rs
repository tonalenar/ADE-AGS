use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde_json::json;

use super::gate::{self, Busy};
use super::load::{self, Parts};
use super::overlap;
use super::queue::{self, Cond, Ctx, NewItem};

fn quiet() -> load::Load {
    load::build(Parts { supported: true, avg: [1.0, 1.0, 1.0], cores: 8, ..Parts::default() })
}

fn heavy() -> load::Load {
    load::build(Parts { supported: true, avg: [53.0, 40.0, 20.0], cores: 8, cargo_procs: 4, rustc_procs: 9, mem_free_mb: Some(512), ..Parts::default() })
}

fn busy(name: &str) -> Busy {
    Busy { member: format!("thread:{name}"), name: name.into() }
}

#[test]
fn a_carga_so_conta_como_alta_acima_de_nucleos_vezes_dois() {
    assert_eq!(load::threshold_for(8), 16.0);
    let at = |v: f64| load::build(Parts { supported: true, avg: [v, v, v], cores: 8, ..Parts::default() });
    assert!(!at(16.0).overloaded);
    assert!(at(16.1).overloaded);
    let unsupported = load::build(Parts { supported: false, avg: [99.0; 3], cores: 4, ..Parts::default() });
    assert!(!unsupported.overloaded, "sem medida nada é recusado por carga");
}

#[test]
fn o_resumo_da_carga_fala_do_que_o_orquestrador_precisa_repetir() {
    let text = heavy().summary;
    assert!(text.contains("carga 53.0 em 8 núcleos"));
    assert!(text.contains("4 compilação"));
    assert!(text.contains("pouca memória"));
    assert!(text.contains("ALTA"));
}

#[test]
fn le_o_load_do_macos_e_do_linux() {
    assert_eq!(load::parse_loadavg("{ 3.25 2.50 1.75 }\n"), Some([3.25, 2.5, 1.75]));
    assert_eq!(load::parse_loadavg("0.52 0.58 0.59 1/467 12345\n"), Some([0.52, 0.58, 0.59]));
    assert_eq!(load::parse_loadavg("lixo"), None);
}

#[test]
fn conta_compilacoes_e_soma_cpu_pelo_nome_do_executavel() {
    let ps = "  12.5 /usr/bin/cargo\n 80.0 /Users/x/.rustup/toolchains/stable/bin/rustc\n  3,0 /Applications/Cargo Cleaner.app/Contents/MacOS/cargo-cleaner\n  1.0 rustc\n  0.5 /bin/zsh\n";
    let (cpu, cargo, rustc) = load::parse_ps(ps);
    assert_eq!((cargo, rustc), (1, 2));
    assert!((cpu - 97.0).abs() < 0.001);
}

#[test]
fn le_a_memoria_livre_do_vm_stat_e_do_meminfo() {
    let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                            5000.\nPages inactive:                           500.\nPages speculative:                        100.\n";
    assert_eq!(load::parse_vm_stat(vm), Some(1600 * 16384 / 1048576));
    assert_eq!(load::parse_meminfo("MemTotal:       16384000 kB\nMemFree: 1 kB\nMemAvailable:    8192000 kB\n"), Some((16000, 8000)));
}

#[test]
fn o_limite_vem_da_configuracao_com_padrao_tres_e_faixa() {
    assert_eq!(gate::limit_from(None), 3);
    assert_eq!(gate::limit_from(Some("lixo")), 3);
    assert_eq!(gate::limit_from(Some("5")), 5);
    assert_eq!(gate::limit_from(Some("0")), 1);
    assert_eq!(gate::limit_from(Some("99")), 12);
}

#[test]
fn com_o_limite_cheio_a_recusa_diz_quem_esta_ocupando_e_como_enfileirar() {
    let refusal = gate::check(3, &[busy("A"), busy("B"), busy("C")], &quiet()).unwrap_err();
    assert_eq!(refusal.reason, gate::REASON_LIMIT);
    assert!(refusal.message.contains("limite de 3"));
    assert!(refusal.message.contains("A, B, C"));
    assert!(refusal.message.contains("team queue add"));
    assert!(gate::check(3, &[busy("A"), busy("B")], &quiet()).is_ok());
}

#[test]
fn com_a_maquina_sobrecarregada_a_recusa_explica_a_carga() {
    let refusal = gate::check(3, &[], &heavy()).unwrap_err();
    assert_eq!(refusal.reason, gate::REASON_LOAD);
    assert!(refusal.message.contains("load 53.0"));
    assert!(refusal.message.contains("--when-load-low"));
}

#[test]
fn o_limite_cheio_vence_a_carga_na_ordem_do_motivo() {
    let refusal = gate::check(1, &[busy("A")], &heavy()).unwrap_err();
    assert_eq!(refusal.reason, gate::REASON_LIMIT);
}

fn areas(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn areas_se_sobrepoem_por_segmento_de_caminho_e_glob() {
    assert_eq!(overlap::normalize("./src\\features/chat/**/*.tsx"), "src/features/chat");
    assert_eq!(overlap::shared(&areas(&["src/features/chat/**"]), &areas(&["src/features/chat/timeline.tsx"])), areas(&["src/features/chat/timeline.tsx"]));
    assert_eq!(overlap::shared(&areas(&["src/a.ts"]), &areas(&["src"])), areas(&["src/a.ts"]));
    assert!(overlap::shared(&areas(&["src/ab"]), &areas(&["src/a"])).is_empty(), "src/ab não está dentro de src/a");
    assert!(overlap::shared(&areas(&["src-tauri/**"]), &areas(&["src/**"])).is_empty());
    assert_eq!(overlap::shared(&areas(&["**"]), &areas(&["docs/x.md"])), areas(&["docs/x.md"]), "a raiz inteira cobre tudo");
}

#[test]
fn as_areas_declaradas_aceitam_virgula_e_descartam_repeticao() {
    assert_eq!(overlap::parse(&areas(&["src/a, src/b", "src/a", " "])), areas(&["src/a", "src/b"]));
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    queue::migrate(&conn).unwrap();
    conn
}

fn after(target: &str) -> Cond {
    Cond { kind: queue::KIND_MEMBER_DONE.into(), target: Some(format!("thread:{target}")), label: Some(target.into()) }
}

fn low_load() -> Cond {
    Cond { kind: queue::KIND_LOAD_LOW.into(), target: None, label: None }
}

fn add(conn: &Connection, parent: &str, conditions: &[Cond], now: i64) -> queue::Item {
    let args = json!({ "agent": "codex" });
    queue::enqueue(conn, &NewItem { parent, cwd: "/repo", title: "T", task: "faça X", args: &args, areas: &[], conditions }, now).unwrap()
}

#[test]
fn a_fila_persiste_a_tarefa_com_condicao_e_lista_na_ordem_de_chegada() {
    let conn = db();
    let a = add(&conn, "thread:o", &[after("Ana")], 10);
    let b = add(&conn, "thread:o", &[low_load()], 20);
    add(&conn, "thread:outro", &[low_load()], 15);
    let items = queue::list(&conn, Some("thread:o"), false).unwrap();
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec![a.id.as_str(), b.id.as_str()]);
    assert_eq!(items[0].conditions, vec![after("Ana")]);
    assert_eq!(items[0].args["agent"], "codex");
}

#[test]
fn tarefa_sem_condicao_nao_entra_na_fila() {
    let conn = db();
    let error = queue::enqueue(&conn, &NewItem { parent: "p", cwd: "/", title: "", task: "x", args: &json!({}), areas: &[], conditions: &[] }, 1).unwrap_err();
    assert!(error.contains("ao menos uma condição"));
}

#[test]
fn a_fila_tem_teto_por_orquestrador() {
    let conn = db();
    for n in 0..queue::MAX_PENDING {
        add(&conn, "p", &[low_load()], n as i64);
    }
    let error = queue::enqueue(&conn, &NewItem { parent: "p", cwd: "/", title: "", task: "x", args: &json!({}), areas: &[], conditions: &[low_load()] }, 99).unwrap_err();
    assert!(error.contains("team queue cancel"));
    add(&conn, "outro", &[low_load()], 1);
}

#[test]
fn cancelar_so_vale_para_o_dono_e_nunca_apaga_a_linha() {
    let conn = db();
    let item = add(&conn, "p", &[low_load()], 1);
    assert!(!queue::cancel(&conn, &item.id, Some("outro"), 2).unwrap());
    assert!(queue::cancel(&conn, &item.id, Some("p"), 2).unwrap());
    assert!(!queue::cancel(&conn, &item.id, Some("p"), 3).unwrap(), "já cancelada");
    assert_eq!(queue::get(&conn, &item.id).unwrap().unwrap().status, queue::CANCELLED);
    assert!(queue::list(&conn, Some("p"), false).unwrap().is_empty());
    assert_eq!(queue::list(&conn, Some("p"), true).unwrap().len(), 1);
}

#[test]
fn so_um_lancador_ganha_a_reserva_do_item() {
    let conn = db();
    let item = add(&conn, "p", &[low_load()], 1);
    assert!(queue::claim_launch(&conn, &item.id, 5).unwrap());
    assert!(!queue::claim_launch(&conn, &item.id, 6).unwrap());
    queue::set_thread(&conn, &item.id, "t1", 7).unwrap();
    let saved = queue::get(&conn, &item.id).unwrap().unwrap();
    assert_eq!((saved.status.as_str(), saved.thread_id.as_deref(), saved.launched_at), (queue::LAUNCHED, Some("t1"), Some(5)));
}

#[test]
fn a_migracao_e_aditiva_e_idempotente() {
    let conn = db();
    add(&conn, "p", &[low_load()], 1);
    queue::migrate(&conn).unwrap();
    queue::migrate(&conn).unwrap();
    assert_eq!(queue::list(&conn, None, true).unwrap().len(), 1);
}

#[test]
fn as_areas_declaradas_ficam_por_orquestrador() {
    let conn = db();
    queue::claim_save(&conn, "t1", "p", &areas(&["src/a"]), 1).unwrap();
    queue::claim_save(&conn, "t2", "q", &areas(&["src/b"]), 1).unwrap();
    queue::claim_save(&conn, "t3", "p", &[], 1).unwrap();
    assert_eq!(queue::claims(&conn, "p").unwrap(), vec![("t1".to_string(), areas(&["src/a"]))]);
}

#[test]
fn as_condicoes_dizem_por_que_esperam() {
    let states: HashMap<String, String> = [("thread:Ana".to_string(), "working".to_string()), ("thread:Bia".to_string(), "idle".to_string())].into();
    let branches: HashSet<String> = ["feat/x".to_string()].into();
    let busy_load = heavy();
    let ctx = Ctx { states: &states, load: &busy_load, branches: &branches };
    assert_eq!(queue::unmet(&after("Ana"), &ctx).unwrap(), "esperando Ana terminar");
    assert!(queue::unmet(&after("Bia"), &ctx).is_none(), "parado = terminou");
    assert!(queue::unmet(&after("Sumiu"), &ctx).is_none(), "conversa fechada = terminou");
    assert!(queue::unmet(&low_load(), &ctx).unwrap().contains("carga baixar (load 53.0, limite 16)"));
    let branch = |name: &str| Cond { kind: queue::KIND_BRANCH.into(), target: Some(name.into()), label: None };
    assert!(queue::unmet(&branch("feat/x"), &ctx).is_none());
    assert_eq!(queue::unmet(&branch("feat/y"), &ctx).unwrap(), "esperando o branch feat/y existir");
    let calm = quiet();
    let calm_ctx = Ctx { states: &states, load: &calm, branches: &branches };
    assert!(queue::unmet(&low_load(), &calm_ctx).is_none());
}

#[test]
fn o_item_so_lanca_quando_todas_as_condicoes_valem() {
    let conn = db();
    let item = add(&conn, "p", &[after("Ana"), low_load()], 1);
    let states: HashMap<String, String> = [("thread:Ana".to_string(), "idle".to_string())].into();
    let branches = HashSet::new();
    let busy_load = heavy();
    let calm = quiet();
    assert_eq!(queue::waiting_on(&item, &Ctx { states: &states, load: &busy_load, branches: &branches }).len(), 1);
    assert!(queue::waiting_on(&item, &Ctx { states: &states, load: &calm, branches: &branches }).is_empty());
}

#[test]
fn o_laco_so_precisa_de_relogio_quando_ha_condicao_de_carga_ou_branch() {
    let conn = db();
    let only_member = add(&conn, "p", &[after("Ana")], 1);
    assert!(!queue::needs_load_timer(&[only_member]));
    let with_load = add(&conn, "p", &[low_load()], 2);
    assert!(queue::needs_load_timer(&[with_load]));
}
