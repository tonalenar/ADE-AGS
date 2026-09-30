//! Misiones: lo que el usuario quiere lograr, por encima de los intentos de lograrlo.
//!
//! Una misión no ejecuta nada por sí misma. Es dominio: el objetivo, la carpeta y la
//! preferencia de cómo correrlo. La ejecución sigue siendo de `runs/` —run, lead, workers,
//! scheduler, supervisor, worktrees—, y una misión solo apunta al run que la está
//! cumpliendo.
//!
//! ```text
//! Workspace → Mission → Run → Task → Agent
//! ```
//!
//! Crear o editar una misión es solo base: ningún PTY, proceso headless ni worktree nace
//! por eso. El único camino que lanza algo es `start`, y lo hace con el mismo
//! `runs::start_orchestration` que usa la flota.

pub(crate) mod store;
mod types;
#[cfg(test)]
mod test;

pub use types::{Mission, MissionDetail, MissionInput, MissionSummary};

use std::path::Path;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::database::DbConnection;
use crate::runs::routing::{Assignment, RouteRequest};
use crate::runs::{Complexity, Task};

use types::status;

/// "Esta misión cambió": la creación, una edición, el arranque, el cierre y la cancelación.
/// Lleva solo el id; cada vista recarga lo suyo. El avance de las tareas va por
/// `cc-task-changed` y la cola de permisos por `cc-task-approvals`, como en la flota.
pub const MISSION_CHANGED: &str = "cc-mission-changed";

pub(crate) fn notify<R: Runtime>(app: &AppHandle<R>, mission_id: &str) {
    let _ = app.emit(MISSION_CHANGED, mission_id);
}

/// Avisa por la misión que el run está cumpliendo, si hay.
pub(crate) fn notify_for_run<R: Runtime>(app: &AppHandle<R>, conn: &Connection, run_id: &str) {
    if let Ok(Some(id)) = store::mission_of_run(conn, run_id) {
        notify(app, &id);
    }
}

fn db_of(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone())
}

// ── Lo que no lanza nada ────────────────────────────────────────

/// Un borrador nuevo. Solo escribe la fila.
pub(crate) fn create(conn: &Connection, workspace_id: &str, input: &MissionInput) -> Result<Mission, String> {
    let valid = store::validate(conn, input)?;
    store::create(conn, workspace_id, &valid)
}

pub(crate) fn update(conn: &Connection, mission_id: &str, input: &MissionInput) -> Result<Mission, String> {
    let valid = store::validate(conn, input)?;
    store::update(conn, mission_id, &valid)
}

