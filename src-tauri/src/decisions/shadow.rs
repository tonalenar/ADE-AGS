//! A consulta sombra não devolve nada para quem decidiu. Falha e timeout só vão ao log.

use std::time::Instant;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config::{self, Settings};
use super::http::{self, DecisionProvider, HeuristicProvider};
use super::log::{self, LogRow};
use super::protocol::{
    DecisionError, DecisionRequest, DecisionResponse, canonical, canonical_labels, primary_metrics,
    state_hash,
};

#[derive(Clone, Debug)]
pub struct ShadowJob {
    pub point: &'static str,
    pub state: String,
    pub request: DecisionRequest,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShadowOutcome {
    /// O que a chamada real continua usando: sempre a heurística.
    pub returned: String,
    pub provider_decision: Option<String>,
    pub error: Option<String>,
    pub probability: Option<f64>,
    pub confidence: Option<f64>,
    pub latency_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub state_hash: String,
}

/// Combina os dois lados. O valor devolvido ao produto é a heurística, com o provedor
/// falhando, estourando o tempo ou discordando.
pub fn evaluate(
    job: &ShadowJob,
    provider: Result<DecisionResponse, DecisionError>,
    latency_ms: i64,
) -> ShadowOutcome {
    let returned = canonical_labels(&job.request.heuristic);
    match provider {
        Ok(response) => {
            let (probability, confidence) = primary_metrics(&response.answers);
            ShadowOutcome {
                returned,
                provider_decision: Some(canonical(&response.answers)),
                error: None,
                probability,
                confidence,
                latency_ms,
                input_tokens: response.input_tokens,
                output_tokens: response.output_tokens,
                state_hash: state_hash(&job.state),
            }
        }
        Err(error) => ShadowOutcome {
            returned,
            provider_decision: None,
            error: Some(clip(&redact(&error.code(), None))),
            probability: None,
            confidence: None,
            latency_ms,
            input_tokens: 0,
            output_tokens: 0,
            state_hash: state_hash(&job.state),
        },
    }
}

pub fn redact(text: &str, secret: Option<&str>) -> String {
    let Some(secret) = secret.filter(|value| value.len() >= 8) else {
        return text.to_string();
    };
    text.replace(secret, "[redacted]")
        .replace(&format!("Bearer {secret}"), "Bearer [redacted]")
}

pub fn enqueue(db: DbConnection, jobs: Vec<ShadowJob>) {
    if jobs.is_empty() {
        return;
    }
    let proceed = match db.lock() {
        Ok(conn) => config::load(&conn).ok().is_some_and(|settings| {
            settings.active() && jobs.iter().any(|job| settings.allows(job.point))
        }),
        Err(_) => false,
    };
    if !proceed {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let joined = tauri::async_runtime::spawn_blocking(move || run_jobs(db, jobs)).await;
        if let Err(error) = joined {
            eprintln!("decision shadow: tarefa de fundo encerrada ({error})");
        }
    });
}

pub fn run_jobs(db: DbConnection, jobs: Vec<ShadowJob>) {
    let Ok(conn) = db.lock() else { return };
    let Ok(settings) = config::load(&conn) else {
        return;
    };
    if !settings.active() {
        return;
    }
    drop(conn);
    run_jobs_with(db, jobs, &settings, config::load_key());
}

pub(crate) fn run_jobs_with(
    db: DbConnection,
    jobs: Vec<ShadowJob>,
    settings: &Settings,
    api_key: Option<String>,
) {
    for job in jobs {
        if !settings.allows(job.point) {
            continue;
        }
        let hash = state_hash(&job.state);
        let seen = db
            .lock()
            .ok()
            .and_then(|conn| log::recent(&conn, job.point, &hash, now_ts()).ok())
            .unwrap_or(false);
        if seen {
            continue;
        }
        let started = Instant::now();
        let provider = http::execute(settings, api_key.as_deref(), &job.request);
        let latency = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        let mut outcome = evaluate(&job, provider, latency);
        if let Ok(heuristic) = HeuristicProvider.decide(&job.request) {
            outcome.returned = canonical(&heuristic.answers);
        }
        if let Ok(conn) = db.lock() {
            let _ = log::record(
                &conn,
                &row_for(settings, &job, &outcome, api_key.as_deref()),
            );
        }
    }
}

fn row_for(
    settings: &Settings,
    job: &ShadowJob,
    outcome: &ShadowOutcome,
    secret: Option<&str>,
) -> LogRow {
    LogRow {
        ts: now_ts(),
        point: job.point.to_string(),
        provider: settings.provider.as_str().to_string(),
        model: settings.model.clone(),
        state_hash: outcome.state_hash.clone(),
        heuristic: redact(&outcome.returned, secret),
        provider_decision: outcome
            .provider_decision
            .as_deref()
            .map(|value| redact(value, secret)),
        probability: outcome.probability,
        confidence: outcome.confidence,
        latency_ms: Some(outcome.latency_ms),
        error: outcome.error.as_deref().map(|value| redact(value, secret)),
        input_tokens: Some(outcome.input_tokens),
        output_tokens: Some(outcome.output_tokens),
    }
}

fn clip(text: &str) -> String {
    super::protocol::truncate_chars(text, 300)
}
