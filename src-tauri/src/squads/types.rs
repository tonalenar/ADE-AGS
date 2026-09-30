use serde::{Deserialize, Serialize};

use crate::runs::Complexity;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadLeadInput {
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub auto_account: bool,
    #[serde(default)]
    pub complexity: Option<Complexity>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadMemberInput {
    pub role_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub auto_account: bool,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    #[serde(default)]
    pub isolate_default: bool,
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
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadLead {
    pub agent_id: String,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

/// One policy for routing every task assigned to `role_id`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SquadMember {
    pub role_id: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub isolate_default: bool,
    pub available: bool,
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
    pub created_at: i64,
    pub updated_at: i64,
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
            model: member.model.clone(),
            account_id: member.account_id.clone(),
            auto_account: member.auto_account,
            complexity: member.complexity.map(|complexity| complexity.as_str().to_string()),
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
}
