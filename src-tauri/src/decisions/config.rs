//! Ajustes da seção experimental. A chave fica só no cofre do sistema.

use rusqlite::{Connection, OptionalExtension};

pub const KEY_ENABLED: &str = "decisions.enabled";
pub const KEY_PROVIDER: &str = "decisions.provider";
pub const KEY_BASE_URL: &str = "decisions.base_url";
pub const KEY_MODEL: &str = "decisions.model";
pub const KEY_TIMEOUT: &str = "decisions.timeout_ms";
pub const KEY_MEMORY: &str = "decisions.point.memory_approval";
pub const KEY_DREAM: &str = "decisions.point.dream_triage";
pub const KEY_FLEET: &str = "decisions.point.fleet_gate";
pub const KEY_MISSION: &str = "decisions.point.mission_gate";

const SERVICE: &str = "ade-ags.decisions";
const ACCOUNT: &str = "api-key";

pub const DEFAULT_TIMEOUT_MS: u64 = 800;
pub const DEFAULT_MODEL: &str = "multilingual";
pub const DEFAULT_BASE_URL: &str = "http://localhost:8000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    None,
    LayaLocal,
    LayaStudio,
    Jev,
    /// Reservado. Não há cliente: o stub existe para o seletor futuro.
    Clef,
}

impl ProviderKind {
    pub fn parse(value: &str) -> Self {
        match value {
            "laya_local" => Self::LayaLocal,
            "laya_studio" => Self::LayaStudio,
            "jev" => Self::Jev,
            "clef" => Self::Clef,
            _ => Self::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::LayaLocal => "laya_local",
            Self::LayaStudio => "laya_studio",
            Self::Jev => "jev",
            Self::Clef => "clef",
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::LayaStudio => "https://api.laya.studio",
            Self::Jev => "https://api.typesafe.ai",
            Self::None | Self::LayaLocal | Self::Clef => DEFAULT_BASE_URL,
        }
    }

    /// Nomes aceitos no campo `model`. A Laya local e a Studio usam os checkpoints
    /// (`multilingual`, `english`, `typed-decisions`); a Studio até aceita `jev-latest`
    /// e ignora, mas o seletor oferece os checkpoints. O Jev exige um nome dele.
    pub fn models(self) -> &'static [&'static str] {
        match self {
            Self::Jev => &["jev-latest", "jev-preview", "jev-1.13.0"],
            Self::None | Self::LayaLocal | Self::LayaStudio | Self::Clef => {
                &["multilingual", "english", "typed-decisions"]
            }
        }
    }

    /// `jev-latest` no Jev (hoje aponta para `jev-1.13.0`); `multilingual` nos outros.
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Jev => "jev-latest",
            Self::None | Self::LayaLocal | Self::LayaStudio | Self::Clef => DEFAULT_MODEL,
        }
    }

    /// Um nome que este provedor não aceita vira o padrão dele.
    pub fn coerce_model(self, model: &str) -> String {
        let model = model.trim();
        if self.models().contains(&model) {
            model.to_string()
        } else {
            self.default_model().to_string()
        }
    }

    /// Caracteres de `state` que o envio pode levar. O corte de ~1.024 tokens é só da
    /// Laya multilingual; o Jev aceita cerca de 32k e aqui fica num teto conservador.
    pub fn state_char_budget(self) -> usize {
        match self {
            Self::Jev => super::protocol::JEV_STATE_CHAR_BUDGET,
            Self::None | Self::LayaLocal | Self::LayaStudio | Self::Clef => {
                super::protocol::STATE_CHAR_BUDGET
            }
        }
    }

    pub fn is_configured(self) -> bool {
        !matches!(self, Self::None)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub provider: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
    pub memory_approval: bool,
    pub dream_triage: bool,
    pub fleet_gate: bool,
    pub mission_gate: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: ProviderKind::None,
            base_url: DEFAULT_BASE_URL.into(),
            model: DEFAULT_MODEL.into(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            memory_approval: false,
            dream_triage: false,
            fleet_gate: false,
            mission_gate: false,
        }
    }
}

impl Settings {
    pub fn active(&self) -> bool {
        self.enabled && self.provider.is_configured()
    }

    /// O texto da proposta sai desta máquina? Vale pelo endereço e não pelo nome do provedor:
    /// uma "Laya local" apontada para um servidor da rede também leva o texto para fora.
    pub fn sends_off_machine(&self) -> bool {
        !is_local_url(&self.base_url)
    }

    pub fn allows(&self, point: &str) -> bool {
        match point {
            super::points::POINT_MEMORY => self.memory_approval,
            super::points::POINT_DREAM => self.dream_triage,
            super::points::POINT_FLEET => self.fleet_gate,
            super::points::POINT_MISSION => self.mission_gate,
            _ => false,
        }
    }
}

