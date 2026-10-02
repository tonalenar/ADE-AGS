//! Qué tarea de un run arranca ahora, y qué pasa cuando una termina.
//!
//! La decisión es una función pura (`decide`) sobre la foto del run: qué tareas esperan, de
//! qué dependen y cuánto lugar queda. Lo que la ejecuta (`tick`) toma esa foto bajo el lock
//! de la base, marca las elegidas antes de soltarlo y recién después las lanza — así dos
//! ticks seguidos no despachan la misma tarea dos veces.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

use super::store;
use super::types::{role, status, Run, Task};

#[derive(Debug, Default, PartialEq)]
pub struct Decision {
    /// Las que arrancan, en orden.
    pub launch: Vec<String>,
    /// Las que no van a correr, con el motivo.
    pub skip: Vec<(String, String)>,
}

/// El lead no ocupa lugar: está esperando a sus workers, y contarlo dejaría a un run con
/// `max_parallel = 2` corriendo de a una tarea.
fn occupies_slot(task: &Task) -> bool {
    matches!(task.status.as_str(), status::READY | status::RUNNING) && task.role.as_deref() != Some(role::LEAD)
}

fn label(task: &Task) -> String {
    task.plan_key.clone().unwrap_or_else(|| task.title.clone())
}

pub fn decide(run: &Run, tasks: &[Task]) -> Decision {
    let mut decision = Decision::default();
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let running = tasks.iter().filter(|t| occupies_slot(t)).count() as i64;
    let mut free = (run.max_parallel.max(1) - running).max(0);
    let over_budget = run.budget_usd.is_some_and(|b| run.spent_usd >= b);

    for task in tasks.iter().filter(|t| t.status == status::PENDING) {
        let mut waiting = false;
        let mut broken = None;
        for dep in &task.depends_on {
            match by_id.get(dep.as_str()) {
                Some(d) if d.status == status::DONE => {}
                Some(d) if status::is_final(&d.status) => {
                    broken = Some(format!("depende de '{}', que terminó como {}", label(d), d.status));
                    break;
                }
                Some(_) => waiting = true,
                // Una dependencia que ya no existe (se borró su fila) no se va a cumplir nunca.
                None => {
                    broken = Some("depende de una tarea que ya no existe".to_string());
                    break;
                }
            }
        }
        if let Some(reason) = broken {
            decision.skip.push((task.id.clone(), reason));
            continue;
        }
        if waiting {
            continue;
        }
        if over_budget {
            decision.skip.push((task.id.clone(), "se acabó el presupuesto del run".to_string()));
            continue;
        }
        if free > 0 {
            decision.launch.push(task.id.clone());
            free -= 1;
        }
    }
    decision
}

/// Un fallo que vale la pena reintentar: el agente llegó a correr y no fue por plata. Un
/// binario que no está o un presupuesto agotado fallan igual la segunda vez, y cobran dos.
pub fn should_retry(task: &Task) -> bool {
    task.role.as_deref() == Some(role::WORKER)
        && task.status == status::FAILED
        && task.attempt < 2
        && task.session_id.is_some()
        && !task.error.as_deref().is_some_and(|e| e.contains("budget"))
}

// ── La parte con efectos ────────────────────────────────────────

lazy_static::lazy_static! {
    /// Un tick a la vez. Con dos en paralelo sobre el mismo run, los dos verían el mismo
    /// lugar libre antes de que el otro marcara su tarea.
    static ref TICK: Mutex<()> = Mutex::new(());
    /// Cuántas veces cambió cada run. `run_await` espera a que el número se mueva.
    static ref CHANGES: (Mutex<HashMap<String, u64>>, Condvar) = (Mutex::new(HashMap::new()), Condvar::new());
}

/// Anota que el run cambió y despierta a quien esté esperando.
pub fn bump(run_id: &str) {
    let (lock, cvar) = &*CHANGES;
    if let Ok(mut map) = lock.lock() {
        *map.entry(run_id.to_string()).or_insert(0) += 1;
    }
    cvar.notify_all();
}

pub fn version(run_id: &str) -> u64 {
    CHANGES.0.lock().map(|m| m.get(run_id).copied().unwrap_or(0)).unwrap_or(0)
}

/// Espera a que el run cambie después de `seen`, hasta `timeout`. Devuelve la versión nueva.
pub fn wait_change(run_id: &str, seen: u64, timeout: Duration) -> u64 {
    let (lock, cvar) = &*CHANGES;
    let deadline = Instant::now() + timeout;
    let Ok(mut map) = lock.lock() else { return seen };
    loop {
        let current = map.get(run_id).copied().unwrap_or(0);
        if current != seen {
            return current;
        }
        let now = Instant::now();
        if now >= deadline {
            return current;
        }
        match cvar.wait_timeout(map, deadline - now) {
            Ok((guard, _)) => map = guard,
            Err(_) => return seen,
        }
    }
}

