//! Corpo e resposta de `POST /v1/systemone`, no formato documentado do Jev e da Laya.
//!
//! `choice`, `score` e `noul` são os únicos tipos. O `state` que sai daqui já está
//! truncado: o checkpoint multilingual lê cerca de 1.024 tokens por pergunta.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

/// Orçamento de caracteres do `state`. 4 caracteres por token é uma aproximação
/// conservadora dos 1.024 tokens do checkpoint multilingual.
pub const STATE_CHAR_BUDGET: usize = 4_096;

/// Menos de 20 opções por pergunta. A Laya perde qualidade acima disso.
pub const MAX_OPTIONS: usize = 19;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
    /// O fio aceita `score`. A fase 0 não pergunta nota; o tipo fica para o mesmo cliente.
    #[allow(dead_code)]
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
    Noul {
        instructions: String,
    },
}

impl Question {
    pub fn choice(instructions: &str, options: &[(&str, &str)]) -> Self {
        Self::Choice {
            instructions: instructions.to_string(),
            criteria: options
                .iter()
                .map(|(id, text)| ((*id).to_string(), (*text).to_string()))
                .collect(),
        }
    }

    pub fn noul(instructions: &str) -> Self {
        Self::Noul {
            instructions: instructions.to_string(),
        }
    }

    pub fn option_count(&self) -> usize {
        match self {
            Self::Choice { criteria, .. } => criteria.len(),
            Self::Score { criteria, .. } => criteria.len(),
            Self::Noul { .. } => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionRequest {
    pub state: String,
    pub questions: BTreeMap<String, Question>,
    pub model: String,
    /// Resposta da heurística atual, por id de pergunta. Não vai no JSON do HTTP.
    pub heuristic: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SystemOneBody {
    pub state: String,
    pub questions: BTreeMap<String, Question>,
    pub model: String,
}

impl DecisionRequest {
    pub fn wire(&self) -> Result<SystemOneBody, DecisionError> {
        if self.questions.is_empty() {
            return Err(DecisionError::Malformed("sem perguntas".into()));
        }
        for question in self.questions.values() {
            if question.option_count() > MAX_OPTIONS {
                return Err(DecisionError::Unprocessable(format!(
                    "cada pergunta aceita no máximo {MAX_OPTIONS} opções"
                )));
            }
        }
        Ok(SystemOneBody {
            state: truncate_state(&self.state),
            questions: self.questions.clone(),
            model: self.model.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionAnswer {
    pub label: String,
    pub probability: Option<f64>,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionResponse {
    pub answers: BTreeMap<String, DecisionAnswer>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model: String,
}

#[derive(Debug)]
pub enum DecisionError {
    Timeout,
    Unauthorized,
    Unprocessable(String),
    Malformed(String),
    Status(u16),
    Transport(String),
    Unavailable(String),
}

impl DecisionError {
    pub fn code(&self) -> String {
        match self {
            Self::Timeout => "timeout".into(),
            Self::Unauthorized => "401".into(),
            Self::Unprocessable(message) => format!("422: {message}"),
            Self::Malformed(message) => format!("malformed: {message}"),
            Self::Status(code) => format!("http {code}"),
            Self::Transport(message) => format!("transport: {message}"),
            Self::Unavailable(message) => format!("unavailable: {message}"),
        }
    }
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code())
    }
}

pub fn truncate_state(text: &str) -> String {
    truncate_chars(text.trim(), STATE_CHAR_BUDGET)
}

pub fn truncate_chars(text: &str, max_bytes: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

/// Rótulos estáveis, em ordem de id, para comparar e gravar sem o texto do state.
pub fn canonical(answers: &BTreeMap<String, DecisionAnswer>) -> String {
    answers
        .iter()
        .map(|(id, answer)| format!("{id}={}", answer.label))
        .collect::<Vec<_>>()
        .join(";")
}

pub fn canonical_labels(labels: &BTreeMap<String, String>) -> String {
    labels
        .iter()
        .map(|(id, label)| format!("{id}={label}"))
        .collect::<Vec<_>>()
        .join(";")
}

pub fn state_hash(state: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(truncate_state(state).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn parse_response(body: &str) -> Result<DecisionResponse, DecisionError> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| DecisionError::Malformed("json".into()))?;
    let answers_value = value
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| DecisionError::Malformed("answers".into()))?;
    if answers_value.is_empty() {
        return Err(DecisionError::Malformed("answers vazio".into()));
    }
    let mut answers = BTreeMap::new();
    for (id, answer) in answers_value {
        answers.insert(id.clone(), parse_answer(answer)?);
    }
    let usage = value.get("usage");
    let tokens = |name: &str| {
        usage
            .and_then(|item| item.get(name))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(DecisionResponse {
        answers,
        input_tokens: tokens("input_tokens"),
        output_tokens: tokens("output_tokens"),
        model,
    })
}

fn parse_answer(value: &Value) -> Result<DecisionAnswer, DecisionError> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let confidence = value.get("confidence").and_then(Value::as_f64);
    if kind == "noul" || (value.get("noul").is_some() && kind != "choice" && kind != "score") {
        let noul = value
            .get("noul")
            .ok_or_else(|| DecisionError::Malformed("noul".into()))?;
        let probability = if let Some(number) = noul.as_f64() {
            number
        } else if let Some(flag) = noul.as_bool() {
            if flag { 1.0 } else { 0.0 }
        } else {
            return Err(DecisionError::Malformed("noul".into()));
        };
        let label = if probability >= 0.5 { "sim" } else { "nao" };
        return Ok(DecisionAnswer {
            label: label.into(),
            probability: Some(probability),
            confidence,
        });
    }
    if kind == "score" || (value.get("score").is_some() && kind != "choice") {
        let score = value
            .get("score")
            .and_then(Value::as_f64)
            .ok_or_else(|| DecisionError::Malformed("score".into()))?;
        let label = (score.round() as i64).to_string();
        let probability = value
            .get("probabilities")
            .and_then(|map| map.get(&label))
            .and_then(Value::as_f64);
        return Ok(DecisionAnswer {
            label,
            probability,
            confidence,
        });
    }
    let label = value
        .get("choice")
        .and_then(Value::as_str)
        .ok_or_else(|| DecisionError::Malformed("choice".into()))?
        .to_string();
    let probability = value
        .get("probabilities")
        .and_then(|map| map.get(&label))
        .and_then(Value::as_f64);
    Ok(DecisionAnswer {
        label,
        probability,
        confidence,
    })
}

pub fn primary_metrics(answers: &BTreeMap<String, DecisionAnswer>) -> (Option<f64>, Option<f64>) {
    let preferred = ["acao", "triagem", "despacho", "gate"]
        .into_iter()
        .find_map(|id| answers.get(id))
        .or_else(|| answers.values().next());
    match preferred {
        Some(answer) => (answer.probability, answer.confidence),
        None => (None, None),
    }
}

/// Pedido mínimo de `noul`. A Laya não tem `GET /v1/models` (responde 404).
pub fn ping_request(model: &str) -> DecisionRequest {
    let mut questions = BTreeMap::new();
    questions.insert("up".into(), Question::noul("O serviço está respondendo?"));
    DecisionRequest {
        state: "ping".into(),
        questions,
        model: model.to_string(),
        heuristic: BTreeMap::new(),
    }
}
