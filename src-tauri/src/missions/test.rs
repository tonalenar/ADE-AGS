//! Tests de las misiones.
//!
//! Nada de acá lanza un agente: el ruteo y el supervisor entran como closures, y lo que el
//! supervisor haría con la fila (arrancarla, cerrarla) se hace con las mismas funciones de
//! `runs::store` que usa él.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::types::{status, MissionInput};
use super::{cancel, create, detail, start, store, update};
use crate::database::{test_db, DbConnection};
use crate::runs::routing::{Assignment, RoutedBy, RouteRequest};
use crate::runs::store as runs_store;
use crate::runs::types::{role, status as task_status, TaskOutcome};
use crate::runs::{Complexity, Task};

fn db() -> DbConnection {
    let conn = test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)", [])
        .unwrap();
    Arc::new(Mutex::new(conn))
}

fn proyecto() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

fn pedido() -> MissionInput {
    MissionInput {
        title: "Hola".into(),
        objective: "Crear hello.txt con ADE AGS".into(),
        cwd: proyecto(),
        auto_account: true,
        complexity: Some(Complexity::Trivial),
        ..Default::default()
    }
}

fn asignacion(agent: &str) -> Assignment {
    Assignment {
        agent_id: agent.into(),
        model: Some("haiku".into()),
        account_id: None,
        routed_by: RoutedBy::Policy,
        notes: vec![],
    }
}

