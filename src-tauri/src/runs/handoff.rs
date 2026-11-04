//! Versioned worker delivery. References are data, never filesystem operations.
//!
//! v1.1 (aditivo): o campo opcional `status` liga regras por estado. `continue` exige
//! `next_steps`, `complete` exige evidência (`evidence`, um teste `passed` ou um artefato) e
//! `blocked` exige um bloqueio concreto em `blockers`. Um report que não cumpre é recusado
//! inteiro, nunca truncado. Sem `status`, vale o v1 de sempre.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024;
pub const MAX_SUMMARY_BYTES: usize = 4 * 1024;
pub const MAX_TEXT_BYTES: usize = 2 * 1024;
pub const MAX_PATH_BYTES: usize = 512;
pub const MAX_ITEMS: usize = 32;
pub const MAX_CONTEXT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StructuredHandoff {
    pub version: u8,
    pub summary: String,
    #[serde(default)]
    pub changed_files: Vec<ChangedFile>,
    #[serde(default)]
    pub tests: Vec<HandoffTest>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    /// v1.1: estado declarado da entrega. Ausente = v1, sem regras por estado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<HandoffStatus>,
    /// v1.1: o que prova a conclusão (saída de comando, link de CI, captura).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    /// v1.1: o que impede seguir, dito de forma concreta.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<String>,
}

/// v1.1: o estado que a entrega declara. Cada um tem a sua regra em [`StructuredHandoff::validate`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HandoffStatus { Continue, Complete, Blocked }

/// Bloqueio mínimo para contar como concreto: menos que isso é "travado" sem dizer onde.
pub const MIN_BLOCKER_CHARS: usize = 12;
const VAGUE_BLOCKERS: &[&str] = &["n/a", "na", "none", "nenhum", "nada", "tbd", "todo", "blocked", "bloqueado", "travado", "unknown", "desconhecido", "-", "?"];

fn concrete_blocker(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.chars().count() >= MIN_BLOCKER_CHARS && !VAGUE_BLOCKERS.contains(&trimmed.to_lowercase().as_str())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HandoffTest {
    pub command: String,
    pub status: TestStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus { Passed, Failed, NotRun }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Artifact { pub label: String, pub path: String }

fn text(value: &str, field: &str, max: usize, required: bool) -> Result<(), String> {
    if (required && value.trim().is_empty()) || value.len() > max || value.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(format!("Invalid handoff {field}: text must fit {max} bytes and contain no control characters"));
    }
    Ok(())
}

fn path(value: &str) -> Result<(), String> {
    text(value, "path", MAX_PATH_BYTES, true)?;
    if value.starts_with('/') || value.contains(['\\', ':', '\n', '\t', '?', '#'])
        || value.split('/').any(|part| part.is_empty() || part == ".." || part == ".") {
        return Err("Invalid handoff path: use a relative workspace path without traversal, drive, URL or backslash".into());
    }
    Ok(())
}

pub fn parse(value: &Value) -> Result<StructuredHandoff, String> {
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("Handoff exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
    let handoff: StructuredHandoff = serde_json::from_value(value.clone()).map_err(|e| format!("Invalid handoff schema: {e}"))?;
    handoff.validate()?;
    Ok(handoff)
}

impl StructuredHandoff {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 { return Err("Unsupported handoff version: expected 1".into()); }
        text(&self.summary, "summary", MAX_SUMMARY_BYTES, true)?;
        for count in [self.changed_files.len(), self.tests.len(), self.decisions.len(), self.risks.len(), self.next_steps.len(), self.artifacts.len()] {
            if count > MAX_ITEMS { return Err(format!("Handoff array exceeds {MAX_ITEMS} items")); }
        }
        for file in &self.changed_files {
            path(&file.path)?;
            if let Some(description) = &file.description { text(description, "description", MAX_TEXT_BYTES, false)?; }
        }
        for test in &self.tests {
            text(&test.command, "command", MAX_TEXT_BYTES, true)?;
            if let Some(notes) = &test.notes { text(notes, "notes", MAX_TEXT_BYTES, false)?; }
        }
        for count in [self.evidence.len(), self.blockers.len()] {
            if count > MAX_ITEMS { return Err(format!("Handoff array exceeds {MAX_ITEMS} items")); }
        }
        for value in self.decisions.iter().chain(&self.risks).chain(&self.next_steps).chain(&self.evidence).chain(&self.blockers) { text(value, "item", MAX_TEXT_BYTES, true)?; }
        for artifact in &self.artifacts { text(&artifact.label, "label", MAX_TEXT_BYTES, true)?; path(&artifact.path)?; }
        self.validate_status()?;
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_PAYLOAD_BYTES { return Err(format!("Handoff exceeds {MAX_PAYLOAD_BYTES} bytes")); }
        Ok(())
    }
}

impl StructuredHandoff {
    /// Regras do v1.1. A mensagem diz o que falta, para o agente reenviar o report inteiro.
    fn validate_status(&self) -> Result<(), String> {
        match self.status {
            None => Ok(()),
            Some(HandoffStatus::Continue) if self.next_steps.is_empty() =>
                Err("Handoff com status \"continue\" exige next_steps: diga o que falta fazer".into()),
            Some(HandoffStatus::Complete) if self.evidence.is_empty()
                && !self.tests.iter().any(|t| t.status == TestStatus::Passed) && self.artifacts.is_empty() =>
                Err("Handoff com status \"complete\" exige evidência: evidence, um teste passed ou um artifact".into()),
            Some(HandoffStatus::Blocked) if !self.blockers.iter().any(|b| concrete_blocker(b)) =>
                Err(format!("Handoff com status \"blocked\" exige um bloqueio concreto em blockers (o quê e onde, {MIN_BLOCKER_CHARS}+ caracteres)")),
            Some(_) => Ok(()),
        }
    }
}

/// The MCP advertises the same fields and bounds enforced by the Rust contract.
pub fn schema() -> Value {
    let text = json!({"type":"string","maxLength":MAX_TEXT_BYTES});
    let path = json!({"type":"string","minLength":1,"maxLength":MAX_PATH_BYTES});
    let list = |items: Value| json!({"type":"array","maxItems":MAX_ITEMS,"items":items});
    json!({"type":"object","additionalProperties":false,"required":["version","summary"],"properties":{
        "version":{"type":"integer","enum":[1]}, "summary":{"type":"string","minLength":1,"maxLength":MAX_SUMMARY_BYTES},
        "changed_files":list(json!({"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":path,"description":text}})),
        "tests":list(json!({"type":"object","additionalProperties":false,"required":["command","status"],"properties":{"command":text,"status":{"type":"string","enum":["passed","failed","not_run"]},"notes":text}})),
        "decisions":list(text.clone()), "risks":list(text.clone()), "next_steps":list(text.clone()),
        "artifacts":list(json!({"type":"object","additionalProperties":false,"required":["label","path"],"properties":{"label":text,"path":path}})),
        "status":{"type":"string","enum":["continue","complete","blocked"],"description":"v1.1: continue requires next_steps; complete requires evidence, a passed test or an artifact; blocked requires a concrete blocker. Invalid reports are rejected whole."},
        "evidence":list(text.clone()), "blockers":list(text.clone())
    }})
}

#[cfg(test)]
mod test;
