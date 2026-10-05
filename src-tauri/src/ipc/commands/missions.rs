//! `ags mission …` y `ags approval …`: correr misiones sin la interfaz.
//!
//! Es lo que hace posible el modo headless (`ade-ags --headless`): un script o un
//! pipeline de CI crea la misión, la arranca, espera a que termine y sale con código 1 si
//! falló. Las aprobaciones que en la pantalla son una tarjeta se listan y se contestan
//! acá; sin nadie que las conteste, un pedido vence y se deniega (ver `runs::broker`), así
//! que en CI conviene dejar escritas las reglas de permiso de antemano.

use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::bus::{self, Filter};
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_opt};
use crate::missions::{MissionDetail, MissionInput};

const MAX_WAIT_SECS: u64 = 6 * 3600;

fn db(app: &AppHandle) -> Result<crate::database::DbConnection, String> {
    Ok(super::shared::db(app)?.inner().clone())
}

/// Lo que se devuelve de una misión: lo que un script necesita para decidir, sin el detalle
/// entero (prompts, facts) que ensuciaría la salida.
fn summary(detail: &MissionDetail) -> Value {
    let m = &detail.mission;
    json!({
        "id": m.id,
        "title": m.title,
        "status": m.status,
        "cwd": m.cwd,
        "activeRunId": m.active_run_id,
        "failureClassification": m.failure_classification,
        "failureDetail": m.failure_detail,
        "tasks": detail.tasks.iter().map(|t| json!({
            "id": t.id,
            "title": t.title,
            "role": t.role,
            "status": t.status,
            "agentId": t.agent_id,
            "accountId": t.account_id,
            "branch": t.branch,
            "error": t.error,
        })).collect::<Vec<_>>(),
    })
}

fn is_final(status: &str) -> bool {
    matches!(status, "done" | "done_without_delivery" | "failed" | "cancelled")
}

pub(super) fn mission_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let objective = arg_str(args, "objective")?;
    let cwd = arg_str(args, "cwd")?;
    let workspace = match arg_str_opt(args, "workspace") {
        Some(w) => w,
        None => crate::database::db_get_last_active_workspace_id(&db(app)?)?,
    };
    let input = MissionInput {
        title: arg_str_opt(args, "title").unwrap_or_else(|| objective.chars().take(60).collect()),
        objective,
        cwd,
        max_parallel: arg_u64_opt(args, "maxParallel").map(|n| n as i64),
        budget_usd: args.get("budget").and_then(|b| b.as_str().and_then(|s| s.parse().ok()).or_else(|| b.as_f64())),
        lead_agent_id: arg_str_opt(args, "agent"),
        lead_model: arg_str_opt(args, "model"),
        lead_account_id: arg_str_opt(args, "account"),
        // Sin `--account`, la elige el ruteo (y puede cambiarla por otra con cupo).
        auto_account: arg_str_opt(args, "account").is_none(),
        squad_id: arg_str_opt(args, "squad"),
        ..Default::default()
    };
    let mission = crate::missions::create_now(app, &workspace, &input)?;
    Ok(json!({ "id": mission.id, "title": mission.title, "status": mission.status }))
}

pub(super) fn mission_start(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
    crate::missions::start_now_with_force(app, &id, force)?;
    Ok(summary(&crate::missions::detail_now(app, &id)?))
}

pub(super) fn mission_status(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    Ok(summary(&crate::missions::detail_now(app, &id)?))
}

/// Espera a que la misión termine (o `--timeout` segundos). Una que falló o se canceló es un
/// ERROR para la CLI (código 1): es lo que un pipeline de CI necesita para cortar.
pub(super) fn mission_wait(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let timeout = Duration::from_secs(arg_u64_opt(args, "timeout").unwrap_or(3600).clamp(1, MAX_WAIT_SECS));
    wait_for(app, &id, timeout)
}

