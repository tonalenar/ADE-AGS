//! Cuánto usó cada cuenta, y hasta dónde se la deja usar.
//!
//! ## El registro
//!
//! Una fila de `usage_events` por INTENTO de tarea, con la cuenta que de verdad lo corrió.
//! Sumar sobre `tasks` no alcanza: cuando una tarea pasa a otra cuenta (`reroute_task`), su
//! `account_id` cambia y lo que gastó la primera se le atribuiría a la segunda. Se escribe
//! en `store::finish_task`, que es por donde termina toda tarea, así que no hay camino que
//! se lo saltee.
//!
//! El costo es el que reportó la CLI (Claude Code lo reporta siempre, OpenCode también).
//! Codex no reporta costo: queda `NULL` y se muestran sus tokens. No se inventan precios.
//!
//! ## Los límites
//!
//! Por cuenta, opcionales, guardados en `settings`:
//!
//! - `max_concurrent`: cuántas tareas a la vez. Varias cuentas de un mismo plan comparten
//!   límites de velocidad del lado del proveedor, y una flota grande sin tope las satura.
//! - `daily_budget_usd`: cuánto costo reportado en las últimas 24 h. Ventana móvil, no "hoy":
//!   no depende de la zona horaria ni corta a medianoche una racha de trabajo.
//!
//! El ruteo saltea una cuenta que llegó a su tope (ver `routing::account_problem`), y el
//! scheduler lo vuelve a mirar al lanzar, porque entre planificar y lanzar puede llenarse.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::types::{status, Task, TaskOutcome};
use crate::database::DbConnection;

const DAY_SECS: i64 = 24 * 3600;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountLimits {
    pub max_concurrent: Option<u32>,
    pub daily_budget_usd: Option<f64>,
}

fn limits_key(account_key: &str) -> String {
    format!("accounts.limits.{account_key}")
}

pub fn load_limits(conn: &Connection, account_key: &str) -> AccountLimits {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [limits_key(account_key)], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_limits(db: &DbConnection, account_key: &str, limits: &AccountLimits) -> Result<(), String> {
    if limits.max_concurrent == Some(0) {
        return Err("O máximo de tarefas simultâneas precisa ser pelo menos 1".into());
    }
    if limits.daily_budget_usd.is_some_and(|b| !b.is_finite() || b < 0.0) {
        return Err("O orçamento precisa ser um número positivo".into());
    }
    let raw = serde_json::to_string(limits).map_err(|e| e.to_string())?;
    crate::database::set_setting(db, &limits_key(account_key), &raw)
}

/// Anota un intento terminado. Lo llama `store::finish_task` ANTES de actualizar la fila,
/// con la tarea como estaba: es la cuenta que corrió este intento.
pub fn record_attempt(conn: &Connection, task: &Task, outcome: &TaskOutcome, now: i64) -> Result<(), String> {
    let key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());
    conn.execute(
        "INSERT INTO usage_events (task_id, run_id, agent_id, account_key, model, ok, tokens_in, tokens_out, cost_usd, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            task.id,
            task.run_id,
            task.agent_id,
            key,
            task.model,
            outcome.ok as i64,
            outcome.tokens_in,
            outcome.tokens_out,
            outcome.cost_usd,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Costo reportado por la cuenta desde `since`.
pub fn spent_since(conn: &Connection, account_key: &str, since: i64) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE account_key = ?1 AND created_at >= ?2",
        rusqlite::params![account_key, since],
        |r| r.get(0),
    )
    .unwrap_or(0.0)
}

/// Tareas de la cuenta que ocupan lugar ahora (lanzadas o por lanzarse), en cualquier run.
pub fn running_on(conn: &Connection, account_key: &str) -> i64 {
    running_with_status(conn, account_key, &[status::RUNNING, status::READY])
}

/// Qué tope alcanzó una cuenta. Se tratan distinto: uno se libera en cuanto termina una
/// tarea (vale esperar), el otro recién cuando sale de la ventana de 24 h.
#[derive(Debug, Clone, PartialEq)]
pub enum Limit {
    Concurrency(String),
    Budget(String),
}

