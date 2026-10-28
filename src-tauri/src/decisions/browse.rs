//! O piloto do navegador: dado um OBJETIVO e o que a página oferece (botões, campos, links), o Jev escolhe a
//! PRÓXIMA OPERAÇÃO (clicar, digitar, escolher numa lista, rolar, esperar, concluir…) e o ELEMENTO dela. É o que
//! `ags portal act` usa, passo a passo, no lugar de um modelo grande que lê a tela inteira a cada passo.
//!
//! Uma só consulta (um só ida e volta de rede) leva duas perguntas: a da OPERAÇÃO e, em paralelo, uma de ALVO para
//! cada operação que precisa de um elemento (`alvo_click`, `alvo_type`, `alvo_select`). Só vale o alvo da operação
//! escolhida; os outros são descartados (é a ideia do "speculative fan-out" do Jev). O texto a digitar NÃO vem do
//! Jev: vem do `--fill` de quem chamou.
//!
//! Diferente da sombra (`shadow.rs`), aqui o Jev AJUDA: o agente pediu a navegação. Por isso as mesmas regras do
//! Vigia (`delivery.rs`) e do roteamento (`routing.rs`):
//!
//! - fica DESLIGADO por padrão (`decisions.point.browser_step`), porque o título, o endereço e os nomes dos
//!   elementos da página saem da máquina;
//! - o que o detector de segredos marca (no estado ou em qualquer opção) NÃO sai: a consulta termina antes de
//!   chamar o provedor;
//! - valores digitados e senhas nunca chegam aqui: só os NOMES dos elementos e se estão preenchidos (o frontend
//!   tira o resto);
//! - as opções têm ids seguros (`e3`, `click`…): o provedor nunca devolve texto livre;
//! - qualquer falha (desligado, sem chave, timeout, opção desconhecida) vira um motivo legível, e quem chamou
//!   devolve a página ao agente para ele decidir;
//! - cada consulta vira uma linha do log (`browser_step`), para medir latência e acerto.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config;
use super::http::{self, CallStats, RetryPolicy};
use super::browse_rules;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_BROWSE};
use super::protocol::{canonical, canonical_labels, truncate_chars, DecisionRequest, Question};

const OPERATION: &str = "operacao";
/// A pergunta direta "o objetivo inteiro já foi atingido?", à parte da operação (sim/não).
const GOAL_DONE: &str = "concluido";
/// Quanto do estado (objetivo, página, elementos, passos já dados) vai ao provedor. Abaixo do teto do Jev.
const STATE_BYTES: usize = 24_000;
/// Quanto de cada rótulo de opção.
const LABEL_CHARS: usize = 110;

/// As operações que precisam de um elemento têm uma pergunta de alvo própria.
const TARGET_OPERATIONS: [&str; 3] = ["click", "type", "select"];

// As regras da pergunta da operação (anúncios, passo satisfeito, quantidade, paginação, modal, formulário) vivem em
// `browse_rules.rs`, versionadas e com teste por regra.

const GOAL_DONE_INSTRUCTIONS: &str = "Is the user's WHOLE goal already visibly satisfied on the CURRENT page? Judge only from what \
the page shows now (the page text, the elements' state) and the recent actions. An action that just ran only counts \
if the page now shows its result. Answer no if any part of the goal is still missing. If the goal was ONLY to OPEN or GO TO an item or page, it is satisfied once the page's title or heading shows that item.";

const TARGET: &str = "Choose the best offered element if the next operation is the one named in this question. \
Use the user's entire goal, the elements' state, nearby page text and the recent actions. This question only chooses \
the element for that operation; another question decides which operation runs. Do not choose a field that is \
already filled, or a checkbox or radio already in the requested state. Choose only an offered element id.";

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOption {
    /// `e3` (o ref do snapshot), `click`, `done`…: um id seguro, nunca texto livre.
    pub id: String,
    /// O que a opção faz, para o Jev ler: `botão "Entrar"`.
    pub label: String,
}

