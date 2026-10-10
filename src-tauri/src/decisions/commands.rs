//! Comandos da seção Decisões e do relatório de sombra.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database::DbConnection;

use super::config::{self, ProviderKind, Settings};
use super::http;
use super::log;
use super::protocol::{DecisionError, ping_request};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSettingsDto {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
    pub memory_approval: bool,
    pub dream_triage: bool,
    pub fleet_gate: bool,
    pub mission_gate: bool,
    pub key_saved: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSettingsInput {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
    pub memory_approval: bool,
    pub dream_triage: bool,
    pub fleet_gate: bool,
    pub mission_gate: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

fn dto(settings: &Settings) -> DecisionSettingsDto {
    DecisionSettingsDto {
        enabled: settings.enabled,
        provider: settings.provider.as_str().into(),
        base_url: settings.base_url.clone(),
        model: settings.model.clone(),
        timeout_ms: settings.timeout_ms,
        memory_approval: settings.memory_approval,
        dream_triage: settings.dream_triage,
        fleet_gate: settings.fleet_gate,
        mission_gate: settings.mission_gate,
        key_saved: config::key_saved(),
    }
}

fn from_input(input: DecisionSettingsInput) -> Settings {
    Settings {
        enabled: input.enabled,
        provider: ProviderKind::parse(&input.provider),
        base_url: input.base_url,
        model: input.model,
        timeout_ms: input.timeout_ms,
        memory_approval: input.memory_approval,
        dream_triage: input.dream_triage,
        fleet_gate: input.fleet_gate,
        mission_gate: input.mission_gate,
    }
}

#[tauri::command]
pub fn decision_settings_get(db: State<DbConnection>) -> Result<DecisionSettingsDto, String> {
    let settings = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        config::load(&conn)?
    };
    Ok(dto(&settings))
}

#[tauri::command]
pub fn decision_settings_set(
    input: DecisionSettingsInput,
    db: State<DbConnection>,
) -> Result<DecisionSettingsDto, String> {
    let settings = from_input(input);
    {
        let conn = db.lock().map_err(|error| error.to_string())?;
        config::persist(&conn, &settings)?;
    }
    let stored = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        config::load(&conn)?
    };
    Ok(dto(&stored))
}

#[tauri::command]
pub fn decision_key_set(key: String) -> Result<(), String> {
    config::save_key(&key)
}

#[tauri::command]
pub fn decision_key_clear() -> Result<(), String> {
    config::clear_key()
}

#[tauri::command]
pub fn decision_test_connection(db: State<DbConnection>) -> Result<ConnectionTest, String> {
    let settings = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        config::load(&conn)?
    };
    if matches!(settings.provider, ProviderKind::None) {
        return Ok(ConnectionTest {
            ok: false,
            latency_ms: 0,
            error: Some("Escolha um provedor antes de testar.".into()),
        });
    }
    if matches!(settings.provider, ProviderKind::Clef) {
        return Ok(ConnectionTest {
            ok: false,
            latency_ms: 0,
            error: Some("Cloudflare Clef ainda não tem cliente.".into()),
        });
    }
    let key = config::load_key();
    let request = ping_request(&settings.model);
    let started = std::time::Instant::now();
    let result = http::execute(&settings, key.as_deref(), &request);
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(_) => Ok(ConnectionTest {
            ok: true,
            latency_ms,
            error: None,
        }),
        Err(error) => Ok(ConnectionTest {
            ok: false,
            latency_ms,
            error: Some(public_error(&error, key.as_deref())),
        }),
    }
}

#[tauri::command]
pub fn decision_shadow_report(db: State<DbConnection>) -> Result<log::ShadowReport, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    log::report(&conn)
}

#[tauri::command]
pub fn decision_shadow_export_csv(db: State<DbConnection>) -> Result<String, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    log::export_csv(&conn)
}

fn public_error(error: &DecisionError, secret: Option<&str>) -> String {
    super::shadow::redact(&error.code(), secret)
}
