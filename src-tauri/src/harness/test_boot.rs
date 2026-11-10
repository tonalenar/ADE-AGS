//! Fase 4 (janela entre criar e registrar) e Fase 5 (presença). Duas conexões no mesmo SQLite
//! temporário; o `agora` é um número. Sem processo e sem CLI de agente.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde_json::json;

use super::child_delivery::{activate, intend, pump, reconcile_intentions, register, watch, WatchSpec, WatchState};
use super::delegate::Target;
use super::presence::{beat, is_live, HEARTBEAT_EVERY_MS, PRESENCE_TTL_MS};
use crate::conversa::api::{self, ChildRequestIdentity, NewThread};
use crate::conversa::store::{self as chat, Tuning};
use crate::database::DbConnection;
use crate::peer_queue::store::{self as queue, NewMessage, State};
use crate::runs::store::{self as runs, NewTask};

struct Arquivo {
    path: PathBuf,
}

impl Drop for Arquivo {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }
}

fn par() -> (Arquivo, Connection, Connection) {
    let path = std::env::temp_dir().join(format!("ags-boot-{}.db", uuid::Uuid::new_v4()));
    let primeira = Connection::open(&path).unwrap();
    primeira.pragma_update(None, "journal_mode", "WAL").unwrap();
    primeira.pragma_update(None, "foreign_keys", "ON").unwrap();
    primeira.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    crate::database::migrate(&primeira).unwrap();
    let segunda = Connection::open(&path).unwrap();
    segunda.pragma_update(None, "foreign_keys", "ON").unwrap();
    segunda.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    primeira
        .execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)", [])
        .unwrap();
    (Arquivo { path }, primeira, segunda)
}

fn tuning() -> Tuning {
    Tuning { model: None, effort: None, access: "ask".into() }
}

fn conversa(conn: &Connection, id: &str, parent: Option<&str>) {
    chat::insert_thread_with_context(conn, id, "codex", "/proj", "Título", &tuning(), None, parent, Some("w1"), 1).unwrap();
}

fn spec<'a>(kind: Target, child: &'a str, parent: &'a str) -> WatchSpec<'a> {
    WatchSpec {
        kind,
        child_ref: child,
        parent_ref: parent,
        title: "Revisar",
        agent_id: "codex",
        parent_turn_id: None,
        session_id: None,
        message_id: None,
    }
}

