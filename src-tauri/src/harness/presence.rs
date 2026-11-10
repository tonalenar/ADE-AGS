//! Presença de cada instância viva da ADE no próprio SQLite (Fase 5, contrato §13).
//!
//! O lease de boot só serializa as varreduras. Duas instâncias no mesmo `data.db` precisam de um
//! batimento: id da instância, PID e validade. A varredura pula turno, tarefa ou integrante cujo
//! dono ainda tem presença válida. Dono desconhecido (dado antigo, coluna vazia) continua no
//! comportamento de hoje.
//!
//! O laço renova a cada [`HEARTBEAT_EVERY_MS`] (30 s). A validade é três batimentos
//! ([`PRESENCE_TTL_MS`]): um atraso do laço não parece morte. O `agora` é argumento de quem chama;
//! o laço injeta `util::now_ts_ms`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::database::DbConnection;

/// Intervalo do laço. Não é polling de trabalho: só renova a linha desta instância.
pub const HEARTBEAT_EVERY_MS: i64 = 30_000;
/// Depois do último batimento a presença vale este prazo. Vencido, a varredura trata a instância como morta.
pub const PRESENCE_TTL_MS: i64 = HEARTBEAT_EVERY_MS * 3;

struct ProcessPresence {
    id: String,
    pid: i64,
}

static PROCESS: OnceLock<ProcessPresence> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_instance (
            id          TEXT PRIMARY KEY,
            pid         INTEGER NOT NULL,
            beat_at     INTEGER NOT NULL,
            valid_until INTEGER NOT NULL
        );",
    )?;
    // Dono do que está em execução. NULL = dado anterior a esta coluna: a varredura não muda de regra.
    add_text_column(conn, "chat_run", "owner_instance")?;
    add_text_column(conn, "tasks", "owner_instance")?;
    add_text_column(conn, "mission_member_state", "owner_instance")?;
    Ok(())
}

fn add_text_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<()> {
    let exists = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
        .exists([table])?;
    if !exists {
        return Ok(());
    }
    let has = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))?
        .exists([column])?;
    if !has {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT;"))?;
    }
    Ok(())
}

fn process() -> &'static ProcessPresence {
    PROCESS.get_or_init(|| ProcessPresence {
        id: Uuid::new_v4().to_string(),
        pid: i64::from(std::process::id()),
    })
}

/// O id desta instância, depois que [`start`] armou o processo. `None` nos testes que não sobem o laço:
/// quem grava turno ou tarefa deixa o dono vazio e a varredura segue a regra antiga.
pub fn current_id() -> Option<&'static str> {
    PROCESS.get().map(|process| process.id.as_str())
}

/// Grava ou renova a presença. `valid_until = now + PRESENCE_TTL_MS`.
pub fn beat(conn: &Connection, id: &str, pid: i64, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO harness_instance (id, pid, beat_at, valid_until) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, beat_at = excluded.beat_at, valid_until = excluded.valid_until",
        params![id, pid, now, now.saturating_add(PRESENCE_TTL_MS)],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// A instância bateu e a validade ainda não venceu. `valid_until > now`.
pub fn is_live(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM harness_instance WHERE id = ?1 AND valid_until > ?2)",
        params![id, now],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Dono vazio ou desconhecido não está protegido. Dono com presença válida está.
pub fn owner_is_protected(conn: &Connection, owner: Option<&str>, now: i64) -> Result<bool, String> {
    match owner.map(str::trim).filter(|owner| !owner.is_empty()) {
        Some(owner) => is_live(conn, owner, now),
        None => Ok(false),
    }
}

/// Um batimento agora e um laço de 30 s. A segunda chamada não abre outro laço.
pub fn start(db: DbConnection) {
    let process = process();
    let id = process.id.clone();
    let pid = process.pid;
    if let Err(error) = beat_now(&db, &id, pid) {
        eprintln!("[harness] não foi possível gravar a presença desta instância: {error}");
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("harness-presence".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(HEARTBEAT_EVERY_MS as u64));
                if let Err(error) = beat_now(&db, &id, pid) {
                    eprintln!("[harness] não foi possível renovar a presença: {error}");
                }
            }
        })
        .expect("hilo de presença do harness");
}

fn beat_now(db: &DbConnection, id: &str, pid: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    beat(&conn, id, pid, crate::util::now_ts_ms())
}