fn db_of(app: &AppHandle) -> Option<DbConnection> {
    app.try_state::<DbConnection>().map(|s| s.inner().clone())
}

/// Despacha lo que le toque al run y cierra lo que ya no va a correr.
pub fn tick(app: &AppHandle, run_id: &str) {
    let Some(db) = db_of(app) else { return };
    let _one = TICK.lock().unwrap_or_else(|e| e.into_inner());

    let mut mission_changed = None;
    let (to_launch, skipped) = {
        let Ok(conn) = db.lock() else { return };
        let Ok(Some(run)) = store::run_by_id(&conn, run_id) else { return };
        let Ok(tasks) = store::tasks_of_run(&conn, run_id) else { return };
        let decision = decide(&run, &tasks);

        let mut skipped = Vec::new();
        for (id, reason) in &decision.skip {
            if store::skip_task(&conn, id, reason).unwrap_or(false) {
                skipped.push(id.clone());
            }
        }
        let mut to_launch = Vec::new();
        for id in &decision.launch {
            // Se marca adentro del lock: el próximo tick ya la ve ocupando lugar.
            if store::mark_dispatched(&conn, id).unwrap_or(false)
                && let Ok(Some(task)) = store::task_by_id(&conn, id)
            {
                to_launch.push(task);
            }
        }
        if let Ok((_, Some(mission))) = store::refresh_run(&conn, run_id) {
            mission_changed = Some(mission);
        }
        (to_launch, skipped)
    };

    // Antes de lanzarlas: la cuenta que se les asignó al planificar puede haberse quedado
    // sin ventana desde entonces. Cambiar de manos ahí cuesta nada; dejarla arrancar cuesta
    // un intento que se sabe que va a fallar.
    let (to_launch, out_of_quota): (Vec<Task>, Vec<Task>) =
        to_launch.into_iter().partition(|t| !out_of_quota(&db, t));
    // Y los topes propios de cada cuenta (simultáneas, presupuesto de 24 h, ver `ledger`), en
    // orden: cada una que pasa ocupa un lugar para la siguiente de la misma cuenta.
    let (to_launch, limited) = within_limits(&db, to_launch);

    for id in &skipped {
        super::supervisor::notify_changed(app, id);
    }
    // Saltear una tarea puede dejar sin cumplir a las que dependían de ella, y una que no se
    // pudo lanzar libera su lugar: en los dos casos hay que volver a mirar el run.
    let mut again = !skipped.is_empty();
    for task in to_launch {
        again |= !super::launch_planned(app, &db, task);
    }
    if let Ok(conn) = db.lock()
        && let Ok((_, Some(mission))) = store::refresh_run(&conn, run_id)
    {
        mission_changed = Some(mission);
    }
    if let Some(mission) = &mission_changed {
        crate::missions::notify(app, mission);
    }
    bump(run_id);
    drop(_one);

    // Afuera del lock a propósito: pasar una tarea a otro agente la para y vuelve a mirar
    // el run, y las dos cosas entran por acá.
    let mut moved = false;
    // Una cuenta fijada (por el usuario, el Squad o la misión) no se cambia sola: la tarea se
    // saltea diciendo por qué, y quien la fijó decide si esperar o cambiarla.
    let (out_of_quota, pinned): (Vec<Task>, Vec<Task>) = out_of_quota.into_iter().partition(|t| t.auto_account);
    for task in pinned {
        let reason = format!(
            "[límite de uso] la cuenta fijada ({}) está sin cupo; no se cambia sola: esperá a que se reinicie o pasala a otra cuenta",
            task.account_id.as_deref().unwrap_or("la del sistema")
        );
        if let Ok(conn) = db.lock() {
            let _ = store::fail_dispatched(&conn, &task.id, &reason);
        }
        super::supervisor::notify_changed(app, &task.id);
        moved = true;
    }
    for task in out_of_quota {
        match hand_to_another(app, &db, &task) {
            Ok(()) => moved = true,
            Err(e) => {
                eprintln!("[runs] no se pudo pasar '{}' a otra cuenta: {e}", task.title);
                // Se la deja arrancar igual. Que falle diciendo que no hay cupo es mejor
                // que dejarla trabada esperando uno que quizá no vuelva hoy — y evita el
                // ida y vuelta de devolverla a la cola para volver a encontrarla igual.
                again |= !super::launch_planned(app, &db, task);
            }
        }
    }
    for (task, limit) in limited {
        let account = task.account_id.clone().unwrap_or_else(|| "la del sistema".into());
        // Con cuenta automática, otra que tenga lugar. Si no hay, o si está fijada:
        if task.auto_account && reroute_elsewhere(app, &db, &task, &format!("la cuenta {account} {}", limit.reason())).is_ok() {
            moved = true;
            continue;
        }
        match limit {
            // Un lugar se libera en cuanto termina una tarea de esa cuenta: espera en la cola,
            // y `on_task_finished` vuelve a mirar este run cuando eso pase.
            super::ledger::Limit::Concurrency(_) => {
                if let Ok(conn) = db.lock() {
                    let _ = store::undispatch(&conn, &task.id);
                }
                waiting_for_capacity(run_id);
            }
            // Un presupuesto no se libera hasta que pasen horas: falla con el motivo.
            super::ledger::Limit::Budget(reason) => {
                if let Ok(conn) = db.lock() {
                    let _ = store::fail_dispatched(&conn, &task.id, &format!("[presupuesto] la cuenta {account} {reason}"));
                }
                moved = true;
            }
        }
        super::supervisor::notify_changed(app, &task.id);
    }
    if again || moved {
        tick(app, run_id);
    }
}

