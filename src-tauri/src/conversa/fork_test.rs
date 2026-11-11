//! O fork da pergunta lateral (`fork`): os argumentos do CLI, o ponto estável, o contexto portátil/recorte como alternativa
//! e a origem intacta. Só fixtures e banco em memória: nenhum agente real roda aqui.

use rusqlite::Connection;

use super::api::Engine;
use super::claude_map::{launch_args, permission_mode, Start};
use super::fork::{origin_of, plan, record, Origin, Outcome, Plan, Reason};
use super::store::{self, ThreadRow, Tuning};

fn tuning(access: &str) -> Tuning {
    Tuning { model: Some("opus".into()), effort: Some("high".into()), access: access.into() }
}

fn conn() -> Connection {
    let conn = crate::database::test_db();
    store::migrate(&conn).unwrap();
    conn
}

/// Uma origem (conversa por protocolo, com sessão) e uma pergunta lateral dela.
fn with_side_chat(conn: &Connection, agent: &str, origin_access: &str, side_access: &str) {
    store::insert_thread(conn, "origem", agent, "/repo", "Origem", &tuning(origin_access), None, 1).unwrap();
    store::set_remote_id(conn, "origem", "sessao-origem").unwrap();
    store::insert_thread_with_parent(conn, "lateral", agent, "/repo", "Pergunta", &tuning(side_access), None, Some("thread:origem"), 2).unwrap();
}

fn run(conn: &Connection, id: &str, status: &str, started: i64) {
    store::upsert_run(conn, "origem", id, status, Some(started), (status != "inProgress").then_some(started + 1), None).unwrap();
}

fn origin(agent: &str) -> Origin {
    Origin { agent_id: agent.into(), account_id: None, remote_id: Some("sessao-origem".into()), working: false, last_stable_turn: Some("turno-3".into()), last_end_uuid: Some("uuid-turno-3".into()) }
}

// ---- argumentos do CLI -------------------------------------------------------------------------------------------

#[test]
fn o_claude_forka_com_resume_fork_session_e_um_id_novo_escolhido_pelo_app() {
    let conn = conn();
    with_side_chat(&conn, "claude-code", "full", "safe");
    let side: ThreadRow = store::thread(&conn, "lateral").unwrap().unwrap();
    let args = launch_args(&side, Start::Fork { from: "sessao-origem", id: "sessao-nova", at: None });
    let at = args.iter().position(|a| a == "--resume").expect("--resume");
    assert_eq!(&args[at..at + 5], ["--resume", "sessao-origem", "--fork-session", "--session-id", "sessao-nova"]);
    // só um `--session-id` (o da sessão nova) e a origem nunca vira o id da pergunta
    assert_eq!(args.iter().filter(|a| *a == "--session-id").count(), 1);
    assert!(!args.iter().any(|a| a == "--continue"));
    // sem ponto de corte, a cópia é a sessão inteira
    assert!(!args.iter().any(|a| a == "--resume-session-at"));
    // a pergunta abre com o ajuste DELA (permissão, modelo, esforço), não o da origem
    let mode = args.iter().position(|a| a == "--permission-mode").unwrap();
    assert_eq!(args[mode + 1], permission_mode("safe"));
    assert_ne!(args[mode + 1], permission_mode("full"));
    let model = args.iter().position(|a| a == "--model").unwrap();
    assert_eq!(args[model + 1], "opus");
}

#[test]
fn a_retomada_e_a_sessao_nova_continuam_sem_fork_session() {
    let conn = conn();
    with_side_chat(&conn, "claude-code", "ask", "ask");
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    for start in [Start::Resume("s-1"), Start::New("s-2")] {
        assert!(!launch_args(&side, start).iter().any(|a| a == "--fork-session"), "{start:?}");
    }
}

