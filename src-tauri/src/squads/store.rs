use rusqlite::{Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::{roles, runs::Complexity, util::now_ts};

use super::types::{Squad, SquadInput, SquadLead, SquadLeadInput, SquadMember, SquadMemberInput, ValidSquad};

const SQUAD_COLUMNS: &str = "id, name, description, lead_agent_id, lead_model, lead_account_id, \
                             lead_auto_account, lead_complexity, created_at, updated_at";

fn clean(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn validate_provider(conn: &Connection, agent_id: &str, account_id: &Option<String>) -> Result<(), String> {
    crate::runs::ensure_headless(agent_id)?;
    if let Some(id) = account_id {
        let owner: Option<String> = conn
            .query_row("SELECT agent_id FROM agent_accounts WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        match owner {
            Some(owner) if owner == agent_id => {}
            Some(owner) => return Err(format!("account '{id}' belongs to '{owner}', not '{agent_id}'")),
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
    lead.model = clean(&lead.model);
    lead.account_id = if lead.auto_account { None } else { clean(&lead.account_id) };
    if lead.agent_id.is_empty() {
        return Err("squad lead provider is required".into());
    }
    validate_provider(conn, &lead.agent_id, &lead.account_id)
        .map_err(|error| format!("lead: {error}"))?;

    let mut seen = std::collections::HashSet::new();
    let mut members = Vec::with_capacity(input.members.len());
    for input_member in &input.members {
        let mut member = input_member.clone();
        member.role_id = member.role_id.trim().to_string();
        member.agent_id = member.agent_id.trim().to_string();
        member.model = clean(&member.model);
        member.account_id = if member.auto_account { None } else { clean(&member.account_id) };

        if roles::get(&member.role_id).is_none() {
            return Err(format!("functional role '{}' does not exist", member.role_id));
        }
        if !seen.insert(member.role_id.clone()) {
            return Err(format!("role '{}' is configured more than once in this squad", member.role_id));
        }
        if member.agent_id.is_empty() {
            return Err(format!("role '{}' needs a provider", member.role_id));
        }
        validate_provider(conn, &member.agent_id, &member.account_id)
            .map_err(|error| format!("role '{}': {error}", member.role_id))?;
        members.push(member);
    }

    Ok(ValidSquad {
        name,
        description: input.description.trim().to_string(),
        lead,
        members,
    })
}

fn provider_status(agent_id: &str) -> (bool, Option<String>) {
    if let Err(error) = crate::runs::ensure_headless(agent_id) {
        return (false, Some(error));
    }
    let installed = crate::agents::agent_command(agent_id).is_some_and(crate::agents::command_exists);
    if !installed {
        let label = crate::agents::agent_label(agent_id).unwrap_or(agent_id);
        return (false, Some(format!("{label} is not installed")));
    }
    (true, None)
}

fn assignment_status(conn: &Connection, agent_id: &str, account_id: &Option<String>) -> (bool, Option<String>) {
    let (available, reason) = provider_status(agent_id);
    if !available {
        return (false, reason);
    }
    if let Some(id) = account_id {
        let owner: Option<String> = conn
            .query_row("SELECT agent_id FROM agent_accounts WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        if owner.as_deref() != Some(agent_id) {
            return (false, Some(format!("account '{id}' is missing or belongs to another provider")));
        }
    }
    (true, None)
}

fn row_to_squad(conn: &Connection, row: &Row) -> rusqlite::Result<Squad> {
    let id: String = row.get(0)?;
    let lead_agent_id: String = row.get(3)?;
    let lead_account_id: Option<String> = row.get(5)?;
    let (lead_available, lead_reason) = assignment_status(conn, &lead_agent_id, &lead_account_id);
    let lead = SquadLead {
        agent_id: lead_agent_id,
        model: row.get(4)?,
        account_id: lead_account_id,
        auto_account: row.get::<_, i64>(6)? != 0,
        complexity: row.get(7)?,
        available: lead_available,
        unavailable_reason: lead_reason.clone(),
    };
    let mut stmt = conn
        .prepare("SELECT role_id, agent_id, model, account_id, auto_account, complexity, isolate_default FROM squad_members WHERE squad_id = ?1 ORDER BY rowid")?;
    let members = stmt
        .query_map([&id], |member| {
            let agent_id: String = member.get(1)?;
            let account_id: Option<String> = member.get(3)?;
            let (available, unavailable_reason) = assignment_status(conn, &agent_id, &account_id);
            Ok(SquadMember {
                role_id: member.get(0)?,
                agent_id,
                model: member.get(2)?,
                account_id,
                auto_account: member.get::<_, i64>(4)? != 0,
                complexity: member.get(5)?,
                isolate_default: member.get::<_, i64>(6)? != 0,
                available,
                unavailable_reason,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut unavailable_reasons = Vec::new();
    if let Some(reason) = lead_reason {
        unavailable_reasons.push(format!("lead: {reason}"));
    }
    for member in &members {
        if let Some(reason) = &member.unavailable_reason {
            let label = roles::get(&member.role_id).map_or(member.role_id.as_str(), |role| role.label);
            unavailable_reasons.push(format!("{label}: {reason}"));
        }
    }
    Ok(Squad {
        id,
        name: row.get(1)?,
        description: row.get(2)?,
        lead,
        members,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        available: unavailable_reasons.is_empty(),
        unavailable_reasons,
    })
}

fn insert_members(conn: &Connection, squad_id: &str, members: &[SquadMemberInput]) -> Result<(), String> {
    for member in members {
        conn.execute(
            "INSERT INTO squad_members (squad_id, role_id, agent_id, model, account_id, auto_account, complexity, isolate_default)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                squad_id,
                member.role_id,
                member.agent_id,
                member.model,
                member.account_id,
                member.auto_account as i64,
                member.complexity.map(Complexity::as_str),
                member.isolate_default as i64,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn save_lead(conn: &Connection, squad_id: &str, lead: &SquadLeadInput) -> Result<(), String> {
    conn.execute(
        "UPDATE squads SET lead_agent_id = ?1, lead_model = ?2, lead_account_id = ?3,
                            lead_auto_account = ?4, lead_complexity = ?5 WHERE id = ?6",
        rusqlite::params![
            lead.agent_id,
            lead.model,
            lead.account_id,
            lead.auto_account as i64,
            lead.complexity.map(Complexity::as_str),
            squad_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn create(conn: &Connection, valid: &ValidSquad) -> Result<Squad, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
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
    insert_members(&tx, &id, &valid.members)?;
    tx.commit().map_err(|error| error.to_string())?;
    get(conn, &id)?.ok_or_else(|| "squad was not saved".into())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Squad>, String> {
    conn.query_row(&format!("SELECT {SQUAD_COLUMNS} FROM squads WHERE id = ?1"), [id], |row| row_to_squad(conn, row))
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<Squad>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {SQUAD_COLUMNS} FROM squads ORDER BY name COLLATE NOCASE, created_at"))
        .map_err(|error| error.to_string())?;
    let rows = stmt.query_map([], |row| row_to_squad(conn, row)).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}

pub fn update(conn: &Connection, id: &str, valid: &ValidSquad) -> Result<Squad, String> {
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let changed = tx.execute(
        "UPDATE squads SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![valid.name, valid.description, now_ts(), id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("no squad '{id}' exists"));
    }
    save_lead(&tx, id, &valid.lead)?;
    tx.execute("DELETE FROM squad_members WHERE squad_id = ?1", [id]).map_err(|error| error.to_string())?;
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
    let changed = conn.execute("DELETE FROM squads WHERE id = ?1", [id]).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("no squad '{id}' exists"));
    }
    Ok(())
}

pub fn snapshot_members(conn: &Connection, squad_id: &str) -> Result<Vec<super::types::RunSquadMember>, String> {
    let mut stmt = conn
        .prepare("SELECT role_id, agent_id, model, account_id, auto_account, complexity, isolate_default
                  FROM squad_members WHERE squad_id = ?1 ORDER BY role_id")
        .map_err(|error| error.to_string())?;
    let rows = stmt.query_map([squad_id], |row| {
        Ok(super::types::RunSquadMember {
            role_id: row.get(0)?,
            agent_id: row.get(1)?,
            model: row.get(2)?,
            account_id: row.get(3)?,
            auto_account: row.get::<_, i64>(4)? != 0,
            complexity: row.get(5)?,
            isolate_default: row.get::<_, i64>(6)? != 0,
        })
    }).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}

pub fn snapshot_members_of_run(conn: &Connection, run_id: &str) -> Result<Vec<super::types::RunSquadMember>, String> {
    let mut stmt = conn
        .prepare("SELECT role_id, agent_id, model, account_id, auto_account, complexity, isolate_default
                  FROM run_squad_members WHERE run_id = ?1 ORDER BY role_id")
        .map_err(|error| error.to_string())?;
    let rows = stmt.query_map([run_id], |row| {
        Ok(super::types::RunSquadMember {
            role_id: row.get(0)?,
            agent_id: row.get(1)?,
            model: row.get(2)?,
            account_id: row.get(3)?,
            auto_account: row.get::<_, i64>(4)? != 0,
            complexity: row.get(5)?,
            isolate_default: row.get::<_, i64>(6)? != 0,
        })
    }).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}
