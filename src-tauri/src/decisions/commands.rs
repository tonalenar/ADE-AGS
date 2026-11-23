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
    pub delivery_gate: bool,
    pub memory_relevance: bool,
    pub turn_routing: bool,
    pub browser_pilot: bool,
    pub browser_vision: bool,
    pub key_saved: bool,
    pub secondary_provider: String,
    pub secondary_base_url: String,
    pub secondary_model: String,
    pub secondary_key_saved: bool,
    pub model_auto_update: bool,
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
    pub delivery_gate: bool,
    #[serde(default)]
    pub memory_relevance: bool,
    #[serde(default)]
    pub turn_routing: bool,
    #[serde(default)]
    pub browser_pilot: bool,
    #[serde(default)]
    pub browser_vision: bool,
    #[serde(default)]
    pub secondary_provider: String,
    #[serde(default)]
    pub secondary_base_url: String,
    #[serde(default)]
    pub secondary_model: String,
    /// Ausente (uma tela antiga) = ligado, o padrão.
    #[serde(default = "default_true")]
    pub model_auto_update: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Estado em edição na tela de Ajustes → Decisões, para testar conexão antes de salvar.
/// A chave em `api_key` fica só em memória durante o teste (nunca vai ao banco nem ao log).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestDraft {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub api_key: Option<String>,
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
        delivery_gate: settings.delivery_gate,
        memory_relevance: settings.memory_relevance,
        turn_routing: settings.turn_routing,
        browser_pilot: settings.browser_pilot,
        browser_vision: settings.browser_vision,
        key_saved: config::key_saved_in(config::KeySlot::Primary),
        secondary_provider: settings
            .secondary
            .as_ref()
            .map_or("none", |second| second.provider.as_str())
            .into(),
        secondary_base_url: settings
            .secondary
            .as_ref()
            .map_or_else(String::new, |second| second.base_url.clone()),
        secondary_model: settings
            .secondary
            .as_ref()
            .map_or_else(String::new, |second| second.model.clone()),
        secondary_key_saved: config::key_saved_in(config::KeySlot::Secondary),
        model_auto_update: settings.model_auto_update,
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
        delivery_gate: input.delivery_gate,
        memory_relevance: input.memory_relevance,
        turn_routing: input.turn_routing,
        browser_pilot: input.browser_pilot,
        browser_vision: input.browser_vision,
        model_auto_update: input.model_auto_update,
    }
}

#[tauri::command]
pub async fn decision_settings_get(
    db: State<'_, DbConnection>,
) -> Result<DecisionSettingsDto, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            config::load(&conn)?
        };
        Ok(dto(&settings))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decision_settings_set(
    input: DecisionSettingsInput,
    db: State<'_, DbConnection>,
) -> Result<DecisionSettingsDto, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = from_input(input);
        {
            let conn = db.lock().map_err(|error| error.to_string())?;
            config::persist(&conn, &settings)?;
        }
        let stored = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            config::load(&conn)?
        };
        http::clear_all_quota_exhausted();
        Ok(dto(&stored))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// O keyring pode abrir um prompt do SO: sai da thread principal.
#[tauri::command]
pub async fn decision_key_set(key: String, slot: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        config::save_key_in(config::KeySlot::parse(slot.as_deref()), &key)?;
        http::clear_all_quota_exhausted();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decision_key_clear(slot: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        config::clear_key_in(config::KeySlot::parse(slot.as_deref()))?;
        http::clear_all_quota_exhausted();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Constrói o alvo de teste a partir do rascunho da tela, validando URL e modelo como no `persist`.
/// Se o usuário digitou uma chave no campo, usa essa chave (em memória); senão, o chamador carrega do cofre.
pub(crate) fn target_from_draft(
    draft: &ConnectionTestDraft,
) -> Result<(Settings, Option<String>), String> {
    let provider = ProviderKind::parse(&draft.provider);
    if matches!(provider, ProviderKind::None | ProviderKind::Clef) {
        return Ok((
            Settings {
                provider,
                ..Settings::default()
            },
            None,
        ));
    }
    let raw_url = if draft.base_url.trim().is_empty() {
        provider.default_base_url().to_string()
    } else {
        draft.base_url.clone()
    };
    let base_url = config::normalize_base_url(&raw_url)?;
    let raw_model = if draft.model.trim().is_empty() {
        provider.default_model().to_string()
    } else {
        draft.model.clone()
    };
    let model = provider.coerce_model(&config::normalize_model(&raw_model)?);
    let typed_key = draft
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    if let Some(key) = typed_key.as_deref() {
        config::validate_api_key(key)?;
    }
    Ok((
        Settings {
            enabled: true,
            provider,
            base_url,
            model,
            timeout_ms: config::clamp_timeout(draft.timeout_ms),
            ..Settings::default()
        },
        typed_key,
    ))
}

/// Comando síncrono roda na thread principal do Tauri: a chamada de rede (até o timeout, que
/// pode chegar a 30 s) congelaria a janela. Quando `draft` vem preenchido, testa o que está na
/// tela antes de salvar; sem `draft`, usa o estado salvo no SQLite.
#[tauri::command]
pub async fn decision_test_connection(
    db: State<'_, DbConnection>,
    slot: Option<String>,
    draft: Option<ConnectionTestDraft>,
) -> Result<ConnectionTest, String> {
    let slot = config::KeySlot::parse(slot.as_deref());
    if let Some(draft) = draft {
        let (target, typed_key) = match target_from_draft(&draft) {
            Ok(pair) => pair,
            Err(error) => {
                return Ok(ConnectionTest {
                    ok: false,
                    latency_ms: 0,
                    error: Some(error),
                });
            }
        };
        if slot == config::KeySlot::Secondary && matches!(target.provider, ProviderKind::None) {
            return Ok(ConnectionTest {
                ok: false,
                latency_ms: 0,
                error: Some("Escolha o segundo provedor antes de testar.".into()),
            });
        }
        return tauri::async_runtime::spawn_blocking(move || {
            let key = typed_key.or_else(|| config::load_key_in(slot));
            ping(&target, key)
        })
        .await
        .map_err(|error| error.to_string());
    }
    let settings = crate::database::blocking_db(&db, |conn| config::load(conn)).await?;
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
pub async fn decision_shadow_report(
    db: State<'_, DbConnection>,
) -> Result<log::ShadowReport, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            log::snapshot(&conn)?
        };
        log::report_from_snapshot(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn decision_shadow_export_csv(db: State<'_, DbConnection>) -> Result<String, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            log::snapshot(&conn)?
        };
        log::export_csv_from_snapshot(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn public_error(error: &DecisionError, secret: Option<&str>) -> String {
    super::shadow::redact(&error.code(), secret)
}
