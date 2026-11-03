//! O medidor de contexto de um agente: quanto da janela do modelo a conversa já ocupa, para avisar quem
//! supervisiona ANTES do auto-compact (depois dele, o integrante "esquece" o que fez). Ideia do `token-meter`
//! do deepseek-harness (MIT), reimplementada aqui.
//!
//! A âncora é o `usage` REAL da última resposta (entrada nova + o que veio do cache + o que foi gravado nele).
//! O que o agente escreveu ou chamou depois dela ainda não tem `usage`: entra como estimativa de 4 caracteres
//! por token. Só leitura; puro.

use serde::Serialize;

/// Quantos caracteres valem um token na estimativa (o texto depois do último `usage` real).
pub const CHARS_PER_TOKEN: u64 = 4;
/// Acima disto (fração da janela), quem supervisiona é avisado: o auto-compact costuma vir perto de 0,8–0,9.
pub const WARN_PRESSURE: f64 = 0.8;
/// Janela padrão do Claude Code e a estendida (`[1m]`), como no painel lateral (`session/panel.rs`).
pub const CLAUDE_WINDOW: u64 = 200_000;
pub const CLAUDE_WINDOW_1M: u64 = 1_000_000;

/// Tokens estimados de um texto (arredonda para cima). Pura.
pub fn estimate_tokens(chars: u64) -> u64 {
    chars.div_ceil(CHARS_PER_TOKEN)
}

/// A janela do Claude: a estendida se o modelo diz `[1m]` ou se o uso já passou da padrão. Pura.
pub fn claude_window(model: Option<&str>, used: u64) -> u64 {
    if model.is_some_and(|m| m.to_ascii_lowercase().contains("[1m]")) || used > CLAUDE_WINDOW {
        CLAUDE_WINDOW_1M
    } else {
        CLAUDE_WINDOW
    }
}

/// O medidor de uma conversa.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// O contexto da última resposta, pelo `usage` real (tokens).
    pub anchor_tokens: u64,
    /// Os caracteres vistos depois da âncora (falas e chamadas ainda sem `usage`).
    pub extra_chars: u64,
    /// A janela do modelo (tokens). `0` = não se sabe, e então não há pressão.
    pub window_tokens: u64,
    pub model: Option<String>,
}

impl Meter {
    /// Uma resposta nova com `usage`: a âncora troca e a estimativa recomeça.
    pub fn anchor(&mut self, used: u64, window: Option<u64>, model: Option<&str>) {
        self.anchor_tokens = used;
        self.extra_chars = 0;
        if let Some(model) = model {
            self.model = Some(model.to_string());
        }
        self.window_tokens = match window.filter(|w| *w > 0) {
            Some(w) => w,
            None => claude_window(self.model.as_deref(), used),
        };
    }

    /// Texto que o agente produziu depois da última âncora.
    pub fn grow(&mut self, chars: usize) {
        self.extra_chars = self.extra_chars.saturating_add(chars as u64);
    }

    /// O contexto estimado agora: a âncora real mais a estimativa do que veio depois.
    pub fn used_tokens(&self) -> u64 {
        self.anchor_tokens.saturating_add(estimate_tokens(self.extra_chars))
    }

    /// A fração da janela ocupada (0 sem janela conhecida).
    pub fn pressure(&self) -> f64 {
        if self.window_tokens == 0 {
            0.0
        } else {
            self.used_tokens() as f64 / self.window_tokens as f64
        }
    }

    /// Passou do limiar de aviso?
    pub fn near_limit(&self) -> bool {
        self.pressure() >= WARN_PRESSURE
    }
}

/// O contexto de uma conversa sem medidor vivo, a partir do último `usage` real e do texto depois dele. Pura.
pub fn pressure_of(anchor_tokens: u64, extra_chars: u64, window_tokens: u64) -> f64 {
    let meter = Meter { anchor_tokens, extra_chars, window_tokens, model: None };
    meter.pressure()
}
