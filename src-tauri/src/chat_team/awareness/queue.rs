//! A fila de tarefas do time: o orquestrador enfileira uma tarefa com condição e a ADE a lança sozinha quando a
//! condição vale (e o limite e a carga deixam), avisando o orquestrador. Persistente e só aditiva: nada aqui apaga
//! dado do usuário; um item sai da fila mudando de estado (`launched`, `cancelled`, `failed`), nunca por `DELETE`.
//!
//! As condições e a decisão "pode lançar" são puras (`unmet`); o SQL é sobre `&Connection`.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::load::Load;

/// No máximo tantas tarefas esperando por orquestrador.
pub const MAX_PENDING: usize = 20;

pub const KIND_MEMBER_DONE: &str = "member_done";
pub const KIND_LOAD_LOW: &str = "load_low";
pub const KIND_BRANCH: &str = "branch";

pub const PENDING: &str = "pending";
#[cfg(test)]
pub const LAUNCHED: &str = "launched";
#[cfg(test)]
pub const CANCELLED: &str = "cancelled";

/// Uma condição de espera. `target` é a conversa (`thread:<id>`) ou o branch; `label` é como o orquestrador a chamou.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cond {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// O orquestrador dono (`thread:<id>` ou o id da aba).
    pub parent: String,
    pub cwd: String,
    pub title: String,
    pub task: String,
    /// Os argumentos de `chat_new` guardados (agente, modelo, esforço, conta, contexto).
    pub args: serde_json::Value,
    pub areas: Vec<String>,
    pub conditions: Vec<Cond>,
    pub status: String,
    /// O último motivo de espera (ou de falha) calculado.
    pub reason: String,
    pub thread_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub launched_at: Option<i64>,
}

pub struct NewItem<'a> {
    pub parent: &'a str,
    pub cwd: &'a str,
    pub title: &'a str,
    pub task: &'a str,
    pub args: &'a serde_json::Value,
    pub areas: &'a [String],
    pub conditions: &'a [Cond],
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_team_queue (
            id TEXT PRIMARY KEY,
            parent TEXT NOT NULL,
            cwd TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            task TEXT NOT NULL,
            args TEXT NOT NULL DEFAULT '{}',
            areas TEXT NOT NULL DEFAULT '[]',
            conditions TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','launched','cancelled','failed')),
            reason TEXT NOT NULL DEFAULT '',
            thread_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            launched_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_chat_team_queue_parent ON chat_team_queue(parent, status, created_at);
        CREATE TABLE IF NOT EXISTS chat_team_claim (
            thread_id TEXT PRIMARY KEY,
            parent TEXT NOT NULL,
            areas TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_team_claim_parent ON chat_team_claim(parent);",
    )
}

const COLS: &str = "id, parent, cwd, title, task, args, areas, conditions, status, reason, thread_id, created_at, updated_at, launched_at";

fn item_of(row: &rusqlite::Row) -> rusqlite::Result<Item> {
    let json = |text: String| serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null);
    Ok(Item {
        id: row.get(0)?,
        parent: row.get(1)?,
        cwd: row.get(2)?,
        title: row.get(3)?,
        task: row.get(4)?,
        args: json(row.get(5)?),
        areas: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        conditions: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
        status: row.get(8)?,
        reason: row.get(9)?,
        thread_id: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        launched_at: row.get(13)?,
    })
}

