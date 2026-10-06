//! Budget decisions use only measured, priced tokens; never ledger estimates.
use super::mission::CostEstimate;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::Emitter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetState {
    Ok,
    Warning,
    Exceeded,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub mission_id: String,
    #[serde(rename = "level")]
    pub state: BudgetState,
    pub budget_usd: Option<f64>,
    pub cost_usd: f64,
    #[serde(rename = "pct")]
    pub percent: Option<f64>,
    /// Observed positive cost delta projected over the supplied horizon, if available.
    pub projected_cost_usd: Option<f64>,
    pub unpriced_models: Vec<String>,
    pub measured: bool,
    pub unmeasured_agents: Vec<String>,
    pub continue_anyway: bool,
    pub trend_usd_per_hour: Option<f64>,
}

pub fn evaluate_budget(
    budget: Option<f64>,
    estimate: Option<&CostEstimate>,
    trend: Option<f64>,
) -> BudgetStatus {
    let budget = budget.filter(|v| v.is_finite());
    let cost = estimate
        .map(|e| e.cost_usd)
        .filter(|v| v.is_finite() && *v >= 0.0);
    let percent = budget.and_then(|b| {
        if b <= 0.0 {
            Some(100.0)
        } else {
            cost.map(|c| c / b * 100.0)
        }
    });
    let state = match percent {
        Some(p) if p >= 100.0 => BudgetState::Exceeded,
        Some(p) if p >= 80.0 => BudgetState::Warning,
        _ => BudgetState::Ok,
    };
    BudgetStatus {
        mission_id: String::new(),
        state,
        budget_usd: budget,
        cost_usd: cost.unwrap_or(0.0),
        percent,
        projected_cost_usd: cost
            .zip(trend.filter(|d| d.is_finite() && *d >= 0.0))
            .map(|(c, d)| c + d),
        unpriced_models: estimate
            .map(|e| e.unpriced_models.clone())
            .unwrap_or_default(),
        measured: cost.is_some(),
        unmeasured_agents: vec![],
        continue_anyway: false,
        trend_usd_per_hour: None,
    }
}

