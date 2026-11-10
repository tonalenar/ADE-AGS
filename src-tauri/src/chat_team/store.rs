//! As tabelas do time (`chat_team` e `chat_team_member`): SQL puro sobre `&Connection`.
//!
//! A migração é só aditiva e idempotente (`CREATE … IF NOT EXISTS`) e roda sob demanda, como a do chat
//! da equipe (`missions::messages`): não sobe `user_version` nem toca as outras tabelas. Uma linha só
//! sai daqui quando a pessoa desliga um integrante ou desfaz o time.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::model::Policy;
use super::permission::{Kind, Rule};

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
    // O interruptor «não decidir sozinho» do time (1 = o backend decide o que a política e as regras cobrem).
    let has_auto = conn.prepare("SELECT 1 FROM pragma_table_info('chat_team') WHERE name = 'auto_decide'")?.exists([])?;
    if !has_auto {
        conn.execute("ALTER TABLE chat_team ADD COLUMN auto_decide INTEGER NOT NULL DEFAULT 1", [])?;
    }
    // O acesso total libera ferramentas de fora do shell (MCP, Task…)? Desligado por padrão: só a pessoa liga.
    let has_tools = conn.prepare("SELECT 1 FROM pragma_table_info('chat_team') WHERE name = 'allow_tools'")?.exists([])?;
    if !has_tools {
        conn.execute("ALTER TABLE chat_team ADD COLUMN allow_tools INTEGER NOT NULL DEFAULT 0", [])?;
    }
    // O vigia do chat: `watch` avisa o orquestrador dos bloqueios dos integrantes (ligado por padrão) e `watch_stall`
    // do «sem progresso» (desligado, como o Vigia das missões). Aditivas: nenhuma linha se perde.
    for (column, default) in [("watch", 1), ("watch_stall", 0)] {
        let has = conn.prepare("SELECT 1 FROM pragma_table_info('chat_team') WHERE name = ?1")?.exists([column])?;
        if !has {
            conn.execute(&format!("ALTER TABLE chat_team ADD COLUMN {column} INTEGER NOT NULL DEFAULT {default}"), [])?;
        }
    }
    // De onde o time nasceu (`chat`, `canvas` ou `mission`), onde mora a coroa dele (`board_key`: pasta, `#c:` ou
    // `#m:`) e a missão espelhada (`mission_id`, só `origin = 'mission'`). Aditivas e protegidas por `has_column`:
    // as linhas antigas ficam `origin = 'chat'`, nada se apaga e o user_version não sobe.
    for (column, ddl) in [
        ("origin", "TEXT NOT NULL DEFAULT 'chat'"),
        ("board_key", "TEXT"),
        ("mission_id", "TEXT"),
    ] {
        if !has_column(conn, "chat_team", column)? {
            conn.execute(&format!("ALTER TABLE chat_team ADD COLUMN {column} {ddl}"), [])?;
        }
    }
    // As regras «Sempre permitir», criadas SÓ pela pessoa (tela). `role` e `team_id` estão preparados e ainda
    // não se avaliam (`permission::auto_allow_rule`).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_permission_rule (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('command','edit','network')),
            pattern TEXT NOT NULL,
            agent_id TEXT,
            role TEXT,
            team_id TEXT,
            origin TEXT NOT NULL DEFAULT 'person' CHECK(origin IN ('person')),
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            uses INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_chat_permission_rule_lookup ON chat_permission_rule(kind, agent_id, role);
        CREATE TABLE IF NOT EXISTS chat_permission_import (id INTEGER PRIMARY KEY CHECK(id = 1), at INTEGER NOT NULL);",
    )?;
    import_legacy_rules(conn)?;
    // O integrante novo gravado ANTES de abrir a conversa e o worktree (`provisioning`), reconciliado no
    // boot para `active` ou `failed` (ver `api::reconcile_provisions`). Aditiva; nenhuma linha se perde: a
    // linha falha fica, com o motivo e o worktree que sobrou.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_team_provision (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES chat_team(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            member TEXT,
            worktree TEXT,
            branch TEXT,
            state TEXT NOT NULL DEFAULT 'provisioning' CHECK(state IN ('provisioning','active','failed')),
            failure TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_team_provision_team ON chat_team_provision(team_id, state);",
    )?;
    let has_owner = conn
        .prepare("SELECT 1 FROM pragma_table_info('chat_team_provision') WHERE name = 'owner_instance'")?
        .exists([])?;
    if !has_owner {
        conn.execute_batch("ALTER TABLE chat_team_provision ADD COLUMN owner_instance TEXT;")?;
    }
    Ok(())
}

