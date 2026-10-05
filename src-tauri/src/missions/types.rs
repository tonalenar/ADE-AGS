//! La misión y lo que se muestra de ella.

use serde::{Deserialize, Serialize};

use super::delivery::MissionDelivery;
use crate::runs::{Complexity, Fact, Run, Task};

/// Failure categories and next steps exposed by mission APIs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    Access,
    Limit,
    Model,
    Crash,
    Timeout,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureActionKey {
    #[serde(rename = "missions.failure.action.loginAgain")]
    LoginAgain,
    #[serde(rename = "missions.failure.action.checkPlanOrBalance")]
    CheckPlanOrBalance,
    #[serde(rename = "missions.failure.action.waitForQuotaReset")]
    WaitForQuotaReset,
    #[serde(rename = "missions.failure.action.checkPlanAccess")]
    CheckPlanAccess,
    #[serde(rename = "missions.failure.action.checkServiceStatus")]
    CheckServiceStatus,
    #[serde(rename = "missions.failure.action.chooseAvailableModel")]
    ChooseAvailableModel,
    #[serde(rename = "missions.failure.action.restartAgent")]
    RestartAgent,
    #[serde(rename = "missions.failure.action.retryAfterTimeout")]
    RetryAfterTimeout,
}

impl FailureCategory {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Access => "access",
            Self::Limit => "limit",
            Self::Model => "model",
            Self::Crash => "crash",
            Self::Timeout => "timeout",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "access" => Some(Self::Access),
            "limit" => Some(Self::Limit),
            "model" => Some(Self::Model),
            "crash" => Some(Self::Crash),
            "timeout" => Some(Self::Timeout),
            _ => None,
        }
    }
}

impl FailureActionKey {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::LoginAgain => "missions.failure.action.loginAgain",
            Self::CheckPlanOrBalance => "missions.failure.action.checkPlanOrBalance",
            Self::WaitForQuotaReset => "missions.failure.action.waitForQuotaReset",
            Self::CheckPlanAccess => "missions.failure.action.checkPlanAccess",
            Self::CheckServiceStatus => "missions.failure.action.checkServiceStatus",
            Self::ChooseAvailableModel => "missions.failure.action.chooseAvailableModel",
            Self::RestartAgent => "missions.failure.action.restartAgent",
            Self::RetryAfterTimeout => "missions.failure.action.retryAfterTimeout",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "missions.failure.action.loginAgain" => Some(Self::LoginAgain),
            "missions.failure.action.checkPlanOrBalance" => Some(Self::CheckPlanOrBalance),
            "missions.failure.action.waitForQuotaReset" => Some(Self::WaitForQuotaReset),
            "missions.failure.action.checkPlanAccess" => Some(Self::CheckPlanAccess),
            "missions.failure.action.checkServiceStatus" => Some(Self::CheckServiceStatus),
            "missions.failure.action.chooseAvailableModel" => Some(Self::ChooseAvailableModel),
            "missions.failure.action.restartAgent" => Some(Self::RestartAgent),
            "missions.failure.action.retryAfterTimeout" => Some(Self::RetryAfterTimeout),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailureClassification {
    pub category: FailureCategory,
    pub action_key: FailureActionKey,
}

/// Lo que el usuario quiere lograr, con la preferencia de cómo correrlo.
///
/// La cuenta es un id, nunca una credencial: el entorno lo resuelve el supervisor al
/// lanzar, igual que para cualquier tarea de la flota.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub objective: String,
    pub cwd: String,
    pub status: String,
    pub max_parallel: i64,
    pub budget_usd: Option<f64>,
    /// `None` = lo elige el ruteo por complejidad.
    pub lead_agent_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub lead_model: Option<String>,
    /// Con `auto_account = false`, `None` es la cuenta del sistema.
    pub lead_account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    /// `None` keeps the existing routing/tier behavior.
    pub squad_id: Option<String>,
    /// El run que la está cumpliendo (o la cumplió). `None` mientras es borrador.
    pub active_run_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    /// Null for unclassified or historical failures.
    pub failure_classification: Option<FailureClassification>,
    pub failure_detail: Option<String>,
}

/// Los estados de una misión. Solo los que el ejecutor de hoy puede sostener: no hay
/// `paused` porque no hay pausa real, ni `planning` porque eso se lee de las tareas.
pub mod status {
    pub const DRAFT: &str = "draft";
    pub const RUNNING: &str = "running";
    pub const DONE: &str = "done";
    pub const DONE_WITHOUT_DELIVERY: &str = "done_without_delivery";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}

/// Lo que se pide al crear o editar una misión.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionInput {
    pub title: String,
    pub objective: String,
    pub cwd: String,
    #[serde(default)]
    pub max_parallel: Option<i64>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    #[serde(default)]
    pub lead_agent_id: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub lead_model: Option<String>,
    #[serde(default)]
    pub lead_account_id: Option<String>,
    #[serde(default)]
    pub auto_account: bool,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    #[serde(default)]
    pub squad_id: Option<String>,
}

/// Una fila de la lista: la misión y su avance, en una sola consulta.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionSummary {
    #[serde(flatten)]
    pub mission: Mission,
    /// Lo gastado por el run activo.
    pub spent_usd: f64,
    /// Las tareas del run activo sin contar al lead.
    pub workers_total: i64,
    pub workers_done: i64,
    /// A quién le tocó el lead del run activo (el ruteo puede haber elegido).
    pub lead_agent: Option<String>,
    /// El estado de la tarea del lead, aparte del avance.
    pub lead_status: Option<String>,
    /// Segundos con algún agente trabajando de verdad; `None` en misiones anteriores a la medición.
    pub active_seconds: Option<i64>,
}

/// La misión con su run activo: sus intentos, sus tareas y sus hechos.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MissionDetail {
    pub mission: Mission,
    /// Evidência da conclusão manual em terminais; ausente nos runs e nas missões antigas.
    pub delivery: Option<MissionDelivery>,
    /// Todos sus runs, el más reciente primero.
    pub runs: Vec<Run>,
    /// Las tareas del run activo, en el orden del plan.
    pub tasks: Vec<Task>,
    /// Los hechos del run activo.
    pub facts: Vec<Fact>,
}
