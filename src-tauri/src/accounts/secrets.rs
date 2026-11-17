//! Credenciais de API key de Claude Code e Codex no keyring do sistema.
//!
//! O helper instalado no perfil de cada conta pede a chave ao broker do processo ADE; ela
//! não entra no ambiente, no SQLite, em `auth.json` nem em argumentos de processo. Sem
//! keyring, a conta não é criada. O `auth.json` legado do Codex é migrado antes do lançamento.
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
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(account_id.to_string(), key.to_string());
    Ok(())
}

pub fn load(account_id: &str) -> Option<String> {
    if let Some(key) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(account_id)
    {
        return Some(key.clone());
    }
    let key = entry(account_id).ok()?.get_password().ok()?;
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(account_id.to_string(), key.clone());
    Some(key)
}

pub fn delete(account_id: &str) {
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(account_id);
    if let Ok(e) = entry(account_id) {
        let _ = e.delete_credential();
    }
}

/// Migra a chave criada por versões antigas do `codex login --with-api-key` do
/// `auth.json` para o keyring. Regrava o JSON sem o campo secreto; em caso de falha,
/// mantém o arquivo original e impede que o lançamento prossiga silenciosamente.
pub(super) fn migrate_legacy_codex_api_key(
    account_id: &str,
    codex_home: &std::path::Path,
) -> Result<(), String> {
    let path = codex_home.join("auth.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(
                "Não foi possível verificar o arquivo de credenciais antigo do Codex.".into(),
            );
        }
    };
    if metadata.file_type().is_symlink() {
        return Err("O auth.json do Codex é um link simbólico; a migração foi recusada.".into());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "Não foi possível ler o auth.json antigo do Codex.".to_string())?;
    let mut raw = WipeString(raw);
    let mut auth: serde_json::Value = serde_json::from_str(&raw.0)
        .map_err(|_| "O auth.json antigo do Codex está inválido e foi preservado.".to_string())?;
    if auth.get("auth_mode").and_then(serde_json::Value::as_str) != Some("apikey") {
        return Ok(());
    }
    let Some(secret) = auth
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let mut secret = WipeString(secret.to_string());
    if secret.0.is_empty() {
        return Ok(());
    }

    // Sempre prefere a cópia mais recente do auth.json legado ao cache/keyring antigo.
    save(account_id, &secret.0)?;
    if let Some(serde_json::Value::String(value)) = auth.get_mut("OPENAI_API_KEY") {
        crate::accounts::broker::wipe_secret(value);
    }
    if let Some(object) = auth.as_object_mut() {
        object.remove("OPENAI_API_KEY");
    }
    let body = serde_json::to_vec_pretty(&auth)
        .map_err(|_| "Não foi possível preparar a remoção da chave antiga do Codex.".to_string())?;
    write_private_atomic(&path, &body)?;
    raw.wipe();
    secret.wipe();
    Ok(())
}

struct WipeString(String);

impl WipeString {
    fn wipe(&mut self) {
        crate::accounts::broker::wipe_secret(&mut self.0);
    }
}

impl Drop for WipeString {
    fn drop(&mut self) {
        self.wipe();
    }
}

fn write_private_atomic(path: &std::path::Path, body: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Não foi possível criar o auth.json privado do Codex.".to_string())?;
        file.write_all(body)
            .map_err(|_| "Não foi possível gravar o auth.json do Codex sem a chave.".to_string())?;
        file.sync_all()
            .map_err(|_| "Não foi possível concluir a migração do Codex.".to_string())?;
        std::fs::rename(&temporary, path).map_err(|_| {
            "Não foi possível remover a chave antiga do auth.json do Codex.".to_string()
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// Lo que se muestra de una key para reconocerla: sus últimos 4 caracteres.
pub fn hint(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

/// Una key que se puede guardar y pasar por el entorno: sin espacios ni saltos de línea (un
/// salto de línea pegado de más es el error más común, y en una variable de entorno rompe
/// el header que arma la CLI) y de un largo razonable.
pub fn validate_key(key: &str) -> Result<(), String> {
    if key.len() < 8 {
        return Err("A chave da API é curta demais".into());
    }
    if key.len() > 512 {
        return Err("A chave da API é longa demais".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("A chave da API não pode ter espaços nem quebras de linha".into());
    }
    Ok(())
}

/// Un endpoint compatible: HTTPS, o HTTP solo hacia esta máquina (un proxy local). Por un
/// endpoint cualquiera en HTTP la key viajaría en claro.
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| format!("'{raw}' não é uma URL válida"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("O endpoint precisa ser HTTPS (ou HTTP para localhost)".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A URL não pode ter usuário nem senha: a chave vai à parte".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
