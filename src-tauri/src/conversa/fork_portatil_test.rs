//! O fork portátil da pergunta lateral (`fork_portatil`, `redacao`) e o ponto estável do Claude (`chat_run.end_uuid`,
//! `--resume-session-at`). Só fixtures e banco em memória: nenhum agente real roda aqui.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::json;

use crate::canal::timeline::{Item, ItemKind, ToolKind, ToolStatus};
use crate::database::DbConnection;

use super::claude_map::{launch_args, Mapper, Out, Start};
use super::fork::{origin_of, plan, prepare_context, record, Outcome, Plan, Reason};
use super::fork_portatil::{self, Kind, Pending, DELTA_CHARS};
use super::handoff::{DEFAULT_BUDGET, END_MARK, START_MARK};
use super::redacao::{redact, sensitive_path};
use super::store::{self, Tuning};

fn tuning() -> Tuning {
    Tuning { model: Some("opus".into()), effort: None, access: "ask".into() }
}

fn conn() -> Connection {
    let conn = crate::database::test_db();
    store::migrate(&conn).unwrap();
    conn.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    conn
}

fn say(kind: ItemKind, id: &str, text: &str) -> Item {
    Item { text: Some(text.into()), ..Item::new(kind, id.into(), Some(10)) }
}

fn tool(id: &str, kind: ToolKind, label: Option<&str>, path: Option<&str>, status: ToolStatus) -> Item {
    Item {
        tool: Some(kind),
        label: label.map(str::to_string),
        path: path.map(str::to_string),
        status: Some(status),
        output: Some("SAÍDA-QUE-NAO-PODE-IR-PARA-O-OUTRO-AGENTE token=abc123abc123abc123".into()),
        ..Item::new(ItemKind::Tool, id.into(), Some(11))
    }
}

/// Uma conversa de origem com falas, ferramentas e um raciocínio.
fn origin_items() -> Vec<Item> {
    vec![
        say(ItemKind::User, "u1", "Crie a rota de login em src/api/login.ts"),
        say(ItemKind::Reasoning, "r1", "RACIOCINIO-INTERNO-QUE-NAO-ATRAVESSA"),
        tool("t1", ToolKind::Read, None, Some("src/api/router.ts"), ToolStatus::Done),
        tool("t2", ToolKind::Read, None, Some("/repo/.env"), ToolStatus::Done),
        tool("t3", ToolKind::Edit, None, Some("src/api/login.ts"), ToolStatus::Done),
        tool("t4", ToolKind::Command, Some("bun run test"), None, ToolStatus::Error),
        say(ItemKind::Assistant, "a1", "Criei a rota e rodei os testes: um falhou."),
        say(ItemKind::User, "u2", "Corrija o teste que falhou"),
    ]
}

fn db_of(conn: Connection) -> DbConnection {
    Arc::new(Mutex::new(conn))
}

// ---- o formato do contexto portátil ----------------------------------------------------------------------------------

#[test]
fn o_contexto_portatil_leva_falas_ferramentas_e_arquivos_no_formato_de_dado_nao_confiavel() {
    let text = fork_portatil::portable_context(&origin_items(), "origem-1", "Claude Code", "Codex").expect("há falas");
    assert!(text.starts_with(START_MARK), "{text}");
    assert!(text.ends_with(END_MARK));
    // sem linha em branco: a tela corta a injeção na primeira
    assert!(!text.contains("\n\n"), "{text}");
    // o enquadramento da pergunta lateral e o envelope de dado
    assert!(text.contains("pergunta lateral"));
    assert!(text.contains("Claude Code") && text.contains("Codex"));
    assert!(text.contains("<untrusted_data"));
    // o que entra: as falas, o pedido, os arquivos e os comandos (sem saída)
    assert!(text.contains("Pessoa: Crie a rota de login em src/api/login.ts"));
    assert!(text.contains("Agente: Criei a rota e rodei os testes: um falhou."));
    assert!(text.contains("Pedido corrente da pessoa: Corrija o teste que falhou"));
    assert!(text.contains("Arquivos alterados: src/api/login.ts"));
    assert!(text.contains("Arquivos lidos: src/api/router.ts"));
    assert!(text.contains("Comandos recentes: bun run test (falhou)"));
    assert!(text.contains("ags chat show origem-1"));
    // o que NÃO entra: raciocínio, saída das ferramentas, arquivo sensível
    assert!(!text.contains("RACIOCINIO-INTERNO"), "{text}");
    assert!(!text.contains("SAÍDA-QUE-NAO-PODE-IR"), "{text}");
    assert!(!text.contains(".env"), "{text}");
    assert!(text.contains("arquivo(s) de nome sensível ficaram de fora"));
}

