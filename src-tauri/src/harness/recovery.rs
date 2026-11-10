//! Lease SQLite que serializa a reconciliação de boot entre instâncias do ADE.
//!
//! O lease fica no mesmo banco das intenções. A tomada é um `UPDATE` condicional numa transação
//! `Immediate`; o relógio é sempre fornecido pelo chamador. Um crash libera a tomada quando vencer.

use rusqlite::{Connection, TransactionBehavior, params};
use uuid::Uuid;

use crate::database::DbConnection;

const LEASE_MS: i64 = 5 * 60 * 1000;

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_recovery_lease (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            owner       TEXT,
            lease_until INTEGER
        );
        INSERT OR IGNORE INTO harness_recovery_lease (id, owner, lease_until) VALUES (1, NULL, NULL);",
    )
}

/// Tenta tomar o lease. `false` significa que outra instância ainda o possui.
pub fn acquire(
    conn: &mut Connection,
    owner: &str,
    now: i64,
    lease_ms: i64,
) -> Result<bool, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE harness_recovery_lease SET owner = ?1, lease_until = ?2
         WHERE id = 1 AND (owner IS NULL OR lease_until IS NULL OR lease_until <= ?3)",
        params![owner, now.saturating_add(lease_ms.max(1)), now],
    )
    .map_err(|error| error.to_string())?;
    let acquired = tx.changes() == 1;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(acquired)
}

pub fn release(conn: &Connection, owner: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE harness_recovery_lease SET owner = NULL, lease_until = NULL WHERE id = 1 AND owner = ?1",
        [owner],
    )
    .map(|changed| changed == 1)
    .map_err(|error| error.to_string())
}

/// Executa uma reconciliação de boot por vez. O lock Rust do banco é liberado durante o trabalho;
/// a linha SQLite permanece como exclusão mútua para as outras conexões e instâncias.
pub fn with_boot_lease<T>(
    db: &DbConnection,
    now: i64,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<Option<T>, String> {
    let owner = format!("boot:{}", Uuid::new_v4());
    {
        let mut conn = db.lock().map_err(|error| error.to_string())?;
        if !acquire(&mut conn, &owner, now, LEASE_MS)? {
            return Ok(None);
        }
    }

    let result = work();
    let released = db
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|conn| release(&conn, &owner));
    match (result, released) {
        (Ok(value), Ok(true)) => Ok(Some(value)),
        (Ok(_), Ok(false)) => Err("o lease de recuperação foi tomado por outra instância".into()),
        (Err(error), Ok(_)) => Err(error),
        (_, Err(error)) => Err(error),
    }
}

#[cfg(test)]
mod test;