/// A coluna existe na tabela? (a base das migrações aditivas deste módulo)
pub fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")?.exists([table, column])
}

/// Uma vez só: copia as regras que a tela guardava nos settings (`chat.permissions.rules`) para a tabela. NÃO
/// apaga o setting (volta atrás é possível) e não se repete (a pessoa pode apagar tudo depois). Tolerante: sem a
/// tabela `settings`, sem a chave ou com JSON quebrado, só marca como feito.
fn import_legacy_rules(conn: &Connection) -> rusqlite::Result<()> {
    if conn.prepare("SELECT 1 FROM chat_permission_import WHERE id = 1")?.exists([])? {
        return Ok(());
    }
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'chat.permissions.rules'", [], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    for rule in legacy_rules(raw.as_deref().unwrap_or("")) {
        conn.execute(
            "INSERT OR IGNORE INTO chat_permission_rule (id, kind, pattern, agent_id, role, team_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5)",
            params![rule.id, kind_name(rule.kind), rule.pattern, rule.agent_id, rule.created_at],
        )?;
    }
    conn.execute("INSERT OR IGNORE INTO chat_permission_import (id, at) VALUES (1, strftime('%s','now') * 1000)", [])?;
    Ok(())
}

/// Pura: as regras do JSON antigo, tolerando lixo (como `parseRules` do front). Regra sem id, tipo ou padrão sai.
pub fn legacy_rules(raw: &str) -> Vec<Rule> {
    let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    list.iter()
        .filter_map(|r| {
            let kind = match r.get("kind")?.as_str()? {
                "command" => Kind::Command,
                "edit" => Kind::Edit,
                "network" => Kind::Network,
                _ => return None,
            };
            let pattern = r.get("pattern")?.as_str()?.trim().to_string();
            let id = r.get("id")?.as_str()?.to_string();
            if pattern.is_empty() || id.is_empty() {
                return None;
            }
            Some(Rule {
                id,
                kind,
                pattern,
                agent_id: r.get("agentId").and_then(|a| a.as_str()).map(str::to_string),
                role: None,
                team_id: None,
                created_at: r.get("createdAt").and_then(|c| c.as_i64()).unwrap_or(0),
            })
        })
        .collect()
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Command => "command",
        Kind::Edit => "edit",
        Kind::Network => "network",
    }
}

fn kind_of(raw: &str) -> Kind {
    match raw {
        "edit" => Kind::Edit,
        "network" => Kind::Network,
        _ => Kind::Command,
    }
}

const RULE_COLUMNS: &str = "id, kind, pattern, agent_id, role, team_id, created_at";

fn rule_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Rule> {
    let kind: String = r.get(1)?;
    Ok(Rule { id: r.get(0)?, kind: kind_of(&kind), pattern: r.get(2)?, agent_id: r.get(3)?, role: r.get(4)?, team_id: r.get(5)?, created_at: r.get(6)? })
}

/// Todas as regras, da mais antiga para a mais nova.
pub fn rules(conn: &Connection) -> Result<Vec<Rule>, String> {
    migrate(conn).map_err(err)?;
    let mut stmt = conn.prepare(&format!("SELECT {RULE_COLUMNS} FROM chat_permission_rule ORDER BY created_at, id")).map_err(err)?;
    let rows = stmt.query_map([], rule_row).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows)
}

