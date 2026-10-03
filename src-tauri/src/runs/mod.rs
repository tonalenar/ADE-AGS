//! Agentes headless: los que corren sin terminal y sin que nadie los mire.
//!
//! Un agente de una tab es un PTY que el usuario mira y tipea. Uno de acá es un proceso
//! con el stdout redirigido del que la app es dueña de punta a punta: emite eventos
//! estructurados en vez de pixeles, así que qué archivo tocó, cuánto costó y si terminó
//! bien vienen **como datos** y no hay que inferirlos de una pantalla redibujada.
//!
//! Eso es lo que hace posible la consola de flota: ver de un vistazo qué está haciendo
//! cada agente. La capa de `orchestrator::{digest,cursors,watch}` sigue siendo para las
//! tabs interactivas y no se toca — acá no hace falta comprimir nada.

mod activity;
mod adapters;
mod agents;
mod antigravity;
mod broker;
mod context;
pub(crate) mod failure;
pub(crate) mod handoff;
pub(crate) mod ledger;
pub(crate) mod model_discovery;
pub mod orchestration;
mod plan;
mod policy;
pub(crate) mod quota;
pub(crate) mod roster;
pub mod checkpoints;
pub(crate) mod routing;
mod rules;
pub mod sandbox;
mod scheduler;
pub(crate) mod store;
mod supervisor;
#[cfg(test)]
mod test;
pub(crate) mod types;
pub(crate) mod worktrees;

pub(crate) use adapters::{Codex, Gemini, Kimi, OpenCode};
pub(crate) use agents::{ClaudeCode, HeadlessAgent};
pub(crate) use antigravity::Antigravity;
pub(crate) use routing::Complexity;
pub use store::sweep_orphans;
pub use types::{Fact, Run, Task};

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

fn db_of(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone())
}

/// Las tarjetas de un workspace, más recientes primero.
#[tauri::command]
pub fn run_list_tasks(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_tasks(&conn, &workspace_id)
}

#[tauri::command]
pub fn run_list_runs(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Run>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_runs(&conn, &workspace_id)
}

/// Asigna la tarea, la crea y la lanza.
///
/// Por ahora cada lanzamiento abre su propio run. Cuando entre el DAG, un run pasará a
/// agrupar varias tareas con sus dependencias; la forma ya está para eso.
///
/// El modelo y la cuenta salen del ruteo (`routing::route`): o se nombran, o se declara la
/// complejidad y elige la app. Si no hay a quién asignarla, vuelve el motivo y NO se crea
/// la fila: no se lanzó nada, y lo que hay que hacer es cambiar el pedido, no diagnosticar
/// una tarjeta fallida.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_start_task(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    title: String,
    prompt: String,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    // Que la cuenta la elija el ruteo. Con `false`, `account_id` manda (y `None` es la del
    // sistema).
    auto_account: bool,
    budget_usd: Option<f64>,
    // En su propio worktree. Es lo que hace seguro lanzar un segundo agente sobre una
    // carpeta en la que ya trabaja otro.
    isolate: bool,
) -> Result<Task, String> {
    let db = db_of(&app)?;
    let request = route_request(agent_id, model, complexity, account_id, auto_account);
    let assignment = assign(&db, request).await?;
    let note = (!assignment.notes.is_empty()).then(|| assignment.notes.join("\n"));

    let mut task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e|e.to_string())?;
        let run = store::create_run(&tx, &workspace_id, &title, &cwd)?;
        let task = store::create_task(
            &tx,
            &store::NewTask {
                run_id: &run.id,
                title: &title,
                prompt: &prompt,
                agent_id: &assignment.agent_id,
                account_id: assignment.account_id.as_deref(),
                auto_account: assignment.auto_account,
                model: assignment.model.as_deref(),
                reasoning_effort: None,
                cwd: &cwd,
                budget_usd,
                complexity: complexity.map(routing::Complexity::as_str),
                routed_by: Some(assignment.routed_by.as_str()),
                route_note: note.as_deref(),
                ..Default::default()
            },
        )?;
        tx.commit().map_err(|e|e.to_string())?;
        task
    };

    // Si el lanzamiento falla, la fila queda igual pero como fallida: una tarea que
    // desaparece sin dejar rastro no se puede diagnosticar, y el motivo (un binario que
    // no está, una cuenta borrada, una carpeta que no es un repo) es justo lo que hay que
    // mostrar.
    let fail = |task_id: &str, e: String| -> Result<Task, String> {
        let conn = db.lock().map_err(|err| err.to_string())?;
        store::finish_task(&conn, task_id, &types::TaskOutcome::failed(e.clone()))?;
        Err(e)
    };

    if isolate {
        match worktrees_base().and_then(|base| isolate_task(&base, &db, &task)) {
            Ok(isolated) => task = isolated,
            Err(e) => return fail(&task.id, e),
        }
    }

    let memory = {let conn=db.lock().map_err(|e|e.to_string())?; crate::memory::snapshot_context_for_run(&conn,&task.run_id)?};
    let extras=supervisor::LaunchExtras {prompt:Some(format!("{}{memory}",task.prompt)), ..Default::default()};
    if let Err(e) = supervisor::start(&app, task.clone(), extras) {
        return fail(&task.id, e);
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al lanzarla".into())
}