fn wait_for(app: &AppHandle, id: &str, timeout: Duration) -> Result<Value, String> {
    let filter = Filter { topics: vec!["mission.changed".into()], mission_id: Some(id.to_string()), ..Default::default() };
    let deadline = Instant::now() + timeout;
    // El seq ANTES de mirar el estado: lo que cambie entre medio se ve en la espera.
    let mut after = bus::since(0, &filter, 0).last_seq;
    loop {
        let detail = crate::missions::detail_now(app, id)?;
        let status = detail.mission.status.clone();
        if is_final(&status) {
            let out = summary(&detail);
            return if status == "done" {
                Ok(out)
            } else {
                Err(format!("la misión terminó como {status}: {out}"))
            };
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("la misión sigue {status} después de {} s", timeout.as_secs()));
        }
        // Un tope por vuelta: si un cambio no publica en el bus, igual se vuelve a mirar.
        let page = bus::wait(after, &filter, 10, (deadline - now).min(Duration::from_secs(30)));
        after = page.last_seq;
    }
}

/// Crear, arrancar y (con `--wait`) esperar, en una llamada: el caso de CI.
pub(super) fn mission_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let created = mission_create(app, args)?;
    let id = created["id"].as_str().unwrap_or_default().to_string();
    crate::missions::start_now(app, &id)?;
    if args.get("wait").is_some_and(|w| w.as_bool().unwrap_or(true)) {
        let timeout = Duration::from_secs(arg_u64_opt(args, "timeout").unwrap_or(3600).clamp(1, MAX_WAIT_SECS));
        return wait_for(app, &id, timeout);
    }
    Ok(summary(&crate::missions::detail_now(app, &id)?))
}

pub(super) fn mission_review(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(json!(crate::missions::review::review(&conn, &id)?))
}

/// `ags memory suggest --mission <id> --scope workspace|mission --key <k> --body "..."`: el agente
/// PROPONE una memoria para la próxima misión. Queda pendiente: solo el usuario la aprueba.
pub(super) fn memory_suggest(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use crate::memory::agent::{author_of, propose_for_mission, AgentProposal};

    let mission = arg_str(args, "mission")?;
    let key = arg_str(args, "key")?;
    let body = arg_str(args, "body")?;
    let scope = arg_str_opt(args, "scope").unwrap_or_else(|| "mission".into());
    let kind = arg_str_opt(args, "kind").unwrap_or_else(|| "note".into());
    let priority = args.get("priority").and_then(Value::as_i64).unwrap_or(0);

    // Quién propone: la terminal que llamó (`from`). El orquestador se distingue por su nombre.
    let from = arg_str_opt(args, "from");
    let name = from
        .as_deref()
        .and_then(|id| super::peers::open_tabs(app).ok()?.into_iter().find(|t| t.id == id).map(|t| t.name))
        .unwrap_or_else(|| "agente".to_string());
    let author = author_of(&name);

    let db = db(app)?;
    let result = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        propose_for_mission(
            &conn,
            &AgentProposal { mission_id: &mission, scope: &scope, key: &key, kind: &kind, body: &body, priority, author, author_name: &name },
        )?
    };
    crate::memory::notify_changed(app);
    Ok(json!({
        "entryId": result.entry_id,
        "revision": result.revision,
        "status": "pending",
        "message": "Proposta enviada. Fica pendente até o usuário aprovar na tela de Missões; você não precisa fazer mais nada.",
    }))
}

/// `ags memory search "<assunto>" --mission <id>`: busca por relevância nas memórias aprovadas
/// do workspace e da missão. Só lê; propor uma memória nova continua passando pelo usuário.
pub(super) fn memory_search(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let query = arg_str(args, "query")?;
    let limit = arg_u64_opt(args, "limit").unwrap_or(5) as usize;
    let at = match args.get("at") {
        Some(Value::String(value)) => Some(parse_memory_at(value)?),
        Some(Value::Number(value)) => Some(
            value
                .as_i64()
                .ok_or("--at must be Unix seconds or a supported date")?,
        ),
        Some(_) => return Err("--at must be Unix seconds or a supported date".into()),
        None => None,
    };
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mission = crate::missions::store::get(&conn, &id)?.ok_or_else(|| format!("no hay ninguna misión {id}"))?;
    let hits = match at {
        Some(at) => crate::memory::search::search_at(
            &conn,
            &mission.workspace_id,
            Some(&mission.id),
            &query,
            limit,
            at,
        )?,
        None => crate::memory::search::search(
            &conn,
            &mission.workspace_id,
            Some(&mission.id),
            &query,
            limit,
        )?,
    };
    Ok(match at {
        Some(at) => json!({ "query": query, "at": at, "results": hits }),
        None => json!({ "query": query, "results": hits }),
    })
}