/// Cria uma regra. SÓ a tela (a pessoa) chama isto: nenhum comando de CLI/MCP escreve regras. A mesma regra
/// (tipo, padrão, agente) não se repete: devolve a que já existe.
pub fn add_rule(conn: &Connection, kind: Kind, pattern: &str, agent_id: Option<&str>, now: i64) -> Result<Rule, String> {
    migrate(conn).map_err(err)?;
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err("A regra precisa de um padrão.".into());
    }
    let agent_id = agent_id.filter(|a| !a.is_empty());
    let existing = conn
        .query_row(
            &format!("SELECT {RULE_COLUMNS} FROM chat_permission_rule WHERE kind = ?1 AND pattern = ?2 AND agent_id IS ?3 AND role IS NULL AND team_id IS NULL"),
            params![kind_name(kind), pattern, agent_id],
            rule_row,
        )
        .optional()
        .map_err(err)?;
    if let Some(found) = existing {
        return Ok(found);
    }
    let id = format!("rule-{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO chat_permission_rule (id, kind, pattern, agent_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, kind_name(kind), pattern, agent_id, now],
    )
    .map_err(err)?;
    Ok(Rule { id, kind, pattern: pattern.to_string(), agent_id: agent_id.map(str::to_string), role: None, team_id: None, created_at: now })
}

/// Muda o padrão e/ou o agente de uma regra (`Some(None)` = qualquer agente). `false` se a regra não existe.
pub fn update_rule(conn: &Connection, id: &str, pattern: Option<&str>, agent_id: Option<Option<&str>>) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    let mut changed = false;
    if let Some(pattern) = pattern.map(str::trim).filter(|p| !p.is_empty()) {
        changed |= conn.execute("UPDATE chat_permission_rule SET pattern = ?1 WHERE id = ?2", params![pattern, id]).map_err(err)? > 0;
    }
    if let Some(agent) = agent_id {
        changed |= conn.execute("UPDATE chat_permission_rule SET agent_id = ?1 WHERE id = ?2", params![agent.filter(|a| !a.is_empty()), id]).map_err(err)? > 0;
    }
    Ok(changed)
}

pub fn remove_rule(conn: &Connection, id: &str) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("DELETE FROM chat_permission_rule WHERE id = ?1", [id]).map_err(err)? > 0)
}

/// A regra liberou um pedido: a tela mostra o que cada regra já fez (auditoria).
pub fn count_rule_use(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    conn.execute("UPDATE chat_permission_rule SET uses = uses + 1, last_used_at = ?1 WHERE id = ?2", params![now, id]).map_err(err)?;
    Ok(())
}

/// Liga ou desliga o «acesso total libera ferramentas de fora do shell» do time. SÓ a pessoa, pela tela.
pub fn set_allow_tools(conn: &Connection, team_id: &str, enabled: bool) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("UPDATE chat_team SET allow_tools = ?1 WHERE id = ?2", params![enabled as i64, team_id]).map_err(err)? > 0)
}

/// Liga ou desliga os avisos de bloqueio do vigia do chat. SÓ a pessoa, pela tela.
pub fn set_watch(conn: &Connection, team_id: &str, enabled: bool) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("UPDATE chat_team SET watch = ?1 WHERE id = ?2", params![enabled as i64, team_id]).map_err(err)? > 0)
}

/// Liga ou desliga o aviso de «sem progresso» do vigia do chat. SÓ a pessoa, pela tela.
pub fn set_watch_stall(conn: &Connection, team_id: &str, enabled: bool) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("UPDATE chat_team SET watch_stall = ?1 WHERE id = ?2", params![enabled as i64, team_id]).map_err(err)? > 0)
}

/// Liga ou desliga o «decidir sozinho» do time. `false` se o time não existe.
pub fn set_auto_decide(conn: &Connection, team_id: &str, enabled: bool) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("UPDATE chat_team SET auto_decide = ?1 WHERE id = ?2", params![enabled as i64, team_id]).map_err(err)? > 0)
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
    /// O backend decide sozinho o que a política e as regras da pessoa cobrem. Desligado (`false`), tudo vai à pessoa.
    pub auto_decide: bool,
    /// O acesso total libera ferramentas de fora do shell (desligado por padrão).
    pub allow_tools: bool,
    /// O vigia do chat avisa o orquestrador dos bloqueios dos integrantes (padrão: ligado).
    pub watch: bool,
    /// ...e do «sem progresso» (padrão: desligado).
    pub watch_stall: bool,
    /// De onde o time nasceu: [`ORIGIN_CHAT`], [`ORIGIN_CANVAS`] ou [`ORIGIN_MISSION`].
    pub origin: String,
    /// Onde mora a coroa dele no canvas (a chave do quadro: pasta, `#c:` ou `#m:`), quando se sabe.
    pub board_key: Option<String>,
    /// A missão que a linha espelha (só `origin = 'mission'`).
    pub mission_id: Option<String>,
}

