//! As tabelas do time (`chat_team` e `chat_team_member`): SQL puro sobre `&Connection`.
//!
//! A migração é só aditiva e idempotente (`CREATE … IF NOT EXISTS`) e roda sob demanda, como a do chat
//! da equipe (`missions::messages`): não sobe `user_version` nem toca as outras tabelas. Uma linha só
//! sai daqui quando a pessoa desliga um integrante ou desfaz o time.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::model::Policy;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_team (
            id TEXT PRIMARY KEY,
            orchestrator TEXT NOT NULL UNIQUE,
            agent_id TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            cwd TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_team_member (
            team_id TEXT NOT NULL REFERENCES chat_team(id) ON DELETE CASCADE,
            member TEXT NOT NULL UNIQUE,
            agent_id TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            model TEXT,
            policy TEXT NOT NULL DEFAULT 'ask' CHECK(policy IN ('read','ask','edits','full')),
            branch TEXT,
            worktree TEXT,
            origin TEXT NOT NULL DEFAULT 'existing',
            position INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            subagent INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_chat_team_member_team ON chat_team_member(team_id, position);",
    )?;
    // Tabela criada antes do interruptor "Subagente": a coluna entra depois, sem apagar nada e sem
    // subir o user_version (como as outras aditivas do banco).
    let has_subagent = conn
        .prepare("SELECT 1 FROM pragma_table_info('chat_team_member') WHERE name = 'subagent'")?
        .exists([])?;
    if !has_subagent {
        conn.execute("ALTER TABLE chat_team_member ADD COLUMN subagent INTEGER NOT NULL DEFAULT 0", [])?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRow {
    pub id: String,
    /// A conversa que coordena: o id da aba ou `thread:<id>`.
    pub orchestrator: String,
    pub agent_id: String,
    pub label: String,
    pub cwd: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    pub team_id: String,
    /// O id da aba ou `thread:<id>`.
    pub member: String,
    pub agent_id: String,
    pub label: String,
    /// O id do papel (`frontend`, `qa`…, ver `model::TEAM_ROLES`).
    pub role: String,
    pub model: Option<String>,
    pub policy: Policy,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    /// `new` (aberto pelo time) ou `existing` (uma conversa que já existia).
    pub origin: String,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Marcado como subagente: apoio que executa o que o orquestrador envia (o mesmo interruptor do canvas).
    pub subagent: bool,
}

/// O que se grava ao ligar alguém.
#[derive(Clone, Debug, Default)]
pub struct NewMember {
    pub member: String,
    pub agent_id: String,
    pub label: String,
    pub role: String,
    pub model: Option<String>,
    pub policy: Option<Policy>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub origin: String,
    /// `None` = não disse: nasce como não subagente e, se já estava no time, fica como está.
    pub subagent: Option<bool>,
}

/// O que muda num integrante já ligado (`None` = fica como está).
#[derive(Clone, Debug, Default)]
pub struct MemberPatch {
    pub role: Option<String>,
    pub policy: Option<Policy>,
    pub label: Option<String>,
    pub model: Option<Option<String>>,
    pub branch: Option<Option<String>>,
    pub subagent: Option<bool>,
}

const TEAM_COLUMNS: &str = "id, orchestrator, agent_id, label, cwd, title, created_at, updated_at";
const MEMBER_COLUMNS: &str = "team_id, member, agent_id, label, role, model, policy, branch, worktree, origin, position, created_at, updated_at, subagent";

fn team_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TeamRow> {
    Ok(TeamRow {
        id: r.get(0)?,
        orchestrator: r.get(1)?,
        agent_id: r.get(2)?,
        label: r.get(3)?,
        cwd: r.get(4)?,
        title: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

fn member_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemberRow> {
    let policy: String = r.get(6)?;
    Ok(MemberRow {
        team_id: r.get(0)?,
        member: r.get(1)?,
        agent_id: r.get(2)?,
        label: r.get(3)?,
        role: r.get(4)?,
        model: r.get(5)?,
        // O CHECK da tabela garante um dos quatro; lixo antigo vira o mais restrito.
        policy: Policy::parse(&policy).unwrap_or(Policy::Read),
        branch: r.get(7)?,
        worktree: r.get(8)?,
        origin: r.get(9)?,
        position: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        subagent: r.get::<_, i64>(13)? != 0,
    })
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn insert_team(conn: &Connection, row: &TeamRow) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    conn.execute(
        &format!("INSERT INTO chat_team ({TEAM_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"),
        params![row.id, row.orchestrator, row.agent_id, row.label, row.cwd, row.title, row.created_at, row.updated_at],
    )
    .map_err(err)?;
    Ok(())
}

pub fn team(conn: &Connection, id: &str) -> Result<Option<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM chat_team WHERE id = ?1"), [id], team_row).optional().map_err(err)
}

pub fn team_led_by(conn: &Connection, orchestrator: &str) -> Result<Option<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM chat_team WHERE orchestrator = ?1"), [orchestrator], team_row)
        .optional()
        .map_err(err)
}

/// O time em que `member` é integrante (não orquestrador).
pub fn team_joined_by(conn: &Connection, member: &str) -> Result<Option<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(
        "SELECT t.id, t.orchestrator, t.agent_id, t.label, t.cwd, t.title, t.created_at, t.updated_at
         FROM chat_team t JOIN chat_team_member m ON m.team_id = t.id WHERE m.member = ?1",
        [member],
        team_row,
    )
    .optional()
    .map_err(err)
}

/// O time de `member`, como orquestrador ou como integrante.
pub fn team_of(conn: &Connection, member: &str) -> Result<Option<TeamRow>, String> {
    match team_led_by(conn, member)? {
        Some(team) => Ok(Some(team)),
        None => team_joined_by(conn, member),
    }
}

pub fn teams(conn: &Connection) -> Result<Vec<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    let mut stmt = conn.prepare(&format!("SELECT {TEAM_COLUMNS} FROM chat_team ORDER BY created_at, id")).map_err(err)?;
    let rows = stmt.query_map([], team_row).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn members(conn: &Connection, team_id: &str) -> Result<Vec<MemberRow>, String> {
    migrate(conn).map_err(err)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {MEMBER_COLUMNS} FROM chat_team_member WHERE team_id = ?1 ORDER BY position, created_at"))
        .map_err(err)?;
    let rows = stmt.query_map([team_id], member_row).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn member(conn: &Connection, member: &str) -> Result<Option<MemberRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {MEMBER_COLUMNS} FROM chat_team_member WHERE member = ?1"), [member], member_row)
        .optional()
        .map_err(err)
}

pub fn insert_member(conn: &Connection, team_id: &str, new: &NewMember, policy: Policy, now: i64) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    let position: i64 = conn
        .query_row("SELECT COALESCE(MAX(position) + 1, 0) FROM chat_team_member WHERE team_id = ?1", [team_id], |r| r.get(0))
        .map_err(err)?;
    conn.execute(
        &format!("INSERT INTO chat_team_member ({MEMBER_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)"),
        params![
            team_id, new.member, new.agent_id, new.label, new.role, new.model, policy.as_str(), new.branch, new.worktree,
            new.origin, position, now, new.subagent.unwrap_or(false)
        ],
    )
    .map_err(err)?;
    touch(conn, team_id, now)
}

