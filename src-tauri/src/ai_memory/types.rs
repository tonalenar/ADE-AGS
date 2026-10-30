use serde::{Deserialize, Serialize};

/// O conteúdo externo nunca equivale à memória aprovada do ADE.
#[derive(Debug, Serialize)]
pub struct Untrusted<T> {
    pub source: &'static str,
    pub trust: &'static str,
    pub data: T,
}

impl<T> Untrusted<T> {
    pub fn new(data: T) -> Self {
        Self {
            source: "ai-memory",
            trust: "UNTRUSTED",
            data,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Missing,
    Outdated,
    ServerDown,
    Ok,
}

#[derive(Debug, Serialize)]
pub struct Probe {
    pub state: Availability,
    pub version: Option<String>,
    pub installation_instruction: Option<String>,
    pub status: Option<Status>,
    pub sessions_supported: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Status {
    pub version: String,
    pub counts: Counts,
    #[serde(default)]
    pub client: Option<StatusClient>,
    #[serde(default)]
    pub providers: Option<Providers>,
    #[serde(default)]
    pub capture_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Counts {
    pub pages_latest: u64,
    pub pages_all: u64,
    pub sessions: u64,
    pub observations: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatusClient {
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Providers {
    #[serde(default)]
    pub embedding: Option<Provider>,
    #[serde(default)]
    pub llm: Option<Provider>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Provider {
    pub status: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub dim: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Handoff {
    pub id: String,
    pub from_agent: String,
    #[serde(default)]
    pub to_agent: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecentPage {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub updated_at: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Page {
    pub path: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    pub frontmatter: serde_json::Value,
    #[serde(default)]
    pub expired: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub workspace_name: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub project_name: String,
    pub page_count: u64,
    #[serde(default)]
    pub last_updated: Option<String>,
}

/// Sessão externa; `ended=false` também pode significar trabalho ainda em uso.
#[derive(Debug, Serialize, Deserialize)]
pub struct Session {
    pub session_id: String,
    pub agent_kind: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub last_activity_at: String,
    pub ended: bool,
    pub handed_off: bool,
    #[serde(default)]
    pub current: bool,
}
