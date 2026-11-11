use std::sync::{Arc, Mutex};

use super::limite::*;
use super::pool::Pending;
use super::store::{self, ThreadRow, Tuning};
use crate::database::DbConnection;
use crate::missions::automation::Gate;
use crate::project_chat_defaults::{ModelChoice, ProjectChatDefaults};
use crate::runs::quota::{self, Quota, QuotaWindow};

const LIMIT_WITH_HOUR: &str = "You've hit your limit · resets 3pm (America/Sao_Paulo)";

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

fn thread(conn: &rusqlite::Connection, id: &str, agent: &str, model: Option<&str>) -> ThreadRow {
    store::insert_thread(conn, id, agent, "/p/app", "Título", &Tuning { model: model.map(str::to_owned), effort: None, access: "ask".into() }, None, 1).unwrap()
}

fn plan(thread_id: &str, at: i64, created_at_ms: i64) -> ResumePlan {
    ResumePlan { thread_id: thread_id.into(), at, created_at_ms }
}

// ── O sinal de limite ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn conta_sem_registro_ou_livre_nao_esta_sem_limite() {
    let db = db();
    let conn = db.lock().unwrap();
    assert_eq!(limited_until(&conn, "codex", None, 100), None);
    drop(conn);
    quota::record(&db, &quota::account_key("codex", None), Quota::default(), 100);
    assert_eq!(limited_until(&db.lock().unwrap(), "codex", None, 200), None);
}

#[test]
fn rejeitada_ate_uma_hora_vale_ate_ela() {
    let db = db();
    quota::record(&db, &quota::account_key("codex", None), Quota { rejected: true, rejected_until: Some(5_000), ..Quota::default() }, 100);
    let conn = db.lock().unwrap();
    assert_eq!(limited_until(&conn, "codex", None, 200), Some(5_000));
    // Passada a hora, volta a estar livre.
    assert_eq!(limited_until(&conn, "codex", None, 5_001), None);
}

#[test]
fn janela_cheia_vale_ate_a_renovacao_dela() {
    let db = db();
    let quota = Quota { five_hour: Some(QuotaWindow { utilization: 1.0, resets_at: Some(7_000) }), ..Quota::default() };
    quota::record(&db, &quota::account_key("claude-code", Some("conta-b")), quota, 100);
    let conn = db.lock().unwrap();
    assert_eq!(limited_until(&conn, "claude-code", Some("conta-b"), 200), Some(7_000));
    // O sinal é da conta: a principal do mesmo agente está livre.
    assert_eq!(limited_until(&conn, "claude-code", None, 200), None);
}

#[test]
fn rejeicao_sem_hora_vale_cinco_horas_a_partir_de_quando_foi_vista() {
    let db = db();
    quota::record(&db, &quota::account_key("codex", None), Quota { rejected: true, ..Quota::default() }, 1_000);
    let conn = db.lock().unwrap();
    assert_eq!(limited_until(&conn, "codex", None, 2_000), Some(1_000 + 5 * 3600));
    assert_eq!(limited_until(&conn, "codex", None, 1_000 + 5 * 3600 + 1), None);
}

// ── Retomar depois do limite: a decisão ───────────────────────────────────────────────────────────────────

#[test]
fn desligado_nao_agenda() {
    assert_eq!(plan_resume(false, LIMIT_WITH_HOUR, 1_000_000, 0), None);
}

#[test]
fn so_o_limite_agenda() {
    assert_eq!(plan_resume(true, "context deadline exceeded", 1_000_000, 0), None);
    assert_eq!(plan_resume(true, "401 unauthorized", 1_000_000, 0), None);
}

#[test]
fn sem_hora_de_renovacao_a_retomada_e_manual() {
    assert_eq!(plan_resume(true, "429 rate limit exceeded", 1_000_000, 0), None);
}

#[test]
fn com_a_hora_dita_agenda_para_depois_dela_com_a_margem() {
    let now = 1_000_000;
    let at = plan_resume(true, LIMIT_WITH_HOUR, now, 0).expect("tem hora");
    assert!(at > now && at - now <= 24 * 3600 + MARGIN_SECS, "{at}");
    // 3pm em UTC (offset 0): 15:00 + margem.
    assert_eq!((at - MARGIN_SECS).rem_euclid(86_400), 15 * 3600);
    // O fuso local desloca a hora do relógio.
    let em_sp = plan_resume(true, LIMIT_WITH_HOUR, now, -3 * 3600).unwrap();
    assert_eq!((em_sp - MARGIN_SECS).rem_euclid(86_400), 18 * 3600);
}

#[test]
fn o_que_o_tick_faz_com_um_plano_vencido() {
    let db = db();
    let row = thread(&db.lock().unwrap(), "t1", "codex", None);
    let p = plan("t1", 10_000, 0);
    assert_eq!(fire_decision(Some(&row), false, 0, &p, 10_001), Fire::Send);
    assert_eq!(fire_decision(Some(&row), true, 0, &p, 10_001), Fire::Wait, "turno em andamento");
    assert_eq!(fire_decision(Some(&row), false, 1, &p, 10_001), Fire::Wait, "pedido esperando resposta");
    assert_eq!(fire_decision(None, false, 0, &p, 10_001), Fire::Drop, "conversa apagada");
    let concluida = ThreadRow { state: "settled".into(), ..row.clone() };
    assert_eq!(fire_decision(Some(&concluida), false, 0, &p, 10_001), Fire::Drop, "conversa concluída");
    // Muito depois da hora marcada sem conseguir, desiste.
    assert_eq!(fire_decision(Some(&row), true, 0, &p, 10_000 + GIVE_UP_SECS + 1), Fire::Drop);
}