/// La misión con sus runs, y las tareas y los hechos del run activo.
pub(crate) fn detail(conn: &Connection, mission_id: &str) -> Result<MissionDetail, String> {
    let mission = store::get(conn, mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
    let runs = crate::runs::store::runs_of_mission(conn, &mission.id)?;
    let (tasks, facts) = match &mission.active_run_id {
        Some(run_id) => (
            crate::runs::store::tasks_of_run(conn, run_id)?,
            crate::runs::store::facts_of_run(conn, run_id)?,
        ),
        None => (Vec::new(), Vec::new()),
    };
    Ok(MissionDetail { mission, runs, tasks, facts })
}

// ── Arrancar y cancelar ─────────────────────────────────────────

/// Arranca un borrador: rutea el lead, crea su run atado a la misión y lo lanza.
///
/// `route` y `launch` son el ruteo y el supervisor de `runs/`; se reciben para poder
/// probar el ciclo entero sin lanzar un agente.
///
/// Todo lo que se puede validar se valida ANTES de crear el run. Después, el run, el lead y
/// el paso a `running` van en una sola transacción: una misión corriendo sin run no puede
/// existir. Si lo que falla es el lanzamiento, el run y el lead quedan fallidos con el
/// motivo, y la misión los sigue a `failed`.
pub(crate) fn start(
    db: &DbConnection,
    mission_id: &str,
    route: impl FnOnce(&RouteRequest) -> Result<Assignment, String>,
    launch: impl FnOnce(&Task) -> Result<(), String>,
) -> Result<Mission, String> {
    let (mission, squad) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mission = store::get(&conn, mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
        let squad = mission
            .squad_id
            .as_deref()
            .map(|id| crate::squads::store::get(&conn, id)?.ok_or_else(|| format!("no squad '{id}' exists")))
            .transpose()?;
        (mission, squad)
    };
    if mission.status != status::DRAFT {
        return Err(format!("la misión ya no es un borrador ({})", mission.status));
    }
    if !Path::new(&mission.cwd).is_dir() {
        return Err(format!("la carpeta {} no existe", mission.cwd));
    }
    if let Some(squad) = &squad {
        if !squad.available {
            return Err(format!("Squad '{}' unavailable: {}", squad.name, squad.unavailable_reasons.join("; ")));
        }
    }
    if let Some(agent) = squad.as_ref().map(|s| &s.lead.agent_id).or(mission.lead_agent_id.as_ref()) {
        crate::runs::ensure_headless(agent)?;
    }

    let (request, complexity) = if let Some(squad) = &squad {
        crate::runs::lead_request(
            Some(squad.lead.agent_id.clone()),
            squad.lead.model.clone(),
            squad.lead.complexity.as_deref().and_then(Complexity::parse),
            squad.lead.account_id.clone(),
            squad.lead.auto_account,
        )
    } else {
        crate::runs::lead_request(
            mission.lead_agent_id.clone(),
            mission.lead_model.clone(),
            mission.complexity.as_deref().and_then(Complexity::parse),
            mission.lead_account_id.clone(),
            mission.auto_account,
        )
    };
    let assignment = route(&request)?;

    let spec = crate::runs::Orchestration {
        workspace_id: &mission.workspace_id,
        cwd: &mission.cwd,
        objective: &mission.objective,
        title: Some(&mission.title),
        max_parallel: mission.max_parallel,
        budget_usd: mission.budget_usd,
        mission_id: Some(&mission.id),
        squad: squad.as_ref(),
    };
    let mark = |conn: &Connection, lead: &Task| {
        if store::mark_started(conn, &mission.id, &lead.run_id)? {
            Ok(())
        } else {
            Err("la misión ya se había arrancado".to_string())
        }
    };
    crate::runs::start_orchestration(db, &spec, &assignment, complexity, mark, launch)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::get(&conn, mission_id)?.ok_or_else(|| "la misión se perdió al arrancarla".to_string())
}

/// Cancela una misión. Un borrador se marca y listo; una que corre cancela su run activo
/// con `cancel_run`, y su estado lo arrastra `refresh_run_status` como a cualquier run.
pub(crate) fn cancel(
    db: &DbConnection,
    mission_id: &str,
    cancel_run: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Mission, String> {
    let mission = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::get(&conn, mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?
    };
    match mission.status.as_str() {
        status::DRAFT => {
            let conn = db.lock().map_err(|e| e.to_string())?;
            if !store::cancel_draft(&conn, mission_id)? {
                return Err("la misión arrancó mientras tanto: volvé a intentar para cancelar su run".into());
            }
        }
        status::RUNNING => {
            let run_id = mission.active_run_id.as_deref().ok_or("la misión corre sin run activo")?;
            cancel_run(run_id)?;
        }
        other => return Err(format!("la misión ya terminó ({other})")),
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::get(&conn, mission_id)?.ok_or_else(|| "la misión se perdió".to_string())
}

// ── Comandos ────────────────────────────────────────────────────

#[tauri::command]
pub fn mission_create<R: Runtime>(
    app: AppHandle<R>,
    workspace_id: String,
    input: MissionInput,
    db: tauri::State<DbConnection>,
) -> Result<Mission, String> {
    let mission = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        create(&conn, &workspace_id, &input)?
    };
    notify(&app, &mission.id);
    Ok(mission)
}

#[tauri::command]
pub fn mission_update<R: Runtime>(
    app: AppHandle<R>,
    mission_id: String,
    input: MissionInput,
    db: tauri::State<DbConnection>,
) -> Result<Mission, String> {
    let mission = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        update(&conn, &mission_id, &input)?
    };
    notify(&app, &mission.id);
    Ok(mission)
}

#[tauri::command]
pub fn mission_list(workspace_id: String, db: tauri::State<DbConnection>) -> Result<Vec<MissionSummary>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list(&conn, &workspace_id)
}

#[tauri::command]
pub fn mission_get(mission_id: String, db: tauri::State<DbConnection>) -> Result<MissionDetail, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    detail(&conn, &mission_id)
}

/// Fuera del hilo async: el ruteo puede sondear el roster, que lanza procesos para
/// preguntarles versión y modelos.
#[tauri::command]
pub async fn mission_start(app: AppHandle, mission_id: String) -> Result<Mission, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = start(
            &db,
            &mission_id,
            |request| crate::runs::route_now(&db, request),
            |lead| crate::runs::launch_lead(&app, lead),
        );
        // También si falló: un lead que no se pudo lanzar deja la misión en `failed`.
        notify(&app, &mission_id);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mission_cancel(app: AppHandle, mission_id: String) -> Result<Mission, String> {
    let db = db_of(&app)?;
    let result = cancel(&db, &mission_id, |run_id| crate::runs::cancel_run(&app, run_id));
    notify(&app, &mission_id);
    result
}
