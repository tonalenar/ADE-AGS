//! Memórias propostas pelos agentes de uma missão em terminais.
//!
//! O ciclo fecha assim: o agente **lê** (`memory search`), trabalha e, ao terminar, **propõe**
//! o que valeria guardar para a próxima missão. Propor não é gravar: a proposta fica
//! pendente até o usuário aprová-la na tela de Missões. Um agente nunca aprova.
//!
//! Como o texto vem de um agente (que leu páginas, arquivos e saídas de comandos), é dado
//! não confiável. Por isso aqui há três travas além das que `propose` já tem (tamanho,
//! cota, no máximo 32 pendentes por dono):
//!
//! - **segredos**: uma proposta que pareça uma chave, token ou senha é recusada. Memória é
//!   texto que vai para o briefing de outros agentes e para o banco;
//! - **prioridade baixa**: o agente pode sugerir até 3; subir a prioridade é decisão do usuário;
//! - **autoria**: fica marcada como de `lead` ou `worker`, com a missão e o nome da terminal
//!   no motivo, para o usuário saber de onde veio ao decidir.

use rusqlite::Connection;

use super::{propose, ProposalActor, ProposalInput, ProposalResult};

/// O nome da terminal do orquestrador (a mesma constante do frontend, `LEAD_NAME`).
pub const LEAD_TAB_NAME: &str = "Orquestrador";

/// A maior prioridade que um agente pode pedir. O usuário a muda ao aprovar.
pub const MAX_AGENT_PRIORITY: i64 = 3;

const SECRET_PREFIXES: &[&str] = &["sk-", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "AIza", "ya29.", "eyJ"];
const SECRET_MARKERS: &[&str] = &["-----BEGIN", "password=", "passwd=", "secret=", "token=", "api_key=", "apikey=", "authorization: bearer"];

/// Parece uma credencial? Heurística conservadora: prefere recusar a deixar passar. Pura.
pub fn looks_like_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    if SECRET_MARKERS.iter().any(|m| lower.contains(&m.to_lowercase())) {
        return true;
    }
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '=' | ':'))
        .any(|word| {
            let word = word.trim_matches(|c: char| matches!(c, '.' | '[' | ']'));
            // Um prefixo conhecido seguido de um bom pedaço de caracteres de chave.
            let keyish = word.len() >= 20 && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
            keyish && SECRET_PREFIXES.iter().any(|p| word.starts_with(p))
        })
}

/// Quem propõe: o orquestrador ou um integrante.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Author {
    Lead,
    Worker,
}

impl Author {
    fn kind(self) -> &'static str {
        match self {
            Author::Lead => "lead",
            Author::Worker => "worker",
        }
    }
}

/// O pedido de um agente, já com o que o servidor sabe dele.
pub struct AgentProposal<'a> {
    pub mission_id: &'a str,
    pub scope: &'a str,
    pub key: &'a str,
    pub kind: &'a str,
    pub body: &'a str,
    pub priority: i64,
    pub author: Author,
    /// O nome da terminal que propôs (para o motivo).
    pub author_name: &'a str,
}

/// Propõe uma memória em nome de um agente. Fica **pendente**; nunca ativa.
pub fn propose_for_mission(conn: &Connection, p: &AgentProposal<'_>) -> Result<ProposalResult, String> {
    let (workspace_id,): (String,) = conn
        .query_row("SELECT workspace_id FROM missions WHERE id = ?1", [p.mission_id], |r| Ok((r.get(0)?,)))
        .map_err(|_| format!("Não existe a missão {}.", p.mission_id))?;
    let scope = match p.scope {
        "workspace" | "mission" => p.scope,
        other => return Err(format!("O escopo '{other}' não existe. Use 'workspace' (vale para o projeto) ou 'mission'.")),
    };
    if looks_like_secret(p.body) || looks_like_secret(p.key) {
        return Err("A proposta parece conter uma credencial (chave, token ou senha). Memória não guarda segredos: reescreva sem o valor.".into());
    }
    let short: String = p.mission_id.chars().take(8).collect();
    let input = ProposalInput {
        scope: scope.into(),
        key: p.key.into(),
        kind: p.kind.into(),
        body: p.body.into(),
        priority: p.priority.clamp(0, MAX_AGENT_PRIORITY),
        operation: "create".into(),
        expected_revision: None,
        source_fact_id: None,
        reason: Some(format!("Proposta de {} na missão {short}", p.author_name)),
    };
    propose(
        conn,
        scope,
        &workspace_id,
        if scope == "mission" { Some(p.mission_id) } else { None },
        &input,
        ProposalActor { kind: p.author.kind(), run_id: None, task_id: None, fact_id: None },
    )
}

#[cfg(test)]
mod test;
