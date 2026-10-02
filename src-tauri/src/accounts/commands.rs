//! Los comandos que invoca el frontend para administrar cuentas.

use crate::database::DbConnection;
use std::collections::HashMap;
use tauri::AppHandle;

use super::profiles::{spec_for, PROFILES};
use crate::util::now_ts;

use super::store::{
    accounts_root, env_for_account, row_to_account, validate_name, AccountCapableAgent, AccountKind,
    AccountRow, AgentAccount, ACCOUNT_COLUMNS,
};

/// TUIs que pueden tener varias cuentas, marcando cuáles están instaladas.
///
/// Las instaladas que NO aparecen acá (gemini-cli, kimi-code) es porque no se les conoce
/// una variable que mueva el login. El frontend las muestra como no soportadas en vez de
/// dejar que el usuario cree una cuenta que después se pisaría con la del sistema.
#[tauri::command]
pub async fn account_capable_agents() -> Result<Vec<AccountCapableAgent>, String> {
    tokio::task::spawn_blocking(|| {
        PROFILES
            .iter()
            .map(|spec| AccountCapableAgent {
                agent_id: spec.agent_id.to_string(),
                label: crate::agents::agent_label(spec.agent_id)
                    .unwrap_or(spec.agent_id)
                    .to_string(),
                env_var: spec.env_var.to_string(),
                installed: crate::agents::agent_command(spec.agent_id)
                    .map(crate::agents::command_exists)
                    .unwrap_or(false),
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_accounts(db: tauri::State<DbConnection>) -> Result<Vec<AgentAccount>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    list_accounts(&conn)
}

/// Las cuentas creadas en la app, sobre una conexión ya tomada. Es lo que usa también el
/// roster de la flota, que necesita la lista sin pasar por un comando.
pub fn list_accounts(conn: &rusqlite::Connection) -> Result<Vec<AgentAccount>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {ACCOUNT_COLUMNS} FROM agent_accounts ORDER BY agent_id, name"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], AccountRow::from_row).map_err(|e| e.to_string())?;

    let mut accounts = Vec::new();
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        // Una cuenta de una TUI que ya no está en PROFILES se omite en vez de romper la
        // lista entera: no hay forma de lanzarla, pero su carpeta sigue en el disco.
        if let Some(account) = row_to_account(row) {
            accounts.push(account);
        }
    }
    Ok(accounts)
}

#[tauri::command]
pub fn create_agent_account(
    agent_id: String,
    name: String,
    app: AppHandle,
    db: tauri::State<DbConnection>,
) -> Result<AgentAccount, String> {
    if spec_for(&agent_id).is_none() {
        return Err(format!("'{agent_id}' no soporta varias cuentas"));
    }
    let name = name.trim().to_string();
    validate_name(&name)?;

    let dir = accounts_root(&app)?.join(&agent_id).join(&name);
    // El directorio se crea vacío y la TUI lo inicializa sola en su primer arranque. Si ya
    // existía (cuenta borrada de la base pero no del disco), se reutiliza tal cual: sus
    // credenciales siguen ahí y volver a loguearse sería trabajo de más.
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear la carpeta de la cuenta: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_ts();
    let dir_str = dir.to_string_lossy().to_string();

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, agent_id, name, dir_str, created_at],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("Ya existe una cuenta '{name}' para esta TUI")
            } else {
                e.to_string()
            }
        })?;
    }

    row_to_account(AccountRow {
        id,
        agent_id,
        name,
        dir: dir_str,
        created_at,
        kind: AccountKind::Login,
        base_url: None,
        key_hint: None,
    })
    .ok_or_else(|| "No se pudo leer la cuenta recién creada".to_string())
}

/// Las TUIs que aceptan una cuenta por API key, y cómo la guarda cada una.
fn supports_api_key(agent_id: &str) -> bool {
    matches!(agent_id, "claude-code" | "codex")
}