/// Separa las que su cuenta deja lanzar ahora de las que llegaron a un tope propio.
fn within_limits(db: &DbConnection, tasks: Vec<Task>) -> (Vec<Task>, Vec<(Task, super::ledger::Limit)>) {
    let Ok(conn) = db.lock() else { return (tasks, Vec::new()) };
    let now = crate::util::now_ts();
    let mut admitted: HashMap<String, i64> = HashMap::new();
    let (mut ok, mut limited) = (Vec::new(), Vec::new());
    for task in tasks {
        let key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());
        let already = admitted.get(&key).copied().unwrap_or(0);
        match super::ledger::blocked(&conn, &key, now, already) {
            Some(limit) => limited.push((task, limit)),
            None => {
                *admitted.entry(key).or_insert(0) += 1;
                ok.push(task);
            }
        }
    }
    (ok, limited)
}

lazy_static::lazy_static! {
    /// Runs con tareas esperando que una cuenta llegue a tener lugar. Ese lugar se libera
    /// cuando termina una tarea de la cuenta, que puede ser de OTRO run: por eso no alcanza
    /// con volver a mirar el run de la tarea que terminó.
    static ref WAITING: Mutex<std::collections::HashSet<String>> = Mutex::new(Default::default());
}

fn waiting_for_capacity(run_id: &str) {
    if let Ok(mut set) = WAITING.lock() {
        set.insert(run_id.to_string());
    }
}

/// Vuelve a mirar los runs que esperaban lugar. Los que sigan sin lugar se vuelven a anotar.
fn wake_waiting(app: &AppHandle, except: &str) {
    let runs: Vec<String> = match WAITING.lock() {
        Ok(mut set) => set.drain().filter(|r| r != except).collect(),
        Err(_) => return,
    };
    for run in runs {
        tick(app, &run);
    }
}

/// La cuenta con la que iba a correr esta tarea ya gastó su ventana.
fn out_of_quota(db: &DbConnection, task: &Task) -> bool {
    let Ok(conn) = db.lock() else { return false };
    let key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());
    super::quota::load(&conn, &key).is_some_and(|q| q.exhausted_at(crate::util::now_ts()))
}

/// La pasa a otra cuenta o a otro agente. El ruteo automático ya descarta las cuentas sin
/// cupo, así que alcanza con volver a rutearla; si no hay ninguna disponible, falla y se
/// la deja intentar igual.
fn hand_to_another(app: &AppHandle, db: &DbConnection, task: &Task) -> Result<(), String> {
    let reason = format!(
        "la cuenta con la que iba a correr ({}) se quedó sin ventana de 5 h",
        task.account_id.as_deref().unwrap_or("la del sistema")
    );
    reroute_elsewhere(app, db, task, &reason)
}

/// Vuelve a rutear la tarea con cuenta automática. El ruteo ya descarta las cuentas sin cupo
/// o con la credencial caída, así que lo que sale es otra; si sale la misma, no hay a dónde.
fn reroute_elsewhere(app: &AppHandle, db: &DbConnection, task: &Task, reason: &str) -> Result<(), String> {
    let request = super::routing::RouteRequest {
        agent_id: (task.complexity.is_none()).then(|| task.agent_id.clone()),
        model: task.complexity.is_none().then(|| task.model.clone()).flatten(),
        complexity: task.complexity.as_deref().and_then(super::routing::Complexity::parse),
        account: super::routing::AccountChoice::Auto,
    };
    let roster = super::roster::snapshot(db, false)?;
    let tiers = super::routing::load_tiers(db);
    let assignment = super::routing::route(&roster, &tiers, &request, crate::util::now_ts())?;
    if (assignment.agent_id.as_str(), assignment.account_id.as_deref()) == (task.agent_id.as_str(), task.account_id.as_deref())
    {
        return Err("no hay otra cuenta con cupo".into());
    }
    super::reroute_to(app, &task.id, assignment, reason).map(|_| ())
}

