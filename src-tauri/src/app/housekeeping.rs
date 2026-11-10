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
static SECRET_CLEANER_STARTED: AtomicBool = AtomicBool::new(false);

pub fn spawn_housekeeping(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("startup-housekeeping".into())
        .spawn(move || run(app))
        .expect("hilo de puesta a punto");
    if !SECRET_CLEANER_STARTED.swap(true, Ordering::SeqCst) {
        std::thread::Builder::new()
            .name("agent-secret-expiry".into())
            .spawn(|| {
                loop {
                    crate::ipc::commands::cleanup_expired_agent_secrets();
                    std::thread::sleep(Duration::from_secs(15 * 60));
                }
            })
            .expect("hilo de expiração de segredos");
    }
}

fn run(app: AppHandle) {
    crate::ipc::commands::cleanup_expired_agent_secrets();

    // Primero el barrido: es lo que la flota tiene que ver ya cerrado. El resto puede
    // seguir después del aviso.
    if let Some(db) = app
        .try_state::<DbConnection>()
        .map(|state| state.inner().clone())
    {
        if crate::ipc::other_instance_alive() {
            eprintln!("[ade-ags] hay otra instancia abierta: no se limpian sus tareas");
        } else {
            let now = crate::util::now_ts_ms();
            let recovery = crate::harness::recovery::with_boot_lease(&db, now, || {
                {
                    let conn = db.lock().map_err(|error| error.to_string())?;
                    let effects =
                        crate::harness::effects::recover_expired(&conn, now, &mut |_| {
                            // Nenhum provider atual prova se `chat_send` saiu antes da queda.
                            crate::harness::effects::Reconcile::Unknown
                        })?;
                    if !effects.completed.is_empty()
                        || !effects.requeued.is_empty()
                        || !effects.unknown.is_empty()
                    {
                        eprintln!(
                            "[harness] recuperação: {} concluído(s), {} na fila, {} desfecho(s) desconhecido(s)",
                            effects.completed.len(),
                            effects.requeued.len(),
                            effects.unknown.len()
                        );
                    }
                    match crate::conversa::store::sweep_orphans(&conn, now) {
                        Ok(sweep) if sweep.runs + sweep.requests > 0 => eprintln!(
                            "[conversa] {} turno(s) e {} pedido(s) órfãos marcados no arranque",
                            sweep.runs, sweep.requests
                        ),
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("[conversa] não foi possível reconciliar turnos: {error}")
                        }
                    }
                }
                match crate::runs::sweep_orphans(&db) {
                    Ok(n) if n > 0 => {
                        eprintln!("[runs] {n} tarefa(s) headless interrompida(s) no boot")
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!("[runs] não foi possível reconciliar tarefas: {error}"),
                }
                {
                    // Integrantes em `provisioning`: reconciliar pelo estado real após uma queda.
                    let conn = db.lock().map_err(|error| error.to_string())?;
                    match crate::missions::members::reconcile(&conn, None, true, now) {
                        Ok(n) if n > 0 => {
                            eprintln!("[missions] {n} integrante(s) reconciliado(s) no boot")
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!(
                            "[missions] não foi possível reconciliar integrantes: {error}"
                        ),
                    }
                    if let Err(error) = crate::chat_team::api::reconcile_provisions(&conn, now) {
                        eprintln!("[chat_team] não foi possível reconciliar integrantes: {error}");
                    }
                }
                if let Err(error) = crate::runs::sweep_orphan_approvals(&db) {
                    eprintln!("[runs] não foi possível fechar permissões órfãs: {error}");
                }
                crate::ipc::mcp::sweep_configs(&db);
                Ok(())
            });
            match recovery {
                Ok(Some(())) => {}
                Ok(None) => eprintln!(
                    "[harness] recuperação de boot adiada: outra instância possui o lease SQLite"
                ),
                Err(error) => eprintln!("[harness] recuperação de boot incompleta: {error}"),
            }
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

    // Por último, e depois de um tempo: apagar caches e backups velhos mexe no disco e não tem
    // pressa. Com outra instância aberta (a de desenvolvimento, por exemplo) não se mexe em nada.
    if !crate::ipc::other_instance_alive() {
        std::thread::sleep(Duration::from_secs(30));
        super::disk_hygiene::run();
    }
}

#[tauri::command]
pub fn runs_sweep_done() -> bool {
    SWEEP_DONE.load(Ordering::SeqCst)
}
