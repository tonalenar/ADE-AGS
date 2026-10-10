//! Pontos de sombra. Cada um lê uma função que já decide e não substitui o retorno dela.

use std::collections::BTreeMap;

use crate::database::DbConnection;
use crate::memory::agent::looks_like_user_secret;
use crate::memory::dream::DreamReview;
use crate::memory::review::{MemoryReviewSummary, WorkspaceReviewSummary};
use crate::missions::delivery::{MissionDelivery, mission_status};
use crate::runs::types::{Run, Task};

use rusqlite::Connection;

use super::config;
use super::protocol::{DecisionRequest, Question, truncate_chars};
use super::shadow::{ShadowJob, enqueue};

pub const POINT_MEMORY: &str = "memory_approval";
pub const POINT_DREAM: &str = "dream_triage";
pub const POINT_FLEET: &str = "fleet_gate";
pub const POINT_MISSION: &str = "mission_gate";

/// Rótulos que a pergunta aceita mas que a heurística do ponto nunca devolve. O relatório os
/// separa: um "desacordo" aí não é erro de ninguém, é o provedor dizendo algo que o código
/// não tem como dizer.
pub fn blind_labels(point: &str, question: &str) -> &'static [&'static str] {
    match (point, question) {
        (POINT_MEMORY, "acao") => &["aprovar"],
        (POINT_DREAM, "triagem") => &["descartar"],
        _ => &[],
    }
}

/// Duplicata sem outro sinal → `rejeitar` (a aprovação em massa deixa essas de fora).
/// Contradição, exclusão, segredo ou o resto → `revisar`. Não existe aprovação automática.
pub fn memory_choice(
    duplicate: bool,
    contradiction: bool,
    deletion: bool,
    secret: bool,
) -> &'static str {
    if duplicate && !contradiction && !deletion && !secret {
        "rejeitar"
    } else {
        "revisar"
    }
}

pub fn memory_secret(key: &str, body: &str, reason: Option<&str>) -> bool {
    looks_like_user_secret(key)
        || looks_like_user_secret(body)
        || reason.is_some_and(looks_like_user_secret)
}

/// O detector de duplicata da revisão vira `juntar`. O código não escolhe `descartar`.
pub fn dream_choice(duplicate: bool) -> &'static str {
    if duplicate { "juntar" } else { "manter" }
}

/// O balde de `scheduler::decide`: lançar, pular ou esperar.
pub fn fleet_label(id: &str, launch: &[String], skip: &[(String, String)]) -> &'static str {
    if launch.iter().any(|item| item == id) {
        "lancar"
    } else if skip.iter().any(|(item, _)| item == id) {
        "pular"
    } else {
        "esperar"
    }
}

pub fn mission_choice(delivery: &MissionDelivery) -> &'static str {
    if mission_status(delivery) == "done" {
        "entregar"
    } else {
        "reter"
    }
}

pub(super) struct MemorySignals {
    pub(super) duplicate: bool,
    pub(super) contradiction: bool,
    pub(super) deletion: bool,
}

pub fn observe_memory_mission(db: DbConnection, summary: &MemoryReviewSummary) {
    let jobs = summary
        .items
        .iter()
        .map(|item| {
            memory_job(
                POINT_MEMORY,
                &item.key,
                &item.kind,
                "proposta",
                &item.body,
                item.evidence.reason.as_deref(),
                MemorySignals {
                    duplicate: item.duplicate_of.is_some(),
                    contradiction: item.contradicts.is_some(),
                    deletion: false,
                },
            )
        })
        .collect();
    enqueue(db, jobs);
}

