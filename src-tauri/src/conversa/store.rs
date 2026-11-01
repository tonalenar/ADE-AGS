//! As tabelas das conversas por protocolo. Só aditivas e sem subir `user_version` (como as outras
//! do fim de `database::schema::migrate`).
//!
//! - `chat_thread`: a conversa (pasta, agente, modelo, esforço, acesso, conta) e o id dela no agente
//!   (`remote_id`, para retomar depois de reabrir o app);
//! - `chat_run`: cada turno, com o status e a duração;
//! - `chat_item`: os itens da timeline, já no formato do front (`canal::timeline::Item` em JSON), na
//!   ordem em que chegaram (`seq`);
//! - `chat_request`: os pedidos do agente (aprovar comando, aprovar edição, pergunta), com o id do
//!   pedido no protocolo para responder.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::canal::timeline::Item;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_thread (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            remote_id TEXT,
            cwd TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            model TEXT,
            effort TEXT,
            access TEXT NOT NULL DEFAULT 'ask',
            account_id TEXT,
            state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','settled')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_run (
            id TEXT NOT NULL,
            thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            duration_ms INTEGER,
            PRIMARY KEY (thread_id, id)
        );
        CREATE TABLE IF NOT EXISTS chat_item (
            thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            run_id TEXT,
            body TEXT NOT NULL,
            PRIMARY KEY (thread_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_item_seq ON chat_item(thread_id, seq);
        CREATE TABLE IF NOT EXISTS chat_request (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            rpc_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('command','fileChange','question')),
            item_id TEXT,
            title TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            options TEXT NOT NULL DEFAULT '[]',
            state TEXT NOT NULL CHECK(state IN ('pending','answered','expired')),
            answer TEXT,
            created_at INTEGER NOT NULL,
            answered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_chat_request_state ON chat_request(thread_id, state);",
    )?;
    // A permissão decidida no backend: o pedido INTEIRO (`chat_team::permission::Subject`, em JSON: o título só
    // guarda a primeira linha do comando) e quem respondeu e por quê (`person`, `policy`, `rule:<id>`).
    for (column, ddl) in [("subject", "TEXT"), ("decided_by", "TEXT"), ("decided_why", "TEXT"), ("claimed_at", "INTEGER")] {
        let has = conn.prepare("SELECT 1 FROM pragma_table_info('chat_request') WHERE name = ?1")?.exists([column])?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE chat_request ADD COLUMN {column} {ddl};"))?;
        }
    }
    // O ai-memory na abertura do processo (`on` ou `off:<código>`): aditiva, nula até o primeiro processo abrir.
    let has = conn.prepare("SELECT 1 FROM pragma_table_info('chat_thread') WHERE name = 'memory'")?.exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE chat_thread ADD COLUMN memory TEXT;")?;
    }
    // As sessões nativas guardadas de cada agente que já esteve na conversa (trocar de agente, `troca.rs`): aditiva.
    super::troca::migrate(conn)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub agent_id: String,
    #[serde(skip)]
    pub remote_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: String,
    pub account_id: Option<String>,
    /// O ai-memory na abertura do processo: `on`, ou `off:<código>`; `None` = o processo ainda não abriu.
    pub memory: Option<String>,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// O que se escolhe ao abrir uma conversa (e ao trocar depois).
#[derive(Clone, Debug, Default)]
pub struct Tuning {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: String,
}

const THREAD_COLS: &str = "id, agent_id, remote_id, cwd, title, model, effort, access, account_id, state, created_at, updated_at, memory";

fn thread_of(r: &rusqlite::Row) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        id: r.get(0)?, agent_id: r.get(1)?, remote_id: r.get(2)?, cwd: r.get(3)?, title: r.get(4)?,
        model: r.get(5)?, effort: r.get(6)?, access: r.get(7)?, account_id: r.get(8)?, state: r.get(9)?,
        created_at: r.get(10)?, updated_at: r.get(11)?, memory: r.get(12)?,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn insert_thread(conn: &Connection, id: &str, agent_id: &str, cwd: &str, title: &str, tuning: &Tuning, account_id: Option<&str>, now: i64) -> rusqlite::Result<ThreadRow> {
    conn.execute(
        "INSERT INTO chat_thread (id, agent_id, cwd, title, model, effort, access, account_id, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9)",
        params![id, agent_id, cwd, title, tuning.model, tuning.effort, tuning.access, account_id, now],
    )?;
    thread(conn, id).map(|t| t.expect("acabou de entrar"))
}

