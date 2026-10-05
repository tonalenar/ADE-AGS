//! Tests de las misiones.
//!
//! Nada de acá lanza un agente: el ruteo y el supervisor entran como closures, y lo que el
//! supervisor haría con la fila (arrancarla, cerrarla) se hace con las mismas funciones de
//! `runs::store` que usa él.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::types::{MissionInput, status};
use super::{cancel, create, detail, start, store, update};
use crate::database::{DbConnection, test_db};
use crate::runs::routing::{Assignment, RouteRequest, RoutedBy};
use crate::runs::store as runs_store;
use crate::runs::types::{TaskOutcome, role, status as task_status};
use crate::runs::{Complexity, Task};
use crate::squads::{self, SquadInput};

fn db() -> DbConnection {
    let conn = test_db();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)",
        [],
    )
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

fn squad_para_mission(conn: &Connection) -> String {
    let input: SquadInput = serde_json::from_value(serde_json::json!({
        "name": "Mission Squad",
        "description": "Squad test",
        "lead": { "agentId": "claude-code", "model": "lead-model", "autoAccount": true, "complexity": null },
        "members": []
    })).unwrap();
    let valid = squads::store::validate(conn, &input).unwrap();
    squads::store::create(conn, &valid).unwrap().id
}

fn asignacion(agent: &str) -> Assignment {
    Assignment {
        agent_id: agent.into(),
        model: Some("haiku".into()),
        account_id: None,
        routed_by: RoutedBy::Policy,
        notes: vec![],
        auto_account: true,
        pool_origin: None,
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
    start(
        db,
        id,
        |_| Ok(asignacion("claude-code")),
        |t| {
            *lanzado.borrow_mut() = Some(t.clone());
            Ok(())
        },
    )
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
    assert_eq!(
        m.max_parallel, 2,
        "sin pedir paralelismo, el mismo default que un run"
    );
    assert_eq!(m.complexity.as_deref(), Some("trivial"));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM runs"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 0);
}

#[test]
fn mission_squad_mode_uses_squad_as_the_only_lead_configuration() {
    let conn = test_db();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)",
        [],
    )
    .unwrap();
    let squad_id = squad_para_mission(&conn);
    let squad_input = MissionInput {
        complexity: None,
        squad_id: Some(squad_id.clone()),
        ..pedido()
    };
    let valid = store::validate(&conn, &squad_input).unwrap();
    assert_eq!(valid.squad_id.as_deref(), Some(squad_id.as_str()));
    assert_eq!(
        (
            valid.lead_agent_id.as_deref(),
            valid.lead_model.as_deref(),
            valid.lead_account_id.as_deref()
        ),
        (None, None, None)
    );
    assert_eq!(valid.complexity.as_deref(), None);
    let mission = store::create(&conn, "w1", &valid).unwrap();
    assert_eq!(mission.squad_id.as_deref(), Some(squad_id.as_str()));
    assert_eq!(mission.lead_agent_id, None);
    assert_eq!(mission.lead_model, None);

    let conflicting = [
        MissionInput {
            lead_agent_id: Some("codex".into()),
            ..squad_input.clone()
        },
        MissionInput {
            lead_model: Some("gpt-5".into()),
            ..squad_input.clone()
        },
        MissionInput {
            lead_account_id: Some("work-account".into()),
            ..squad_input.clone()
        },
        MissionInput {
            auto_account: false,
            ..squad_input.clone()
        },
        MissionInput {
            complexity: Some(Complexity::Trivial),
            ..squad_input.clone()
        },
    ];
    for input in conflicting {
        assert!(
            store::validate(&conn, &input)
                .unwrap_err()
                .contains("cannot override the Squad Lead"),
            "manual Lead settings must not conflict with Squad routing"
        );
    }
    let missing = MissionInput {
        squad_id: Some("missing-squad".into()),
        ..squad_input
    };
    assert!(
        store::validate(&conn, &missing)
            .unwrap_err()
            .contains("no squad 'missing-squad' exists")
    );
}

/// El contrato de la etapa: una misión en borrador es solo base. Crearla, editarla,
/// listarla y abrirla no lanza agentes, no abre terminales y no crea worktrees.
#[test]
fn crear_y_abrir_una_mision_no_lanza_nada() {
    let db = db();
    let (procesos, ptys, worktrees) = (
        crate::runs::live_task_count(),
        crate::terminal::live_pty_count(),
        crate::runs::worktree_count(),
    );
    {
        let conn = db.lock().unwrap();
        let m = create(&conn, "w1", &pedido()).unwrap();
        update(
            &conn,
            &m.id,
            &MissionInput {
                title: "Otro".into(),
                ..pedido()
            },
        )
        .unwrap();
        store::list(&conn, "w1").unwrap();
        detail(&conn, &m.id).unwrap();
        for table in ["runs", "tasks", "task_approvals", "run_facts"] {
            assert_eq!(
                count(&conn, &format!("SELECT COUNT(*) FROM {table}")),
                0,
                "{table}"
            );
        }
    }
    assert_eq!(
        crate::runs::live_task_count(),
        procesos,
        "ningún proceso headless"
    );
    assert_eq!(crate::terminal::live_pty_count(), ptys, "ningún PTY");
    assert_eq!(crate::runs::worktree_count(), worktrees, "ningún worktree");
}

