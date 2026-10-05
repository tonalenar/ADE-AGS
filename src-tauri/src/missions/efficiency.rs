//! Métricas para avaliar quando dividir uma missão entre agentes compensa.
//!
//! O tempo ativo é a união dos spans `turn` e `peer_ask`: intervalos sobrepostos contam
//! uma vez. O relógio vem dos timestamps da missão; custos usam o acumulado já salvo nos
//! Runs; agentes são abas distintas observadas nos spans persistidos.

use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::active;
use super::timings::{self, Span};
use crate::util::now_ts;

/// Quantas missões concluídas entram na comparação recente.
pub const HISTORY_LIMIT: usize = 30;
const AGENT_BANDS: &[&str] = &["1", "2", "3-4", "5+"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBandComparison {
    pub band: String,
    pub sample_size: usize,
    pub median_active_ms: Option<i64>,
    pub median_wall_ms: Option<i64>,
    pub median_cost_estimate: Option<f64>,
    /// Percentual economizado pela faixa contra a mediana da faixa de um agente.
    pub time_gain_percent: Option<f64>,
    pub cost_gain_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionEfficiency {
    /// Tempo ativo oficial: `mission_active` e, sem ele, a união dos spans (ver `active::choose`).
    pub active_ms: Option<i64>,
    /// De onde veio `active_ms`: `mission_active`, `spans`, `wall` ou ausente.
    pub active_source: Option<String>,
    /// Detalhe por turno: união dos spans `turn` e `peer_ask`.
    pub turn_ms: Option<i64>,
    pub wall_ms: Option<i64>,
    /// Soma do custo reportado nos Runs. Ausente quando nenhum Run reportou custo.
    pub cost_estimate: Option<f64>,
    /// Abas distintas vistas em spans da missão; `peer_ask` também conta seu destino.
    pub agents: usize,
    pub history_limit: usize,
    pub history_size: usize,
    /// Ganho desta missão contra a mediana recente de missões com um agente.
    pub time_gain_percent: Option<f64>,
    pub cost_gain_percent: Option<f64>,
    /// Medianas do histórico, agrupadas pelo número de agentes.
    pub by_agent_band: Vec<AgentBandComparison>,
}

#[derive(Debug, Clone)]
struct Measurement {
    active_ms: Option<i64>,
    active_source: Option<&'static str>,
    turn_ms: Option<i64>,
    wall_ms: Option<i64>,
    cost_estimate: Option<f64>,
    agents: usize,
}

/// Calcula as métricas de uma missão e compara com até 30 missões concluídas recentes do
/// mesmo workspace. Missões de teste não entram no histórico.
pub fn get(conn: &Connection, mission_id: &str) -> Result<MissionEfficiency, String> {
    let mission = conn
        .query_row(
            "SELECT workspace_id, started_at, ended_at FROM missions WHERE id = ?1",
            [mission_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;

    let now = now_ts();
    let current = measure(conn, mission_id, mission.1, mission.2, now)?;
    let history = history(conn, &mission.0, mission_id, now)?;
    let bands = compare_bands(&history);
    let solo = bands.iter().find(|band| band.band == "1");

    Ok(MissionEfficiency {
        active_ms: current.active_ms,
        active_source: current.active_source.map(str::to_owned),
        turn_ms: current.turn_ms,
        wall_ms: current.wall_ms,
        cost_estimate: current.cost_estimate,
        agents: current.agents,
        history_limit: HISTORY_LIMIT,
        history_size: history.len(),
        time_gain_percent: solo.and_then(|band| percent_gain(band.median_wall_ms, current.wall_ms)),
        cost_gain_percent: solo.and_then(|band| percent_gain_f64(band.median_cost_estimate, current.cost_estimate)),
        by_agent_band: bands,
    })
}

fn measure(
    conn: &Connection,
    mission_id: &str,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    now: i64,
) -> Result<Measurement, String> {
    let spans = timings::list(conn, mission_id)?;
    let (cost_estimate, _) = run_cost(conn, mission_id)?;
    let turn_ms = active_time(&spans);
    let wall_ms = wall_time(started_at, ended_at, now);
    let active = active::resolve(conn, mission_id, turn_ms, wall_ms)?;
    Ok(Measurement {
        active_ms: active.ms,
        active_source: active.source,
        turn_ms,
        wall_ms,
        cost_estimate,
        agents: observed_agents(&spans),
    })
}

fn wall_time(started_at: Option<i64>, ended_at: Option<i64>, now: i64) -> Option<i64> {
    active::wall_ms(started_at, ended_at, now)
}

/// União dos spans `turn` e `peer_ask` (detalhe por turno, não o tempo ativo oficial).
pub(crate) fn turn_ms(spans: &[Span]) -> Option<i64> {
    active_time(spans)
}

fn active_time(spans: &[Span]) -> Option<i64> {
    let mut intervals = spans
        .iter()
        .filter(|span| matches!(span.kind.as_str(), "turn" | "peer_ask"))
        .map(|span| (span.started_ms, span.ended_ms.max(span.started_ms)))
        .collect::<Vec<_>>();
    if intervals.is_empty() {
        return None;
    }
    intervals.sort_unstable();
    let (mut start, mut end) = intervals[0];
    let mut total = 0i64;
    for (next_start, next_end) in intervals.into_iter().skip(1) {
        if next_start <= end {
            end = end.max(next_end);
        } else {
            total = total.saturating_add(end.saturating_sub(start));
            start = next_start;
            end = next_end;
        }
    }
    Some(total.saturating_add(end.saturating_sub(start)))
}

fn observed_agents(spans: &[Span]) -> usize {
    let mut agents = HashSet::new();
    for span in spans {
        let actor = span.actor.trim();
        if !actor.is_empty() {
            agents.insert(actor);
        }
        if span.kind == "peer_ask" {
            let target = span.target.trim();
            if !target.is_empty() {
                agents.insert(target);
            }
        }
    }
    agents.len()
}

fn run_cost(conn: &Connection, mission_id: &str) -> Result<(Option<f64>, usize), String> {
    let run_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM runs WHERE mission_id = ?1", [mission_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if run_count == 0 {
        return Ok((None, 0));
    }
    let total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(spent_usd), 0) FROM runs WHERE mission_id = ?1",
            [mission_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let reported: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks t JOIN runs r ON r.id = t.run_id
              WHERE r.mission_id = ?1 AND t.cost_usd IS NOT NULL",
            [mission_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(((reported > 0).then_some(total), reported as usize))
}

fn history(
    conn: &Connection,
    workspace_id: &str,
    current_id: &str,
    now: i64,
) -> Result<Vec<Measurement>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, started_at, ended_at FROM missions
              WHERE workspace_id = ?1 AND id <> ?2 AND is_test = 0
                AND status IN ('done', 'done_without_delivery')
                AND started_at IS NOT NULL AND ended_at IS NOT NULL
              ORDER BY ended_at DESC, rowid DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let missions = stmt
        .query_map(
            rusqlite::params![workspace_id, current_id, HISTORY_LIMIT as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    missions
        .iter()
        .map(|(id, started, ended)| measure(conn, id, *started, *ended, now))
        .collect()
}

fn agent_band(agents: usize) -> Option<&'static str> {
    match agents {
        1 => Some("1"),
        2 => Some("2"),
        3..=4 => Some("3-4"),
        5.. => Some("5+"),
        _ => None,
    }
}

fn compare_bands(history: &[Measurement]) -> Vec<AgentBandComparison> {
    let mut groups: BTreeMap<&'static str, Vec<&Measurement>> = BTreeMap::new();
    for measurement in history {
        if let Some(band) = agent_band(measurement.agents) {
            groups.entry(band).or_default().push(measurement);
        }
    }
    let solo_wall = groups.get("1").and_then(|group| median_i64(group.iter().filter_map(|m| m.wall_ms)));
    let solo_cost = groups.get("1").and_then(|group| median_f64(group.iter().filter_map(|m| m.cost_estimate)));

    AGENT_BANDS
        .iter()
        .filter_map(|band| {
            let group = groups.get(*band)?;
            Some(AgentBandComparison {
                band: (*band).to_string(),
                sample_size: group.len(),
                median_active_ms: median_i64(group.iter().filter_map(|m| m.active_ms)),
                median_wall_ms: median_i64(group.iter().filter_map(|m| m.wall_ms)),
                median_cost_estimate: median_f64(group.iter().filter_map(|m| m.cost_estimate)),
                time_gain_percent: percent_gain(solo_wall, median_i64(group.iter().filter_map(|m| m.wall_ms))),
                cost_gain_percent: percent_gain_f64(solo_cost, median_f64(group.iter().filter_map(|m| m.cost_estimate))),
            })
        })
        .collect()
}

fn median_i64(values: impl Iterator<Item = i64>) -> Option<i64> {
    let mut values = values.collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[middle])
    } else {
        Some(((values[middle - 1] as i128 + values[middle] as i128) / 2) as i64)
    }
}

fn median_f64(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut values = values.filter(|value| value.is_finite()).collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[middle])
    } else {
        Some((values[middle - 1] + values[middle]) / 2.0)
    }
}

fn percent_gain(baseline: Option<i64>, current: Option<i64>) -> Option<f64> {
    let (baseline, current) = (baseline?, current?);
    (baseline > 0).then(|| (baseline as f64 - current as f64) * 100.0 / baseline as f64)
}

fn percent_gain_f64(baseline: Option<f64>, current: Option<f64>) -> Option<f64> {
    let (baseline, current) = (baseline?, current?);
    (baseline > 0.0).then(|| (baseline - current) * 100.0 / baseline)
}

#[cfg(test)]
mod test;
