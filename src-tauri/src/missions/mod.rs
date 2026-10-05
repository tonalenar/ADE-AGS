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

pub(crate) mod review;
pub(crate) mod precheck;
pub(crate) mod failure;
pub(crate) mod duplicate;
pub(crate) mod store;
pub(crate) mod timings;
#[cfg(test)]
mod test;
mod types;
pub mod active;

pub use types::{
    FailureActionKey, FailureCategory, FailureClassification, Mission, MissionDetail,
    MissionInput, MissionSummary,
};
pub use duplicate::DuplicateMission;

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
    crate::bus::publish(Some(app), crate::bus::Publish::new("mission.changed").mission(mission_id));
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
pub(crate) fn create(
    conn: &Connection,
    workspace_id: &str,
    input: &MissionInput,
) -> Result<Mission, String> {
    let valid = store::validate(conn, input)?;
    store::create(conn, workspace_id, &valid)
}

pub(crate) fn update(
    conn: &Connection,
    mission_id: &str,
    input: &MissionInput,
) -> Result<Mission, String> {
    let valid = store::validate(conn, input)?;
    store::update(conn, mission_id, &valid)
}

/// La misión con sus runs, y las tareas y los hechos del run activo.
pub(crate) fn detail(conn: &Connection, mission_id: &str) -> Result<MissionDetail, String> {
    let mission = store::get(conn, mission_id)?
        .ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
    let runs = crate::runs::store::runs_of_mission(conn, &mission.id)?;
    let (tasks, facts) = match &mission.active_run_id {
        Some(run_id) => (
            crate::runs::store::tasks_of_run(conn, run_id)?,
            crate::runs::store::facts_of_run(conn, run_id)?,
        ),
        None => (Vec::new(), Vec::new()),
    };
    Ok(MissionDetail {
        mission,
        runs,
        tasks,
        facts,
    })
}

// ── Arrancar y cancelar ─────────────────────────────────────────

fn launch_request(mission: &Mission, squad: Option<&crate::squads::Squad>) -> (RouteRequest, Option<Complexity>) {
    if let Some(squad) = squad {
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
    }
}

/// Starts a draft or retries a failed mission with a new run and lead.
///
/// `route` y `launch` son el ruteo y el supervisor de `runs/`; se reciben para poder
/// probar el ciclo entero sin lanzar un agente.
///
/// Todo lo que se puede validar se valida ANTES de crear el run. Después, el run, el lead y
/// el paso a `running` van en una sola transacción: una misión corriendo sin run no puede
/// existir. Si lo que falla es el lanzamiento, el run y el lead quedan fallidos con el
/// motivo, y la misión los sigue a `failed`.
#[allow(dead_code)]
pub(crate) fn start(
    db: &DbConnection,
    mission_id: &str,
    route: impl FnOnce(&RouteRequest) -> Result<Assignment, String>,
    launch: impl FnOnce(&Task) -> Result<(), String>,
) -> Result<Mission, String> {
    start_with_force(db, mission_id, false, route, launch)
}

