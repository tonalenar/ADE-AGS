//! Durable consultations relayed through the installed Gemini app's visible controls.
use crate::database::DbConnection;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Consult {
    id: String,
    pub(crate) cwd: String,
    prompt: String,
    pub(crate) status: String,
    response: Option<String>,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    run_task_id: Option<String>,
    role: Option<String>,
}

pub(crate) fn workspace_key(cwd: &str) -> String {
    let path = std::path::Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| cwd.into());
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    if text.as_bytes().get(1) == Some(&b':') {
        format!("{}{}", text[..1].to_ascii_lowercase(), &text[1..])
    } else {
        text.into()
    }
}
pub(crate) fn schema(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gemini_desktop_consults (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', response TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS gemini_desktop_consults_cwd ON gemini_desktop_consults(cwd, created_at);
    CREATE TABLE IF NOT EXISTS gemini_desktop_run_tasks (consult_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plan_applied INTEGER NOT NULL DEFAULT 0);")
        .map_err(|e| e.to_string())
}
pub(crate) fn read(db: &rusqlite::Connection, id: &str) -> Result<Consult, String> {
    use rusqlite::OptionalExtension;
    let mut consult = db.query_row("SELECT id,cwd,prompt,status,response,error,created_at,updated_at FROM gemini_desktop_consults WHERE id=?1", [id], |r| {
        Ok(Consult { id: r.get(0)?, cwd: r.get(1)?, prompt: r.get(2)?, status: r.get(3)?, response: r.get(4)?, error: r.get(5)?, created_at: r.get(6)?, updated_at: r.get(7)?, run_task_id: None, role: None })
    }).map_err(|e| e.to_string())?;
    consult.run_task_id = db.query_row("SELECT task_id FROM gemini_desktop_run_tasks WHERE consult_id=?1", [id], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(task) = &consult.run_task_id {
        consult.role = db.query_row("SELECT role FROM tasks WHERE id=?1", [task], |r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten();
    }
    Ok(consult)
}
pub(crate) fn dispatch(app: &tauri::AppHandle, op: &str, args: &Value) -> Result<Value, String> {
    let db = app.state::<DbConnection>();
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    super::participant::sync_cancelled(&conn)?;
    let scoped_cwd = if let Some(task) = args.get("taskId").and_then(Value::as_str) {
        Some(
            crate::runs::store::project_cwd_of_task(&conn, task)
                .ok_or("Task workspace not found")?,
        )
    } else {
        args.get("cwd").and_then(Value::as_str).map(str::to_string)
    };
    let args = args.get("args").unwrap_or(args);
    match op {
        "status" => Ok(json!(super::status())),
        "consult" => {
            let cwd = scoped_cwd
                .as_deref()
                .or_else(|| args.get("cwd").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .ok_or("cwd is required")?;
            if !std::path::Path::new(cwd).is_dir() {
                return Err("cwd must be an existing workspace directory".into());
            }
            let requested_cwd = cwd.to_string();
            let cwd = workspace_key(cwd);
            let prompt = args
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or("prompt is required")?;
            if prompt.len() > 65536 {
                return Err("Gemini consult prompt exceeds 64 KiB".into());
            }
            let pending: i64 = conn.query_row("SELECT count(*) FROM gemini_desktop_consults WHERE cwd=?1 AND status IN ('queued','working')", [&cwd], |r| r.get(0)).map_err(|e| e.to_string())?;
            if pending >= 100 {
                return Err("This workspace already has 100 pending Gemini consultations".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().timestamp();
            conn.execute("INSERT INTO gemini_desktop_consults (id,cwd,prompt,status,created_at,updated_at) VALUES (?1,?2,?3,'queued',?4,?4)",
                rusqlite::params![id, cwd, prompt, now]).map_err(|e| e.to_string())?;
            let task = read(&conn, &id)?;
            let _ = app.emit("gemini-desktop-tasks-changed", ());
            let _ = app.emit(
                "gemini-desktop-consult-created",
                json!({ "cwd": requested_cwd, "id": id }),
            );
            Ok(json!({ "task": task, "mode": if super::status().attached { "automatic" } else { "queued" },
                "message": if super::status().attached { "Queued for automatic delivery through the connected Gemini Desktop session." } else { "Queued. Connect Gemini Desktop in an ADE panel to send this consultation through the signed-in app." } }))
        }
        "result" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or("id is required")?;
            let task = read(&conn, id)?;
            if scoped_cwd
                .as_deref()
                .is_some_and(|cwd| workspace_key(cwd) != task.cwd)
            {
                return Err("Consult belongs to a different workspace".into());
            }
            Ok(json!({ "task": task }))
        }
        _ => Err("Unknown Gemini Desktop operation".into()),
    }
}

#[cfg(windows)]
fn execute_sync(app: tauri::AppHandle, view_id: String, cwd: String, id: String) -> Result<Consult, String> {
    static EXECUTION: OnceLock<Mutex<()>> = OnceLock::new();
    let _slot = EXECUTION.get_or_init(|| Mutex::new(())).lock().map_err(|e| e.to_string())?;
    let hwnd = super::native::automation_window(&view_id)?;
    let (prompt, role) = {
        let db = app.state::<DbConnection>();
        let conn = db.lock().map_err(|e| e.to_string())?;
        schema(&conn)?;
        super::participant::sync_cancelled(&conn)?;
        let consult = read(&conn, &id)?;
        if consult.cwd != workspace_key(&cwd) {
            return Err("Consult belongs to a different workspace".into());
        }
        if matches!(consult.status.as_str(), "completed" | "failed" | "cancelled")
            || (consult.status == "working" && consult.response.is_some())
        {
            return Ok(consult);
        }
        if !matches!(consult.status.as_str(), "queued" | "working") {
            return Err("Consultation is not available for delivery".into());
        }
        update_record(&conn, &cwd, &id, "working", None, None)?;
        (consult.prompt, consult.role)
    };
    let _ = app.emit("gemini-desktop-tasks-changed", ());

    let marker = format!("ADE_GEMINI_DONE_{}", uuid::Uuid::new_v4().simple());
    let outcome = super::accessibility::submit_and_wait(
        hwnd,
        &prompt,
        &marker,
        Duration::from_secs(600),
    );
    match outcome {
        Ok(response) if role.as_deref() == Some("lead") => {
            let db = app.state::<DbConnection>();
            let conn = db.lock().map_err(|e| e.to_string())?;
            let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            super::participant::validate_completion(&tx, &id, "working")?;
            update_record(&tx, &cwd, &id, "working", Some(response), None)?;
            tx.commit().map_err(|e| e.to_string())?;
            let task = read(&conn, &id)?;
            drop(conn);
            let _ = app.emit("gemini-desktop-tasks-changed", ());
            Ok(task)
        }
        Ok(response) => finish_automated(&app, &cwd, &id, "completed", Some(response), None),
        Err(error) => finish_automated(&app, &cwd, &id, "failed", None, Some(error)),
    }
}

#[cfg(windows)]
fn finish_automated(
    app: &tauri::AppHandle,
    cwd: &str,
    id: &str,
    status: &str,
    response: Option<String>,
    error: Option<String>,
) -> Result<Consult, String> {
    let db = app.state::<DbConnection>();
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    super::participant::sync_cancelled(&conn)?;
    let existing = read(&conn, id)?;
    if existing.status == "cancelled" { return Ok(existing); }
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    super::participant::validate_completion(&tx, id, status)?;
    update_record(&tx, cwd, id, status, response.clone(), error.clone())?;
    let finished = super::participant::finish(&tx, id, status, response, error)?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut consult = read(&conn, id)?;
    consult.cwd = cwd.to_string();
    drop(conn);
    if let Some(task) = finished {
        crate::runs::supervisor::notify_changed(app, &task);
        crate::runs::scheduler::on_task_finished(app, &task);
    }
    let _ = app.emit("gemini-desktop-tasks-changed", ());
    Ok(consult)
}

#[tauri::command]
pub async fn gemini_desktop_execute(
    app: tauri::AppHandle,
    view_id: String,
    cwd: String,
    id: String,
) -> Result<Consult, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || execute_sync(app, view_id, cwd, id))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, view_id, cwd, id);
        Err("Automatic Gemini Desktop delivery requires Windows".into())
    }
}

#[tauri::command]
pub fn gemini_desktop_consult_create(app: tauri::AppHandle, cwd: String, prompt: String) -> Result<Value,String> {
    dispatch(&app,"consult",&json!({"cwd":cwd,"prompt":prompt}))
}

#[tauri::command]
pub fn gemini_desktop_tasks(
    cwd: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Consult>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    super::participant::sync_cancelled(&conn)?;
    let mut stmt = conn.prepare("SELECT id FROM gemini_desktop_consults WHERE cwd=?1 ORDER BY CASE WHEN status IN ('queued','working') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 100").map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([workspace_key(&cwd)], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter()
        .map(|id| {
            read(&conn, id).map(|mut task| {
                task.cwd = cwd.clone();
                task
            })
        })
        .collect()
}

fn validate_update(
    status: &str,
    response: &Option<String>,
    error: &Option<String>,
) -> Result<(), String> {
    if !matches!(status, "working" | "completed" | "failed" | "cancelled") {
        return Err("Invalid Gemini consult status".into());
    }
    if status == "completed" && response.as_deref().is_none_or(|s| s.trim().is_empty()) {
        return Err("Paste the Gemini response before completing the consult".into());
    }
    if status == "failed" && error.as_deref().is_none_or(|s| s.trim().is_empty()) {
        return Err("A failure reason is required".into());
    }
    if response.as_ref().is_some_and(|s| s.len() > 1_048_576)
        || error.as_ref().is_some_and(|s| s.len() > 8192)
    {
        return Err("Consult result is too large".into());
    }
    Ok(())
}

#[tauri::command]
pub fn gemini_desktop_task_update(
    app: tauri::AppHandle,
    cwd: String,
    id: String,
    status: String,
    response: Option<String>,
    error: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    super::participant::validate_completion(&tx, &id, &status)?;
    update_record(&tx, &cwd, &id, &status, response.clone(), error.clone())?;
    let finished = super::participant::finish(&tx, &id, &status, response, error)?;
    tx.commit().map_err(|e|e.to_string())?;
    drop(conn);
    if let Some(task) = finished {
        crate::runs::supervisor::notify_changed(&app,&task);
        crate::runs::scheduler::on_task_finished(&app,&task);
    }
    let _ = app.emit("gemini-desktop-tasks-changed", ());
    Ok(())
}

fn retry_record(conn: &rusqlite::Connection, cwd: &str, id: &str) -> Result<(), String> {
    let consult = read(conn, id)?;
    if consult.cwd != workspace_key(cwd) {
        return Err("Consult belongs to a different workspace".into());
    }
    if consult.status != "failed" {
        return Err("Only a failed Gemini consultation can be retried".into());
    }
    if consult.run_task_id.is_some() {
        return Err("This consultation belongs to a finished mission task; retry the mission to create a fresh attempt".into());
    }
    let changed = conn.execute(
        "UPDATE gemini_desktop_consults SET status='queued',response=NULL,error=NULL,updated_at=?1 WHERE id=?2 AND cwd=?3 AND status='failed'",
        rusqlite::params![chrono::Utc::now().timestamp(), id, workspace_key(cwd)],
    ).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Consult is no longer available for retry".into());
    }
    Ok(())
}

#[tauri::command]
pub fn gemini_desktop_task_retry(
    app: tauri::AppHandle,
    cwd: String,
    id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    schema(&conn)?;
    super::participant::sync_cancelled(&conn)?;
    retry_record(&conn, &cwd, &id)?;
    drop(conn);
    let _ = app.emit("gemini-desktop-tasks-changed", ());
    Ok(())
}

fn update_record(
    conn: &rusqlite::Connection,
    cwd: &str,
    id: &str,
    status: &str,
    response: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    validate_update(status, &response, &error)?;
    let cwd = workspace_key(cwd);
    let count = conn.execute("UPDATE gemini_desktop_consults SET status=?1,response=?2,error=?3,updated_at=?4 WHERE id=?5 AND cwd=?6 AND status IN ('queued','working')",
        rusqlite::params![status, if matches!(status, "completed" | "working") { response } else { None }, if status == "failed" { error } else { None }, chrono::Utc::now().timestamp(), id, cwd]).map_err(|e| e.to_string())?;
    if count != 1 {
        return Err("Consult not found in this workspace or already finished".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_requires_a_real_result_and_failure_a_reason() {
        assert!(validate_update("completed", &None, &None).is_err());
        assert!(validate_update("completed", &Some("  ".into()), &None).is_err());
        assert!(validate_update("completed", &Some("review result".into()), &None).is_ok());
        assert!(validate_update("failed", &None, &None).is_err());
        assert!(validate_update("invented", &None, &None).is_err());
    }
    #[test]
    fn handoff_is_durable_and_does_not_conflate_workspaces() {
        let path = std::env::temp_dir().join(format!("ade-gemini-consults-{}.db", uuid::Uuid::new_v4()));
        let db = rusqlite::Connection::open(&path).unwrap();
        schema(&db).unwrap();
        schema(&db).unwrap();
        db.execute("INSERT INTO gemini_desktop_consults VALUES ('test','project-a','review','queued',NULL,NULL,1,1)", []).unwrap();
        assert_eq!(read(&db, "test").unwrap().status, "queued");
        assert!(
            update_record(
                &db,
                "project-b",
                "test",
                "completed",
                Some("answer".into()),
                None
            )
            .is_err()
        );
        assert_eq!(read(&db, "test").unwrap().status, "queued");
        update_record(&db, "project-a", "test", "working", None, None).unwrap();
        update_record(
            &db,
            "project-a",
            "test",
            "completed",
            Some("Gemini review".into()),
            None,
        )
        .unwrap();
        assert!(update_record(&db, "project-a", "test", "working", None, None).is_err());
        drop(db);
        let reopened = rusqlite::Connection::open(&path).unwrap();
        let restored = read(&reopened, "test").unwrap();
        assert_eq!(restored.status, "completed");
        assert_eq!(restored.response.as_deref(), Some("Gemini review"));
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn retry_requeues_failed_unlinked_consultations_without_touching_other_workspaces() {
        let db = crate::database::test_db();
        schema(&db).unwrap();
        db.execute("INSERT INTO gemini_desktop_consults VALUES ('retry','project-a','review','failed',NULL,'send failed',1,1)", []).unwrap();
        assert!(retry_record(&db, "project-b", "retry").is_err());
        assert_eq!(read(&db, "retry").unwrap().status, "failed");
        retry_record(&db, "project-a", "retry").unwrap();
        let retried = read(&db, "retry").unwrap();
        assert_eq!(retried.status, "queued");
        assert_eq!(retried.error, None);
        assert_eq!(retried.response, None);
    }
}
