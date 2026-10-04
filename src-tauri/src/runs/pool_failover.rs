//! Límites de failover por pool. El estado persistente usa `settings`; el cooldown solo
//! afecta `routing::pick_in_pool` y vive en memoria durante 30 minutos.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::accounts::pools::PoolOrigin;
use crate::database::DbConnection;

pub(crate) const MAX_FAILOVERS_PER_POOL_HOUR: usize = 3;
pub(crate) const WINDOW_SECS: i64 = 60 * 60;
pub(crate) const COOLDOWN_SECS: i64 = 30 * 60;

fn task_pool_key(task_id: &str) -> String {
    format!("runs.task_pool.{task_id}")
}

fn task_failover_key(task_id: &str) -> String {
    format!("runs.pool_failover.{task_id}")
}

fn pool_window_key(pool_id: &str) -> String {
    format!("runs.pool_failover.pool.{pool_id}")
}

/// Só falha classificada como rate limit pode acionar failover, e apenas no pool que
/// autorizou a opção, uma vez por tarefa.
pub(crate) fn failure_eligible(
    kind: super::failure::FailureKind,
    opted_in: bool,
    already_failed_over: bool,
) -> bool {
    kind == super::failure::FailureKind::RateLimited && opted_in && !already_failed_over
}

/// Remove do histórico os eventos que já saíram da janela deslizante. Timestamps futuros
/// permanecem contados, para um relógio que volte não liberar failovers extras.
pub(crate) fn prune_hour_window(timestamps: &[i64], now: i64) -> Vec<i64> {
    timestamps
        .iter()
        .copied()
        .filter(|at| now.saturating_sub(*at) < WINDOW_SECS)
        .collect()
}

pub(crate) fn pool_hourly_limit_available(timestamps: &[i64], now: i64) -> bool {
    prune_hour_window(timestamps, now).len() < MAX_FAILOVERS_PER_POOL_HOUR
}

pub(crate) fn cooldown_active(until: Option<i64>, now: i64) -> bool {
    until.is_some_and(|until| until > now)
}

lazy_static::lazy_static! {
    static ref ACCOUNT_COOLDOWNS: Mutex<HashMap<String, i64>> = Mutex::new(HashMap::new());
}

/// Marca a conta que recebeu rate limit. É uma regra própria de pools e não muda rotas
/// `Auto` ou contas fixadas.
pub(crate) fn cool_down_account(account_key: &str, now: i64) {
    let mut cooldowns = ACCOUNT_COOLDOWNS.lock().unwrap_or_else(|e| e.into_inner());
    let until = now.saturating_add(COOLDOWN_SECS);
    cooldowns
        .entry(account_key.to_string())
        .and_modify(|current| *current = (*current).max(until))
        .or_insert(until);
}

pub(crate) fn account_in_cooldown(account_key: &str, now: i64) -> bool {
    let mut cooldowns = ACCOUNT_COOLDOWNS.lock().unwrap_or_else(|e| e.into_inner());
    let until = cooldowns.get(account_key).copied();
    if until.is_some_and(|until| until <= now) {
        cooldowns.remove(account_key);
        return false;
    }
    cooldown_active(until, now)
}

/// Persiste a origem da tarefa sem adicionar coluna à tabela `tasks`.
pub(crate) fn record_task_pool(
    conn: &Connection,
    task_id: &str,
    origin: Option<&PoolOrigin>,
) -> Result<(), String> {
    let key = task_pool_key(task_id);
    match origin {
        Some(origin) => {
            let value = serde_json::to_string(origin).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn task_pool(db: &DbConnection, task_id: &str) -> Option<PoolOrigin> {
    crate::database::get_setting(db, &task_pool_key(task_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

pub(crate) fn task_already_failed_over(db: &DbConnection, task_id: &str) -> bool {
    crate::database::get_setting(db, &task_failover_key(task_id))
        .ok()
        .flatten()
        .is_some()
}

/// Reserva atomicamente los límites persistentes antes de cambiar la cuenta. Si el estado
/// guardado no se puede leer o escribir, se falla cerrado y no se hace failover.
pub(crate) fn reserve_failover(
    db: &DbConnection,
    task_id: &str,
    pool_id: &str,
    now: i64,
) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let task_key = task_failover_key(task_id);
    let already: Option<String> = tx
        .query_row("SELECT value FROM settings WHERE key = ?1", [&task_key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if already.is_some() {
        return Ok(false);
    }

    let pool_key = pool_window_key(pool_id);
    let raw: Option<String> = tx
        .query_row("SELECT value FROM settings WHERE key = ?1", [&pool_key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let mut history = match raw {
        Some(raw) => serde_json::from_str::<Vec<i64>>(&raw).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    history = prune_hour_window(&history, now);
    if !pool_hourly_limit_available(&history, now) {
        return Ok(false);
    }
    history.push(now);
    let value = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![pool_key, value],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&task_key],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod test;
