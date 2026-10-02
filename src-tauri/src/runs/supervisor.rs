//! Lanzar una tarea, seguirla mientras corre y cerrarla.
//!
//! Es lo único común a todos los agentes: esperar al proceso, contener su descendencia,
//! guardar el crudo, traducir eventos y escribir el veredicto. Lo que cambia entre TUIs
//! —el argv y el dialecto— está en `agents.rs`.
//!
//! ## Por qué acá sí `tokio::spawn`
//!
//! Es el primero del crate. El resto de la app usa `spawn_blocking` porque `portable-pty`
//! expone un `Read` bloqueante (ver `pty_manager.rs`), y una lectura bloqueante en un
//! worker async lo secuestra. Un hijo de `tokio::process` con el stdout redirigido es un
//! stream async de verdad, así que esa objeción no aplica — y un hilo de OS por agente de
//! la flota sería desperdicio puro.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::database::DbConnection;
use crate::terminal::containment::ProcessGroup;

use super::agents::{LaunchCtx, adapter_for};
use super::store;
use super::types::{AgentEvent, Task, TaskOutcome, status};

/// Evento que la consola escucha para pintar la actividad viva de una tarjeta.
pub const TASK_EVENT: &str = "cc-task-event";
/// Evento de "esta tarjeta cambió de estado"; la consola recarga esa fila.
pub const TASK_CHANGED: &str = "cc-task-changed";
/// Evento de "cambió la cola de permisos"; la consola vuelve a pedirla.
pub const APPROVALS_CHANGED: &str = "cc-task-approvals";

/// Avisa que la cola de permisos cambió. Se manda el estado entero y no el delta porque
/// son unos pocos pedidos y así una ventana que se perdió un evento se recupera sola.
pub fn notify_approvals(app: &AppHandle) {
    let pending = super::broker::pending();
    crate::bus::publish(
        Some(app),
        crate::bus::Publish::new("approvals.changed").data(serde_json::json!({ "pending": pending.len() })),
    );
    let _ = app.emit(APPROVALS_CHANGED, pending);
}

/// Nombre del grupo de contención. No se cruza con los ids de PTY porque va por otro
/// contador y el nombre del cgroup los distingue igual; solo sirve para leerlo.
static GROUP_SEQ: AtomicU32 = AtomicU32::new(1);

lazy_static::lazy_static! {
    /// El grupo de contención de cada tarea viva.
    ///
    /// Sin esto `cancel` no tendría a qué matar: el grupo se crea al lanzar y viaja dentro
    /// de la tarea async que espera al proceso, que desde afuera es inalcanzable. Es el
    /// mismo patrón que `PTY_REGISTRY` en `pty_manager`, y por el mismo motivo.
    static ref LIVE: Mutex<HashMap<String, ProcessGroup>> = Mutex::new(HashMap::new());
}

fn live() -> std::sync::MutexGuard<'static, HashMap<String, ProcessGroup>> {
    // Igual que en el resto del crate: un panic aislado no debe dejar inutilizable al
    // registro entero.
    LIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Cuántas tareas headless tienen un proceso vivo. Para probar que algo NO lanzó uno.