fn borrador(db: &DbConnection) -> String {
    let conn = db.lock().unwrap();
    create(&conn, "w1", &pedido()).unwrap().id
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Arranca con un ruteo fijo y un lanzamiento que no hace nada. Devuelve el lead.
fn arrancar(db: &DbConnection, id: &str) -> Task {
    let lanzado = RefCell::new(None);
    start(db, id, |_| Ok(asignacion("claude-code")), |t| {
        *lanzado.borrow_mut() = Some(t.clone());
        Ok(())
    })
    .unwrap();
    lanzado.into_inner().expect("se lanzó el lead")
}

/// Lo que hace el supervisor con una tarea que corre y termina.
fn correr_y_cerrar(db: &DbConnection, task_id: &str, outcome: TaskOutcome) -> String {
    let conn = db.lock().unwrap();
    runs_store::mark_running(&conn, task_id, "s-1", "/tmp/e.jsonl").unwrap();
    runs_store::finish_task(&conn, task_id, &outcome).unwrap();
    let run = runs_store::run_of_task(&conn, task_id).unwrap().unwrap();
    runs_store::refresh_run_status(&conn, &run.id).unwrap()
}

fn estado(db: &DbConnection, id: &str) -> String {
    store::get(&db.lock().unwrap(), id).unwrap().unwrap().status
}

// ── Crear, listar, cargar, editar ───────────────────────────────

#[test]
fn crear_una_mision_deja_un_borrador_sin_run() {
    let db = db();
    let conn = db.lock().unwrap();
    let m = create(&conn, "w1", &pedido()).unwrap();
    assert_eq!(m.status, status::DRAFT);
    assert_eq!(m.active_run_id, None);
    assert_eq!((m.started_at, m.ended_at), (None, None));
    assert_eq!(m.max_parallel, 2, "sin pedir paralelismo, el mismo default que un run");
    assert_eq!(m.complexity.as_deref(), Some("trivial"));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM runs"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 0);
}

/// El contrato de la etapa: una misión en borrador es solo base. Crearla, editarla,
/// listarla y abrirla no lanza agentes, no abre terminales y no crea worktrees.
#[test]
fn crear_y_abrir_una_mision_no_lanza_nada() {
    let db = db();
    let (procesos, ptys, worktrees) =
        (crate::runs::live_task_count(), crate::terminal::live_pty_count(), crate::runs::worktree_count());
    {
        let conn = db.lock().unwrap();
        let m = create(&conn, "w1", &pedido()).unwrap();
        update(&conn, &m.id, &MissionInput { title: "Otro".into(), ..pedido() }).unwrap();
        store::list(&conn, "w1").unwrap();
        detail(&conn, &m.id).unwrap();
        for table in ["runs", "tasks", "task_approvals", "run_facts"] {
            assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM {table}")), 0, "{table}");
        }
    }
    assert_eq!(crate::runs::live_task_count(), procesos, "ningún proceso headless");
    assert_eq!(crate::terminal::live_pty_count(), ptys, "ningún PTY");
    assert_eq!(crate::runs::worktree_count(), worktrees, "ningún worktree");
}

#[test]
fn la_lista_va_de_la_mas_nueva_a_la_mas_vieja_y_es_por_workspace() {
    let db = db();
    let conn = db.lock().unwrap();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w2', 'W2', 0, 0)", [])
        .unwrap();
    let a = create(&conn, "w1", &MissionInput { title: "A".into(), ..pedido() }).unwrap();
    let b = create(&conn, "w1", &MissionInput { title: "B".into(), ..pedido() }).unwrap();
    create(&conn, "w2", &MissionInput { title: "C".into(), ..pedido() }).unwrap();
    let ids: Vec<String> = store::list(&conn, "w1").unwrap().into_iter().map(|s| s.mission.id).collect();
    assert_eq!(ids, vec![b.id, a.id]);
    let first = &store::list(&conn, "w1").unwrap()[0];
    assert_eq!((first.workers_total, first.workers_done, first.spent_usd), (0, 0, 0.0));
    assert_eq!((first.lead_agent.as_deref(), first.lead_status.as_deref()), (None, None));
}

#[test]
fn el_detalle_de_un_borrador_no_tiene_runs_ni_tareas() {
    let db = db();
    let id = borrador(&db);
    let d = detail(&db.lock().unwrap(), &id).unwrap();
    assert_eq!(d.mission.id, id);
    assert!(d.runs.is_empty() && d.tasks.is_empty() && d.facts.is_empty());
}

#[test]
fn un_borrador_se_edita_entero() {
    let db = db();
    let id = borrador(&db);
    let conn = db.lock().unwrap();
    let m = update(
        &conn,
        &id,
        &MissionInput {
            title: "Nuevo".into(),
            objective: "Otro objetivo".into(),
            max_parallel: Some(9),
            budget_usd: Some(1.5),
            lead_agent_id: Some("codex".into()),
            lead_model: Some("gpt-5".into()),
            lead_account_id: Some("acc-1".into()),
            auto_account: false,
            complexity: None,
            ..pedido()
        },
    )
    .unwrap();
    assert_eq!((m.title.as_str(), m.objective.as_str()), ("Nuevo", "Otro objetivo"));
    assert_eq!(m.max_parallel, 6, "el paralelismo se topa igual que en la flota");
    assert_eq!(m.budget_usd, Some(1.5));
    assert_eq!((m.lead_agent_id.as_deref(), m.lead_model.as_deref()), (Some("codex"), Some("gpt-5")));
    assert_eq!((m.lead_account_id.as_deref(), m.auto_account), (Some("acc-1"), false));
    assert_eq!(m.status, status::DRAFT);
}

#[test]
fn con_cuenta_automatica_no_se_guarda_una_cuenta_elegida() {
    let db = db();
    let conn = db.lock().unwrap();
    let m = create(&conn, "w1", &MissionInput { lead_account_id: Some("acc-1".into()), auto_account: true, ..pedido() })
        .unwrap();
    assert_eq!(m.lead_account_id, None);
}

// ── Validación ──────────────────────────────────────────────────

#[test]
fn titulo_y_objetivo_vacios_se_rechazan_juntos() {
    let db = db();
    let e = create(&db.lock().unwrap(), "w1", &MissionInput { title: "  ".into(), objective: "".into(), ..pedido() })
        .unwrap_err();
    assert!(e.contains("título") && e.contains("objetivo"), "{e}");
}

#[test]
fn un_workspace_que_no_existe_se_rechaza() {
    let db = db();
    let e = create(&db.lock().unwrap(), "nada", &pedido()).unwrap_err();
    assert!(e.contains("workspace"), "{e}");
}

#[test]
fn un_provider_que_no_existe_se_rechaza() {
    let db = db();
    let e = create(&db.lock().unwrap(), "w1", &MissionInput { lead_agent_id: Some("nope".into()), ..pedido() })
        .unwrap_err();
    assert!(e.contains("no es un provider conocido"), "{e}");
}

/// La terminal está en el registro, pero no tiene `HeadlessAgent`: no puede ser lead.
#[test]
fn un_provider_sin_headless_no_puede_ser_lead() {
    let db = db();
    let e = create(&db.lock().unwrap(), "w1", &MissionInput { lead_agent_id: Some("bash".into()), ..pedido() })
        .unwrap_err();
    assert!(e.contains("sin terminal"), "{e}");
}

#[test]
fn un_modelo_sin_agente_y_un_presupuesto_no_positivo_se_rechazan() {
    let db = db();
    let e = create(&db.lock().unwrap(), "w1", &MissionInput { lead_model: Some("opus".into()), budget_usd: Some(0.0), ..pedido() })
        .unwrap_err();
    assert!(e.contains("modelo fijo") && e.contains("presupuesto"), "{e}");
}

#[test]
fn una_mision_arrancada_solo_cambia_el_titulo() {
    let db = db();
    let id = borrador(&db);
    arrancar(&db, &id);
    let conn = db.lock().unwrap();
    let e = update(&conn, &id, &MissionInput { objective: "Otra cosa".into(), ..pedido() }).unwrap_err();
    assert!(e.contains("solo se le puede cambiar el título"), "{e}");
    let m = update(&conn, &id, &MissionInput { title: "Renombrada".into(), ..pedido() }).unwrap();
    assert_eq!(m.title, "Renombrada");
    assert_eq!(m.objective, pedido().objective);
}

#[test]
fn una_mision_terminada_tampoco_se_reconfigura() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, ..Default::default() });
    let e = update(&db.lock().unwrap(), &id, &MissionInput { max_parallel: Some(4), ..pedido() }).unwrap_err();
    assert!(e.contains("solo se le puede cambiar el título"), "{e}");
}

