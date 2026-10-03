//! La API key de una cuenta de Claude Code, en el llavero del sistema.
//!
//! Claude Code no tiene un "login con API key" que la guarde en su perfil: la lee de
//! `ANTHROPIC_API_KEY` (o `ANTHROPIC_AUTH_TOKEN` con un gateway). Así que la app la guarda
//! y la pone en el entorno del proceso al lanzarlo, como ya hace con la variable del perfil.
//!
//! Va al llavero (Administrador de credenciales en Windows, Llavero en macOS, Secret Service
//! en Linux) y a ningún otro lado: ni a SQLite, ni a un archivo. Si no hay llavero, la cuenta
//! no se crea — a diferencia de los tokens de git (ver `forge::secret`), una API key cobra por
//! uso y un archivo en claro no es un lugar aceptable para ella.
//!
//! Codex no pasa por acá: `codex login --with-api-key` la guarda en su propio perfil.
//!
//! Todo esto bloquea (D-Bus, Keychain): solo desde hilos de bloqueo o comandos síncronos.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "controlcode.agent-accounts"; // el nombre del llavero NO cambia: renombrarlo dejaría huérfanas las keys guardadas

lazy_static::lazy_static! {
    /// Una vez leída, queda en memoria: se lee en cada lanzamiento de una tab o tarea.
    static ref CACHE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

fn entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account_id).map_err(|e| format!("llavero no disponible: {e}"))
}

pub fn save(account_id: &str, key: &str) -> Result<(), String> {
    entry(account_id)?
        .set_password(key)
        .map_err(|e| format!("No se pudo guardar la API key en el llavero del sistema: {e}"))?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(account_id.to_string(), key.to_string());
    Ok(())
}

pub fn load(account_id: &str) -> Option<String> {
    if let Some(key) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(account_id) {
        return Some(key.clone());
    }
    let key = entry(account_id).ok()?.get_password().ok()?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(account_id.to_string(), key.clone());
    Some(key)
}

pub fn delete(account_id: &str) {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).remove(account_id);
    if let Ok(e) = entry(account_id) {
        let _ = e.delete_credential();
    }
}

/// Lo que se muestra de una key para reconocerla: sus últimos 4 caracteres.
pub fn hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

/// Una key que se puede guardar y pasar por el entorno: sin espacios ni saltos de línea (un
/// salto de línea pegado de más es el error más común, y en una variable de entorno rompe
/// el header que arma la CLI) y de un largo razonable.
pub fn validate_key(key: &str) -> Result<(), String> {
    if key.len() < 8 {
        return Err("La API key es demasiado corta".into());
    }
    if key.len() > 512 {
        return Err("La API key es demasiado larga".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("La API key no puede tener espacios ni saltos de línea".into());
    }
    Ok(())
}

/// Un endpoint compatible: HTTPS, o HTTP solo hacia esta máquina (un proxy local). Por un
/// endpoint cualquiera en HTTP la key viajaría en claro.
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| format!("'{raw}' no es una URL válida"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("El endpoint tiene que ser HTTPS (o HTTP hacia localhost)".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("La URL no puede llevar usuario ni contraseña: la key va aparte".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