#[cfg(test)]
pub(crate) fn live_count() -> usize {
    live().len()
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskEventPayload {
    task_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

fn emit_event(app: &AppHandle, task_id: &str, event: AgentEvent) {
    if let Some(data) = activity_data(&event) {
        crate::bus::publish(Some(app), crate::bus::Publish::new("task.activity").task(task_id).data(data));
    }
    let _ = app.emit(
        TASK_EVENT,
        TaskEventPayload {
            task_id: task_id.to_string(),
            event,
        },
    );
}

/// Lo que va al bus de la actividad de una tarea: qué herramienta usa, qué dijo (corto), si
/// arrancó o terminó. El texto entero ya va por `cc-task-event` y al NDJSON de la tarea;
/// el bus guarda historia y no tiene por qué cargar párrafos.
fn activity_data(event: &AgentEvent) -> Option<serde_json::Value> {
    use serde_json::json;
    Some(match event {
        AgentEvent::Started { .. } => json!({ "kind": "started" }),
        AgentEvent::Tool { label, .. } => json!({ "kind": "tool", "label": label }),
        AgentEvent::Text { text } => {
            let short: String = text.chars().take(200).collect();
            json!({ "kind": "text", "text": short })
        }
        AgentEvent::Finished { outcome } => json!({ "kind": "finished", "ok": outcome.ok }),
        AgentEvent::Quota { .. } => return None,
    })
}

fn emit_changed(app: &AppHandle, task_id: &str) {
    crate::bus::publish(Some(app), crate::bus::Publish::new("task.changed").task(task_id));
    let _ = app.emit(TASK_CHANGED, task_id.to_string());
}

/// Avisa a la consola que una fila cambió por algo que no pasó en el proceso (descartar su
/// worktree, por ejemplo).
pub fn notify_changed(app: &AppHandle, task_id: &str) {
    emit_changed(app, task_id);
}

/// El `--mcp-config` que le dice al agente cómo alcanzar su puente de permisos y el
/// navegador.
///
/// Se escribe uno por tarea porque el `--task` de adentro es lo que después le dice a la
/// app a qué tarjeta pertenece cada pedido. El archivo se borra al terminar; los que
/// queden de un cierre sucio los barre el arranque.
///
/// Si no hay `ccode` —una build de desarrollo sin el binario al lado— se corre sin broker
/// en vez de fallar: el agente igual sirve, solo que sin poder pedir permiso.
fn write_mcp_config(app: &AppHandle, task_id: &str) -> Option<PathBuf> {
    crate::ipc::mcp::write_config(app, task_id, &["mcp", "--task", task_id])
}

/// Dónde va el NDJSON crudo de una tarea.
fn events_path_for(run_id: &str, task_id: &str) -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "no se pudo resolver el home".to_string())?
        .join(".controlcode")
        .join("runs")
        .join(run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{task_id}.jsonl")))
}

/// Lo que un lanzamiento lleva además de la tarea, según el papel que cumple en su run.
#[derive(Default)]
pub struct LaunchExtras {
    /// El prompt a mandar, si no es el de la fila (un worker recibe el suyo más el contexto
    /// del run, que se arma al despacharlo y no se guarda).
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_tools: Vec<String>,
}

/// Arranca la tarea en segundo plano. Vuelve en cuanto el proceso quedó lanzado; lo que
/// pase después llega por eventos.
pub fn start(app: &AppHandle, task: Task, extras: LaunchExtras) -> Result<(), String> {
    // Se llama también desde afuera del runtime async: el hilo de una conexión del IPC (un
    // agente que despacha su plan) o un comando síncrono. Lanzar el proceso y la tarea que
    // lo espera necesita estar adentro de tokio.
    let runtime = tauri::async_runtime::handle();
    let _inside = runtime.inner().enter();
    let Some(adapter) = adapter_for(&task.agent_id) else {
        return Err(format!(
            "todavía no se sabe correr '{}' sin terminal",
            task.agent_id
        ));
    };
    let read_only = super::policy::is_coordinator(&task);
    if let Some(schema) = &task.result_schema {
        let schema = serde_json::from_str(schema).map_err(|error| format!("result_schema inválido: {error}"))?;
        super::plan::validate_result_schema(&task.agent_id, &schema)?;
    }
    if read_only { super::ensure_orchestration(&task.agent_id)?; }
    if read_only && !adapter.enforces_read_only() {
        return Err(format!(
            "'{}' no puede correr como lead: su modo sin terminal aprueba todo solo y no hay \
             cómo impedirle modificar el workspace",
            task.agent_id
        ));
    }

    let db = app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone();

    // El id de sesión lo decide la app ANTES de lanzar: así la fila ya sabe a qué sesión
    // mirar, y reabrir la tarea como tab con `--resume` no depende de descubrir nada.
    let session_id = Uuid::new_v4().to_string();
    let events_path = events_path_for(&task.run_id, &task.id)?;

    // La cuenta se resuelve justo antes de lanzar, no al crear la tarea: si dejó de
    // existir, se aborta en vez de caer a la cuenta del sistema — que es lo mismo que hace
    // el arranque de una tab (`Terminal.tsx`), y por el mismo motivo: correr con otra
    // cuenta que la pedida gasta cupo ajeno sin avisar.
    let mut account_env = match &task.account_id {
        Some(id) => crate::accounts::env_for_account(&db, id)
            .ok_or_else(|| format!("la cuenta '{id}' ya no existe"))?,
        None => Default::default(),
    };

    if task.reasoning_effort.is_some() {
        let roster = super::roster::snapshot(&db, false)?;
        super::roster::validate_effort(&roster, &task.agent_id, task.account_id.as_deref(), task.model.as_deref(), task.reasoning_effort.as_deref())?;
    }

    let mcp_config = write_mcp_config(app, &task.id);
    if !extras.allowed_tools.is_empty() && mcp_config.is_none() {
        return Err("ADE MCP configuration unavailable: build/stage the current ccode CLI before starting orchestration".into());
    }
    let task_profile = if task.agent_id == "antigravity" {
        let profile = super::antigravity::TaskProfile::prepare(
            mcp_config.as_deref(), &extras.allowed_tools, read_only, &task.cwd,
        )?;
        account_env.extend(profile.env());
        Some(profile)
    } else {
        None
    };
    let ctx = LaunchCtx {
        cwd: &task.cwd,
        reasoning_effort: task.reasoning_effort.as_deref(),
        session_id: &session_id,
        account_env,
        mcp_config: mcp_config.clone(),
        system_prompt: extras.system_prompt,
        allowed_tools: extras.allowed_tools,
        json_schema: task.result_schema.clone(),
        read_only,
    };
    let prompt = extras.prompt.unwrap_or_else(|| task.prompt.clone());
    let launch = adapter.launch(&prompt, task.model.as_deref(), task.budget_usd, &ctx);

    // Con la ruta completa: en Windows, un `claude.cmd` instalado con npm no se ejecuta por
    // su nombre a secas (ver `util::path_env::find_program`). Y sin shell en el medio: el
    // prompt no puede pasar por `cmd.exe` (ver `util::launch`).
    let program = crate::util::find_program(&launch.program)
        .unwrap_or_else(|| std::path::PathBuf::from(&launch.program));
    let mut command = crate::util::external_command(&program, &launch.args)
        .map_err(|e| format!("no se pudo lanzar '{}': {e}", launch.program))?;
    // Con una cuenta de la app, una API key heredada no le gana a su login.
    crate::agents::apply_account_env(&mut command, &launch.env);
    let mut command = tokio::process::Command::from(command);
    command
        .current_dir(task_profile.as_ref().map_or_else(|| PathBuf::from(&task.cwd), |p| p.workspace()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Sin esto el hijo hereda el grupo de procesos de la app y un Ctrl-C en la
        // terminal que la lanzó se lo llevaría puesto a él también.
        .kill_on_drop(true);

    // El grupo se crea ANTES del spawn, para que exista cuando el hijo empiece a tener
    // descendencia propia: un agente que corre `cargo test` o levanta un server deja
    // nietos, y son los que quedarían huérfanos.
    let mut group = ProcessGroup::new(GROUP_SEQ.fetch_add(1, Ordering::Relaxed));

    let mut child = command
        .spawn()
        .map_err(|e| format!("no se pudo lanzar '{}': {e}", launch.program))?;
    group.adopt(&child);
    live().insert(task.id.clone(), group);

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::mark_running(&conn, &task.id, &session_id, &events_path.to_string_lossy())?;
    }
    emit_changed(app, &task.id);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app = app.clone();
    let task_id = task.id.clone();
    let quota_key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());
    // Codex no informa su cupo en el stream de `exec --json` (Claude sí, ver `quota`): al
    // terminar se le pregunta a su `app-server`, con el mismo entorno de la cuenta.
    let codex_account_env = (task.agent_id == "codex").then(|| launch.env.clone());
    let imposed_session = session_id.clone();

    tokio::spawn(async move {
        // Keep the isolated config alive until the owned process has exited.
        let _task_profile = task_profile;
        // Drain diagnostics while stdout is streamed: a full stderr pipe must not
        // deadlock a native CLI before it can emit its terminal result.
        let stderr_reader = tokio::spawn(async move {
            match stderr {
                Some(mut reader) => {
                    let mut bytes = Vec::new();
                    let _ = tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes).await;
                    String::from_utf8_lossy(&bytes).trim().to_string()
                }
                None => String::new(),
            }
        });
        let mut file = tokio::fs::File::create(&events_path).await.ok();
        let mut emitted: Option<TaskOutcome> = None;

        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(f) = file.as_mut() {
                    let _ = f.write_all(line.as_bytes()).await;
                    let _ = f.write_all(b"\n").await;
                }
                for event in adapter.parse_line(&line) {
                    match event {
                        // Es de la cuenta, no de la tarjeta: se guarda para que el ruteo
                        // sepa cuánto le queda, y la consola no se entera.
                        AgentEvent::Quota { quota } => {
                            super::quota::record(&db, &quota_key, quota, crate::util::now_ts());
                        }
                        // La TUI dice cuál es su sesión y no es la que se le pasó: la
                        // de verdad es la suya (las que no aceptan una de afuera).
                        AgentEvent::Started {
                            session_id: Some(ref real),
                        } if *real != imposed_session => {
                            if let Ok(conn) = db.lock() {
                                let _ = store::set_session_id(&conn, &task_id, real);
                            }
                            emit_event(&app, &task_id, event);
                        }
                        AgentEvent::Finished { ref outcome } => {
                            emitted = Some(outcome.clone());
                            emit_event(&app, &task_id, event);
                        }
                        event => emit_event(&app, &task_id, event),
                    }
                }
            }
        }

        let stderr_text = stderr_reader.await.unwrap_or_default();

        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        let mut outcome = adapter.finish(emitted, code);
        if !outcome.ok && outcome.error.is_none() && !stderr_text.is_empty() {
            outcome.error = Some(tail(&stderr_text, 400));
        }

        // Sacarlo del registro corre el `Drop` del grupo, que barre lo que el agente
        // hubiera dejado atrás (un `cargo test` a medias, un server levantado).
        live().remove(&task_id);
        // Un pedido de permiso sin proceso que lo espere no lo va a contestar nadie:
        // dejarlo en la cola lo mostraría en la consola para siempre.
        super::broker::drop_task(&task_id);
        if let Some(path) = &mcp_config {
            let _ = std::fs::remove_file(path);
        }

        if let Ok(conn) = db.lock() {
            let _ = store::finish_task(&conn, &task_id, &outcome);
        }
        emit_event(&app, &task_id, AgentEvent::Finished { outcome });
        emit_changed(&app, &task_id);

        if let Some(env) = codex_account_env {
            let (db, key) = (db.clone(), quota_key.clone());
            // Aparte y sin esperarlo: levantar el `app-server` tarda un segundo, y el cupo no
            // cambia el resultado de esta tarea, solo cómo se rutean las próximas.
            tokio::task::spawn_blocking(move || crate::accounts::refresh_codex_account(&db, &key, &env));
        }
        // Lo que dependía de esta tarea puede arrancar (o no va a poder nunca).
        super::scheduler::on_task_finished(&app, &task_id);
    });

    Ok(())
}