/// O que se pergunta num passo.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepQuery {
    /// O objetivo, a página, o que já foi feito e o texto visível.
    pub state: String,
    /// As operações possíveis neste passo (`click`, `type`, `select`, `scroll`, `wait`, `done`, `stuck`).
    pub operations: Vec<StepOption>,
    /// Os elementos de cada operação que precisa de um (`click`, `type`, `select`).
    #[serde(default)]
    pub targets: BTreeMap<String, Vec<StepOption>>,
    /// Não faz a pergunta direta «o objetivo já foi atingido?»: a última ação não mudou a página, então a resposta seria a
    /// mesma da consulta anterior (plano v2, 4.2). O piloto só usa o `concluido` depois de uma ação que mudou a página.
    #[serde(default)]
    pub skip_goal_done: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReply {
    /// `ok`, `off` (ponto desligado ou sem provedor), `secret` (o detector bloqueou) ou `error`.
    pub status: &'static str,
    /// A operação escolhida.
    pub operation: Option<String>,
    /// O elemento (ref) dela, se a operação tem um.
    pub target: Option<String>,
    /// A probabilidade do passo: a MENOR entre a da operação e a do alvo. É ela que o piloto confere antes de agir.
    pub probability: Option<f64>,
    /// A probabilidade de o objetivo inteiro já estar atingido (a pergunta `concluido`).
    pub goal_done: Option<f64>,
    pub operation_probability: Option<f64>,
    pub target_probability: Option<f64>,
    pub confidence: Option<f64>,
    /// Por que não houve escolha, em português.
    pub reason: Option<String>,
    pub latency_ms: Option<u64>,
    /// O que a consulta custou (plano v2, 4.2): vai ao relatório do `act` para o benchmark medir bytes, tokens e a espera.
    pub cost: Option<QueryCost>,
    /// De quem foi a falha, se houve: `rede`, `provedor` ou `local` (plano v2, 4.3).
    pub fault: Option<&'static str>,
}

/// O custo de uma consulta ao Jev, medido aqui e no cliente HTTP.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCost {
    /// O estado (objetivo, página, elementos, texto) em bytes, já cortado.
    pub state_bytes: usize,
    /// O corpo inteiro enviado (estado + perguntas + opções), em bytes.
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Perguntas na consulta (operação + alvos + `concluido`).
    pub questions: usize,
    /// Opções somadas de todas as perguntas.
    pub options: usize,
    /// A varredura de segredos antes de enviar, em ms.
    pub scan_ms: u64,
    /// Tentativas ao provedor (1 = de primeira) e o que se esperou entre elas.
    pub attempts: u32,
    pub backoff_ms: u64,
    /// O tempo limite da última tentativa (adaptativo).
    pub timeout_ms: u64,
}

impl StepReply {
    fn without_choice(status: &'static str, reason: impl Into<String>) -> Self {
        Self {
            status,
            operation: None,
            target: None,
            probability: None,
            goal_done: None,
            operation_probability: None,
            target_probability: None,
            confidence: None,
            reason: Some(reason.into()),
            latency_ms: None,
            cost: None,
            fault: None,
        }
    }
}

/**
 * O texto de uma página para o detector de segredos: sem os ENDEREÇOS. O caminho de um endereço de loja
 * (`…/Orelhas-Bluetooth-Infantil-COLORIDO-HEADPHONE/dp/B0CGH58XFC`) é longo, de letras e números misturados, e o
 * detector o lia como uma chave — a Amazon inteira era recusada. O estado já leva só origem + caminho (sem consulta nem
 * fragmento, que é onde vão tokens), então o que sai daqui não perde nada que importe. Pura.
 */
