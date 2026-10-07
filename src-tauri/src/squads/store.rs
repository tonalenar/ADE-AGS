use rusqlite::{Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::{roles, runs::Complexity, util::now_ts};

use super::types::{
    AssignmentAvailability, Squad, SquadInput, SquadLead, SquadLeadInput, SquadMember,
    SquadMemberInput, SubagentDefault, ValidSquad,
};

const SQUAD_COLUMNS: &str = "id, name, description, lead_agent_id, lead_model, lead_account_id, \
                             lead_auto_account, lead_complexity, created_at, updated_at, reasoning_effort, fast_mode, \n                             subagent_agent_id, subagent_model, subagent_effort, subagent_fast";

pub(crate) fn validate_effort_input(model: Option<&str>, complexity: Option<Complexity>, effort: Option<&str>) -> Result<(), String> {
    if let Some(effort) = effort {
        if model.is_none() || complexity.is_some() {
            return Err("Explicit reasoning effort requires a specific model; complexity routing uses Automatic effort".into());
        }
        if !matches!(effort, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
            return Err("Unknown reasoning effort".into());
        }
    }
    Ok(())
}

/// El modo Fast es un `service_tier` de Codex: en otro agente no existe y se rechaza en vez
/// de guardarlo y que quede sin efecto.
pub(crate) fn validate_fast_input(agent_id: &str, fast: bool) -> Result<(), String> {
    if fast && agent_id != "codex" {
        return Err("Fast mode is only available for the Codex agent".into());
    }
    Ok(())
}

fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_provider(
    conn: &Connection,
    agent_id: &str,
    account_id: &Option<String>,
    lead: bool,
) -> Result<(), String> {
    if lead {
        if crate::agents::adapter_for(agent_id).is_none()
            || agent_id == crate::agents::SHELL_AGENT_ID
        {
            return Err(format!("provider '{agent_id}' is not a registered agent"));
        }
    } else {
        crate::runs::ensure_headless(agent_id)?;
    }
    if let Some(id) = account_id {
        let owner: Option<String> = conn
            .query_row(
                "SELECT agent_id FROM agent_accounts WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        match owner {
            Some(owner) if owner == agent_id => {}
            Some(owner) => {
                return Err(format!(
                    "account '{id}' belongs to '{owner}', not '{agent_id}'"
                ));
            }
            None => return Err(format!("account '{id}' does not exist")),
        }
    }
    Ok(())
}

pub fn validate(conn: &Connection, input: &SquadInput) -> Result<ValidSquad, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("squad name is required".into());
    }
    if name.chars().count() > 100 {
        return Err("squad name must be 100 characters or fewer".into());
    }

    let mut lead = input.lead.clone();
    lead.agent_id = lead.agent_id.trim().to_string();
    validate_fast_input(&lead.agent_id, lead.fast_mode).map_err(|error| format!("lead: {error}"))?;
    lead.model = clean(&lead.model);
    validate_effort_input(lead.model.as_deref(), lead.complexity, lead.reasoning_effort.as_deref())?;
    if lead.model.is_some() && lead.complexity.is_some() {
        return Err("lead: specific model and complexity cannot be selected together".into());
    }
    lead.account_id = if lead.auto_account {
        None
    } else {
        clean(&lead.account_id)
    };
    if lead.agent_id.is_empty() {
        return Err("squad lead provider is required".into());
    }
    validate_provider(conn, &lead.agent_id, &lead.account_id, true)
        .map_err(|error| format!("lead: {error}"))?;

    let default_subagent = validate_subagent(input.default_subagent.as_ref())?;

    let mut seen = std::collections::HashSet::new();
    let mut members = Vec::with_capacity(input.members.len());
    for input_member in &input.members {
        let mut member = input_member.clone();
        member.role_id = member.role_id.trim().to_string();
        member.agent_id = member.agent_id.trim().to_string();
        validate_fast_input(&member.agent_id, member.fast_mode).map_err(|error| format!("role '{}': {error}", member.role_id))?;
        member.model = clean(&member.model);
        validate_effort_input(member.model.as_deref(), member.complexity, member.reasoning_effort.as_deref())?;
        if member.model.is_some() && member.complexity.is_some() {
            return Err(format!("role '{}': specific model and complexity cannot be selected together", member.role_id));
        }
        member.account_id = if member.auto_account {
            None
        } else {
            clean(&member.account_id)
        };

        if roles::get(&member.role_id).is_none() {
            return Err(format!(
                "functional role '{}' does not exist",
                member.role_id
            ));
        }
        if !seen.insert(member.role_id.clone()) {
            return Err(format!(
                "role '{}' is configured more than once in this squad",
                member.role_id
            ));
        }
        if member.agent_id.is_empty() {
            return Err(format!("role '{}' needs a provider", member.role_id));
        }
        validate_provider(conn, &member.agent_id, &member.account_id, false)
            .map_err(|error| format!("role '{}': {error}", member.role_id))?;
        members.push(member);
    }

    Ok(ValidSquad {
        name,
        description: input.description.trim().to_string(),
        lead,
        members,
        default_subagent,
    })
}