/// Alta de una cuenta por API key: sin terminal de login.
///
/// - **Claude Code** no tiene un login con key que la guarde en su perfil: la key va al
///   llavero del sistema y se pone en el entorno al lanzar (ver `env_for_account`). Con
///   `base_url`, va como token de un gateway compatible (OpenRouter, un proxy propio).
/// - **Codex** sí: `codex login --with-api-key` la guarda en el perfil de la cuenta, igual
///   que guarda un login de ChatGPT. La app se la pasa por stdin (no por argumentos, que se
///   verían en la lista de procesos) y no se queda con ella.
///
/// La key no se verifica contra el proveedor acá: eso es [`account_health`], que el
/// frontend corre enseguida. Así una key válida con la red caída igual se puede guardar.
#[tauri::command]
pub async fn create_agent_api_key_account(
    agent_id: String,
    name: String,
    api_key: String,
    base_url: Option<String>,
    app: AppHandle,
    db: tauri::State<'_, DbConnection>,
) -> Result<AgentAccount, String> {
    if !supports_api_key(&agent_id) {
        return Err(format!("'{agent_id}' no acepta cuentas por API key: usá el login de la TUI"));
    }
    let name = name.trim().to_string();
    validate_name(&name)?;
    let api_key = api_key.trim().to_string();
    super::secrets::validate_key(&api_key)?;
    let base_url = match base_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(_) if agent_id != "claude-code" => {
            return Err("Un endpoint propio solo se admite en cuentas de Claude Code".into());
        }
        Some(url) => Some(super::secrets::validate_base_url(url)?),
        None => None,
    };

    let dir = accounts_root(&app)?.join(&agent_id).join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de la cuenta: {e}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_ts();
    let dir_str = dir.to_string_lossy().to_string();
    let hint = super::secrets::hint(&api_key);

    // Primero el secreto, después la fila: una fila sin su key sería una cuenta que no
    // arranca. Si la fila falla después, se borra lo guardado.
    let (secret_id, store_key, login_dir, login_key) = (id.clone(), api_key.clone(), dir.clone(), api_key);
    let agent = agent_id.clone();
    tokio::task::spawn_blocking(move || match agent.as_str() {
        "claude-code" => super::secrets::save(&secret_id, &store_key),
        _ => super::health::codex_login_with_api_key(&login_dir, &login_key),
    })
    .await
    .map_err(|e| e.to_string())??;

    let inserted = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at, kind, base_url, key_hint)
             VALUES (?1, ?2, ?3, ?4, ?5, 'api_key', ?6, ?7)",
            rusqlite::params![id, agent_id, name, dir_str, created_at, base_url, hint],
        )
    };
    if let Err(e) = inserted {
        super::secrets::delete(&id);
        return Err(if e.to_string().contains("UNIQUE") {
            format!("Ya existe una cuenta '{name}' para esta TUI")
        } else {
            e.to_string()
        });
    }

    row_to_account(AccountRow {
        id,
        agent_id,
        name,
        dir: dir_str,
        created_at,
        kind: AccountKind::ApiKey,
        base_url,
        key_hint: Some(hint),
    })
    .ok_or_else(|| "No se pudo leer la cuenta recién creada".to_string())
}

/// Borra la cuenta. `delete_files` decide si también se va la carpeta con las credenciales.
///
/// Están separados a propósito: sacarla de la app es reversible (se vuelve a agregar con el
/// mismo nombre y el login sigue ahí), borrar la carpeta no lo es.
#[tauri::command]
pub fn delete_agent_account(
    id: String,
    delete_files: bool,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let dir: Option<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let dir = conn
            .query_row(
                "SELECT dir FROM agent_accounts WHERE id = ?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        conn.execute("DELETE FROM agent_accounts WHERE id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        dir
    };
    // La key de una cuenta de Claude Code vive en el llavero, no en la carpeta: sin la fila
    // no la usa nadie, así que se va siempre (no hay nada que "conservar" para re-agregarla).
    super::secrets::delete(&id);

    if delete_files {
        if let Some(dir) = dir {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("La cuenta se quitó, pero no se pudo borrar {dir}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_account_env(
    account_id: String,
    db: tauri::State<DbConnection>,
) -> Result<HashMap<String, String>, String> {
    env_for_account(&db, &account_id).ok_or_else(|| "Cuenta no encontrada".to_string())
}

/// La cuenta PRINCIPAL de cada TUI instalada: la que usa cuando no se le apunta la variable
/// a ningún perfil.
///
/// Va por separado de `list_agent_accounts` porque no es una fila de la base: no la creó
/// esta app, existía antes. Sin esto, la barra de cuentas mostraba los perfiles alternativos
/// y escondía justo la que el usuario usa siempre.
#[tauri::command]
pub async fn system_accounts() -> Result<Vec<AgentAccount>, String> {
    tokio::task::spawn_blocking(|| {
        PROFILES
            .iter()
            .filter(|spec| {
                crate::agents::agent_command(spec.agent_id)
                    .map(crate::agents::command_exists)
                    .unwrap_or(false)
            })
            .filter_map(|spec| system_account(spec.agent_id))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// La cuenta principal de UNA TUI, esté instalada o no. `None` si no soporta cuentas.
pub fn system_account(agent_id: &str) -> Option<AgentAccount> {
    let spec = spec_for(agent_id)?;
    let dir = super::profiles::default_dir(spec)?;
    let marker_root = super::profiles::system_marker_root(spec, &dirs::home_dir()?, &dir);
    let (logged_in, label) = super::profiles::read_identity(&marker_root, spec);
    Some(AgentAccount {
        // Id sintético y estable: no hay fila, pero el frontend necesita una clave y el
        // backend tiene que poder distinguirla de un perfil real.
        id: format!("system:{}", spec.agent_id),
        agent_id: spec.agent_id.to_string(),
        name: crate::agents::agent_label(spec.agent_id)
            .unwrap_or(spec.agent_id)
            .to_string(),
        dir: dir.to_string_lossy().to_string(),
        env_var: spec.env_var.to_string(),
        login_command: spec.login_command.to_string(),
        logged_in,
        label,
        created_at: 0,
        kind: AccountKind::Login,
        base_url: None,
        key_hint: None,
    })
}