/// Cancela una tarea en curso: marca la fila y mata el proceso con toda su descendencia.
pub fn cancel(app: &AppHandle, task_id: &str) -> Result<(), String> {
    stop(app, task_id, status::CANCELLED)
}

/// Para el proceso headless porque el usuario va a seguir la conversación en una terminal.
///
/// Hay que pararlo, no dejarlo correr en paralelo: dos procesos escribiendo la MISMA sesión
/// a la vez —el headless y el `--resume` de la tab— se pisarían el transcript, y el agente
/// de la tab arrancaría sin saber lo que el otro hizo después.
pub fn hand_off(app: &AppHandle, task_id: &str) -> Result<(), String> {
    stop(app, task_id, status::HANDED_OFF)
}

/// Marca la fila con `new_status` y mata el proceso con toda su descendencia.
///
/// El orden importa. La fila se marca PRIMERO: al morir el proceso, la tarea que lo espera
/// va a intentar cerrarlo como fallido, y `finish_task` solo pisa filas abiertas — así ni
/// una cancelación ni un traspaso a terminal se convierten en un error que no hubo.
fn stop(app: &AppHandle, task_id: &str, new_status: &str) -> Result<(), String> {
    let db = app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    // `ready` también: una tarea que se está lanzando todavía no llegó a `running`, y
    // pararla en ese instante no puede quedar sin efecto. Y `pending`: parar una que espera
    // turno es sacarla de la cola.
    conn.execute(
        "UPDATE tasks SET status = ?1, ended_at = ?2
         WHERE id = ?3 AND status IN ('pending', 'ready', 'running')",
        rusqlite::params![new_status, crate::util::now_ts(), task_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    super::broker::drop_task(task_id);
    if let Some(mut group) = live().remove(task_id) {
        group.kill_all();
    }
    emit_changed(app, task_id);
    // Una tarea parada libera su lugar y deja sin cumplir lo que dependía de ella.
    let run_id = db
        .lock()
        .ok()
        .and_then(|c| store::run_of_task(&c, task_id).ok().flatten())
        .map(|r| r.id);
    if let Some(run_id) = run_id {
        super::scheduler::tick(app, &run_id);
    }
    Ok(())
}

/// Las últimas `max` letras. El final de un stderr es donde está el error; el principio
/// suele ser ruido de arranque.
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    format!("…{}", s.chars().skip(n - max).collect::<String>())
}