/// El subagente padrão: un agente registrado, modelo opcional, esfuerzo solo con modelo
/// explícito y Fast solo en Codex. `None` (Automático) es válido y es el valor por defecto.
fn validate_subagent(input: Option<&SubagentDefault>) -> Result<Option<SubagentDefault>, String> {
    let Some(input) = input else { return Ok(None) };
    let agent_id = input.agent_id.trim().to_string();
    if agent_id.is_empty() {
        return Err("default subagent: provider is required (use Automatic to let the orchestrator decide)".into());
    }
    if crate::agents::adapter_for(&agent_id).is_none() {
        return Err(format!("default subagent: provider '{agent_id}' is not registered"));
    }
    let model = clean(&input.model);
    let reasoning_effort = clean(&input.reasoning_effort);
    validate_effort_input(model.as_deref(), None, reasoning_effort.as_deref())
        .map_err(|error| format!("default subagent: {error}"))?;
    validate_fast_input(&agent_id, input.fast_mode).map_err(|error| format!("default subagent: {error}"))?;
    Ok(Some(SubagentDefault { agent_id, model, reasoning_effort, fast_mode: input.fast_mode }))
}

fn assignment_status(
    conn: &Connection,
    agent_id: &str,
    model: Option<&str>,
    account_id: &Option<String>,
) -> rusqlite::Result<(AssignmentAvailability, Option<String>)> {
    let Some(adapter) = crate::agents::adapter_for(agent_id) else {
        return Ok((
            AssignmentAvailability::ProviderMissing,
            Some(format!("provider '{agent_id}' is not registered")),
        ));
    };
    let label = adapter.def().label;
    if !adapter.capabilities().headless {
        return Ok((
            AssignmentAvailability::ProviderNotHeadless,
            Some(format!("{label} cannot run headless")),
        ));
    }
    // En los tests, "instalado" no puede depender de la máquina que los corre: en la de
    // desarrollo Claude Code y Codex están y en el CI no, y el mismo test pasaba en una y
    // fallaba en la otra. Lo que se prueba acá son las demás reglas (cuenta, headless).
    let installed = cfg!(test)
        || adapter.assumes_installed()
        || crate::agents::agent_command(agent_id).is_some_and(crate::agents::command_exists);
    if !installed {
        return Ok((
            AssignmentAvailability::ProviderNotInstalled,
            Some(format!("{label} is not installed")),
        ));
    }
    if let Some(id) = account_id {
        let owner: Option<String> = conn
            .query_row(
                "SELECT agent_id FROM agent_accounts WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match owner {
            None => {
                return Ok((
                    AssignmentAvailability::AccountMissing,
                    Some(format!("account '{id}' is unavailable")),
                ));
            }
            Some(owner) if owner != agent_id => {
                return Ok((
                    AssignmentAvailability::AccountProviderMismatch,
                    Some(format!(
                        "account '{id}' belongs to '{owner}', not '{agent_id}'"
                    )),
                ));
            }
            Some(_) => {}
        }
    }
    if model.is_some_and(|value| !value.trim().is_empty()) {
        return Ok((AssignmentAvailability::Unknown, None));
    }
    Ok((AssignmentAvailability::Available, None))
}

