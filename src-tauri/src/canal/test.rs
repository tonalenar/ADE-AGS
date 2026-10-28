//! Testes do canal estruturado. Todas as linhas são SINTÉTICAS, escritas no formato observado nos
//! transcripts desta máquina (Claude Code 2.1.30x, codex-cli 0.163.0), sem conteúdo de conversa real.

use serde_json::json;

use super::event::{ends_with_question, parse_ts_ms, EndReason, Event, Tokens};
use super::pending::{self, Kind, Owner, Signal};
use super::state::{Phase, TabState, STALE_OPEN_MS};
use super::tail::{Tailer, BOOT_WINDOW};
use super::*;

fn line(v: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&v).unwrap()
}

fn apply_all(agent: &str, lines: &[serde_json::Value]) -> TabState {
    let mut state = TabState::default();
    for (i, l) in lines.iter().enumerate() {
        let (at, events) = parse_line(agent, &line(l.clone()));
        for e in events {
            state.apply(e, at.unwrap_or(i as i64 * 1000));
        }
    }
    state
}

// ── Claude Code ───────────────────────────────────────────────────────

fn c_user(text: &str) -> serde_json::Value {
    json!({"type":"user","isSidechain":false,"timestamp":"2026-10-22T10:00:00.000Z","message":{"role":"user","content":text},"sessionId":"s","entrypoint":"cli"})
}

fn c_tool_use(id: &str, name: &str, input: serde_json::Value) -> serde_json::Value {
    json!({"type":"assistant","isSidechain":false,"timestamp":"2026-10-22T10:00:01.000Z",
           "message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input}],
                      "stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}})
}

fn c_result(id: &str, decision: serde_json::Value) -> serde_json::Value {
    json!({"type":"user","isSidechain":false,"timestamp":"2026-10-22T10:00:05.000Z",
           "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},
           "permissionDecision":decision})
}

fn c_end(text: &str) -> serde_json::Value {
    json!({"type":"assistant","isSidechain":false,"timestamp":"2026-10-22T10:00:09.000Z",
           "message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":text}],"stop_reason":"end_turn",
                      "usage":{"input_tokens":3,"output_tokens":40,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}})
}

#[test]
fn claude_um_turno_com_ferramenta_e_fim() {
    let lines = [
        c_user("rode os testes"),
        c_tool_use("toolu_1", "Bash", json!({"command":"cargo test --lib\n# segunda linha"})),
    ];
    let state = apply_all("claude-code", &lines);
    assert_eq!(state.phase, Phase::Working);
    assert!(!state.inferred, "o prompt abriu o turno");
    assert_eq!(state.tools.len(), 1);
    assert_eq!(state.tools[0].name, "Bash");
    assert_eq!(state.tools[0].summary, "cargo test --lib", "só a primeira linha do comando");

    let mut lines = lines.to_vec();
    lines.push(c_result("toolu_1", json!({"decision":"accept","source":"user_temporary","grantScope":"once"})));
    lines.push(c_end("Pronto. Posso abrir o PR?"));
    lines.push(json!({"type":"system","subtype":"turn_duration","durationMs":9000,"timestamp":"2026-10-22T10:00:10.000Z","isSidechain":false}));
    let state = apply_all("claude-code", &lines);
    assert_eq!(state.phase, Phase::Idle);
    assert_eq!(state.end_reason, Some(EndReason::Completed));
    assert!(state.tools.is_empty());
    assert_eq!(state.last_decision.map(|d| (d.accepted, d.by_user)), Some((true, true)));
    assert!(state.ends_with_question, "a fala termina com pergunta");
    assert_eq!(state.turns, 1);
    assert_eq!(state.turn_ended_at, Some(parse_ts_ms("2026-10-22T10:00:09.000Z").unwrap()), "o turn_duration não move o fim");
}

#[test]
fn claude_linhas_repetidas_da_mesma_resposta_nao_somam_o_uso_duas_vezes() {
    let tool = c_tool_use("toolu_1", "Read", json!({"file_path":"a.rs"}));
    let state = apply_all("claude-code", &[c_user("x"), tool.clone(), tool, c_end("ok")]);
    assert_eq!(state.usage.total, Tokens { input: 13, output: 45, cached: 300, cache_write: 7 });
    assert_eq!(state.usage.last, Some(Tokens { input: 3, output: 40, cached: 200, cache_write: 0 }));
    assert_eq!(state.usage.total_scope, "observed");
}