#[test]
fn origem_sem_falas_nao_tem_contexto_portatil() {
    let items = vec![tool("t1", ToolKind::Read, None, Some("a.rs"), ToolStatus::Done), say(ItemKind::Assistant, "a1", "   ")];
    assert!(!fork_portatil::has_talk(&items));
    assert_eq!(fork_portatil::portable_context(&items, "o", "Claude Code", "Codex"), None);
    assert_eq!(fork_portatil::portable_context(&[], "o", "Claude Code", "Codex"), None);
}

#[test]
fn o_contexto_portatil_respeita_o_teto_e_diz_o_que_ficou_de_fora() {
    let long = "palavra ".repeat(120);
    let mut items = Vec::new();
    for n in 0..400 {
        items.push(say(if n % 2 == 0 { ItemKind::User } else { ItemKind::Assistant }, &format!("m{n}"), &format!("fala {n} {long}")));
    }
    let text = fork_portatil::portable_context(&items, "origem-1", "Claude Code", "Codex").unwrap();
    assert!(text.len() <= DEFAULT_BUDGET, "{} > {DEFAULT_BUDGET}", text.len());
    assert!(text.contains("falas mais antigas ficaram de fora"));
    assert!(text.contains("ags chat show origem-1 --last 200"));
    // as mais novas ficam, as mais antigas saem
    assert!(text.contains("fala 399 "));
    // (o pedido original fica sempre; a fala em si, não)
    assert!(!text.contains("Pessoa: fala 0 ") && !text.contains("Pessoa: fala 100 "));
}

// ---- o filtro de segredos --------------------------------------------------------------------------------------------

#[test]
fn segredos_no_texto_nunca_atravessam_para_o_outro_agente() {
    let secrets = [
        "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
        "AKIAIOSFODNN7EXAMPLE",
        "xoxb-123456789012-abcdefghijkl",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
        "hunter2hunter2",
    ];
    let items = vec![
        say(ItemKind::User, "u1", &format!("use a chave {} e também {} no deploy", secrets[0], secrets[1])),
        say(ItemKind::Assistant, "a1", &format!("anotei {} e {} e {}", secrets[2], secrets[3], secrets[4])),
        say(ItemKind::User, "u2", &format!("o jwt é {} e a senha: {}", secrets[5], secrets[6])),
        tool("t1", ToolKind::Command, Some("curl -H 'Authorization: Bearer abcdef0123456789abcdef' https://x.dev --password hunter2hunter2"), None, ToolStatus::Done),
    ];
    let text = fork_portatil::portable_context(&items, "o", "Claude Code", "Codex").unwrap();
    for secret in secrets {
        assert!(!text.contains(secret), "vazou {secret}: {text}");
    }
    assert!(!text.contains("abcdef0123456789abcdef"), "{text}");
    // o resto da fala continua legível
    assert!(text.contains("no deploy"));
}

#[test]
fn a_redacao_cobre_chave_privada_url_com_senha_atribuicao_e_flag() {
    let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n-----END RSA PRIVATE KEY-----";
    let out = redact(&format!("segue a chave:\n{pem}\nfim"));
    assert!(!out.contains("MIIEow") && out.contains("[chave privada oculta]") && out.contains("fim"), "{out}");
    assert_eq!(redact("git clone https://ton:s3nh4-forte@git.exemplo.dev/r.git"), "git clone https://[oculto]@git.exemplo.dev/r.git");
    assert!(redact("DATABASE_PASSWORD=abc123 e API_KEY: \"xyz 789\"").matches("[oculto]").count() == 2);
    assert!(!redact("login --token meu-token-longo --user ton").contains("meu-token-longo"));
    // texto comum passa intacto, inclusive com a palavra "autor"/"password-stdin"
    let plain = "o autor do commit usou --password-stdin e leu a documentação\nsegunda linha";
    assert_eq!(redact(plain), plain);
}

