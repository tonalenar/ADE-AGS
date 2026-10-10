//! Las filas de `missions`: validarlas, crearlas, editarlas y seguir a su run.
//!
//! Crear o editar una misión es solo escribir en la base. Nada de acá lanza procesos,
//! crea worktrees ni toca el supervisor: eso pasa recién en `missions::start`.

use rusqlite::{Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::util::now_ts;

use super::delivery::{CiStatus, MissionDelivery, PrState, TestResult, mission_status, normalize_pr_reference};
use super::types::{Mission, MissionInput, MissionSummary, status};
use super::{FailureActionKey, FailureCategory, FailureClassification};

const COLUMNS: &str = "id, workspace_id, title, objective, cwd, status, max_parallel, budget_usd, \
                       lead_agent_id, lead_model, lead_account_id, auto_account, complexity, \
                       active_run_id, created_at, updated_at, started_at, ended_at, squad_id, reasoning_effort, \
                       failure_class, failure_action_key, failure_detail, is_test";

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
        is_test: row.get::<_, i64>(23)? != 0,
    })
}

// ── Validar ─────────────────────────────────────────────────────

/// Un pedido ya revisado y normalizado: lo único que llega a la base.
#[derive(Debug, Clone, PartialEq)]
pub struct Valid {
    pub is_test: Option<bool>,
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
        is_test: input.is_test,
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
        return Err(format!("não há nenhum workspace {workspace_id}"));
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    conn.execute(
        "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, max_parallel, budget_usd,
                               lead_agent_id, lead_model, lead_account_id, auto_account, complexity,
                               created_at, updated_at, squad_id, reasoning_effort, is_test)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, ?16, ?17)",
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
            valid.is_test.unwrap_or(false) as i64,
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
                    l.status
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
                spent_usd: row.get(24)?,
                workers_total: row.get(25)?,
                workers_done: row.get(26)?,
                lead_agent: row.get(27)?,
                lead_status: row.get(28)?,
                active_seconds: None,
                active_source: None,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect::<Vec<MissionSummary>>();
    // Mesma cadeia de fontes de `efficiency` e `timings`: lista, QG e CLI mostram o mesmo valor.
    let now = crate::util::now_ts();
    let mut rows = rows;
    for row in &mut rows {
        let active = super::active::resolve_mission(conn, &row.mission.id, row.mission.started_at, row.mission.ended_at, now)?;
        row.active_seconds = active.ms.map(|ms| ms / 1000);
        row.active_source = active.source.map(str::to_owned);
    }
    Ok(rows)
}

// ── Editar ──────────────────────────────────────────────────────