/// Lanza un lead: el agente que va a repartir `objective` en tareas para otros agentes.
///
/// El run nace con el paralelismo y el presupuesto que se piden acá; el plan lo declara el
/// lead cuando entiende el proyecto. Sin modelo ni complejidad, el lead va a `hard`: de
/// cómo reparte depende lo que cuesta todo lo demás.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_start_orchestration(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    objective: String,
    max_parallel: i64,
    budget_usd: Option<f64>,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> Result<Task, String> {
    let db = db_of(&app)?;
    let (request, complexity) = lead_request(agent_id, model, complexity, account_id, auto_account);
    let routing_db = db.clone();
    let assignment =
        tauri::async_runtime::spawn_blocking(move || route_lead_now(&routing_db, &request))
            .await
            .map_err(|error| error.to_string())??;
    let spec = Orchestration {
        reasoning_effort: None,
        workspace_id: &workspace_id,
        cwd: &cwd,
        objective: &objective,
        title: None,
        max_parallel,
        budget_usd,
        mission_id: None,
        squad: None,
    };
    start_orchestration(
        &db,
        &spec,
        &assignment,
        complexity,
        |_, _| Ok(()),
        |task| launch_lead(&app, task),
    )
}

/// Lo que define un run orquestado, venga de la flota o de una misión.
pub(crate) struct Orchestration<'a> {
    pub reasoning_effort: Option<&'a str>,
    pub workspace_id: &'a str,
    pub cwd: &'a str,
    pub objective: &'a str,
    /// El título de la tarjeta del lead. `None` = la primera línea del objetivo.
    pub title: Option<&'a str>,
    pub max_parallel: i64,
    pub budget_usd: Option<f64>,
    pub mission_id: Option<&'a str>,
    pub squad: Option<&'a crate::squads::Squad>,
}

/// El pedido de ruteo de un lead. Sin modelo ni complejidad va a `hard`: de cómo reparte
/// depende lo que cuesta todo lo demás.
pub(crate) fn lead_request(
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> (routing::RouteRequest, Option<routing::Complexity>) {
    let complexity =
        complexity.or((agent_id.is_none() && model.is_none()).then_some(routing::Complexity::Hard));
    (
        route_request(agent_id, model, complexity, account_id, auto_account),
        complexity,
    )
}

/// Crea el run y su lead, y lo lanza con `launch`.
///
/// El run y el lead se crean en UNA transacción junto con lo que `on_created` escriba (una
/// misión se marca corriendo ahí): o queda todo, o nada. Si después el lanzamiento falla,
/// las filas quedan como fallidas —el motivo es lo que hay que poder ver— y el estado se
/// recalcula por `refresh_run_status`, que es quien arrastra a la misión.
pub(crate) fn start_orchestration(
    db: &DbConnection,
    spec: &Orchestration,
    assignment: &routing::Assignment,
    complexity: Option<routing::Complexity>,
    on_created: impl FnOnce(&rusqlite::Connection, &Task) -> Result<(), String>,
    launch: impl FnOnce(&Task) -> Result<(), String>,
) -> Result<Task, String> {
    let objective = spec.objective.trim();
    if objective.is_empty() {
        return Err("falta el objetivo".into());
    }
    // Antes de crear nada: una fila de un lead que nunca podía lanzarse es ruido.
    ensure_orchestration(&assignment.agent_id)?;
    if spec.reasoning_effort.is_some() {
        roster::validate_effort(
            &roster::snapshot(db, false)?,
            &assignment.agent_id,
            assignment.account_id.as_deref(),
            assignment.model.as_deref(),
            spec.reasoning_effort,
        )?;
    }
    let note = (!assignment.notes.is_empty()).then(|| assignment.notes.join("\n"));
    let max_parallel = spec.max_parallel.clamp(1, 6);

    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let run = store::create_run_with_memory_snapshot(
            &tx,
            spec.workspace_id,
            spec.mission_id,
            objective,
            spec.cwd,
            max_parallel,
            spec.budget_usd,
        )?;
if let Some(squad) = spec.squad {
            store::set_run_squad_snapshot(&tx, &run.id, squad)?;
        }
        let title: String = match spec.title {
            Some(t) => t.chars().take(80).collect(),
            None => objective
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect(),
        };
        let budget = spec.budget_usd
            .map(|b| format!(" El run tiene un presupuesto de ${b:.2}: ninguna tarea nueva arranca después de gastarlo."))
            .unwrap_or_default();
        let prompt = format!("{objective}\n\n(Hasta {max_parallel} tareas en paralelo.{budget})");
        let task = store::create_task(
            &tx,
            &store::NewTask {
                run_id: &run.id,
                title: &title,
                prompt: &prompt,
                agent_id: &assignment.agent_id,
                account_id: assignment.account_id.as_deref(),
                auto_account: assignment.auto_account,
                model: assignment.model.as_deref(),
                reasoning_effort: spec.reasoning_effort,
                cwd: spec.cwd,
                complexity: complexity.map(routing::Complexity::as_str),
                routed_by: Some(assignment.routed_by.as_str()),
                route_note: note.as_deref(),
                role: Some(types::role::LEAD),
                ..Default::default()
            },
        )?;
        on_created(&tx, &task)?;
        tx.commit().map_err(|e| e.to_string())?;
        task
    };

    if let Err(e) = launch(&task) {
        let conn = db.lock().map_err(|err| err.to_string())?;
        store::finish_task(&conn, &task.id, &types::TaskOutcome::failed(e.clone()))?;
        store::refresh_run_status(&conn, &task.run_id)?;
        return Err(e);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al lanzarla".into())
}

/// Lanza un lead por el supervisor, con las tools de orquestación: leer el run, dejar hechos
/// y repartir tareas.
pub(crate) fn launch_lead(app: &AppHandle, task: &Task) -> Result<(), String> {
    use crate::ipc::mcp::{
        OrchestrationPower::*, orchestration_tool_name, orchestration_tool_names,
    };
    let db = db_of(app)?;
    let run = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        store::run_by_id(&conn, &task.run_id)?
            .ok_or_else(|| "the lead's Run no longer exists".to_string())?
    };
    let snapshot = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        crate::memory::snapshot_context_for_run(&conn, &run.id)?
    };
    let mut system_prompt = context::LEAD_SYSTEM_PROMPT.to_string();
    let mut allowed_tools = orchestration_tool_names(&[Read, Note, Spawn]);
    if run.squad_id.is_some() {
        system_prompt.push_str(&context::lead_squad_context(&run.squad_members));
        // A Squad lead chooses work roles. It cannot inspect or optimize provider routing.
        let roster_tool = orchestration_tool_name("agent_roster");
        allowed_tools.retain(|tool| tool != &roster_tool);
    }
    let extras = supervisor::LaunchExtras {
        prompt: (!snapshot.is_empty()).then(|| format!("{}\n{snapshot}", task.prompt)),
        system_prompt: Some(system_prompt),
        allowed_tools,
    };
    supervisor::start(app, task.clone(), extras)
}