// ── Arrancar ────────────────────────────────────────────────────

#[test]
fn arrancar_crea_el_run_atado_y_lanza_solo_al_lead() {
    let db = db();
    let id = borrador(&db);
    let pedido_ruteo: RefCell<Option<RouteRequest>> = RefCell::new(None);
    let lanzados = RefCell::new(Vec::new());
    let m = start(
        &db,
        &id,
        |req| {
            *pedido_ruteo.borrow_mut() = Some(req.clone());
            Ok(asignacion("claude-code"))
        },
        |t| {
            lanzados.borrow_mut().push(t.clone());
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(m.status, status::RUNNING);
    assert!(m.started_at.is_some());
    let run_id = m.active_run_id.clone().expect("run activo");

    let req = pedido_ruteo.into_inner().unwrap();
    assert_eq!(req.complexity, Some(Complexity::Trivial), "rutea con la complejidad de la misión");

    let lanzados = lanzados.into_inner();
    assert_eq!(lanzados.len(), 1, "se lanza una vez, por el ejecutor recibido");
    let lead = &lanzados[0];
    assert_eq!(lead.role.as_deref(), Some(role::LEAD));
    assert_eq!(lead.run_id, run_id);
    assert_eq!(lead.title, "Hola");
    assert!(lead.prompt.starts_with("Crear hello.txt con ADE AGS"));

    let conn = db.lock().unwrap();
    let run = runs_store::run_by_id(&conn, &run_id).unwrap().unwrap();
    assert_eq!(run.mission_id.as_deref(), Some(id.as_str()));
    assert_eq!(run.objective, pedido().objective);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 1, "ningún worker inventado");
}

#[test]
fn sin_modelo_ni_complejidad_el_lead_va_a_hard() {
    let db = db();
    let id = {
        let conn = db.lock().unwrap();
        create(&conn, "w1", &MissionInput { complexity: None, ..pedido() }).unwrap().id
    };
    let visto = RefCell::new(None);
    start(&db, &id, |req| {
        *visto.borrow_mut() = req.complexity;
        Ok(asignacion("claude-code"))
    }, |_| Ok(()))
    .unwrap();
    assert_eq!(visto.into_inner(), Some(Complexity::Hard));
}

/// El ruteo por complejidad puede devolver cualquier agente del tramo. Si ese no corre sin
/// terminal, se falla antes de crear el run.
#[test]
fn si_el_ruteo_elige_un_provider_sin_headless_no_se_crea_nada() {
    let db = db();
    let id = borrador(&db);
    let lanzo = RefCell::new(false);
    let e = start(&db, &id, |_| Ok(asignacion("bash")), |_| {
        *lanzo.borrow_mut() = true;
        Ok(())
    })
    .unwrap_err();
    assert!(e.contains("sin terminal"), "{e}");
    assert!(!lanzo.into_inner());
    assert_eq!(estado(&db, &id), status::DRAFT);
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

#[test]
fn una_carpeta_que_no_existe_frena_antes_de_rutear() {
    let db = db();
    let id = {
        let conn = db.lock().unwrap();
        create(&conn, "w1", &MissionInput { cwd: "/no/existe/ade-ags".into(), ..pedido() }).unwrap().id
    };
    let e = start(&db, &id, |_| panic!("no se rutea"), |_| panic!("no se lanza")).unwrap_err();
    assert!(e.contains("no existe"), "{e}");
    assert_eq!(estado(&db, &id), status::DRAFT);
}

#[test]
fn un_error_de_ruteo_deja_el_borrador_intacto() {
    let db = db();
    let id = borrador(&db);
    let e = start(&db, &id, |_| Err("no hay cuenta con cupo".into()), |_| panic!("no se lanza")).unwrap_err();
    assert_eq!(e, "no hay cuenta con cupo");
    assert_eq!(estado(&db, &id), status::DRAFT);
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

#[test]
fn no_se_arranca_dos_veces() {
    let db = db();
    let id = borrador(&db);
    arrancar(&db, &id);
    let e = start(&db, &id, |_| Ok(asignacion("claude-code")), |_| panic!("no se lanza")).unwrap_err();
    assert!(e.contains("ya no es un borrador"), "{e}");
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 1);
}

/// Si el proceso del lead no arranca, nada desaparece: el run y el lead quedan fallidos con
/// el motivo, y la misión los sigue.
#[test]
fn si_el_lead_no_arranca_la_mision_queda_fallida_con_el_motivo() {
    let db = db();
    let id = borrador(&db);
    let e = start(&db, &id, |_| Ok(asignacion("claude-code")), |_| Err("no se pudo lanzar 'claude'".into()))
        .unwrap_err();
    assert!(e.contains("no se pudo lanzar"));

    let conn = db.lock().unwrap();
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(m.status, status::FAILED);
    assert!(m.ended_at.is_some());
    let run = runs_store::run_by_id(&conn, m.active_run_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(run.status, "failed");
    let lead = &runs_store::tasks_of_run(&conn, &run.id).unwrap()[0];
    assert_eq!(lead.status, task_status::FAILED);
    assert_eq!(lead.error.as_deref(), Some("no se pudo lanzar 'claude'"));
}

// ── El estado sigue al run ──────────────────────────────────────

#[test]
fn run_terminado_bien_deja_la_mision_hecha() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    let run = correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, cost_usd: Some(0.02), ..Default::default() });
    assert_eq!(run, "done");
    let conn = db.lock().unwrap();
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(m.status, status::DONE);
    assert!(m.ended_at.is_some());
    let s = &store::list(&conn, "w1").unwrap()[0];
    assert_eq!((s.workers_done, s.workers_total), (0, 0), "el lead no es un worker");
    assert_eq!(s.lead_agent.as_deref(), Some("claude-code"));
    assert_eq!(s.lead_status.as_deref(), Some(task_status::DONE));
    assert!((s.spent_usd - 0.02).abs() < 1e-9);
}

