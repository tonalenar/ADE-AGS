//! Comandos ACP locais configurados pela pessoa. Os comandos e argumentos ficam no chaveiro;
//! o banco guarda apenas o id e o nome visível para montar o seletor sem ler segredos.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::async_runtime;

use crate::database::DbConnection;

const SETTING_KEY: &str = "chat.local-acp.providers.v1";
const SERVICE_PREFIX: &str = "ade-ags.local-acp";
const MAX_PROVIDERS: usize = 64;
const MAX_LABEL: usize = 80;
const MAX_COMMAND: usize = 1024;
const MAX_ARGS: usize = 32;
const MAX_ARG: usize = 2048;
const MAX_CONFIG: usize = 12 * 1024;
static KEYRING_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_keyring() -> Result<MutexGuard<'static, ()>, String> {
    KEYRING_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "O chaveiro foi interrompido".into())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAcpProvider {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAcpConfig {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAcpDraft {
    pub id: Option<String>,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
}

pub fn is_local_acp_id(id: &str) -> bool {
    id.strip_prefix("local-acp-")
        .and_then(|suffix| uuid::Uuid::parse_str(suffix).ok())
        .is_some()
}

fn service() -> Result<String, String> {
    let data_dir = crate::util::datadir::ags_home().ok_or("Não foi possível identificar os dados desta instância")?;
    let digest = Sha256::digest(data_dir.to_string_lossy().as_bytes());
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{SERVICE_PREFIX}.{hash}"))
}

fn read_index(db: &DbConnection) -> Result<Vec<LocalAcpProvider>, String> {
    let Some(raw) = crate::database::get_setting(db, SETTING_KEY)? else { return Ok(Vec::new()) };
    let providers: Vec<LocalAcpProvider> = serde_json::from_str(&raw)
        .map_err(|_| "A lista de agentes ACP locais está inválida".to_string())?;
    if providers.len() > MAX_PROVIDERS {
        return Err("A lista de agentes ACP locais excede o limite".into());
    }
    let mut ids = std::collections::HashSet::new();
    for provider in &providers {
        if !is_local_acp_id(&provider.id)
            || provider.label.trim().is_empty()
            || provider.label.chars().count() > MAX_LABEL
            || provider.label.chars().any(char::is_control)
            || !ids.insert(provider.id.as_str())
        {
            return Err("A lista de agentes ACP locais está inválida".into());
        }
    }
    Ok(providers)
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    if !is_local_acp_id(id) { return Err("O identificador do agente ACP local está inválido".into()); }
    keyring::Entry::new(&service()?, id).map_err(|_| "O chaveiro do sistema não está disponível".into())
}

fn validate(draft: &LocalAcpDraft) -> Result<(), String> {
    let label = draft.label.trim();
    let command = draft.command.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL || label.chars().any(char::is_control) {
        return Err("O nome do agente ACP precisa ter de 1 a 80 caracteres".into());
    }
    if command.is_empty() || command.len() > MAX_COMMAND || command.contains('\0') || command.contains('\n') || command.contains('\r') {
        return Err("Informe um executável válido, sem argumentos".into());
    }
    if draft.args.len() > MAX_ARGS || draft.args.iter().any(|arg| arg.len() > MAX_ARG || arg.contains('\0')) {
        return Err("Use até 32 argumentos literais, com no máximo 2.048 caracteres cada".into());
    }
    let config_bytes = serde_json::to_vec(draft).map_err(|error| error.to_string())?.len();
    if config_bytes > MAX_CONFIG { return Err("A configuração excede o limite de 12 KiB".into()); }
    Ok(())
}

pub fn list(db: &DbConnection) -> Result<Vec<LocalAcpProvider>, String> {
    read_index(db)
}

pub fn contains(db: &DbConnection, id: &str) -> Result<bool, String> {
    Ok(read_index(db)?.iter().any(|provider| provider.id == id))
}

/// Lê o comando apenas quando a pessoa edita o cadastro ou quando a conversa precisa iniciá-lo.
pub async fn get_config(db: &DbConnection, id: &str) -> Result<LocalAcpConfig, String> {
    let db = db.clone();
    let id = id.to_owned();
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let provider = read_index(&db)?.into_iter().find(|provider| provider.id == id)
            .ok_or_else(|| "O agente ACP local não está mais cadastrado".to_string())?;
        let raw = entry(&id)?.get_password().map_err(|_| "Não foi possível ler o comando no chaveiro do sistema".to_string())?;
        let config: LocalAcpConfig = serde_json::from_str(&raw)
            .map_err(|_| "A configuração ACP no chaveiro está inválida".to_string())?;
        if config.id != id || config.label != provider.label {
            return Err("A configuração ACP e a lista de agentes não correspondem".into());
        }
        Ok(config)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn local_acp_list(db: tauri::State<DbConnection>) -> Result<Vec<LocalAcpProvider>, String> {
    list(&db)
}

#[tauri::command]
pub async fn local_acp_get(db: tauri::State<'_, DbConnection>, id: String) -> Result<LocalAcpConfig, String> {
    get_config(&db, &id).await
}

#[tauri::command]
pub async fn local_acp_upsert(db: tauri::State<'_, DbConnection>, draft: LocalAcpDraft) -> Result<LocalAcpProvider, String> {
    validate(&draft)?;
    let db = db.inner().clone();
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let mut providers = read_index(&db)?;
        let id = match draft.id.as_deref() {
            Some(id) if is_local_acp_id(id) && providers.iter().any(|provider| provider.id == id) => id.to_owned(),
            Some(_) => return Err("O agente ACP que você está editando não existe".into()),
            None if providers.len() < MAX_PROVIDERS => format!("local-acp-{}", uuid::Uuid::new_v4()),
            None => return Err(format!("A ADE aceita até {MAX_PROVIDERS} agentes ACP locais")),
        };
        let provider = LocalAcpProvider { id: id.clone(), label: draft.label.trim().to_owned() };
        let config = LocalAcpConfig { id: id.clone(), label: provider.label.clone(), command: draft.command.trim().to_owned(), args: draft.args };
        let raw = serde_json::to_string(&config).map_err(|error| error.to_string())?;
        let credential = entry(&id)?;
        let previous = credential.get_password().ok();
        credential.set_password(&raw).map_err(|_| "Não foi possível guardar o comando no chaveiro do sistema".to_string())?;
        if let Some(existing) = providers.iter_mut().find(|item| item.id == id) {
            *existing = provider.clone();
        } else {
            providers.push(provider.clone());
        }
        providers.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        let saved = serde_json::to_string(&providers).map_err(|error| error.to_string())?;
        if let Err(error) = crate::database::set_setting(&db, SETTING_KEY, &saved) {
            if let Some(previous) = previous { let _ = credential.set_password(&previous); }
            else { let _ = credential.delete_credential(); }
            return Err(error);
        }
        Ok(provider)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_acp_delete(db: tauri::State<'_, DbConnection>, id: String) -> Result<(), String> {
    let db = db.inner().clone();
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let mut providers = read_index(&db)?;
        let Some(index) = providers.iter().position(|provider| provider.id == id) else {
            return Err("O agente ACP local não está mais cadastrado".into());
        };
        let credential = entry(&id)?;
        let previous = credential.get_password().ok();
        providers.remove(index);
        let saved = serde_json::to_string(&providers).map_err(|error| error.to_string())?;
        crate::database::set_setting(&db, SETTING_KEY, &saved)?;
        if credential.delete_credential().is_err() && previous.is_some() {
            return Err("O agente foi removido da ADE, mas não consegui apagar o comando do chaveiro".into());
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}
