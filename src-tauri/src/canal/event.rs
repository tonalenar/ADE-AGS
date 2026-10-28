//! Os eventos normalizados do canal estruturado: o que cada transcript diz, já no mesmo
//! vocabulário para o Claude Code e o Codex. Só tipos e funções puras.

use serde::Serialize;

/// Por que o turno acabou.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// O agente terminou de responder (`turn_duration`/`end_turn` no Claude, `task_complete` no Codex).
    Completed,
    /// Alguém apertou Esc (`[Request interrupted by user]` no Claude, `turn_aborted` no Codex).
    Interrupted,
}

/// Como uma ferramenta que pedia permissão foi resolvida. Só o Claude Code escreve isso, e só
/// DEPOIS da decisão (`permissionDecision` na linha do `tool_result`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub accepted: bool,
    /// `true` = a pessoa respondeu no diálogo (`user_temporary`/`user_permanent`/`user-rejected`);
    /// `false` = uma regra, o modo ou o classificador decidiu sozinho.
    pub by_user: bool,
}

/// Tokens de uma resposta. `input` é só a entrada NÃO cacheada nos dois agentes (no Codex o
/// `input_tokens` inclui o cache e é normalizado aqui).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cached += other.cached;
        self.cache_write += other.cache_write;
    }

    pub fn sub(&mut self, other: &Tokens) {
        self.input = self.input.saturating_sub(other.input);
        self.output = self.output.saturating_sub(other.output);
        self.cached = self.cached.saturating_sub(other.cached);
        self.cache_write = self.cache_write.saturating_sub(other.cache_write);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// Um prompt (da pessoa, do ADE ou de uma notificação de tarefa) abriu um turno.
    TurnStarted,
    /// O turno acabou. `text` é a última fala do agente, quando a linha a traz.
    TurnEnded { reason: EndReason, text: Option<String> },
    /// Uma ferramenta foi chamada e ainda não tem resultado.
    ToolStarted { id: String, name: String, summary: String },
    /// O resultado da ferramenta chegou.
    ToolFinished { id: String, decision: Option<Decision> },
    /// O agente fez uma pergunta com opções e espera a resposta (`AskUserQuestion` no Claude).
    Question { id: String, text: String, options: Vec<String> },
    /// O agente pediu aprovação e o transcript disse (não acontece no Codex 0.163: ver o doc).
    ApprovalRequested { id: String, summary: String },
    /// Uma fala do agente (texto, sem ferramentas).
    AssistantText(String),
    /// Uso de tokens. `key` deduplica as linhas repetidas da mesma resposta (o Claude escreve
    /// uma linha por bloco, todas com o mesmo `usage`); `total` é o acumulado da sessão quando
    /// o próprio agente o informa (Codex).
    Usage { key: Option<String>, last: Tokens, total: Option<Tokens> },
}

/// Corta um texto em `max` caracteres, sem partir um caractere.
pub(crate) fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// A primeira linha com texto, cortada: o resumo de um comando ou de um argumento longo.
pub(crate) fn first_line(text: &str, max: usize) -> String {
    clip(text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""), max)
}

/// `2026-10-20T21:47:44.123Z` → ms desde a época. `None` se não reconhece.
pub(crate) fn parse_ts_ms(raw: &str) -> Option<i64> {
    let seconds = crate::usage::parse_ts(raw)?;
    let millis = raw
        .split_once('.')
        .map(|(_, frac)| {
            let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
            format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
        })
        .unwrap_or(0);
    Some(seconds * 1000 + millis)
}

/// A última fala termina numa pergunta? Olha só a última linha com texto (o fim da resposta),
/// ignorando o que está dentro de um bloco de código. Pura.
pub fn ends_with_question(text: &str) -> bool {
    let mut in_code = false;
    let mut last = "";
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if !in_code && !trimmed.is_empty() {
            last = trimmed;
        }
    }
    let last = last.trim_end_matches(['*', '_', '`', ')', '"', '\'', ' ']);
    last.ends_with('?')
}
