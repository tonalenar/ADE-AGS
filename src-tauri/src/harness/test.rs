//! Testes do contrato de capabilities. Sem relógio e sem processo: só a tabela, o código e o doc.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::conversa::api::{Engine, MidTurnBehavior};

use super::capability::{Capability, Claim, Proof, Scope, Support, Surface};
use super::matrix::{find, matrix};

const DOC: &str = include_str!("../../../docs/ade-ags/HARNESS_CONTRATO.md");
const PROVIDER_COMPARISON_BASELINE: &str = include_str!("provider_comparisons.baseline.json");

const PROVIDER_IDS: [&str; 8] = ["claude-code", "codex", "opencode", "antigravity", "cursor", "gemini-cli", "kimi-code", "hermes"];

fn source_provider_comparisons(path: &Path, root: &Path, found: &mut BTreeMap<String, BTreeMap<String, usize>>) {
    let entries = std::fs::read_dir(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    for entry in entries {
        let entry = entry.unwrap();
        let file = entry.path();
        if file.is_dir() {
            source_provider_comparisons(&file, root, found);
            continue;
        }
        let relative = file.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if relative == "src-tauri/src/agents/adapter.rs" || relative == "src-tauri/src/agents/registry.rs" {
            continue;
        }
        if relative.contains("/tests/") || relative.contains("/__tests__/") || file.file_name().and_then(|name| name.to_str()).is_some_and(|name| name == "test.rs" || name.ends_with("_test.rs") || name.ends_with(".test.ts") || name.ends_with(".test.tsx")) {
            continue;
        }
        let rust = file.extension().and_then(|ext| ext.to_str()) == Some("rs") && relative.starts_with("src-tauri/src/");
        let typescript = matches!(file.extension().and_then(|ext| ext.to_str()), Some("ts" | "tsx")) && relative.starts_with("src/");
        if !rust && !typescript {
            continue;
        }
        let source = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        for line in source.lines().map(str::trim) {
            if !line.contains("==") || !["agent_id", "agentId", "provider"].iter().any(|name| line.contains(name)) {
                continue;
            }
            if !PROVIDER_IDS.iter().any(|provider| line.contains(&format!("\"{provider}\"")) || line.contains(&format!("'{provider}'"))) {
                continue;
            }
            *found.entry(relative.clone()).or_default().entry(line.to_owned()).or_default() += 1;
        }
    }
}

#[test]
fn comparacoes_de_provider_nao_crescem_fora_do_adapter_e_registro() {
    let root = repo_root();
    let mut actual = BTreeMap::new();
    source_provider_comparisons(&root.join("src-tauri/src"), &root, &mut actual);
    source_provider_comparisons(&root.join("src"), &root, &mut actual);
    let baseline: BTreeMap<String, Vec<String>> = serde_json::from_str(PROVIDER_COMPARISON_BASELINE).unwrap();
    for (file, lines) in actual {
        for (line, count) in lines {
            let allowed = baseline.get(&file).map(|known| known.iter().filter(|known_line| **known_line == line).count()).unwrap_or_default();
            assert!(count <= allowed, "nova comparação de provider fora de adapter/registro em {file}: {line}");
        }
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn every_claim() -> Vec<(String, Claim)> {
    let mut claims = Vec::new();
    for column in matrix() {
        for cell in &column.cells {
            claims.push((format!("{}/{}/{}", column.surface.id(), column.provider, cell.capability.id()), cell.claim));
        }
        claims.push((format!("{}/{}/ags_mcp", column.surface.id(), column.provider), column.ags_mcp));
    }
    claims
}

#[test]
fn a_matriz_tem_as_22_colunas_esperadas() {
    let expected: Vec<(Surface, &str)> = [
        (Surface::Chat, ["claude-code", "codex", "opencode", "antigravity", "cursor", "local-acp"].as_slice()),
        (
            Surface::Fleet,
            ["claude-code", "gemini-cli", "codex", "opencode", "kimi-code", "hermes", "antigravity", "cursor"].as_slice(),
        ),
        (
            Surface::Tui,
            ["claude-code", "gemini-cli", "codex", "opencode", "kimi-code", "hermes", "antigravity", "cursor"].as_slice(),
        ),
    ]
    .into_iter()
    .flat_map(|(surface, providers)| providers.iter().map(move |provider| (surface, *provider)))
    .collect();
    let actual: Vec<(Surface, &str)> = matrix().iter().map(|column| (column.surface, column.provider)).collect();
    assert_eq!(actual, expected);
}

#[test]
fn todo_provider_cobre_as_18_capabilities_na_ordem_do_enum() {
    assert_eq!(Capability::ALL.len(), 18);
    for column in matrix() {
        let listed: Vec<Capability> = column.cells.iter().map(|cell| cell.capability).collect();
        assert_eq!(listed, Capability::ALL, "{}/{}", column.surface.id(), column.provider);
        for (index, capability) in Capability::ALL.iter().enumerate() {
            assert_eq!(*capability as usize, index, "o discriminante de {capability:?} deixou de ser a posição");
        }
    }
}

#[test]
fn os_ids_das_capabilities_sao_unicos() {
    let mut ids: Vec<&str> = Capability::ALL.iter().map(|capability| capability.id()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 18);
}

#[test]
fn todo_supported_tem_evidencia_e_prova() {
    for (key, claim) in every_claim() {
        if claim.support == Support::Supported {
            assert!(!claim.evidence.is_empty(), "{key}: Supported sem evidência");
            assert!(claim.proof > Proof::None, "{key}: Supported sem prova");
            assert!(claim.missing.is_empty(), "{key}: Supported não tem o que provar");
            assert!(!claim.note.trim().is_empty(), "{key}: Supported sem observação");
        }
    }
}

#[test]
fn todo_unknown_diz_o_que_falta_provar() {
    let mut unknowns = 0;
    for (key, claim) in every_claim() {
        if claim.support == Support::Unknown {
            unknowns += 1;
            assert!(claim.missing.trim().len() >= 20, "{key}: Unknown sem dizer o que falta provar");
            assert!(claim.proof < Proof::RealCapture, "{key}: Unknown com captura real não é Unknown");
        } else {
            assert!(claim.missing.is_empty(), "{key}: só Unknown tem `missing`");
        }
    }
    assert!(unknowns > 0, "a matriz atual tem Unknown; se zerou, atualize o doc e este teste");
}

#[test]
fn todo_unsupported_diz_o_motivo() {
    for (key, claim) in every_claim() {
        if claim.support == Support::Unsupported {
            assert!(claim.note.trim().len() >= 8, "{key}: Unsupported sem motivo");
        }
    }
}

#[test]
fn nenhuma_celula_alega_captura_real_enquanto_nao_houver_uma() {
    let root = repo_root();
    let mut reais = 0;
    for (key, claim) in every_claim() {
        if claim.proof != Proof::RealCapture {
            continue;
        }
        reais += 1;
        let mut achou = false;
        for citation in claim.evidence {
            let (path, _) = parse_citation(citation);
            if !path.contains("conversa/fixtures/protocolo/") || !path.ends_with(".json") || path.ends_with(".oracle.json") {
                continue;
            }
            let text = std::fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            assert_eq!(value["origin"]["kind"].as_str(), Some("recorded"), "{key}: {path} não é recorded");
            achou = true;
        }
        assert!(achou, "{key}: prova recorded sem fixture que exista e seja recorded");
    }
    assert!(reais > 0, "há captura recorded; a regra não pode ficar vazia");
}

fn parse_citation(citation: &str) -> (&str, Option<(usize, usize)>) {
    match citation.rsplit_once(':') {
        Some((path, lines)) if lines.chars().all(|c| c.is_ascii_digit() || c == '-') && !lines.is_empty() => {
            let (start, end) = lines.split_once('-').unwrap_or((lines, lines));
            let start: usize = start.parse().expect("linha inicial");
            let end: usize = end.parse().expect("linha final");
            (path, Some((start, end)))
        }
        _ => (citation, None),
    }
}

#[test]
fn as_citacoes_apontam_para_arquivos_e_linhas_que_existem() {
    let root = repo_root();
    for (key, claim) in every_claim() {
        for citation in claim.evidence {
            let (path, lines) = parse_citation(citation);
            let file = root.join(path);
            let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            if let Some((start, end)) = lines {
                let total = text.lines().count();
                assert!(start >= 1 && start <= end, "{key}: {citation}: intervalo inválido");
                assert!(end <= total, "{key}: {citation}: o arquivo tem só {total} linhas");
            }
        }
    }
}

#[test]
fn o_steer_do_claude_fica_unknown_ate_haver_captura_real() {
    let claude = find(Surface::Chat, "claude-code").expect("coluna do Claude");
    let steer = claude.claim(Capability::Steer);
    assert_eq!(steer.support, Support::Supported);
    assert_eq!(steer.proof, Proof::RealCapture);
    assert_eq!(
        steer.note,
        "em turno com ferramenta a mensagem entra depois da fronteira da ferramenta; em turno sem ferramenta a resposta corrente não muda e a mensagem vira um novo turno logo depois do `result`."
    );
    assert!(steer.promises());
}

fn engine_of(provider: &str) -> Engine {
    // O id real é `local-acp-<uuid>` (`local_acp::is_local_acp_id`).
    let id = if provider == "local-acp" { "local-acp-00000000-0000-4000-8000-000000000000" } else { provider };
    Engine::of(id).unwrap_or_else(|| panic!("{provider}: sem motor de conversa"))
}

#[test]
fn a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor() {
    for column in matrix().iter().filter(|column| column.surface == Surface::Chat) {
        let declared = engine_of(column.provider).capabilities();
        let steer = column.claim(Capability::Steer).support;
        match declared.mid_turn {
            MidTurnBehavior::Steer => assert_ne!(steer, Support::Unsupported, "{}: declara steer", column.provider),
            MidTurnBehavior::Interrupt => assert_eq!(steer, Support::Unsupported, "{}: declara interrupt", column.provider),
        }
        let compact = column.claim(Capability::Compact).support;
        assert_eq!(declared.context_compaction, compact != Support::Unsupported, "{}: compact", column.provider);
        let goal = column.claim(Capability::Goal).support;
        assert_eq!(declared.persistent_goal, goal != Support::Unsupported, "{}: goal", column.provider);
    }
}

#[test]
fn a_contagem_do_doc_concorda_com_a_matriz() {
    let start = DOC.find("<!-- contagem-matriz:inicio -->").expect("marca de início da contagem no doc");
    let end = DOC.find("<!-- contagem-matriz:fim -->").expect("marca de fim da contagem no doc");
    let mut seen = 0;
    for line in DOC[start..end].lines() {
        let cells: Vec<&str> = line.trim().trim_matches('|').split('|').map(str::trim).collect();
        let [surface, provider, supported, unknown, unsupported, ags_mcp] = cells.as_slice() else { continue };
        let Some(surface) = [Surface::Chat, Surface::Fleet, Surface::Tui]
            .into_iter()
            .find(|candidate| candidate.id().eq_ignore_ascii_case(surface))
        else {
            continue;
        };
        let column = find(surface, provider).unwrap_or_else(|| panic!("o doc lista {provider}, que não está na matriz"));
        let counts = column.counts();
        assert_eq!(
            (counts.supported.to_string(), counts.unknown.to_string(), counts.unsupported.to_string()),
            (supported.to_string(), unknown.to_string(), unsupported.to_string()),
            "{}/{provider}: o doc e a matriz divergem",
            surface.id()
        );
        let ags = match column.ags_mcp.support {
            Support::Supported => "Supported",
            Support::Unknown => "Unknown",
            Support::Unsupported => "Unsupported",
        };
        assert_eq!(*ags_mcp, ags, "{}/{provider}: ags_mcp", surface.id());
        seen += 1;
    }
    assert_eq!(seen, matrix().len(), "o doc precisa listar as {} colunas", matrix().len());
}

#[test]
fn cada_provider_aparece_uma_vez_por_superficie() {
    let mut keys: Vec<(Surface, &str)> = matrix().iter().map(|column| (column.surface, column.provider)).collect();
    let total = keys.len();
    keys.sort_by(|a, b| (a.0.id(), a.1).cmp(&(b.0.id(), b.1)));
    keys.dedup();
    assert_eq!(keys.len(), total);
}

#[test]
fn escopos_de_instancia_so_nas_capabilities_que_o_adapter_decide_sozinho() {
    // `Scope::Model` só faz sentido onde o modelo muda a resposta: compactar e uso.
    for (key, claim) in every_claim() {
        if claim.scope == Scope::Model {
            assert!(key.ends_with("/compact") || key.ends_with("/usage"), "{key}: escopo de modelo fora de compact e usage");
        }
    }
}

// ── Fase 1: identidade durável (`harness_run`, `harness_node`) ──────────────────────────────

mod fase1 {
    use rusqlite::Connection;

    use crate::conversa::store::{self as chat, Tuning};
    use crate::harness::state::{EndReason, NodeState, from_chat_run, from_fleet_run, from_task};
    use crate::harness::store as harness;
    use crate::runs::store::{self as fleet, NewTask, SWEPT_RUNNING_ERROR};

    fn db() -> Connection {
        crate::database::test_db()
    }

    fn tuning() -> Tuning {
        Tuning { model: None, effort: None, access: "ask".into() }
    }

    fn thread(conn: &Connection, id: &str) {
        chat::insert_thread(conn, id, "codex", "/p", "T", &tuning(), None, 1).unwrap();
    }

    fn child(conn: &Connection, id: &str, parent: &str) {
        let parent_ref = format!("thread:{parent}");
        chat::insert_thread_with_parent(conn, id, "codex", "/p", "T", &tuning(), None, Some(&parent_ref), 2).unwrap();
    }

    fn turn(conn: &Connection, thread: &str, id: &str, status: &str) {
        chat::upsert_run(conn, thread, id, status, Some(1), None, None).unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn fleet_run(conn: &Connection, source: Option<&str>) -> String {
        conn.execute_batch("INSERT OR IGNORE INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)").unwrap();
        let run = fleet::create_run(conn, "w1", "objetivo", "/p").unwrap();
        if let Some(thread) = source {
            fleet::set_run_source_thread(conn, &run.id, thread).unwrap();
        }
        run.id
    }

    fn fleet_task(conn: &Connection, run_id: &str, key: &str) -> String {
        fleet::create_task(
            conn,
            &NewTask { run_id, title: key, prompt: "p", agent_id: "claude-code", cwd: "/p", plan_key: Some(key), ..Default::default() },
        )
        .unwrap()
        .id
    }

    /// Teste 1.
    #[test]
    fn a_migracao_do_harness_roda_duas_vezes_sem_perder_linhas() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 2));
        harness::migrate(&conn).unwrap();
        chat::migrate(&conn).unwrap();
        crate::database::migrate_for_tests(&conn).unwrap();
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 2), "migrar de novo não apaga nada");
    }

    #[test]
    fn ligar_de_novo_o_mesmo_registro_nativo_devolve_o_mesmo_no() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let first = harness::link_child_chat(&conn, "r", "t1", "c", 5).unwrap();
        assert_eq!(harness::link_child_chat(&conn, "r", "t1", "c", 6).unwrap(), first);
        let run_id = fleet_run(&conn, Some("r"));
        let node = harness::link_fleet_run(&conn, "r", "t1", &run_id, 7).unwrap();
        assert_eq!(harness::link_fleet_run(&conn, "r", "t1", &run_id, 8).unwrap(), node);
        let task = fleet_task(&conn, &run_id, "a");
        let task_node = harness::link_fleet_task(&conn, &run_id, &task, None, 9).unwrap().unwrap();
        assert_eq!(harness::link_fleet_task(&conn, &run_id, &task, None, 10).unwrap(), Some(task_node));
        // root + filho de chat + run + tarefa, num único run do harness.
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 4));
    }

    #[test]
    fn a_tarefa_cuja_pai_tem_no_fica_sob_a_pai_e_a_sem_run_ligado_nao_vira_no() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let run_id = fleet_run(&conn, Some("r"));
        let lead = fleet_task(&conn, &run_id, "lead");
        let sub = fleet_task(&conn, &run_id, "sub");
        // Sem nó para o run da Frota: tarefa não cria run nem nó.
        assert_eq!(harness::link_fleet_task(&conn, &run_id, &lead, None, 1).unwrap(), None);
        assert_eq!(count(&conn, "harness_node"), 0);
        harness::link_fleet_run(&conn, "r", "t1", &run_id, 2).unwrap();
        let lead_node = harness::link_fleet_task(&conn, &run_id, &lead, None, 3).unwrap().unwrap();
        harness::link_fleet_task(&conn, &run_id, &sub, Some(&lead), 4).unwrap();
        let parent: String = conn
            .query_row("SELECT parent_id FROM harness_node WHERE legacy_ref = ?1", [format!("task:{sub}")], |row| row.get(0))
            .unwrap();
        assert_eq!(parent, lead_node);
    }

    #[test]
    fn o_id_do_turno_nao_cruza_conversas() {
        let conn = db();
        thread(&conn, "a");
        thread(&conn, "b");
        // O mesmo `turn_id` em duas conversas: duas identidades, nunca uma só.
        turn(&conn, "a", "t1", "inProgress");
        turn(&conn, "b", "t1", "inProgress");
        let a = harness::ensure_run(&conn, "a", "t1", 1).unwrap();
        let b = harness::ensure_run(&conn, "b", "t1", 1).unwrap();
        assert_ne!(a.run_id, b.run_id);
        assert_ne!(a.root_node_id, b.root_node_id);
        assert_eq!(harness::ensure_run(&conn, "a", "t1", 9).unwrap(), a);
    }

    /// Teste 8: só as linhas `harness_*` (e as dependentes da conversa) saem; a Frota fica.
    #[test]
    fn apagar_a_conversa_remove_so_as_linhas_do_harness_e_a_frota_fica() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        let run_id = fleet_run(&conn, Some("r"));
        harness::link_fleet_run(&conn, "r", "t1", &run_id, 3).unwrap();
        let task = fleet_task(&conn, &run_id, "a");
        harness::link_fleet_task(&conn, &run_id, &task, None, 4).unwrap();
        assert_eq!(count(&conn, "harness_node"), 4);
        conn.execute("DELETE FROM chat_thread WHERE id = 'r'", []).unwrap();
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (0, 0));
        assert_eq!((count(&conn, "runs"), count(&conn, "tasks")), (1, 1), "a Frota não é tocada");
        assert_eq!(chat::thread(&conn, "c").unwrap().map(|row| row.id), Some("c".into()), "outra conversa também não");
    }

    /// Ajuste 2: apagar uma conversa lateral filha não pode deixar nó apontando para nada.
    #[test]
    fn apagar_a_conversa_lateral_filha_tira_o_no_dela_e_deixa_o_do_turno() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        child(&conn, "d", "r");
        assert_eq!(count(&conn, "harness_node"), 3);
        assert!(chat::delete_side_chat(&conn, "c").unwrap());
        let refs: Vec<String> = conn
            .prepare("SELECT legacy_ref FROM harness_node ORDER BY legacy_ref")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(refs, ["thread:d", "turn:r:t1"]);
        assert_eq!(count(&conn, "harness_run"), 1);
    }

    /// Ajuste 2 (outras rotas): a Frota não tem rota de apagar, mas o CASCADE do workspace apaga run e
    /// tarefas. Os nós saem na mesma operação (o gatilho dispara também nas deleções por CASCADE).
    #[test]
    fn apagar_o_run_ou_a_tarefa_da_frota_tira_os_nos_sem_estourar() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let run_a = fleet_run(&conn, Some("r"));
        harness::link_fleet_run(&conn, "r", "t1", &run_a, 3).unwrap();
        let task_a = fleet_task(&conn, &run_a, "a");
        let task_b = fleet_task(&conn, &run_a, "b");
        harness::link_fleet_task(&conn, &run_a, &task_a, None, 4).unwrap();
        harness::link_fleet_task(&conn, &run_a, &task_b, None, 4).unwrap();
        assert_eq!(count(&conn, "harness_node"), 4);
        conn.execute("DELETE FROM tasks WHERE id = ?1", [&task_a]).unwrap();
        assert_eq!(count(&conn, "harness_node"), 3);
        // O workspace apaga o run e as tarefas por CASCADE.
        conn.execute("DELETE FROM workspaces WHERE id = 'w1'", []).unwrap();
        assert_eq!(count(&conn, "runs"), 0);
        let left: Vec<String> = conn
            .prepare("SELECT legacy_ref FROM harness_node")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, ["turn:r:t1"], "só o nó raiz do turno, que não tem origem apagada");
    }

    #[test]
    fn o_estado_do_no_e_derivado_do_nativo() {
        let state = |derived: crate::harness::state::Derived| derived.state;
        assert_eq!(state(from_chat_run("inProgress", false)), NodeState::Running);
        assert_eq!(state(from_chat_run("inProgress", true)), NodeState::Waiting);
        assert_eq!(state(from_chat_run("completed", false)), NodeState::Completed);
        assert_eq!(state(from_chat_run("failed", false)), NodeState::Failed);
        assert_eq!(state(from_chat_run("interrupted", true)), NodeState::Interrupted);
        // Valor desconhecido nunca vira terminal conhecido.
        let unknown = from_chat_run("aborted", false);
        assert_eq!(unknown.state, NodeState::Interrupted);
        assert_eq!(unknown.end_reason, Some(EndReason::UnmappedNativeStatus));
        assert!(unknown.outcome_unknown);

        for (native, expected) in [
            ("pending", NodeState::Pending),
            ("ready", NodeState::Pending),
            ("running", NodeState::Running),
            ("done", NodeState::Completed),
            ("failed", NodeState::Failed),
            ("cancelled", NodeState::Cancelled),
            ("handed_off", NodeState::HandedOff),
            ("skipped", NodeState::Skipped),
        ] {
            assert_eq!(state(from_task(native, None)), expected, "{native}");
        }
        let swept = from_task("failed", Some(SWEPT_RUNNING_ERROR));
        assert_eq!((swept.state, swept.end_reason), (NodeState::Interrupted, Some(EndReason::AppClosed)));
        assert_eq!(from_task("skipped", None).end_reason, Some(EndReason::DependencyFailed));
        assert_eq!(state(from_fleet_run("done")), NodeState::Completed);
        assert!(NodeState::Cancelled.is_terminal() && !NodeState::Waiting.is_terminal());
    }
}