pub fn enqueue(conn: &Connection, new: &NewItem, now: i64) -> Result<Item, String> {
    migrate(conn).map_err(err)?;
    if new.conditions.is_empty() {
        return Err("a fila exige ao menos uma condição (--after, --when-load-low ou --after-branch); sem condição, use chat_new".into());
    }
    let waiting: i64 = conn
        .query_row("SELECT COUNT(*) FROM chat_team_queue WHERE parent = ?1 AND status = 'pending'", [new.parent], |r| r.get(0))
        .map_err(err)?;
    if waiting as usize >= MAX_PENDING {
        return Err(format!("a fila do time já tem {MAX_PENDING} tarefas esperando; cancele alguma com `ags team queue cancel <id>`"));
    }
    let id = format!("q{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let conditions = serde_json::to_string(new.conditions).map_err(|e| e.to_string())?;
    let areas = serde_json::to_string(new.areas).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_team_queue (id, parent, cwd, title, task, args, areas, conditions, status, reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', '', ?9, ?9)",
        params![id, new.parent, new.cwd, new.title, new.task, new.args.to_string(), areas, conditions, now],
    )
    .map_err(err)?;
    get(conn, &id)?.ok_or_else(|| "a tarefa enfileirada sumiu".into())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Item>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {COLS} FROM chat_team_queue WHERE id = ?1"), [id], item_of).optional().map_err(err)
}

/// As tarefas de um orquestrador (ou de todos) na ordem de chegada. `with_done` inclui as já resolvidas (as últimas 20).
pub fn list(conn: &Connection, parent: Option<&str>, with_done: bool) -> Result<Vec<Item>, String> {
    migrate(conn).map_err(err)?;
    let sql = format!(
        "SELECT {COLS} FROM chat_team_queue WHERE (?1 IS NULL OR parent = ?1) AND (?2 = 1 OR status = 'pending')
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at ASC, rowid ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt.query_map(params![parent, with_done as i64], item_of).map_err(err)?;
    let mut items: Vec<Item> = rows.collect::<Result<_, _>>().map_err(err)?;
    let mut done = 0;
    items.retain(|item| item.status == PENDING || {
        done += 1;
        done <= 20
    });
    Ok(items)
}

pub fn cancel(conn: &Connection, id: &str, parent: Option<&str>, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    let n = conn
        .execute(
            "UPDATE chat_team_queue SET status = 'cancelled', reason = 'cancelada', updated_at = ?2
             WHERE id = ?1 AND status = 'pending' AND (?3 IS NULL OR parent = ?3)",
            params![id, now, parent],
        )
        .map_err(err)?;
    Ok(n > 0)
}

/// Reserva o item para o lançamento (`pending` → `launched`, sem `thread_id` ainda). Só um lançador ganha.
pub fn claim_launch(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    let n = conn
        .execute("UPDATE chat_team_queue SET status = 'launched', reason = 'lançando', updated_at = ?2, launched_at = ?2 WHERE id = ?1 AND status = 'pending'", params![id, now])
        .map_err(err)?;
    Ok(n > 0)
}

pub fn set_thread(conn: &Connection, id: &str, thread_id: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE chat_team_queue SET thread_id = ?2, reason = 'lançada', updated_at = ?3 WHERE id = ?1", params![id, thread_id, now]).map_err(err)?;
    Ok(())
}

pub fn mark_failed(conn: &Connection, id: &str, reason: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE chat_team_queue SET status = 'failed', reason = ?2, updated_at = ?3 WHERE id = ?1", params![id, reason, now]).map_err(err)?;
    Ok(())
}

/// Grava o motivo de espera mais recente, só se mudou.
pub fn set_reason(conn: &Connection, id: &str, reason: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE chat_team_queue SET reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'pending' AND reason <> ?2", params![id, reason, now]).map_err(err)?;
    Ok(())
}

// ── Áreas declaradas por quem já está trabalhando ────────────────────

pub fn claim_save(conn: &Connection, thread_id: &str, parent: &str, areas: &[String], now: i64) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    if areas.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string(areas).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_team_claim (thread_id, parent, areas, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(thread_id) DO UPDATE SET areas = excluded.areas",
        params![thread_id, parent, json, now],
    )
    .map_err(err)?;
    Ok(())
}

/// `(conversa, áreas)` declaradas sob um orquestrador.
pub fn claims(conn: &Connection, parent: &str) -> Result<Vec<(String, Vec<String>)>, String> {
    migrate(conn).map_err(err)?;
    let mut stmt = conn.prepare("SELECT thread_id, areas FROM chat_team_claim WHERE parent = ?1").map_err(err)?;
    let rows = stmt
        .query_map([parent], |row| Ok((row.get::<_, String>(0)?, serde_json::from_str::<Vec<String>>(&row.get::<_, String>(1)?).unwrap_or_default())))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

// ── A decisão (pura) ─────────────────────────────────────────────────

/// O que a condição precisa saber do mundo.
pub struct Ctx<'a> {
    /// Estado real de cada integrante/filho (`thread:<id>` → `working`, `idle`…). Quem não aparece já saiu (fechado).
    pub states: &'a HashMap<String, String>,
    pub load: &'a Load,
    /// Branches (ou refs) citados por alguma condição que existem no repositório.
    pub branches: &'a HashSet<String>,
}

/// Por que a condição ainda não vale; `None` quando vale.
pub fn unmet(cond: &Cond, ctx: &Ctx) -> Option<String> {
    let label = || cond.label.clone().or_else(|| cond.target.clone()).unwrap_or_default();
    match cond.kind.as_str() {
        KIND_MEMBER_DONE => {
            let target = cond.target.as_deref().unwrap_or("");
            match ctx.states.get(target).map(String::as_str) {
                Some("working") | Some("waiting_input") => Some(format!("esperando {} terminar", label())),
                _ => None,
            }
        }
        KIND_LOAD_LOW => ctx.load.overloaded.then(|| format!("esperando a carga baixar (load {:.1}, limite {:.0})", ctx.load.load1, ctx.load.threshold)),
        KIND_BRANCH => {
            let target = cond.target.as_deref().unwrap_or("");
            (!ctx.branches.contains(target)).then(|| format!("esperando o branch {target} existir"))
        }
        other => Some(format!("condição desconhecida: {other}")),
    }
}

/// Todos os motivos que ainda seguram o item. Vazio = a condição vale.
pub fn waiting_on(item: &Item, ctx: &Ctx) -> Vec<String> {
    item.conditions.iter().filter_map(|cond| unmet(cond, ctx)).collect()
}

/// Os branches que as condições dos itens pendentes citam (para quem chama conferir no git, fora do lock do banco).
pub fn branches_wanted(items: &[Item]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for cond in items.iter().flat_map(|i| i.conditions.iter()).filter(|c| c.kind == KIND_BRANCH) {
        if let Some(target) = &cond.target {
            if !out.contains(target) {
                out.push(target.clone());
            }
        }
    }
    out
}

/// Há algum item pendente cuja condição depende da carga? Então o laço precisa reler a carga de tempos em tempos.
pub fn needs_load_timer(items: &[Item]) -> bool {
    items.iter().any(|i| i.status == PENDING && i.conditions.iter().any(|c| c.kind == KIND_LOAD_LOW || c.kind == KIND_BRANCH))
}
