//! Las filas de `runs` y `tasks`: leerlas, crearlas y cerrarlas.
//!
//! A diferencia de las tabs —cuya fuente de verdad mientras la app corre es el store del
//! frontend— acá la base **es** la fuente de verdad: el proceso lo lanza y lo espera Rust,
//! así que no hay un store de Zustand que sepa nada que la base no sepa.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use uuid::Uuid;

use crate::database::DbConnection;
use crate::squads::Squad;
use crate::util::now_ts;

use super::types::{Fact, Run, Task, TaskOutcome, status};

const RUN_COLUMNS: &str = "id, workspace_id, objective, cwd, status, max_parallel, budget_usd, \
                           spent_usd, created_at, ended_at, mission_id, source_thread_id, squad_id, squad_name";

const TASK_COLUMNS: &str = "id, run_id, title, prompt, agent_id, account_id, model, cwd, \
                            budget_usd, status, session_id, attempt, result, error, cost_usd, \
                            tokens_in, tokens_out, events_path, started_at, ended_at, created_at, \
                            worktree_path, branch, worktree_removed, complexity, routed_by, \
                            route_note, role, plan_key, parent_id, depth, isolate, result_schema, \
                            last_error, handoff, functional_role, reasoning_effort, structured_handoff, \
                            auto_account, work_key, fix_round, full_gate, fix_status";

fn row_to_run(row: &Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        objective: row.get(2)?,
        cwd: row.get(3)?,
        status: row.get(4)?,
        max_parallel: row.get(5)?,
        budget_usd: row.get(6)?,
        spent_usd: row.get(7)?,
        created_at: row.get(8)?,
        ended_at: row.get(9)?,
        mission_id: row.get(10)?,
        source_thread_id: row.get(11)?,
        squad_id: row.get(12)?,
        squad_name: row.get(13)?,
        squad_members: Vec::new(),
    })
}

fn row_to_task(row: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        run_id: row.get(1)?,
        title: row.get(2)?,
        prompt: row.get(3)?,
        agent_id: row.get(4)?,
        account_id: row.get(5)?,
        model: row.get(6)?,
        cwd: row.get(7)?,
        budget_usd: row.get(8)?,
        status: row.get(9)?,
        session_id: row.get(10)?,
        attempt: row.get(11)?,
        result: row.get(12)?,
        error: row.get(13)?,
        cost_usd: row.get(14)?,
        tokens_in: row.get(15)?,
        tokens_out: row.get(16)?,
        events_path: row.get(17)?,
        started_at: row.get(18)?,
        ended_at: row.get(19)?,
        created_at: row.get(20)?,
        worktree_path: row.get(21)?,
        branch: row.get(22)?,
        worktree_removed: row.get::<_, i64>(23)? != 0,
        complexity: row.get(24)?,
        routed_by: row.get(25)?,
        route_note: row.get(26)?,
        role: row.get(27)?,
        plan_key: row.get(28)?,
        parent_id: row.get(29)?,
        depth: row.get(30)?,
        isolate: row.get::<_, i64>(31)? != 0,
        result_schema: row.get(32)?,
        last_error: row.get(33)?,
        handoff: row.get(34)?,
        functional_role: row.get(35)?,
        reasoning_effort: row.get(36)?,
        structured_handoff: row
            .get::<_, Option<String>>(37)?
            .map(|raw| {
                let value = serde_json::from_str(&raw).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        37,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                super::handoff::parse(&value).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        37,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::other(e)),
                    )
                })
            })
            .transpose()?,
        auto_account: row.get::<_, i64>(38)? != 0,
        work_key: row.get(39)?,
        fix_round: row.get(40)?,
        full_gate: row.get::<_, i64>(41)? != 0,
        fix_status: row.get(42)?,
        // Lo llena `with_deps`: vive en otra tabla.
        depends_on: Vec::new(),
    })
}

