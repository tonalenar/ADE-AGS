//! Cronômetro de uma missão: quanto tempo foi para cada coisa.
//!
//! Uma missão em terminais tem etapas que não aparecem em nenhum lugar: a TUI subir, o
//! briefing chegar, o agente terminar o turno, um `peer ask` esperar a resposta. Sem medir,
//! "demorou muito" é um palpite. Cada etapa é um *span* (início e fim em milissegundos) e
//! `summarize` os agrupa por tipo para mostrar onde foi o tempo.
//!
//! Os spans os gravam o frontend (boot, briefing, turno: é onde a terminal se vê) e o
//! servidor de IPC (`peer ask`, que mede o próprio turno do outro agente).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// As etapas que se medem. Texto livre não: assim a tela e o resumo sempre sabem o que são.
pub const KINDS: &[&str] = &["boot", "briefing", "turn", "peer_ask", "peer_message",
    "orchestrator_stall", "start_all_working", "start_briefing", "start_activity", "start_retry", "start_stalled"];
const MAX_TEXT: usize = 200;
/// Um span mais comprido que isto é um erro de relógio, não uma etapa (24 h).
const MAX_SPAN_MS: i64 = 24 * 60 * 60 * 1000;
/// Spans guardados por missão: uma missão longa não pode encher o banco.
pub const MAX_SPANS: i64 = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub id: i64,
    pub kind: String,
    /// Quem: o nome da terminal.
    pub actor: String,
    /// Com quem (em `peer_ask`, o agente perguntado).
    pub target: String,
    pub started_ms: i64,
    pub ended_ms: i64,
    pub detail: String,
}

impl Span {
    pub fn duration_ms(&self) -> i64 {
        (self.ended_ms - self.started_ms).max(0)
    }
}

/// O que o frontend ou o IPC mandam gravar.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSpan {
    pub kind: String,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub target: String,
    pub started_ms: i64,
    pub ended_ms: i64,
    #[serde(default)]
    pub detail: String,
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

/// Valida um span antes de gravá-lo. Pura.
pub fn validate(span: &NewSpan) -> Result<(), String> {
    if !KINDS.contains(&span.kind.as_str()) {
        return Err(format!("Tipo de tempo desconhecido '{}'. Use: {}.", span.kind, KINDS.join(", ")));
    }
    if span.started_ms <= 0 || span.ended_ms < span.started_ms {
        return Err("O fim do tempo não pode ser anterior ao início.".into());
    }
    if span.ended_ms - span.started_ms > MAX_SPAN_MS {
        return Err("Um tempo de mais de 24 h não é uma etapa de missão.".into());
    }
    Ok(())
}