// ── Retomar depois do limite: o que fica gravado ──────────────────────────────────────────────────────────

#[test]
fn o_plano_sobrevive_a_reabrir_e_cancelar_apaga() {
    let db = db();
    {
        let conn = db.lock().unwrap();
        save_plan(&conn, &plan("t1", 500, 7)).unwrap();
        save_plan(&conn, &plan("t2", 900, 8)).unwrap();
        // Reagendar a mesma conversa substitui.
        save_plan(&conn, &plan("t1", 600, 9)).unwrap();
        assert_eq!(load_plan(&conn, "t1"), Some(plan("t1", 600, 9)));
        assert_eq!(all_plans(&conn).len(), 2);
    }
    cancel_resume(&db, "t1");
    let conn = db.lock().unwrap();
    assert_eq!(load_plan(&conn, "t1"), None);
    assert_eq!(load_plan(&conn, "t2"), Some(plan("t2", 900, 8)));
    // Cancelar de novo não faz nada.
    assert!(!drop_plan(&conn, "t1"));
}

#[test]
fn a_preferencia_comeca_desligada() {
    let db = db();
    assert!(!resume_enabled(&db));
    crate::database::set_setting(&db, "chat.threads.resume-after-limit", "on").unwrap();
    assert!(resume_enabled(&db));
    crate::database::set_setting(&db, "chat.threads.resume-after-limit", "off").unwrap();
    assert!(!resume_enabled(&db));
}

#[test]
fn o_tick_so_ve_o_que_venceu_e_respeita_a_pausa_da_automacao() {
    let db = db();
    {
        let conn = db.lock().unwrap();
        save_plan(&conn, &plan("vencido-novo", 1_000, 5_000)).unwrap();
        save_plan(&conn, &plan("vencido-antigo", 1_000, 100)).unwrap();
        save_plan(&conn, &plan("futuro", 99_000, 5_000)).unwrap();
    }
    // O app subiu em 1_000 ms e a pessoa ainda não retomou a automação: o armado antes do boot espera.
    let pausado = Gate { boot_ms: 1_000, resumed_at: None };
    let mut ids: Vec<String> = due_now(&db, pausado, 2_000).into_iter().map(|p| p.thread_id).collect();
    ids.sort();
    assert_eq!(ids, ["vencido-novo"]);
    // Retomada a automação, o antigo também sai.
    let retomado = Gate { boot_ms: 1_000, resumed_at: Some(1_500) };
    let mut ids = due_now(&db, retomado, 2_000).into_iter().map(|p| p.thread_id).collect::<Vec<String>>();
    ids.sort();
    assert_eq!(ids, ["vencido-antigo", "vencido-novo"]);
}

// ── O modelo reserva ──────────────────────────────────────────────────────────────────────────────────────

fn projeto(fallback: Option<(&str, Option<&str>)>) -> ProjectChatDefaults {
    ProjectChatDefaults {
        cwd: "/p/app".into(),
        primary: Some(ModelChoice { agent_id: "codex".into(), model: Some("m1".into()) }),
        fallback: fallback.map(|(agent, model)| ModelChoice { agent_id: agent.into(), model: model.map(str::to_owned) }),
        ..Default::default()
    }
}

#[test]
fn sem_reserva_nao_ha_oferta() {
    assert_eq!(fallback_target(&projeto(None), "codex", Some("m1")), None);
}

#[test]
fn reserva_de_outro_agente_ou_outro_modelo_e_oferecido() {
    let outro_agente = fallback_target(&projeto(Some(("claude-code", Some("opus")))), "codex", Some("m1")).unwrap();
    assert_eq!(outro_agente.agent_id, "claude-code");
    let outro_modelo = fallback_target(&projeto(Some(("codex", Some("m2")))), "codex", Some("m1")).unwrap();
    assert_eq!(outro_modelo.model.as_deref(), Some("m2"));
}

#[test]
fn a_conversa_que_ja_usa_o_reserva_nao_recebe_a_oferta_de_novo() {
    assert_eq!(fallback_target(&projeto(Some(("claude-code", Some("opus")))), "claude-code", Some("opus")), None);
    // Reserva sem modelo (o padrão do agente) e conversa sem modelo: é o mesmo.
    assert_eq!(fallback_target(&projeto(Some(("claude-code", None))), "claude-code", None), None);
    // Mas com um modelo explícito na conversa, o padrão do agente é outra coisa.
    assert!(fallback_target(&projeto(Some(("claude-code", None))), "claude-code", Some("sonnet")).is_some());
}

#[test]
fn a_pergunta_guardada_antes_dos_campos_novos_ainda_le() {
    // Formato de antes: sem `agentId` nem `model`.
    let antigo = r#"{"kind":"switch","to":"conta-b","toLabel":"B","request":"faça x","poolId":null}"#;
    let lido: Pending = serde_json::from_str(antigo).unwrap();
    assert_eq!((lido.agent_id, lido.model), (None, None));
    // E a nova ida e volta.
    let nova = Pending { kind: "fallback".into(), to: None, to_label: "Claude · opus".into(), request: Some("faça x".into()), pool_id: None, agent_id: Some("claude-code".into()), model: Some("opus".into()) };
    let volta: Pending = serde_json::from_str(&serde_json::to_string(&nova).unwrap()).unwrap();
    assert_eq!(volta, nova);
}