#[test]
fn la_lista_va_de_la_mas_nueva_a_la_mas_vieja_y_es_por_workspace() {
    let db = db();
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w2', 'W2', 0, 0)",
        [],
    )
    .unwrap();
    let a = create(
        &conn,
        "w1",
        &MissionInput {
            title: "A".into(),
            ..pedido()
        },
    )
    .unwrap();
    let b = create(
        &conn,
        "w1",
        &MissionInput {
            title: "B".into(),
            ..pedido()
        },
    )
    .unwrap();
    create(
        &conn,
        "w2",
        &MissionInput {
            title: "C".into(),
            ..pedido()
        },
    )
    .unwrap();
    let ids: Vec<String> = store::list(&conn, "w1")
        .unwrap()
        .into_iter()
        .map(|s| s.mission.id)
        .collect();
    assert_eq!(ids, vec![b.id, a.id]);
    let first = &store::list(&conn, "w1").unwrap()[0];
    assert_eq!(
        (first.workers_total, first.workers_done, first.spent_usd),
        (0, 0, 0.0)
    );
    assert_eq!(
        (first.lead_agent.as_deref(), first.lead_status.as_deref()),
        (None, None)
    );
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
            lead_agent_id: Some("opencode".into()),
            lead_model: Some("gpt-5".into()),
            lead_account_id: Some("acc-1".into()),
            auto_account: false,
            complexity: None,
            ..pedido()
        },
    )
    .unwrap();
    assert_eq!(
        (m.title.as_str(), m.objective.as_str()),
        ("Nuevo", "Otro objetivo")
    );
    assert_eq!(
        m.max_parallel, 6,
        "el paralelismo se topa igual que en la flota"
    );
    assert_eq!(m.budget_usd, Some(1.5));
    assert_eq!(
        (m.lead_agent_id.as_deref(), m.lead_model.as_deref()),
        (Some("opencode"), Some("gpt-5"))
    );
    assert_eq!(
        (m.lead_account_id.as_deref(), m.auto_account),
        (Some("acc-1"), false)
    );
    assert_eq!(m.status, status::DRAFT);
}

#[test]
fn con_cuenta_automatica_no_se_guarda_una_cuenta_elegida() {
    let db = db();
    let conn = db.lock().unwrap();
    let m = create(
        &conn,
        "w1",
        &MissionInput {
            lead_account_id: Some("acc-1".into()),
            auto_account: true,
            ..pedido()
        },
    )
    .unwrap();
    assert_eq!(m.lead_account_id, None);
}

// ── Validación ──────────────────────────────────────────────────

#[test]
fn titulo_y_objetivo_vacios_se_rechazan_juntos() {
    let db = db();
    let e = create(
        &db.lock().unwrap(),
        "w1",
        &MissionInput {
            title: "  ".into(),
            objective: "".into(),
            ..pedido()
        },
    )
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
    let e = create(
        &db.lock().unwrap(),
        "w1",
        &MissionInput {
            lead_agent_id: Some("nope".into()),
            ..pedido()
        },
    )
    .unwrap_err();
    assert!(e.contains("no es un provider conocido"), "{e}");
}

/// La terminal está en el registro, pero no tiene `HeadlessAgent`: no puede ser lead.
#[test]
fn un_provider_sin_headless_no_puede_ser_lead() {
    let db = db();
    let e = create(
        &db.lock().unwrap(),
        "w1",
        &MissionInput {
            lead_agent_id: Some("bash".into()),
            ..pedido()
        },
    )
    .unwrap_err();
    assert!(e.contains("sin terminal"), "{e}");
}

#[test]
fn un_modelo_sin_agente_y_un_presupuesto_no_positivo_se_rechazan() {
    let db = db();
    let e = create(
        &db.lock().unwrap(),
        "w1",
        &MissionInput {
            lead_model: Some("opus".into()),
            budget_usd: Some(0.0),
            ..pedido()
        },
    )
    .unwrap_err();
    assert!(
        e.contains("modelo fijo") && e.contains("presupuesto"),
        "{e}"
    );
}

#[test]
fn una_mision_arrancada_solo_cambia_el_titulo() {
    let db = db();
    let id = borrador(&db);
    arrancar(&db, &id);
    let conn = db.lock().unwrap();
    let e = update(
        &conn,
        &id,
        &MissionInput {
            objective: "Otra cosa".into(),
            ..pedido()
        },
    )
    .unwrap_err();
    assert!(e.contains("solo se le puede cambiar el título"), "{e}");
    let m = update(
        &conn,
        &id,
        &MissionInput {
            title: "Renombrada".into(),
            ..pedido()
        },
    )
    .unwrap();
    assert_eq!(m.title, "Renombrada");
    assert_eq!(m.objective, pedido().objective);
}