pub fn add(conn: &Connection, mission_id: &str, span: &NewSpan) -> Result<(), String> {
    validate(span)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM mission_timings WHERE mission_id = ?1", [mission_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count >= MAX_SPANS {
        return Ok(()); // o limite não é um erro para quem mede: simplesmente deixa de guardar
    }
    conn.execute(
        "INSERT INTO mission_timings (mission_id, kind, actor, target, started_ms, ended_ms, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![mission_id, span.kind, clip(&span.actor), clip(&span.target), span.started_ms, span.ended_ms, clip(&span.detail)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(conn: &Connection, mission_id: &str) -> Result<Vec<Span>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, actor, target, started_ms, ended_ms, detail
               FROM mission_timings WHERE mission_id = ?1 ORDER BY started_ms, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([mission_id], |r| {
            Ok(Span {
                id: r.get(0)?,
                kind: r.get(1)?,
                actor: r.get(2)?,
                target: r.get(3)?,
                started_ms: r.get(4)?,
                ended_ms: r.get(5)?,
                detail: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KindTotal {
    pub kind: String,
    pub count: usize,
    pub total_ms: i64,
    pub max_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Do primeiro início ao último fim medido.
    pub wall_ms: i64,
    pub by_kind: Vec<KindTotal>,
    /// As etapas mais demoradas, da maior para a menor.
    pub slowest: Vec<Span>,
    pub bottlenecks: Vec<Bottleneck>,
}

/// Sum of caller wait time, including simultaneous waits by different callers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bottleneck {
    pub agent: String,
    pub asks: usize,
    pub blocked_callers: usize,
    pub waiting_ms: i64,
    pub max_wait_ms: i64,
    pub timeouts: usize,
    pub turn_ms: i64,
}

pub fn bottlenecks(spans: &[Span]) -> Vec<Bottleneck> {
    let mut agents = std::collections::BTreeMap::<String, Vec<&Span>>::new();
    for span in spans.iter().filter(|s| s.kind == "peer_ask" && !s.target.trim().is_empty()) {
        agents.entry(span.target.clone()).or_default().push(span);
    }
    let mut report: Vec<_> = agents.into_iter().map(|(agent, asks)| {
        let callers: std::collections::BTreeSet<_> = asks.iter().map(|s| &s.actor).collect();
        Bottleneck {
            asks: asks.len(), blocked_callers: callers.len(),
            waiting_ms: asks.iter().map(|s| s.duration_ms()).sum(),
            max_wait_ms: asks.iter().map(|s| s.duration_ms()).max().unwrap_or(0),
            timeouts: asks.iter().filter(|s| s.detail == "timeout").count(),
            turn_ms: spans.iter().filter(|s| s.kind == "turn" && s.actor == agent).map(|s| s.duration_ms()).sum(),
            agent,
        }
    }).collect();
    report.sort_by(|a, b| b.waiting_ms.cmp(&a.waiting_ms).then(a.agent.cmp(&b.agent)));
    report
}

/// Quanto tempo foi, e para quê. Pura.
pub fn summarize(spans: &[Span], top: usize) -> Summary {
    let wall_ms = match (spans.iter().map(|s| s.started_ms).min(), spans.iter().map(|s| s.ended_ms).max()) {
        (Some(start), Some(end)) => (end - start).max(0),
        _ => 0,
    };
    let by_kind = KINDS
        .iter()
        .filter_map(|kind| {
            let mine: Vec<&Span> = spans.iter().filter(|s| s.kind == *kind).collect();
            if mine.is_empty() {
                return None;
            }
            Some(KindTotal {
                kind: (*kind).to_string(),
                count: mine.len(),
                total_ms: mine.iter().map(|s| s.duration_ms()).sum(),
                max_ms: mine.iter().map(|s| s.duration_ms()).max().unwrap_or(0),
            })
        })
        .collect();
    let mut slowest: Vec<Span> = spans.to_vec();
    slowest.sort_by(|a, b| b.duration_ms().cmp(&a.duration_ms()).then(a.id.cmp(&b.id)));
    slowest.truncate(top);
    Summary { wall_ms, by_kind, slowest, bottlenecks: bottlenecks(spans) }
}

/// Alert and answer snapshots of the same wait count its elapsed time only once.
pub fn orchestrator_waits(spans: &[Span]) -> (usize, i64, i64) {
    let mut waits = std::collections::BTreeMap::new();
    let mut alerts = std::collections::BTreeSet::new();
    for span in spans.iter().filter(|s| s.kind == "orchestrator_stall") {
        let key = (&span.actor, &span.target, span.started_ms);
        let duration = waits.entry(key).or_insert(0_i64);
        *duration = (*duration).max(span.duration_ms());
        if span.detail.starts_with("alerted:") { alerts.insert(key); }
    }
    (alerts.len(), waits.values().sum(), waits.values().copied().max().unwrap_or(0))
}

#[cfg(test)]
mod test;

/// Lead-to-member send evidence; missing evidence or baseline remains unmeasured.
pub fn first_delegation(spans: &[Span], started_at: Option<i64>) -> (Option<i64>, Option<&'static str>) {
    let baseline = spans.iter().filter(|s| s.kind == "boot").map(|s| s.started_ms).min()
        .or_else(|| started_at.filter(|s| *s > 0).map(|s| s.saturating_mul(1000)));
    let measured = spans.iter().filter(|s| s.kind == "peer_message" && s.detail == "delegation").map(|s| s.started_ms).min();
    let legacy = spans.iter().filter(|s| s.kind == "peer_ask" && s.actor == "Orquestrador" && !s.target.is_empty()).map(|s| s.started_ms).min();
    match (baseline, measured.or(legacy)) {
        (Some(start), Some(end)) if end >= start => (Some(end - start), Some(if measured.is_some() { "peer_message" } else { "span" })),
        _ => (None, None),
    }
}

/// Only successful sends from the mission lead to another member are delegation evidence.
pub(crate) fn record_delegation(conn: &Connection, boards: &crate::canvas::Boards, kind: &str, from: &str, target: &str, at: i64) -> Result<(), String> {
    if !matches!(kind, "tell" | "ask") || from == target || !crate::canvas::is_orchestrator(boards, from) {
        return Ok(());
    }
    let Some(mission) = crate::canvas::mission_of_tab(boards, from) else { return Ok(()); };
    if crate::canvas::mission_of_tab(boards, target).as_deref() != Some(mission.as_str()) {
        return Ok(());
    }
    add(conn, &mission, &NewSpan { kind: "peer_message".into(), actor: "Orquestrador".into(), target: target.into(), started_ms: at, ended_ms: at, detail: "delegation".into() })
}