pub(crate) fn start_with_force(
    db: &DbConnection,
    mission_id: &str,
    force: bool,
    route: impl FnOnce(&RouteRequest) -> Result<Assignment, String>,
    launch: impl FnOnce(&Task) -> Result<(), String>,
) -> Result<Mission, String> {
    let (mission, squad) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if !force {
            if let Some(dup) = duplicate::check_mission_duplicate(&conn, mission_id, crate::util::now_ts())? {
                return Err(if dup.is_running {
                    "missions.error.duplicateRunning".into()
                } else {
                    "missions.error.duplicateRecent".into()
                });
            }
        }
        let mission = store::get(&conn, mission_id)?
            .ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
        let squad = mission
            .squad_id
            .as_deref()
            .map(|id| {
                crate::squads::store::get(&conn, id)?
                    .ok_or_else(|| format!("no squad '{id}' exists"))
            })
            .transpose()?;
        (mission, squad)
    };
    if !matches!(mission.status.as_str(), status::DRAFT | status::FAILED) {
        return Err("missions.error.notStartable".into());
    }
    if !Path::new(&mission.cwd).is_dir() {
        return Err(format!("la carpeta {} no existe", mission.cwd));
    }
    if let Some(squad) = &squad {
        if !squad.available {
            return Err(format!(
                "Squad '{}' unavailable: {}",
                squad.name,
                squad.unavailable_reasons.join("; ")
            ));
        }
    }
    if let Some(agent) = squad
        .as_ref()
        .map(|s| &s.lead.agent_id)
        .or(mission.lead_agent_id.as_ref())
    {
        crate::runs::ensure_orchestration(agent)?;
    }

    let (request, complexity) = launch_request(&mission, squad.as_ref());
    let assignment = route(&request)?;

    let spec = crate::runs::Orchestration {
        reasoning_effort: squad.as_ref().and_then(|team| team.lead.reasoning_effort.as_deref()).or(mission.reasoning_effort.as_deref()),
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
        if store::mark_started(conn, &mission, &lead.run_id)? {
            Ok(())
        } else {
            Err("missions.error.changed".to_string())
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
        store::get(&conn, mission_id)?
            .ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?
    };
    match mission.status.as_str() {
        status::DRAFT => {
            let conn = db.lock().map_err(|e| e.to_string())?;
            if !store::cancel_draft(&conn, mission_id)? {
                return Err(
                    "la misión arrancó mientras tanto: volvé a intentar para cancelar su run"
                        .into(),
                );
            }
        }
        // En terminales no hay run: cancelarla es cerrarla (las tabs las cierra la pantalla).
        status::RUNNING if mission.active_run_id.is_none() => {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::close_terminals(&conn, mission_id, status::CANCELLED)?;
        }
        status::RUNNING => {
            let run_id = mission
                .active_run_id
                .as_deref()
                .ok_or("la misión corre sin run activo")?;
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
pub fn mission_list(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<MissionSummary>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list(&conn, &workspace_id)
}

#[tauri::command]
pub fn mission_get(
    mission_id: String,
    db: tauri::State<DbConnection>,
) -> Result<MissionDetail, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    detail(&conn, &mission_id)
}

/// Fuera del hilo async: el ruteo puede sondear el roster, que lanza procesos para
/// preguntarles versión y modelos.
#[tauri::command]
pub async fn mission_start(app: AppHandle, mission_id: String, force: Option<bool>) -> Result<Mission, String> {
    let force_val = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || start_now_with_force(&app, &mission_id, force_val))
        .await
        .map_err(|e| e.to_string())?
}

/// Arranca (o reintenta) una misión en el hilo actual. Bloquea: el ruteo puede sondear el
/// roster. Lo usan la pantalla y la CLI (`ags mission start|run`).
pub(crate) fn start_now(app: &AppHandle, mission_id: &str) -> Result<Mission, String> {
    start_now_with_force(app, mission_id, false)
}

pub(crate) fn start_now_with_force(app: &AppHandle, mission_id: &str, force: bool) -> Result<Mission, String> {
    let db = db_of(app)?;
    let result = start_with_force(
        &db,
        mission_id,
        force,
        |request| crate::runs::route_lead_now(&db, request),
        |lead| crate::runs::launch_lead(app, lead),
    );
    // También si falló: un lead que no se pudo lanzar deja la misión en `failed`.
    notify(app, mission_id);
    result
}

/// Crea una misión en borrador. Para la CLI: la pantalla usa `mission_create`.
pub(crate) fn create_now(app: &AppHandle, workspace_id: &str, input: &MissionInput) -> Result<Mission, String> {
    let db = db_of(app)?;
    let mission = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        create(&conn, workspace_id, input)?
    };
    notify(app, &mission.id);
    Ok(mission)
}

