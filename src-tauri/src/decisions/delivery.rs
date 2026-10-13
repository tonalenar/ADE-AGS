//! O Jev diz se uma mensagem ao Orquestrador é o RELATÓRIO FINAL de um integrante, só andamento, uma
//! pergunta ou conversa. É o único ponto em que o provedor AJUDA uma decisão (a do Vigia: "este
//! integrante já entregou?"), então:
//!
//! - fica DESLIGADO por padrão (`decisions.point.delivery_gate`), com aviso na tela de Ajustes;
//! - o texto sai da máquina: só os primeiros `MAX_CHARS` caracteres, e nada que o detector de segredos
//!   marque;
//! - qualquer falha (desligado, sem chave, timeout, resposta estranha) devolve `None` e o Vigia segue
//!   com a regra local (`isFinalReport`);
//! - cada consulta vira uma linha do log (`delivery_gate`) com o rótulo da regra local ao lado, para medir
//!   quem acerta.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::Serialize;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config;
use super::http;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_DELIVERY};
use super::protocol::{canonical, canonical_labels, primary_metrics, DecisionRequest, Question};

/// Quanto da mensagem vai ao provedor: o começo de um relatório já diz se é final.
pub const MAX_CHARS: usize = 600;

/// Os rótulos que a pergunta aceita.
const LABELS: [&str; 4] = ["final", "andamento", "pergunta", "conversa"];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportClass {
    pub label: String,
    pub confidence: Option<f64>,
}

fn questions() -> BTreeMap<String, Question> {
    let mut map = BTreeMap::new();
    map.insert(
        "tipo".into(),
        Question::choice(
            "Um integrante de uma equipe de agentes mandou esta mensagem ao orquestrador. O que ela é?",
            &[
                ("final", "relatório final: o integrante terminou a tarefa e reporta resultado, arquivos ou testes"),
                ("andamento", "andamento: ainda está trabalhando, recebeu a tarefa ou promete voltar depois"),
                ("pergunta", "pergunta ou pedido ao orquestrador"),
                ("conversa", "confirmação, agradecimento ou conversa sem resultado"),
            ],
        ),
    );
    map
}

/// O texto que vai ao provedor: só o começo, sem quebra de linha repetida. Pura.
pub fn clip_text(text: &str) -> String {
    let cleaned = text.trim();
    let mut out: String = cleaned.chars().take(MAX_CHARS).collect();
    if cleaned.chars().count() > MAX_CHARS {
        out.push('…');
    }
    out
}

/// O pedido ao provedor. `local` é o rótulo da regra local (`final`/`andamento`…), que vai ao log para comparar. Pura.
pub fn request_for(text: &str, local: &str) -> DecisionRequest {
    let mut heuristic = BTreeMap::new();
    heuristic.insert("tipo".into(), local.to_string());
    DecisionRequest { state: clip_text(text), questions: questions(), model: String::new(), heuristic }
}

/// Lê a resposta do provedor: só vale um rótulo conhecido. Pura.
pub fn read_answer(canonical_answer: &str, confidence: Option<f64>) -> Option<ReportClass> {
    let label = canonical_answer.split(';').find_map(|pair| pair.strip_prefix("tipo="))?;
    LABELS.contains(&label).then(|| ReportClass { label: label.to_string(), confidence })
}

/// Pergunta ao provedor principal. Bloqueante: chamar de `spawn_blocking`.
pub fn classify(db: &DbConnection, text: &str, local: &str) -> Option<ReportClass> {
    let settings = {
        let conn = db.lock().ok()?;
        config::load(&conn).ok()?
    };
    if !settings.active() || !settings.allows(POINT_DELIVERY) {
        return None;
    }
    // O que o detector de segredos marca não sai, qualquer que seja o provedor.
    if memory_secret("", text, None) {
        return None;
    }
    let api_key = config::load_key();
    classify_with(db, &settings, api_key.as_deref(), text, local)
}

pub(super) fn classify_with(
    db: &DbConnection,
    settings: &config::Settings,
    api_key: Option<&str>,
    text: &str,
    local: &str,
) -> Option<ReportClass> {
    let request = request_for(text, local);
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
                point: POINT_DELIVERY.into(),
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
    read_answer(&decision?, confidence)
}

#[tauri::command]
pub async fn decision_classify_report(
    db: tauri::State<'_, DbConnection>,
    text: String,
    local: String,
) -> Result<Option<ReportClass>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || classify(&db, &text, &local))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_o_comeco_do_texto_vai_ao_provedor() {
        assert_eq!(clip_text("  curto  "), "curto");
        let long = "a".repeat(MAX_CHARS + 40);
        let clipped = clip_text(&long);
        assert_eq!(clipped.chars().count(), MAX_CHARS + 1);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn o_pedido_leva_a_pergunta_e_o_rotulo_da_regra_local() {
        let request = request_for("Backend: corrigi A1, commit abc, testes verdes.", "final");
        assert_eq!(request.heuristic.get("tipo").map(String::as_str), Some("final"));
        assert!(request.questions.contains_key("tipo"));
        assert!(request.state.starts_with("Backend: corrigi A1"));
    }

    #[test]
    fn so_vale_um_rotulo_conhecido() {
        assert_eq!(read_answer("tipo=final", Some(0.9)), Some(ReportClass { label: "final".into(), confidence: Some(0.9) }));
        assert_eq!(read_answer("tipo=andamento", None).map(|c| c.label), Some("andamento".into()));
        assert_eq!(read_answer("tipo=talvez", Some(0.9)), None);
        assert_eq!(read_answer("outra=final", None), None);
        assert_eq!(read_answer("", None), None);
    }
}