pub fn patch_member(conn: &Connection, member: &str, patch: &MemberPatch, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    let Some(before) = self::member(conn, member)? else { return Ok(false) };
    let role = patch.role.clone().unwrap_or(before.role);
    let policy = patch.policy.unwrap_or(before.policy);
    let label = patch.label.clone().unwrap_or(before.label);
    let model = patch.model.clone().unwrap_or(before.model);
    let branch = patch.branch.clone().unwrap_or(before.branch);
    let subagent = patch.subagent.unwrap_or(before.subagent);
    conn.execute(
        "UPDATE chat_team_member SET role = ?1, policy = ?2, label = ?3, model = ?4, branch = ?5, subagent = ?6, updated_at = ?7 WHERE member = ?8",
        params![role, policy.as_str(), label, model, branch, subagent, now, member],
    )
    .map_err(err)?;
    touch(conn, &before.team_id, now)?;
    Ok(true)
}

pub fn delete_member(conn: &Connection, member: &str, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    let Some(before) = self::member(conn, member)? else { return Ok(false) };
    conn.execute("DELETE FROM chat_team_member WHERE member = ?1", [member]).map_err(err)?;
    touch(conn, &before.team_id, now)?;
    Ok(true)
}

/// Desfaz o time (só a pessoa, na tela): os integrantes saem junto. As conversas continuam.
pub fn delete_team(conn: &Connection, team_id: &str) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    conn.execute("DELETE FROM chat_team_member WHERE team_id = ?1", [team_id]).map_err(err)?;
    Ok(conn.execute("DELETE FROM chat_team WHERE id = ?1", [team_id]).map_err(err)? > 0)
}

