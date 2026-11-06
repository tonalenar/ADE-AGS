//! "Ativa em todos os agentes": uma skill montada em toda aba ou conversa ativa, sem anexar projeto a projeto.
//!
//! É o liga/desliga por skill do painel de Skills. Serve às skills de computer use que vêm com a app
//! (`jev-sim-use`, `agent-desktop`): elas precisam estar onde o agente está quando a pessoa pede para mexer no
//! simulador, no Mac ou no navegador, e não em um projeto que alguém lembrou de configurar. Desligada, a skill
//! sai de todas as pastas na hora (a próxima reconciliação tira o symlink) e o agente que abrir depois não a vê.
//!
//! A lista mora em `settings` (`skills.always_on`, JSON com os ids). Uma skill apagada some da lista sozinha: o id
//! que não acha linha é ignorado.

use crate::database::DbConnection;
use rusqlite::OptionalExtension;

use super::links::{fetch_skill_row, reconcile_link_dirs};
use super::types::SkillInfo;

pub(crate) const KEY: &str = "skills.always_on";

pub(super) fn ids(conn: &rusqlite::Connection) -> Vec<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write(conn: &rusqlite::Connection, ids: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Liga ou desliga, sem reconciliar. Devolve se mudou algo.
pub(super) fn set(conn: &rusqlite::Connection, skill_id: &str, on: bool) -> Result<bool, String> {
    let mut list = ids(conn);
    let had = list.iter().any(|id| id == skill_id);
    if had == on {
        return Ok(false);
    }
    if on {
        list.push(skill_id.to_string());
    } else {
        list.retain(|id| id != skill_id);
    }
    write(conn, &list)?;
    Ok(true)
}

/// As skills ligadas para todos, se há uma aba aberta ou conversa ativa daquele agente naquela pasta.
pub(super) fn skills_for(conn: &rusqlite::Connection, cwd: &str, agent_id: &str) -> Vec<SkillInfo> {
    let list = ids(conn);
    if list.is_empty() {
        return vec![];
    }
    let open: bool = conn
        .query_row(
            "SELECT
                EXISTS(SELECT 1 FROM tabs t JOIN windows w ON w.id = t.window_id AND w.is_open = 1
                       WHERE t.cwd = ?1 AND t.agent_id = ?2)
                OR EXISTS(SELECT 1 FROM chat_thread c WHERE c.cwd = ?1 AND c.agent_id = ?2 AND c.state = 'active')",
            [cwd, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !open {
        return vec![];
    }
    list.iter().filter_map(|id| fetch_skill_row(conn, id).ok()).collect()
}

/// (cwd, agente) de todas as abas abertas e conversas ativas: ligar ou desligar mexe em todas as pastas de uma vez.
fn open_link_dirs(conn: &rusqlite::Connection) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT t.cwd, t.agent_id FROM tabs t JOIN windows w ON w.id = t.window_id AND w.is_open = 1
         UNION SELECT DISTINCT c.cwd, c.agent_id FROM chat_thread c WHERE c.state = 'active'",
    ) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) else { return vec![] };
    rows.filter_map(|r| r.ok()).collect()
}

/// Liga na primeira instalação de uma skill que vem com a app. Se a pessoa desligou depois, uma atualização não liga
/// de novo: só a instalação conta.
pub(super) fn enable_on_install(db: &DbConnection, skill_id: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    if set(&conn, skill_id, true)? {
        reconcile_link_dirs(&conn, &open_link_dirs(&conn));
    }
    Ok(())
}

#[tauri::command]
pub fn list_always_on_skills(db: tauri::State<DbConnection>) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(ids(&conn))
}

#[tauri::command]
pub fn set_skill_always_on(skill_id: String, on: bool, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    if on {
        // Só uma skill instalada pode ser ligada: um id inventado não entra na lista.
        fetch_skill_row(&conn, &skill_id)?;
    }
    if set(&conn, &skill_id, on)? {
        reconcile_link_dirs(&conn, &open_link_dirs(&conn));
    }
    Ok(())
}
