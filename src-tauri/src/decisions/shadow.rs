//! A consulta sombra não devolve nada para quem decidiu. Falha e timeout só vão ao log.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
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
    /// O detector de segredos do app marcou este texto. Com um provedor fora desta máquina,
    /// ele não é enviado.
    pub sensitive: bool,
    /// O que separa duas ocorrências de um mesmo `state` (a missão, por exemplo). Entra só no
    /// hash: o provedor continua recebendo exatamente o que a heurística viu.
    pub identity: Option<String>,
    pub request: DecisionRequest,
}

impl ShadowJob {
    pub fn hash(&self) -> String {
        match &self.identity {
            Some(identity) => state_hash(&format!("{identity}\n{}", self.state)),
            None => state_hash(&self.state),
        }
    }
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
                state_hash: job.hash(),
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
            state_hash: job.hash(),
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

/// Teto da fila. É amostra, não auditoria: se o provedor engasga, o que passa do teto é
/// descartado em vez de acumular tarefas de fundo.
const QUEUE_CAP: usize = 128;

pub(crate) struct Queued {
    db: DbConnection,
    job: ShadowJob,
    hash: String,
}

/// Uma fila e um trabalhador só. O agendador chama a cada tick e a tela de revisão a cada
/// abertura: sem isto, um provedor lento empilharia uma tarefa de fundo por chamada.
pub(crate) struct Queue {
    items: VecDeque<Queued>,
    draining: bool,
}

impl Queue {
    pub(crate) const fn new() -> Self {
        Self {
            items: VecDeque::new(),
            draining: false,
        }
    }

    /// Põe na fila o que ainda não está nela (mesmo ponto, mesmo hash, mesmo banco).
    /// Devolve `true` quando alguém precisa começar a drenar.
    pub(crate) fn push(&mut self, db: &DbConnection, jobs: Vec<ShadowJob>, cap: usize) -> bool {
        for job in jobs {
            if self.items.len() >= cap {
                break;
            }
            let hash = job.hash();
            let twin = self.items.iter().any(|item| {
                item.job.point == job.point && item.hash == hash && Arc::ptr_eq(&item.db, db)
            });
            if !twin {
                self.items.push_back(Queued {
                    db: db.clone(),
                    job,
                    hash,
                });
            }
        }
        if self.items.is_empty() || self.draining {
            return false;
        }
        self.draining = true;
        true
    }

    /// Tudo o que está esperando, de uma vez. Vazio, encerra o trabalhador.
    pub(crate) fn take(&mut self) -> Vec<Queued> {
        if self.items.is_empty() {
            self.draining = false;
        }
        self.items.drain(..).collect()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
}

static QUEUE: Mutex<Queue> = Mutex::new(Queue::new());

fn drain(queue: &'static Mutex<Queue>) {
    // Se o trabalhador cair no meio, a próxima chamada precisa poder começar outro.
    struct Reset(&'static Mutex<Queue>);
    impl Drop for Reset {
        fn drop(&mut self) {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).draining = false;
        }
    }
    let _reset = Reset(queue);
    loop {
        let batch = queue.lock().unwrap_or_else(|e| e.into_inner()).take();
        if batch.is_empty() {
            return;
        }
        run_batch(batch);
    }
}

fn run_batch(batch: Vec<Queued>) {
    let mut batch = batch.into_iter().peekable();
    while let Some(first) = batch.next() {
        let db = first.db;
        let mut jobs = vec![first.job];
        while let Some(next) = batch.next_if(|item| Arc::ptr_eq(&item.db, &db)) {
            jobs.push(next.job);
        }
        run_jobs(db, jobs);
    }
}

pub fn enqueue(db: DbConnection, jobs: Vec<ShadowJob>) {
    if jobs.is_empty() {
        return;
    }
    let jobs: Vec<ShadowJob> = match db.lock() {
        Ok(conn) => {
            let mut verdicts: Vec<(&'static str, bool)> = Vec::new();
            jobs.into_iter()
                .filter(|job| {
                    if let Some((_, on)) = verdicts.iter().find(|(point, _)| *point == job.point) {
                        return *on;
                    }
                    let on = config::point_active(&conn, job.point);
                    verdicts.push((job.point, on));
                    on
                })
                .collect()
        }
        Err(_) => Vec::new(),
    };
    if jobs.is_empty() {
        return;
    }
    let start = QUEUE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(&db, jobs, QUEUE_CAP);
    if !start {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let joined = tauri::async_runtime::spawn_blocking(|| drain(&QUEUE)).await;
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
    let secondary_key = settings
        .secondary
        .is_some()
        .then(|| config::load_key_in(config::KeySlot::Secondary))
        .flatten();
    run_jobs_with_keys(db, jobs, &settings, config::load_key(), secondary_key);
}

#[cfg(test)]
pub(crate) fn run_jobs_with(
    db: DbConnection,
    jobs: Vec<ShadowJob>,
    settings: &Settings,
    api_key: Option<String>,
) {
    run_jobs_with_keys(db, jobs, settings, api_key, None);
}

/// Cada proposta vai para TODOS os destinos (o principal e o segundo, se houver) e cada resposta
/// vira uma linha própria do log, com o provedor: é isso que permite comparar os dois na mesma
/// proposta. O texto marcado como segredo não vai para um destino fora desta máquina.
pub(crate) fn run_jobs_with_keys(
    db: DbConnection,
    jobs: Vec<ShadowJob>,
    settings: &Settings,
    primary_key: Option<String>,
    secondary_key: Option<String>,
) {
    let targets: Vec<(Settings, Option<String>, bool)> = settings
        .endpoints()
        .iter()
        .enumerate()
        .map(|(index, endpoint)| {
            (
                settings.with_endpoint(endpoint),
                if index == 0 { primary_key.clone() } else { secondary_key.clone() },
                endpoint.sends_off_machine(),
            )
        })
        .collect();
    for job in jobs {
        if !settings.allows(job.point) {
            continue;
        }
        let hash = job.hash();
        for (target, api_key, off_machine) in &targets {
            if job.sensitive && *off_machine {
                continue;
            }
            let seen = db
                .lock()
                .ok()
                .and_then(|conn| {
                    log::recent(&conn, job.point, &hash, target.provider.as_str(), now_ts()).ok()
                })
                .unwrap_or(false);
            if seen {
                continue;
            }
            let started = Instant::now();
            let provider = http::execute(target, api_key.as_deref(), &job.request);
            let latency = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
            let mut outcome = evaluate(&job, provider, latency);
            if let Ok(heuristic) = HeuristicProvider.decide(&job.request) {
                outcome.returned = canonical(&heuristic.answers);
            }
            if let Ok(conn) = db.lock() {
                let _ = log::record(
                    &conn,
                    &row_for(target, &job, &outcome, api_key.as_deref()),
                );
            }
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
        model: settings.provider.coerce_model(&settings.model),
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