#[test]
fn arquivos_de_nome_sensivel_nao_sao_citados() {
    for path in ["/repo/.env", ".env.local", "config/prod.env", "/home/u/.ssh/id_rsa", "keys/server.pem", "certs/app.p12", "/home/u/.aws/credentials", ".npmrc"] {
        assert!(sensitive_path(path), "{path}");
    }
    for path in ["src/env.ts", ".env.example", "docs/chaves.md", "src/credentials_form.tsx", "package.json"] {
        assert!(!sensitive_path(path), "{path}");
    }
}

// ---- o digest do que a origem fez depois do ponto da cópia ---------------------------------------------------------------

#[test]
fn o_digest_da_origem_em_andamento_cabe_no_teto_e_diz_que_cortou() {
    let mut items = Vec::new();
    for n in 0..200 {
        items.push(tool(&format!("c{n}"), ToolKind::Command, Some(&format!("comando-numero-{n} {}", "x".repeat(100))), None, ToolStatus::Done));
    }
    items.push(say(ItemKind::Assistant, "a-final", "Terminei a migração."));
    let text = fork_portatil::delta_context(&items, "origem-1", "Claude Code").unwrap();
    assert!(text.len() <= DELTA_CHARS, "{} > {DELTA_CHARS}", text.len());
    assert!(text.starts_with(START_MARK) && text.ends_with(END_MARK));
    assert!(!text.contains("\n\n"));
    assert!(text.contains("atividade mais antiga ficou de fora"));
    assert!(text.contains("Terminei a migração.") && text.contains("comando-numero-199"));
    assert!(!text.contains("comando-numero-0 "));
    assert!(text.contains("ags chat show origem-1"));
}

#[test]
fn o_digest_sem_nada_a_dizer_nao_existe() {
    assert_eq!(fork_portatil::delta_context(&[], "o", "Claude Code"), None);
    let only_reasoning = vec![say(ItemKind::Reasoning, "r", "pensando"), say(ItemKind::User, "u", "[ADE AGS] injeção")];
    assert_eq!(fork_portatil::delta_context(&only_reasoning, "o", "Claude Code"), None);
}

// ---- guardar e entregar ----------------------------------------------------------------------------------------------

#[test]
fn o_contexto_vai_na_frente_da_primeira_mensagem_e_so_sai_da_fila_quando_enviada() {
    let db = db_of(conn());
    assert_eq!(fork_portatil::before_send(&db, "lateral", "oi"), ("oi".to_string(), false));
    let pending = Pending { kind: Kind::Portable, text: format!("{START_MARK}: x\n{END_MARK}") };
    fork_portatil::save(&db, "lateral", &pending);
    assert_eq!(fork_portatil::load(&db, "lateral"), Some(pending.clone()));
    let (text, carries) = fork_portatil::before_send(&db, "lateral", "qual era o erro?");
    assert!(carries);
    assert_eq!(text, format!("{}\n\nqual era o erro?", pending.text));
    // um envio que falhou não consome o contexto: a próxima tentativa o leva de novo
    assert!(fork_portatil::before_send(&db, "lateral", "de novo").1);
    fork_portatil::sent(&db, "lateral");
    assert_eq!(fork_portatil::before_send(&db, "lateral", "e agora").0, "e agora");
    // outra pergunta não é afetada
    assert!(!fork_portatil::before_send(&db, "outra", "oi").1);
}