pub fn budget_for_conn(conn: &Connection, mission: &str) -> Result<BudgetStatus, String> {
    let budget = conn
        .query_row(
            "SELECT budget_usd FROM missions WHERE id=?1",
            [mission],
            |r| r.get::<_, Option<f64>>(0),
        )
        .map_err(|e| e.to_string())?;
    let tokens = super::mission_tokens_for_conn(conn, mission)?;
    let mut status = evaluate_budget(budget, tokens.totals.estimate.as_ref(), None);
    status.mission_id = mission.into();
    status.unmeasured_agents = tokens
        .agents
        .iter()
        .filter(|a| !a.measured || a.tabs.iter().any(|t| !t.measured))
        .map(|a| a.agent_id.clone())
        .collect();
    status.continue_anyway = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("mission.budget.continue.{mission}")],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if status.measured {
        let key = format!("mission.budget.sample.{mission}");
        let now = crate::util::now_ts();
        let previous = conn
            .query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .and_then(|s| serde_json::from_str::<(i64, f64)>(&s).ok());
        if let Some((at, cost)) = previous {
            status.trend_usd_per_hour = observed_trend(at, cost, now, status.cost_usd);
        }
        if previous.is_none_or(|(at, _)| now - at >= 60) {
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
                rusqlite::params![
                    key,
                    serde_json::to_string(&(now, status.cost_usd)).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(status)
}

fn observed_trend(previous_at: i64, previous_cost: f64, now: i64, cost: f64) -> Option<f64> {
    (now > previous_at && cost >= previous_cost && previous_cost.is_finite() && cost.is_finite())
        .then(|| (cost - previous_cost) * 3600.0 / (now - previous_at) as f64)
}

pub fn require_budget(conn: &Connection, mission: &str) -> Result<(), String> {
    let status = budget_for_conn(conn, mission)?;
    if status.state != BudgetState::Exceeded || status.continue_anyway {
        return Ok(());
    }
    Err("missions.budget.confirmationRequired".into())
}

/// One warning per threshold per mission and ceiling. Persistent across app restarts.
pub fn claim_warning(
    conn: &Connection,
    mission: &str,
    status: &BudgetStatus,
) -> Result<Option<String>, String> {
    if status.state == BudgetState::Ok {
        return Ok(None);
    }
    let key = format!(
        "mission.budget.warning.{mission}.{:?}.{:?}",
        status.budget_usd, status.state
    );
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES (?1,'1')",
            [&key],
        )
        .map_err(|e| e.to_string())?;
    Ok((inserted > 0).then(|| format!("[AGS] orçamento a {:.0}%: US$ {:.4} de US$ {:.2}. Novas tarefas exigem confirmação quando o teto é atingido.", status.percent.unwrap_or(0.0), status.cost_usd, status.budget_usd.unwrap_or(0.0))))
}

/// Approval is obtained from the user's UI, never from CLI flags supplied by an agent.
pub fn confirm_spend(
    app: &tauri::AppHandle,
    db: &crate::database::DbConnection,
    mission: &str,
    action: &str,
) -> Result<(), String> {
    let (status, language) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let language = conn
            .query_row(
                "SELECT value FROM settings WHERE key='ui.language'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "pt-BR".into());
        (budget_for_conn(&conn, mission)?, language)
    };
    {
        let c = db.lock().map_err(|e| e.to_string())?;
        if let Some(message) = claim_warning(&c, mission, &status)? {
            warn_lead(app, mission, &message);
        }
    }
    if status.state != BudgetState::Exceeded || status.continue_anyway {
        return Ok(());
    }
    let (question, continue_label, cancel_label) = confirmation_copy(
        &language,
        action,
        status.cost_usd,
        status.budget_usd.unwrap_or(0.0),
    );
    let raw = crate::ipc::bridge::ask_frontend_within(
        app,
        "user.ask",
        &serde_json::json!({
            "question": question,
            "options": [continue_label,cancel_label], "timeout_s": 1800
        }),
        None,
        std::time::Duration::from_secs(1830),
    )?;
    let response = crate::ipc::bridge::unwrap_frontend_result(raw)?;
    let text = response["text"]
        .as_str()
        .ok_or("missions.budget.confirmationRequired")?;
    let raised = text
        .trim()
        .replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > status.cost_usd && *n > status.budget_usd.unwrap_or(0.0));
    if text != continue_label && raised.is_none() {
        return Err("missions.budget.confirmationRequired".into());
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    if let Some(n) = raised {
        conn.execute(
            "UPDATE missions SET budget_usd=?1 WHERE id=?2",
            rusqlite::params![n, mission],
        )
        .map_err(|e| e.to_string())?;
    }
    let key = format!("mission.budget.decision.{mission}.{}", uuid::Uuid::new_v4());
    let value = serde_json::json!({"at":crate::util::now_ts(),"action":action,"costUsd":status.cost_usd,"budgetUsd":status.budget_usd,"raisedTo":raised,"decision":text}).to_string();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES (?1,?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    if raised.is_none() {
        conn.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
            rusqlite::params![format!("mission.budget.continue.{mission}"), action],
        )
        .map_err(|e| e.to_string())?;
    }
    app.emit(
        "cc-budget-changed",
        serde_json::json!({"missionId":mission}),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn confirmation_copy(
    language: &str,
    action: &str,
    cost: f64,
    budget: f64,
) -> (String, &'static str, &'static str) {
    match language {
        "en"=>(format!("[AGS] Budget exceeded ({cost:.4} / {budget:.2} USD). Authorize {action}? To raise the ceiling, enter the new amount in USD."),"Continue anyway","Cancel"),
        "es"=>(format!("[AGS] Presupuesto agotado ({cost:.4} / {budget:.2} USD). ¿Autorizar {action}? Para elevar el límite, escribe el nuevo importe en USD."),"Continuar de todas formas","Cancelar"),
        _=>(format!("[AGS] Orçamento esgotado ({cost:.4} / {budget:.2} USD). Autorizar {action}? Para elevar o teto, informe o novo valor em USD."),"Continuar mesmo assim","Cancelar")
    }
}

#[tauri::command]
pub fn mission_budget(
    app: tauri::AppHandle,
    mission_id: String,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<BudgetStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let status = budget_for_conn(&conn, &mission_id)?;
    if let Some(message) = claim_warning(&conn, &mission_id, &status)? {
        warn_lead(&app, &mission_id, &message);
        let _ = app.emit(
            "cc-budget-changed",
            serde_json::json!({"missionId":mission_id}),
        );
    }
    Ok(status)
}

pub fn warn_lead(app: &tauri::AppHandle, mission: &str, message: &str) {
    let boards = crate::canvas::load_boards();
    for board in boards.values() {
        for tab in &board.orchestrators {
            if crate::canvas::mission_of_tab(&boards, tab).as_deref() == Some(mission) {
                crate::terminal::display_notice(app, tab, message);
            }
        }
    }
}

#[tauri::command]
pub fn mission_raise_budget(
    app: tauri::AppHandle,
    mission_id: String,
    budget_usd: f64,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<BudgetStatus, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    let s = budget_for_conn(&c, &mission_id)?;
    if !budget_usd.is_finite() || budget_usd <= s.budget_usd.unwrap_or(0.0) {
        return Err("missions.budget.invalidCeiling".into());
    }
    c.execute(
        "UPDATE missions SET budget_usd=?1 WHERE id=?2",
        rusqlite::params![budget_usd, mission_id],
    )
    .map_err(|e| e.to_string())?;
    record_decision(
        &c,
        &mission_id,
        "raise",
        serde_json::json!({"previous":s.budget_usd,"budgetUsd":budget_usd}),
    )?;
    c.execute(
        "DELETE FROM settings WHERE key=?1",
        [format!("mission.budget.continue.{mission_id}")],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "cc-budget-changed",
        serde_json::json!({"missionId":mission_id}),
    );
    budget_for_conn(&c, &mission_id)
}

fn record_decision(
    c: &Connection,
    mission: &str,
    action: &str,
    details: serde_json::Value,
) -> Result<(), String> {
    let key = format!("mission.budget.decision.{mission}.{}", uuid::Uuid::new_v4());
    c.execute(
        "INSERT INTO settings(key,value) VALUES (?1,?2)",
        rusqlite::params![
            key,
            serde_json::json!({"at":crate::util::now_ts(),"action":action,"details":details})
                .to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// User-only Tauri command: intentionally absent from IPC/MCP dispatch.
#[tauri::command]
pub fn mission_budget_continue(
    app: tauri::AppHandle,
    mission_id: String,
    action: String,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<BudgetStatus, String> {
    if !matches!(action.as_str(), "recruit" | "startTask") {
        return Err("invalid budget action".into());
    }
    let c = db.lock().map_err(|e| e.to_string())?;
    let s = budget_for_conn(&c, &mission_id)?;
    record_decision(
        &c,
        &mission_id,
        &action,
        serde_json::json!({"budgetUsd":s.budget_usd,"costUsd":s.cost_usd,"decision":"continue"}),
    )?;
    c.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
        rusqlite::params![format!("mission.budget.continue.{mission_id}"), action],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "cc-budget-changed",
        serde_json::json!({"missionId":mission_id}),
    );
    budget_for_conn(&c, &mission_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn estimate(n: f64) -> CostEstimate {
        CostEstimate {
            cost_usd: n,
            saved_usd: 0.0,
            unpriced_models: vec!["unknown".into()],
        }
    }
    #[test]
    fn boundaries_and_trend() {
        for (cost, state) in [
            (7.99, BudgetState::Ok),
            (8.0, BudgetState::Warning),
            (10.0, BudgetState::Exceeded),
            (11.0, BudgetState::Exceeded),
        ] {
            let s = evaluate_budget(Some(10.0), Some(&estimate(cost)), Some(3.0));
            assert_eq!(s.state, state);
            assert_eq!(s.projected_cost_usd, Some(cost + 3.0));
            assert_eq!(s.unpriced_models, vec!["unknown"]);
        }
    }
    #[test]
    fn unknown_is_not_zero_and_zero_ceiling_is_exceeded() {
        assert!(!evaluate_budget(Some(1.0), None, None).measured);
        assert_eq!(
            evaluate_budget(Some(0.0), Some(&estimate(0.0)), None).state,
            BudgetState::Exceeded
        );
        assert_eq!(
            evaluate_budget(None, Some(&estimate(99.0)), None).state,
            BudgetState::Ok
        );
        assert_eq!(
            evaluate_budget(Some(f64::NAN), Some(&estimate(2.0)), None).percent,
            None
        );
    }
    #[test]
    fn warning_is_persistently_deduplicated() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        let s = evaluate_budget(Some(10.0), Some(&estimate(8.0)), None);
        assert!(claim_warning(&c, "m", &s)
            .unwrap()
            .unwrap()
            .starts_with("[AGS] orçamento a 80%"));
        assert!(claim_warning(&c, "m", &s).unwrap().is_none());
        assert!(claim_warning(
            &c,
            "m",
            &evaluate_budget(Some(10.0), Some(&estimate(10.0)), None)
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn recruit_and_task_start_are_blocked_until_user_decision() {
        let c = crate::database::test_db();
        c.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('ws','W',0,0); INSERT INTO missions(id,workspace_id,title,objective,cwd,budget_usd,created_at,updated_at) VALUES('m','ws','M','O','/repo',0,0,0)").unwrap();
        assert_eq!(
            require_budget(&c, "m").unwrap_err(),
            "missions.budget.confirmationRequired"
        );
        c.execute(
            "INSERT INTO settings(key,value) VALUES ('mission.budget.continue.m','recruit')",
            [],
        )
        .unwrap();
        assert!(require_budget(&c, "m").is_ok());
        c.execute(
            "DELETE FROM settings WHERE key='mission.budget.continue.m'",
            [],
        )
        .unwrap();
        assert!(require_budget(&c, "m").is_err());
        c.execute("UPDATE missions SET budget_usd=NULL WHERE id='m'", [])
            .unwrap();
        assert!(require_budget(&c, "m").is_ok());
    }
    #[test]
    fn trend_uses_real_positive_observations_only() {
        assert_eq!(observed_trend(0, 1.0, 3600, 2.0), Some(1.0));
        assert_eq!(observed_trend(10, 2.0, 10, 3.0), None);
        assert_eq!(observed_trend(0, 2.0, 60, 1.0), None);
        assert_eq!(
            evaluate_budget(Some(-1.0), None, None).state,
            BudgetState::Exceeded
        );
    }
}