pub const ORIGIN_CHAT: &str = "chat";
pub const ORIGIN_CANVAS: &str = "canvas";
pub const ORIGIN_MISSION: &str = "mission";

/// O orquestrador de um time sem orquestrador fica gravado como `none:<id do time>`: a coluna é
/// `NOT NULL UNIQUE` (e não dá para afrouxar sem recriar a tabela), então cada time ganha um valor
/// próprio que nunca é uma conversa. Para fora (`TeamRow`, CLI, tela) ele é a string vazia.
const NO_ORCHESTRATOR: &str = "none:";

fn stored_orchestrator(team_id: &str, orchestrator: &str) -> String {
    if orchestrator.is_empty() { format!("{NO_ORCHESTRATOR}{team_id}") } else { orchestrator.to_string() }
}

fn shown_orchestrator(stored: String) -> String {
    if stored.starts_with(NO_ORCHESTRATOR) { String::new() } else { stored }
}

impl TeamRow {
    /// O time tem quem o coordene? (a coroa tirada no canvas deixa o time sem orquestrador)
    pub fn led(&self) -> bool {
        !self.orchestrator.is_empty()
    }
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

const TEAM_COLUMNS: &str = "id, orchestrator, agent_id, label, cwd, title, created_at, updated_at, auto_decide, allow_tools, watch, watch_stall, origin, board_key, mission_id";
const MEMBER_COLUMNS: &str = "team_id, member, agent_id, label, role, model, policy, branch, worktree, origin, position, created_at, updated_at, subagent";

fn team_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TeamRow> {
    Ok(TeamRow {
        id: r.get(0)?,
        orchestrator: shown_orchestrator(r.get(1)?),
        agent_id: r.get(2)?,
        label: r.get(3)?,
        cwd: r.get(4)?,
        title: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        auto_decide: r.get::<_, i64>(8)? != 0,
        allow_tools: r.get::<_, i64>(9)? != 0,
        watch: r.get::<_, i64>(10)? != 0,
        watch_stall: r.get::<_, i64>(11)? != 0,
        origin: r.get(12)?,
        board_key: r.get(13)?,
        mission_id: r.get(14)?,
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
        &format!("INSERT INTO chat_team ({TEAM_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"),
        params![
            row.id, stored_orchestrator(&row.id, &row.orchestrator), row.agent_id, row.label, row.cwd, row.title, row.created_at, row.updated_at,
            row.auto_decide as i64, row.allow_tools as i64, row.watch as i64, row.watch_stall as i64, row.origin, row.board_key, row.mission_id
        ],
    )
    .map_err(err)?;
    Ok(())
}

pub fn team(conn: &Connection, id: &str) -> Result<Option<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM chat_team WHERE id = ?1"), [id], team_row).optional().map_err(err)
}

pub fn team_led_by(conn: &Connection, orchestrator: &str) -> Result<Option<TeamRow>, String> {
    if orchestrator.is_empty() {
        return Ok(None);
    }
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM chat_team WHERE orchestrator = ?1"), [orchestrator], team_row)
        .optional()
        .map_err(err)
}

/// O time em que `member` é integrante (não orquestrador).
pub fn team_joined_by(conn: &Connection, member: &str) -> Result<Option<TeamRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(
        "SELECT t.id, t.orchestrator, t.agent_id, t.label, t.cwd, t.title, t.created_at, t.updated_at, t.auto_decide, t.allow_tools, t.watch, t.watch_stall, t.origin, t.board_key, t.mission_id
         FROM chat_team t JOIN chat_team_member m ON m.team_id = t.id WHERE m.member = ?1",
        [member],
        team_row,
    )
    .optional()
    .map_err(err)
}