#[test]
fn a_tela_esconde_o_contexto_portatil_e_mostra_so_a_pergunta() {
    // o mesmo recorte que `displayUserText` (userMessage.ts) tira: o bloco termina em END_MARK e vem antes da pergunta
    let text = fork_portatil::portable_context(&origin_items(), "o", "Claude Code", "Codex").unwrap();
    let (framed, _) = {
        let db = db_of(conn());
        fork_portatil::save(&db, "l", &Pending { kind: Kind::Portable, text });
        fork_portatil::before_send(&db, "l", "qual era o erro?")
    };
    let (block, question) = framed.split_once(&format!("{END_MARK}\n\n")).expect("o bloco termina na marca e a pergunta vem depois");
    assert!(block.starts_with("[ADE AGS]") && !block.contains("\n\n"));
    assert_eq!(question, "qual era o erro?");
}

// ---- a decisão no fork -----------------------------------------------------------------------------------------------

fn with_origin(conn: &Connection, origin_agent: &str, side_agent: &str) {
    store::insert_thread(conn, "origem", origin_agent, "/repo", "Origem", &tuning(), None, 1).unwrap();
    store::set_remote_id(conn, "origem", "sessao-origem").unwrap();
    for item in origin_items() {
        store::upsert_item(conn, "origem", None, &item).unwrap();
    }
    store::insert_thread_with_parent(conn, "lateral", side_agent, "/repo", "Pergunta", &tuning(), None, Some("thread:origem"), 2).unwrap();
}

/// A origem como o banco a guarda: a conversa, os turnos e os itens.
fn snapshot(conn: &Connection) -> (String, Vec<String>, Vec<String>) {
    let row = format!("{:?}", store::thread(conn, "origem").unwrap().unwrap());
    let runs: Vec<String> = conn
        .prepare("SELECT id || status || COALESCE(end_uuid, '') FROM chat_run WHERE thread_id = 'origem' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let items: Vec<String> = conn
        .prepare("SELECT body FROM chat_item WHERE thread_id = 'origem' ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    (row, runs, items)
}

#[test]
fn outro_agente_abre_a_sessao_nova_com_o_contexto_portatil_e_a_origem_fica_intacta() {
    let conn = conn();
    with_origin(&conn, "claude-code", "codex");
    store::upsert_run(&conn, "origem", "turno-1", "completed", Some(10), Some(11), None).unwrap();
    store::upsert_run(&conn, "origem", "turno-2", "inProgress", Some(20), None, None).unwrap();
    let before = snapshot(&conn);

    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let planned = plan(&side.agent_id, side.account_id.as_deref(), Some(&origin));
    assert_eq!(planned, Plan::Portable(Reason::OtherAgent));
    let outcome = record(&conn, "lateral", &planned, Ok(())).unwrap();
    let (outcome, pending) = prepare_context(&conn, &side, "origem", &origin.agent_id, origin.working, outcome).unwrap();

    assert_eq!(outcome, Outcome::portable(Reason::OtherAgent));
    let pending = pending.expect("o contexto portátil foi preparado");
    assert_eq!(pending.kind, Kind::Portable);
    assert!(pending.text.contains("Claude Code") && pending.text.contains("Codex") && pending.text.contains("Pessoa: Corrija o teste que falhou"));
    // gravado como a pergunta nasceu, com o motivo; a origem não mudou e o turno dela segue em andamento
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode.as_deref(), side.fork_reason.as_deref()), (Some("portable"), Some("other-agent")));
    assert_eq!(side.remote_id, None);
    assert_eq!(snapshot(&conn), before);
    assert_eq!(store::active_turn_id(&conn, "origem").unwrap().as_deref(), Some("turno-2"));
}

#[test]
fn outra_conta_do_mesmo_agente_tambem_leva_o_contexto_portatil() {
    let conn = conn();
    with_origin(&conn, "claude-code", "claude-code");
    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    assert_eq!(plan("claude-code", Some("conta-b"), Some(&origin)), Plan::Portable(Reason::OtherAccount));
}

#[test]
fn origem_sem_falas_cai_no_recorte_com_o_mesmo_motivo() {
    let conn = conn();
    store::insert_thread(&conn, "origem", "claude-code", "/repo", "Origem", &tuning(), None, 1).unwrap();
    store::insert_thread_with_parent(&conn, "lateral", "codex", "/repo", "Pergunta", &tuning(), None, Some("thread:origem"), 2).unwrap();
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let outcome = record(&conn, "lateral", &Plan::Portable(Reason::OtherAgent), Ok(())).unwrap();
    let (outcome, pending) = prepare_context(&conn, &side, "origem", "claude-code", false, outcome).unwrap();
    assert_eq!(outcome, Outcome::excerpt(Reason::OtherAgent));
    assert_eq!(pending, None);
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    assert_eq!((side.fork_mode.as_deref(), side.fork_reason.as_deref()), (Some("excerpt"), Some("other-agent")));
}