impl Limit {
    pub fn reason(&self) -> &str {
        match self {
            Limit::Concurrency(r) | Limit::Budget(r) => r,
        }
    }
}

/// Por qué una cuenta no puede tomar OTRA tarea ahora, si llegó a alguno de sus topes.
/// `running` cuenta las que ya ocupan lugar (sin contar la que se está por lanzar).
pub fn limit_problem(limits: &AccountLimits, running: i64, spent_24h: f64) -> Option<Limit> {
    if let Some(budget) = limits.daily_budget_usd
        && spent_24h >= budget
    {
        return Some(Limit::Budget(format!(
            "gastó US$ {spent_24h:.2} en 24 h, su presupuesto es US$ {budget:.2}"
        )));
    }
    if let Some(max) = limits.max_concurrent
        && running >= max as i64
    {
        return Some(Limit::Concurrency(format!("ya corre {running} tarea(s), su máximo es {max}")));
    }
    None
}

/// Lo mismo, leyendo de la base. Para el scheduler, justo antes de lanzar.
///
/// Cuenta solo las que ya CORREN, más `admitted`: las que el mismo tick ya dejó pasar para
/// esta cuenta. Las `ready` no: en un tick todas las despachadas lo están a la vez, y con
/// máximo 1 cada una vería a la otra y no arrancaría ninguna.
pub fn blocked(conn: &Connection, account_key: &str, now: i64, admitted: i64) -> Option<Limit> {
    let limits = load_limits(conn, account_key);
    if limits == AccountLimits::default() {
        return None;
    }
    let running = running_with_status(conn, account_key, &[status::RUNNING]) + admitted;
    limit_problem(&limits, running, spent_since(conn, account_key, now - DAY_SECS))
}

fn running_with_status(conn: &Connection, account_key: &str, statuses: &[&str]) -> i64 {
    let placeholders = (0..statuses.len()).map(|i| format!("?{}", i + 2)).collect::<Vec<_>>().join(", ");
    let (filter, param) = match account_key.strip_prefix("system:") {
        Some(agent) => ("agent_id = ?1 AND account_id IS NULL", agent),
        None => ("account_id = ?1", account_key),
    };
    let sql = format!("SELECT COUNT(*) FROM tasks WHERE {filter} AND status IN ({placeholders})");
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&param];
    params.extend(statuses.iter().map(|s| s as &dyn rusqlite::ToSql));
    conn.query_row(&sql, params.as_slice(), |r| r.get(0)).unwrap_or(0)
}

/// Lo que usó una cuenta en un período.
#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_key: String,
    pub agent_id: String,
    pub attempts: i64,
    pub failed: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    /// `None` = ningún intento reportó costo (Codex): no es cero, es "no se sabe".
    pub cost_usd: Option<f64>,
    pub last_at: Option<i64>,
    pub limits: AccountLimits,
    pub running: i64,
    pub spent_24h: f64,
}

/// El uso de todas las cuentas desde `since`, más sus límites y lo que corren ahora.
pub fn summary(conn: &Connection, since: i64, now: i64) -> Result<Vec<AccountUsage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_key, agent_id, COUNT(*), SUM(ok = 0), COALESCE(SUM(tokens_in), 0),
                    COALESCE(SUM(tokens_out), 0), SUM(cost_usd), MAX(created_at)
             FROM usage_events WHERE created_at >= ?1
             GROUP BY account_key, agent_id ORDER BY account_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([since], |r| {
            Ok(AccountUsage {
                account_key: r.get(0)?,
                agent_id: r.get(1)?,
                attempts: r.get(2)?,
                failed: r.get(3)?,
                tokens_in: r.get(4)?,
                tokens_out: r.get(5)?,
                cost_usd: r.get(6)?,
                last_at: r.get(7)?,
                ..Default::default()
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let mut usage = row.map_err(|e| e.to_string())?;
        usage.limits = load_limits(conn, &usage.account_key);
        usage.running = running_on(conn, &usage.account_key);
        usage.spent_24h = spent_since(conn, &usage.account_key, now - DAY_SECS);
        out.push(usage);
    }
    Ok(out)
}