fn touch(conn: &Connection, team_id: &str, now: i64) -> Result<(), String> {
    conn.execute("UPDATE chat_team SET updated_at = ?1 WHERE id = ?2", params![now, team_id]).map_err(err)?;
    Ok(())
}

/// As conversas por protocolo que estão em algum time (como orquestrador ou integrante): só elas
/// entram no `peer` (ver `ipc/commands/peers.rs::open_tabs`).
pub fn thread_refs(conn: &Connection) -> Result<Vec<String>, String> {
    migrate(conn).map_err(err)?;
    let mut stmt = conn
        .prepare(
            "SELECT orchestrator FROM chat_team WHERE orchestrator LIKE 'thread:%'
             UNION SELECT member FROM chat_team_member WHERE member LIKE 'thread:%'",
        )
        .map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

/// Uma linha da fila de mensagens entre agentes que importa ao fio do orquestrador.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedRow {
    pub id: i64,
    pub kind: String,
    pub from: String,
    pub from_name: String,
    pub to: String,
    pub to_name: String,
    pub text: String,
    pub state: String,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

/// As mensagens entre o orquestrador e os integrantes (`peer_messages`), as mais novas por último.
/// Só leitura: a fila é de `peer_queue`. Sem a tabela (banco sem a fila), vazio.
pub fn feed(conn: &Connection, orchestrator: &str, members: &[String], limit: i64) -> Result<Vec<FeedRow>, String> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='peer_messages')", [], |r| r.get(0))
        .map_err(err)?;
    if !exists || members.is_empty() {
        return Ok(Vec::new());
    }
    let marks = (0..members.len()).map(|i| format!("?{}", i + 3)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, kind, from_tab_id, from_name, to_tab_id, to_name, text, state, created_at, delivered_at FROM (
            SELECT * FROM peer_messages
            WHERE state != 'refused' AND kind IN ('tell','ask','handoff')
              AND ((from_tab_id = ?1 AND to_tab_id IN ({marks})) OR (to_tab_id = ?1 AND from_tab_id IN ({marks})))
            ORDER BY id DESC LIMIT ?2
         ) ORDER BY id"
    );
    let mut values: Vec<rusqlite::types::Value> = vec![orchestrator.to_string().into(), limit.into()];
    values.extend(members.iter().map(|m| rusqlite::types::Value::from(m.clone())));
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values), |r| {
            Ok(FeedRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                from: r.get(2)?,
                from_name: r.get(3)?,
                to: r.get(4)?,
                to_name: r.get(5)?,
                text: r.get(6)?,
                state: r.get(7)?,
                created_at: r.get(8)?,
                delivered_at: r.get(9)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}
