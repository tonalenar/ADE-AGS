//! Visible-UI execution through the installed desktop app. No headless or MCP channel.
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use crate::database::DbConnection;
use crate::runs::{roster::{RosterAgent, ModelDiscoveryState}, store, supervisor, types::{Task, TaskOutcome}};

pub fn roster_agent() -> RosterAgent {
    let installed = super::status().installed;
    RosterAgent {
        agent_id: super::GEMINI_DESKTOP.into(), label: "Gemini Desktop · aplicativo local".into(), installed,
        launchable: installed, unavailable: (!installed).then(|| "Gemini Desktop is not installed".into()),
        capabilities: crate::agents::Capabilities { accounts: false, sessions: false, resume: false, skills: false,
            mcp: false, models: false, headless: false, orchestration: true },
        models: vec![], accounts: vec![], model_discovery: ModelDiscoveryState::Unsupported,
    }
}

pub fn schema(conn: &Connection) -> Result<(), String> {
    super::tasks::schema(conn)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS gemini_desktop_run_tasks (
        consult_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_applied INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS gemini_desktop_run_task_id ON gemini_desktop_run_tasks(task_id);")
        .map_err(|e| e.to_string())
}

pub fn start(app: &tauri::AppHandle, task: Task, extras: supervisor::LaunchExtras) -> Result<(), String> {
    if task.model.is_some() || task.account_id.is_some() || task.reasoning_effort.is_some() || task.result_schema.is_some() {
        return Err("Gemini Desktop uses the model/account selected in its app and does not enforce a result schema".into());
    }
    if !super::status().installed { return Err("Gemini Desktop is not installed".into()); }
    let db = app.state::<DbConnection>();
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    let run = store::run_of_task(&conn, &task.id)?.ok_or("Run not found")?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut prompt = format!("{}\n\n{}", extras.system_prompt.unwrap_or_default(), extras.prompt.unwrap_or(task.prompt.clone()));
    if task.role.as_deref() == Some("lead") {
        prompt.push_str("\n\nADE LEAD VIA GEMINI DESKTOP: You cannot call ADE tools directly. Return a JSON object {\"tasks\":[{\"key\":\"review\",\"title\":\"Review\",\"prompt\":\"Concrete task\",\"role\":\"qa\",\"depends_on\":[]}]}. Use only the functional roles supplied above. The user must review and apply this plan in ADE before the mission starts. Do not claim to have executed or delegated it.");
    }
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO gemini_desktop_consults(id,cwd,prompt,status,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?4)",
        rusqlite::params![id, super::tasks::workspace_key(&run.cwd), prompt, crate::util::now_ts()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO gemini_desktop_run_tasks(consult_id,task_id) VALUES(?1,?2)", rusqlite::params![id,task.id]).map_err(|e|e.to_string())?;
    store::mark_running(&tx, &task.id, &id, "")?;
    tx.commit().map_err(|e|e.to_string())?;
    drop(conn);
    supervisor::notify_changed(app, &task.id);
    let _ = app.emit("gemini-desktop-tasks-changed", ());
    let _ = app.emit("gemini-desktop-consult-created", json!({"cwd":run.cwd,"id":id}));
    Ok(())
}

pub fn linked_task(conn: &Connection, consult_id: &str) -> Result<Option<Task>, String> {
    schema(conn)?;
    let id: Option<String> = conn.query_row("SELECT task_id FROM gemini_desktop_run_tasks WHERE consult_id=?1", [consult_id], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
    id.map(|id|store::task_by_id(conn,&id)).transpose().map(Option::flatten)
}

pub fn validate_completion(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    let Some(task) = linked_task(conn,id)? else { return Ok(()) };
    let latest: String = conn.query_row("SELECT consult_id FROM gemini_desktop_run_tasks WHERE task_id=?1 ORDER BY rowid DESC LIMIT 1", [&task.id], |r|r.get(0)).map_err(|e|e.to_string())?;
    if latest != id { return Err("This consultation belongs to an older attempt".into()); }
    if task.status != "running" { return Err("The associated task is no longer running".into()); }
    if status == "completed" && task.role.as_deref() == Some("lead") {
        let applied: bool = conn.query_row("SELECT plan_applied FROM gemini_desktop_run_tasks WHERE consult_id=?1", [id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !applied { return Err("Review and apply the Lead plan before completing the consultation".into()); }
    }
    Ok(())
}

pub fn sync_cancelled(conn: &Connection) -> Result<(),String> {
    conn.execute("UPDATE gemini_desktop_consults SET status='cancelled',error='The associated task stopped or was retried',updated_at=?1
        WHERE status IN ('queued','working') AND id IN (
            SELECT link.consult_id FROM gemini_desktop_run_tasks link JOIN tasks task ON task.id=link.task_id
            WHERE task.status <> 'running' OR link.rowid < (SELECT MAX(newer.rowid) FROM gemini_desktop_run_tasks newer WHERE newer.task_id=link.task_id)
        )", [crate::util::now_ts()]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn finish(conn: &Connection, id: &str, status: &str, response: Option<String>, error: Option<String>) -> Result<Option<String>, String> {
    let Some(task) = linked_task(conn,id)? else { return Ok(None) };
    if status == "working" { return Ok(None); }
    if status == "cancelled" {
        conn.execute("UPDATE tasks SET status='cancelled',ended_at=?2 WHERE id=?1 AND status='running'", rusqlite::params![task.id,crate::util::now_ts()]).map_err(|e|e.to_string())?;
    } else {
        store::finish_task(conn,&task.id,&TaskOutcome { ok:status=="completed", result:response, error, ..Default::default() })?;
    }
    Ok(Some(task.id))
}

#[tauri::command]
pub async fn gemini_desktop_apply_plan(app: tauri::AppHandle, cwd: String, id: String, plan: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if plan.len() > 262144 { return Err("Plan exceeds 256 KiB".into()); }
        let value: Value = serde_json::from_str(&plan).map_err(|e|format!("Invalid plan JSON: {e}"))?;
        let db = app.state::<DbConnection>();
        let task_id = {
            let conn = db.lock().map_err(|e|e.to_string())?;
            schema(&conn)?;
            let consult = super::tasks::read(&conn,&id)?;
            if consult.cwd != super::tasks::workspace_key(&cwd) || !matches!(consult.status.as_str(),"queued"|"working") { return Err("Consultation is not active in this workspace".into()); }
            let task = linked_task(&conn,&id)?.ok_or("Consultation has no associated run")?;
            validate_completion(&conn,&id,"working")?;
            if task.agent_id != super::GEMINI_DESKTOP || task.role.as_deref()!=Some("lead") || task.status!="running" { return Err("Only a running Gemini Desktop Lead can apply a plan".into()); }
            task.id
        };
        let result = crate::runs::orchestration::handle(&app,"run.plan",&json!({"taskId":task_id,"args":value}))?;
        let conn = db.lock().map_err(|e|e.to_string())?;
        conn.execute("UPDATE gemini_desktop_run_tasks SET plan_applied=1 WHERE consult_id=?1",[id]).map_err(|e|e.to_string())?;
        Ok(result)
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(role: &str) -> (Connection,Task) {
        let conn = crate::database::test_db();
        conn.execute("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('desktop-test','Test',0,0)",[]).unwrap();
        let run = store::create_run(&conn,"desktop-test","Test","/p").unwrap();
        let task = store::create_task(&conn,&store::NewTask {run_id:&run.id,title:"Desktop",prompt:"Review",agent_id:super::super::GEMINI_DESKTOP,cwd:"/p",role:Some(role),..Default::default()}).unwrap();
        schema(&conn).unwrap();
        conn.execute("INSERT INTO gemini_desktop_consults VALUES('consult','/p','Review','queued',NULL,NULL,0,0)",[]).unwrap();
        conn.execute("INSERT INTO gemini_desktop_run_tasks VALUES('consult',?1,0)",[&task.id]).unwrap();
        store::mark_running(&conn,&task.id,"consult","").unwrap();
        (conn,task)
    }
    #[test]
    fn local_app_transport_does_not_claim_headless_mcp_accounts_or_model_control() {
        let agent=roster_agent();
        assert!(agent.capabilities.orchestration);
        assert!(!agent.capabilities.headless && !agent.capabilities.mcp && !agent.capabilities.accounts && !agent.capabilities.models);
    }
    #[test]
    fn delivered_worker_response_finishes_the_real_task_without_inventing_usage() {
        let (conn,task)=fixture("worker");
        validate_completion(&conn,"consult","completed").unwrap();
        assert_eq!(finish(&conn,"consult","completed",Some("Reviewed design".into()),None).unwrap(),Some(task.id.clone()));
        let result=store::task_by_id(&conn,&task.id).unwrap().unwrap();
        assert_eq!(result.status,"done");
        assert_eq!(result.result.as_deref(),Some("Reviewed design"));
        assert!(result.tokens_in.is_none() && result.cost_usd.is_none());
        assert!(validate_completion(&conn,"consult","completed").is_err());
    }
    #[test]
    fn lead_cannot_finish_before_a_validated_plan_and_stopped_work_is_not_resurrected() {
        let (conn,task)=fixture("lead");
        assert!(validate_completion(&conn,"consult","completed").is_err());
        conn.execute("UPDATE gemini_desktop_run_tasks SET plan_applied=1",[]).unwrap();
        validate_completion(&conn,"consult","completed").unwrap();
        conn.execute("UPDATE tasks SET status='cancelled' WHERE id=?1",[&task.id]).unwrap();
        assert!(validate_completion(&conn,"consult","working").is_err());
        sync_cancelled(&conn).unwrap();
        assert_eq!(super::super::tasks::read(&conn,"consult").unwrap().status,"cancelled");
    }
    #[test]
    fn old_consultation_cannot_finish_a_retried_task() {
        let (conn,task)=fixture("worker");
        conn.execute("INSERT INTO gemini_desktop_run_tasks VALUES('new-attempt',?1,0)",[task.id]).unwrap();
        assert!(validate_completion(&conn,"consult","completed").unwrap_err().contains("older attempt"));
    }
}
