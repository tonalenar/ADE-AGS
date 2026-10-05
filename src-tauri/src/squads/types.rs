use serde::{Deserialize, Serialize};

use crate::runs::Complexity;

/// What the local installation can verify about a saved provider/account assignment.
/// Explicit model IDs stay `Unknown` here because model catalogs differ by adapter; the
/// routing layer validates them when a Mission starts or a Plan is resolved.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentAvailability {
    ProviderNotOrchestrating,
    Available,
    Unknown,
    ProviderMissing,
    ProviderNotInstalled,
    ProviderNotHeadless,
    AccountMissing,
    AccountProviderMismatch,
}

impl AssignmentAvailability {
    /// Unknown means runtime routing must check the selected model; it is not a reason to
    /// silently replace the configured assignment or prevent the user from trying it.
    pub fn can_attempt(self) -> bool {
        matches!(self, Self::Available | Self::Unknown)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadLeadInput {
    pub agent_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub auto_account: bool,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    /// Modo Fast de Codex (`service_tier="fast"`). Solo vale con el agente `codex`.
    #[serde(default)]
    pub fast_mode: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadMemberInput {
    pub role_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub auto_account: bool,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    #[serde(default)]
    pub fast_mode: bool,
    #[serde(default)]
    pub isolate_default: bool,
}

/// Qué LLM usan por defecto los subagentes que la orquestadora suma con `ags peer recruit`.
/// `None` en el Squad = Automático: la orquestadora decide y justifica la elección.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDefault {
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Modo Fast de Codex; solo vale con `agent_id = "codex"`.
    #[serde(default)]
    pub fast_mode: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub lead: SquadLeadInput,
    #[serde(default)]
    pub members: Vec<SquadMemberInput>,
    #[serde(default)]
    pub default_subagent: Option<SubagentDefault>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadLead {
    pub agent_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub fast_mode: bool,
    pub availability: AssignmentAvailability,
    pub unavailable_reason: Option<String>,
}

/// One policy for routing every task assigned to `role_id`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadMember {
    pub role_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub fast_mode: bool,
    pub isolate_default: bool,
    pub availability: AssignmentAvailability,
    pub unavailable_reason: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Squad {
    pub id: String,
    pub name: String,
    pub description: String,
    pub lead: SquadLead,
    pub members: Vec<SquadMember>,
    pub default_subagent: Option<SubagentDefault>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Start availability follows the Lead. Optional worker roles are checked only if a
    /// plan uses them; one unavailable member must not disable the whole Squad.
    pub available: bool,
    pub unavailable_reasons: Vec<String>,
}

/// Immutable copy of the routing policy stored with a Run. Runtime planning uses these
/// members instead of following the editable Squad row after execution has started.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSquadMember {
    pub role_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub isolate_default: bool,
}

impl From<&SquadMember> for RunSquadMember {
    fn from(member: &SquadMember) -> Self {
        Self {
            role_id: member.role_id.clone(),
            agent_id: member.agent_id.clone(),
            reasoning_effort: member.reasoning_effort.clone(),
            model: member.model.clone(),
            account_id: member.account_id.clone(),
            auto_account: member.auto_account,
            complexity: member.complexity.clone(),
            isolate_default: member.isolate_default,
        }
    }
}

impl From<&SquadMemberInput> for RunSquadMember {
    fn from(member: &SquadMemberInput) -> Self {
        Self {
            role_id: member.role_id.clone(),
            agent_id: member.agent_id.clone(),
            reasoning_effort: member.reasoning_effort.clone(),
            model: member.model.clone(),
            account_id: member.account_id.clone(),
            auto_account: member.auto_account,
            complexity: member
                .complexity
                .map(|complexity| complexity.as_str().to_string()),
            isolate_default: member.isolate_default,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidSquad {
    pub name: String,
    pub description: String,
    pub lead: SquadLeadInput,
    pub members: Vec<SquadMemberInput>,
    pub default_subagent: Option<SubagentDefault>,
}