#[test]
fn claude_esc_encerra_o_turno_como_interrompido() {
    let interrupt = json!({"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}});
    let state = apply_all("claude-code", &[c_user("x"), c_tool_use("t", "Bash", json!({"command":"sleep 99"})), interrupt]);
    assert_eq!(state.phase, Phase::Idle);
    assert_eq!(state.end_reason, Some(EndReason::Interrupted));
    assert!(state.tools.is_empty());
    assert!(!state.ends_with_question);
}

#[test]
fn claude_o_que_nao_e_prompt_nao_abre_turno() {
    let meta = json!({"type":"user","isMeta":true,"message":{"role":"user","content":"lembrete do sistema"}});
    let command = c_user("<command-name>/compact</command-name>");
    let sidechain = json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"tarefa do subagente"}});
    let attachment = json!({"type":"attachment","attachment":{"type":"hook_success"}});
    let state = apply_all("claude-code", &[meta, command, sidechain, attachment]);
    assert_eq!(state.phase, Phase::Unknown);
    assert_eq!(state.turns, 0);
}

#[test]
fn claude_ask_user_question_vira_pergunta_com_opcoes() {
    let ask = c_tool_use("toolu_q", "AskUserQuestion", json!({"questions":[{"question":"Qual banco?","options":[{"label":"SQLite"},{"label":"Postgres"}]}]}));
    let state = apply_all("claude-code", &[c_user("x"), ask.clone()]);
    let q = state.question.clone().expect("pergunta");
    assert_eq!(q.text, "Qual banco?");
    assert_eq!(q.options, vec!["SQLite", "Postgres"]);
    let state = apply_all("claude-code", &[c_user("x"), ask, c_result("toolu_q", serde_json::Value::Null)]);
    assert!(state.question.is_none(), "a resposta fecha a pergunta");
}

#[test]
fn claude_rejeicao_do_usuario_e_registrada() {
    let mut rejected = c_result("t", serde_json::Value::Null);
    rejected["toolDenialKind"] = json!("user-rejected");
    let state = apply_all("claude-code", &[c_user("x"), c_tool_use("t", "Bash", json!({"command":"rm -rf x"})), rejected]);
    assert_eq!(state.last_decision.map(|d| (d.accepted, d.by_user)), Some((false, true)));
}

#[test]
fn ferramenta_sem_prompt_visto_abre_turno_deduzido() {
    let state = apply_all("claude-code", &[c_tool_use("t", "Bash", json!({"command":"ls"}))]);
    assert_eq!(state.phase, Phase::Working);
    assert!(state.inferred);
}

// ── Codex ────────────────────────────────────────────────────────────

fn x_event(payload: serde_json::Value) -> serde_json::Value {
    json!({"timestamp":"2026-10-22T11:00:00.500Z","type":"event_msg","payload":payload})
}

fn x_item(payload: serde_json::Value) -> serde_json::Value {
    json!({"timestamp":"2026-10-22T11:00:01.000Z","type":"response_item","payload":payload})
}

#[test]
fn codex_turno_ferramenta_tokens_e_fim() {
    let lines = [
        json!({"timestamp":"2026-10-22T11:00:00.000Z","type":"session_meta","payload":{"id":"abc","cwd":"/repo","originator":"codex-tui","cli_version":"0.163.0"}}),
        x_event(json!({"type":"task_started","turn_id":"t1","started_at":1})),
        x_item(json!({"type":"custom_tool_call","status":"completed","call_id":"call_1","name":"exec","input":"git status\n"})),
    ];
    let state = apply_all("codex", &lines);
    assert_eq!(state.phase, Phase::Working);
    assert!(!state.inferred);
    assert_eq!(state.tools[0].summary, "git status");

    let mut lines = lines.to_vec();
    lines.push(x_item(json!({"type":"custom_tool_call_output","call_id":"call_1","output":"limpo"})));
    lines.push(x_event(json!({"type":"token_count","info":{
        "last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050},
        "total_token_usage":{"input_tokens":5000,"cached_input_tokens":4000,"cache_write_input_tokens":0,"output_tokens":300,"reasoning_output_tokens":20,"total_tokens":5300}}})));
    lines.push(x_event(json!({"type":"task_complete","turn_id":"t1","last_agent_message":"Feito.\nQuer que eu rode o lint?","duration_ms":900})));
    let state = apply_all("codex", &lines);
    assert_eq!(state.phase, Phase::Idle);
    assert!(state.tools.is_empty());
    assert!(state.ends_with_question);
    assert_eq!(state.usage.last, Some(Tokens { input: 200, output: 50, cached: 800, cache_write: 0 }), "input sem o cache");
    assert_eq!(state.usage.total, Tokens { input: 1000, output: 300, cached: 4000, cache_write: 0 });
    assert_eq!(state.usage.total_scope, "session");
}