/// Lanza una tarea de un plan que le tocó correr: su worktree si va aislada, y su prompt con
/// lo que entregaron sus dependencias y los hechos del run. `false` si no se pudo — la fila
/// ya queda cerrada como fallida, y quien despacha tiene que volver a mirar el run.
pub(crate) fn launch_planned(app: &AppHandle, db: &DbConnection, task: Task) -> bool {
    let task_id = task.id.clone();
    let launched = (|| -> Result<(), String> {
        let (run, deps, facts) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let run = store::run_by_id(&conn, &task.run_id)?.ok_or("el run ya no existe")?;
            let mut deps = Vec::new();
            for id in &task.depends_on {
                if let Some(dep) = store::task_by_id(&conn, id)? {
                    deps.push(dep);
                }
            }
            let facts = store::facts_of_run(&conn, &run.id)?;
            (run, deps, facts)
        };

        // De qué rama parte: la de su única dependencia aislada, para empezar desde lo que
        // esa dejó. Con varias, desde HEAD, y el prompt le pide integrarlas primero.
        let dep_branches: Vec<String> = deps
            .iter()
            .filter(|d| !d.worktree_removed)
            .filter_map(|d| d.branch.clone())
            .collect();
        let mut task = task.clone();
        if task.isolate {
            let start = if dep_branches.len() == 1 {
                dep_branches[0].as_str()
            } else {
                "HEAD"
            };
            task = isolate_task_from(&worktrees_base()?, db, &task, start)?;
        }
        let to_merge: &[String] = if task.isolate && dep_branches.len() > 1 {
            &dep_branches
        } else {
            &[]
        };

        let deps_refs: Vec<&Task> = deps.iter().collect();
        let snapshot = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            crate::memory::snapshot_context_for_run(&conn, &run.id)?
        };
        let prompt = format!(
            "{}{}",
            context::worker_prompt(&task, &run.objective, &deps_refs, &facts, to_merge),
            snapshot
        );
        let can_delegate = task.depth < plan::MAX_DEPTH;
        use crate::ipc::mcp::{
            OrchestrationPower::*, orchestration_tool_name, orchestration_tool_names,
        };
        let mut allowed = orchestration_tool_names(&[Read, Note, Delivery]);
        allowed.push(orchestration_tool_name(crate::ipc::mcp::ASK_TOOL));
        if can_delegate {
            allowed.push(orchestration_tool_name("task_add"));
        }
        supervisor::start(
            app,
            task.clone(),
            supervisor::LaunchExtras {
                prompt: Some(prompt),
                system_prompt: Some(context::worker_system_prompt(&task, can_delegate)),
                allowed_tools: allowed,
            },
        )
    })();

    match launched {
        Ok(()) => true,
        Err(e) => {
            if let Ok(conn) = db.lock() {
                let _ = store::finish_task(&conn, &task_id, &types::TaskOutcome::failed(e));
            }
            supervisor::notify_changed(app, &task_id);
            false
        }
    }
}