/// El detalle de una misión: ella, sus runs y las tareas del run activo.
pub(crate) fn detail_now(app: &AppHandle, mission_id: &str) -> Result<MissionDetail, String> {
    let db = db_of(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    detail(&conn, mission_id)
}

/// Lo que entregó cada tarea aislada del run actual, y cómo va su revisión.
#[tauri::command]
pub async fn mission_review(app: AppHandle, mission_id: String) -> Result<review::MissionReview, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        review::review(&conn, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_task_diff(app: AppHandle, task_id: String) -> Result<String, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        review::task_diff(&conn, &task_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Junta la entrega en la integración de la misión. Ver `review::accept`.
#[tauri::command]
pub async fn mission_accept_task(app: AppHandle, mission_id: String, task_id: String) -> Result<review::MergeOutcome, String> {
    let db = db_of(&app)?;
    let base = dirs::home_dir().ok_or("no se pudo resolver el home")?.join(".ags").join("worktrees");
    let id = mission_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || review::accept(&db, &base, &id, &task_id))
        .await
        .map_err(|e| e.to_string())?;
    notify(&app, &mission_id);
    outcome
}

#[tauri::command]
pub fn mission_reject_task(app: AppHandle, mission_id: String, task_id: String) -> Result<(), String> {
    let db = db_of(&app)?;
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        review::set_review(&conn, &task_id, Some("rejected"), None)?;
    }
    notify(&app, &mission_id);
    Ok(())
}

/// Lleva al proyecto lo aceptado. Ver `review::apply`.
#[tauri::command]
pub async fn mission_apply(app: AppHandle, mission_id: String) -> Result<review::MergeOutcome, String> {
    let db = db_of(&app)?;
    let id = mission_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || review::apply(&db, &id))
        .await
        .map_err(|e| e.to_string())?;
    notify(&app, &mission_id);
    outcome
}

pub(crate) fn check_launch_now(db: &DbConnection, mission_id: &str, terminals: bool) -> Result<(), String> {
    let (mission, squad) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mission = store::get(&conn, mission_id)?.ok_or("missions.error.changed")?;
        let squad = mission.squad_id.as_deref().map(|id| crate::squads::store::get(&conn, id)).transpose()?.flatten();
        (mission, squad)
    };
    let (request, _) = launch_request(&mission, squad.as_ref());
    if terminals {
        // Auto means system account in startMissionInTerminals, not headless routing.
        let roster = crate::runs::roster::snapshot(db, false)?;
        let lead_agent = squad.as_ref().map(|s| s.lead.agent_id.clone()).or(mission.lead_agent_id.clone()).unwrap_or_else(|| "claude-code".into());
        let lead_model = squad.as_ref().and_then(|s| s.lead.model.clone()).or(mission.lead_model.clone());
        let lead_account = match &squad {
            Some(s) if !s.lead.auto_account => s.lead.account_id.clone(),
            _ if !mission.auto_account => mission.lead_account_id.clone(),
            _ => None,
        };
        let mut actors = vec![(lead_agent, lead_model, lead_account)];
        if let Some(squad) = &squad {
            actors.extend(squad.members.iter().map(|m| (m.agent_id.clone(), m.model.clone(), if m.auto_account { None } else { m.account_id.clone() })));
        }
        for (agent_id, model, account_id) in actors {
            let assignment = crate::runs::routing::Assignment { agent_id, model, account_id,
                routed_by: crate::runs::routing::RoutedBy::Manual, notes: vec![], auto_account: false, pool_origin: None };
            precheck::validate_launch(&roster, &assignment, crate::util::now_ts())?;
        }
        Ok(())
    } else { crate::runs::route_lead_now(db, &request).map(|_| ()) }
}

/// Arranca la misión en terminales: solo la marca; abrir las tabs es de la pantalla.
#[tauri::command]
pub fn mission_start_terminals(app: AppHandle, mission_id: String, force: Option<bool>) -> Result<Mission, String> {
    let _update_guard = crate::agents::updates::activity_guard()?;
    let db = db_of(&app)?;
    check_launch_now(&db, &mission_id, true)?;
    if !force.unwrap_or(false) {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Some(dup) = duplicate::check_mission_duplicate(&conn, &mission_id, crate::util::now_ts())? {
            return Err(if dup.is_running {
                "missions.error.duplicateRunning".into()
            } else {
                "missions.error.duplicateRecent".into()
            });
        }
    }
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mission = store::get(&conn, &mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
        if mission.status != status::DRAFT && mission.status != status::FAILED {
            return Err(format!("la misión ya está en estado '{}'", mission.status));
        }
        if !store::mark_started_terminals(&conn, &mission_id)? {
            return Err("la misión cambió de estado mientras tanto".into());
        }
    }
    notify(&app, &mission_id);
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::get(&conn, &mission_id)?.ok_or_else(|| "la misión desapareció".to_string())
}