#[test]
fn codex_turn_aborted_e_exec_com_argumentos_json() {
    let call = x_item(json!({"type":"function_call","call_id":"c2","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"cargo build\"]}"}));
    let state = apply_all("codex", &[x_event(json!({"type":"task_started"})), call.clone()]);
    assert_eq!(state.tools[0].summary, "bash -lc cargo build");
    let state = apply_all("codex", &[x_event(json!({"type":"task_started"})), call, x_event(json!({"type":"turn_aborted","reason":"interrupted"}))]);
    assert_eq!(state.end_reason, Some(EndReason::Interrupted));
    assert!(state.tools.is_empty());
}

#[test]
fn codex_token_count_sem_info_e_ignorado() {
    let state = apply_all("codex", &[x_event(json!({"type":"token_count","info":null,"rate_limits":{}}))]);
    assert_eq!(state.usage.last, None);
}

#[test]
fn codex_pedido_de_aprovacao_gravado_seria_lido() {
    // Não visto no 0.163 (o rollout não grava): só para uma versão que passe a gravar.
    let state = apply_all("codex", &[x_event(json!({"type":"exec_approval_request","call_id":"c9","command":["git","push"]}))]);
    assert_eq!(state.approval.as_ref().map(|a| a.summary.as_str()), Some("git push"));
}

#[test]
fn linha_sem_tipo_interessante_nem_e_decodificada() {
    assert_eq!(parse_line("codex", b"{\"type\":\"turn_context\",\"payload\":{}}").1, vec![]);
    assert_eq!(parse_line("claude-code", b"lixo que nem e json \"type\":\"user\"").1, vec![]);
    assert_eq!(parse_line("opencode", b"{\"type\":\"user\"}").1, vec![]);
}

// ── Funções puras ─────────────────────────────────────────────────────

#[test]
fn pergunta_no_fim_da_fala() {
    assert!(ends_with_question("Fiz X.\n\nPosso commitar?"));
    assert!(ends_with_question("Posso seguir? **"));
    assert!(!ends_with_question("Você pergunta: funciona?\nSim, funciona."));
    assert!(!ends_with_question("Pronto.\n```\nquem?\n```"), "pergunta dentro de código não conta");
}

#[test]
fn carimbo_com_milissegundos() {
    assert_eq!(parse_ts_ms("1970-01-01T00:00:01.250Z"), Some(1250));
    assert_eq!(parse_ts_ms("1970-01-01T00:00:01Z"), Some(1000));
    assert_eq!(parse_ts_ms("1970-01-01T00:00:01.5Z"), Some(1500));
    assert_eq!(parse_ts_ms("ontem"), None);
}

#[test]
fn turno_aberto_com_arquivo_parado_vira_nao_sei() {
    let mut state = TabState::default();
    state.apply(Event::TurnStarted, 0);
    assert_eq!(state.effective_phase(0, STALE_OPEN_MS), Phase::Working);
    assert_eq!(state.effective_phase(0, STALE_OPEN_MS + 1), Phase::Unknown);
    state.apply(Event::TurnEnded { reason: EndReason::Completed, text: None }, 1);
    assert_eq!(state.effective_phase(0, STALE_OPEN_MS * 10), Phase::Idle, "ocioso não envelhece");
}

#[test]
fn o_modo_vem_do_ambiente_depois_da_configuracao_e_o_padrao_e_veto() {
    assert_eq!(mode_from(None, None), Mode::Veto);
    assert_eq!(mode_from(None, Some("full")), Mode::Full);
    assert_eq!(mode_from(Some("off"), Some("full")), Mode::Off);
    assert_eq!(mode_from(Some("???"), Some("autoritativo")), Mode::Full);
}

fn snap(phase_open: bool, grew_at: i64) -> Snapshot {
    let mut state = TabState::default();
    state.apply(if phase_open { Event::TurnStarted } else { Event::TurnEnded { reason: EndReason::Completed, text: None } }, 0);
    Snapshot { tab_id: "t".into(), agent_id: "codex".into(), session_id: "s".into(), path: String::new(), mode: Mode::Veto, phase: state.phase, stale: false, grew_at, state }
}