/// Para un run entero: lo que espera no arranca y lo que corre se detiene.
#[tauri::command]
pub fn run_cancel_run(app: AppHandle, run_id: String) -> Result<(), String> {
    cancel_run(&app, &run_id)
}

pub(crate) fn cancel_run(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let db = db_of(app)?;
    let ids = cancel_run_with(&db, run_id, |id| supervisor::cancel(app, id))?;
    scheduler::bump(run_id);
    for id in &ids {
        supervisor::notify_changed(app, id);
    }
    // Cancelado desde la flota: la misión que lo cumplía también cambió.
    if let Ok(conn) = db.lock() {
        crate::missions::notify_for_run(app, &conn, run_id);
    }
    Ok(())
}

/// Cancela lo que espera, para lo que corre con `stop` y recalcula el run. Devuelve las
/// tareas del run, para avisar que cambiaron.
pub(crate) fn cancel_run_with(
    db: &DbConnection,
    run_id: &str,
    mut stop: impl FnMut(&str) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let live: Vec<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::cancel_pending(&conn, run_id, "se canceló el run")?;
        store::tasks_of_run(&conn, run_id)?
            .into_iter()
            .filter(|t| {
                matches!(
                    t.status.as_str(),
                    types::status::READY | types::status::RUNNING
                )
            })
            .map(|t| t.id)
            .collect()
    };
    for id in &live {
        stop(id)?;
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::refresh_run_status(&conn, run_id)?;
    Ok(store::tasks_of_run(&conn, run_id)?
        .into_iter()
        .map(|t| t.id)
        .collect())
}

/// Lo que se dejaron escrito los agentes de un run.
#[tauri::command]
pub fn run_list_facts(run_id: String, db: tauri::State<DbConnection>) -> Result<Vec<Fact>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::facts_of_run(&conn, &run_id)
}

/// Que el provider exista en el registro y la flota sepa correrlo sin terminal. Se pregunta
/// al registro, no por nombre: un provider nuevo con `HeadlessAgent` entra solo, y la
/// terminal de emergencia queda afuera por no tenerlo.
pub(crate) fn ensure_headless(agent_id: &str) -> Result<(), String> {
    let adapter = crate::agents::adapter_for(agent_id)
        .ok_or_else(|| format!("'{agent_id}' no es un provider conocido"))?;
    if !adapter.capabilities().headless {
        return Err(format!(
            "'{agent_id}' no se puede correr sin terminal: no puede ser lead"
        ));
    }
    Ok(())
}

pub(crate) fn ensure_orchestration(agent_id: &str) -> Result<(), String> {
    ensure_headless(agent_id)?;
    let adapter = crate::agents::adapter_for(agent_id).ok_or("provider unavailable")?;
    if !adapter.capabilities().orchestration {
        return Err(format!(
            "{} can execute worker tasks, but does not support the ADE orchestration required to act as Lead.",
            adapter.def().label
        ));
    }
    Ok(())
}

pub(crate) fn route_lead_now(
    db: &DbConnection,
    request: &routing::RouteRequest,
) -> Result<routing::Assignment, String> {
    if let Some(id) = &request.agent_id {
        ensure_orchestration(id)?;
    }
    let mut roster = roster::snapshot(db, false)?;
    roster
        .agents
        .retain(|agent| agent.capabilities.orchestration);
    routing::route(
        &roster,
        &routing::load_tiers(db),
        &routing::resolve_pool(db, request)?,
        crate::util::now_ts(),
    )
}

fn route_request(
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> routing::RouteRequest {
    routing::RouteRequest {
        agent_id,
        // Un modelo en blanco es "el de siempre", no un modelo llamado "".
        model: model.filter(|m| !m.trim().is_empty()),
        complexity,
        account: if auto_account {
            routing::AccountChoice::Auto
        } else {
            routing::AccountChoice::Fixed(account_id)
        },
    }
}

/// Corre el ruteo fuera del hilo async: la primera vez sondea el roster, que lanza procesos.
async fn assign(
    db: &DbConnection,
    request: routing::RouteRequest,
) -> Result<routing::Assignment, String> {
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || route_now(&db, &request))
        .await
        .map_err(|e| e.to_string())?
}

/// El ruteo en el hilo actual. Bloquea: la primera vez sondea el roster.
pub(crate) fn route_now(
    db: &DbConnection,
    request: &routing::RouteRequest,
) -> Result<routing::Assignment, String> {
    let roster = roster::snapshot(db, false)?;
    let tiers = routing::load_tiers(db);
    routing::route(&roster, &tiers, &routing::resolve_pool(db, request)?, crate::util::now_ts())
}