#[test]
fn queda_entre_criar_e_registrar_entrega_ou_cancela_no_boot() {
    let (_arquivo, escritora, leitora) = par();
    conversa(&escritora, "lead", None);
    conversa(&escritora, "filha", Some("thread:lead"));
    chat::upsert_run(&escritora, "filha", "ft1", "completed", Some(20), Some(30), Some(10)).unwrap();
    let body = json!({ "kind": "assistant", "id": "m1", "text": "pronto" }).to_string();
    escritora
        .execute(
            "INSERT INTO chat_item (thread_id, id, seq, run_id, body) VALUES ('filha', 'm1', 1, 'ft1', ?1)",
            [body],
        )
        .unwrap();
    // A intenção foi gravada e o filho também; a promoção a `watching` não chegou.
    assert!(intend(&escritora, &spec(Target::ProviderChat, "filha", "thread:lead"), 10).unwrap());
    let tarefa = runs::create_task(
        &escritora,
        &NewTask {
            run_id: &runs::create_run(&escritora, "w1", "objetivo", "/proj").unwrap().id,
            title: "Testes",
            prompt: "faça",
            agent_id: "claude-code",
            cwd: "/proj",
            ..Default::default()
        },
    )
    .unwrap();
    escritora
        .execute("UPDATE tasks SET status = 'done', result = 'feito' WHERE id = ?1", [&tarefa.id])
        .unwrap();
    assert!(intend(&escritora, &spec(Target::FleetTask, &tarefa.id, "thread:lead"), 10).unwrap());
    assert!(intend(&escritora, &spec(Target::ProviderChat, "nunca", "thread:lead"), 10).unwrap());

    let client = "delegate:pedido-1";
    let nova = NewMessage {
        client_id: Some(client),
        kind: "tell",
        from_tab_id: "thread:lead",
        from_name: "Lead",
        to_tab_id: "thread:codex",
        to_name: "Codex",
        text: "olha isto",
        raw: false,
        reply: false,
        envelope: None,
        limits: None,
    };
    let mensagem = match queue::admit(&escritora, &nova, State::Queued, 40).unwrap() {
        queue::Admission::New(mensagem) => mensagem,
        outro => panic!("a mensagem da sessão devia ser nova: {outro:?}"),
    };
    let mut sessao = spec(Target::ConnectedSession, "thread:codex#pedido-1", "thread:lead");
    sessao.session_id = Some("thread:codex");
    assert!(intend(&escritora, &sessao, 10).unwrap());
    assert!(intend(&escritora, &spec(Target::ConnectedSession, "thread:sumida#pedido-sem-mensagem", "thread:lead"), 10).unwrap());
    // A outra conexão vê o que a primeira commitou e faz o boot.
    let relatorio = reconcile_intentions(&leitora, 50).unwrap();
    assert_eq!(relatorio.activated, 3, "conversa, tarefa e sessão com filho");
    assert_eq!(relatorio.cancelled, 2, "intenção sem filho");
    assert_eq!(watch(&escritora, Target::ProviderChat, "filha").unwrap().unwrap().state, WatchState::Watching);
    assert_eq!(watch(&escritora, Target::FleetTask, &tarefa.id).unwrap().unwrap().state, WatchState::Watching);
    let sessao = watch(&escritora, Target::ConnectedSession, "thread:codex#pedido-1").unwrap().unwrap();
    assert_eq!(sessao.state, WatchState::Watching);
    assert_eq!(sessao.message_id, Some(mensagem.id));
    assert_eq!(watch(&escritora, Target::ProviderChat, "nunca").unwrap().unwrap().state, WatchState::Cancelled);
    assert_eq!(
        watch(&escritora, Target::ConnectedSession, "thread:sumida#pedido-sem-mensagem").unwrap().unwrap().state,
        WatchState::Cancelled
    );

    let entrega = pump(&leitora, "boot", 60).unwrap();
    assert_eq!(entrega.effects, 2, "conversa e tarefa terminaram; a sessão ainda não respondeu");
    assert_eq!(entrega.queued.len(), 2);
    let de_novo = pump(&escritora, "boot-2", 70).unwrap();
    assert_eq!(de_novo.queued.len(), 0, "a segunda passada não entrega outra vez");
    drop(escritora);
}

#[test]
fn registrar_na_mesma_transacao_grava_ou_desfaz_os_dois() {
    let (_arquivo, mut conn, _) = par();
    conversa(&conn, "lead", None);
    let tx = conn.transaction().unwrap();
    chat::insert_thread_with_context(&tx, "filha", "codex", "/proj", "Filha", &tuning(), None, Some("thread:lead"), Some("w1"), 2).unwrap();
    assert!(register(&tx, &spec(Target::ProviderChat, "filha", "thread:lead"), 2).unwrap());
    drop(tx);
    assert!(watch(&conn, Target::ProviderChat, "filha").unwrap().is_none(), "o rollback leva o acompanhamento");
    assert!(chat::thread(&conn, "filha").unwrap().is_none());

    let tx = conn.transaction().unwrap();
    chat::insert_thread_with_context(&tx, "filha", "codex", "/proj", "Filha", &tuning(), None, Some("thread:lead"), Some("w1"), 3).unwrap();
    assert!(register(&tx, &spec(Target::ProviderChat, "filha", "thread:lead"), 3).unwrap());
    tx.commit().unwrap();
    assert_eq!(watch(&conn, Target::ProviderChat, "filha").unwrap().unwrap().state, WatchState::Watching);
}

#[test]
fn criar_conversa_filha_async_ja_deixa_o_acompanhamento() {
    let db: DbConnection = Arc::new(Mutex::new(crate::database::test_db()));
    {
        let conn = db.lock().unwrap();
        chat::insert_thread(&conn, "raiz", "codex", "/p", "R", &tuning(), None, 1).unwrap();
        chat::upsert_run(&conn, "raiz", "t1", "inProgress", Some(1), None, None).unwrap();
    }
    let input = NewThread {
        agent_id: "codex".into(),
        cwd: "/p".into(),
        workspace_id: None,
        title: "filha".into(),
        model: None,
        effort: None,
        access: "ask".into(),
        account_id: None,
        parent_ref: Some("thread:raiz".into()),
    };
    let identity = ChildRequestIdentity {
        caller_key: "thread:raiz".into(),
        request_id: "pedido".into(),
        request_hash: "hash-pedido".into(),
    };
    let criada = api::create_child_async(&db, input, &identity).unwrap();
    let conn = db.lock().unwrap();
    let acompanhamento = watch(&conn, Target::ProviderChat, &criada.thread.id).unwrap().unwrap();
    assert_eq!(acompanhamento.state, WatchState::Watching);
    assert_eq!(acompanhamento.parent_ref, "thread:raiz");
    assert!(!activate(&conn, &spec(Target::ProviderChat, &criada.thread.id, "thread:raiz"), 9).unwrap());
}