pub fn thread(conn: &Connection, id: &str) -> rusqlite::Result<Option<ThreadRow>> {
    conn.query_row(&format!("SELECT {THREAD_COLS} FROM chat_thread WHERE id = ?1"), params![id], thread_of).optional()
}

/// As conversas, as mais recentes primeiro.
pub fn threads(conn: &Connection) -> rusqlite::Result<Vec<ThreadRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {THREAD_COLS} FROM chat_thread ORDER BY updated_at DESC, created_at DESC"))?;
    stmt.query_map([], thread_of)?.collect()
}

pub fn set_remote_id(conn: &Connection, id: &str, remote: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_thread SET remote_id = ?2 WHERE id = ?1", params![id, remote]).map(|_| ())
}

pub fn set_tuning(conn: &Connection, id: &str, tuning: &Tuning, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_thread SET model = ?2, effort = ?3, access = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, tuning.model, tuning.effort, tuning.access, now],
    )
    .map(|_| ())
}

/// O ai-memory na abertura do processo da conversa (`on` ou `off:<código>`), para a tela mostrar o que de fato aconteceu.
pub fn set_memory(conn: &Connection, id: &str, memory: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_thread SET memory = ?2 WHERE id = ?1", params![id, memory]).map(|_| ())
}

pub fn set_title(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_thread SET title = ?2 WHERE id = ?1", params![id, title]).map(|_| ())
}

pub fn set_state(conn: &Connection, id: &str, state: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_thread SET state = ?2, updated_at = ?3 WHERE id = ?1", params![id, state, now]).map(|_| ())
}

pub fn touch(conn: &Connection, id: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_thread SET updated_at = ?2 WHERE id = ?1", params![id, now]).map(|_| ())
}

/// Grava um item: um novo vai para o fim; um que já existe (a ferramenta que terminou) fica no lugar.
pub fn upsert_item(conn: &Connection, thread_id: &str, run_id: Option<&str>, item: &Item) -> rusqlite::Result<()> {
    let body = serde_json::to_string(item).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO chat_item (thread_id, id, seq, run_id, body)
         VALUES (?1, ?2, COALESCE((SELECT MAX(seq) FROM chat_item WHERE thread_id = ?1), 0) + 1, ?3, ?4)
         ON CONFLICT(thread_id, id) DO UPDATE SET body = excluded.body",
        params![thread_id, item.id, run_id, body],
    )
    .map(|_| ())
}

