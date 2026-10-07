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

const SECRET_PREFIXES: &[&str] = &["sk-", "sk_live_", "sk_test_", "glpat-", "npm_", "ghp_", "gho_", "github_pat_", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "AKIA", "ASIA", "AIza", "ya29.", "eyJ"];

/// Prefixo estável para a interface pedir confirmação consciente, sem interpretar a frase.
pub const SECRET_CONFIRMATION_CODE: &str = "CONFIRMACAO_DE_CREDENCIAL";

pub fn secret_confirmation_error() -> String {
    format!("{SECRET_CONFIRMATION_CODE}: Esta proposta parece conter uma credencial (chave, token ou senha). Reescreva sem o valor ou confirme conscientemente para guardar mesmo assim.")
}

/// `password: hunter2` é credencial. `senha: mínimo 12 caracteres` é política de senha.
/// Só o painel do usuário usa este critério. Worker, lead e swarm usam a atribuição inteira.
fn assignment_value_is_secret(raw: &str, rest: &str) -> bool {
    let value = raw.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | '{' | '}' | '[' | ']' | '(' | ')' | '.'));
    if value.is_empty() || !value.is_ascii() {
        return false;
    }
    let followed_by_prose = rest.split_whitespace().next().is_some_and(|word| {
        let word = word.trim_matches(|c: char| !c.is_alphanumeric());
        !word.is_empty()
    });
    if !followed_by_prose {
        return true;
    }
    if value.len() >= 20 && SECRET_PREFIXES.iter().any(|prefix| value.starts_with(prefix)) {
        return true;
    }
    let has_digit = value.bytes().any(|b| b.is_ascii_digit());
    let has_symbol = value.bytes().any(|b| matches!(b, b'-' | b'_' | b'+' | b'/' | b'=' | b'$' | b'#' | b'@' | b'%' | b'!' | b'&' | b'*'));
    (has_digit && value.len() >= 6) || (has_symbol && value.len() >= 8) || value.len() >= 24
}

fn assignment_is_secret(text: &str, relaxed: bool) -> bool {
    use std::sync::OnceLock;
    static ASSIGNMENT: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = ASSIGNMENT.get_or_init(|| {
        regex::Regex::new(r#"(?i)\b(password|passwd|senha|secret|token|api_key|apikey)["']?\s*[:=]\s*(\S+)"#).unwrap()
    });
    pattern.captures_iter(text).any(|caps| {
        if !relaxed {
            return true;
        }
        let value = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let end = caps.get(2).map(|m| m.end()).unwrap_or(0);
        assignment_value_is_secret(value, text.get(end..).unwrap_or(""))
    })
}

/// Detector rígido para worker, lead, swarm, fatos e o Dreamer.
/// Qualquer `senha: valor` conta, mesmo com texto depois ou com acento.
pub fn looks_like_secret(text: &str) -> bool {
    looks_like_secret_inner(text, false)
}

/// Detector do painel do usuário. Frase de política de senha não pede confirmação.
pub fn looks_like_user_secret(text: &str) -> bool {
    looks_like_secret_inner(text, true)
}

fn looks_like_secret_inner(text: &str, relaxed_assignment: bool) -> bool {
    use std::sync::OnceLock;
    static CREDENTIAL_URL: OnceLock<regex::Regex> = OnceLock::new();
    let lower = text.to_lowercase();
    if lower.contains("-----begin") && lower.contains("private key-----")
        || lower.contains("authorization: bearer") {
        return true;
    }
    if assignment_is_secret(text, relaxed_assignment)
        || CREDENTIAL_URL.get_or_init(|| regex::Regex::new(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/@:]+:[^\s/@]+@[^\s/]+").unwrap()).is_match(text) {
        return true;
    }
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '=' | ':'))
        .any(|word| {
            let word = word.trim_matches(|c: char| matches!(c, '.' | '[' | ']'));
            let keyish = word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/'));
            if !keyish { return false; }
            if word.len() >= 20 && SECRET_PREFIXES.iter().any(|p| word.starts_with(p)) { return true; }
            // Canonical ADE evidence URIs contain UUIDs, not credential entropy.
            // Only short fixture identifiers or canonical hexadecimal UUIDs qualify;
            // long credential-like URI components still pass through the guard.
            if let Some(path)=word.strip_prefix("//run/") {
                let parts=path.split('/').collect::<Vec<_>>();
                let evidence_id=|id:&str| {
                    (id.len()<=16 && !id.is_empty() && id.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||matches!(b,b'-'|b'_')))
                    || (id.len()==36 && id.bytes().enumerate().all(|(i,b)|if matches!(i,8|13|18|23){b==b'-'}else{b.is_ascii_hexdigit()}))
                };
                if parts.len()==3 && matches!(parts[1],"task"|"fact") && evidence_id(parts[0]) && evidence_id(parts[2]) {return false;}
            }
            // Hashes and UUIDs are routine evidence IDs, not credential entropy.
            if word.len() < 32 || word.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return false; }
            let classes = [word.bytes().any(|b| b.is_ascii_lowercase()), word.bytes().any(|b| b.is_ascii_uppercase()), word.bytes().any(|b| b.is_ascii_digit())];
            if classes.into_iter().filter(|present| *present).count() < 2 { return false; }
            let mut counts = [0usize; 256];
            for byte in word.bytes() { counts[byte as usize] += 1; }
            let entropy: f64 = counts.iter().filter(|&&n| n > 0).map(|&n| {
                let p = n as f64 / word.len() as f64; -p * p.log2()
            }).sum();
            entropy >= 4.5
        })
}


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

/// Quem é, pelo nome da aba: o orquestrador se reconhece pelo nome (sem importar maiúsculas nem
/// espaços nas pontas); qualquer outro é um integrante. Pura.
pub fn author_of(tab_name: &str) -> Author {
    if tab_name.trim().eq_ignore_ascii_case(LEAD_TAB_NAME) { Author::Lead } else { Author::Worker }
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
        acknowledge_secret: false,
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