/// Lo que usó cada cuenta en los últimos `days` días (intentos, tokens, costo reportado), con
/// sus límites y lo que corre ahora. Ver `ledger`.
#[tauri::command]
pub async fn account_usage_summary(app: AppHandle, days: u32) -> Result<Vec<ledger::AccountUsage>, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = crate::util::now_ts();
        let conn = db.lock().map_err(|e| e.to_string())?;
        ledger::summary(&conn, now - i64::from(days.clamp(1, 365)) * 24 * 3600, now)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Los límites de una cuenta (`account_key` como en `quota::account_key`).
#[tauri::command]
pub fn account_limits_get(app: AppHandle, account_key: String) -> Result<ledger::AccountLimits, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(ledger::load_limits(&conn, &account_key))
}

#[tauri::command]
pub fn account_limits_set(app: AppHandle, account_key: String, limits: ledger::AccountLimits) -> Result<(), String> {
    let db = db_of(&app)?;
    ledger::save_limits(&db, &account_key, &limits)
}

/// Qué agentes, modelos y cuentas hay para lanzar ahora. `refresh` vuelve a sondear las
/// TUIs aunque lo último sea reciente.
#[tauri::command]
pub async fn run_roster(app: AppHandle, refresh: bool) -> Result<roster::Roster, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || roster::snapshot(&db, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn models_refresh(
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
) -> Result<roster::Roster, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        roster::refresh_models(&db, &agent_id, account_id.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A quién le tocaría una tarea con estos datos, sin lanzarla. Es lo que muestra el
/// diálogo antes de apretar "Lanzar": enterarse de que fue a otra cuenta DESPUÉS sería
/// enterarse tarde.
#[tauri::command]
pub async fn run_preview_route(
    app: AppHandle,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> Result<routing::Assignment, String> {
    let db = db_of(&app)?;
    assign(
        &db,
        route_request(agent_id, model, complexity, account_id, auto_account),
    )
    .await
}

#[tauri::command]
pub fn run_get_tiers(db: tauri::State<DbConnection>) -> routing::Tiers {
    routing::load_tiers(&db)
}

#[tauri::command]
pub fn run_set_tiers(
    tiers: routing::Tiers,
    db: tauri::State<DbConnection>,
) -> Result<routing::Tiers, String> {
    for c in [
        routing::Complexity::Trivial,
        routing::Complexity::Standard,
        routing::Complexity::Hard,
    ] {
        let entries = tiers.get(c);
        // Un tramo vacío no tiene a quién asignar: lanzar con esa complejidad fallaría
        // siempre, y se enteraría quien lanza en vez de quien lo dejó vacío.
        if entries.is_empty() {
            return Err(format!(
                "el tramo {} necesita al menos un modelo",
                c.as_str()
            ));
        }
        if let Some(bad) = entries
            .iter()
            .find(|e| crate::agents::adapter_for(&e.agent_id).is_none())
        {
            return Err(format!("'{}' no es un agente conocido", bad.agent_id));
        }
        if entries.iter().any(|e| e.model.trim().is_empty()) {
            return Err(format!(
                "el tramo {} tiene un modelo sin nombre",
                c.as_str()
            ));
        }
    }
    routing::save_tiers(&db, &tiers)?;
    Ok(tiers)
}

/// Procesos headless vivos. Para probar que algo NO lanzó un agente.
#[cfg(test)]
pub(crate) fn live_task_count() -> usize {
    supervisor::live_count()
}

/// Worktrees en la carpeta de la app. Para probar que algo NO creó uno.
#[cfg(test)]
pub(crate) fn worktree_count() -> usize {
    worktrees_base()
        .ok()
        .and_then(|b| std::fs::read_dir(b).ok())
        .map_or(0, |d| d.count())
}

/// Dónde viven los worktrees de las tareas. Fuera del repo a propósito: adentro habría que
/// ignorarlos en `.gitignore`, y cualquier herramienta que recorra el proyecto (un linter,
/// el mismo agente) los encontraría como si fueran parte del código.
fn worktrees_base() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "no se pudo resolver el home".to_string())?
        .join(".ags")
        .join("worktrees"))
}

/// Crea el worktree de una tarea, le monta las skills del proyecto y deja la fila
/// apuntando adentro. `base` se recibe para que los tests no escriban en el home.
pub(crate) fn isolate_task(
    base: &std::path::Path,
    db: &DbConnection,
    task: &Task,
) -> Result<Task, String> {
    isolate_task_from(base, db, task, "HEAD")
}

pub(crate) fn isolate_task_from(
    base: &std::path::Path,
    db: &DbConnection,
    task: &Task,
    start: &str,
) -> Result<Task, String> {
    let project = std::path::Path::new(&task.cwd);
    let wt = worktrees::create_from(base, project, &task.title, start)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    // Las skills que el usuario ve en el proyecto, también adentro. Best-effort: sin la
    // carpeta global configurada, o sin skills, el agente arranca igual.
    if let (Ok(skills_dir), Some(project_links), Some(task_links)) = (
        crate::skills::skills_dir_from_conn(&conn),
        crate::skills::links_dir_for(&task.cwd, &task.agent_id),
        crate::skills::links_dir_for(&wt.task_cwd.to_string_lossy(), &task.agent_id),
    ) {
        worktrees::link_skills(&project_links, &task_links, &skills_dir);
    }

    store::set_worktree(
        &conn,
        &task.id,
        &wt.task_cwd.to_string_lossy(),
        &wt.root.to_string_lossy(),
        &wt.branch,
    )?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al aislarla".into())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardedWorktree {
    pub branch: String,
    /// La rama quedó porque tiene commits que no están en ningún otro lado.
    pub branch_kept: bool,
}

