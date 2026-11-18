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
    let app_run = app.clone();
    let app_aviso = app;
    arrancar_com(lanzar_hilo, move || run(app_run), move |error| {
        let _ = app_aviso.emit(SWEPT, ());
        let _ = app_aviso.emit("cc-housekeeping-failed", error.to_string());
    });
}

type Corpo = Box<dyn FnOnce() + Send>;

fn lanzar_hilo(nome: &str, corpo: Corpo) -> std::io::Result<()> {
    std::thread::Builder::new().name(nome.into()).spawn(corpo).map(|_| ())
}

/// Falha de thread é de ambiente: o app abre sem a limpeza em segundo plano.
/// Sem a thread, o sweep nunca rodaria: liberamos o gate da frota e avisamos.
fn arrancar_com(
    lanzar: impl Fn(&str, Corpo) -> std::io::Result<()>,
    principal: impl FnOnce() + Send + 'static,
    ao_falhar_principal: impl FnOnce(&std::io::Error),
) {
    if let Err(error) = lanzar("startup-housekeeping", Box::new(principal)) {
        eprintln!("[housekeeping] não foi possível iniciar a puesta a punto: {error}");
        SWEEP_DONE.store(true, Ordering::SeqCst);
        ao_falhar_principal(&error);
    }
    if !SECRET_CLEANER_STARTED.swap(true, Ordering::SeqCst) {
        let expiracion = lanzar(
            "agent-secret-expiry",
            Box::new(|| {
                loop {
                    crate::ipc::commands::cleanup_expired_agent_secrets();
                    std::thread::sleep(Duration::from_secs(15 * 60));
                }
            }),
        );
        if let Err(error) = expiracion {
            eprintln!("[housekeeping] não foi possível iniciar a expiração de segredos: {error}");
        }
    }
}

#[cfg(test)]
mod test;

fn run(app: AppHandle) {
    crate::ipc::commands::cleanup_expired_agent_secrets();

    // Primero el barrido: es lo que la flota tiene que ver ya cerrado. El resto puede
    // seguir después del aviso.
    if let Some(db) = app
        .try_state::<DbConnection>()
        .map(|state| state.inner().clone())
    {
        let other = crate::ipc::other_instance_alive();
        if other {
            eprintln!("[ade-ags] hay otra instancia abierta: no se limpian sus tareas");
        }
        {
            let now = crate::util::now_ts_ms();
            let recovery = crate::harness::recovery::with_boot_lease(&db, now, || {
                {
                    let conn = db.lock().map_err(|error| error.to_string())?;
                    // Uma falha aqui não pode impedir as varreduras seguintes (turnos órfãos, Frota, integrantes).
                    match crate::harness::effects::recover_expired(&conn, now, &mut |_| {
                        // Nenhum provider atual prova se `chat_send` saiu antes da queda.
                        crate::harness::effects::Reconcile::Unknown
                    }) {
                        Ok(effects)
                            if !effects.completed.is_empty()
                                || !effects.requeued.is_empty()
                                || !effects.unknown.is_empty() =>
                        {
                            eprintln!(
                                "[harness] recuperação: {} concluído(s), {} na fila, {} desfecho(s) desconhecido(s)",
                                effects.completed.len(),
                                effects.requeued.len(),
                                effects.unknown.len()
                            );
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!("[harness] não foi possível reconciliar os efeitos: {error}"),
                    }
                    if let Err(error) = crate::harness::child_delivery::reconcile_intentions(&conn, now) {
                        eprintln!("[harness] não foi possível reconciliar intenções de filho: {error}");
                    }
                    if other {
                        return Ok(());
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
    // Filhos que terminaram (ou foram varridos como interrompidos) com o app fechado: o resultado chega ao pai agora,
    // depois de `recover_expired` ter devolvido à fila os efeitos de entrega que uma queda deixou no meio.
    crate::ipc::pump_child_delivery(&app);

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