/// Edita una misión.
///
/// En borrador cambia todo. Después de arrancar solo cambia el título: el resto describe
/// cómo se ejecutó, y cambiarlo reescribiría lo que pasó.
pub fn update(conn: &Connection, id: &str, valid: &Valid) -> Result<Mission, String> {
    let current = get(conn, id)?.ok_or_else(|| format!("não há nenhuma missão {id}"))?;
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
        let same_config = same_config && current.squad_id == valid.squad_id
            && valid.is_test.is_none_or(|marked| marked == current.is_test);
        if !same_config {
            return Err("a missão já começou: só o título pode ser alterado".into());
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
                                 auto_account = ?9, complexity = ?10, updated_at = ?11, squad_id = ?12, reasoning_effort = ?13, is_test = COALESCE(?16, is_test)
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
                valid.is_test.map(i64::from),
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("a missão já começou: só o título pode ser alterado".into());
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
        return Err("Uma missão em terminais só é concluída com evidência de entrega.".into());
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
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
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
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(mission_id) DO UPDATE SET
             test_result = excluded.test_result,
             pull_request = excluded.pull_request,
             ci_status = excluded.ci_status,
             checked_at = excluded.checked_at",
        rusqlite::params![
            id,
            evidence.test_result.as_str(),
            evidence.pull_request.as_deref(),
            evidence.ci_status.as_str(),
            evidence.checked_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO mission_delivery_audit (
             mission_id, action, previous_status, new_status,
             test_result, pull_request, pr_state, ci_status,
             promoted, reason, checked_at
         ) VALUES (?1, 'finish_terminals', 'running', ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            id,
            outcome,
            evidence.test_result.as_str(),
            evidence.pull_request.as_deref(),
            evidence.ci_status.as_str(),
            if outcome == status::DONE { 1 } else { 0 },
            format!("Conclusão manual em terminais com status {outcome}"),
            evidence.checked_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedeliverOutcome {
    pub mission_id: String,
    pub previous_status: String,
    pub new_status: String,
    pub promoted: bool,
    pub pull_request: Option<String>,
    pub pr_state: PrState,
    pub ci_status: CiStatus,
    pub test_result: TestResult,
    pub reason: String,
    pub checked_at: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissionDeliveryAuditEntry {
    pub id: i64,
    pub mission_id: String,
    pub action: String,
    pub previous_status: String,
    pub new_status: String,
    pub test_result: String,
    pub pull_request: Option<String>,
    pub pr_state: Option<String>,
    pub ci_status: String,
    pub promoted: bool,
    pub reason: Option<String>,
    pub checked_at: i64,
}

pub fn delivery_audit_for_mission(conn: &Connection, mission_id: &str) -> Result<Vec<MissionDeliveryAuditEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, mission_id, action, previous_status, new_status, test_result,
                    pull_request, pr_state, ci_status, promoted, reason, checked_at
             FROM mission_delivery_audit
             WHERE mission_id = ?1
             ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([mission_id], |row| {
            let promoted_int: i64 = row.get(9)?;
            Ok(MissionDeliveryAuditEntry {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                action: row.get(2)?,
                previous_status: row.get(3)?,
                new_status: row.get(4)?,
                test_result: row.get(5)?,
                pull_request: row.get(6)?,
                pr_state: row.get(7)?,
                ci_status: row.get(8)?,
                promoted: promoted_int != 0,
                reason: row.get(10)?,
                checked_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

pub fn redeliver_with_checker<F>(
    conn: &Connection,
    mission_id: &str,
    cwd: &str,
    pr_override: Option<&str>,
    test_override: Option<TestResult>,
    pr_checker: F,
) -> Result<RedeliverOutcome, String>
where
    F: Fn(&std::path::Path, &str) -> (PrState, CiStatus),
{
    let mission = get(conn, mission_id)?
        .ok_or_else(|| format!("não há nenhuma missão {mission_id}"))?;

    // Nunca mexe em missão failed ou cancelled
    if mission.status == status::FAILED || mission.status == status::CANCELLED {
        return Err(format!(
            "Não é permitido reavaliar missão com status '{}'.",
            mission.status
        ));
    }

    if mission.status != status::DONE && mission.status != status::DONE_WITHOUT_DELIVERY {
        return Err(format!(
            "Apenas missões finalizadas podem ser reavaliadas (status atual: '{}').",
            mission.status
        ));
    }

    let existing_delivery = delivery_for_mission(conn, mission_id)?;

    // Determina o PR a ser verificado
    let target_pr = match pr_override {
        Some(pr) if !pr.trim().is_empty() => Some(normalize_pr_reference(pr)?),
        _ => existing_delivery.as_ref().and_then(|d| d.pull_request.clone()),
    };

    // Determina o resultado dos testes
    let target_test_result = match test_override {
        Some(tr) => tr,
        None => existing_delivery
            .as_ref()
            .map(|d| d.test_result)
            .unwrap_or(TestResult::NotRun),
    };

    let checked_at = now_ts();

    // Consulta estado do PR e CI
    let (pr_state, ci_status) = match target_pr.as_deref() {
        Some(pr_ref) => pr_checker(std::path::Path::new(cwd), pr_ref),
        None => (PrState::Unknown, CiStatus::NotApplicable),
    };

    // Só promove para done se PR mesclado e CI verde e testes aprovados
    let has_pr = target_pr.is_some();
    let is_merged = pr_state == PrState::Merged;
    let is_ci_green = ci_status == CiStatus::Success;
    let is_test_passed = target_test_result == TestResult::Passed;

    let can_promote = has_pr && is_merged && is_ci_green && is_test_passed;

    let previous_status = mission.status.clone();
    let (new_status, promoted, reason) = if can_promote {
        if previous_status == status::DONE_WITHOUT_DELIVERY {
            (
                status::DONE.to_string(),
                true,
                format!(
                    "PR {} mesclado e CI verde com testes aprovados; missão promovida com sucesso para done.",
                    target_pr.as_deref().unwrap_or("")
                ),
            )
        } else {
            (
                status::DONE.to_string(),
                false,
                format!(
                    "PR {} mesclado e CI verde com testes aprovados; já estava em done (idempotente).",
                    target_pr.as_deref().unwrap_or("")
                ),
            )
        }
    } else {
        let reason = if !has_pr {
            "Nenhum pull request informado ou associado à missão. Nunca promove sem evidência.".to_string()
        } else if !is_test_passed {
            format!(
                "Testes não aprovados (resultado: {}). Só promove se testes aprovados, PR mesclado e CI verde.",
                target_test_result.as_str()
            )
        } else if !is_merged {
            format!(
                "PR {} não está mesclado (estado: {}). Só promove se PR mesclado e CI verde.",
                target_pr.as_deref().unwrap_or(""),
                pr_state.as_str()
            )
        } else {
            format!(
                "CI do PR {} não está verde (estado do CI: {}). Só promove se CI verde.",
                target_pr.as_deref().unwrap_or(""),
                ci_status.as_str()
            )
        };

        (previous_status.clone(), false, reason)
    };

    // Executa persistência no banco em transação atômica
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;

    if new_status != previous_status {
        tx.execute(
            "UPDATE missions SET status = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![new_status, checked_at, mission_id],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "INSERT INTO mission_terminal_deliveries (mission_id, test_result, pull_request, ci_status, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(mission_id) DO UPDATE SET
             test_result = excluded.test_result,
             pull_request = excluded.pull_request,
             ci_status = excluded.ci_status,
             checked_at = excluded.checked_at",
        rusqlite::params![
            mission_id,
            target_test_result.as_str(),
            target_pr.as_deref(),
            ci_status.as_str(),
            checked_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO mission_delivery_audit (
             mission_id, action, previous_status, new_status,
             test_result, pull_request, pr_state, ci_status,
             promoted, reason, checked_at
         ) VALUES (?1, 'redeliver', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            mission_id,
            previous_status,
            new_status,
            target_test_result.as_str(),
            target_pr.as_deref(),
            pr_state.as_str(),
            ci_status.as_str(),
            if promoted { 1 } else { 0 },
            reason,
            checked_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(RedeliverOutcome {
        mission_id: mission_id.to_string(),
        previous_status,
        new_status,
        promoted,
        pull_request: target_pr,
        pr_state,
        ci_status,
        test_result: target_test_result,
        reason,
        checked_at,
    })
}

pub fn redeliver(
    conn: &Connection,
    mission_id: &str,
    cwd: &str,
    pr_override: Option<&str>,
    test_override: Option<TestResult>,
) -> Result<RedeliverOutcome, String> {
    redeliver_with_checker(conn, mission_id, cwd, pr_override, test_override, super::delivery::check_pr_status)
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

/// Start payload may explicitly mark a draft/retry; no implicit or historical relabeling.
pub(crate) fn mark_test_before_start(conn: &Connection, id: &str, is_test: bool) -> Result<(), String> {
    let changed = conn.execute("UPDATE missions SET is_test = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('draft', 'failed')",
        rusqlite::params![i64::from(is_test), now_ts(), id]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("missions.error.notStartable".into()); }
    Ok(())
}