/// A timeline guardada, na ordem. Um corpo ilegível (de uma versão futura) fica de fora.
pub fn items(conn: &Connection, thread_id: &str) -> rusqlite::Result<Vec<Item>> {
    let mut stmt = conn.prepare("SELECT body FROM chat_item WHERE thread_id = ?1 ORDER BY seq")?;
    let bodies: Vec<String> = stmt.query_map(params![thread_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(bodies.iter().filter_map(|b| serde_json::from_str(b).ok()).collect())
}

pub fn upsert_run(conn: &Connection, thread_id: &str, run_id: &str, status: &str, started_at: Option<i64>, completed_at: Option<i64>, duration_ms: Option<i64>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO chat_run (id, thread_id, status, started_at, completed_at, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(thread_id, id) DO UPDATE SET status = excluded.status,
            started_at = COALESCE(chat_run.started_at, excluded.started_at),
            completed_at = COALESCE(excluded.completed_at, chat_run.completed_at),
            duration_ms = COALESCE(excluded.duration_ms, chat_run.duration_ms)",
        params![run_id, thread_id, status, started_at, completed_at, duration_ms],
    )
    .map(|_| ())
}

/// O status gravado de um turno (`inProgress`, `completed`, `interrupted`, `failed`), se houver.
pub fn run_status(conn: &Connection, thread_id: &str, run_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT status FROM chat_run WHERE thread_id = ?1 AND id = ?2", params![thread_id, run_id], |r| r.get(0)).optional()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    pub id: String,
    pub thread_id: String,
    #[serde(skip)]
    pub rpc_id: String,
    /// `command`, `fileChange` ou `question`.
    pub kind: String,
    pub item_id: Option<String>,
    pub title: String,
    pub detail: String,
    /// As opções de uma pergunta (JSON `[{id, question, options: [...]}]`). Numa aprovação do
    /// Claude, a ferramenta (`{tool}`); numa do Codex, `[]`.
    pub options: serde_json::Value,
    pub state: String,
    pub created_at: i64,
}

const REQUEST_COLS: &str = "id, thread_id, rpc_id, kind, item_id, title, detail, options, state, created_at";

fn request_of(r: &rusqlite::Row) -> rusqlite::Result<RequestRow> {
    let options: String = r.get(7)?;
    Ok(RequestRow {
        id: r.get(0)?, thread_id: r.get(1)?, rpc_id: r.get(2)?, kind: r.get(3)?, item_id: r.get(4)?, title: r.get(5)?,
        detail: r.get(6)?, options: serde_json::from_str(&options).unwrap_or(serde_json::Value::Null), state: r.get(8)?,
        created_at: r.get(9)?,
    })
}

pub fn insert_request(conn: &Connection, row: &RequestRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO chat_request (id, thread_id, rpc_id, kind, item_id, title, detail, options, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)",
        params![row.id, row.thread_id, row.rpc_id, row.kind, row.item_id, row.title, row.detail, row.options.to_string(), row.created_at],
    )
    .map(|_| ())
}

pub fn request(conn: &Connection, id: &str) -> rusqlite::Result<Option<RequestRow>> {
    conn.query_row(&format!("SELECT {REQUEST_COLS} FROM chat_request WHERE id = ?1"), params![id], request_of).optional()
}

pub fn pending_requests(conn: &Connection, thread_id: &str) -> rusqlite::Result<Vec<RequestRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {REQUEST_COLS} FROM chat_request WHERE thread_id = ?1 AND state = 'pending' ORDER BY created_at"))?;
    stmt.query_map(params![thread_id], request_of)?.collect()
}

/// Marca respondido pela pessoa. `false` se já não estava pendente (respondido em outro lugar, ou expirou).
pub fn answer_request(conn: &Connection, id: &str, answer: &str, now: i64) -> rusqlite::Result<bool> {
    answer_request_by(conn, id, answer, now, "person", None)
}

/// Como `answer_request`, dizendo quem respondeu (`person`, `policy`, `rule:<id>`) e por quê (auditoria).
pub fn answer_request_by(conn: &Connection, id: &str, answer: &str, now: i64, by: &str, why: Option<&str>) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE chat_request SET state = 'answered', answer = ?2, answered_at = ?3, decided_by = ?4, decided_why = ?5
          WHERE id = ?1 AND state = 'pending'",
        params![id, answer, now, by, why],
    )
    .map(|n| n > 0)
}

/// RESERVA o pedido para responder ao agente: só um quem chega primeiro, e só se ele ainda está `pending`. A reserva
/// esquecida (mais velha que `lease_ms`) pode ser tomada. `false` = não era dele; quem perde não responde nada.
pub fn reserve_request(conn: &Connection, id: &str, now: i64, lease_ms: i64) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE chat_request SET claimed_at = ?2 WHERE id = ?1 AND state = 'pending' AND (claimed_at IS NULL OR claimed_at < ?3)",
        params![id, now, now - lease_ms],
    )
    .map(|n| n == 1)
}

/// Devolve a reserva (o envio ao agente falhou): o pedido segue `pending` para a pessoa.
pub fn release_request(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_request SET claimed_at = NULL WHERE id = ?1 AND state = 'pending'", params![id]).map(|_| ())
}

/// Guarda o pedido inteiro (JSON de `permission::Subject`) para decidir sobre ele, na chegada ou depois.
pub fn set_subject(conn: &Connection, id: &str, subject: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE chat_request SET subject = ?2 WHERE id = ?1", params![id, subject]).map(|_| ())
}

pub fn subject_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn.query_row("SELECT subject FROM chat_request WHERE id = ?1", params![id], |r| r.get::<_, Option<String>>(0)).optional()?.flatten())
}