#[test]
fn run_fallido_deja_la_mision_fallida() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    correr_y_cerrar(&db, &lead.id, TaskOutcome::failed("se cayó"));
    assert_eq!(estado(&db, &id), status::FAILED);
}

#[test]
fn mientras_quede_un_worker_la_mision_sigue_corriendo() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    {
        let conn = db.lock().unwrap();
        runs_store::create_task(
            &conn,
            &runs_store::NewTask {
                run_id: &lead.run_id,
                title: "w",
                prompt: "p",
                agent_id: "claude-code",
                cwd: &proyecto(),
                role: Some(role::WORKER),
                queued: true,
                ..Default::default()
            },
        )
        .unwrap();
    }
    correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, ..Default::default() });
    assert_eq!(estado(&db, &id), status::RUNNING);
}

/// El avance cuenta workers y el lead va aparte: recién arrancada, 0 workers y el lead
/// planificando; con el plan, cuántos de los workers terminaron.
#[test]
fn el_avance_es_de_los_workers_y_el_lead_va_aparte() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    let resumen = |db: &DbConnection| store::list(&db.lock().unwrap(), "w1").unwrap().remove(0);

    let s = resumen(&db);
    assert_eq!((s.workers_done, s.workers_total), (0, 0));
    assert!(s.lead_status.is_some_and(|st| !task_status::is_final(&st)), "el lead sigue planificando");

    let workers: Vec<String> = {
        let conn = db.lock().unwrap();
        (0..2)
            .map(|i| {
                runs_store::create_task(
                    &conn,
                    &runs_store::NewTask {
                        run_id: &lead.run_id,
                        title: if i == 0 { "backend" } else { "frontend" },
                        prompt: "p",
                        agent_id: "codex",
                        cwd: &proyecto(),
                        role: Some(role::WORKER),
                        queued: true,
                        ..Default::default()
                    },
                )
                .unwrap()
                .id
            })
            .collect()
    };
    let s = resumen(&db);
    assert_eq!((s.workers_done, s.workers_total), (0, 2));

    correr_y_cerrar(&db, &workers[0], TaskOutcome { ok: true, ..Default::default() });
    let s = resumen(&db);
    assert_eq!((s.workers_done, s.workers_total), (1, 2));

    correr_y_cerrar(&db, &workers[1], TaskOutcome { ok: true, ..Default::default() });
    correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, ..Default::default() });
    let s = resumen(&db);
    assert_eq!((s.workers_done, s.workers_total), (2, 2));
    assert_eq!(s.mission.status, status::DONE);
}

