//! Na aba Equipe, uma mensagem escrita SEM @ ganha uma SUGESTÃO de destino: um integrante ou o
//! orquestrador. O Jev só sugere; a tela mostra um chip e a pessoa clica. Nada é enviado sozinho.
//!
//! Mesmas regras do Vigia (`delivery.rs`):
//!
//! - fica DESLIGADO por padrão (`decisions.point.turn_routing`);
//! - o texto sai só até o corte de `delivery::clip_text`, e nada que o detector de segredos marque;
//! - a pergunta usa ids seguros (`d0`, `d1`…, e `orquestrador`): o provedor nunca escolhe um nome livre;
//! - qualquer falha (desligado, sem chave, timeout, resposta desconhecida) devolve `None`;
//! - cada consulta vira uma linha do log (`turn_routing`) com a sugestão local ao lado, para medir quem acerta.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config;
use super::delivery::clip_text;
use super::http;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_ROUTING};
use super::protocol::{canonical, canonical_labels, primary_metrics, DecisionRequest, Question};

/// Quantos integrantes entram na pergunta (os primeiros da lista).
pub const MAX_MEMBERS: usize = 12;

/// Quanto do papel de cada integrante vai como descrição da opção.
const ROLE_CHARS: usize = 80;
const QUESTION: &str = "destino";
const ORCHESTRATOR: &str = "orquestrador";
/// Rótulo do log quando a regra local não sugere ninguém.
const NONE: &str = "nenhum";

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub name: String,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// O nome do integrante, ou `orquestrador`.
    pub target: String,
    pub confidence: Option<f64>,
    /// A probabilidade do destino escolhido: é ela que a tela pode conferir.
    pub probability: Option<f64>,
}

/// Os integrantes que entram na pergunta: no máximo `MAX_MEMBERS`. Pura.
fn team(members: &[Member]) -> &[Member] {
    &members[..members.len().min(MAX_MEMBERS)]
}

fn option_id(index: usize) -> String {
    format!("d{index}")
}