/// Una tarea de un run terminó: reintentarla si corresponde, y ver qué más arranca.
///
/// Un fallo de cuenta (límite de uso, credencial) no se reintenta con la misma cuenta: se
/// anota la cuenta como no disponible y, si la eligió el ruteo, la tarea pasa a otra. Ver
/// `runs::failure`.
pub fn on_task_finished(app: &AppHandle, task_id: &str) {
    use super::failure::FailureKind;
    let Some(db) = db_of(app) else { return };
    let (run_id, account_failure) = {
        let Ok(conn) = db.lock() else { return };
        let Ok(Some(task)) = store::task_by_id(&conn, task_id) else { return };
        let kind = (task.status == status::FAILED)
            .then(|| super::failure::classify(task.error.as_deref().unwrap_or("")));
        let account_failure = match kind {
            Some(kind @ (FailureKind::RateLimited | FailureKind::AuthExpired)) => {
                let tag = if kind == FailureKind::RateLimited { "[límite de uso]" } else { "[credencial]" };
                let _ = store::tag_error(&conn, task_id, tag);
                Some((task.clone(), kind))
            }
            _ => {
                if should_retry(&task) {
                    let error = task.error.clone().unwrap_or_default();
                    let _ = store::requeue_for_retry(&conn, task_id, &error);
                }
                None
            }
        };
        (task.run_id, account_failure)
    };
    if let Some((task, kind)) = account_failure {
        on_account_failure(app, &db, &task, kind);
    }
    super::supervisor::notify_changed(app, task_id);
    tick(app, &run_id);
    // Terminar libera un lugar en su cuenta, y puede haber tareas de otros runs esperándolo.
    wake_waiting(app, &run_id);
}

/// La cuenta de una tarea falló: queda fuera del ruteo (hasta que se reinicie su ventana o
/// se la verifique) y, si la eligió el ruteo, la tarea pasa a otra con el trabajo hecho.
fn on_account_failure(app: &AppHandle, db: &DbConnection, task: &Task, kind: super::failure::FailureKind) {
    use super::failure::FailureKind;
    let key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());
    let now = crate::util::now_ts();
    let account = task.account_id.as_deref().unwrap_or("la del sistema");
    let reason = match kind {
        FailureKind::RateLimited => {
            mark_exhausted(db, &key, now);
            format!("la cuenta {account} llegó a su límite de uso")
        }
        _ => {
            super::failure::record_auth_failure(db, &key, now);
            format!("la credencial de la cuenta {account} fue rechazada (hay que volver a loguearla)")
        }
    };
    crate::bus::publish(
        Some(app),
        crate::bus::Publish::new("account.failure").task(&task.id).run(&task.run_id).data(serde_json::json!({
            "accountKey": key,
            "kind": if kind == FailureKind::RateLimited { "rate_limited" } else { "auth" },
            "reason": reason,
        })),
    );
    let pinned = !task.auto_account;
    let lead = task.role.as_deref() == Some(role::LEAD);
    if pinned || lead {
        // Una cuenta fijada no se cambia sola, y el lead no se pasa a otro agente: falla
        // diciendo por qué, y decide quien la fijó.
        if let Ok(conn) = db.lock() {
            let why = if lead { "[lead: no se reasigna solo]" } else { "[cuenta fijada: no se cambia sola]" };
            let _ = store::tag_error(&conn, &task.id, why);
        }
        return;
    }
    if let Err(e) = reroute_elsewhere(app, db, task, &reason) {
        eprintln!("[runs] '{}' no pudo pasar a otra cuenta: {e}", task.title);
        if let Ok(conn) = db.lock() {
            let _ = store::tag_error(&conn, &task.id, "[sin otra cuenta disponible]");
        }
    }
}

/// Anota la cuenta como sin cupo, sin pisar lo que ya se sabía de sus ventanas. El rechazo
/// sin fecha vence solo a las 5 h (ver `Quota::exhausted_at`).
fn mark_exhausted(db: &DbConnection, key: &str, now: i64) {
    let mut quota = db.lock().ok().and_then(|conn| super::quota::load(&conn, key)).unwrap_or_default();
    if quota.exhausted_at(now) {
        return;
    }
    quota.rejected = true;
    quota.rejected_until = None;
    super::quota::record(db, key, quota, now);
}