/// Descarta el worktree de una tarea terminada.
///
/// Nunca con la tarea viva: sería sacarle la carpeta a un agente que está trabajando.
/// Se niega también si hay cambios sin commitear (ver `worktrees::remove`).
#[tauri::command]
pub fn run_discard_worktree(app: AppHandle, task_id: String) -> Result<DiscardedWorktree, String> {
    let db = db_of(&app)?;
    let (task, project_cwd, skills_dir) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let task = store::task_by_id(&conn, &task_id)?
            .ok_or_else(|| "la tarea ya no existe".to_string())?;
        let project = store::project_cwd_of_task(&conn, &task_id).ok_or("la tarea no tiene run")?;
        (task, project, crate::skills::skills_dir_from_conn(&conn)?)
    };

    if matches!(
        task.status.as_str(),
        types::status::READY | types::status::RUNNING
    ) {
        return Err("la tarea todavía está corriendo: parala o esperá a que termine".into());
    }
    let (Some(root), Some(branch)) = (task.worktree_path.clone(), task.branch.clone()) else {
        return Err("esta tarea no corre en un worktree".into());
    };
    if task.worktree_removed {
        return Err("el worktree de esta tarea ya se descartó".into());
    }

    let wt = worktrees::Worktree {
        root: root.into(),
        task_cwd: task.cwd.clone().into(),
        branch: branch.clone(),
    };
    let links = crate::skills::links_dir_for(&task.cwd, &task.agent_id).unwrap_or_default();
    // Cualquier carpeta del repo sirve para `git -C`; la del proyecto sigue existiendo.
    let removed = worktrees::remove(std::path::Path::new(&project_cwd), &wt, &links, &skills_dir)?;

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::mark_worktree_removed(&conn, &task_id)?;
    }
    supervisor::notify_changed(&app, &task_id);
    Ok(DiscardedWorktree {
        branch,
        branch_kept: removed.branch_kept,
    })
}

#[tauri::command]
pub fn run_cancel_task(app: AppHandle, task_id: String) -> Result<(), String> {
    supervisor::cancel(&app, &task_id)
}

// ── Pasarle una tarea a otro agente ─────────────────────────────

/// Lo que el agente anterior alcanzó a hacer: los pasos que quedaron en su registro de
/// eventos y los commits que dejó en su rama.
///
/// El registro se lee ACÁ y no al relanzar porque el lanzamiento lo pisa: cada intento
/// escribe su `.jsonl` desde cero.
fn what_it_did(task: &Task) -> (Vec<String>, Vec<String>) {
    let mut did = Vec::new();
    if let Some(path) = &task.events_path
        && let Some(adapter) = agents::adapter_for(&task.agent_id)
        && let Ok(raw) = std::fs::read_to_string(path)
    {
        for line in raw.lines() {
            for event in adapter.parse_line(line) {
                match event {
                    types::AgentEvent::Tool { label, .. } => did.push(label),
                    types::AgentEvent::Text { text } => did.extend(activity::text_line(&text)),
                    _ => {}
                }
            }
        }
    }
    let commits = match (&task.worktree_path, task.started_at) {
        (Some(root), Some(since)) if !task.worktree_removed => {
            worktrees::commits_since(std::path::Path::new(root), since, 15)
        }
        _ => Vec::new(),
    };
    (did, commits)
}

/// Le pasa una tarea a otro agente, con lo que el anterior ya hizo.
///
/// No es un reintento: el reintento repite con el MISMO agente porque falló. Esto cambia
/// quién la corre —se quedó sin cupo, no está dando resultado, el usuario quiere otro
/// modelo— y por eso lo que vale es que el que entra no empiece de cero: hereda la carpeta,
/// la rama y el relato de lo que se hizo hasta acá.
pub async fn reroute(
    app: &AppHandle,
    task_id: &str,
    request: routing::RouteRequest,
    reason: &str,
) -> Result<(Task, routing::Assignment), String> {
    let db = db_of(app)?;
    let assignment = assign(&db, request).await?;
    let out = reroute_to(app, task_id, assignment, reason)?;
    scheduler::tick(app, &out.0.run_id);
    Ok(out)
}

