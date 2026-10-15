//! O piloto do navegador: dado um OBJETIVO e o que a página oferece (botões, campos, links), o Jev escolhe o
//! PRÓXIMO elemento a tocar. É o que `ags portal act` usa, passo a passo, no lugar de um modelo grande que
//! lê a tela inteira a cada passo: a escolha entre ≤19 opções é exatamente o que o Jev faz em milissegundos.
//!
//! Diferente da sombra (`shadow.rs`), aqui o Jev AJUDA: o agente pediu a navegação. Por isso as mesmas regras do
//! Vigia (`delivery.rs`) e do roteamento (`routing.rs`):
//!
//! - fica DESLIGADO por padrão (`decisions.point.browser_step`), porque o título, o endereço e os nomes dos
//!   elementos da página saem da máquina;
//! - o que o detector de segredos marca (no objetivo, no estado ou em qualquer opção) NÃO sai: a consulta
//!   termina antes de chamar o provedor;
//! - valores digitados e senhas nunca chegam aqui: só os NOMES dos elementos (o frontend os tira);
//! - as opções têm ids seguros (`e3`, `done`…): o provedor nunca devolve texto livre;
//! - qualquer falha (desligado, sem chave, timeout, opção desconhecida) vira um motivo legível, e quem chamou
//!   devolve a página ao agente para ele decidir;
//! - cada consulta vira uma linha do log (`browser_step`), para medir latência e acerto.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config;
use super::http;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_BROWSE};
use super::protocol::{
    canonical, canonical_labels, primary_metrics, truncate_chars, DecisionRequest, Question, MAX_OPTIONS,
};