#[test]
fn a_copia_nativa_de_uma_origem_trabalhando_leva_so_o_que_ela_fez_depois_do_ponto() {
    let conn = conn();
    with_origin(&conn, "codex", "codex");
    // o item da origem que pertence ao turno em andamento
    store::upsert_run(&conn, "origem", "turno-1", "completed", Some(10), Some(11), None).unwrap();
    store::upsert_run(&conn, "origem", "turno-2", "inProgress", Some(20), None, None).unwrap();
    store::upsert_item(&conn, "origem", Some("turno-2"), &say(ItemKind::Assistant, "a-novo", "Estou migrando o banco agora.")).unwrap();
    store::upsert_item(&conn, "origem", Some("turno-2"), &tool("c-novo", ToolKind::Command, Some("cargo test --lib"), None, ToolStatus::Running)).unwrap();
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let (outcome, pending) = prepare_context(&conn, &side, "origem", "codex", true, Outcome::native()).unwrap();
    assert_eq!(outcome, Outcome::native());
    let pending = pending.expect("digest");
    assert_eq!(pending.kind, Kind::Delta);
    assert!(pending.text.contains("Estou migrando o banco agora.") && pending.text.contains("cargo test --lib"));
    // o que é de turno concluído já está na cópia: não se repete
    assert!(!pending.text.contains("Crie a rota de login"));
    // origem ociosa: a cópia é completa e não há digest
    let (_, none) = prepare_context(&conn, &side, "origem", "codex", false, Outcome::native()).unwrap();
    assert_eq!(none, None);
}

// ---- o ponto estável do Claude ---------------------------------------------------------------------------------------

#[test]
fn o_fork_do_claude_corta_a_copia_no_uuid_do_ultimo_turno_concluido() {
    let conn = conn();
    with_origin(&conn, "claude-code", "claude-code");
    let side = store::thread(&conn, "lateral").unwrap().unwrap();
    let args = launch_args(&side, Start::Fork { from: "sessao-origem", id: "sessao-nova", at: Some("uuid-turno-1") });
    let resume = args.iter().position(|a| a == "--resume").unwrap();
    assert_eq!(&args[resume..resume + 7], ["--resume", "sessao-origem", "--fork-session", "--session-id", "sessao-nova", "--resume-session-at", "uuid-turno-1"]);
    // o ponto de corte vale só com o fork: a retomada comum não o leva
    assert!(!launch_args(&side, Start::Resume("s-1")).iter().any(|a| a == "--resume-session-at"));
    // uuid vazio é como não ter ponto
    assert!(!launch_args(&side, Start::Fork { from: "a", id: "b", at: Some("") }).iter().any(|a| a == "--resume-session-at"));
}

#[test]
fn o_ponto_estavel_do_claude_e_o_ultimo_turno_concluido_com_uuid_nunca_o_interrompido_ou_em_andamento() {
    let conn = conn();
    with_origin(&conn, "claude-code", "claude-code");
    assert_eq!(store::last_end_uuid(&conn, "origem").unwrap(), None);
    store::upsert_run(&conn, "origem", "t1", "completed", Some(10), Some(11), None).unwrap();
    store::set_run_end_uuid(&conn, "origem", "t1", "uuid-1").unwrap();
    store::upsert_run(&conn, "origem", "t2", "completed", Some(20), Some(21), None).unwrap();
    store::set_run_end_uuid(&conn, "origem", "t2", "uuid-2").unwrap();
    // turno interrompido depois, mesmo com uuid gravado por engano: não é o ponto
    store::upsert_run(&conn, "origem", "t3", "interrupted", Some(30), Some(31), None).unwrap();
    store::set_run_end_uuid(&conn, "origem", "t3", "uuid-3").unwrap();
    store::upsert_run(&conn, "origem", "t4", "inProgress", Some(40), None, None).unwrap();
    assert_eq!(store::last_end_uuid(&conn, "origem").unwrap().as_deref(), Some("uuid-2"));

    // com a origem trabalhando, o plano corta no uuid do último concluído
    let origin = origin_of(&conn, "thread:origem").unwrap().unwrap();
    assert!(origin.working);
    assert_eq!(
        plan("claude-code", None, Some(&origin)),
        Plan::Claude { from: "sessao-origem".into(), at: Some("uuid-2".into()) }
    );
    // outra conversa não empresta o ponto
    store::insert_thread(&conn, "outra", "claude-code", "/repo", "Outra", &tuning(), None, 3).unwrap();
    assert_eq!(store::last_end_uuid(&conn, "outra").unwrap(), None);
}