/// Leitura barata para o caminho quente (o agendador passa por aqui a cada tick): só as três
/// chaves que dizem se o ponto está ligado. Desligado, que é o padrão, custa uma consulta.
pub fn point_active(conn: &Connection, point: &str) -> bool {
    let key = match point {
        super::points::POINT_MEMORY => KEY_MEMORY,
        super::points::POINT_DREAM => KEY_DREAM,
        super::points::POINT_FLEET => KEY_FLEET,
        super::points::POINT_MISSION => KEY_MISSION,
        _ => return false,
    };
    flag(conn, KEY_ENABLED)
        && ProviderKind::parse(&text(conn, KEY_PROVIDER).unwrap_or_default()).is_configured()
        && flag(conn, key)
}

pub fn load(conn: &Connection) -> Result<Settings, String> {
    let mut settings = Settings::default();
    settings.enabled = flag(conn, KEY_ENABLED);
    settings.provider = ProviderKind::parse(&text(conn, KEY_PROVIDER).unwrap_or_default());
    settings.base_url = text(conn, KEY_BASE_URL)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| settings.provider.default_base_url().to_string());
    let stored_model = text(conn, KEY_MODEL).filter(|value| !value.is_empty());
    let model = settings.provider.coerce_model(
        stored_model
            .as_deref()
            .unwrap_or(settings.provider.default_model()),
    );
    // Config já gravada com um nome do outro provedor (Jev + `multilingual`) é corrigida
    // aqui, não só na próxima vez que alguém salvar.
    if stored_model
        .as_deref()
        .is_some_and(|stored| stored != model)
    {
        let _ = put(conn, KEY_MODEL, &model);
    }
    settings.model = model;
    settings.timeout_ms = text(conn, KEY_TIMEOUT)
        .and_then(|value| value.parse().ok())
        .map(clamp_timeout)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    settings.memory_approval = flag(conn, KEY_MEMORY);
    settings.dream_triage = flag(conn, KEY_DREAM);
    settings.fleet_gate = flag(conn, KEY_FLEET);
    settings.mission_gate = flag(conn, KEY_MISSION);
    Ok(settings)
}

pub fn persist(conn: &Connection, settings: &Settings) -> Result<(), String> {
    let base_url = normalize_base_url(&settings.base_url)?;
    let model = settings
        .provider
        .coerce_model(&normalize_model(&settings.model)?);
    let rows = [
        (KEY_ENABLED, bool_text(settings.enabled)),
        (KEY_PROVIDER, settings.provider.as_str().to_string()),
        (KEY_BASE_URL, base_url),
        (KEY_MODEL, model),
        (KEY_TIMEOUT, clamp_timeout(settings.timeout_ms).to_string()),
        (KEY_MEMORY, bool_text(settings.memory_approval)),
        (KEY_DREAM, bool_text(settings.dream_triage)),
        (KEY_FLEET, bool_text(settings.fleet_gate)),
        (KEY_MISSION, bool_text(settings.mission_gate)),
    ];
    for (key, value) in rows {
        put(conn, key, &value)?;
    }
    Ok(())
}

fn put(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let invalid = "A URL base tem de ser HTTPS, ou HTTP só para localhost, sem usuário nem senha.";
    let url = url::Url::parse(raw.trim()).map_err(|_| invalid.to_string())?;
    let local = is_local_host(url.host_str());
    let scheme_ok = matches!((url.scheme(), local), ("https", _) | ("http", true));
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid.into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn is_local_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Uma URL que não dá para ler conta como remota: na dúvida, o texto não sai.
pub fn is_local_url(raw: &str) -> bool {
    url::Url::parse(raw.trim()).is_ok_and(|url| is_local_host(url.host_str()))
}

pub fn normalize_model(raw: &str) -> Result<String, String> {
    let model = raw.trim();
    if model.is_empty()
        || model.chars().count() > 64
        || model
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("O modelo precisa ser um identificador curto, sem espaços.".into());
    }
    Ok(model.to_string())
}

pub fn clamp_timeout(value: u64) -> u64 {
    value.clamp(50, 30_000)
}

pub fn validate_api_key(key: &str) -> Result<(), String> {
    if key.chars().count() < 8 {
        return Err("A chave é curta demais.".into());
    }
    if key.chars().count() > 512 {
        return Err("A chave é longa demais.".into());
    }
    if key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err("A chave não pode ter espaços nem quebras de linha.".into());
    }
    Ok(())
}

pub fn save_key(key: &str) -> Result<(), String> {
    validate_api_key(key)?;
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| scrub_keyring(error.to_string(), key))?;
    entry
        .set_password(key)
        .map_err(|error| scrub_keyring(error.to_string(), key))
}

pub fn clear_key() -> Result<(), String> {
    let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) else {
        return Ok(());
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Não foi possível apagar a chave do cofre: {error}")),
    }
}

pub fn load_key() -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

pub fn key_saved() -> bool {
    load_key().is_some()
}

fn scrub_keyring(message: String, key: &str) -> String {
    let message = super::shadow::redact(&message, Some(key));
    if message.contains(key) {
        "O cofre do sistema está indisponível.".into()
    } else {
        format!("O cofre do sistema está indisponível: {message}")
    }
}

fn flag(conn: &Connection, key: &str) -> bool {
    matches!(text(conn, key).as_deref(), Some("true") | Some("1"))
}

fn text(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

fn bool_text(value: bool) -> String {
    if value { "true" } else { "false" }.into()
}