fn cut(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// O pedido ao provedor. `local` é a opção que a regra local sugeriu (`d1`, `orquestrador`…), para o log. Pura.
pub fn request_for(text: &str, members: &[Member], local: &str) -> DecisionRequest {
    let mut options: Vec<(String, String)> = team(members)
        .iter()
        .enumerate()
        .map(|(index, member)| {
            let role = if member.role.trim().is_empty() { &member.name } else { &member.role };
            (option_id(index), cut(role, ROLE_CHARS))
        })
        .collect();
    options.push((ORCHESTRATOR.into(), "coordena a equipe e decide os próximos passos".into()));
    let refs: Vec<(&str, &str)> = options.iter().map(|(id, label)| (id.as_str(), label.as_str())).collect();
    let mut questions = BTreeMap::new();
    questions.insert(QUESTION.into(), Question::choice("Para quem esta mensagem deve ir?", &refs));
    let mut heuristic = BTreeMap::new();
    heuristic.insert(QUESTION.into(), local.to_string());
    DecisionRequest { state: clip_text(text), questions, model: String::new(), heuristic }
}

/// Lê a resposta: só vale uma opção conhecida, e volta para o nome do integrante. Pura.
pub fn read_answer(
    canonical_answer: &str,
    members: &[Member],
    confidence: Option<f64>,
    probability: Option<f64>,
) -> Option<Route> {
    let chosen = canonical_answer.split(';').find_map(|pair| pair.strip_prefix("destino="))?;
    let target = target_of(chosen, members)?;
    Some(Route { target, confidence, probability })
}

fn target_of(option: &str, members: &[Member]) -> Option<String> {
    if option == ORCHESTRATOR {
        return Some(ORCHESTRATOR.into());
    }
    let team = team(members);
    (0..team.len())
        .find(|index| option_id(*index) == option)
        .map(|index| team[index].name.clone())
}

/// O integrante cujo nome ou papel tem mais palavras em comum com o texto. Empate ou zero → `None`.
/// Palavras de até 3 letras não contam; acentos simples são ignorados. Pura.
pub fn local_guess(text: &str, members: &[Member]) -> Option<String> {
    let said = words(text);
    let mut best = 0;
    let mut winner: Option<&Member> = None;
    let mut tie = false;
    for member in team(members) {
        let mut own = words(&member.name);
        own.extend(words(&member.role));
        let score = own.iter().filter(|word| said.contains(*word)).count();
        if score > best {
            best = score;
            winner = Some(member);
            tie = false;
        } else if score == best && score > 0 {
            tie = true;
        }
    }
    if tie {
        None
    } else {
        winner.map(|member| member.name.clone())
    }
}

fn words(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .map(|word| fold_accents(&word.to_lowercase()))
        .filter(|word| word.chars().count() > 3)
        .collect()
}

fn fold_accents(word: &str) -> String {
    word.chars()
        .map(|c| match c {
            'á' | 'à' | 'ã' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'õ' | 'ô' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

/// A opção que a regra local sugere, no vocabulário da pergunta (`dN`, `orquestrador` ou `nenhum`).
fn local_option(text: &str, members: &[Member], local: Option<&str>) -> String {
    let guess = local.map(str::to_string).or_else(|| local_guess(text, members));
    match guess.as_deref() {
        Some(ORCHESTRATOR) => ORCHESTRATOR.into(),
        Some(name) => team(members)
            .iter()
            .position(|member| member.name == name)
            .map(option_id)
            .unwrap_or_else(|| NONE.into()),
        None => NONE.into(),
    }
}

/// Pergunta ao provedor principal. Bloqueante: chamar de `spawn_blocking`.
pub fn route(db: &DbConnection, text: &str, members: &[Member], local: Option<&str>) -> Option<Route> {
    let settings = {
        let conn = db.lock().ok()?;
        config::load(&conn).ok()?
    };
    if !settings.active() || !settings.allows(POINT_ROUTING) {
        return None;
    }
    // Um integrante basta: com o orquestrador, são dois destinos. Sem integrante, não há o que sugerir.
    if text.trim().is_empty() || team(members).is_empty() {
        return None;
    }
    // Só o papel vai ao provedor; o que o detector de segredos marca não sai, qualquer que seja o provedor.
    if memory_secret("", text, None) || team(members).iter().any(|m| memory_secret("", &m.role, None)) {
        return None;
    }
    let api_key = config::load_key();
    route_with(db, &settings, api_key.as_deref(), text, members, local)
}

pub(super) fn route_with(
    db: &DbConnection,
    settings: &config::Settings,
    api_key: Option<&str>,
    text: &str,
    members: &[Member],
    local: Option<&str>,
) -> Option<Route> {
    let local_id = local_option(text, members, local);
    let request = request_for(text, members, &local_id);
    let started = Instant::now();
    let result = http::execute(settings, api_key, &request);
    let latency = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let state_hash = super::protocol::state_hash(&request.state);
    let (decision, error, probability, confidence, input, output) = match &result {
        Ok(response) => {
            let (probability, confidence) = primary_metrics(&response.answers);
            (Some(canonical(&response.answers)), None, probability, confidence, response.input_tokens, response.output_tokens)
        }
        Err(error) => (None, Some(super::protocol::truncate_chars(&error.code(), 300)), None, None, 0, 0),
    };
    if let Ok(conn) = db.lock() {
        let _ = log::record(
            &conn,
            &LogRow {
                ts: now_ts(),
                point: POINT_ROUTING.into(),
                provider: settings.provider.as_str().into(),
                model: settings.provider.coerce_model(&settings.model),
                state_hash,
                heuristic: canonical_labels(&request.heuristic),
                provider_decision: decision.clone(),
                probability,
                confidence,
                latency_ms: Some(latency),
                error,
                input_tokens: Some(input),
                output_tokens: Some(output),
            },
        );
    }
    read_answer(&decision?, members, confidence, probability)
}

#[tauri::command]
pub async fn decision_route_turn(
    db: tauri::State<'_, DbConnection>,
    text: String,
    members: Vec<Member>,
    local: Option<String>,
) -> Result<Option<Route>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || route(&db, &text, &members, local.as_deref()))
        .await
        .map_err(|e| e.to_string())
}