/// Lo mismo con la asignación ya resuelta, para quien ya tiene el roster en la mano (la
/// orquestación, que atiende en un hilo sincrónico).
pub fn reroute_to(
    app: &AppHandle,
    task_id: &str,
    assignment: routing::Assignment,
    reason: &str,
) -> Result<(Task, routing::Assignment), String> {
    let db = db_of(app)?;
    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::task_by_id(&conn, task_id)?.ok_or_else(|| "la tarea ya no existe".to_string())?
    };
    if task.role.as_deref() == Some(types::role::LEAD) {
        return Err("el lead no se pasa a otro agente: es quien reparte".into());
    }

    // Se para ANTES de leer el registro: mientras el proceso vive sigue escribiendo, y el
    // relato del traspaso tiene que ser de algo que ya terminó de pasar.
    if matches!(
        task.status.as_str(),
        types::status::PENDING | types::status::READY | types::status::RUNNING
    ) {
        supervisor::hand_off(app, task_id)?;
    }

    let (did, commits) = what_it_did(&task);
    let from = match &task.model {
        Some(model) => format!("{} · {model}", task.agent_id),
        None => task.agent_id.clone(),
    };
    let last = task.error.as_deref().or(task.result.as_deref());
    let note = context::handoff_note(&context::Handoff {
        from: &from,
        reason,
        did: &did,
        commits: &commits,
        last,
    });

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let moved = store::reroute_task(
            &conn,
            task_id,
            &assignment.agent_id,
            assignment.model.as_deref(),
            assignment.account_id.as_deref(),
            assignment.routed_by.as_str(),
            (!assignment.notes.is_empty())
                .then(|| assignment.notes.join("; "))
                .as_deref(),
            &note,
            assignment.auto_account,
        )?;
        if !moved {
            return Err(
                "la tarea no está en un estado en el que se pueda pasar a otro agente".into(),
            );
        }
    }
    // Un cambio de manos es lo que el Map Mode dibuja como arista de traspaso.
    crate::bus::publish(
        Some(app),
        crate::bus::Publish::new("task.rerouted").task(task_id).run(&task.run_id).data(serde_json::json!({
            "from": { "agentId": task.agent_id, "model": task.model, "accountId": task.account_id },
            "to": { "agentId": assignment.agent_id, "model": assignment.model, "accountId": assignment.account_id },
            "reason": reason,
        })),
    );
    supervisor::notify_changed(app, task_id);
    // No se tiquea acá: el scheduler llama a esto con su propio lock tomado, y volver a
    // entrar lo trabaría. Tiquean los de afuera.
    let conn = db.lock().map_err(|e| e.to_string())?;
    let updated =
        store::task_by_id(&conn, task_id)?.ok_or_else(|| "la tarea ya no existe".to_string())?;
    Ok((updated, assignment))
}

/// Pasarla a otro agente desde la consola. Sin `agent`/`model`, elige la app.
#[tauri::command]
pub async fn run_reroute_task(
    app: AppHandle,
    task_id: String,
    agent_id: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    reason: Option<String>,
) -> Result<Task, String> {
    let complexity = {
        let db = db_of(&app)?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::task_by_id(&conn, &task_id)?
            .and_then(|t| t.complexity)
            .and_then(|c| routing::Complexity::parse(&c))
    };
    let request = routing::RouteRequest {
        agent_id,
        model: model.filter(|m| !m.trim().is_empty()),
        complexity,
        account: match account_id {
            Some(id) => routing::AccountChoice::Fixed(Some(id)),
            None => routing::AccountChoice::Auto,
        },
    };
    let reason = reason.unwrap_or_else(|| "lo pidió el usuario desde la consola".into());
    reroute(&app, &task_id, request, &reason)
        .await
        .map(|(task, _)| task)
}

/// Deja la tarea lista para seguirla en una terminal y devuelve la fila con lo necesario
/// para abrirla: la sesión, la cuenta y la carpeta.
///
/// Si todavía corre, la para (ver `supervisor::hand_off`). Si ya terminó, no toca nada:
/// reabrir una conversación cerrada es solo reanudarla.
#[tauri::command]
pub fn run_hand_off_task(app: AppHandle, task_id: String) -> Result<Task, String> {
    let db = db_of(&app)?;
    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::task_by_id(&conn, &task_id)?.ok_or_else(|| "la tarea ya no existe".to_string())?
    };

    // Sin sesión no hay nada que reanudar: la tarea falló antes de que la TUI arrancara.
    // Abrir una tab igual daría una conversación NUEVA presentada como la de la tarea.
    if task.session_id.is_none() {
        return Err("esta tarea nunca llegó a arrancar: no hay conversación para seguir".into());
    }
    // La sesión quedó atada a la ruta del worktree: sin la carpeta, `--resume` en otro
    // lado no la encuentra y abriría una conversación nueva haciéndose pasar por esta.
    if task.worktree_removed {
        return Err(
            "el worktree de esta tarea se descartó: su conversación ya no tiene dónde retomarse"
                .into(),
        );
    }

    if matches!(
        task.status.as_str(),
        types::status::READY | types::status::RUNNING
    ) {
        supervisor::hand_off(&app, &task_id)?;
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task_id)?.ok_or_else(|| "la tarea ya no existe".into())
}

