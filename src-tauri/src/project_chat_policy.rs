//! Política local de provedores do chat por pasta de projeto.
//!
//! A lista de agentes bloqueados fica no key-value `settings`, dentro do banco desta
//! instância (inclusive a instância isolada). A política vale para novos turnos e trocas
//! de agente; um turno que já começou pode terminar.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::database::DbConnection;

const SETTINGS_PREFIX: &str = "chat.project.disabled-agents.v1.";
const ALIAS_PREFIX: &str = "chat.project.policy-alias.v1.";
const MAX_PROJECT_PATH: usize = 4096;
const MAX_AGENTS: usize = 128;
const MAX_AGENT_ID: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatAgentPolicy {
    pub cwd: String,
    pub disabled_agent_ids: Vec<String>,
}

fn normalize_cwd(cwd: &str) -> Result<String, String> {
    if cwd.trim().is_empty() || cwd.len() > MAX_PROJECT_PATH || cwd.contains('\0') {
        return Err("A pasta do projeto está inválida".into());
    }
    let path = cwd.replace('\\', "/");
    let absolute = path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':')
            && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic));
    if !absolute {
        return Err("A pasta do projeto precisa ser um caminho absoluto".into());
    }
    if path == "/" || (path.len() == 3 && path.as_bytes().get(1) == Some(&b':') && path.ends_with('/')) {
        return Ok(path);
    }
    Ok(path.trim_end_matches('/').to_owned())
}

fn validate_agent_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_AGENT_ID
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("A política contém um identificador de agente inválido".into());
    }
    Ok(())
}

fn setting_key(cwd: &str) -> Result<(String, String), String> {
    let cwd = normalize_cwd(cwd)?;
    let digest = Sha256::digest(cwd.as_bytes());
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((format!("{SETTINGS_PREFIX}{hash}"), cwd))
}

fn alias_key(cwd: &str) -> Result<(String, String), String> {
    let (key, normalized) = setting_key(cwd)?;
    Ok((key.replacen(SETTINGS_PREFIX, ALIAS_PREFIX, 1), normalized))
}

fn read_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| error.to_string())
}

fn read_policy_exact(conn: &Connection, cwd: &str) -> Result<Option<ProjectChatAgentPolicy>, String> {
    let (key, normalized) = setting_key(cwd)?;
    let raw = read_setting(conn, &key)?;
    let Some(raw) = raw else { return Ok(None) };
    let policy: ProjectChatAgentPolicy = serde_json::from_str(&raw)
        .map_err(|_| "A política de agentes deste projeto está inválida".to_string())?;
    if normalize_cwd(&policy.cwd)? != normalized
        || policy.disabled_agent_ids.len() > MAX_AGENTS
    {
        return Err("A política de agentes deste projeto está inválida".into());
    }
    for id in &policy.disabled_agent_ids {
        validate_agent_id(id)?;
    }
    Ok(Some(policy))
}

fn read_policy(conn: &Connection, cwd: &str) -> Result<Option<ProjectChatAgentPolicy>, String> {
    let mut current = normalize_cwd(cwd)?;
    for _ in 0..8 {
        if let Some(policy) = read_policy_exact(conn, &current)? {
            return Ok(Some(policy));
        }
        let (key, _) = alias_key(&current)?;
        let Some(parent) = read_setting(conn, &key)? else { return Ok(None) };
        let parent = normalize_cwd(&parent)?;
        if parent == current {
            return Err("A política do projeto contém uma referência circular".into());
        }
        current = parent;
    }
    Err("A cadeia de projetos relacionados excede o limite permitido".into())
}

/// Confere a regra dentro da mesma conexão que cria ou envia a conversa.
pub(crate) fn ensure_agent_enabled(conn: &Connection, cwd: &str, agent_id: &str) -> Result<(), String> {
    let Some(policy) = read_policy(conn, cwd)? else { return Ok(()) };
    if policy.disabled_agent_ids.iter().any(|disabled| disabled == agent_id) {
        return Err(format!(
            "O agente {agent_id} está desativado neste projeto. Ative-o nas configurações do projeto para iniciar novos turnos."
        ));
    }
    Ok(())
}

/// Registra a pasta original dos worktrees temporários para que usem a política vigente do projeto.
pub(crate) fn register_worktree_alias(db: &DbConnection, worktree_cwd: &str, project_cwd: &str) -> Result<(), String> {
    let (key, _) = alias_key(worktree_cwd)?;
    let project_cwd = normalize_cwd(project_cwd)?;
    crate::database::set_setting(db, &key, &project_cwd)
}

#[tauri::command]
pub fn chat_project_agent_policy_get(
    db: State<'_, DbConnection>,
    cwd: String,
) -> Result<Option<ProjectChatAgentPolicy>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    read_policy(&conn, &cwd)
}

#[tauri::command]
pub fn chat_project_agent_policy_check(
    db: State<'_, DbConnection>,
    cwd: String,
    agent_id: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    ensure_agent_enabled(&conn, &cwd, &agent_id)
}

#[tauri::command]
pub fn chat_project_agent_policy_save(
    db: State<'_, DbConnection>,
    cwd: String,
    disabled_agent_ids: Vec<String>,
) -> Result<ProjectChatAgentPolicy, String> {
    if disabled_agent_ids.len() > MAX_AGENTS {
        return Err("A política excede o limite de agentes por projeto".into());
    }
    let (key, cwd) = setting_key(&cwd)?;
    let mut ids = disabled_agent_ids;
    for id in &ids {
        validate_agent_id(id)?;
    }
    ids.sort();
    ids.dedup();
    let policy = ProjectChatAgentPolicy { cwd, disabled_agent_ids: ids };
    let value = serde_json::to_string(&policy).map_err(|error| error.to_string())?;
    crate::database::set_setting(&db, &key, &value)?;
    Ok(policy)
}

#[tauri::command]
pub fn chat_project_agent_policy_clear(
    db: State<'_, DbConnection>,
    cwd: String,
) -> Result<(), String> {
    let (key, _) = setting_key(&cwd)?;
    crate::database::wait_until_db_ready();
    let conn = db.lock().map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [&key])
        .map_err(|error| error.to_string())?;
    Ok(())
}