#[test]
fn o_thread_fork_do_codex_leva_a_origem_o_ponto_estavel_e_a_configuracao_da_pergunta() {
    let conn = conn();
    with_side_chat(&conn, "codex", "full", "ask");
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let params = super::codex::fork_params(&side, "thread-origem", Some("turno-3"));
    assert_eq!(params["threadId"], "thread-origem");
    assert_eq!(params["lastTurnId"], "turno-3");
    assert_eq!(params["excludeTurns"], true);
    assert_eq!(params["cwd"], "/repo");
    assert_eq!(params["model"], "opus");
    // a permissão é a da pergunta (supervisionada), não a da origem (acesso total)
    let (approval, sandbox) = super::codex_map::access_policy("ask");
    assert_eq!(params["approvalPolicy"], serde_json::json!(approval));
    assert_eq!(params["sandbox"], serde_json::json!(sandbox));
    let (full_approval, _) = super::codex_map::access_policy("full");
    assert_ne!(params["approvalPolicy"], serde_json::json!(full_approval));
}

#[test]
fn sem_ponto_estavel_o_thread_fork_forka_o_fim_da_thread() {
    let conn = conn();
    with_side_chat(&conn, "codex", "ask", "ask");
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    for turn in [None, Some("")] {
        let params = super::codex::fork_params(&side, "thread-origem", turn);
        assert!(params.get("lastTurnId").is_none(), "{turn:?}");
    }
}

// ---- o plano -----------------------------------------------------------------------------------------------------

#[test]
fn claude_com_a_origem_ociosa_forka_a_sessao_inteira() {
    assert_eq!(plan("claude-code", None, Some(&origin("claude-code"))), Plan::Claude { from: "sessao-origem".into(), at: None });
}

#[test]
fn claude_com_a_origem_no_meio_de_um_turno_corta_a_copia_no_ultimo_turno_concluido() {
    let working = Origin { working: true, ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&working)), Plan::Claude { from: "sessao-origem".into(), at: Some("uuid-turno-3".into()) });
}

#[test]
fn claude_no_meio_de_um_turno_sem_o_uuid_do_ponto_estavel_leva_o_contexto_portatil() {
    // primeiro turno: não há turno concluído
    let first = Origin { working: true, last_stable_turn: None, last_end_uuid: None, ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&first)), Plan::Portable(Reason::NoStableTurn));
    // há turnos, mas de antes de o app guardar o uuid: a cópia não sabe onde cortar
    let old = Origin { working: true, last_end_uuid: None, ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&old)), Plan::Portable(Reason::OriginWorking));
}

#[test]
fn codex_forka_no_ultimo_turno_terminado_mesmo_com_a_origem_trabalhando() {
    let working = Origin { working: true, ..origin("codex") };
    assert_eq!(plan("codex", None, Some(&working)), Plan::Codex { from: "sessao-origem".into(), last_turn_id: Some("turno-3".into()) });
    assert_eq!(plan("codex", None, Some(&origin("codex"))), Plan::Codex { from: "sessao-origem".into(), last_turn_id: Some("turno-3".into()) });
}

#[test]
fn codex_no_primeiro_turno_da_origem_nao_tem_ponto_estavel() {
    let first_turn = Origin { working: true, last_stable_turn: None, ..origin("codex") };
    assert_eq!(plan("codex", None, Some(&first_turn)), Plan::Portable(Reason::NoStableTurn));
    // ociosa e sem turno registrado: forka o fim da thread
    let idle = Origin { last_stable_turn: None, ..origin("codex") };
    assert_eq!(plan("codex", None, Some(&idle)), Plan::Codex { from: "sessao-origem".into(), last_turn_id: None });
}

#[test]
fn motor_sem_fork_nativo_leva_o_contexto_portatil_e_agente_sem_motor_cai_no_recorte() {
    for agent in ["opencode", "antigravity", "cursor"] {
        assert_eq!(plan(agent, None, Some(&origin(agent))), Plan::Portable(Reason::Unsupported), "{agent}");
    }
    for agent in ["gemini-cli", "agente-que-nao-existe"] {
        assert_eq!(plan(agent, None, Some(&origin(agent))), Plan::Excerpt(Reason::Unsupported), "{agent}");
    }
}

