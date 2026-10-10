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
    pub secondary_provider: String,
    pub secondary_base_url: String,
    pub secondary_model: String,
    pub secondary_key_saved: bool,
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
    #[serde(default)]
    pub secondary_provider: String,
    #[serde(default)]
    pub secondary_base_url: String,
    #[serde(default)]
    pub secondary_model: String,
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
        key_saved: config::key_saved_in(config::KeySlot::Primary),
        secondary_provider: settings
            .secondary
            .as_ref()
            .map_or("none", |second| second.provider.as_str())
            .into(),
        secondary_base_url: settings.secondary.as_ref().map_or_else(String::new, |second| second.base_url.clone()),
        secondary_model: settings.secondary.as_ref().map_or_else(String::new, |second| second.model.clone()),
        secondary_key_saved: config::key_saved_in(config::KeySlot::Secondary),
    }
}

fn from_input(input: DecisionSettingsInput) -> Settings {
    let second_provider = ProviderKind::parse(&input.secondary_provider);
    let secondary = second_provider.is_configured().then(|| config::Endpoint {
        provider: second_provider,
        base_url: if input.secondary_base_url.trim().is_empty() {
            second_provider.default_base_url().to_string()
        } else {
            input.secondary_base_url.clone()
        },
        model: if input.secondary_model.trim().is_empty() {
            second_provider.default_model().to_string()
        } else {
            input.secondary_model.clone()
        },
    });
    Settings {
        secondary,
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
pub fn decision_key_set(key: String, slot: Option<String>) -> Result<(), String> {
    config::save_key_in(config::KeySlot::parse(slot.as_deref()), &key)
}

#[tauri::command]
pub fn decision_key_clear(slot: Option<String>) -> Result<(), String> {
    config::clear_key_in(config::KeySlot::parse(slot.as_deref()))
}

/// Comando síncrono roda na thread principal do Tauri: a chamada de rede (até o timeout, que
/// pode chegar a 30 s) congelaria a janela. Aqui só se lê o ajuste; o resto vai para fora.
#[tauri::command]
pub async fn decision_test_connection(
    db: State<'_, DbConnection>,
    slot: Option<String>,
) -> Result<ConnectionTest, String> {
    let settings = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        config::load(&conn)?
    };
    let slot = config::KeySlot::parse(slot.as_deref());
    let target = match (slot, &settings.secondary) {
        (config::KeySlot::Secondary, Some(second)) => settings.with_endpoint(second),
        (config::KeySlot::Secondary, None) => {
            return Ok(ConnectionTest {
                ok: false,
                latency_ms: 0,
                error: Some("Escolha o segundo provedor antes de testar.".into()),
            });
        }
        (config::KeySlot::Primary, _) => settings,
    };
    tauri::async_runtime::spawn_blocking(move || ping(&target, config::load_key_in(slot)))
        .await
        .map_err(|error| error.to_string())
}

pub(crate) fn ping(settings: &Settings, key: Option<String>) -> ConnectionTest {
    if matches!(settings.provider, ProviderKind::None) {
        return ConnectionTest {
            ok: false,
            latency_ms: 0,
            error: Some("Escolha um provedor antes de testar.".into()),
        };
    }
    if matches!(settings.provider, ProviderKind::Clef) {
        return ConnectionTest {
            ok: false,
            latency_ms: 0,
            error: Some("Cloudflare Clef ainda não tem cliente.".into()),
        };
    }
    let request = ping_request(&settings.model);
    let started = std::time::Instant::now();
    let result = http::execute(settings, key.as_deref(), &request);
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(_) => ConnectionTest {
            ok: true,
            latency_ms,
            error: None,
        },
        Err(error) => ConnectionTest {
            ok: false,
            latency_ms,
            error: Some(public_error(&error, key.as_deref())),
        },
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