#[tauri::command]
pub fn mission_check_duplicate(app: AppHandle, mission_id: String) -> Result<Option<DuplicateMission>, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    duplicate::check_mission_duplicate(&conn, &mission_id, crate::util::now_ts())
}

#[tauri::command]
pub fn mission_check_duplicate_input(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    title: String,
    objective: String,
    current_id: Option<String>,
) -> Result<Option<DuplicateMission>, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    duplicate::check_duplicate(
        &conn,
        current_id.as_deref(),
        Some(&workspace_id),
        Some(&cwd),
        &title,
        Some(&objective),
        crate::util::now_ts(),
    )
}

/// Da por terminada una misión en terminales.
#[tauri::command]
pub fn mission_finish_terminals(app: AppHandle, mission_id: String) -> Result<Mission, String> {
    let db = db_of(&app)?;
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if !store::close_terminals(&conn, &mission_id, status::DONE)? {
            return Err("Solo se termina a mano una misión en terminales que está corriendo.".into());
        }
    }
    notify(&app, &mission_id);
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::get(&conn, &mission_id)?.ok_or_else(|| "la misión desapareció".to_string())
}

#[tauri::command]
pub fn mission_cancel(app: AppHandle, mission_id: String) -> Result<Mission, String> {
    let db = db_of(&app)?;
    let result = cancel(&db, &mission_id, |run_id| {
        crate::runs::cancel_run(&app, run_id)
    });
    notify(&app, &mission_id);
    result
}

// ── Cronómetro ──────────────────────────────────────────────────────

/// Graba el tiempo de una etapa de la misión (ver `timings`).
#[tauri::command]
pub fn mission_timing_add(app: AppHandle, mission_id: String, span: timings::NewSpan) -> Result<(), String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    timings::add(&conn, &mission_id, &span)
}

/// Suma tiempo de trabajo real a una misión en curso (ver `active`).
#[tauri::command]
pub fn mission_active_add(app: AppHandle, mission_id: String, ms: i64) -> Result<(), String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    active::add(&conn, &mission_id, ms)
}

/// Los tiempos de una misión y su resumen: dónde se fue el tiempo.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTimings {
    pub spans: Vec<timings::Span>,
    pub summary: timings::Summary,
}

pub(crate) fn timings_of(conn: &Connection, mission_id: &str) -> Result<MissionTimings, String> {
    let spans = timings::list(conn, mission_id)?;
    let summary = timings::summarize(&spans, 5);
    Ok(MissionTimings { spans, summary })
}

#[tauri::command]
pub fn mission_timings(app: AppHandle, mission_id: String) -> Result<MissionTimings, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    timings_of(&conn, &mission_id)
}

// ── Checagem do que já existe ───────────────────────────────────────

/// O texto do briefing com o que o repositório e as missões anteriores já dizem sobre o
/// objetivo (ver `precheck`). Vazio se não há nada a dizer.
pub(crate) fn precheck_text(conn: &Connection, mission_id: &str) -> Result<String, String> {
    let mission = store::get(conn, mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
    Ok(precheck::render(&precheck::run(conn, &mission.id, &mission.cwd, &mission.objective)))
}

#[tauri::command]
pub async fn mission_precheck(app: AppHandle, mission_id: String) -> Result<String, String> {
    let db = db_of(&app)?;
    // git corre fuera del hilo de la UI y sin mantener el candado de la base más de lo necesario.
    tokio::task::spawn_blocking(move || {
        check_launch_now(&db, &mission_id, true)?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        precheck_text(&conn, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Memoria del proyecto en el briefing ─────────────────────────────

/// El bloque de memoria aprobada (workspace + misión) para el briefing del Orquestador. Vacío si
/// no hay nada. Solo lee.
pub(crate) fn memory_context_text(conn: &Connection, mission_id: &str) -> Result<String, String> {
    let mission = store::get(conn, mission_id)?.ok_or_else(|| format!("no hay ninguna misión {mission_id}"))?;
    let docs = crate::memory::search::load_docs(conn, &mission.workspace_id, Some(&mission.id))?;
    Ok(crate::memory::search::briefing_block(&docs, &mission.id, 8, 1_800))
}

#[tauri::command]
pub fn mission_memory_context(app: AppHandle, mission_id: String) -> Result<String, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    memory_context_text(&conn, &mission_id)
}