/// Quem respondeu um pedido e por quê (auditoria).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub request_id: String,
    pub answer: String,
    /// `person`, `policy` ou `rule:<id>`.
    pub by: Option<String>,
    pub why: Option<String>,
}

/// As últimas decisões de uma conversa (quem respondeu e por quê), da mais nova para a mais velha.
pub fn recent_decisions(conn: &Connection, thread_id: &str, limit: i64) -> rusqlite::Result<Vec<Decision>> {
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(answer, ''), decided_by, decided_why FROM chat_request
          WHERE thread_id = ?1 AND state = 'answered' ORDER BY answered_at DESC, id LIMIT ?2",
    )?;
    stmt.query_map(params![thread_id, limit], |r| Ok(Decision { request_id: r.get(0)?, answer: r.get(1)?, by: r.get(2)?, why: r.get(3)? }))?.collect()
}

/// Os pedidos pendentes de TODAS as conversas ativas (a varredura os decide; ver `conversa::permission`).
pub fn pending_all(conn: &Connection) -> rusqlite::Result<Vec<RequestRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {REQUEST_COLS} FROM chat_request WHERE state = 'pending'
           AND thread_id IN (SELECT id FROM chat_thread WHERE state = 'active') ORDER BY created_at"
    ))?;
    stmt.query_map([], request_of)?.collect()
}

/// Os pendentes de uma conversa expiram (o turno acabou, ou o processo do agente fechou). Devolve os ids.
pub fn expire_requests(conn: &Connection, thread_id: &str) -> rusqlite::Result<Vec<String>> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM chat_request WHERE thread_id = ?1 AND state = 'pending'")?;
        stmt.query_map(params![thread_id], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    conn.execute("UPDATE chat_request SET state = 'expired' WHERE thread_id = ?1 AND state = 'pending'", params![thread_id])?;
    Ok(ids)
}

/// O que o `sweep_orphans` marcou.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    pub runs: usize,
    pub requests: usize,
}

/// No arranque do app: nenhum agente de uma conversa sobrevive ao app, então todo turno `inProgress` e todo
/// pedido `pending` que sobrou de um crash é órfão. O turno vira `interrupted`; o que ficou aberto na ponta da
/// timeline ganha um `turnEnd` com o motivo (para a tela não mostrar um turno aberto para sempre); o pedido
/// vira `expired` (clicar nele daria "o agente já fechou"). Nunca apaga linha. Idempotente.
pub fn sweep_orphans(conn: &Connection, now: i64) -> rusqlite::Result<Sweep> {
    let runs: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT thread_id, id FROM chat_run WHERE status = 'inProgress'")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
    };
    for (thread_id, run_id) in &runs {
        conn.execute(
            "UPDATE chat_run SET status = 'interrupted', completed_at = COALESCE(completed_at, ?3) WHERE thread_id = ?1 AND id = ?2",
            params![thread_id, run_id, now],
        )?;
        // Só o turno que ficou na ponta da timeline fecha com o `turnEnd`: um fim jogado no meio fecharia o turno errado.
        let last: Option<i64> = conn.query_row("SELECT MAX(seq) FROM chat_item WHERE thread_id = ?1 AND run_id = ?2", params![thread_id, run_id], |r| r.get(0))?;
        let Some(last) = last else { continue };
        let others: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chat_item WHERE thread_id = ?1 AND seq > ?2 AND COALESCE(run_id, '') != ?3",
            params![thread_id, last, run_id],
            |r| r.get(0),
        )?;
        let end_id = format!("end:{run_id}");
        let has_end: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_item WHERE thread_id = ?1 AND id = ?2)", params![thread_id, end_id], |r| r.get(0))?;
        if others == 0 && !has_end {
            let mut end = Item::new(crate::canal::timeline::ItemKind::TurnEnd, end_id, Some(now));
            end.interrupted = Some(false);
            end.text = Some("O app foi fechado antes de o turno terminar.".into());
            upsert_item(conn, thread_id, Some(run_id), &end)?;
        }
    }
    let requests = conn.execute("UPDATE chat_request SET state = 'expired' WHERE state = 'pending'", [])?;
    Ok(Sweep { runs: runs.len(), requests })
}