#[test]
fn una_mision_terminada_tampoco_se_reconfigura() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    correr_y_cerrar(
        &db,
        &lead.id,
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
    let e = update(
        &db.lock().unwrap(),
        &id,
        &MissionInput {
            max_parallel: Some(4),
            ..pedido()
        },
    )
    .unwrap_err();
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
    assert_eq!(
        req.complexity,
        Some(Complexity::Trivial),
        "rutea con la complejidad de la misión"
    );

    let lanzados = lanzados.into_inner();
    assert_eq!(
        lanzados.len(),
        1,
        "se lanza una vez, por el ejecutor recibido"
    );
    let lead = &lanzados[0];
    assert_eq!(lead.role.as_deref(), Some(role::LEAD));
    assert_eq!(lead.run_id, run_id);
    assert_eq!(lead.title, "Hola");
    assert!(lead.prompt.starts_with("Crear hello.txt con ADE AGS"));

    let conn = db.lock().unwrap();
    let run = runs_store::run_by_id(&conn, &run_id).unwrap().unwrap();
    assert_eq!(run.mission_id.as_deref(), Some(id.as_str()));
    assert_eq!(run.objective, pedido().objective);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM tasks"),
        1,
        "ningún worker inventado"
    );
}

#[test]
fn sin_modelo_ni_complejidad_el_lead_va_a_hard() {
    let db = db();
    let id = {
        let conn = db.lock().unwrap();
        create(
            &conn,
            "w1",
            &MissionInput {
                complexity: None,
                ..pedido()
            },
        )
        .unwrap()
        .id
    };
    let visto = RefCell::new(None);
    start(
        &db,
        &id,
        |req| {
            *visto.borrow_mut() = req.complexity;
            Ok(asignacion("claude-code"))
        },
        |_| Ok(()),
    )
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
    let e = start(
        &db,
        &id,
        |_| Ok(asignacion("bash")),
        |_| {
            *lanzo.borrow_mut() = true;
            Ok(())
        },
    )
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
        create(
            &conn,
            "w1",
            &MissionInput {
                cwd: "/no/existe/ade-ags".into(),
                ..pedido()
            },
        )
        .unwrap()
        .id
    };
    let e = start(
        &db,
        &id,
        |_| panic!("no se rutea"),
        |_| panic!("no se lanza"),
    )
    .unwrap_err();
    assert!(e.contains("no existe"), "{e}");
    assert_eq!(estado(&db, &id), status::DRAFT);
}

#[test]
fn un_error_de_ruteo_deja_el_borrador_intacto() {
    let db = db();
    let id = borrador(&db);
    let e = start(
        &db,
        &id,
        |_| Err("no hay cuenta con cupo".into()),
        |_| panic!("no se lanza"),
    )
    .unwrap_err();
    assert_eq!(e, "no hay cuenta con cupo");
    assert_eq!(estado(&db, &id), status::DRAFT);
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

#[test]
fn no_se_arranca_dos_veces() {
    let db = db();
    let id = borrador(&db);
    arrancar(&db, &id);
    let e = start(
        &db,
        &id,
        |_| Ok(asignacion("claude-code")),
        |_| panic!("no se lanza"),
    )
    .unwrap_err();
    assert_eq!(e, "missions.error.notStartable");
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 1);
}