#[test]
fn a_instancia_b_nao_marca_o_turno_vivo_de_a_e_marca_o_da_morta() {
    let (_arquivo, a, b) = par();
    let agora = 1_000_000;
    beat(&a, "inst-a", 11, agora).unwrap();
    beat(&a, "inst-morta", 12, agora - PRESENCE_TTL_MS).unwrap();
    assert!(is_live(&b, "inst-a", agora + HEARTBEAT_EVERY_MS).unwrap());
    assert!(!is_live(&b, "inst-morta", agora).unwrap(), "o batimento antigo já venceu em `agora`");

    conversa(&a, "viva", None);
    conversa(&a, "morta", None);
    conversa(&a, "antiga", None);
    chat::upsert_run(&a, "viva", "t-viva", "inProgress", Some(agora), None, None).unwrap();
    chat::upsert_run(&a, "morta", "t-morta", "inProgress", Some(agora), None, None).unwrap();
    chat::upsert_run(&a, "antiga", "t-antiga", "inProgress", Some(agora), None, None).unwrap();
    a.execute("UPDATE chat_run SET owner_instance = 'inst-a' WHERE id = 't-viva'", []).unwrap();
    a.execute("UPDATE chat_run SET owner_instance = 'inst-morta' WHERE id = 't-morta'", []).unwrap();

    let run = runs::create_run(&a, "w1", "objetivo", "/proj").unwrap();
    let viva = runs::create_task(
        &a,
        &NewTask { run_id: &run.id, title: "Viva", prompt: "faça", agent_id: "codex", cwd: "/proj", ..Default::default() },
    )
    .unwrap();
    let morta = runs::create_task(
        &a,
        &NewTask { run_id: &run.id, title: "Morta", prompt: "faça", agent_id: "codex", cwd: "/proj", ..Default::default() },
    )
    .unwrap();
    a.execute(
        "UPDATE tasks SET status = 'running', owner_instance = 'inst-a' WHERE id = ?1",
        [&viva.id],
    )
    .unwrap();
    a.execute(
        "UPDATE tasks SET status = 'running', owner_instance = 'inst-morta' WHERE id = ?1",
        [&morta.id],
    )
    .unwrap();

    let quando = agora + HEARTBEAT_EVERY_MS;
    let db_b: DbConnection = Arc::new(Mutex::new(b));
    chat::sweep_orphans(&db_b.lock().unwrap(), quando).unwrap();
    runs::sweep_orphans_at(&db_b, quando / 1000, quando).unwrap();

    let status = |thread: &str, turno: &str| -> String {
        a.query_row(
            "SELECT status FROM chat_run WHERE thread_id = ?1 AND id = ?2",
            params![thread, turno],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(status("viva", "t-viva"), "inProgress", "a instância A ainda bate");
    assert_eq!(status("morta", "t-morta"), "interrupted", "a presença de quem morreu venceu");
    assert_eq!(status("antiga", "t-antiga"), "interrupted", "dono desconhecido segue a regra antiga");
    let tarefa = |id: &str| -> String {
        a.query_row("SELECT status FROM tasks WHERE id = ?1", [id], |row| row.get(0)).unwrap()
    };
    assert_eq!(tarefa(&viva.id), "running");
    assert_eq!(tarefa(&morta.id), "failed");
}

#[test]
fn presenca_vence_exatamente_no_prazo() {
    let conn = crate::database::test_db();
    beat(&conn, "inst-a", 1, 500).unwrap();
    assert!(is_live(&conn, "inst-a", 500 + PRESENCE_TTL_MS - 1).unwrap());
    assert!(!is_live(&conn, "inst-a", 500 + PRESENCE_TTL_MS).unwrap());
}