// ── Cancelar ────────────────────────────────────────────────────

#[test]
fn cancelar_un_borrador_no_toca_ningun_run() {
    let db = db();
    let id = borrador(&db);
    let m = cancel(&db, &id, |_| panic!("un borrador no tiene run")).unwrap();
    assert_eq!(m.status, status::CANCELLED);
    assert!(m.ended_at.is_some());
    let e = start(&db, &id, |_| panic!(), |_| panic!()).unwrap_err();
    assert!(e.contains("ya no es un borrador"), "{e}");
}

#[test]
fn cancelar_una_mision_que_corre_cancela_su_run() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    {
        let conn = db.lock().unwrap();
        runs_store::mark_running(&conn, &lead.id, "s-1", "/tmp/e.jsonl").unwrap();
    }
    let parados = RefCell::new(Vec::new());
    let m = cancel(&db, &id, |run_id| {
        assert_eq!(run_id, lead.run_id);
        // Lo que hace `supervisor::cancel` con la fila: marcarla antes de matar el proceso.
        crate::runs::cancel_run_with(&db, run_id, |task_id| {
            parados.borrow_mut().push(task_id.to_string());
            let conn = db.lock().unwrap();
            conn.execute("UPDATE tasks SET status = 'cancelled' WHERE id = ?1", [task_id]).unwrap();
            Ok(())
        })
        .map(|_| ())
    })
    .unwrap();
    assert_eq!(parados.into_inner(), vec![lead.id.clone()]);
    assert_eq!(m.status, status::CANCELLED);
    let run = runs_store::run_by_id(&db.lock().unwrap(), &lead.run_id).unwrap().unwrap();
    assert_eq!(run.status, "cancelled");
}

#[test]
fn una_mision_terminada_no_se_cancela() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, ..Default::default() });
    let e = cancel(&db, &id, |_| panic!("no hay nada que parar")).unwrap_err();
    assert!(e.contains("ya terminó"), "{e}");
}

// ── Lo de antes sigue igual ─────────────────────────────────────

#[test]
fn un_run_sin_mision_sigue_funcionando_como_siempre() {
    let db = db();
    let conn = db.lock().unwrap();
    let run = runs_store::create_run(&conn, "w1", "a mano", "/p").unwrap();
    assert_eq!(run.mission_id, None);
    let t = runs_store::create_task(
        &conn,
        &runs_store::NewTask { run_id: &run.id, title: "t", prompt: "p", agent_id: "claude-code", cwd: "/p", ..Default::default() },
    )
    .unwrap();
    runs_store::finish_task(&conn, &t.id, &TaskOutcome { ok: true, ..Default::default() }).unwrap();
    assert_eq!(runs_store::refresh_run_status(&conn, &run.id).unwrap(), "done");
    assert_eq!(runs_store::list_runs(&conn, "w1").unwrap().len(), 1);
    assert_eq!(runs_store::list_tasks(&conn, "w1").unwrap().len(), 1);
    assert!(store::list(&conn, "w1").unwrap().is_empty(), "ningún run se vuelve misión solo");
}

