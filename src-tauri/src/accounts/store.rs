//! El almacén de cuentas: dónde vive cada perfil, cómo se valida su nombre y cómo se
//! traduce una fila de la base al tipo que ve el frontend.

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

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
        return Err("O nome não pode estar vazio".into());
    }
    if name.len() > 40 {
        return Err("O nome não pode ter mais de 40 caracteres".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Solo se permiten letras, números, '-', '_' y '.'".into());
    }
    if name.starts_with('.') || name.chars().all(|c| c == '.') {
        return Err("O nome não pode começar com '.'".into());
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
    let base = crate::util::datadir::app_data_dir(app)
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
    /// Nome que a pessoa vê (o `name` é o da pasta). `None` = usa o padrão.
    pub display_name: Option<String>,
    /// Nome de um token da paleta do tema (`green`…), nunca um hex. `None` = sem cor própria.
    pub accent_color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Login,
    ApiKey,
}

impl AccountKind {
    pub fn parse(raw: &str) -> Self {
        if raw == "api_key" {
            AccountKind::ApiKey
        } else {
            AccountKind::Login
        }
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
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
}

/// Las columnas que espera [`AccountRow::from_row`], en ese orden.
pub(super) const ACCOUNT_COLUMNS: &str =
    "id, agent_id, name, dir, created_at, kind, base_url, key_hint, display_name, accent_color";

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
            display_name: row.get(8)?,
            accent_color: row.get(9)?,
        })
    }
}

pub(super) fn row_to_account(row: AccountRow) -> Option<AgentAccount> {
    let spec = spec_for(&row.agent_id)?;
    let path = PathBuf::from(&row.dir);
    let (marker_logged_in, label) = read_identity(&path, spec);
    // Claude por API key depende de la chave no keyring. Codex também usa o keyring;
    // um auth.json legado é aceito como marcador até ser migrado no próximo lançamento.
    let logged_in = match (row.kind, row.agent_id.as_str()) {
        (AccountKind::ApiKey, "claude-code") => {
            let Some(mut key) = super::secrets::load(&row.id) else {
                return None;
            };
            super::broker::wipe_secret(&mut key);
            true
        }
        // Perfis antigos do Codex ainda podem ter a chave no auth.json. O lançamento
        // migra esse arquivo para o keyring, fora do lock do banco.
        (AccountKind::ApiKey, "codex") => match super::secrets::load(&row.id) {
            Some(mut key) => {
                super::broker::wipe_secret(&mut key);
                true
            }
            None => marker_logged_in,
        },
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
        display_name: row.display_name,
        accent_color: row.accent_color,
    })
}

/// Só a configuração não secreta do endpoint chega ao processo. A chave sai pelo
/// `apiKeyHelper` do broker quando Claude Code pede autenticação.
pub(super) fn claude_api_env(base_url: Option<&str>) -> HashMap<String, String> {
    base_url
        .map(|url| HashMap::from([("ANTHROPIC_BASE_URL".to_string(), url.to_string())]))
        .unwrap_or_default()
}

/// Variables que el backend inyecta al lanzar un proceso con esta cuenta.
///
/// El mapa nunca se devuelve al WebView: allí viaja solo `account_id` por `pty_create`.
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
    account_env_from_row(account_id, &agent_id, &dir, &kind, base_url.as_deref())
        .ok()
        .flatten()
}

pub(super) fn account_env_from_row(
    account_id: &str,
    agent_id: &str,
    dir: &str,
    kind: &str,
    base_url: Option<&str>,
) -> Result<Option<HashMap<String, String>>, String> {
    account_env_from_row_with_home(
        account_id,
        agent_id,
        dir,
        kind,
        base_url,
        dirs::home_dir().as_deref(),
    )
}

fn account_env_from_row_with_home(
    account_id: &str,
    agent_id: &str,
    dir: &str,
    kind: &str,
    base_url: Option<&str>,
    real_home: Option<&std::path::Path>,
) -> Result<Option<HashMap<String, String>>, String> {
    // La variable sale del provider. Sin perfil (Gemini, Kimi, una TUI desconocida) no hay
    // mapa: no se hereda el de otra.
    let Some(adapter) = crate::agents::adapter_for(agent_id) else {
        return Ok(None);
    };
    let Some(mut env) = adapter.account_env(dir) else {
        return Ok(None);
    };
    // Antigravity: a conta é um HOME inteiro; é montado aqui, uma vez por lançamento, e nunca
    // apaga nada (ver `antigravity_home`). Sem isso o PTY abriria num HOME sem git nem ssh.
    if agent_id == "antigravity" {
        if let Some(home) = real_home {
            super::antigravity_home::prepare(home, std::path::Path::new(dir)).map_err(|error| {
                format!(
                    "Não foi possível preparar o HOME isolado da conta Antigravity: {error}"
                )
            })?;
        }
    }
    // El llavero se lee FUERA del lock de la base: puede tardar (D-Bus, Keychain).
    if AccountKind::parse(kind) == AccountKind::ApiKey
        && matches!(agent_id, "claude-code" | "codex")
    {
        if agent_id == "codex" {
            super::secrets::migrate_legacy_codex_api_key(account_id, std::path::Path::new(dir))?;
        }
        let Some(mut key) = super::secrets::load(account_id) else {
            return Ok(None);
        };
        super::broker::wipe_secret(&mut key);
        if agent_id == "claude-code" {
            env.extend(claude_api_env(base_url));
        }
    }
    Ok(Some(env))
}