pub(super) fn without_addresses(text: &str) -> String {
    use std::sync::OnceLock;
    static ADDRESS: OnceLock<regex::Regex> = OnceLock::new();
    static ARROW: OnceLock<regex::Regex> = OnceLock::new();
    let address = ADDRESS.get_or_init(|| regex::Regex::new(r#"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"')]+"#).unwrap());
    // `link "Nome" → /caminho/longo-do-link`: o destino de um link, que o piloto mostra ao Jev.
    let arrow = ARROW.get_or_init(|| regex::Regex::new(r"→ \S+").unwrap());
    arrow.replace_all(&address.replace_all(text, "<url>"), "→ <path>").into_owned()
}

fn cut(text: &str, max: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Um id que pode ir ao provedor: curto e só `[a-z0-9_]`. Pura.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 16 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// As opções que entram numa pergunta: ids seguros e sem repetição, no máximo `max` (o do provedor). Pura.
fn clean_options(options: &[StepOption], max: usize) -> Vec<(String, String)> {
    let mut seen = BTreeSet::new();
    options
        .iter()
        .filter(|option| safe_id(&option.id) && seen.insert(option.id.clone()))
        .take(max)
        .map(|option| (option.id.clone(), cut(&option.label, LABEL_CHARS)))
        .collect()
}

/// A consulta já limpa: operações e alvos (só das operações oferecidas) com ids seguros. Pura.
#[derive(Clone, Debug, PartialEq)]
pub struct CleanQuery {
    pub state: String,
    pub operations: Vec<(String, String)>,
    pub targets: BTreeMap<String, Vec<(String, String)>>,
    pub skip_goal_done: bool,
}

pub fn clean_query(query: &StepQuery, max: usize) -> CleanQuery {
    let operations = clean_options(&query.operations, max);
    let offered: BTreeSet<&str> = operations.iter().map(|(id, _)| id.as_str()).collect();
    let targets = query
        .targets
        .iter()
        .filter(|(operation, _)| TARGET_OPERATIONS.contains(&operation.as_str()) && offered.contains(operation.as_str()))
        .map(|(operation, options)| (operation.clone(), clean_options(options, max)))
        .filter(|(_, options)| !options.is_empty())
        .collect();
    CleanQuery { state: query.state.clone(), operations, targets, skip_goal_done: query.skip_goal_done }
}

fn target_question_id(operation: &str) -> String {
    format!("alvo_{operation}")
}

/// O pedido ao provedor: a pergunta da operação e uma de alvo por operação que tem elementos. Pura.
pub fn request_for(query: &CleanQuery) -> DecisionRequest {
    fn refs(options: &[(String, String)]) -> Vec<(&str, &str)> {
        options.iter().map(|(id, label)| (id.as_str(), label.as_str())).collect()
    }
    let mut questions = BTreeMap::new();
    questions.insert(OPERATION.to_string(), Question::choice(&browse_rules::next_action(), &refs(&query.operations)));
    for (operation, options) in &query.targets {
        let instructions = format!("{TARGET} Operation: {}.", operation.to_uppercase());
        questions.insert(target_question_id(operation), Question::choice(&instructions, &refs(options)));
    }
    if !query.skip_goal_done {
        questions.insert(
            GOAL_DONE.to_string(),
            Question::choice(GOAL_DONE_INSTRUCTIONS, &[("yes", "The whole goal is already satisfied on this page."), ("no", "Something is still missing.")]),
        );
    }
    let mut heuristic = BTreeMap::new();
    heuristic.insert(OPERATION.to_string(), "nenhum".to_string());
    DecisionRequest { state: truncate_chars(query.state.trim(), STATE_BYTES), questions, model: String::new(), heuristic }
}

/// Lê a resposta: só valem opções oferecidas, e só o alvo da operação escolhida. Pura.
pub fn read_answer(
    answers: &BTreeMap<String, super::protocol::DecisionAnswer>,
    query: &CleanQuery,
) -> Result<(String, Option<String>, Option<f64>, Option<f64>, Option<f64>), String> {
    let operation_answer = answers.get(OPERATION).ok_or("O Jev não respondeu a operação.")?;
    let operation = query
        .operations
        .iter()
        .find(|(id, _)| *id == operation_answer.label)
        .map(|(id, _)| id.clone())
        .ok_or("O Jev respondeu uma operação que não foi oferecida.")?;
    let operation_probability = operation_answer.probability;
    let Some(options) = query.targets.get(&operation) else {
        return Ok((operation, None, operation_probability, None, operation_answer.confidence));
    };
    let target_answer = answers
        .get(&target_question_id(&operation))
        .ok_or("O Jev não respondeu o elemento da operação.")?;
    let target = options
        .iter()
        .find(|(id, _)| *id == target_answer.label)
        .map(|(id, _)| id.clone())
        .ok_or("O Jev respondeu um elemento que não foi oferecido.")?;
    let confidence = match (operation_answer.confidence, target_answer.confidence) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    Ok((operation, Some(target), operation_probability, target_answer.probability, confidence))
}

/**
 * O rótulo gravado no log (`provider_decision`): os rótulos escolhidos e, depois de `|p:`, a probabilidade de CADA pergunta
 * (`operacao=0.90,alvo_click=0.80,concluido=0.07`). O log só guardava a menor delas; sem as outras não dá para calibrar
 * `MIN_PROBABILITY` e `MIN_GOAL_DONE` por pergunta (plano v2, 4.5). A do `concluido` é a do rótulo escolhido. Pura.
 */
pub fn decision_note(answers: &BTreeMap<String, super::protocol::DecisionAnswer>) -> String {
    let probabilities: Vec<String> = answers
        .iter()
        .filter_map(|(id, answer)| answer.probability.map(|p| format!("{id}={p:.2}")))
        .collect();
    if probabilities.is_empty() {
        canonical(answers)
    } else {
        format!("{}|p:{}|r:{}", canonical(answers), probabilities.join(","), browse_rules::rules_tag())
    }
}

/// A probabilidade de "sim" na pergunta direta de objetivo atingido. Com duas opções, "não" com p vale 1 − p para o "sim". Pura.
pub fn goal_done_probability(answers: &BTreeMap<String, super::protocol::DecisionAnswer>) -> Option<f64> {
    let answer = answers.get(GOAL_DONE)?;
    let p = answer.probability?;
    match answer.label.as_str() {
        "yes" => Some(p),
        "no" => Some(1.0 - p),
        _ => None,
    }
}

/// Pergunta ao provedor principal. Bloqueante: chamar de `spawn_blocking`.
pub fn pick(db: &DbConnection, query: &StepQuery) -> StepReply {
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
    let clean = clean_query(query, settings.provider.max_options());
    if clean.operations.len() < 2 {
        return StepReply::without_choice("error", "A página não ofereceu opções suficientes para escolher.");
    }
    // O que o detector de segredos marca não sai, qualquer que seja o provedor.
    let scan_started = Instant::now();
    let labels = clean.operations.iter().chain(clean.targets.values().flatten());
    let secret = memory_secret("", &without_addresses(&clean.state), None)
        || labels.into_iter().any(|(_, label)| memory_secret("", &without_addresses(label), None));
    let scan_ms = millis(scan_started);
    if secret {
        return StepReply::without_choice("secret", "A página tem algo que parece um segredo: não enviei ao provedor.");
    }
    let api_key = config::load_key();
    pick_with(db, &settings, api_key.as_deref(), &clean, scan_ms)
}

fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Quanto uma consulta carregou e custou: bytes (estado e corpo inteiro), tokens, perguntas e opções, e o que o cliente
/// fez (tentativas, espera, prazo). Pura.
fn cost_of(request: &DecisionRequest, stats: &CallStats, response: Option<&super::protocol::DecisionResponse>, scan_ms: u64) -> QueryCost {
    QueryCost {
        state_bytes: request.state.len(),
        request_bytes: stats.bytes_out,
        response_bytes: stats.bytes_in,
        input_tokens: response.map_or(0, |r| r.input_tokens),
        output_tokens: response.map_or(0, |r| r.output_tokens),
        questions: request.questions.len(),
        options: request.questions.values().map(|q| q.option_count()).sum(),
        scan_ms,
        attempts: stats.attempts,
        backoff_ms: stats.backoff_ms,
        timeout_ms: stats.timeout_ms,
    }
}

pub(super) fn pick_with(db: &DbConnection, settings: &config::Settings, api_key: Option<&str>, query: &CleanQuery, scan_ms: u64) -> StepReply {
    let request = request_for(query);
    let started = Instant::now();
    // O piloto é interativo e perde o `act` inteiro se uma consulta falha: aqui o cliente repete (429/503/529, conexão) e adapta o prazo.
    let (result, stats) = http::execute_with(settings, api_key, &request, RetryPolicy::Patient);
    let latency = millis(started);
    let cost = cost_of(&request, &stats, result.as_ref().ok(), scan_ms);
    let fault = result.as_ref().err().map(|error| match error.fault() {
        super::protocol::Fault::Network => "rede",
        super::protocol::Fault::Provider => "provedor",
        super::protocol::Fault::Local => "local",
    });
    let state_hash = super::protocol::state_hash(&request.state);
    let reading = match &result {
        Ok(response) => read_answer(&response.answers, query),
        Err(error) => Err(error.explain(stats.attempts, stats.timeout_ms)),
    };
    let (decision, error, input, output) = match &result {
        Ok(response) => (
            Some(decision_note(&response.answers)),
            reading.as_ref().err().map(|e| truncate_chars(e, 300)),
            response.input_tokens,
            response.output_tokens,
        ),
        Err(error) => (None, Some(truncate_chars(&error.code(), 300)), 0, 0),
    };
    let probability = reading.as_ref().ok().and_then(|(_, _, op, target, _)| match (op, target) {
        (Some(a), Some(b)) => Some(a.min(*b)),
        (a, b) => a.or(*b),
    });
    let confidence = reading.as_ref().ok().and_then(|(_, _, _, _, c)| *c);
    let goal_done = result.as_ref().ok().and_then(|response| goal_done_probability(&response.answers));
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
                error,
                input_tokens: Some(input),
                output_tokens: Some(output),
            },
        );
    }
    match reading {
        Ok((operation, target, operation_probability, target_probability, confidence)) => StepReply {
            status: "ok",
            operation: Some(operation),
            target,
            probability,
            goal_done,
            operation_probability,
            target_probability,
            confidence,
            reason: None,
            latency_ms: Some(latency),
            cost: Some(cost),
            fault: None,
        },
        Err(reason) => StepReply { cost: Some(cost), fault, ..StepReply::without_choice("error", reason) },
    }
}

