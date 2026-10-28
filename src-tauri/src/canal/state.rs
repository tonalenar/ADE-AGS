//! A máquina de estados de uma aba, alimentada pelos eventos do transcript. Pura: o relógio vem
//! de fora (o carimbo da linha, ou o "agora" de quem lê).

use std::collections::VecDeque;

use serde::Serialize;

use super::event::{clip, ends_with_question, Decision, EndReason, Event, Tokens};

/// Com um turno aberto e o arquivo parado há mais que isto, o estado deixa de valer: o agente
/// pode ter morrido no meio do turno (ou trocado de sessão com `/clear`). Uma ferramenta longa
/// (`cargo test`) não escreve nada enquanto roda, por isso o prazo é generoso.
pub const STALE_OPEN_MS: i64 = 10 * 60 * 1000;
/// Quantas respostas o Claude lembra para não somar duas vezes o mesmo `usage`.
const USAGE_KEYS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Ainda não se viu um começo ou fim de turno.
    Unknown,
    /// Turno aberto: pensando, escrevendo ou com uma ferramenta pendente (que pode estar esperando aprovação).
    Working,
    /// O turno acabou: o agente espera a próxima mensagem.
    Idle,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub since_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub text: String,
    pub options: Vec<String>,
    pub since_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// A última resposta.
    pub last: Option<Tokens>,
    /// O acumulado. `session` = informado pelo próprio agente (Codex); `observed` = somado só a
    /// partir do trecho que o ADE leu (Claude: o começo de um transcript grande não é relido).
    pub total: Tokens,
    pub total_scope: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub phase: Phase,
    /// Se o turno foi deduzido de uma ferramenta (sem ver o prompt que o abriu).
    pub inferred: bool,
    pub turns: u32,
    pub turn_started_at: Option<i64>,
    pub turn_ended_at: Option<i64>,
    pub end_reason: Option<EndReason>,
    pub tools: Vec<PendingTool>,
    pub question: Option<PendingQuestion>,
    /// Pedido de aprovação dito pelo próprio transcript (nenhum agente desta máquina o grava).
    pub approval: Option<PendingTool>,
    /// A última decisão de permissão que o transcript registrou (Claude).
    pub last_decision: Option<Decision>,
    /// A última fala do agente, cortada.
    pub last_text: Option<String>,
    /// O turno acabou com uma pergunta na última linha da fala.
    pub ends_with_question: bool,
    pub usage: Usage,
    /// Carimbo do último evento aplicado (ms).
    pub last_event_at: Option<i64>,
    #[serde(skip)]
    usage_keys: VecDeque<(String, Tokens)>,
}

impl Default for TabState {
    fn default() -> Self {
        TabState {
            phase: Phase::Unknown,
            inferred: false,
            turns: 0,
            turn_started_at: None,
            turn_ended_at: None,
            end_reason: None,
            tools: Vec::new(),
            question: None,
            approval: None,
            last_decision: None,
            last_text: None,
            ends_with_question: false,
            usage: Usage { total_scope: "observed", ..Usage::default() },
            last_event_at: None,
            usage_keys: VecDeque::new(),
        }
    }
}

impl TabState {
    fn open_turn(&mut self, at: i64, inferred: bool) {
        if self.phase == Phase::Working {
            return;
        }
        self.phase = Phase::Working;
        self.inferred = inferred;
        self.turns += 1;
        self.turn_started_at = Some(at);
        self.end_reason = None;
        self.ends_with_question = false;
    }

    pub fn apply(&mut self, event: Event, at: i64) {
        self.last_event_at = Some(at);
        match event {
            Event::TurnStarted => {
                // Um prompt no meio de um turno (mensagem que a pessoa digitou enquanto ele
                // trabalhava, entregue pelo Claude entre duas ferramentas) não abre outro.
                if self.phase != Phase::Working {
                    self.last_text = None;
                }
                self.open_turn(at, false);
            }
            Event::TurnEnded { reason, text } => {
                if let Some(text) = text {
                    self.last_text = Some(text);
                }
                let again = self.phase == Phase::Idle && self.end_reason == Some(reason);
                self.phase = Phase::Idle;
                self.inferred = false;
                if !again {
                    self.turn_ended_at = Some(at);
                }
                self.end_reason = Some(reason);
                self.tools.clear();
                self.question = None;
                self.approval = None;
                self.ends_with_question =
                    reason == EndReason::Completed && self.last_text.as_deref().is_some_and(ends_with_question);
            }
            Event::ToolStarted { id, name, summary } => {
                // Ferramenta sem prompt visto: um turno que começou antes do trecho lido, ou a
                // continuação depois de um hook de Stop.
                self.open_turn(at, true);
                if !self.tools.iter().any(|t| t.id == id) {
                    self.tools.push(PendingTool { id, name, summary, since_ms: at });
                }
            }
            Event::ToolFinished { id, decision } => {
                self.tools.retain(|t| t.id != id);
                if self.question.as_ref().is_some_and(|q| q.id == id) {
                    self.question = None;
                }
                if self.approval.as_ref().is_some_and(|a| a.id == id) {
                    self.approval = None;
                }
                if decision.is_some() {
                    self.last_decision = decision;
                }
            }
            Event::Question { id, text, options } => {
                self.open_turn(at, true);
                self.question = Some(PendingQuestion { id, text, options, since_ms: at });
            }
            Event::ApprovalRequested { id, summary } => {
                self.open_turn(at, true);
                self.approval = Some(PendingTool { id, name: "approval".into(), summary, since_ms: at });
            }
            Event::AssistantText(text) => {
                self.last_text = Some(clip(&text, 2000));
            }
            Event::Usage { key, last, total } => {
                self.usage.last = Some(last);
                if let Some(total) = total {
                    self.usage.total = total;
                    self.usage.total_scope = "session";
                    return;
                }
                match key {
                    Some(key) => {
                        if let Some(pos) = self.usage_keys.iter().position(|(k, _)| *k == key) {
                            let (_, before) = self.usage_keys[pos];
                            self.usage.total.sub(&before);
                            self.usage_keys[pos].1 = last;
                        } else {
                            self.usage_keys.push_back((key, last));
                            if self.usage_keys.len() > USAGE_KEYS {
                                self.usage_keys.pop_front();
                            }
                        }
                        self.usage.total.add(&last);
                    }
                    None => self.usage.total.add(&last),
                }
            }
        }
    }

    /// A fase que vale para decidir: um turno aberto com o arquivo parado há mais de
    /// [`STALE_OPEN_MS`] volta a ser "não sei". `grew_at` = quando o arquivo cresceu pela última vez.
    pub fn effective_phase(&self, grew_at: i64, now: i64) -> Phase {
        if self.phase == Phase::Working && now - grew_at > STALE_OPEN_MS {
            Phase::Unknown
        } else {
            self.phase
        }
    }

    /// O que muda o que alguém faria com este estado (para emitir o evento só quando muda).
    pub fn signature(&self) -> String {
        let tools: Vec<&str> = self.tools.iter().map(|t| t.id.as_str()).collect();
        format!(
            "{:?}|{}|{:?}|{}|{}|{}|{}|{}",
            self.phase,
            self.turns,
            self.end_reason,
            tools.join(","),
            self.question.as_ref().map(|q| q.id.as_str()).unwrap_or(""),
            self.approval.as_ref().map(|a| a.id.as_str()).unwrap_or(""),
            self.ends_with_question,
            self.usage.total.output,
        )
    }
}