/// Si el proceso del lead no arranca, nada desaparece: el run y el lead quedan fallidos con
/// el motivo, y la misión los sigue.
#[test]
fn si_el_lead_no_arranca_la_mision_queda_fallida_con_el_motivo() {
    let db = db();
    let id = borrador(&db);
    let e = start(
        &db,
        &id,
        |_| Ok(asignacion("claude-code")),
        |_| Err("no se pudo lanzar 'claude'".into()),
    )
    .unwrap_err();
    assert!(e.contains("no se pudo lanzar"));

    let conn = db.lock().unwrap();
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(m.status, status::FAILED);
    assert!(m.ended_at.is_some());
    let run = runs_store::run_by_id(&conn, m.active_run_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(run.status, "failed");
    let lead = &runs_store::tasks_of_run(&conn, &run.id).unwrap()[0];
    assert_eq!(lead.status, task_status::FAILED);
    assert_eq!(lead.error.as_deref(), Some("no se pudo lanzar 'claude'"));
}

// ── El estado sigue al run ──────────────────────────────────────

#[test]
fn retry_failed_mission_preserves_configuration_and_previous_attempt() {
    let db = db();
    let input = MissionInput {
        lead_agent_id: Some("claude-code".into()),
        lead_model: Some("sonnet".into()),
        complexity: None,
        auto_account: false,
        max_parallel: Some(3),
        budget_usd: Some(0.25),
        ..pedido()
    };
    let id = create(&db.lock().unwrap(), "w1", &input).unwrap().id;
    let first = arrancar(&db, &id);
    correr_y_cerrar(&db, &first.id, TaskOutcome::failed("OAuth session expired"));
    let before = store::get(&db.lock().unwrap(), &id).unwrap().unwrap();
    assert!(before.ended_at.is_some());
    {
        let conn = db.lock().unwrap();
        runs_store::add_fact(&conn, &first.run_id, Some(&first.id), "note", "Previous diagnostic").unwrap();
    }

    let launched = RefCell::new(None);
    let retried = start(&db, &id, |request| {
        assert_eq!(request.agent_id.as_deref(), Some("claude-code"));
        assert_eq!(request.model.as_deref(), Some("sonnet"));
        assert_eq!(request.complexity, None);
        let mut assignment = asignacion("claude-code");
        assignment.model = request.model.clone();
        Ok(assignment)
    }, |task| {
        *launched.borrow_mut() = Some(task.clone());
        Ok(())
    }).unwrap();
    let second = launched.into_inner().unwrap();
    assert_ne!(second.id, first.id);
    assert_ne!(second.run_id, first.run_id);
    assert!(second.prompt.starts_with(&before.objective));
    assert_eq!(retried.id, before.id);
    assert_eq!(retried.created_at, before.created_at);
    assert_eq!(retried.objective, before.objective);
    assert_eq!(retried.cwd, before.cwd);
    assert_eq!(retried.lead_agent_id, before.lead_agent_id);
    assert_eq!(retried.lead_model, before.lead_model);
    assert_eq!(retried.lead_account_id, before.lead_account_id);
    assert_eq!(retried.auto_account, before.auto_account);
    assert_eq!(retried.max_parallel, before.max_parallel);
    assert_eq!(retried.budget_usd, before.budget_usd);
    assert_eq!(retried.active_run_id.as_deref(), Some(second.run_id.as_str()));
    assert_eq!(retried.status, status::RUNNING);
    assert_eq!(retried.ended_at, None);

    let conn = db.lock().unwrap();
    let old = runs_store::task_by_id(&conn, &first.id).unwrap().unwrap();
    assert_eq!(old.status, task_status::FAILED);
    assert_eq!(old.error.as_deref(), Some("OAuth session expired"));
    assert_eq!(runs_store::run_by_id(&conn, &first.run_id).unwrap().unwrap().status, "failed");
    assert_eq!(runs_store::facts_of_run(&conn, &first.run_id).unwrap()[0].body, "Previous diagnostic");
    assert_eq!(runs_store::refresh_run_status(&conn, &first.run_id).unwrap(), "failed");
    let current = detail(&conn, &id).unwrap();
    assert_eq!(current.mission.status, status::RUNNING);
    assert_eq!(current.runs.len(), 2);
    assert_eq!(current.tasks.len(), 1);
    assert_eq!(current.tasks[0].id, second.id);
    assert!(current.facts.is_empty());
}

#[test]
fn retry_routing_failure_leaves_previous_attempt_intact() {
    let db = db();
    let id = borrador(&db);
    let first = arrancar(&db, &id);
    correr_y_cerrar(&db, &first.id, TaskOutcome::failed("Login required"));
    let before = store::get(&db.lock().unwrap(), &id).unwrap().unwrap();
    let error = start(&db, &id, |_| Err("No account available".into()), |_| panic!("must not launch")).unwrap_err();
    assert_eq!(error, "No account available");
    let conn = db.lock().unwrap();
    assert_eq!(store::get(&conn, &id).unwrap().unwrap(), before);
    assert_eq!(runs_store::runs_of_mission(&conn, &id).unwrap().len(), 1);
}

#[test]
fn retry_launch_failure_is_saved_as_a_new_failed_attempt() {
    let db = db();
    let id = borrador(&db);
    let first = arrancar(&db, &id);
    correr_y_cerrar(&db, &first.id, TaskOutcome::failed("Previous failure"));
    let error = start(&db, &id, |_| Ok(asignacion("claude-code")), |_| Err("Launch failed again".into())).unwrap_err();
    assert_eq!(error, "Launch failed again");
    let conn = db.lock().unwrap();
    let current = detail(&conn, &id).unwrap();
    assert_eq!(current.mission.status, status::FAILED);
    assert_ne!(current.mission.active_run_id.as_deref(), Some(first.run_id.as_str()));
    assert_eq!(current.runs.len(), 2);
    assert_eq!(current.tasks[0].error.as_deref(), Some("Launch failed again"));
    assert_eq!(runs_store::task_by_id(&conn, &first.id).unwrap().unwrap().error.as_deref(), Some("Previous failure"));
}

#[test]
fn stale_retry_rolls_back_even_if_a_concurrent_attempt_has_already_failed() {
    let db = db();
    let id = borrador(&db);
    let first = arrancar(&db, &id);
    correr_y_cerrar(&db, &first.id, TaskOutcome::failed("First failure"));
    let winning_run = RefCell::new(None);
    let error = start(&db, &id, |_| {
        let second = arrancar(&db, &id);
        correr_y_cerrar(&db, &second.id, TaskOutcome::failed("Second failure"));
        *winning_run.borrow_mut() = Some(second.run_id);
        Ok(asignacion("claude-code"))
    }, |_| panic!("stale retry must not launch")).unwrap_err();
    assert_eq!(error, "missions.error.changed");
    let conn = db.lock().unwrap();
    let mission = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(mission.status, status::FAILED);
    assert_eq!(mission.active_run_id, winning_run.into_inner());
    assert_eq!(runs_store::runs_of_mission(&conn, &id).unwrap().len(), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 2);
}

#[test]
fn lead_without_workers_fails_mission() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    let run = correr_y_cerrar(
        &db,
        &lead.id,
        TaskOutcome {
            ok: true,
            cost_usd: Some(0.02),
            ..Default::default()
        },
    );
    assert_eq!(run, "failed");
    let conn = db.lock().unwrap();
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(m.status, status::FAILED);
    assert!(m.ended_at.is_some());
    let s = &store::list(&conn, "w1").unwrap()[0];
    assert_eq!(
        (s.workers_done, s.workers_total),
        (0, 0),
        "el lead no es un worker"
    );
    assert_eq!(s.lead_agent.as_deref(), Some("claude-code"));
    assert_eq!(s.lead_status.as_deref(), Some(task_status::FAILED));
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
                reasoning_effort: None,
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
    correr_y_cerrar(
        &db,
        &lead.id,
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
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
    assert!(
        s.lead_status.is_some_and(|st| !task_status::is_final(&st)),
        "el lead sigue planificando"
    );

    let workers: Vec<String> = {
        let conn = db.lock().unwrap();
        (0..2)
            .map(|i| {
                runs_store::create_task(
                    &conn,
                    &runs_store::NewTask {
                        reasoning_effort: None,
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

    correr_y_cerrar(
        &db,
        &workers[0],
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
    let s = resumen(&db);
    assert_eq!((s.workers_done, s.workers_total), (1, 2));

    correr_y_cerrar(
        &db,
        &workers[1],
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
    correr_y_cerrar(
        &db,
        &lead.id,
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
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
    assert_eq!(e, "missions.error.notStartable");
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
            conn.execute(
                "UPDATE tasks SET status = 'cancelled' WHERE id = ?1",
                [task_id],
            )
            .unwrap();
            Ok(())
        })
        .map(|_| ())
    })
    .unwrap();
    assert_eq!(parados.into_inner(), vec![lead.id.clone()]);
    assert_eq!(m.status, status::CANCELLED);
    let run = runs_store::run_by_id(&db.lock().unwrap(), &lead.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, "cancelled");
}

#[test]
fn una_mision_terminada_no_se_cancela() {
    let db = db();
    let id = borrador(&db);
    let lead = arrancar(&db, &id);
    correr_y_cerrar(
        &db,
        &lead.id,
        TaskOutcome {
            ok: true,
            ..Default::default()
        },
    );
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
        &runs_store::NewTask {
            reasoning_effort: None,
            run_id: &run.id,
            title: "t",
            prompt: "p",
            agent_id: "claude-code",
            cwd: "/p",
            ..Default::default()
        },
    )
    .unwrap();
    runs_store::finish_task(
        &conn,
        &t.id,
        &TaskOutcome {
            ok: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        runs_store::refresh_run_status(&conn, &run.id).unwrap(),
        "done"
    );
    assert_eq!(runs_store::list_runs(&conn, "w1").unwrap().len(), 1);
    assert_eq!(runs_store::list_tasks(&conn, "w1").unwrap().len(), 1);
    assert!(
        store::list(&conn, "w1").unwrap().is_empty(),
        "ningún run se vuelve misión solo"
    );
}

fn orquestacion_de_flota<'a>(cwd: &'a str) -> crate::runs::Orchestration<'a> {
    crate::runs::Orchestration {
        reasoning_effort: None,
        workspace_id: "w1",
        cwd,
        objective: "  Repartir el login\nen tres partes ",
        title: None,
        max_parallel: 9,
        budget_usd: Some(2.0),
        mission_id: None,
        squad: None,
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
        &runs_store::NewTask {
            reasoning_effort: None,
            run_id: &viejo.id,
            title: "t",
            prompt: "p",
            agent_id: "claude-code",
            cwd: "/p",
            ..Default::default()
        },
    )
    .unwrap();
    runs_store::finish_task(&conn, &t.id, &TaskOutcome::failed("x")).unwrap();
    assert_eq!(
        runs_store::refresh_run_status(&conn, &viejo.id).unwrap(),
        "failed"
    );
    assert_eq!(
        store::get(&conn, &id).unwrap().unwrap().status,
        status::RUNNING
    );
    assert_eq!(
        runs_store::runs_of_mission(&conn, &id).unwrap().len(),
        2,
        "una misión admite varios runs"
    );
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
    use crate::missions::{MISSION_CHANGED, mission_create, mission_update};
    use tauri::{Listener, Manager};

    /// Una app de prueba con la base, y lo que va llegando por `cc-mission-changed`.
    fn app_que_escucha(
        db: DbConnection,
    ) -> (
        tauri::App<tauri::test::MockRuntime>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let app = tauri::test::mock_app();
        app.manage(db);
        let vistos = Arc::new(Mutex::new(Vec::new()));
        let v = vistos.clone();
        app.listen_any(MISSION_CHANGED, move |e| {
            v.lock()
                .unwrap()
                .push(serde_json::from_str::<String>(e.payload()).unwrap());
        });
        (app, vistos)
    }

    #[test]
    fn crear_y_editar_avisan_con_el_id() {
        let (app, vistos) = app_que_escucha(db());
        let m = mission_create(app.handle().clone(), "w1".into(), pedido(), app.state()).unwrap();
        assert_eq!(*vistos.lock().unwrap(), vec![m.id.clone()]);

        mission_update(
            app.handle().clone(),
            m.id.clone(),
            MissionInput {
                title: "Otro".into(),
                ..pedido()
            },
            app.state(),
        )
        .unwrap();
        assert_eq!(*vistos.lock().unwrap(), vec![m.id.clone(), m.id]);
    }

    #[test]
    fn un_pedido_invalido_no_avisa() {
        let (app, vistos) = app_que_escucha(db());
        let vacio = MissionInput {
            objective: "  ".into(),
            ..pedido()
        };
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
            assert_eq!(
                runs_store::refresh_run(&conn, &lead.run_id).unwrap(),
                ("running".into(), None)
            );
            runs_store::mark_running(&conn, &lead.id, "s-1", "/tmp/e.jsonl").unwrap();
            runs_store::finish_task(
                &conn,
                &lead.id,
                &TaskOutcome {
                    ok: true,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                runs_store::refresh_run(&conn, &lead.run_id).unwrap(),
                ("failed".into(), Some(id.clone()))
            );
            assert_eq!(
                runs_store::refresh_run(&conn, &lead.run_id).unwrap(),
                ("failed".into(), None),
                "ya avisado"
            );
        }
        assert_eq!(estado(&db, &id), status::FAILED);
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
                    conn.execute(
                        "UPDATE tasks SET status = 'cancelled' WHERE id = ?1",
                        [&lead.id],
                    )
                    .unwrap();
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

#[test]
fn legacy_kimi_lead_is_readable_but_blocked_before_routing_or_launch() {
    let db = db();
    let id = borrador(&db);
    {
        let conn = db.lock().unwrap();
        assert!(store::validate(&conn, &MissionInput { lead_agent_id: Some("kimi-code".into()), ..pedido() }).unwrap_err().contains("orchestration"));
        conn.execute("UPDATE missions SET lead_agent_id = 'kimi-code' WHERE id = ?1", [&id]).unwrap();
        assert_eq!(store::get(&conn, &id).unwrap().unwrap().lead_agent_id.as_deref(), Some("kimi-code"));
    }
    let error = start(&db, &id, |_| panic!("must not route"), |_| panic!("must not launch")).unwrap_err();
    assert!(error.contains("orchestration"), "{error}");
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

#[test]
fn codex_lead_is_validated_and_dispatched_with_lead_permissions() {
    let db = db();
    let id = {
        let conn = db.lock().unwrap();
        create(&conn, "w1", &MissionInput {
            lead_agent_id: Some("codex".into()), ..pedido()
        }).unwrap().id
    };
    let launched = RefCell::new(None);
    start(&db, &id, |_| Ok(asignacion("codex")), |task| {
        *launched.borrow_mut() = Some(task.clone());
        Ok(())
    }).unwrap();
    let lead = launched.into_inner().unwrap();
    assert_eq!(lead.agent_id, "codex");
    assert_eq!(lead.role.as_deref(), Some(role::LEAD));
    assert_eq!(store::get(&db.lock().unwrap(), &id).unwrap().unwrap().status, status::RUNNING);
}

#[test]
fn legacy_squad_kimi_lead_start_is_blocked_without_execution() {
    let db = db();
    let id;
    {
        let conn = db.lock().unwrap();
        let squad_id = squad_para_mission(&conn);
        let mission = create(&conn, "w1", &MissionInput { squad_id: Some(squad_id.clone()), complexity: None, ..pedido() }).unwrap();
        id = mission.id;
        conn.execute("UPDATE squads SET lead_agent_id = 'kimi-code' WHERE id = ?1", [&squad_id]).unwrap();
    }
    let error = start(&db, &id, |_| panic!("must not route"), |_| panic!("must not launch")).unwrap_err();
    assert!(error.contains("unavailable"), "{error}");
    assert_eq!(count(&db.lock().unwrap(), "SELECT COUNT(*) FROM runs"), 0);
}

#[test]
fn lead_with_workers_follows_dag_outcome() {
    for fail in [false, true] {
        let db = db();
        let id = borrador(&db);
        let lead = arrancar(&db, &id);
        let workers: Vec<_> = {
            let conn = db.lock().unwrap();
            (0..2).map(|_| runs_store::create_task(&conn, &runs_store::NewTask {
                reasoning_effort: None,
                run_id: &lead.run_id, title: "worker", prompt: "work", agent_id: "codex",
                cwd: &proyecto(), role: Some(role::WORKER), queued: true, ..Default::default()
            }).unwrap()).collect()
        };
        assert_eq!(correr_y_cerrar(&db, &lead.id, TaskOutcome { ok: true, ..Default::default() }), "running");
        assert_eq!(estado(&db, &id), status::RUNNING);
        correr_y_cerrar(&db, &workers[0].id, TaskOutcome { ok: true, ..Default::default() });
        correr_y_cerrar(&db, &workers[1].id, TaskOutcome { ok: !fail, ..Default::default() });
        assert_eq!(estado(&db, &id), if fail { status::FAILED } else { status::DONE });
        assert_eq!(runs_store::task_by_id(&db.lock().unwrap(), &lead.id).unwrap().unwrap().status, task_status::DONE);
    }
}

// ── Revisión de lo entregado ─────────────────────────────────────

#[test]
fn numstat_lee_binarios_y_renombres() {
    use super::review::parse_numstat;
    let raw = "3\t1\tsrc/a.rs\0-\t-\tlogo.png\x002\t0\t\0viejo.rs\0nuevo.rs\0";
    let files = parse_numstat(raw);
    assert_eq!(files.len(), 3);
    assert_eq!((files[0].path.as_str(), files[0].added, files[0].removed), ("src/a.rs", Some(3), Some(1)));
    assert_eq!((files[1].added, files[1].removed), (None, None), "binario");
    assert_eq!(files[2].path, "nuevo.rs");
}

fn git_ok(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn commit_file(dir: &std::path::Path, file: &str, body: &str, msg: &str) {
    std::fs::write(dir.join(file), body).unwrap();
    git_ok(dir, &["add", "-A"]);
    git_ok(dir, &["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
}

/// Una misión en `running` con su run activo, sobre un repo de verdad con un commit.
fn mision_en_repo(tmp: &std::path::Path) -> (DbConnection, std::path::PathBuf, String) {
    let project = tmp.join("proyecto");
    std::fs::create_dir_all(&project).unwrap();
    git_ok(&project, &["init", "-q", "-b", "main"]);
    git_ok(&project, &["config", "core.autocrlf", "false"]);
    commit_file(&project, "a.txt", "uno\n", "base");
    let db = db();
    let run_id = {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, created_at, updated_at)
             VALUES ('m1', 'w1', 'Demo', 'o', ?1, 'running', 0, 0)",
            [project.to_string_lossy()],
        )
        .unwrap();
        let run = runs_store::create_run_with_memory_snapshot(&conn, "w1", Some("m1"), "o", &project.to_string_lossy(), 2, None).unwrap();
        conn.execute("UPDATE missions SET active_run_id = ?1 WHERE id = 'm1'", [&run.id]).unwrap();
        run.id
    };
    (db, project, run_id)
}

/// Una tarea terminada en su propio worktree, que commiteó `body` en `file`.
fn tarea_aislada(db: &DbConnection, run_id: &str, project: &std::path::Path, base: &std::path::Path, title: &str, file: &str, body: &str) -> String {
    let conn = db.lock().unwrap();
    let task = runs_store::create_task(
        &conn,
        &runs_store::NewTask { run_id, title, prompt: "p", agent_id: "claude-code", cwd: &project.to_string_lossy(), ..Default::default() },
    )
    .unwrap();
    let wt = crate::runs::worktrees::create_from(base, project, title, "HEAD").unwrap();
    commit_file(&wt.root, file, body, title);
    runs_store::set_worktree(&conn, &task.id, &wt.task_cwd.to_string_lossy(), &wt.root.to_string_lossy(), &wt.branch).unwrap();
    conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?1", [&task.id]).unwrap();
    task.id
}

/// Aceptar junta en la integración (no en el proyecto), un conflicto se aborta y se informa,
/// y aplicar lleva lo aceptado al proyecto solo con el árbol limpio.
#[test]
fn una_mision_se_revisa_se_integra_y_se_aplica() {
    use super::review::{self, MergeOutcome};
    let tmp = std::env::temp_dir().join(format!("cc-review-{}", uuid::Uuid::new_v4()));
    let base = tmp.join("worktrees");
    let (db, project, run_id) = mision_en_repo(&tmp);
    let nuevo = tarea_aislada(&db, &run_id, &project, &base, "agrega b", "b.txt", "nuevo\n");
    let cambia = tarea_aislada(&db, &run_id, &project, &base, "cambia a", "a.txt", "dos\n");
    let choca = tarea_aislada(&db, &run_id, &project, &base, "choca con a", "a.txt", "tres\n");

    // Lo que se ve antes de decidir.
    let r = review::review(&db.lock().unwrap(), "m1").unwrap();
    assert_eq!(r.deliveries.len(), 3);
    let b = r.deliveries.iter().find(|d| d.task_id == nuevo).unwrap();
    assert_eq!((b.files[0].path.as_str(), b.files[0].added), ("b.txt", Some(1)));
    assert_eq!(b.commits, vec!["agrega b".to_string()]);
    assert!(review::task_diff(&db.lock().unwrap(), &cambia).unwrap().contains("+dos"));

    // Aceptar dos que no chocan. El proyecto no se toca: todo va a la integración.
    assert!(matches!(review::accept(&db, &base, "m1", &nuevo).unwrap(), MergeOutcome::Merged { .. }));
    assert!(matches!(review::accept(&db, &base, "m1", &cambia).unwrap(), MergeOutcome::Merged { .. }));
    assert!(!project.join("b.txt").exists());

    // La tercera choca con la segunda: se aborta y se dice dónde.
    match review::accept(&db, &base, "m1", &choca).unwrap() {
        MergeOutcome::Conflict { files } => assert_eq!(files, vec!["a.txt".to_string()]),
        other => panic!("esperaba conflicto: {other:?}"),
    }
    let (branch, integration) = review::integration_path(&db.lock().unwrap(), "m1").unwrap().unwrap();
    let merge_head = std::process::Command::new("git")
        .arg("-C")
        .arg(&integration)
        .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .output()
        .unwrap();
    assert!(!merge_head.status.success(), "la integración quedó a mitad de un merge");

    let r = review::review(&db.lock().unwrap(), "m1").unwrap();
    let estado = |id: &str| r.deliveries.iter().find(|d| d.task_id == id).unwrap().review.clone();
    assert_eq!(estado(&nuevo).as_deref(), Some("accepted"));
    assert_eq!(estado(&cambia).as_deref(), Some("accepted"));
    assert_eq!(estado(&choca).as_deref(), Some("conflict"));
    assert_eq!(r.integration_branch.as_deref(), Some(branch.as_str()));
    assert_eq!(r.pending_commits, 4, "dos commits de tareas y dos merges");

    // Aplicar con cambios sin commitear en el proyecto: se niega y dice cuáles.
    std::fs::write(project.join("a.txt"), "a mano\n").unwrap();
    assert!(review::apply(&db, "m1").unwrap_err().contains("a.txt"));
    git_ok(&project, &["checkout", "--", "a.txt"]);
    // Un archivo nuevo sin agregar no impide aplicar.
    std::fs::write(project.join("notas.txt"), "mio\n").unwrap();

    assert!(matches!(review::apply(&db, "m1").unwrap(), MergeOutcome::Merged { .. }));
    assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap().replace("\r\n", "\n"), "dos\n");
    assert!(project.join("b.txt").exists());
    assert!(review::review(&db.lock().unwrap(), "m1").unwrap().applied_at.is_some());

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Lo que el agente dejó sin commitear no está en su rama: aceptarla sería aceptar otra cosa.
#[test]
fn no_se_acepta_una_entrega_con_cambios_sin_commitear() {
    let tmp = std::env::temp_dir().join(format!("cc-review-sucia-{}", uuid::Uuid::new_v4()));
    let base = tmp.join("worktrees");
    let (db, project, run_id) = mision_en_repo(&tmp);
    let task_id = tarea_aislada(&db, &run_id, &project, &base, "t", "c.txt", "c\n");
    let root: String = db
        .lock()
        .unwrap()
        .query_row("SELECT worktree_path FROM tasks WHERE id = ?1", [&task_id], |r| r.get(0))
        .unwrap();
    std::fs::write(std::path::Path::new(&root).join("olvidado.txt"), "x").unwrap();

    let err = super::review::accept(&db, &base, "m1", &task_id).unwrap_err();
    assert!(err.contains("olvidado.txt"), "{err}");
    let _ = std::fs::remove_dir_all(&tmp);
}

// ── En terminales: sin run ──────────────────────────────────────

#[test]
fn una_mision_en_terminales_corre_sin_run_y_se_cierra_a_mano() {
    let db = db();
    let id = borrador(&db);
    let conn = db.lock().unwrap();

    assert!(store::mark_started_terminals(&conn, &id).unwrap());
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!((m.status.as_str(), m.active_run_id.clone()), ("running", None));
    assert!(m.started_at.is_some() && m.ended_at.is_none());

    // Ya corre: arrancarla de nuevo no hace nada.
    assert!(!store::mark_started_terminals(&conn, &id).unwrap());
    // Que se refresque su estado (lo hace la flota con cada tarea) no la mueve: no tiene run.
    assert_eq!(store::refresh_status(&conn, &id).unwrap().as_deref(), Some("running"));

    assert!(store::close_terminals(&conn, &id, "done").unwrap());
    let m = store::get(&conn, &id).unwrap().unwrap();
    assert_eq!(m.status, "done");
    assert!(m.ended_at.is_some());
    // Ya cerrada: no se cierra dos veces ni se cambia el desenlace.
    assert!(!store::close_terminals(&conn, &id, "cancelled").unwrap());
    assert!(store::close_terminals(&conn, &id, "failed").is_err(), "solo terminada o cancelada");
}

#[test]
fn cancelar_una_mision_en_terminales_la_cierra_sin_tocar_ningun_run() {
    let db = db();
    let id = borrador(&db);
    {
        let conn = db.lock().unwrap();
        store::mark_started_terminals(&conn, &id).unwrap();
    }
    let cancelled = cancel(&db, &id, |_| panic!("no hay run que cancelar")).unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert!(cancel(&db, &id, |_| Ok(())).is_err(), "ya terminó");
}

#[test]
fn una_fallida_se_puede_reabrir_en_terminales_pero_una_terminada_no() {
    let db = db();
    let id = borrador(&db);
    let conn = db.lock().unwrap();
    conn.execute("UPDATE missions SET status = 'failed' WHERE id = ?1", [&id]).unwrap();
    assert!(store::mark_started_terminals(&conn, &id).unwrap());
    store::close_terminals(&conn, &id, "done").unwrap();
    assert!(!store::mark_started_terminals(&conn, &id).unwrap());
}

#[test]
fn explicit_test_marker_persists_in_get_list_and_start_payload_without_guessing() {
    let db = db();
    let conn = db.lock().unwrap();
    let real = create(&conn, "w1", &MissionInput { title: "E2E test development".into(), ..pedido() }).unwrap();
    assert!(!real.is_test);
    let marked = create(&conn, "w1", &MissionInput { is_test: Some(true), ..pedido() }).unwrap();
    assert!(store::get(&conn, &marked.id).unwrap().unwrap().is_test);
    let list = store::list(&conn, "w1").unwrap();
    assert!(list.iter().find(|m| m.mission.id == marked.id).unwrap().mission.is_test);
    assert!(!list.iter().find(|m| m.mission.id == real.id).unwrap().mission.is_test);
    let encoded = serde_json::to_value(&list).unwrap();
    assert!(encoded.as_array().unwrap().iter().any(|m| m["id"] == marked.id && m["isTest"] == true));
    assert!(update(&conn, &marked.id, &pedido()).unwrap().is_test);
    store::mark_test_before_start(&conn, &real.id, true).unwrap();
    assert!(store::get(&conn, &real.id).unwrap().unwrap().is_test);
    conn.execute("UPDATE missions SET status='done' WHERE id=?1", [&real.id]).unwrap();
    assert!(store::mark_test_before_start(&conn, &real.id, false).is_err());
    assert!(store::get(&conn, &real.id).unwrap().unwrap().is_test);
    assert!(!update(&conn, &marked.id, &MissionInput { is_test: Some(false), ..pedido() }).unwrap().is_test);
}