#[tauri::command]
pub async fn decision_pick_step(db: tauri::State<'_, DbConnection>, query: StepQuery) -> Result<StepReply, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pick(&db, &query))
        .await
        .map_err(|e| e.to_string())
}

/// Abre a conexão com o Jev antes da primeira consulta do `act` (ver `http::preconnect`). Só age com o piloto ligado.
pub fn preconnect(db: &DbConnection) {
    if let Some(settings) = db.lock().ok().and_then(|conn| config::load(&conn).ok()) {
        http::preconnect(&settings);
    }
}

/// Ao abrir o app: espera a base ficar pronta e pré-conecta, para o primeiro `act` não pagar o handshake.
pub fn preconnect_at_start(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || {
        crate::database::wait_until_db_ready();
        let db = app.state::<DbConnection>().inner().clone();
        preconnect(&db);
    });
}

/// O frontend chama no começo de um `act`: a conexão abre enquanto ele lê a primeira página.
#[tauri::command]
pub async fn decision_preconnect(db: tauri::State<'_, DbConnection>) -> Result<(), String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || preconnect(&db)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::decisions::protocol::{DecisionAnswer, MAX_OPTIONS};

    fn option(id: &str, label: &str) -> StepOption {
        StepOption { id: id.into(), label: label.into() }
    }

    fn query() -> StepQuery {
        StepQuery {
            state: "OBJETIVO: entrar".into(),
            operations: vec![option("click", "tocar"), option("type", "digitar"), option("done", "pronto"), option("stuck", "preso")],
            targets: BTreeMap::from([
                ("click".to_string(), vec![option("e1", "botão \"Entrar\""), option("e2", "link \"Ajuda\"")]),
                ("type".to_string(), vec![option("e3", "campo \"E-mail\" (vazio)")]),
                ("select".to_string(), vec![option("e9", "lista \"País\"")]),
            ]),
            skip_goal_done: false,
        }
    }

    fn answer(label: &str, p: f64) -> DecisionAnswer {
        DecisionAnswer { label: label.into(), probability: Some(p), confidence: Some(p) }
    }

    #[test]
    fn so_entram_ids_seguros_sem_repetir_e_ate_o_limite() {
        let mut many: Vec<StepOption> = (0..30).map(|i| option(&format!("e{i}"), "botão")).collect();
        many.insert(0, option("E1; DROP", "mau id"));
        many.insert(1, option("e0", "repetido"));
        let clean = clean_options(&many, MAX_OPTIONS);
        assert_eq!(clean.len(), MAX_OPTIONS);
        assert!(clean.iter().all(|(id, _)| safe_id(id)));
        assert_eq!(clean.iter().filter(|(id, _)| id == "e0").count(), 1);
        assert_eq!(clean_options(&many, 60).len(), 30, "o Jev leva mais que 19");
    }

    #[test]
    fn o_endereco_de_uma_loja_nao_e_um_segredo_mas_uma_chave_de_verdade_continua_sendo() {
        let amazon = "PAGE: \"Fone\" https://www.amazon.com.br/Orelhas-Bluetooth-Infantil-COLORIDO-HEADPHONE-Sem-Fio/dp/B0CGH58XFC\n\
[e7] link \"Fone De Ouvido\" → /Fone-De-Ouvido-Headphone-Sem-Fio-Bluetooth-P47-Micro-SD-FM-Preto/dp/B0CGH58XFCa";
        assert!(memory_secret("", amazon, None), "sem tirar os endereços o detector recusa a página");
        assert!(!memory_secret("", &without_addresses(amazon), None));
        let leaked = "GOAL: entrar\nVISIBLE TEXT: token sk-ant-api03-aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF3hJ5kL7nP9rS1tU3wX5yA7cD9fG1hJ3k";
        assert!(memory_secret("", &without_addresses(leaked), None), "uma chave de verdade no texto continua bloqueada");
        let credentials = "abrir https://user:senha123@exemplo.com/x";
        assert!(without_addresses(credentials).contains("<url>"));
    }

    #[test]
    fn o_rotulo_e_uma_linha_curta() {
        let long = format!("botão\n\n  \"{}\"", "x".repeat(300));
        let clean = clean_options(&[option("e1", &long)], MAX_OPTIONS);
        assert!(!clean[0].1.contains('\n'));
        assert!(clean[0].1.chars().count() <= LABEL_CHARS);
    }

    #[test]
    fn alvo_so_para_operacao_oferecida_e_com_elementos() {
        let clean = clean_query(&query(), 60);
        // `select` tem elementos mas a operação não foi oferecida: fica de fora.
        assert_eq!(clean.targets.keys().map(String::as_str).collect::<Vec<_>>(), ["click", "type"]);
    }

    #[test]
    fn o_pedido_leva_a_pergunta_da_operacao_e_uma_de_alvo_por_operacao() {
        let request = request_for(&clean_query(&query(), 60));
        let ids: Vec<&str> = request.questions.keys().map(String::as_str).collect();
        assert_eq!(ids, ["alvo_click", "alvo_type", "concluido", "operacao"]);
        assert_eq!(request.questions["operacao"].option_count(), 4);
        assert_eq!(request.questions["alvo_click"].option_count(), 2);
        assert_eq!(request.heuristic["operacao"], "nenhum");
    }

    #[test]
    fn sem_o_concluido_quando_a_ultima_acao_nao_mudou_a_pagina() {
        // 4.2 (D2): a pergunta direta custa uma cabeça por consulta; o piloto só usa a resposta depois de uma ação que mudou a página.
        let mut skipped = query();
        skipped.skip_goal_done = true;
        let clean = clean_query(&skipped, 60);
        assert!(clean.skip_goal_done);
        let request = request_for(&clean);
        let ids: Vec<&str> = request.questions.keys().map(String::as_str).collect();
        assert_eq!(ids, ["alvo_click", "alvo_type", "operacao"]);
        let with = request_for(&clean_query(&query(), 60));
        assert_eq!(with.questions.len(), request.questions.len() + 1);
    }

    #[test]
    fn o_custo_conta_bytes_perguntas_opcoes_e_tokens() {
        let request = request_for(&clean_query(&query(), 60));
        let stats = CallStats { attempts: 2, bytes_out: 1234, bytes_in: 321, backoff_ms: 250, timeout_ms: 3000 };
        let response = super::super::protocol::DecisionResponse {
            answers: BTreeMap::new(),
            input_tokens: 400,
            output_tokens: 6,
            model: "jev".into(),
        };
        let cost = cost_of(&request, &stats, Some(&response), 7);
        assert_eq!((cost.request_bytes, cost.response_bytes, cost.attempts, cost.backoff_ms), (1234, 321, 2, 250));
        assert_eq!((cost.input_tokens, cost.output_tokens, cost.scan_ms, cost.timeout_ms), (400, 6, 7, 3000));
        assert_eq!(cost.questions, 4);
        // operação (4) + alvo_click (2) + alvo_type (1) + concluido (2)
        assert_eq!(cost.options, 9);
        assert_eq!(cost.state_bytes, request.state.len());
        // Falhou antes de haver resposta: sem tokens.
        assert_eq!(cost_of(&request, &stats, None, 0).input_tokens, 0);
    }

    #[test]
    fn so_vale_o_alvo_da_operacao_escolhida() {
        let clean = clean_query(&query(), 60);
        // O Jev responde todas as cabeças; só a de `type` conta quando a operação é `type`.
        let answers = BTreeMap::from([
            ("operacao".to_string(), answer("type", 0.9)),
            ("alvo_click".to_string(), answer("e1", 0.99)),
            ("alvo_type".to_string(), answer("e3", 0.8)),
        ]);
        let (operation, target, op_p, target_p, _) = read_answer(&answers, &clean).unwrap();
        assert_eq!((operation.as_str(), target.as_deref()), ("type", Some("e3")));
        assert_eq!((op_p, target_p), (Some(0.9), Some(0.8)));
    }

    #[test]
    fn o_log_guarda_a_probabilidade_de_cada_pergunta() {
        let answers = BTreeMap::from([
            ("operacao".to_string(), answer("click", 0.9)),
            ("alvo_click".to_string(), answer("e4", 0.8)),
            ("concluido".to_string(), answer("no", 0.93)),
        ]);
        assert_eq!(decision_note(&answers), format!("alvo_click=e4;concluido=no;operacao=click|p:alvo_click=0.80,concluido=0.93,operacao=0.90|r:{}", browse_rules::rules_tag()));
        let bare = BTreeMap::from([("operacao".to_string(), DecisionAnswer { label: "done".into(), probability: None, confidence: None })]);
        assert_eq!(decision_note(&bare), "operacao=done", "sem probabilidade, o rótulo de sempre");
    }

    #[test]
    fn a_pergunta_direta_de_objetivo_atingido_vira_a_probabilidade_do_sim() {
        let yes = BTreeMap::from([("concluido".to_string(), answer("yes", 0.93))]);
        assert_eq!(goal_done_probability(&yes), Some(0.93));
        let no = BTreeMap::from([("concluido".to_string(), answer("no", 0.9))]);
        let p = goal_done_probability(&no).unwrap();
        assert!((p - 0.1).abs() < 1e-9);
        assert_eq!(goal_done_probability(&BTreeMap::new()), None);
        let odd = BTreeMap::from([("concluido".to_string(), answer("talvez", 0.5))]);
        assert_eq!(goal_done_probability(&odd), None);
    }

    #[test]
    fn operacao_sem_elemento_nao_pede_alvo() {
        let clean = clean_query(&query(), 60);
        let answers = BTreeMap::from([("operacao".to_string(), answer("done", 0.95))]);
        let (operation, target, _, target_p, _) = read_answer(&answers, &clean).unwrap();
        assert_eq!((operation.as_str(), target, target_p), ("done", None, None));
    }

    #[test]
    fn resposta_fora_do_oferecido_e_erro() {
        let clean = clean_query(&query(), 60);
        let unknown_operation = BTreeMap::from([("operacao".to_string(), answer("rm -rf", 0.9))]);
        assert!(read_answer(&unknown_operation, &clean).is_err());
        let unknown_target = BTreeMap::from([
            ("operacao".to_string(), answer("click", 0.9)),
            ("alvo_click".to_string(), answer("e77", 0.9)),
        ]);
        assert!(read_answer(&unknown_target, &clean).is_err());
        let missing_target = BTreeMap::from([("operacao".to_string(), answer("click", 0.9))]);
        assert!(read_answer(&missing_target, &clean).is_err());
    }
}