#[test]
fn o_mapper_guarda_o_uuid_da_ultima_fala_do_agente_e_o_entrega_uma_vez() {
    let mut mapper = Mapper::default();
    let assistant = |uuid: &str, text: &str, parent: serde_json::Value| {
        json!({
            "type": "assistant", "uuid": uuid, "parent_tool_use_id": parent,
            "message": { "id": format!("msg-{uuid}"), "role": "assistant", "content": [{ "type": "text", "text": text }] }
        })
    };
    assert_eq!(mapper.take_end_uuid(), None);
    mapper.feed(&assistant("u-1", "primeira", serde_json::Value::Null), 100);
    mapper.feed(&assistant("u-2", "segunda", serde_json::Value::Null), 101);
    // a fala de um subagente (sidechain) não é a última do fio principal
    mapper.feed(&assistant("u-sub", "do subagente", json!("toolu_1")), 102);
    // a linha de resultado fecha o turno sem trocar o uuid
    let outs = mapper.feed(&json!({ "type": "result", "subtype": "success", "is_error": false, "uuid": "uuid-do-resultado", "duration_ms": 5 }), 103);
    assert!(matches!(outs.as_slice(), [Out::Done(_)]));
    assert_eq!(mapper.take_end_uuid().as_deref(), Some("u-2"));
    // entregue uma vez: o turno seguinte não herda o uuid do anterior
    assert_eq!(mapper.take_end_uuid(), None);
    // linha sem uuid não apaga o último
    mapper.feed(&assistant("u-3", "terceira", serde_json::Value::Null), 104);
    mapper.feed(&json!({ "type": "assistant", "message": { "id": "m", "role": "assistant", "content": [{ "type": "text", "text": "sem uuid" }] } }), 105);
    assert_eq!(mapper.take_end_uuid().as_deref(), Some("u-3"));
}

#[test]
fn a_coluna_do_ponto_estavel_e_aditiva_idempotente_e_nao_apaga_turnos_antigos() {
    // um banco antigo: `chat_run` sem a coluna, com um turno gravado
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_thread (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, remote_id TEXT, cwd TEXT NOT NULL, workspace_id TEXT,
            title TEXT NOT NULL DEFAULT '', model TEXT, effort TEXT, access TEXT NOT NULL DEFAULT 'ask', account_id TEXT,
            state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         INSERT INTO chat_thread (id, agent_id, cwd, created_at, updated_at) VALUES ('antiga', 'claude-code', '/repo', 1, 1);
         CREATE TABLE chat_run (id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE, status TEXT NOT NULL,
            started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, PRIMARY KEY (thread_id, id));
         INSERT INTO chat_run (id, thread_id, status, started_at) VALUES ('turno-antigo', 'antiga', 'completed', 5);",
    )
    .unwrap();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
    let kept: (String, Option<String>) =
        conn.query_row("SELECT status, end_uuid FROM chat_run WHERE id = 'turno-antigo'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(kept, ("completed".to_string(), None));
    let columns: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('chat_run') WHERE name = 'end_uuid'", [], |r| r.get(0)).unwrap();
    assert_eq!(columns, 1);
    // turno antigo sem uuid: não há ponto estável do Claude para ele
    assert_eq!(store::last_end_uuid(&conn, "antiga").unwrap(), None);
}