pub fn observe_memory_workspace(db: DbConnection, summary: &WorkspaceReviewSummary) {
    let jobs = summary
        .groups
        .iter()
        .flat_map(|group| group.items.iter())
        .filter(|item| item.item.evidence.actor_kind != "dreamer")
        .map(|item| {
            memory_job(
                POINT_MEMORY,
                &item.item.key,
                &item.item.kind,
                &item.operation,
                &item.item.body,
                item.item.evidence.reason.as_deref(),
                MemorySignals {
                    duplicate: item.item.duplicate_of.is_some(),
                    contradiction: item.item.contradicts.is_some(),
                    deletion: item.operation == "delete",
                },
            )
        })
        .collect();
    enqueue(db, jobs);
}

pub fn observe_dreams(db: DbConnection, dreams: &[DreamReview]) {
    let jobs = dreams
        .iter()
        .flat_map(|dream| dream.proposals.iter())
        .map(|item| {
            dream_job(
                &item.item.key,
                &item.item.kind,
                &item.operation,
                &item.item.body,
                item.item.evidence.reason.as_deref(),
                item.item.duplicate_of.is_some(),
            )
        })
        .collect();
    enqueue(db, jobs);
}

pub(super) fn dream_job(
    key: &str,
    kind: &str,
    operation: &str,
    body: &str,
    reason: Option<&str>,
    duplicate: bool,
) -> ShadowJob {
    let mut heuristic = BTreeMap::new();
    heuristic.insert("triagem".into(), dream_choice(duplicate).to_string());
    let state = proposal_state(key, kind, operation, body);
    ShadowJob {
        point: POINT_DREAM,
        state: state.clone(),
        sensitive: memory_secret(key, body, reason),
        identity: None,
        request: request(state, dream_questions(), heuristic),
    }
}

/// `running` são as vagas ocupadas, que o agendador já conta para decidir e o provedor
/// precisa ver para decidir igual. Com o ponto desligado não monta nada.
pub fn fleet_jobs(
    conn: &Connection,
    run: &Run,
    tasks: &[Task],
    running: i64,
    launch: &[String],
    skip: &[(String, String)],
) -> Vec<ShadowJob> {
    if !config::point_active(conn, POINT_FLEET) {
        return Vec::new();
    }
    tasks
        .iter()
        .filter(|task| task.status == crate::runs::types::status::PENDING)
        .map(|task| {
            let mut heuristic = BTreeMap::new();
            heuristic.insert(
                "despacho".into(),
                fleet_label(&task.id, launch, skip).to_string(),
            );
            let state = fleet_state(run, task, tasks, running);
            ShadowJob {
                point: POINT_FLEET,
                state: state.clone(),
                sensitive: false,
                identity: None,
                request: request(state, fleet_questions(), heuristic),
            }
        })
        .collect()
}

pub fn observe_mission(db: DbConnection, mission_id: &str, delivery: &MissionDelivery) {
    let mut heuristic = BTreeMap::new();
    heuristic.insert("gate".into(), mission_choice(delivery).to_string());
    let state = format!(
        "testes: {}\nci: {}",
        delivery.test_result.as_str(),
        delivery.ci_status.as_str()
    );
    enqueue(
        db,
        vec![ShadowJob {
            point: POINT_MISSION,
            state: state.clone(),
            sensitive: false,
            // O estado é o mesmo para toda missão com o mesmo resultado: sem a missão no
            // hash, a janela de uma hora descartaria quase todas as amostras.
            identity: Some(mission_id.to_string()),
            request: request(state, mission_questions(), heuristic),
        }],
    );
}

pub(super) fn memory_job(
    point: &'static str,
    key: &str,
    kind: &str,
    operation: &str,
    body: &str,
    reason: Option<&str>,
    signals: MemorySignals,
) -> ShadowJob {
    let secret = memory_secret(key, body, reason);
    let MemorySignals {
        duplicate,
        contradiction,
        deletion,
    } = signals;
    let mut heuristic = BTreeMap::new();
    heuristic.insert(
        "acao".into(),
        memory_choice(duplicate, contradiction, deletion, secret).to_string(),
    );
    heuristic.insert(
        "segredo".into(),
        if secret { "sim" } else { "nao" }.to_string(),
    );
    let state = proposal_state(key, kind, operation, body);
    ShadowJob {
        point,
        state: state.clone(),
        sensitive: secret,
        identity: None,
        request: request(state, memory_questions(), heuristic),
    }
}