#[test]
fn ocupado_so_com_turno_aberto_recente_e_modo_ligado() {
    let open = snap(true, 0);
    assert!(busy_in(Some(&open), Mode::Veto, 1000));
    assert!(busy_in(Some(&open), Mode::Full, 1000));
    assert!(!busy_in(Some(&open), Mode::Off, 1000), "desligado nunca segura");
    assert!(!busy_in(Some(&open), Mode::Veto, STALE_OPEN_MS + 1), "estado velho não segura");
    assert!(!busy_in(Some(&snap(false, 0)), Mode::Veto, 1000));
    assert!(!busy_in(None, Mode::Veto, 1000), "sem canal: decide a tela");
}

// ── Leitor do arquivo ─────────────────────────────────────────────────

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ags-canal-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn append(path: &std::path::Path, bytes: &[u8]) {
    use std::io::Write;
    std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(bytes).unwrap();
}

#[test]
fn o_leitor_entrega_so_linhas_completas_e_so_o_que_cresceu() {
    let dir = temp_dir("tail");
    let path = dir.join("s.jsonl");
    append(&path, b"{\"a\":1}\n{\"b\":");
    let mut t = Tailer::new(&path);
    let first = t.poll().unwrap();
    assert_eq!(first.lines, vec![b"{\"a\":1}".to_vec()]);
    assert!(!first.reset);
    assert!(t.poll().unwrap().lines.is_empty(), "nada novo");
    append(&path, b"2}\r\n\n{\"c\":3}\n");
    assert_eq!(t.poll().unwrap().lines, vec![b"{\"b\":2}".to_vec(), b"{\"c\":3}".to_vec()]);
    // Encolheu (outro arquivo no mesmo nome): recomeça e avisa.
    std::fs::write(&path, b"{\"d\":4}\n").unwrap();
    let again = t.poll().unwrap();
    assert!(again.reset);
    assert_eq!(again.lines, vec![b"{\"d\":4}".to_vec()]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn arquivo_grande_le_so_a_janela_do_fim_a_partir_de_uma_linha_inteira() {
    let dir = temp_dir("boot");
    let path = dir.join("big.jsonl");
    let filler = format!("{{\"x\":\"{}\"}}\n", "y".repeat(1000));
    let mut body = String::new();
    while (body.len() as u64) < BOOT_WINDOW * 2 {
        body.push_str(&filler);
    }
    body.push_str("{\"fim\":true}\n");
    std::fs::write(&path, &body).unwrap();
    let batch = Tailer::new(&path).poll().unwrap();
    assert!(batch.lines.len() < 600, "não leu o arquivo inteiro: {}", batch.lines.len());
    assert!(batch.lines.iter().all(|l| l.starts_with(b"{")), "a primeira linha partida foi descartada");
    assert_eq!(batch.lines.last().unwrap(), b"{\"fim\":true}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn o_rollout_do_codex_e_achado_pelo_id_no_nome() {
    let root = temp_dir("codex");
    let day = root.join("2026").join("10").join("22");
    std::fs::create_dir_all(&day).unwrap();
    let id = "01a15bed-aa1e-7931-9fae-a99060900934";
    std::fs::write(day.join(format!("rollout-2026-10-22T10-00-00-{id}.jsonl")), b"{}\n").unwrap();
    std::fs::write(day.join(format!("rollout-2026-10-21T10-00-00-{id}.jsonl.zst")), b"x").unwrap();
    std::fs::write(day.join("rollout-2026-10-22T10-00-00-outro.jsonl"), b"{}\n").unwrap();
    let found = codex_rollout_by_id(&root, id).expect("achou");
    assert!(found.to_string_lossy().ends_with(&format!("{id}.jsonl")));
    assert_eq!(codex_rollout_by_id(&root, "nao-existe"), None);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn id_de_sessao_perigoso_nao_vira_caminho() {
    assert_eq!(transcript_path("claude-code", "/repo", "../../etc/passwd", None), None);
    assert_eq!(transcript_path("opencode", "/repo", "ses_1", None), None);
}

#[test]
fn o_tracker_le_o_arquivo_que_cresce() {
    let dir = temp_dir("tracker");
    let path = dir.join("s.jsonl");
    append(&path, &line(c_user("oi")));
    append(&path, b"\n");
    let mut tracker = Tracker::new("claude-code", "s", path.clone());
    tracker.feed(1_000).unwrap();
    assert_eq!(tracker.state.phase, Phase::Working);
    assert!(tracker.grew_at > 0, "a primeira leitura usa a data do arquivo");
    append(&path, &line(c_end("ok")));
    append(&path, b"\n");
    tracker.feed(5_000).unwrap();
    assert_eq!(tracker.state.phase, Phase::Idle);
    assert_eq!(tracker.grew_at, 5_000);
    let snapshot = tracker.snapshot("tab", 6_000);
    assert_eq!(snapshot.phase, Phase::Idle);
    assert_eq!(snapshot.brief()["phase"], "idle");
    std::fs::remove_dir_all(dir).unwrap();
}

// ── Pendências ────────────────────────────────────────────────────────

fn working_with_tool(since: i64) -> TabState {
    let mut state = TabState::default();
    state.apply(Event::TurnStarted, 0);
    state.apply(Event::ToolStarted { id: "t1".into(), name: "Bash".into(), summary: "git push".into() }, since);
    state
}

#[test]
fn aprovacao_so_com_ferramenta_pendente_e_dialogo_na_tela() {
    let state = working_with_tool(0);
    assert!(pending::signals(&state, None, 10_000).is_empty(), "sem olhar a tela, nada");
    assert!(pending::signals(&state, Some(false), 10_000).is_empty());
    assert!(pending::signals(&state, Some(true), 1_000).is_empty(), "ferramenta recém-chamada: o diálogo pode ser de antes");
    let s = pending::signals(&state, Some(true), 10_000);
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].kind, s[0].key.as_str(), s[0].detail.as_str()), (Kind::Approval, "t1", "git push"));
    assert!(pending::needs_dialog_check(&state, 10_000));
    assert!(!pending::needs_dialog_check(&state, 500));
}

#[test]
fn pergunta_e_fim_de_turno_com_pergunta_viram_pendencias() {
    let mut state = TabState::default();
    state.apply(Event::TurnStarted, 0);
    state.apply(Event::ToolStarted { id: "q".into(), name: "AskUserQuestion".into(), summary: String::new() }, 0);
    state.apply(Event::Question { id: "q".into(), text: "Qual?".into(), options: vec!["A".into(), "B".into()] }, 0);
    let s = pending::signals(&state, Some(true), 60_000);
    assert_eq!(s.len(), 1, "o diálogo da pergunta não vira também aprovação: {s:?}");
    assert_eq!(s[0].kind, Kind::Question);
    assert!(!pending::needs_dialog_check(&state, 60_000));

    let mut idle = TabState::default();
    idle.apply(Event::TurnStarted, 0);
    idle.apply(Event::TurnEnded { reason: EndReason::Completed, text: Some("Terminei.\nSigo com o deploy?".into()) }, 5);
    let s = pending::signals(&idle, None, 10);
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].kind, s[0].title.as_str()), (Kind::TurnQuestion, "Sigo com o deploy?"));
    assert!(!Kind::TurnQuestion.notifies());
}