fn row_to_squad(conn: &Connection, row: &Row) -> rusqlite::Result<Squad> {
    let id: String = row.get(0)?;
    let lead_agent_id: String = row.get(3)?;
    let lead_account_id: Option<String> = row.get(5)?;
    let lead_model: Option<String> = row.get(4)?;
    let (mut lead_availability, mut lead_reason) = assignment_status(
        conn,
        &lead_agent_id,
        lead_model.as_deref(),
        &lead_account_id,
    )?;
    if let Err(reason) = crate::runs::ensure_orchestration(&lead_agent_id)
        && lead_availability.can_attempt()
    {
        lead_availability = AssignmentAvailability::ProviderNotOrchestrating;
        lead_reason = Some(reason);
    }
    let lead = SquadLead {
        agent_id: lead_agent_id,
        model: lead_model,
        reasoning_effort: row.get(10)?,
        fast_mode: row.get::<_, i64>(11)? != 0,
        account_id: lead_account_id,
        auto_account: row.get::<_, i64>(6)? != 0,
        complexity: row.get(7)?,
        availability: lead_availability,
        unavailable_reason: lead_reason.clone(),
    };
    let mut stmt = conn
        .prepare("SELECT role_id, agent_id, model, account_id, auto_account, complexity, isolate_default, reasoning_effort, fast_mode FROM squad_members WHERE squad_id = ?1 ORDER BY rowid")?;
    let members = stmt
        .query_map([&id], |member| {
            let agent_id: String = member.get(1)?;
            let account_id: Option<String> = member.get(3)?;
            let model: Option<String> = member.get(2)?;
            let (availability, unavailable_reason) =
                assignment_status(conn, &agent_id, model.as_deref(), &account_id)?;
            Ok(SquadMember {
                role_id: member.get(0)?,
                reasoning_effort: member.get(7)?,
                fast_mode: member.get::<_, i64>(8)? != 0,
                agent_id,
                model,
                account_id,
                auto_account: member.get::<_, i64>(4)? != 0,
                complexity: member.get(5)?,
                isolate_default: member.get::<_, i64>(6)? != 0,
                availability,
                unavailable_reason,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let unavailable_reasons = lead_reason
        .into_iter()
        .map(|reason| format!("lead: {reason}"))
        .collect();
    let default_subagent = row.get::<_, Option<String>>(12)?.map(|agent_id| -> rusqlite::Result<SubagentDefault> {
        Ok(SubagentDefault {
            agent_id,
            model: row.get(13)?,
            reasoning_effort: row.get(14)?,
            fast_mode: row.get::<_, i64>(15)? != 0,
        })
    }).transpose()?;
    Ok(Squad {
        id,
        name: row.get(1)?,
        description: row.get(2)?,
        lead,
        members,
        default_subagent,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        available: lead_availability.can_attempt(),
        unavailable_reasons,
    })
}

fn insert_members(
    conn: &Connection,
    squad_id: &str,
    members: &[SquadMemberInput],
) -> Result<(), String> {
    for member in members {
        conn.execute(
            "INSERT INTO squad_members (squad_id, role_id, agent_id, model, account_id, auto_account, complexity, isolate_default, reasoning_effort, fast_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                squad_id,
                member.role_id,
                member.agent_id,
                member.model,
                member.account_id,
                member.auto_account as i64,
                member.complexity.map(Complexity::as_str),
                member.isolate_default as i64,
                member.reasoning_effort,
                member.fast_mode as i64,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn save_lead(conn: &Connection, squad_id: &str, lead: &SquadLeadInput) -> Result<(), String> {
    conn.execute(
        "UPDATE squads SET lead_agent_id = ?1, lead_model = ?2, lead_account_id = ?3,
                            lead_auto_account = ?4, lead_complexity = ?5, reasoning_effort = ?7, fast_mode = ?8 WHERE id = ?6",
        rusqlite::params![
            lead.agent_id,
            lead.model,
            lead.account_id,
            lead.auto_account as i64,
            lead.complexity.map(Complexity::as_str),
            squad_id,
            lead.reasoning_effort,
            lead.fast_mode as i64,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn save_subagent(conn: &Connection, squad_id: &str, subagent: Option<&SubagentDefault>) -> Result<(), String> {
    conn.execute(
        "UPDATE squads SET subagent_agent_id = ?1, subagent_model = ?2, subagent_effort = ?3, subagent_fast = ?4 WHERE id = ?5",
        rusqlite::params![
            subagent.map(|value| value.agent_id.as_str()),
            subagent.and_then(|value| value.model.as_deref()),
            subagent.and_then(|value| value.reasoning_effort.as_deref()),
            subagent.is_some_and(|value| value.fast_mode) as i64,
            squad_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn create(conn: &Connection, valid: &ValidSquad) -> Result<Squad, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO squads (id, name, description, lead_agent_id, lead_model, lead_account_id,
                             lead_auto_account, lead_complexity, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        rusqlite::params![
            id,
            valid.name,
            valid.description,
            valid.lead.agent_id,
            valid.lead.model,
            valid.lead.account_id,
            valid.lead.auto_account as i64,
            valid.lead.complexity.map(Complexity::as_str),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    save_lead(&tx, &id, &valid.lead)?;
    save_subagent(&tx, &id, valid.default_subagent.as_ref())?;
    insert_members(&tx, &id, &valid.members)?;
    tx.commit().map_err(|error| error.to_string())?;
    get(conn, &id)?.ok_or_else(|| "squad was not saved".into())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Squad>, String> {
    conn.query_row(
        &format!("SELECT {SQUAD_COLUMNS} FROM squads WHERE id = ?1"),
        [id],
        |row| row_to_squad(conn, row),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<Squad>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SQUAD_COLUMNS} FROM squads ORDER BY name COLLATE NOCASE, created_at"
        ))
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| row_to_squad(conn, row))
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn update(conn: &Connection, id: &str, valid: &ValidSquad) -> Result<Squad, String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let changed = tx
        .execute(
            "UPDATE squads SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![valid.name, valid.description, now_ts(), id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("no squad '{id}' exists"));
    }
    save_lead(&tx, id, &valid.lead)?;
    save_subagent(&tx, id, valid.default_subagent.as_ref())?;
    tx.execute("DELETE FROM squad_members WHERE squad_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    insert_members(&tx, id, &valid.members)?;
    tx.commit().map_err(|error| error.to_string())?;
    get(conn, id)?.ok_or_else(|| "squad was not saved".into())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let refs: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM missions WHERE squad_id = ?1) + (SELECT COUNT(*) FROM runs WHERE squad_id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if refs > 0 {
        return Err("this squad is referenced by a Mission or Run and cannot be deleted".into());
    }
    let changed = conn
        .execute("DELETE FROM squads WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("no squad '{id}' exists"));
    }
    Ok(())
}

pub fn snapshot_members_of_run(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<super::types::RunSquadMember>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role_id, agent_id, model, account_id, auto_account, complexity, isolate_default, reasoning_effort
                  FROM run_squad_members WHERE run_id = ?1 ORDER BY role_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([run_id], |row| {
            Ok(super::types::RunSquadMember {
                role_id: row.get(0)?,
                agent_id: row.get(1)?,
                model: row.get(2)?,
                account_id: row.get(3)?,
                auto_account: row.get::<_, i64>(4)? != 0,
                complexity: row.get(5)?,
                isolate_default: row.get::<_, i64>(6)? != 0,
                reasoning_effort: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}