/// Resolve o ambiente de uma conta para o provedor declarado no lançamento do PTY.
/// A leitura do keyring ocorre depois de liberar o lock do banco. Erros não incluem valores
/// do ambiente, para que a resposta do IPC possa ser mostrada com segurança no terminal.
pub fn env_for_account_for_agent(
    db: &DbConnection,
    account_id: &str,
    expected_agent_id: &str,
) -> Result<HashMap<String, String>, String> {
    env_for_account_for_agent_inner(
        db,
        account_id,
        expected_agent_id,
        dirs::home_dir().as_deref(),
    )
}

#[cfg(test)]
pub(crate) fn env_for_account_for_agent_with_home(
    db: &DbConnection,
    account_id: &str,
    expected_agent_id: &str,
    real_home: &std::path::Path,
) -> Result<HashMap<String, String>, String> {
    env_for_account_for_agent_inner(db, account_id, expected_agent_id, Some(real_home))
}

fn env_for_account_for_agent_inner(
    db: &DbConnection,
    account_id: &str,
    expected_agent_id: &str,
    real_home: Option<&std::path::Path>,
) -> Result<HashMap<String, String>, String> {
    let (agent_id, dir, kind, base_url): (String, String, String, Option<String>) = {
        let conn = db
            .lock()
            .map_err(|_| "Não foi possível acessar as contas locais.".to_string())?;
        conn.query_row(
            "SELECT agent_id, dir, kind, base_url FROM agent_accounts WHERE id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "A conta selecionada não existe mais.".to_string())?
    };
    if agent_id != expected_agent_id {
        return Err("A conta selecionada não pertence ao provedor desta aba.".into());
    }
    account_env_from_row_with_home(
        account_id,
        &agent_id,
        &dir,
        &kind,
        base_url.as_deref(),
        real_home,
    )?
    .ok_or_else(|| "O perfil ou a credencial desta conta não está disponível no sistema.".to_string())
}

/// Tipo da conta, validando também o provedor esperado pelo lançamento do PTY.
pub fn kind_for_account_for_agent(
    db: &DbConnection,
    account_id: &str,
    expected_agent_id: &str,
) -> Result<AccountKind, String> {
    let conn = db
        .lock()
        .map_err(|_| "Não foi possível acessar as contas locais.".to_string())?;
    let (agent, kind): (String, String) = conn
        .query_row(
            "SELECT agent_id, kind FROM agent_accounts WHERE id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "A conta selecionada não existe mais.".to_string())?;
    if agent != expected_agent_id {
        return Err("A conta selecionada não pertence ao provedor desta aba.".into());
    }
    Ok(AccountKind::parse(&kind))
}

/// Contas por API key usam o broker de credenciais por PTY (`ags credential`). Fora de PTY
/// (chat estruturado e Frota headless), falha fechado com mensagem clara em vez de subir sem credencial.
pub fn ensure_supported_outside_pty(db: &DbConnection, account_id: &str) -> Result<(), String> {
    let kind: Option<String> = {
        let conn = db
            .lock()
            .map_err(|_| "Não foi possível acessar as contas locais.".to_string())?;
        conn.query_row(
            "SELECT kind FROM agent_accounts WHERE id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .ok()
    };
    if kind.as_deref().map(AccountKind::parse) == Some(AccountKind::ApiKey) {
        return Err(
            "Contas por API key estão disponíveis apenas em abas de terminal (PTY). No chat estruturado e na Frota, escolha uma conta com login."
                .into(),
        );
    }
    Ok(())
}

/// Agente dono da conta, sem carregar as credenciais do chaveiro.
pub fn agent_id_for_account(db: &DbConnection, account_id: &str) -> Option<String> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT agent_id FROM agent_accounts WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )
    .ok()
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