#[test]
fn a_sessao_so_abre_no_mesmo_agente_e_na_mesma_conta_da_origem_o_resto_leva_o_contexto_portatil() {
    assert_eq!(plan("codex", None, Some(&origin("claude-code"))), Plan::Portable(Reason::OtherAgent));
    // outro agente vale mesmo quando o motor da pergunta não tem fork nativo
    assert_eq!(plan("opencode", None, Some(&origin("claude-code"))), Plan::Portable(Reason::OtherAgent));
    assert_eq!(plan("claude-code", Some("conta-b"), Some(&origin("claude-code"))), Plan::Portable(Reason::OtherAccount));
    let other = Origin { account_id: Some("conta-a".into()), ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&other)), Plan::Portable(Reason::OtherAccount));
    assert_eq!(plan("claude-code", Some("conta-a"), Some(&other)), Plan::Claude { from: "sessao-origem".into(), at: None });
}

#[test]
fn origem_sem_sessao_leva_o_contexto_portatil_e_a_que_e_terminal_cai_no_recorte() {
    let no_session = Origin { remote_id: None, ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&no_session)), Plan::Portable(Reason::OriginNoSession));
    let empty = Origin { remote_id: Some(String::new()), ..origin("claude-code") };
    assert_eq!(plan("claude-code", None, Some(&empty)), Plan::Portable(Reason::OriginNoSession));
    assert_eq!(plan("claude-code", None, None), Plan::Excerpt(Reason::OriginTerminal));
    // terminal de origem e motor sem fork: o motivo é o do motor
    assert_eq!(plan("opencode", None, None), Plan::Excerpt(Reason::Unsupported));
}

#[test]
fn a_capability_de_fork_vem_da_matriz_e_so_claude_e_codex_a_declaram() {
    let declared: Vec<(&str, bool)> = ["codex", "claude-code", "opencode", "antigravity", "cursor"]
        .into_iter()
        .map(|agent| (agent, Engine::of(agent).unwrap().capabilities().session_fork))
        .collect();
    assert_eq!(declared, [("codex", true), ("claude-code", true), ("opencode", false), ("antigravity", false), ("cursor", false)]);
}

// ---- a origem no banco: o ponto estável e a origem intacta --------------------------------------------------------

#[test]
fn o_ponto_estavel_e_o_ultimo_turno_terminado_nunca_o_em_andamento() {
    let conn = conn();
    with_side_chat(&conn, "codex", "ask", "ask");
    assert_eq!(origin_of(&conn, "thread:origem").unwrap().unwrap().last_stable_turn, None);
    run(&conn, "turno-1", "completed", 10);
    run(&conn, "turno-2", "interrupted", 20);
    run(&conn, "turno-3", "inProgress", 30);
    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    assert!(origin.working);
    assert_eq!(origin.last_stable_turn.as_deref(), Some("turno-2"));
    assert_eq!(origin.remote_id.as_deref(), Some("sessao-origem"));
    // o turno fecha: o ponto estável anda
    run(&conn, "turno-3", "completed", 30);
    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    assert!(!origin.working);
    assert_eq!(origin.last_stable_turn.as_deref(), Some("turno-3"));
}

#[test]
fn o_ponto_estavel_da_origem_nao_pega_turnos_de_outra_conversa() {
    let conn = conn();
    with_side_chat(&conn, "codex", "ask", "ask");
    store::upsert_run(&conn, "lateral", "turno-da-lateral", "completed", Some(99), Some(100), None).unwrap();
    assert_eq!(origin_of(&conn, "thread:origem").unwrap().unwrap().last_stable_turn, None);
}

#[test]
fn origem_que_e_aba_de_terminal_ou_sumiu_nao_tem_origem_de_protocolo() {
    let conn = conn();
    assert_eq!(origin_of(&conn, "tab:abc").unwrap(), None);
    assert_eq!(origin_of(&conn, "thread:nao-existe").unwrap(), None);
}