fn parse_memory_at(value: &str) -> Result<i64, String> {
    if let Ok(timestamp) = value.parse::<i64>() {
        return Ok(timestamp);
    }
    let date_time = match value.len() {
        10 => chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0)),
        16 => chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").ok(),
        _ => None,
    };
    date_time
        .map(|date_time| date_time.and_utc().timestamp())
        .ok_or_else(|| "--at accepts YYYY-MM-DD, YYYY-MM-DDTHH:MM, or Unix seconds (UTC)".into())
}

/// `ags memory history --mission <id> --key <key> --scope workspace|mission`.
pub(super) fn memory_history(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let mission_id = arg_str(args, "mission")?;
    let key = crate::memory::normalize_key(&arg_str(args, "key")?)?;
    let scope = arg_str(args, "scope")?;
    if !matches!(scope.as_str(), "workspace" | "mission") {
        return Err("--scope must be workspace or mission".into());
    }

    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mission = crate::missions::store::get(&conn, &mission_id)?
        .ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
    let entry_id: String = match scope.as_str() {
        "workspace" => conn.query_row(
            "SELECT id FROM memory_entries WHERE workspace_id=?1 AND scope='workspace' AND key=?2",
            params![mission.workspace_id.as_str(), key.as_str()],
            |row| row.get(0),
        ),
        "mission" => conn.query_row(
            "SELECT id FROM memory_entries WHERE workspace_id=?1 AND mission_id=?2 AND scope='mission' AND key=?3",
            params![mission.workspace_id.as_str(), mission.id.as_str(), key.as_str()],
            |row| row.get(0),
        ),
        _ => unreachable!(),
    }
    .map_err(|_| format!("no {scope} memory entry with key {key}"))?;
    let history = crate::memory::history::history_for_entry(
        &conn,
        &mission.workspace_id,
        Some(&mission.id),
        &entry_id,
    )?;
    Ok(json!({ "entryId": entry_id, "scope": scope, "key": key, "history": history }))
}

/// `ags mission precheck <id>`: lo que el repositorio y las misiones anteriores ya dicen del objetivo.
pub(super) fn mission_precheck(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let db = db(app)?;
    crate::missions::check_launch_now(&db, &id, false)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(json!({ "mission": id, "findings": crate::missions::precheck_text(&conn, &id)? }))
}

/// `ags mission timings <id>`: dónde se fue el tiempo de la misión.
pub(super) fn mission_timings(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(json!(crate::missions::timings_of(&conn, &id)?))
}

pub(super) fn mission_accept(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let task = arg_str(args, "task")?;
    let base = dirs::home_dir().ok_or("no se pudo resolver el home")?.join(".ags").join("worktrees");
    let outcome = crate::missions::review::accept(&db(app)?, &base, &id, &task)?;
    crate::missions::notify(app, &id);
    Ok(json!(outcome))
}

pub(super) fn mission_apply(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "mission")?;
    let outcome = crate::missions::review::apply(&db(app)?, &id)?;
    crate::missions::notify(app, &id);
    Ok(json!(outcome))
}

pub(super) fn approval_list(_app: &AppHandle) -> Result<Value, String> {
    Ok(json!(crate::runs::pending_approvals()))
}

/// `ags approval decide <id> --allow|--deny [--remember]`.
pub(super) fn approval_decide(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "approval")?;
    let allow = match (args.get("allow").is_some(), args.get("deny").is_some()) {
        (true, false) => true,
        (false, true) => false,
        _ => return Err("decí --allow o --deny".into()),
    };
    let remember = args.get("remember").and_then(Value::as_bool).unwrap_or(false);
    let decided = crate::runs::decide_approval(app, &db(app)?, &id, allow, remember)?;
    if !decided {
        return Err("ese pedido ya no está esperando (venció o se canceló la tarea)".into());
    }
    Ok(json!({ "id": id, "allow": allow, "remembered": remember }))
}

#[cfg(test)]
mod memory_time_tests {
    use super::parse_memory_at;

    #[test]
    fn parses_unix_seconds_and_utc_date_forms() {
        assert_eq!(parse_memory_at("86400").unwrap(), 86_400);
        assert_eq!(parse_memory_at("1970-01-02").unwrap(), 86_400);
        assert_eq!(parse_memory_at("1970-01-01T00:02").unwrap(), 120);
        assert!(parse_memory_at("1970-1-1").is_err());
    }
}
