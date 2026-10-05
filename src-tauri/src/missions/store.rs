//! Las filas de `missions`: validarlas, crearlas, editarlas y seguir a su run.
//!
//! Crear o editar una misión es solo escribir en la base. Nada de acá lanza procesos,
//! crea worktrees ni toca el supervisor: eso pasa recién en `missions::start`.

use rusqlite::{Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::util::now_ts;

use super::delivery::{MissionDelivery, mission_status};
use super::types::{Mission, MissionInput, MissionSummary, status};
use super::{FailureActionKey, FailureCategory, FailureClassification};

const COLUMNS: &str = "id, workspace_id, title, objective, cwd, status, max_parallel, budget_usd, \
                       lead_agent_id, lead_model, lead_account_id, auto_account, complexity, \
                       active_run_id, created_at, updated_at, started_at, ended_at, squad_id, reasoning_effort, \
                       failure_class, failure_action_key, failure_detail";

/// Lo mismo que acepta `run_start_orchestration`: más de seis a la vez deja de ser
/// paralelismo que alguien pueda seguir.
const MAX_PARALLEL: i64 = 6;
const MAX_TITLE: usize = 120;

fn row_to_mission(row: &Row) -> rusqlite::Result<Mission> {
    Ok(Mission {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        objective: row.get(3)?,
        cwd: row.get(4)?,
        status: row.get(5)?,
        max_parallel: row.get(6)?,
        budget_usd: row.get(7)?,
        lead_agent_id: row.get(8)?,
        lead_model: row.get(9)?,
        lead_account_id: row.get(10)?,
        auto_account: row.get::<_, i64>(11)? != 0,
        complexity: row.get(12)?,
        active_run_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        started_at: row.get(16)?,
        ended_at: row.get(17)?,
        squad_id: row.get(18)?,
        reasoning_effort: row.get(19)?,
        failure_classification: {
            let category = row.get::<_, Option<String>>(20)?;
            let action_key = row.get::<_, Option<String>>(21)?;
            match (
                category.as_deref().and_then(FailureCategory::from_db),
                action_key.as_deref().and_then(FailureActionKey::from_db),
            ) {
                (Some(category), Some(action_key)) => Some(FailureClassification {
                    category,
                    action_key,
                }),
                _ => None,
            }
        },
        failure_detail: row.get(22)?,
    })
}

// ── Validar ─────────────────────────────────────────────────────

/// Un pedido ya revisado y normalizado: lo único que llega a la base.
#[derive(Debug, Clone, PartialEq)]
pub struct Valid {
    pub title: String,
    pub objective: String,
    pub cwd: String,
    pub max_parallel: i64,
    pub budget_usd: Option<f64>,
    pub lead_agent_id: Option<String>,
    pub lead_model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub lead_account_id: Option<String>,
    pub auto_account: bool,
    pub complexity: Option<String>,
    pub squad_id: Option<String>,
}

fn blank_to_none(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Revisa un pedido sin tocar la base. Junta todos los errores: corregir de a uno por
/// intento es peor que ver la lista entera.
pub fn validate(conn: &Connection, input: &MissionInput) -> Result<Valid, String> {
    crate::squads::store::validate_effort_input(input.lead_model.as_deref(), input.complexity, input.reasoning_effort.as_deref())?;
    if input.squad_id.is_some() && input.reasoning_effort.is_some() { return Err("Mission cannot override Squad effort".into()); }
    let mut errors = Vec::new();
    let title = input.title.trim().to_string();
    let objective = input.objective.trim().to_string();
    let cwd = input.cwd.trim().to_string();
    if title.is_empty() {
        errors.push("falta el título".to_string());
    } else if title.chars().count() > MAX_TITLE {
        errors.push(format!("el título tiene más de {MAX_TITLE} caracteres"));
    }
    if objective.is_empty() {
        errors.push("falta el objetivo".to_string());
    }
    if cwd.is_empty() {
        errors.push("falta la carpeta del proyecto".to_string());
    }
    if input.budget_usd.is_some_and(|b| !b.is_finite() || b <= 0.0) {
        errors.push("el presupuesto tiene que ser positivo".to_string());
    }
    let squad_id = blank_to_none(&input.squad_id);
    if let Some(id) = &squad_id {
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM squads WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        if exists.is_none() {
            errors.push(format!("no squad '{id}' exists"));
        }
        if blank_to_none(&input.lead_agent_id).is_some()
            || blank_to_none(&input.lead_model).is_some()
            || blank_to_none(&input.lead_account_id).is_some()
            || input.complexity.is_some()
            || !input.auto_account
        {
            errors.push(
                "a Mission using a Squad cannot override the Squad Lead provider/model/account"
                    .to_string(),
            );
        }
    }
    let lead_agent_id = if squad_id.is_some() {
        None
    } else {
        blank_to_none(&input.lead_agent_id)
    };
    let lead_model = if squad_id.is_some() {
        None
    } else {
        blank_to_none(&input.lead_model)
    };
    if lead_model.is_some() && lead_agent_id.is_none() {
        errors.push("un modelo fijo necesita decir de qué agente es".to_string());
    }
    if lead_model.is_some() && input.complexity.is_some() {
        errors.push("Specific model and complexity routing cannot be selected together".into());
    }
    if let Some(agent) = &lead_agent_id
        && let Err(e) = crate::runs::ensure_orchestration(agent)
    {
        errors.push(e);
    }
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(Valid {
        title,
        objective,
        cwd,
        max_parallel: input.max_parallel.unwrap_or(2).clamp(1, MAX_PARALLEL),
        budget_usd: input.budget_usd,
        lead_agent_id,
        lead_model,
        reasoning_effort: input.reasoning_effort.clone(),
        // Con la cuenta automática, una elegida antes no aplica: guardarla dejaría una
        // preferencia que nadie va a leer.
        lead_account_id: if squad_id.is_some() || input.auto_account {
            None
        } else {
            blank_to_none(&input.lead_account_id)
        },
        auto_account: squad_id.is_none() && input.auto_account,
        complexity: if squad_id.is_some() {
            None
        } else {
            input.complexity.map(|c| c.as_str().to_string())
        },
        squad_id,
    })
}

// ── Crear y leer ────────────────────────────────────────────────

pub fn create(conn: &Connection, workspace_id: &str, valid: &Valid) -> Result<Mission, String> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workspaces WHERE id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err(format!("no hay ningún workspace {workspace_id}"));
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    conn.execute(
        "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, max_parallel, budget_usd,
                               lead_agent_id, lead_model, lead_account_id, auto_account, complexity,
                               created_at, updated_at, squad_id, reasoning_effort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, ?16)",
        rusqlite::params![
            id,
            workspace_id,
            valid.title,
            valid.objective,
            valid.cwd,
            status::DRAFT,
            valid.max_parallel,
            valid.budget_usd,
            valid.lead_agent_id,
            valid.lead_model,
            valid.lead_account_id,
            valid.auto_account as i64,
            valid.complexity,
            now,
            valid.squad_id,
            valid.reasoning_effort,
        ],
    )
    .map_err(|e| e.to_string())?;
    get(conn, &id)?.ok_or_else(|| "la misión no quedó guardada".to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Mission>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM missions WHERE id = ?1"),
        [id],
        row_to_mission,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Evidência da conclusão manual, ausente em runs automáticos e em missões antigas.
pub fn delivery_for_mission(conn: &Connection, id: &str) -> Result<Option<MissionDelivery>, String> {
    conn.query_row(
        "SELECT test_result, pull_request, ci_status, checked_at
         FROM mission_terminal_deliveries WHERE mission_id = ?1",
        [id],
        |row| {
            let test_result: String = row.get(0)?;
            let ci_status: String = row.get(2)?;
            Ok(MissionDelivery {
                test_result: super::delivery::TestResult::parse(&test_result),
                pull_request: row.get(1)?,
                ci_status: super::delivery::CiStatus::parse(&ci_status),
                checked_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Las misiones de un workspace, más recientes primero, con el avance de su run activo.
///
/// El avance es de los workers: el lead no es trabajo repartido, es quien reparte, y
/// contarlo haría que una misión recién arrancada figure "0 / 1" sin plan todavía.
///
/// Todo en una consulta: la lista se relee con cada cambio de una tarea, y una consulta
/// por misión la haría crecer con el historial.
pub fn list(conn: &Connection, workspace_id: &str) -> Result<Vec<MissionSummary>, String> {
    let cols = COLUMNS
        .split(", ")
        .map(|c| format!("m.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {cols},
                    COALESCE(r.spent_usd, 0),
                    (SELECT COUNT(*) FROM tasks t
                     WHERE t.run_id = m.active_run_id AND COALESCE(t.role, '') <> 'lead'),
                    (SELECT COUNT(*) FROM tasks t
                     WHERE t.run_id = m.active_run_id AND COALESCE(t.role, '') <> 'lead' AND t.status = 'done'),
                    l.agent_id,
                    l.status,
                    (SELECT a.active_ms / 1000 FROM mission_active a WHERE a.mission_id = m.id)
             FROM missions m LEFT JOIN runs r ON r.id = m.active_run_id
             LEFT JOIN tasks l ON l.id = (SELECT t.id FROM tasks t WHERE t.run_id = m.active_run_id AND t.role = 'lead'
                                          ORDER BY t.created_at, t.rowid LIMIT 1)
             WHERE m.workspace_id = ?1
             ORDER BY m.created_at DESC, m.rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok(MissionSummary {
                mission: row_to_mission(row)?,
                spent_usd: row.get(23)?,
                workers_total: row.get(24)?,
                workers_done: row.get(25)?,
                lead_agent: row.get(26)?,
                lead_status: row.get(27)?,
                active_seconds: row.get(28)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ── Editar ──────────────────────────────────────────────────────

/// Edita una misión.
///
/// En borrador cambia todo. Después de arrancar solo cambia el título: el resto describe
/// cómo se ejecutó, y cambiarlo reescribiría lo que pasó.
pub fn update(conn: &Connection, id: &str, valid: &Valid) -> Result<Mission, String> {
    let current = get(conn, id)?.ok_or_else(|| format!("no hay ninguna misión {id}"))?;
    if current.status != status::DRAFT {
        let same_config = current.objective == valid.objective
            && current.cwd == valid.cwd
            && current.max_parallel == valid.max_parallel
            && current.budget_usd == valid.budget_usd
            && current.lead_agent_id == valid.lead_agent_id
            && current.lead_model == valid.lead_model
            && current.reasoning_effort == valid.reasoning_effort
            && current.lead_account_id == valid.lead_account_id
            && current.auto_account == valid.auto_account
            && current.complexity == valid.complexity;
        let same_config = same_config && current.squad_id == valid.squad_id;
        if !same_config {
            return Err("la misión ya arrancó: solo se le puede cambiar el título".into());
        }
        conn.execute(
            "UPDATE missions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![valid.title, now_ts(), id],
        )
        .map_err(|e| e.to_string())?;
        return get(conn, id)?.ok_or_else(|| "la misión se perdió".to_string());
    }
    // `status = draft` también en el WHERE: si otro la arrancó entre la lectura y acá, la
    // edición no puede cambiarle la configuración a una ejecución ya lanzada.
    let n = conn
        .execute(
            "UPDATE missions SET title = ?1, objective = ?2, cwd = ?3, max_parallel = ?4, budget_usd = ?5,
                                 lead_agent_id = ?6, lead_model = ?7, lead_account_id = ?8,
                                 auto_account = ?9, complexity = ?10, updated_at = ?11, squad_id = ?12, reasoning_effort = ?13
             WHERE id = ?14 AND status = ?15",
            rusqlite::params![
                valid.title,
                valid.objective,
                valid.cwd,
                valid.max_parallel,
                valid.budget_usd,
                valid.lead_agent_id,
                valid.lead_model,
                valid.lead_account_id,
                valid.auto_account as i64,
                valid.complexity,
                now_ts(),
                valid.squad_id,
            valid.reasoning_effort,
                id,
                status::DRAFT,
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("la misión ya arrancó: solo se le puede cambiar el título".into());
    }
    get(conn, id)?.ok_or_else(|| "la misión se perdió".to_string())
}

// ── Ciclo de vida ───────────────────────────────────────────────

/// Claims a new attempt only if the state and previous run still match the snapshot.
/// A stale start/retry rolls back its newly created run and lead in the caller's transaction.
pub fn mark_started(conn: &Connection, mission: &Mission, run_id: &str) -> Result<bool, String> {
    let now = now_ts();
    let n = conn
        .execute(
            "UPDATE missions SET status = ?1, active_run_id = ?2, started_at = ?3, updated_at = ?3,
                                 ended_at = NULL, failure_class = NULL, failure_action_key = NULL, failure_detail = NULL
             WHERE id = ?4 AND status = ?5 AND active_run_id IS ?6
                   AND status IN ('draft', 'failed')",
            rusqlite::params![status::RUNNING, run_id, now, mission.id, mission.status, mission.active_run_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Arranca una misión **en terminales**: queda `running` sin run activo (el trabajo lo hacen
/// las tabs del canvas, no la flota sin terminal). Un borrador o una fallida.
pub fn mark_started_terminals(conn: &Connection, id: &str) -> Result<bool, String> {
    let now = now_ts();
    let n = conn
        .execute(
            "UPDATE missions SET status = ?1, active_run_id = NULL, started_at = ?2, updated_at = ?2, ended_at = NULL, failure_class = NULL, failure_action_key = NULL, failure_detail = NULL
             WHERE id = ?3 AND status IN ('draft', 'failed')",
            rusqlite::params![status::RUNNING, now, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Cierra una misión en terminales (sin run) por cancelación. Una conclusión como `done`
/// exige evidencia y usa `finish_terminals`; una misión con run la cierra `refresh_status`.
pub fn close_terminals(conn: &Connection, id: &str, outcome: &str) -> Result<bool, String> {
    if outcome != status::CANCELLED {
        return Err("Una misión en terminal solo se concluye con evidencia de entrega.".into());
    }
    let now = now_ts();
    let n = conn
        .execute(
            "UPDATE missions SET status = ?1, ended_at = ?2, updated_at = ?2
             WHERE id = ?3 AND status = ?4 AND active_run_id IS NULL",
            rusqlite::params![outcome, now, id, status::RUNNING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Persiste la evidencia y cierra en una transacción para que el estado nunca diga `done`
/// si no se pudo guardar por qué pasó el gate de entrega.
pub fn finish_terminals(conn: &Connection, id: &str, evidence: &MissionDelivery) -> Result<bool, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let outcome = mission_status(evidence);
    let now = now_ts();
    let changed = tx
        .execute(
            "UPDATE missions SET status = ?1, ended_at = ?2, updated_at = ?2
             WHERE id = ?3 AND status = ?4 AND active_run_id IS NULL",
            rusqlite::params![outcome, now, id, status::RUNNING],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO mission_terminal_deliveries (mission_id, test_result, pull_request, ci_status, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            id,
            evidence.test_result.as_str(),
            evidence.pull_request.as_deref(),
            evidence.ci_status.as_str(),
            evidence.checked_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Cancela un borrador. No hay proceso que parar: nunca se lanzó nada.
pub fn cancel_draft(conn: &Connection, id: &str) -> Result<bool, String> {
    let now = now_ts();
    let n = conn
        .execute(
            "UPDATE missions SET status = ?1, ended_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = ?4",
            rusqlite::params![status::CANCELLED, now, id, status::DRAFT],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Qué estado de misión corresponde al de su run activo.
pub fn status_for_run(run_status: &str) -> &'static str {
    match run_status {
        "done" => status::DONE,
        "failed" => status::FAILED,
        "cancelled" => status::CANCELLED,
        _ => status::RUNNING,
    }
}

/// Pone a la misión en el estado de su run activo. Es el único lugar que lo hace.
///
/// Un borrador no tiene run y no se toca. Devuelve el estado resultante.
pub fn refresh_status(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT m.status, r.status,
                    (SELECT t.error FROM tasks t
                     WHERE t.run_id = m.active_run_id AND t.status = 'failed' AND t.error IS NOT NULL
                     ORDER BY CASE WHEN t.role = 'lead' THEN 0 ELSE 1 END,
                              t.created_at DESC, t.rowid DESC LIMIT 1)
             FROM missions m LEFT JOIN runs r ON r.id = m.active_run_id
             WHERE m.id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((current, run_status, error)) = row else {
        return Ok(None);
    };
    let Some(run_status) = run_status else {
        return Ok(Some(current));
    };
    let next = status_for_run(&run_status);
    if next != current {
        let now = now_ts();
        let error = error.filter(|error| !error.trim().is_empty());
        let classification = if next == status::FAILED {
            error.as_deref().and_then(super::failure::classify)
        } else {
            None
        };
        let detail = if next == status::FAILED {
            error.as_deref().map(super::failure::detail)
        } else {
            None
        };
        conn.execute(
            "UPDATE missions SET status = ?1, updated_at = ?2,
                                 ended_at = CASE WHEN ?1 = 'running' THEN NULL ELSE COALESCE(ended_at, ?2) END,
                                 failure_class = ?3, failure_action_key = ?4, failure_detail = ?5
             WHERE id = ?6",
            rusqlite::params![
                next,
                now,
                classification.map(|value| value.category.as_str()),
                classification.map(|value| value.action_key.as_str()),
                detail,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(Some(next.to_string()))
}

/// Si el run es el activo de una misión, la sincroniza. Lo llama `refresh_run_status`.
///
/// Solo el run ACTIVO mueve a la misión: cuando haya varios intentos, el que terminó
/// antes no puede pisar el estado del que corre ahora.
///
/// Devuelve la misión si su estado cambió, para que quien tenga la app avise.
pub fn refresh_for_run(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    let mission: Option<(String, String)> = conn
        .query_row(
            "SELECT m.id, m.status FROM runs r JOIN missions m ON m.id = r.mission_id AND m.active_run_id = r.id
             WHERE r.id = ?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, before)) = mission else {
        return Ok(None);
    };
    let after = refresh_status(conn, &id)?;
    Ok((after.as_deref() != Some(before.as_str())).then_some(id))
}

/// La misión que el run está cumpliendo ahora, si hay.
pub fn mission_of_run(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT m.id FROM runs r JOIN missions m ON m.id = r.mission_id AND m.active_run_id = r.id
         WHERE r.id = ?1",
        [run_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