/// Completa `depends_on` de cada tarea con una sola consulta por lote.
fn with_deps(conn: &Connection, mut tasks: Vec<Task>) -> Result<Vec<Task>, String> {
    if tasks.is_empty() {
        return Ok(tasks);
    }
    let placeholders = vec!["?"; tasks.len()].join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT task_id, depends_on FROM task_deps WHERE task_id IN ({placeholders}) ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let pairs: Vec<(String, String)> = stmt
        .query_map(rusqlite::params_from_iter(ids), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for task in &mut tasks {
        task.depends_on = pairs
            .iter()
            .filter(|(t, _)| *t == task.id)
            .map(|(_, d)| d.clone())
            .collect();
    }
    Ok(tasks)
}

// ── Crear ───────────────────────────────────────────────────────

pub fn create_run(
    conn: &Connection,
    workspace_id: &str,
    objective: &str,
    cwd: &str,
) -> Result<Run, String> {
    create_run_with(conn, workspace_id, objective, cwd, 2, None)
}

/// Un run con su paralelismo y su presupuesto: lo que declara un plan.
pub fn create_run_with(
    conn: &Connection,
    workspace_id: &str,
    objective: &str,
    cwd: &str,
    max_parallel: i64,
    budget_usd: Option<f64>,
) -> Result<Run, String> {
    create_run_with_memory_snapshot(conn, workspace_id, None, objective, cwd, max_parallel, budget_usd)
}

/// Atomic Run creation, including an empty or selected durable-memory snapshot.
/// A savepoint composes with the caller's transaction for Lead/Task creation.
pub fn create_run_with_memory_snapshot(
    conn: &Connection, workspace_id: &str, mission_id: Option<&str>, objective: &str,
    cwd: &str, max_parallel: i64, budget_usd: Option<f64>,
) -> Result<Run, String> {
    // A standalone SAVEPOINT starts a deferred transaction. Reserve the writer
    // before reading memory; caller-owned transactions retain their own lifetime.
    let transaction = if conn.is_autocommit() {
        Some(rusqlite::Transaction::new_unchecked(conn,rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?)
    } else { None };
    conn.execute_batch("SAVEPOINT create_run_memory").map_err(|e| e.to_string())?;
    let result = (|| {
        let id = Uuid::new_v4().to_string();
        conn.execute("INSERT INTO runs(id,workspace_id,mission_id,objective,cwd,status,max_parallel,budget_usd,created_at)
            VALUES(?1,?2,?3,?4,?5,'running',?6,?7,?8)",
            rusqlite::params![id,workspace_id,mission_id,objective,cwd,max_parallel,budget_usd,now_ts()]).map_err(|e| e.to_string())?;
        crate::memory::snapshot_run(conn, &id, workspace_id, mission_id)?;
        run_by_id(conn, &id)?.ok_or_else(|| "Run was not saved".to_string())
    })();
    match result {
        Ok(run) => {conn.execute_batch("RELEASE create_run_memory").map_err(|e| e.to_string())?; if let Some(transaction)=transaction {transaction.commit().map_err(|e|e.to_string())?;} Ok(run)}
        Err(error) => {conn.execute_batch("ROLLBACK TO create_run_memory; RELEASE create_run_memory").map_err(|e| e.to_string())?; Err(error)}
    }
}

/// Ata un run recién creado a la misión que intenta cumplir.
#[cfg(test)]
pub fn set_run_mission(conn: &Connection, run_id: &str, mission_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET mission_id = ?1 WHERE id = ?2",
        [mission_id, run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stores the Squad configuration selected at Mission start. Later planning resolves from
/// these copied rows even if the reusable Squad is edited.
pub fn set_run_squad_snapshot(
    conn: &Connection,
    run_id: &str,
    squad: &Squad,
) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET squad_id = ?1, squad_name = ?2, fast_mode = ?4 WHERE id = ?3",
        rusqlite::params![squad.id, squad.name, run_id, squad.lead.fast_mode as i64],
    )
    .map_err(|error| error.to_string())?;
    for member in &squad.members {
        conn.execute(
            "INSERT INTO run_squad_members (run_id, role_id, agent_id, model, account_id,
                                            auto_account, complexity, isolate_default, reasoning_effort, fast_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                run_id,
                member.role_id,
                member.agent_id,
                member.model,
                member.account_id,
                member.auto_account as i64,
                member.complexity,
                member.isolate_default as i64,
                member.reasoning_effort,
                member.fast_mode as i64,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn with_squad_members(conn: &Connection, mut run: Run) -> Result<Run, String> {
    if run.squad_id.is_some() {
        run.squad_members = crate::squads::store::snapshot_members_of_run(conn, &run.id)?;
    }
    Ok(run)
}

fn with_squad_members_many(conn: &Connection, runs: Vec<Run>) -> Result<Vec<Run>, String> {
    runs.into_iter()
        .map(|run| with_squad_members(conn, run))
        .collect()
}

/// Los intentos de una misión, el más reciente primero.
pub fn runs_of_mission(conn: &Connection, mission_id: &str) -> Result<Vec<Run>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE mission_id = ?1 ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([mission_id], row_to_run)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    with_squad_members_many(conn, rows)
}

/// Runs originados numa conversa estruturada, mais recentes primeiro.
pub fn runs_of_thread(conn: &Connection, thread_id: &str) -> Result<Vec<Run>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE source_thread_id = ?1 ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([thread_id], row_to_run)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    with_squad_members_many(conn, rows)
}

/// Registra a origem uma única vez; repetir a mesma ligação é seguro, trocar a conversa não.
pub fn set_run_source_thread(
    conn: &Connection,
    run_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    let updated = conn
        .execute(
            "UPDATE runs SET source_thread_id = ?1
             WHERE id = ?2 AND (source_thread_id IS NULL OR source_thread_id = ?1)",
            rusqlite::params![thread_id, run_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 1 {
        return Ok(());
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT source_thread_id FROM runs WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    match existing {
        None => Err(format!("o run {run_id} não existe")),
        Some(_) => Err(format!("o run {run_id} já pertence a outra conversa")),
    }
}

/// Recibo idempotente de uma delegação feita pelo MCP.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationReceipt {
    pub request_hash: String,
    pub run_id: String,
    pub task_keys: Vec<String>,
}

pub fn delegation_receipt(
    conn: &Connection,
    caller_key: &str,
    request_id: &str,
) -> Result<Option<DelegationReceipt>, String> {
    let raw: Option<(String, String, String)> = conn
        .query_row(
            "SELECT request_hash, run_id, task_keys_json
             FROM run_delegation_receipts WHERE caller_key = ?1 AND request_id = ?2",
            rusqlite::params![caller_key, request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(|(request_hash, run_id, task_keys)| {
        let task_keys = serde_json::from_str(&task_keys)
            .map_err(|error| format!("recibo de delegação inválido: {error}"))?;
        Ok(DelegationReceipt { request_hash, run_id, task_keys })
    })
    .transpose()
}

pub fn save_delegation_receipt(
    conn: &Connection,
    caller_key: &str,
    request_id: &str,
    request_hash: &str,
    run_id: &str,
    task_keys: &[String],
) -> Result<(), String> {
    let task_keys = serde_json::to_string(task_keys).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO run_delegation_receipts
         (caller_key, request_id, request_hash, run_id, task_keys_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![caller_key, request_id, request_hash, run_id, task_keys, crate::util::now_ts_ms()],
    )
    .map_err(|error| format!("não consegui registrar a idempotência da delegação: {error}"))?;
    // Escrita dupla (harness, contrato §11.6): o recibo antigo continua sendo a fonte.
    crate::harness::receipts::mirror_delegation(
        conn,
        caller_key,
        request_id,
        request_hash,
        run_id,
        &task_keys,
        crate::util::now_ts_ms(),
    )?;
    Ok(())
}

#[derive(Default)]
pub struct NewTask<'a> {
    pub run_id: &'a str,
    pub title: &'a str,
    pub prompt: &'a str,
    pub agent_id: &'a str,
    pub account_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub reasoning_effort: Option<&'a str>,
    pub cwd: &'a str,
    pub budget_usd: Option<f64>,
    pub complexity: Option<&'a str>,
    pub routed_by: Option<&'a str>,
    pub route_note: Option<&'a str>,
    /// `None` = lanzada a mano.
    pub role: Option<&'a str>,
    pub functional_role: Option<&'a str>,
    pub plan_key: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub depth: i64,
    pub isolate: bool,
    pub result_schema: Option<&'a str>,
    /// Arranca esperando (`pending`) en vez de lista para lanzar. Es lo que crea un plan: la
    /// tarea existe, pero la lanza el scheduler cuando le toca.
    pub queued: bool,
    /// La cuenta la eligió el ruteo: se puede cambiar por otra con cupo (ver `Task::auto_account`).
    pub auto_account: bool,
    /// Plan key, id ou work_key da entrega que esta task corrige. Vazio = trabalho novo.
    pub corrects: Option<&'a str>,
}

pub fn create_task(conn: &Connection, new: &NewTask) -> Result<Task, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tasks (id, run_id, title, prompt, agent_id, account_id, model, cwd,
                            budget_usd, status, created_at, complexity, routed_by, route_note,
                            role, plan_key, parent_id, depth, isolate, result_schema, functional_role, reasoning_effort,
                            auto_account)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
        rusqlite::params![
            id,
            new.run_id,
            new.title,
            new.prompt,
            new.agent_id,
            new.account_id,
            new.model,
            new.cwd,
            new.budget_usd,
            if new.queued { status::PENDING } else { status::READY },
            now_ts(),
            new.complexity,
            new.routed_by,
            new.route_note,
            new.role,
            new.plan_key,
            new.parent_id,
            new.depth,
            new.isolate as i64,
            new.result_schema,
            new.functional_role,
            new.reasoning_effort,
            new.auto_account as i64,
        ],
    )
    .map_err(|e| e.to_string())?;
    super::fixrounds::bind_new_task(conn, &id, new.run_id, new.title, new.prompt, new.corrects)?;
    task_by_id(conn, &id)?.ok_or_else(|| "a tarefa não foi salva".to_string())
}

// ── Leer ────────────────────────────────────────────────────────

pub fn run_by_id(conn: &Connection, id: &str) -> Result<Option<Run>, String> {
    let run = conn
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"),
            [id],
            row_to_run,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    run.map(|run| with_squad_members(conn, run)).transpose()
}

pub fn task_by_id(conn: &Connection, id: &str) -> Result<Option<Task>, String> {
    let task = conn
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"),
            [id],
            row_to_task,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match task {
        Some(t) => with_deps(conn, vec![t])?.pop(),
        None => None,
    })
}

/// Las tareas de un run, en el orden en que se crearon: el orden del plan.
pub fn tasks_of_run(conn: &Connection, run_id: &str) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE run_id = ?1 ORDER BY created_at, rowid"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], row_to_task)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    with_deps(conn, rows)
}

/// Una tarea del run por su nombre en el plan o por su id.
pub fn task_in_run(
    conn: &Connection,
    run_id: &str,
    key_or_id: &str,
) -> Result<Option<Task>, String> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM tasks WHERE run_id = ?1 AND (id = ?2 OR plan_key = ?2) ORDER BY created_at LIMIT 1",
            [run_id, key_or_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match id {
        Some(id) => task_by_id(conn, &id),
        None => Ok(None),
    }
}

pub fn run_of_task(conn: &Connection, task_id: &str) -> Result<Option<Run>, String> {
    let run_id: Option<String> = conn
        .query_row("SELECT run_id FROM tasks WHERE id = ?1", [task_id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match run_id {
        Some(id) => run_by_id(conn, &id),
        None => Ok(None),
    }
}

pub fn list_runs(conn: &Connection, workspace_id: &str) -> Result<Vec<Run>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], row_to_run)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    with_squad_members_many(conn, rows)
}

/// Las tarjetas de un workspace, más recientes primero.
///
/// Se ordenan por creación y no por estado: el orden que importa —primero el que está
/// trabado— es cosa de la consola, que lo recalcula en vivo. Meterlo en el `ORDER BY`
/// obligaría a releer la base con cada cambio de estado.
pub fn list_tasks(conn: &Connection, workspace_id: &str) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM tasks t JOIN runs r ON r.id = t.run_id
             WHERE r.workspace_id = ?1 ORDER BY t.created_at DESC",
            TASK_COLUMNS
                .split(", ")
                .map(|c| format!("t.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], row_to_task)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    with_deps(conn, rows)
}

/// El workspace de una carpeta: el de la ventana abierta más reciente que tiene una tab ahí.
/// Es cómo un agente de una tab, que solo conoce su carpeta, crea un run donde se vea.
pub fn workspace_of_folder(conn: &Connection, cwd: &str) -> Option<String> {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();
    let wanted = norm(cwd);
    let mut stmt = conn
        .prepare(
            "SELECT w.workspace_id, t.cwd FROM tabs t JOIN windows w ON w.id = t.window_id
             ORDER BY w.is_open DESC, w.last_active DESC",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()?;
    // En una variable a propósito: devolverlo directo haría vivir el iterador (que toma
    // prestado `stmt`) más que `stmt` mismo.
    #[allow(clippy::let_and_return)]
    let found = rows
        .filter_map(Result::ok)
        .find(|(_, c)| norm(c) == wanted)
        .map(|(w, _)| w);
    found
}

/// El run más reciente creado desde esa carpeta en ese workspace.
pub fn latest_run_in_folder(
    conn: &Connection,
    workspace_id: &str,
    cwd: &str,
) -> Result<Option<Run>, String> {
    let run = conn
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS} FROM runs WHERE workspace_id = ?1 AND cwd = ?2
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
            ),
            [workspace_id, cwd],
            row_to_run,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    run.map(|run| with_squad_members(conn, run)).transpose()
}

// ── El plan ─────────────────────────────────────────────────────

pub fn add_dep(conn: &Connection, task_id: &str, depends_on: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?1, ?2)",
        [task_id, depends_on],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cambia el paralelismo o el presupuesto de un run, si vienen.
pub fn update_run_limits(
    conn: &Connection,
    run_id: &str,
    max_parallel: Option<i64>,
    budget_usd: Option<f64>,
) -> Result<(), String> {
    if let Some(n) = max_parallel {
        conn.execute(
            "UPDATE runs SET max_parallel = ?1 WHERE id = ?2",
            rusqlite::params![n, run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(b) = budget_usd {
        conn.execute(
            "UPDATE runs SET budget_usd = ?1 WHERE id = ?2",
            rusqlite::params![b, run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancela una tarea que todavía esperaba turno.
pub fn cancel_one_pending(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, ended_at = ?2 WHERE id = ?3 AND status = ?4",
            rusqlite::params![status::CANCELLED, now_ts(), task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn set_run_objective(conn: &Connection, run_id: &str, objective: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET objective = ?1 WHERE id = ?2",
        [objective, run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Le toca correr: de `pending` a `ready`. `false` si otro ya la despachó o se canceló.
pub fn mark_dispatched(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1 WHERE id = ?2 AND status = ?3",
            rusqlite::params![status::READY, task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Una tarea ya despachada que no se va a lanzar: falla con el motivo, sin haber corrido. Queda
/// como cualquier falla, así que se puede pasar a otra cuenta o agente (`reroute_task`).
pub fn fail_dispatched(conn: &Connection, task_id: &str, reason: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE id = ?4 AND status = ?5",
            rusqlite::params![status::FAILED, reason, now_ts(), task_id, status::READY],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// La devuelve a la cola sin que haya corrido: su cuenta no tiene lugar ahora (ver `ledger`).
pub fn undispatch(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1 WHERE id = ?2 AND status = ?3",
            rusqlite::params![status::PENDING, task_id, status::READY],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Le antepone al error de una tarea terminada de qué tipo fue, para que quien la mira (la
/// consola, el lead) sepa qué hacer sin leer el log de la CLI.
pub fn tag_error(conn: &Connection, task_id: &str, tag: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET error = ?1 || ' ' || COALESCE(error, '') WHERE id = ?2 AND COALESCE(error, '') NOT LIKE ?1 || '%'",
        rusqlite::params![tag, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// No va a correr, y por qué. Solo sobre tareas que esperaban.
pub fn skip_task(conn: &Connection, task_id: &str, reason: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE id = ?4 AND status = ?5",
            rusqlite::params![status::SKIPPED, reason, now_ts(), task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Vuelve a la cola para un segundo intento, con el motivo del primero.
///
/// A tentativa anterior fica intacta: isto passa por [`resume_task`], que abre outra linha.
#[cfg(test)]
pub fn requeue_for_retry(conn: &Connection, task_id: &str, error: &str) -> Result<bool, String> {
    let Some(task) = task_by_id(conn, task_id)? else {
        return Ok(false);
    };
    if task.status != status::FAILED {
        return Ok(false);
    }
    resume_task(conn, task_id, false)?;
    conn.execute(
        "UPDATE tasks SET last_error = ?1 WHERE id = ?2",
        rusqlite::params![error, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Tentativa aberta pela retomada. A correlação com a anterior é `(task_id, attempt)`:
/// o mesmo `task_id` e `attempt` igual ao maior já gravado mais um. Não há coluna nova.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumedAttempt {
    pub id: String,
    pub task_id: String,
    pub attempt: i64,
    /// Id da linha anterior, quando havia uma.
    pub previous_id: Option<String>,
}

struct AttemptHead {
    id: String,
    attempt: i64,
    status: String,
    ended_at: Option<i64>,
}

fn latest_attempt(conn: &Connection, task_id: &str) -> Result<Option<AttemptHead>, String> {
    conn.query_row(
        "SELECT id, attempt, status, ended_at FROM run_attempts
         WHERE task_id = ?1 ORDER BY attempt DESC LIMIT 1",
        [task_id],
        |row| {
            Ok(AttemptHead {
                id: row.get(0)?,
                attempt: row.get(1)?,
                status: row.get(2)?,
                ended_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn open_attempt_is_running(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let running: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM run_attempts
             WHERE task_id = ?1 AND ended_at IS NULL AND status = ?2",
            rusqlite::params![task_id, status::RUNNING],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(running > 0)
}

/// Abre a próxima tentativa, ou reaproveita a reserva que ainda não foi lançada.
///
/// Não atualiza linha com `ended_at` preenchido e não abre o arquivo de eventos.
pub(crate) fn reserve_next_attempt(conn: &Connection, task_id: &str) -> Result<ResumedAttempt, String> {
    let task = task_by_id(conn, task_id)?.ok_or_else(|| "a tarefa não existe".to_string())?;
    if open_attempt_is_running(conn, task_id)? {
        return Err("a tarefa ainda está em execução e não ganha outra tentativa".into());
    }
    let previous = latest_attempt(conn, task_id)?;
    if let Some(open) = previous.as_ref().filter(|row| row.ended_at.is_none()) {
        conn.execute(
            "UPDATE run_attempts SET agent_id = ?1, model = ?2
             WHERE id = ?3 AND ended_at IS NULL AND status != ?4",
            rusqlite::params![task.agent_id, task.model, open.id, status::RUNNING],
        )
        .map_err(|error| error.to_string())?;
        return Ok(ResumedAttempt {
            id: open.id.clone(),
            task_id: task_id.to_string(),
            attempt: open.attempt,
            previous_id: None,
        });
    }
    let attempt = previous.as_ref().map(|row| row.attempt).unwrap_or(0) + 1;
    let id = Uuid::new_v4().to_string();
    // Placeholder até o processo nascer. Não é o `events_path` da tentativa anterior
    // e este caminho não é criado aqui: nada é truncado.
    let events_path = format!("attempt://{task_id}/{id}.jsonl");
    conn.execute(
        "INSERT INTO run_attempts (id, task_id, run_id, attempt, agent_id, model, session_id,
                                   events_path, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9)",
        rusqlite::params![
            id,
            task_id,
            task.run_id,
            attempt,
            task.agent_id,
            task.model,
            events_path,
            status::PENDING,
            now_ts(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(ResumedAttempt {
        id,
        task_id: task_id.to_string(),
        attempt,
        previous_id: previous.map(|row| row.id),
    })
}

/// Retoma uma tarefa da Frota com uma tentativa nova, correlacionada à anterior.
///
/// `failed` e `interrupted` (e a falha de desfecho desconhecido, que continua `failed`)
/// entram sem flag. `done` só entra com `explicit`. `ready` e `running`, ou qualquer
/// tentativa ainda aberta, não ganham outra linha. A linha anterior não é atualizada:
/// status, resultado, erro e `events_path` ficam onde foram gravados. A linha da tarefa
/// volta para `pending` porque é o estado corrente que o scheduler lê; o histórico é
/// `run_attempts`.
pub fn resume_task(conn: &Connection, task_id: &str, explicit: bool) -> Result<ResumedAttempt, String> {
    let task = task_by_id(conn, task_id)?.ok_or_else(|| "a tarefa não existe".to_string())?;
    if matches!(task.status.as_str(), status::READY | status::RUNNING) || open_attempt_is_running(conn, task_id)? {
        return Err("a tarefa ainda está em execução e não ganha outra tentativa".into());
    }
    if latest_attempt(conn, task_id)?.is_some_and(|row| row.ended_at.is_none()) {
        return Err("já existe uma tentativa em aberto para esta tarefa".into());
    }
    let resumable = match task.status.as_str() {
        status::FAILED | "interrupted" => true,
        status::DONE if explicit => true,
        status::DONE => {
            return Err("uma tarefa concluída não é retomada sem pedido explícito".into());
        }
        _ => false,
    };
    if !resumable {
        return Err("esta tarefa não está num estado que possa ser retomado".into());
    }
    let changed = conn
        .execute(
            "UPDATE tasks SET status = ?1, last_error = COALESCE(error, last_error), error = NULL,
                              result = NULL, structured_handoff = NULL, ended_at = NULL, session_id = NULL
             WHERE id = ?2 AND status = ?3",
            rusqlite::params![status::PENDING, task_id, task.status],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("a tarefa mudou antes da retomada".into());
    }
    reserve_next_attempt(conn, task_id)
}

/// Le pasa la tarea a otro agente: nueva asignación, el traspaso escrito, y de vuelta a la
/// cola con los intentos en cero.
///
/// `attempt` volta a zero para o processo novo poder arrancar. O orçamento de correção
/// (`fix_round` / `fix_rounds`) não é tocado: reroute e troca de worker continuam no mesmo teto.
#[allow(clippy::too_many_arguments)]
pub fn reroute_task(
    conn: &Connection,
    task_id: &str,
    agent_id: &str,
    model: Option<&str>,
    account_id: Option<&str>,
    routed_by: &str,
    route_note: Option<&str>,
    handoff: &str,
    auto_account: bool,
) -> Result<bool, String> {
    if open_attempt_is_running(conn, task_id)? {
        return Ok(false);
    }
    let n = conn
        .execute(
            "UPDATE tasks SET agent_id = ?1, model = ?2, account_id = ?3, routed_by = ?4, route_note = ?5,
                              handoff = ?6, structured_handoff = NULL, status = ?7, attempt = 0, session_id = NULL,
                              result = NULL, error = NULL, last_error = NULL,
                              started_at = NULL, ended_at = NULL, auto_account = ?11
             WHERE id = ?8 AND status NOT IN (?9, ?10)",
            rusqlite::params![
                agent_id, model, account_id, routed_by, route_note, handoff, status::PENDING, task_id,
                status::RUNNING, status::READY, auto_account as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 1 {
        // A linha anterior de `run_attempts` não entra neste UPDATE. A próxima é outra
        // linha, com `attempt` monotônico, mesmo que o contador da tarefa volte a zero.
        reserve_next_attempt(conn, task_id)?;
    }
    Ok(n > 0)
}

/// Cancela lo que esperaba en un run. Devuelve cuántas.
pub fn cancel_pending(conn: &Connection, run_id: &str, reason: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE run_id = ?4 AND status = ?5",
        rusqlite::params![status::CANCELLED, reason, now_ts(), run_id, status::PENDING],
    )
    .map_err(|e| e.to_string())
}

/// Recalcula el estado del run a partir de sus tareas y lo guarda. Devuelve el nuevo.
///
/// `running` mientras quede algo que pueda cambiar solo; al cerrarse todo, `done` si todas
/// terminaron bien, `cancelled` si alguna se canceló y ninguna falló, y `failed` si no.
///
/// Si el run es de una misión, la misión lo sigue desde acá y solo desde acá: su estado es
/// el del run que la está cumpliendo, no uno propio que pueda divergir.
pub fn refresh_run_status(conn: &Connection, run_id: &str) -> Result<String, String> {
    refresh_run(conn, run_id).map(|(status, _)| status)
}

/// `refresh_run_status`, y además la misión si su estado cambió por esto.
pub fn refresh_run(conn: &Connection, run_id: &str) -> Result<(String, Option<String>), String> {
    let statuses: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT status FROM tasks WHERE run_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([run_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let next = if statuses.iter().any(|s| !status::is_final(s)) {
        "running"
    } else if statuses.iter().all(|s| s == status::DONE) {
        "done"
    } else if statuses
        .iter()
        .any(|s| s == status::FAILED || s == status::SKIPPED)
    {
        "failed"
    } else {
        "cancelled"
    };
    conn.execute(
        "UPDATE runs SET status = ?1,
                         ended_at = CASE WHEN ?1 = 'running' THEN NULL ELSE COALESCE(ended_at, ?2) END
         WHERE id = ?3",
        rusqlite::params![next, now_ts(), run_id],
    )
    .map_err(|e| e.to_string())?;
    let mission = crate::missions::store::refresh_for_run(conn, run_id)?;
    Ok((next.to_string(), mission))
}

// ── Lo que se dejan escrito ─────────────────────────────────────

pub fn add_fact(
    conn: &Connection,
    run_id: &str,
    task_id: Option<&str>,
    kind: &str,
    body: &str,
) -> Result<Fact, String> {
    if crate::memory::agent::looks_like_secret(body) {
        return Err("run facts cannot contain credentials".into());
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO run_facts (id, run_id, task_id, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, run_id, task_id, kind, body, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    facts_of_run(conn, run_id)?
        .into_iter()
        .find(|f| f.id == id)
        .ok_or_else(|| "o fato não foi salvo".to_string())
}

pub fn facts_of_run(conn: &Connection, run_id: &str) -> Result<Vec<Fact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.run_id, f.task_id, t.title, f.kind, f.body, f.created_at
             FROM run_facts f LEFT JOIN tasks t ON t.id = f.task_id
             WHERE f.run_id = ?1 ORDER BY f.created_at, f.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok(Fact {
                id: r.get(0)?,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                author: r.get(3)?,
                kind: r.get(4)?,
                body: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactPageItem {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub author: Option<String>,
    pub kind: String,
    pub body: String,
    pub body_bytes: usize,
    pub body_truncated: bool,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactPage {
    pub items: Vec<FactPageItem>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}

/// The MCP reader is paginated newest-first to retain its historical default view. The
/// complete body is fetched separately in bounded UTF-8 byte chunks.
pub fn facts_page(
    conn: &Connection,
    run_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<FactPage, String> {
    const RESPONSE_BYTES: usize = crate::memory::LIST_BYTES;
    const BODY_PREVIEW_CHARS: usize = 300;
    let boundary: Option<(i64,i64)> = match cursor {
        None => None,
        Some(id) => Some(conn.query_row("SELECT created_at,rowid FROM run_facts WHERE id=?1 AND run_id=?2",rusqlite::params![id,run_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?.ok_or("invalid facts cursor for this Run")?),
    };
    let limit = limit.clamp(1, crate::memory::LIST_LIMIT);
    let mut stmt = conn
        .prepare(
            "SELECT f.id,f.run_id,f.task_id,t.title,f.kind,f.body,f.created_at
         FROM run_facts f LEFT JOIN tasks t ON t.id=f.task_id
         WHERE f.run_id=?1 AND (?3 IS NULL OR f.created_at<?3 OR (f.created_at=?3 AND f.rowid<?4)) ORDER BY f.created_at DESC,f.rowid DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut candidates = stmt
        .query_map(rusqlite::params![run_id, limit + 1, boundary.map(|x|x.0),boundary.map(|x|x.1)], |r| {
            let body: String = r.get(5)?;
            let preview: String = body.chars().take(BODY_PREVIEW_CHARS).collect();
            let body_truncated = preview.chars().count() < body.chars().count();
            Ok(FactPageItem {
                id: r.get(0)?,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                author: r.get(3)?,
                kind: r.get(4)?,
                body: preview,
                body_bytes: body.len(),
                body_truncated,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let source_has_more = candidates.len() > limit;
    if source_has_more {
        candidates.pop();
    }
    let mut items: Vec<FactPageItem> = Vec::new();
    let mut item_values = Vec::new();
    let mut byte_truncated = false;
    for item in candidates {
        let mut trial = item_values.clone();
        trial.push(serde_json::to_value(&item).map_err(|e| e.to_string())?);

        let page = serde_json::json!({"items":trial.clone(),"hasMore":true,"nextCursor":item.id,"truncated":false});
        if serde_json::to_vec(&page).map_err(|e| e.to_string())?.len() > RESPONSE_BYTES {
            byte_truncated = true;
            break;
        }
        item_values = trial;
        items.push(item);
    }
    let has_more = source_has_more || byte_truncated;
    let next_cursor = if has_more {items.last().map(|item|item.id.clone())} else {None};
    let truncated = byte_truncated || items.iter().any(|item| item.body_truncated);
    Ok(FactPage {
        items,
        has_more,
        next_cursor,
        truncated,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactBodyChunk {
    pub fact_id: String,
    pub body: String,
    pub offset_bytes: usize,
    pub next_offset: usize,
    pub total_bytes: usize,
    pub has_more: bool,
}

pub fn fact_body_chunk(
    conn: &Connection,
    run_id: &str,
    fact_id: &str,
    offset: usize,
    limit: usize,
) -> Result<FactBodyChunk, String> {
    let body: String = conn
        .query_row(
            "SELECT body FROM run_facts WHERE id=?1 AND run_id=?2",
            rusqlite::params![fact_id, run_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Run Fact is unavailable in this Run")?;
    if offset > body.len() || !body.is_char_boundary(offset) {
        return Err("fact body offset must be a UTF-8 character boundary".into());
    }
    let max = limit.clamp(1, crate::memory::BODY_MAX_BYTES);
    let mut end = offset.saturating_add(max).min(body.len());
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset && offset < body.len() {
        return Err("fact body limit is too small for the next UTF-8 character".into());
    }
    let next = end;
    Ok(FactBodyChunk {
        fact_id: fact_id.to_string(),
        body: body[offset..end].to_string(),
        offset_bytes: offset,
        next_offset: next,
        total_bytes: body.len(),
        has_more: next < body.len(),
    })
}

// ── Cerrar ──────────────────────────────────────────────────────

/// La tarea corre en un worktree: su `cwd` pasa a ser el de adentro.
pub fn set_worktree(
    conn: &Connection,
    task_id: &str,
    cwd: &str,
    root: &str,
    branch: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET cwd = ?1, worktree_path = ?2, branch = ?3 WHERE id = ?4",
        rusqlite::params![cwd, root, branch, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `(carpeta del proyecto, cwd de la tarea, raíz del worktree)`, si corre en uno.
pub fn worktree_of_task(conn: &Connection, task_id: &str) -> Option<(String, String, String)> {
    conn.query_row(
        "SELECT r.cwd, t.cwd, t.worktree_path FROM tasks t JOIN runs r ON r.id = t.run_id
         WHERE t.id = ?1 AND t.worktree_path IS NOT NULL",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn mark_worktree_removed(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET worktree_removed = 1 WHERE id = ?1",
        [task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// El id de sesión que dio la TUI, cuando no se le pudo imponer uno (OpenCode, Codex): es el
/// que sirve para reabrir la tarea como tab.
pub fn set_session_id(conn: &Connection, task_id: &str, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET session_id = ?1 WHERE id = ?2",
        rusqlite::params![session_id, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// La tarea arrancó: queda el id de sesión que se le impuso y dónde va su crudo.
pub fn mark_running(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    session_id: &str,
    events_path: &str,
) -> Result<bool, String> {
    if conn.is_autocommit() {
        let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let changed = mark_running_inner(&tx, task_id, attempt_id, session_id, events_path)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    } else {
        // Alguns providers (como Gemini Desktop) já reservam uma transação maior para
        // gravar a consulta externa e a task juntas. Nesse caso, compomos na transação do
        // chamador em vez de tentar abrir uma transação aninhada.
        mark_running_inner(conn, task_id, attempt_id, session_id, events_path)
    }
}

fn mark_running_inner(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    session_id: &str,
    events_path: &str,
) -> Result<bool, String> {
    let assignment = conn
        .query_row(
            "SELECT run_id, agent_id, model FROM tasks WHERE id = ?1 AND status = ?2",
            rusqlite::params![task_id, status::READY],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((run_id, agent_id, model)) = assignment else {
        return Ok(false);
    };
    let open = latest_attempt(conn, task_id)?.filter(|row| row.ended_at.is_none());
    if open.as_ref().is_some_and(|row| row.status == status::RUNNING) {
        return Ok(false);
    }
    let now = now_ts();
    let changed = conn.execute(
        "UPDATE tasks SET status = ?1, session_id = ?2, events_path = ?3, started_at = ?4,
                          attempt = attempt + 1
         WHERE id = ?5 AND status = ?6",
        rusqlite::params![status::RUNNING, session_id, events_path, now, task_id, status::READY],
    )
    .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Ok(false);
    }
    if let Some(open) = open {
        // A retomada já criou a linha. Promove essa, sem abrir uma segunda.
        conn.execute(
            "UPDATE run_attempts SET id = ?1, status = 'running', agent_id = ?2, model = ?3,
                                     session_id = ?4, events_path = ?5, started_at = ?6
             WHERE id = ?7 AND ended_at IS NULL AND status != ?8",
            rusqlite::params![
                attempt_id,
                agent_id,
                model,
                session_id,
                events_path,
                now,
                open.id,
                status::RUNNING,
            ],
        )
        .map_err(|error| error.to_string())?;
    } else {
        let attempt: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(attempt), 0) + 1 FROM run_attempts WHERE task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO run_attempts (id, task_id, run_id, attempt, agent_id, model, session_id,
                                       events_path, status, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9)",
            rusqlite::params![attempt_id, task_id, run_id, attempt, agent_id, model, session_id, events_path, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Fecha a tentativa viva mais recente. Tarefas que falharam antes de o processo nascer
/// não têm tentativa e tornam esta operação um no-op.
pub fn close_active_attempt(
    conn: &Connection,
    task_id: &str,
    final_status: &str,
    outcome: Option<&TaskOutcome>,
    ended_at: i64,
) -> Result<bool, String> {
    let (result, error, tokens_in, tokens_out, cost_usd) = outcome.map_or(
        (None, None, None, None, None),
        |outcome| (outcome.result.as_deref(), outcome.error.as_deref(), outcome.tokens_in, outcome.tokens_out, outcome.cost_usd),
    );
    let changed = conn
        .execute(
            "UPDATE run_attempts SET status = ?1, result = ?2, error = ?3, tokens_in = ?4,
                                     tokens_out = ?5, cost_usd = ?6, ended_at = ?7
             WHERE id = (SELECT id FROM run_attempts
                         WHERE task_id = ?8 AND ended_at IS NULL ORDER BY attempt DESC LIMIT 1)",
            rusqlite::params![final_status, result, error, tokens_in, tokens_out, cost_usd, ended_at, task_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed == 1)
}

/// Save delivery only for the caller's running worker, without changing lifecycle/routing.
pub fn save_handoff(
    conn: &Connection,
    task_id: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let handoff = super::handoff::parse(value)?;
    let raw = serde_json::to_string(&handoff).map_err(|e| e.to_string())?;
    let changed = conn.execute(
        "UPDATE tasks SET structured_handoff = ?1 WHERE id = ?2 AND role = 'worker' AND status = 'running'",
        rusqlite::params![raw, task_id],
    ).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Only the current running worker can submit its handoff; historical tasks are immutable".into());
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static RECOVERABLE_LOGS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn log_recoverable(message: &str) {
    eprintln!("[harness] {message}");
    #[cfg(test)]
    RECOVERABLE_LOGS.with(|logs| logs.borrow_mut().push(message.to_string()));
}

#[cfg(test)]
pub(crate) fn take_recoverable_logs() -> Vec<String> {
    RECOVERABLE_LOGS.with(|logs| std::mem::take(&mut *logs.borrow_mut()))
}

/// Grava o fim. Se a escrita falha, o erro fica no log e a tarefa aberta passa a
/// `failed` com essa mensagem, em vez de seguir `running` sem rastro.
pub fn persist_finish(conn: &Connection, task_id: &str, outcome: &TaskOutcome) -> TaskOutcome {
    match finish_task(conn, task_id, outcome) {
        Ok(()) => outcome.clone(),
        Err(error) => {
            let message = format!("erro recuperável ao gravar o fim da tarefa {task_id}: {error}");
            log_recoverable(&message);
            let failed = TaskOutcome::failed(message);
            if let Err(again) = finish_task(conn, task_id, &failed) {
                log_recoverable(&format!(
                    "erro recuperável ao gravar o fim da tarefa {task_id}: a tarefa segue aberta ({again})"
                ));
            }
            failed
        }
    }
}

/// La tarea cerró. Acumula lo gastado en su run, que es lo que mira el presupuesto.
///
/// Solo pisa filas abiertas (`ready` o `running`). Si el usuario canceló, el proceso muere
/// y el supervisor llega acá igual con un veredicto de fallo, y ese fallo no es de la tarea
/// sino de haberla parado: cancelada tiene que quedar cancelada. `ready` entra porque una
/// tarea que falla AL LANZARSE (un binario que no está, una cuenta borrada) nunca llegó a
/// correr, y sin eso se quedaría en `ready` para siempre.
pub fn finish_task(conn: &Connection, task_id: &str, outcome: &TaskOutcome) -> Result<(), String> {
    // Central finalization also covers IPC/runtime callers; no model-text heuristics.
    let mut outcome = outcome.clone();
    if outcome.ok {
        if let Some(task) = task_by_id(conn, task_id)? {
            // O verde já registrado no cache para esta árvore também é evidência (sem repetir a suíte).
            let green_in_cache = || {
                let dir = task.worktree_path.as_deref().unwrap_or(task.cwd.as_str());
                crate::testspeed::run::full_gate_green(conn, std::path::Path::new(dir))
            };
            if task.full_gate
                && !super::fixrounds::full_gate_satisfied(outcome.result.as_deref().unwrap_or(""), task.structured_handoff.as_ref())
                && !green_in_cache()
            {
                outcome.ok = false;
                outcome.error = Some(super::fixrounds::MISSING_GATE.into());
            }
        }
    }
    if outcome.ok {
        let no_workers: bool = conn.query_row(
            "SELECT role = 'lead' AND NOT EXISTS (
                SELECT 1 FROM tasks worker WHERE worker.run_id = lead.run_id AND worker.role = 'worker'
             ) FROM tasks lead WHERE lead.id = ?1",
            [task_id], |row| Ok(row.get::<_, Option<bool>>(0)?.unwrap_or(false)),
        ).map_err(|error| error.to_string())?;
        if no_workers {
            outcome.ok = false;
            outcome.result = None;
            outcome.error = Some("The Lead finished without creating an execution plan. No worker tasks were delegated. Check that the provider supports ADE orchestration tools.".into());
        }
    }
    let state = if outcome.ok {
        status::DONE
    } else {
        status::FAILED
    };
    // Como estaba ANTES de cerrarla: la cuenta y el modelo de ESTE intento (ver `ledger`).
    let attempt = task_by_id(conn, task_id)?;
    let ended_at = now_ts();
    let closed = conn.execute(
        // Costo y tokens SUMAN: con reintentos, la tarea gastó lo de todos sus intentos, y
        // mostrar solo el último escondería lo que costó que fallara la primera vez.
        "UPDATE tasks SET status = ?1, result = ?2, error = ?3,
                          cost_usd = CASE WHEN ?4 IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ?4 END,
                          tokens_in = CASE WHEN ?5 IS NULL THEN tokens_in ELSE COALESCE(tokens_in, 0) + ?5 END,
                          tokens_out = CASE WHEN ?6 IS NULL THEN tokens_out ELSE COALESCE(tokens_out, 0) + ?6 END,
                          ended_at = ?7
         WHERE id = ?8 AND status IN ('ready', 'running')",
        rusqlite::params![
            state,
            outcome.result,
            outcome.error,
            outcome.cost_usd,
            outcome.tokens_in,
            outcome.tokens_out,
            ended_at,
            task_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    // Solo si este llamado la cerró: una segunda finalización del mismo intento no cuenta dos veces.
    if closed > 0
        && let Some(task) = &attempt
    {
        super::ledger::record_attempt(conn, task, &outcome, now_ts())?;
        close_active_attempt(conn, task_id, state, Some(&outcome), ended_at)?;
    }

    if let Some(cost) = outcome.cost_usd {
        conn.execute(
            "UPDATE runs SET spent_usd = spent_usd + ?1
             WHERE id = (SELECT run_id FROM tasks WHERE id = ?2)",
            rusqlite::params![cost, task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reconcilia tarefas deixadas pelo encerramento do app em uma única transação.
///
/// Os processos da Frota são filhos do app e não sobrevivem a ele. O scheduler mantém os
/// estados internos `failed`/`cancelled`, mas tentativas originadas no chat registram também
/// o evento `interrupted` que o grafo mostra. Nenhuma tarefa é relançada automaticamente.
/// O erro que o sweep do boot grava numa tarefa que estava rodando (a tela de retomar conta as rodadas
/// de correção interrompidas por ele, ver `missions::automation`).
pub const SWEPT_RUNNING_ERROR: &str = "o app foi fechado enquanto esta tarefa rodava";

pub fn sweep_orphans(db: &DbConnection) -> Result<usize, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let now = now_ts();
    let event_at = crate::util::now_ts_ms();
    let interrupted_attempts: Vec<(String, String)> = {
        let mut statement = tx
            .prepare(
                "SELECT a.task_id, a.id FROM run_attempts a
                 JOIN tasks t ON t.id = a.task_id
                 WHERE t.status IN ('ready', 'running') AND a.ended_at IS NULL",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?
    };
    for (task_id, attempt_id) in &interrupted_attempts {
        super::execution_log::record_fleet_interrupted(
            &tx,
            task_id,
            attempt_id,
            SWEPT_RUNNING_ERROR,
            event_at,
        )
        .map_err(|error| error.to_string())?;
    }
    let n = tx
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE status IN ('ready', 'running')",
            rusqlite::params![status::FAILED, SWEPT_RUNNING_ERROR, now],
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE run_attempts
         SET status = (SELECT status FROM tasks WHERE tasks.id = run_attempts.task_id),
             error = (SELECT error FROM tasks WHERE tasks.id = run_attempts.task_id),
             ended_at = (SELECT ended_at FROM tasks WHERE tasks.id = run_attempts.task_id)
         WHERE ended_at IS NULL
           AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = run_attempts.task_id
                       AND tasks.status NOT IN ('ready', 'running'))",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Las que esperaban turno no se relanzan solas al reabrir: su lead murió con la app, y
    // un plan a medias corriendo sin nadie que lo mire no es lo que alguien dejó andando.
    let waiting = tx
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE status = ?4",
            rusqlite::params![
                status::CANCELLED,
                "o app foi fechado antes de chegar a vez dela de rodar",
                now,
                status::PENDING
            ],
        )
        .map_err(|e| e.to_string())?;
    let open_runs: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM runs WHERE status = 'running'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for run in open_runs {
        refresh_run_status(&tx, &run)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(n + waiting)
}

// ── Reglas de permisos ──────────────────────────────────────────

/// Una regla tal como se guarda y como la ve la consola.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleRow {
    pub id: String,
    pub cwd: String,
    pub pattern: String,
    pub allow: bool,
    pub created_at: i64,
}

/// La carpeta de proyecto de una tarea: la de su run, no la suya.
///
/// Hoy coinciden. Cuando las tareas corran en worktrees, cada una va a tener su propio
/// cwd, y las reglas tienen que seguir siendo las del proyecto desde el que se lanzaron.
pub fn project_cwd_of_task(conn: &Connection, task_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT r.cwd FROM runs r JOIN tasks t ON t.run_id = r.id WHERE t.id = ?1",
        [task_id],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Las reglas de una carpeta, en el orden en que se evalúan.
///
/// Por creación, con el `rowid` de desempate: dos reglas creadas en el mismo segundo
/// tienen que salir siempre en el mismo orden, porque con "gana la primera que coincide"
/// un orden inestable es un resultado inestable.
pub fn list_rules(conn: &Connection, cwd: &str) -> Result<Vec<RuleRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, pattern, allow, created_at FROM permission_rules
             WHERE cwd = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([cwd], |row| {
            Ok(RuleRow {
                id: row.get(0)?,
                cwd: row.get(1)?,
                pattern: row.get(2)?,
                allow: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Guarda una regla. Si ya había una con el mismo patrón en esa carpeta, le cambia el
/// veredicto **sin moverla de lugar**.
///
/// No moverla importa: el orden decide con "gana la primera", y darle vuelta a una regla
/// que ya existía no debería cambiar su precedencia respecto de las demás a espaldas del
/// usuario.
pub fn upsert_rule(
    conn: &Connection,
    cwd: &str,
    pattern: &str,
    allow: bool,
) -> Result<RuleRow, String> {
    let pattern = pattern.trim();
    conn.execute(
        "INSERT INTO permission_rules (id, cwd, pattern, allow, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(cwd, pattern) DO UPDATE SET allow = excluded.allow",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            cwd,
            pattern,
            allow as i64,
            now_ts()
        ],
    )
    .map_err(|e| e.to_string())?;

    list_rules(conn, cwd)?
        .into_iter()
        .find(|r| r.pattern == pattern)
        .ok_or_else(|| "a regra não foi salva".to_string())
}

pub fn delete_rule(conn: &Connection, id: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM permission_rules WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}