/// A origem como o banco a guarda: a conversa, os turnos e os itens.
fn snapshot(conn: &Connection) -> (ThreadRow, Vec<(String, String)>, i64) {
    let row = store::thread(conn, "origem").unwrap().unwrap();
    let mut stmt = conn.prepare("SELECT id, status FROM chat_run WHERE thread_id = 'origem' ORDER BY id").unwrap();
    let runs = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    let items = conn.query_row("SELECT COUNT(*) FROM chat_item WHERE thread_id = 'origem'", [], |r| r.get(0)).unwrap();
    (row, runs, items)
}

#[test]
fn planejar_e_gravar_o_desfecho_nao_alteram_nem_interrompem_a_origem() {
    let conn = conn();
    with_side_chat(&conn, "codex", "full", "ask");
    run(&conn, "turno-1", "completed", 10);
    run(&conn, "turno-2", "inProgress", 20);
    let before = snapshot(&conn);

    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let planned = plan(&side.agent_id, side.account_id.as_deref(), Some(&origin));
    assert_eq!(planned, Plan::Codex { from: "sessao-origem".into(), last_turn_id: Some("turno-1".into()) });
    let outcome = record(&conn, "lateral", &planned, Ok(())).unwrap();

    assert_eq!(outcome, Outcome::native());
    // o turno da origem segue em andamento e nada dela mudou
    assert_eq!(snapshot(&conn), before);
    assert_eq!(store::active_turn_id(&conn, "origem").unwrap().as_deref(), Some("turno-2"));
    // só a pergunta guardou como nasceu
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode.as_deref(), side.fork_reason.as_deref()), (Some("native"), None));
}

#[test]
fn falha_ao_abrir_o_fork_vira_o_contexto_portatil_avisado_e_a_origem_segue_intacta() {
    let conn = conn();
    with_side_chat(&conn, "claude-code", "ask", "ask");
    let before = snapshot(&conn);
    let planned = Plan::Claude { from: "sessao-origem".into(), at: None };
    let outcome = record(&conn, "lateral", &planned, Err("No conversation found with session ID".into())).unwrap();
    assert_eq!(outcome, Outcome::portable(Reason::Failed));
    assert_eq!(snapshot(&conn), before);
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode.as_deref(), side.fork_reason.as_deref()), (Some("portable"), Some("failed")));
    // a pergunta segue sem sessão: o envio abre uma nova e leva o contexto portátil
    assert_eq!(side.remote_id, None);
}

#[test]
fn o_recorte_grava_o_motivo_para_a_tela_avisar() {
    let conn = conn();
    with_side_chat(&conn, "opencode", "ask", "ask");
    let outcome = record(&conn, "lateral", &Plan::Excerpt(Reason::OriginTerminal), Ok(())).unwrap();
    assert_eq!((outcome.mode.as_str(), outcome.reason.as_deref()), ("excerpt", Some("origin-terminal")));
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode.as_deref(), side.fork_reason.as_deref()), (Some("excerpt"), Some("origin-terminal")));
    // o contexto portátil também grava o motivo, com outro modo
    let outcome = record(&conn, "lateral", &Plan::Portable(Reason::OtherAgent), Ok(())).unwrap();
    assert_eq!((outcome.mode.as_str(), outcome.reason.as_deref()), ("portable", Some("other-agent")));
}

#[test]
fn os_codigos_dos_motivos_sao_estaveis_e_unicos() {
    let all = [
        Reason::Unsupported, Reason::OriginTerminal, Reason::OriginNoSession, Reason::OtherAgent,
        Reason::OtherAccount, Reason::OriginWorking, Reason::NoStableTurn, Reason::Failed,
    ];
    let codes: Vec<&str> = all.iter().map(|r| r.code()).collect();
    assert_eq!(codes, ["unsupported", "origin-terminal", "origin-no-session", "other-agent", "other-account", "origin-working", "no-stable-turn", "failed"]);
}

#[test]
fn a_migracao_das_colunas_do_fork_e_aditiva_e_roda_duas_vezes() {
    let conn = conn();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
    with_side_chat(&conn, "codex", "ask", "ask");
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode, side.fork_reason), (None, None));
}