// ── Permisos ────────────────────────────────────────────────────

/// Lo que el puente MCP de una tarea pregunta: ¿puede usar esta herramienta?
///
/// Vive acá y no en `broker` porque además de resolverlo hay que avisarle a la consola: un
/// pedido que espera y nadie ve es un agente parado en silencio.
pub fn resolve_permission(
    app: &AppHandle,
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> broker::Verdict {
    supervisor::notify_approvals(app);
    let verdict = broker::resolve(db, task_id, tool_name, input, timeout);
    // Y otra vez al cerrarse, para que la tarjeta deje de pedir.
    supervisor::notify_approvals(app);
    verdict
}

/// Los pedidos que están esperando a una persona ahora mismo.
#[tauri::command]
pub fn run_pending_approvals() -> Vec<broker::PendingApproval> {
    broker::pending()
}

/// Contesta un pedido. `false` si ya no existe: venció, o la tarea se canceló mientras
/// tanto, y en los dos casos el usuario tiene que enterarse en vez de creer que decidió.
///
/// Con `remember`, además deja escrita la regla exacta del pedido para su carpeta, y
/// resuelve con ella lo que otros agentes de esa carpeta estuvieran esperando.
#[tauri::command]
pub fn run_decide_approval(
    app: AppHandle,
    approval_id: String,
    allow: bool,
    remember: bool,
    db: tauri::State<DbConnection>,
) -> Result<bool, String> {
    decide_approval(&app, &db, &approval_id, allow, remember)
}

/// Lo mismo, para quien no es un comando de Tauri (la CLI: `ags approval decide`).
pub(crate) fn decide_approval(
    app: &AppHandle,
    db: &DbConnection,
    approval_id: &str,
    allow: bool,
    remember: bool,
) -> Result<bool, String> {
    let Some(pending) = broker::get(approval_id) else {
        supervisor::notify_approvals(app);
        return Ok(false);
    };

    // La regla se guarda ANTES de contestar: si guardarla falla, el usuario tiene que
    // enterarse ahí, no después de que el agente ya siguió creyendo que quedó recordado.
    let remembered_in = if remember {
        remember_rule(db, &pending, allow)?
    } else {
        None
    };

    let decided = broker::decide(approval_id, allow, None);
    if let Some(cwd) = remembered_in {
        broker::release_matching(db, &cwd);
    }
    supervisor::notify_approvals(app);
    Ok(decided)
}

/// Los pedidos de permiso que esperan a una persona. Para la CLI (`ags approval list`).
pub(crate) fn pending_approvals() -> Vec<broker::PendingApproval> {
    broker::pending()
}

/// Guarda la regla exacta de un pedido. Devuelve la carpeta en la que quedó.
fn remember_rule(
    db: &DbConnection,
    pending: &broker::PendingApproval,
    allow: bool,
) -> Result<Option<String>, String> {
    // Un pedido sin regla exacta posible no ofrece "recordar" en la consola; si igual llega
    // acá (un click contra una tarjeta vieja), se contesta sin recordar en vez de inventar
    // una regla más amplia que lo que se vio.
    let Some(pattern) = rules::exact_rule_for(&pending.tool_name, &pending.input) else {
        return Ok(None);
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    let Some(cwd) = store::project_cwd_of_task(&conn, &pending.task_id) else {
        return Ok(None);
    };
    store::upsert_rule(&conn, &cwd, &pattern, allow)?;
    Ok(Some(cwd))
}

/// Las reglas de una carpeta, en el orden en que se evalúan.
#[tauri::command]
pub fn run_list_rules(
    cwd: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<store::RuleRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_rules(&conn, &cwd)
}

/// Agrega una regla escrita a mano, y resuelve con ella lo que estuviera esperando.
#[tauri::command]
pub fn run_add_rule(
    app: AppHandle,
    cwd: String,
    pattern: String,
    allow: bool,
    db: tauri::State<DbConnection>,
) -> Result<store::RuleRow, String> {
    if !rules::is_valid_pattern(&pattern) {
        return Err(format!(
            "'{pattern}' no tiene la forma de una regla: Herramienta o Herramienta(patrón)"
        ));
    }
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::upsert_rule(&conn, &cwd, &pattern, allow)?
    };
    if broker::release_matching(&db, &cwd) > 0 {
        supervisor::notify_approvals(&app);
    }
    Ok(row)
}

#[tauri::command]
pub fn run_delete_rule(id: String, db: tauri::State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::delete_rule(&conn, &id)
}

/// Cierra los pedidos que quedaron colgados de una ejecución anterior de la app.
pub fn sweep_orphan_approvals(db: &DbConnection) -> Result<usize, String> {
    broker::sweep_orphans(db)
}

/// Qué aísla el sandbox de los agentes en esta máquina, con el modo configurado.
#[tauri::command]
pub fn sandbox_status(app: AppHandle) -> Result<sandbox::Status, String> {
    let db = db_of(&app)?;
    Ok(sandbox::status(sandbox::Mode::from_db(&db)))
}
