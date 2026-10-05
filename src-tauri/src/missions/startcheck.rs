//! Persisted launch evidence; absence of output must never count as a successful start.
use rusqlite::Connection;
use serde::Serialize;
use super::timings::Span;

pub const START_DEADLINE_MS: i64 = 120_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStart {
    pub actor: String,
    pub briefing_sent_ms: Option<i64>,
    pub activity_ms: Option<i64>,
    pub time_until_start_ms: Option<i64>,
    pub exceeded_deadline: bool,
    pub passed: bool,
    pub submit_retries: usize,
    pub stalled_notifications: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCheck {
    pub mission_id: String,
    pub deadline_ms: i64,
    pub agents: Vec<AgentStart>,
    pub all_working: bool,
    pub passed: bool,
    pub time_until_all_working_ms: Option<i64>,
}

/// Launch deadline is measured from opening the team, including TUI boot time.
pub fn evaluate(mission_id: &str, names: &[String], spans: &[Span], started_ms: Option<i64>, now: i64) -> StartCheck {
    let baseline = spans.iter().filter(|s| s.kind == "boot").map(|s| s.started_ms).min().or(started_ms);
    let agents: Vec<_> = names.iter().map(|actor| {
        let mine: Vec<_> = spans.iter().filter(|s| &s.actor == actor).collect();
        let briefing = mine.iter().filter(|s| matches!(s.kind.as_str(), "start_briefing" | "boot"))
            .map(|s| s.ended_ms).min();
        // Only the dedicated activity event proves that the agent started. A turn's
        // start timestamp is submission time, not observed activity.
        let activity = briefing.and_then(|sent| mine.iter().filter(|s| s.kind == "start_activity" && s.ended_ms >= sent)
            .map(|s| s.ended_ms).min());
        let elapsed = baseline.zip(activity).filter(|(a,b)| b >= a).map(|(a,b)| b - a);
        let exceeded = baseline.map(|start| activity.unwrap_or(now).saturating_sub(start) > START_DEADLINE_MS).unwrap_or(false);
        AgentStart { actor: actor.clone(), briefing_sent_ms: briefing, activity_ms: activity,
            time_until_start_ms: elapsed, exceeded_deadline: exceeded,
            passed: elapsed.is_some_and(|ms| ms <= START_DEADLINE_MS),
            submit_retries: mine.iter().filter(|s| s.kind == "start_retry").count(),
            stalled_notifications: mine.iter().filter(|s| s.kind == "start_stalled").count() }
    }).collect();
    let all_working = !agents.is_empty() && agents.iter().all(|a| a.activity_ms.is_some());
    let passed = !agents.is_empty() && agents.iter().all(|a| a.passed);
    let time_until_all_working_ms = if all_working { agents.iter().map(|a| a.time_until_start_ms).collect::<Option<Vec<_>>>()
        .and_then(|times| times.into_iter().max()) } else { None };
    StartCheck { mission_id: mission_id.into(), deadline_ms: START_DEADLINE_MS, agents, all_working, passed, time_until_all_working_ms }
}

pub(crate) fn get(conn: &Connection, mission_id: &str, now: i64) -> Result<StartCheck, String> {
    let mission = super::store::get(conn, mission_id)?.ok_or("Missão não encontrada.")?;
    let spans = super::timings::list(conn, mission_id)?;
    let mut stmt = conn.prepare("SELECT name FROM mission_team_workspaces WHERE mission_id=?1 ORDER BY name").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([mission_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let mut names = rows.collect::<Result<std::collections::BTreeSet<_>, _>>().map_err(|e| e.to_string())?;
    // Legacy missions without team workspaces still expose their measured agents.
    names.extend(spans.iter().filter(|s| matches!(s.kind.as_str(), "boot" | "start_briefing" | "start_activity") && !s.actor.is_empty()).map(|s| s.actor.clone()));
    Ok(evaluate(mission_id, &names.into_iter().collect::<Vec<_>>(), &spans,
        mission.started_at.filter(|s| *s > 0).map(|s| s.saturating_mul(1000)), now))
}

#[cfg(test)]
mod test;