/// O time de `member`, como orquestrador ou como integrante, **incluindo** a linha-espelho de uma missão.
/// Serve para o invariante "um agente em um time só"; o comportamento (escopo do chat, política, alias de
/// peer) usa [`team_of`], que não enxerga o espelho.
pub fn team_of_any(conn: &Connection, member: &str) -> Result<Option<TeamRow>, String> {
    match team_led_by(conn, member)? {
        Some(team) => Ok(Some(team)),
        None => team_joined_by(conn, member),
    }
}

/// O time do modo chat de `member` (orquestrador ou integrante). A linha-espelho de uma missão
/// (`origin = 'mission'`) NÃO conta: a missão é dona do motor, do chat da equipe (`m:<id>`) e do vigia,
/// e o espelho existe só para o chat mostrá-la.
pub fn team_of(conn: &Connection, member: &str) -> Result<Option<TeamRow>, String> {
    Ok(team_of_any(conn, member)?.filter(|t| t.origin != ORIGIN_MISSION))
}

/// A linha-espelho de uma missão.
pub fn team_of_mission(conn: &Connection, mission_id: &str) -> Result<Option<TeamRow>, String> {
    if mission_id.is_empty() {
        return Ok(None);
    }
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM chat_team WHERE origin = 'mission' AND mission_id = ?1"), [mission_id], team_row)
        .optional()
        .map_err(err)
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

/// Tira o orquestrador do time (a coroa saiu do canvas): o time e os integrantes ficam. `false` = o time não
/// existe ou já estava sem orquestrador.
pub fn clear_orchestrator(conn: &Connection, team_id: &str, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn
        .execute(
            "UPDATE chat_team SET orchestrator = ?2, updated_at = ?3 WHERE id = ?1 AND orchestrator NOT LIKE 'none:%'",
            params![team_id, stored_orchestrator(team_id, ""), now],
        )
        .map_err(err)?
        > 0)
}

/// Dá um orquestrador a um time que não tem (ou troca o dele). Quem chama já conferiu o invariante.
pub fn set_orchestrator(conn: &Connection, team_id: &str, orchestrator: &str, agent_id: &str, label: &str, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn
        .execute(
            "UPDATE chat_team SET orchestrator = ?2, agent_id = ?3, label = ?4, updated_at = ?5 WHERE id = ?1",
            params![team_id, stored_orchestrator(team_id, orchestrator), agent_id, label, now],
        )
        .map_err(err)?
        > 0)
}

/// Guarda onde mora a coroa do time no canvas.
pub fn set_board_key(conn: &Connection, team_id: &str, board_key: Option<&str>, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    Ok(conn.execute("UPDATE chat_team SET board_key = ?2, updated_at = ?3 WHERE id = ?1", params![team_id, board_key, now]).map_err(err)? > 0)
}

/// Troca a ref de uma conversa (o id da aba ou `thread:<id>`) no roster: como orquestrador e como integrante.
/// Devolve o time e o que mudou. `None` = a ref antiga não estava em time nenhum.
pub fn rebind(conn: &Connection, old: &str, new: &str, now: i64) -> Result<Option<(String, &'static str)>, String> {
    migrate(conn).map_err(err)?;
    conn.execute("UPDATE chat_team_provision SET member = ?2 WHERE member = ?1", params![old, new]).map_err(err)?;
    if let Some(team) = team_led_by(conn, old)? {
        conn.execute("UPDATE chat_team SET orchestrator = ?2, updated_at = ?3 WHERE id = ?1", params![team.id, new, now]).map_err(err)?;
        return Ok(Some((team.id, "orchestrator")));
    }
    if let Some(row) = member(conn, old)? {
        conn.execute("UPDATE chat_team_member SET member = ?2, updated_at = ?3 WHERE member = ?1", params![old, new, now]).map_err(err)?;
        touch(conn, &row.team_id, now)?;
        return Ok(Some((row.team_id, "member")));
    }
    Ok(None)
}