fn orquestacion_de_flota<'a>(cwd: &'a str) -> crate::runs::Orchestration<'a> {
    crate::runs::Orchestration {
        workspace_id: "w1",
        cwd,
        objective: "  Repartir el login\nen tres partes ",
        title: None,
        max_parallel: 9,
        budget_usd: Some(2.0),
        mission_id: None,
    }
}

/// `run_start_orchestration` pasa por el mismo camino que una misión y queda como antes:
/// run sin misión, lead con la primera línea del objetivo, paralelismo topado.
#[test]
fn la_orquestacion_de_la_flota_sigue_creando_runs_sin_mision() {
    let db = db();
    let cwd = proyecto();
    let lead = crate::runs::start_orchestration(
        &db,
        &orquestacion_de_flota(&cwd),
        &asignacion("claude-code"),
        None,
        |_, _| Ok(()),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(lead.role.as_deref(), Some(role::LEAD));
    assert_eq!(lead.title, "Repartir el login");
    let conn = db.lock().unwrap();
    let run = runs_store::run_by_id(&conn, &lead.run_id).unwrap().unwrap();
    assert_eq!(run.mission_id, None);
    assert_eq!((run.max_parallel, run.budget_usd), (6, Some(2.0)));
    assert!(store::list(&conn, "w1").unwrap().is_empty());
}

#[test]
fn la_orquestacion_de_la_flota_rechaza_un_lead_sin_headless_sin_crear_filas() {
    let db = db();
    let cwd = proyecto();
    let e = crate::runs::start_orchestration(
        &db,
        &orquestacion_de_flota(&cwd),
        &asignacion("bash"),
        None,
        |_, _| Ok(()),
        |_| panic!("no se lanza"),
    )
    .unwrap_err();
    assert!(e.contains("sin terminal"), "{e}");
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

/// Solo el run activo mueve a la misión: un run viejo que se recalcula no la pisa.
#[test]
fn un_run_que_no_es_el_activo_no_mueve_a_la_mision() {
    let db = db();
    let id = borrador(&db);
    arrancar(&db, &id);
    let conn = db.lock().unwrap();
    let viejo = runs_store::create_run(&conn, "w1", "otro intento", "/p").unwrap();
    runs_store::set_run_mission(&conn, &viejo.id, &id).unwrap();
    let t = runs_store::create_task(
        &conn,
        &runs_store::NewTask { run_id: &viejo.id, title: "t", prompt: "p", agent_id: "claude-code", cwd: "/p", ..Default::default() },
    )
    .unwrap();
    runs_store::finish_task(&conn, &t.id, &TaskOutcome::failed("x")).unwrap();
    assert_eq!(runs_store::refresh_run_status(&conn, &viejo.id).unwrap(), "failed");
    assert_eq!(store::get(&conn, &id).unwrap().unwrap().status, status::RUNNING);
    assert_eq!(runs_store::runs_of_mission(&conn, &id).unwrap().len(), 2, "una misión admite varios runs");
}

/// Migrar una base de la v18: `missions` nace vacía, los runs existentes quedan sin misión y
/// sus tareas intactas.
#[test]
fn migrar_desde_v18_no_convierte_runs_en_misiones() {
    let conn = test_db();
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         DROP INDEX idx_runs_mission;
         DROP TABLE missions;
         CREATE TABLE runs_v18 (
             id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, objective TEXT NOT NULL, cwd TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'running', max_parallel INTEGER NOT NULL DEFAULT 2,
             budget_usd REAL, spent_usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ended_at INTEGER
         );
         DROP TABLE runs;
         ALTER TABLE runs_v18 RENAME TO runs;
         PRAGMA foreign_keys = ON;
         INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at) VALUES ('r', 'ws', 'o', '/p', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, cwd, created_at)
             VALUES ('t', 'r', 'tit', 'pr', 'claude-code', '/p', 0);
         PRAGMA user_version = 18;",
    )
    .unwrap();

    crate::database::migrate_for_tests(&conn).expect("migrar de v18 a v19");

    let run = runs_store::run_by_id(&conn, "r").unwrap().unwrap();
    assert_eq!(run.mission_id, None);
    assert_eq!(runs_store::tasks_of_run(&conn, "r").unwrap().len(), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM missions"), 0);
}

// ── `cc-mission-changed` ────────────────────────────────────────

mod eventos {
    use super::*;
    use crate::missions::{mission_create, mission_update, MISSION_CHANGED};
    use tauri::{Listener, Manager};

    /// Una app de prueba con la base, y lo que va llegando por `cc-mission-changed`.
    fn app_que_escucha(db: DbConnection) -> (tauri::App<tauri::test::MockRuntime>, Arc<Mutex<Vec<String>>>) {
        let app = tauri::test::mock_app();
        app.manage(db);
        let vistos = Arc::new(Mutex::new(Vec::new()));
        let v = vistos.clone();
        app.listen_any(MISSION_CHANGED, move |e| {
            v.lock().unwrap().push(serde_json::from_str::<String>(e.payload()).unwrap());
        });
        (app, vistos)
    }

    #[test]
    fn crear_y_editar_avisan_con_el_id() {
        let (app, vistos) = app_que_escucha(db());
        let m = mission_create(app.handle().clone(), "w1".into(), pedido(), app.state()).unwrap();
        assert_eq!(*vistos.lock().unwrap(), vec![m.id.clone()]);

        mission_update(app.handle().clone(), m.id.clone(), MissionInput { title: "Otro".into(), ..pedido() }, app.state())
            .unwrap();
        assert_eq!(*vistos.lock().unwrap(), vec![m.id.clone(), m.id]);
    }

    #[test]
    fn un_pedido_invalido_no_avisa() {
        let (app, vistos) = app_que_escucha(db());
        let vacio = MissionInput { objective: "  ".into(), ..pedido() };
        assert!(mission_create(app.handle().clone(), "w1".into(), vacio, app.state()).is_err());
        assert!(vistos.lock().unwrap().is_empty());
    }

    /// El scheduler avisa cuando `refresh_run` dice que la misión cambió: solo al cerrarse,
    /// no en cada vuelta mientras sigue corriendo.
    #[test]
    fn el_cierre_del_run_dice_que_mision_cambio_y_solo_entonces() {
        let db = db();
        let id = borrador(&db);
        let lead = arrancar(&db, &id);
        {
            let conn = db.lock().unwrap();
            assert_eq!(runs_store::refresh_run(&conn, &lead.run_id).unwrap(), ("running".into(), None));
            runs_store::mark_running(&conn, &lead.id, "s-1", "/tmp/e.jsonl").unwrap();
            runs_store::finish_task(&conn, &lead.id, &TaskOutcome { ok: true, ..Default::default() }).unwrap();
            assert_eq!(runs_store::refresh_run(&conn, &lead.run_id).unwrap(), ("done".into(), Some(id.clone())));
            assert_eq!(runs_store::refresh_run(&conn, &lead.run_id).unwrap(), ("done".into(), None), "ya avisado");
        }
        assert_eq!(estado(&db, &id), status::DONE);
    }

    #[test]
    fn fallar_y_cancelar_tambien_avisan() {
        for (outcome, esperado) in [
            (Some(TaskOutcome::failed("x")), status::FAILED),
            (None, status::CANCELLED),
        ] {
            let db = db();
            let id = borrador(&db);
            let lead = arrancar(&db, &id);
            let conn = db.lock().unwrap();
            match outcome {
                Some(o) => {
                    runs_store::finish_task(&conn, &lead.id, &o).unwrap();
                }
                None => {
                    runs_store::cancel_pending(&conn, &lead.run_id, "se canceló").unwrap();
                    conn.execute("UPDATE tasks SET status = 'cancelled' WHERE id = ?1", [&lead.id]).unwrap();
                }
            }
            let (_, cambio) = runs_store::refresh_run(&conn, &lead.run_id).unwrap();
            assert_eq!(cambio.as_deref(), Some(id.as_str()), "{esperado}");
            assert_eq!(store::get(&conn, &id).unwrap().unwrap().status, esperado);
        }
    }

    #[test]
    fn un_run_sin_mision_no_avisa_por_ninguna() {
        let db = db();
        let conn = db.lock().unwrap();
        let run = runs_store::create_run(&conn, "w1", "suelto", "/p").unwrap();
        assert_eq!(store::mission_of_run(&conn, &run.id).unwrap(), None);
        assert_eq!(runs_store::refresh_run(&conn, &run.id).unwrap().1, None);
    }
}
