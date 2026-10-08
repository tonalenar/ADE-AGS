//! Trabajo de arranque que no tiene que estar en el camino del primer cuadro.
//!
//! Skills empaquetadas, barrido de tareas huérfanas y limpieza de adjuntos. Corren
//! en un hilo después de que la ventana principal ya existe. El barrido avisa cuando
//! termina: la flota no lista tareas `running` hasta oírlo.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::database::DbConnection;

const SWEPT: &str = "cc-runs-swept";

static STARTED: AtomicBool = AtomicBool::new(false);
static SWEEP_DONE: AtomicBool = AtomicBool::new(false);

pub fn spawn_housekeeping(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("startup-housekeeping".into())
        .spawn(move || run(app))
        .expect("hilo de puesta a punto");
}

fn run(app: AppHandle) {
    // Primero el barrido: es lo que la flota tiene que ver ya cerrado. El resto puede
    // seguir después del aviso.
    if let Some(db) = app
        .try_state::<DbConnection>()
        .map(|state| state.inner().clone())
    {
        if crate::ipc::other_instance_alive() {
            eprintln!("[ade-ags] hay otra instancia abierta: no se limpian sus tareas");
        } else {
            match crate::runs::sweep_orphans(&db) {
                Ok(n) if n > 0 => {
                    eprintln!("[runs] {n} tarea(s) headless quedaron colgadas del cierre anterior");
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("[runs] no se pudieron cerrar las tareas huérfanas: {error}")
                }
            }
            if let Err(error) = crate::runs::sweep_orphan_approvals(&db) {
                eprintln!("[runs] no se pudieron cerrar los permisos huérfanos: {error}");
            }
            crate::ipc::mcp::sweep_configs(&db);
        }
    }
    SWEEP_DONE.store(true, Ordering::SeqCst);
    let _ = app.emit(SWEPT, ());

    crate::terminal::attachments::cleanup_pasted(Duration::from_secs(24 * 60 * 60));
    if let Some(db) = app
        .try_state::<DbConnection>()
        .map(|state| state.inner().clone())
    {
        crate::skills::migrate_legacy_skill(&db);
        crate::skills::ensure_bundled_skills(&app, &db);
    }
}

#[tauri::command]
pub fn runs_sweep_done() -> bool {
    SWEEP_DONE.load(Ordering::SeqCst)
}