/// Desfaz o time (só a pessoa, na tela): os integrantes saem junto. As conversas continuam.
pub fn delete_team(conn: &Connection, team_id: &str) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    conn.execute("DELETE FROM chat_team_member WHERE team_id = ?1", [team_id]).map_err(err)?;
    conn.execute("DELETE FROM chat_team_provision WHERE team_id = ?1", [team_id]).map_err(err)?;
    Ok(conn.execute("DELETE FROM chat_team WHERE id = ?1", [team_id]).map_err(err)? > 0)
}

/// Um integrante novo, do momento em que a pessoa pediu até entrar no time.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionRow {
    pub id: String,
    pub team_id: String,
    /// O nome dele no time, único entre todos os que o time já teve.
    pub label: String,
    pub agent_id: String,
    pub role: String,
    /// A conversa aberta para ele (id da aba ou `thread:<id>`), quando chegou a abrir.
    pub member: Option<String>,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    /// `provisioning`, `active` ou `failed`.
    pub state: String,
    pub failure: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const PROVISION_COLUMNS: &str = "id, team_id, label, agent_id, role, member, worktree, branch, state, failure, created_at, updated_at";

fn provision_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProvisionRow> {
    Ok(ProvisionRow {
        id: r.get(0)?,
        team_id: r.get(1)?,
        label: r.get(2)?,
        agent_id: r.get(3)?,
        role: r.get(4)?,
        member: r.get(5)?,
        worktree: r.get(6)?,
        branch: r.get(7)?,
        state: r.get(8)?,
        failure: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

pub fn insert_provision(conn: &Connection, row: &ProvisionRow) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    conn.execute(
        &format!("INSERT INTO chat_team_provision ({PROVISION_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"),
        params![row.id, row.team_id, row.label, row.agent_id, row.role, row.member, row.worktree, row.branch, row.state, row.failure, row.created_at, row.updated_at],
    )
    .map_err(err)?;
    Ok(())
}

pub fn provision(conn: &Connection, id: &str) -> Result<Option<ProvisionRow>, String> {
    migrate(conn).map_err(err)?;
    conn.query_row(&format!("SELECT {PROVISION_COLUMNS} FROM chat_team_provision WHERE id = ?1"), [id], provision_row).optional().map_err(err)
}

/// As do time, ou (sem `team_id`) as que ainda estão `provisioning` em qualquer time.
pub fn provisions(conn: &Connection, team_id: Option<&str>) -> Result<Vec<ProvisionRow>, String> {
    migrate(conn).map_err(err)?;
    let sql = format!(
        "SELECT {PROVISION_COLUMNS} FROM chat_team_provision
         WHERE (?1 IS NOT NULL AND team_id = ?1) OR (?1 IS NULL AND state = 'provisioning') ORDER BY created_at, id"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt.query_map([team_id], provision_row).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

/// Muda o estado de uma em `provisioning` (as decididas não voltam atrás). `false` = não mudou.
pub fn settle_provision(conn: &Connection, id: &str, state: &str, member: Option<&str>, failure: Option<&str>, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(err)?;
    let failure: Option<String> = failure.map(|f| f.chars().take(500).collect());
    Ok(conn
        .execute(
            "UPDATE chat_team_provision SET state = ?2, member = COALESCE(?3, member), failure = ?4, updated_at = ?5 WHERE id = ?1 AND state = 'provisioning'",
            params![id, state, member, failure, now],
        )
        .map_err(err)?
        > 0)
}

/// Anota o worktree criado para ela (a conversa ainda vai abrir).
pub fn provision_place(conn: &Connection, id: &str, worktree: Option<&str>, branch: Option<&str>, now: i64) -> Result<(), String> {
    migrate(conn).map_err(err)?;
    conn.execute(
        "UPDATE chat_team_provision SET worktree = ?2, branch = ?3, updated_at = ?4 WHERE id = ?1 AND state = 'provisioning'",
        params![id, worktree, branch, now],
    )
    .map_err(err)?;
    Ok(())
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