fn request(
    state: String,
    questions: BTreeMap<String, Question>,
    heuristic: BTreeMap<String, String>,
) -> DecisionRequest {
    DecisionRequest {
        state,
        questions,
        model: String::new(),
        heuristic,
    }
}

fn proposal_state(key: &str, kind: &str, operation: &str, body: &str) -> String {
    let body = truncate_chars(body, 3_500);
    super::protocol::truncate_state(&format!(
        "chave: {}\ntipo: {kind}\noperacao: {operation}\ntexto:\n{body}",
        truncate_chars(key, 200)
    ))
}

fn fleet_state(run: &Run, task: &Task, tasks: &[Task], running: i64) -> String {
    let deps = task
        .depends_on
        .iter()
        .map(|id| {
            tasks
                .iter()
                .find(|other| &other.id == id)
                .map(|other| {
                    format!(
                        "{}={}",
                        other.plan_key.as_deref().unwrap_or(&other.title),
                        other.status
                    )
                })
                .unwrap_or_else(|| format!("{id}=ausente"))
        })
        .collect::<Vec<_>>()
        .join(", ");
    // O agendador só olha se o orçamento estourou e quantas vagas estão ocupadas. O gasto em
    // dólar mudaria o hash a cada tick e anularia a janela de uma hora.
    let budget = match run.budget_usd {
        None => "sem limite",
        Some(limit) if run.spent_usd >= limit => "estourado",
        Some(_) => "dentro",
    };
    super::protocol::truncate_state(&format!(
        "titulo: {}\npapel: {}\norcamento: {budget}\nem_execucao: {running}\nmax_paralelo: {}\ndependencias: {}",
        truncate_chars(&task.title, 180),
        task.role.as_deref().unwrap_or("manual"),
        run.max_parallel.max(1),
        if deps.is_empty() {
            "nenhuma".to_string()
        } else {
            deps
        },
    ))
}

fn memory_questions() -> BTreeMap<String, Question> {
    let mut questions = BTreeMap::new();
    questions.insert(
        "acao".into(),
        Question::choice(
            "O que a caixa de aprovação deve sugerir para esta proposta de memória?",
            &[
                ("aprovar", "pode entrar na memória sem ressalva"),
                ("rejeitar", "não deve entrar"),
                ("revisar", "uma pessoa precisa olhar antes"),
            ],
        ),
    );
    questions.insert(
        "segredo".into(),
        Question::noul("contém segredo ou dado sensível?"),
    );
    questions
}

fn dream_questions() -> BTreeMap<String, Question> {
    let mut questions = BTreeMap::new();
    questions.insert(
        "triagem".into(),
        Question::choice(
            "Como triar esta proposta do sonho?",
            &[
                ("manter", "é nova e continua pendente"),
                (
                    "juntar",
                    "é duplicata e deve ser fundida com uma memória existente",
                ),
                ("descartar", "está obsoleta e deve ser descartada"),
            ],
        ),
    );
    questions
}

fn fleet_questions() -> BTreeMap<String, Question> {
    let mut questions = BTreeMap::new();
    questions.insert(
        "despacho".into(),
        Question::choice(
            "O que fazer com esta tarefa pendente da frota?",
            &[
                ("lancar", "pode sair agora"),
                ("esperar", "ainda depende de outra ou não há vaga"),
                ("pular", "não vai rodar"),
            ],
        ),
    );
    questions
}

fn mission_questions() -> BTreeMap<String, Question> {
    let mut questions = BTreeMap::new();
    questions.insert(
        "gate".into(),
        Question::choice(
            "O gate de entrega da missão passa?",
            &[
                ("entregar", "testes e CI permitem concluir como entregue"),
                ("reter", "fecha sem entrega completa"),
            ],
        ),
    );
    questions
}
