//! El almacén de cuentas: dónde vive cada perfil, cómo se valida su nombre y cómo se
//! traduce una fila de la base al tipo que ve el frontend.

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::profiles::{read_identity, spec_for};

// ── Nombre de la cuenta ─────────────────────────────────────────

/// El nombre que elige el usuario ES el nombre de la carpeta, así que se valida como tal.
///
/// No alcanza con rechazar `/`: `..` sola escaparía del almacén, y en Windows además hay
/// nombres reservados (`CON`, `NUL`, …) que no se pueden crear. Se acepta un conjunto
/// chico y explícito en vez de intentar listar todo lo prohibido.
pub fn validate_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    if name.len() > 40 {
        return Err("El nombre no puede tener más de 40 caracteres".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Solo se permiten letras, números, '-', '_' y '.'".into());
    }
    if name.starts_with('.') || name.chars().all(|c| c == '.') {
        return Err("El nombre no puede empezar con '.'".into());
    }
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3",
    ];
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err("Ese nombre está reservado por el sistema".into());
    }
    Ok(())
}

// ── Almacén ─────────────────────────────────────────────────────

pub(super) fn accounts_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta de datos de la app: {e}"))?;
    Ok(base.join("accounts"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub id: String,
    pub agent_id: String,
    /// Nombre simbólico elegido por el usuario; también es el nombre de la carpeta.
    pub name: String,
    pub dir: String,
    pub env_var: String,
    pub login_command: String,
    /// Si la TUI dejó rastro de una sesión iniciada dentro de este perfil.
    pub logged_in: bool,
    /// Mail (u otro identificador) de la cuenta, cuando la TUI lo expone.
    pub label: Option<String>,
    pub created_at: i64,
    /// `login` (el login hecho en la TUI) o `api_key`.
    pub kind: AccountKind,
    /// Endpoint compatible en vez del oficial (solo cuentas `api_key` de Claude Code).
    pub base_url: Option<String>,
    /// Los últimos caracteres de la key, para reconocerla. Nunca la key.
    pub key_hint: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Login,
    ApiKey,
}

impl AccountKind {
    pub fn parse(raw: &str) -> Self {
        if raw == "api_key" { AccountKind::ApiKey } else { AccountKind::Login }
    }
}

/// Una TUI que soporta cuentas múltiples, con el dato de si está instalada.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapableAgent {
    pub agent_id: String,
    pub label: String,
    pub env_var: String,
    pub installed: bool,
}

/// Una fila de `agent_accounts`, como la lee [`row_to_account`].
pub(super) struct AccountRow {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub dir: String,
    pub created_at: i64,
    pub kind: AccountKind,
    pub base_url: Option<String>,
    pub key_hint: Option<String>,
}

/// Las columnas que espera [`AccountRow::from_row`], en ese orden.
pub(super) const ACCOUNT_COLUMNS: &str = "id, agent_id, name, dir, created_at, kind, base_url, key_hint";

impl AccountRow {
    pub(super) fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(AccountRow {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            name: row.get(2)?,
            dir: row.get(3)?,
            created_at: row.get(4)?,
            kind: AccountKind::parse(&row.get::<_, String>(5)?),
            base_url: row.get(6)?,
            key_hint: row.get(7)?,
        })
    }
}

pub(super) fn row_to_account(row: AccountRow) -> Option<AgentAccount> {
    let spec = spec_for(&row.agent_id)?;
    let path = PathBuf::from(&row.dir);
    let (marker_logged_in, label) = read_identity(&path, spec);
    // Una cuenta de Claude Code por API key no deja marcador de login: está "lista" si la
    // key sigue en el llavero. Codex sí lo deja (`auth.json`), y se lee como siempre.
    let logged_in = match (row.kind, row.agent_id.as_str()) {
        (AccountKind::ApiKey, "claude-code") => super::secrets::load(&row.id).is_some(),
        _ => marker_logged_in,
    };
    let label = match row.kind {
        AccountKind::ApiKey => Some(match (&row.base_url, &row.key_hint) {
            (Some(url), Some(hint)) => format!("API key {hint} · {url}"),
            (None, Some(hint)) => format!("API key {hint}"),
            (Some(url), None) => format!("API key · {url}"),
            (None, None) => "API key".to_string(),
        }),
        AccountKind::Login => label,
    };
    Some(AgentAccount {
        id: row.id,
        agent_id: row.agent_id,
        name: row.name,
        dir: row.dir,
        env_var: spec.env_var.to_string(),
        login_command: spec.login_command.to_string(),
        logged_in,
        label,
        created_at: row.created_at,
        kind: row.kind,
        base_url: row.base_url,
        key_hint: row.key_hint,
    })
}

/// Las variables con las que una cuenta `api_key` de Claude Code se autentica. Sin gateway,
/// `ANTHROPIC_API_KEY` (cabecera `x-api-key`); con gateway, `ANTHROPIC_AUTH_TOKEN` (Bearer,
/// que es lo que piden OpenRouter y los proxies compatibles) más `ANTHROPIC_BASE_URL`.
pub(super) fn claude_key_env(key: &str, base_url: Option<&str>) -> HashMap<String, String> {
    match base_url {
        None => HashMap::from([("ANTHROPIC_API_KEY".to_string(), key.to_string())]),
        Some(url) => HashMap::from([
            ("ANTHROPIC_AUTH_TOKEN".to_string(), key.to_string()),
            ("ANTHROPIC_BASE_URL".to_string(), url.to_string()),
        ]),
    }
}

/// Variables de entorno con las que hay que lanzar un proceso para que use esta cuenta.
///
/// Es lo único que necesita saber quien abre una tab (o la terminal de login): un mapa que
/// se pasa tal cual a `pty_create`.
pub fn env_for_account(db: &DbConnection, account_id: &str) -> Option<HashMap<String, String>> {
    let (agent_id, dir, kind, base_url): (String, String, String, Option<String>) = {
        let conn = db.lock().ok()?;
        conn.query_row(
            "SELECT agent_id, dir, kind, base_url FROM agent_accounts WHERE id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()?
    };
    // La variable sale del provider. Sin perfil (Gemini, Kimi, una TUI desconocida) no hay
    // mapa: no se hereda el de otra.
    let mut env = crate::agents::adapter_for(&agent_id)?.account_env(&dir)?;
    // El llavero se lee FUERA del lock de la base: puede tardar (D-Bus, Keychain).
    if AccountKind::parse(&kind) == AccountKind::ApiKey && agent_id == "claude-code" {
        // Sin la key (borrada del llavero por fuera) la cuenta no se lanza: arrancaría con
        // el perfil vacío y pediría login, que no es lo que el usuario eligió.
        let key = super::secrets::load(account_id)?;
        env.extend(claude_key_env(&key, base_url.as_deref()));
    }
    Some(env)
}

/// Directorio de perfil de una cuenta. Es la raíz donde la TUI guarda TODO lo suyo —
/// incluidas las sesiones — así que es lo que necesita `session::title` para no buscar los
/// transcripts de una tab con cuenta alternativa en la carpeta del sistema.
pub fn dir_for(db: &DbConnection, account_id: &str) -> Option<String> {
    let conn = db.lock().ok()?;
    dir_for_conn(&conn, account_id)
}

/// Igual que `dir_for`, sobre una conexión ya tomada — para quien está adentro del lock y
/// volver a pedirlo sería un deadlock.
pub fn dir_for_conn(conn: &rusqlite::Connection, account_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT dir FROM agent_accounts WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )
    .ok()
}