const QUESTION: &str = "passo";
/// Quanto do estado (objetivo, página, passos já dados) vai ao provedor. Abaixo do teto do Jev.
const STATE_BYTES: usize = 12_000;
/// Quanto de cada rótulo de opção.
const LABEL_CHARS: usize = 90;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOption {
    /// `e3` (o ref do snapshot), `done`, `scroll`, `stuck`…: um id seguro, nunca texto livre.
    pub id: String,
    /// O que a opção faz, para o Jev ler: `botão "Entrar"`.
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReply {
    /// `ok`, `off` (ponto desligado ou sem provedor), `secret` (o detector bloqueou) ou `error`.
    pub status: &'static str,
    pub choice: Option<String>,
    /// A probabilidade da opção escolhida: é ela que o piloto confere antes de agir.
    pub probability: Option<f64>,
    pub confidence: Option<f64>,
    /// Por que não houve escolha, em português.
    pub reason: Option<String>,
    pub latency_ms: Option<u64>,
}

impl StepReply {
    fn without_choice(status: &'static str, reason: impl Into<String>) -> Self {
        Self { status, choice: None, probability: None, confidence: None, reason: Some(reason.into()), latency_ms: None }
    }
}

fn cut(text: &str, max: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Um id que pode ir ao provedor: curto e só `[a-z0-9_]`. Pura.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 16 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// As opções que entram na pergunta: ids seguros e sem repetição, no máximo `MAX_OPTIONS`. Pura.
fn clean_options(options: &[StepOption]) -> Vec<(String, String)> {
    let mut seen = std::collections::BTreeSet::new();
    options
        .iter()
        .filter(|option| safe_id(&option.id) && seen.insert(option.id.clone()))
        .take(MAX_OPTIONS)
        .map(|option| (option.id.clone(), cut(&option.label, LABEL_CHARS)))
        .collect()
}

/// O pedido ao provedor. Pura.
pub fn request_for(state: &str, options: &[(String, String)]) -> DecisionRequest {
    let refs: Vec<(&str, &str)> = options.iter().map(|(id, label)| (id.as_str(), label.as_str())).collect();
    let mut questions = BTreeMap::new();
    questions.insert(
        QUESTION.into(),
        Question::choice(
            "Qual é o próximo passo para atingir o objetivo nesta página? Escolha 'done' só se o objetivo já foi atingido, e 'stuck' se nenhuma opção leva a ele.",
            &refs,
        ),
    );
    let mut heuristic = BTreeMap::new();
    heuristic.insert(QUESTION.into(), "nenhum".into());
    DecisionRequest { state: truncate_chars(state.trim(), STATE_BYTES), questions, model: String::new(), heuristic }
}

/// Lê a resposta: só vale uma das opções oferecidas. Pura.
pub fn read_choice(chosen: &str, options: &[(String, String)]) -> Option<String> {
    options.iter().find(|(id, _)| id == chosen).map(|(id, _)| id.clone())
}

/// Pergunta ao provedor principal. Bloqueante: chamar de `spawn_blocking`.
pub fn pick(db: &DbConnection, state: &str, options: &[StepOption]) -> StepReply {
    let settings = match db.lock().ok().and_then(|conn| config::load(&conn).ok()) {
        Some(settings) => settings,
        None => return StepReply::without_choice("error", "Não consegui ler os ajustes de Decisões."),
    };
    if !settings.active() || !settings.allows(POINT_BROWSE) {
        return StepReply::without_choice(
            "off",
            "O Jev não está pilotando navegadores: ligue em Ajustes → Decisões (Navegador do canvas).",
        );
    }
    let options = clean_options(options);
    if options.len() < 2 {
        return StepReply::without_choice("error", "A página não ofereceu opções suficientes para escolher.");
    }
    // O que o detector de segredos marca não sai, qualquer que seja o provedor.
    if memory_secret("", state, None) || options.iter().any(|(_, label)| memory_secret("", label, None)) {
        return StepReply::without_choice("secret", "A página tem algo que parece um segredo: não enviei ao provedor.");
    }
    let api_key = config::load_key();
    pick_with(db, &settings, api_key.as_deref(), state, &options)
}

pub(super) fn pick_with(
    db: &DbConnection,
    settings: &config::Settings,
    api_key: Option<&str>,
    state: &str,
    options: &[(String, String)],
) -> StepReply {
    let request = request_for(state, options);
    let started = Instant::now();
    let result = http::execute(settings, api_key, &request);
    let latency = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let state_hash = super::protocol::state_hash(&request.state);
    let (decision, error, probability, confidence, input, output) = match &result {
        Ok(response) => {
            let (probability, confidence) = primary_metrics(&response.answers);
            (Some(canonical(&response.answers)), None, probability, confidence, response.input_tokens, response.output_tokens)
        }
        Err(error) => (None, Some(truncate_chars(&error.code(), 300)), None, None, 0, 0),
    };
    if let Ok(conn) = db.lock() {
        let _ = log::record(
            &conn,
            &LogRow {
                ts: now_ts(),
                point: POINT_BROWSE.into(),
                provider: settings.provider.as_str().into(),
                model: settings.provider.coerce_model(&settings.model),
                state_hash,
                heuristic: canonical_labels(&request.heuristic),
                provider_decision: decision,
                probability,
                confidence,
                latency_ms: Some(i64::try_from(latency).unwrap_or(i64::MAX)),
                error: error.clone(),
                input_tokens: Some(input),
                output_tokens: Some(output),
            },
        );
    }
    match result {
        Ok(response) => {
            let chosen = response.answers.get(QUESTION).and_then(|answer| read_choice(&answer.label, options));
            match chosen {
                Some(choice) => StepReply {
                    status: "ok",
                    choice: Some(choice),
                    probability,
                    confidence,
                    reason: None,
                    latency_ms: Some(latency),
                },
                None => StepReply::without_choice("error", "O Jev respondeu algo que não é uma das opções."),
            }
        }
        Err(error) => StepReply::without_choice("error", format!("O Jev não respondeu ({}).", error.code())),
    }
}

#[tauri::command]
pub async fn decision_pick_step(
    db: tauri::State<'_, DbConnection>,
    state: String,
    options: Vec<StepOption>,
) -> Result<StepReply, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pick(&db, &state, &options))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod test {
    use super::*;

    fn option(id: &str, label: &str) -> StepOption {
        StepOption { id: id.into(), label: label.into() }
    }

    #[test]
    fn so_entram_ids_seguros_sem_repetir_e_ate_o_limite() {
        let mut many: Vec<StepOption> = (0..30).map(|i| option(&format!("e{i}"), "botão")).collect();
        many.insert(0, option("E1; DROP", "mau id"));
        many.insert(1, option("e0", "repetido"));
        let clean = clean_options(&many);
        assert_eq!(clean.len(), MAX_OPTIONS);
        assert!(clean.iter().all(|(id, _)| safe_id(id)));
        assert_eq!(clean.iter().filter(|(id, _)| id == "e0").count(), 1);
    }

    #[test]
    fn o_rotulo_e_uma_linha_curta() {
        let long = format!("botão\n\n  \"{}\"", "x".repeat(300));
        let clean = clean_options(&[option("e1", &long)]);
        assert!(!clean[0].1.contains('\n'));
        assert!(clean[0].1.chars().count() <= LABEL_CHARS);
    }

    #[test]
    fn o_pedido_tem_uma_pergunta_de_escolha_com_as_opcoes() {
        let options = vec![("e1".to_string(), "botão \"Entrar\"".to_string()), ("done".to_string(), "pronto".to_string())];
        let request = request_for("OBJETIVO: entrar", &options);
        assert_eq!(request.questions.len(), 1);
        assert_eq!(request.questions[QUESTION].option_count(), 2);
        assert_eq!(request.heuristic[QUESTION], "nenhum");
    }

    #[test]
    fn a_resposta_so_vale_se_for_uma_das_opcoes() {
        let options = vec![("e1".to_string(), "a".to_string()), ("done".to_string(), "b".to_string())];
        assert_eq!(read_choice("e1", &options).as_deref(), Some("e1"));
        assert_eq!(read_choice("e9", &options), None);
        assert_eq!(read_choice("click everything", &options), None);
    }
}
