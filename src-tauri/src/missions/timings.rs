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
pub const KINDS: &[&str] = &["boot", "briefing", "turn", "peer_ask"];
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
    Summary { wall_ms, by_kind, slowest }
}

#[cfg(test)]
mod test;