#[test]
fn dialogos_de_permissao_na_tela() {
    assert!(pending::dialog_on_screen("Bash command\n  git push\nDo you want to proceed?\n❯ 1. Yes\n  2. No"));
    assert!(pending::dialog_on_screen("Would you like to run the following command?\n$ git push\n› 1. Yes, proceed (y)"));
    assert!(!pending::dialog_on_screen("● Working (5s • esc to interrupt)\n› "));
    // Só o fim da tela conta: um diálogo antigo lá em cima não.
    let old = format!("Do you want to proceed?\n{}", "linha\n".repeat(30));
    assert!(!pending::dialog_on_screen(&old));
}

fn sig(kind: Kind, key: &str) -> Signal {
    Signal { kind, key: key.into(), title: "Bash".into(), detail: "git push".into(), options: vec!["1".into()] }
}

#[test]
fn a_migracao_e_idempotente_e_aditiva() {
    let conn = crate::database::test_db();
    pending::migrate(&conn).unwrap();
    pending::migrate(&conn).unwrap();
    let owner = Owner { tab_id: "m", tab_name: "Dev", agent_id: "claude-code", session_id: "s" };
    pending::sync(&conn, &owner, &[sig(Kind::Approval, "t1")], 1).unwrap();
    pending::migrate(&conn).unwrap();
    assert_eq!(pending::pending_for(&conn, "m").unwrap().len(), 1, "migrar de novo não apaga nada");
}

#[test]
fn sync_registra_uma_vez_e_fecha_o_que_sumiu() {
    let conn = crate::database::test_db();
    let owner = Owner { tab_id: "m", tab_name: "Dev", agent_id: "claude-code", session_id: "s" };
    let created = pending::sync(&conn, &owner, &[sig(Kind::Approval, "t1")], 1_000).unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].options, vec!["1"]);
    assert!(pending::sync(&conn, &owner, &[sig(Kind::Approval, "t1")], 2_000).unwrap().is_empty(), "a mesma não nasce de novo");
    // A pessoa respondeu na própria TUI: a pendência some do estado.
    pending::sync(&conn, &owner, &[], 3_000).unwrap();
    let item = pending::get(&conn, created[0].id).unwrap().unwrap();
    assert_eq!(item.state, pending::State::Answered);
    assert_eq!(item.answered_by.as_deref(), Some("tui"));
    // E não é reaberta se a mesma chave aparecer de novo.
    assert!(pending::sync(&conn, &owner, &[sig(Kind::Approval, "t1")], 4_000).unwrap().is_empty());
    assert!(pending::pending_for(&conn, "m").unwrap().is_empty());
}

#[test]
fn a_resposta_do_orquestrador_vence_e_so_vale_uma_vez() {
    let conn = crate::database::test_db();
    let owner = Owner { tab_id: "m", ..Owner::default() };
    let id = pending::sync(&conn, &owner, &[sig(Kind::Question, "q")], 0).unwrap()[0].id;
    assert!(pending::record_answer(&conn, id, "2", "Orquestrador", 10).unwrap());
    assert!(!pending::record_answer(&conn, id, "1", "Orquestrador", 11).unwrap(), "já respondida");
    pending::sync(&conn, &owner, &[], 20).unwrap();
    let item = pending::get(&conn, id).unwrap().unwrap();
    assert_eq!((item.answer.as_deref(), item.answered_by.as_deref(), item.answered_at), (Some("2"), Some("Orquestrador"), Some(10)));
}

#[test]
fn aviso_so_depois_do_prazo_e_nunca_da_heuristica() {
    let conn = crate::database::test_db();
    let owner = Owner { tab_id: "m", ..Owner::default() };
    pending::sync(&conn, &owner, &[sig(Kind::Approval, "a"), sig(Kind::Question, "q"), sig(Kind::TurnQuestion, "turn:1:0")], 0).unwrap();
    let due = |now| pending::due_notices(&conn, now).unwrap().into_iter().map(|i| i.item_key).collect::<Vec<_>>();
    assert!(due(5_000).is_empty());
    assert_eq!(due(10_000), vec!["q"]);
    assert_eq!(due(15_000), vec!["a", "q"]);
    let q = pending::pending_for(&conn, "m").unwrap().into_iter().find(|i| i.item_key == "q").unwrap();
    pending::mark_notified(&conn, q.id, 15_000).unwrap();
    assert_eq!(due(16_000), vec!["a"], "avisada não volta");
}

#[test]
fn aba_fechada_e_pendencia_velha_expiram() {
    let conn = crate::database::test_db();
    pending::sync(&conn, &Owner { tab_id: "fechada", ..Owner::default() }, &[sig(Kind::Question, "q")], 0).unwrap();
    pending::sync(&conn, &Owner { tab_id: "aberta", ..Owner::default() }, &[sig(Kind::Question, "q")], 0).unwrap();
    pending::sync(&conn, &Owner { tab_id: "velha", ..Owner::default() }, &[sig(Kind::Question, "q")], -pending::EXPIRE_AFTER_MS - 1).unwrap();
    let live = vec!["aberta".to_string(), "velha".to_string()];
    assert_eq!(pending::housekeep(&conn, &live, 1).unwrap(), 2);
    let all = vec!["fechada".to_string(), "aberta".to_string(), "velha".to_string()];
    let open = pending::list(&conn, &all, false, 1).unwrap();
    assert_eq!(open.iter().map(|i| i.tab_id.as_str()).collect::<Vec<_>>(), vec!["aberta"]);
    assert_eq!(pending::list(&conn, &all, true, 1).unwrap().len(), 3, "com --all aparecem as resolvidas");
    assert!(pending::list(&conn, &["outra".to_string()], true, 1).unwrap().is_empty(), "só as abas pedidas");
}

#[test]
fn segredo_nao_vai_para_a_pendencia() {
    let conn = crate::database::test_db();
    let mut s = sig(Kind::Approval, "t");
    s.detail = "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' x".into();
    let item = &pending::sync(&conn, &Owner { tab_id: "m", ..Owner::default() }, &[s], 0).unwrap()[0];
    assert!(item.detail.starts_with("(oculto"), "{}", item.detail);
}
