//! O núcleo do time, sobre `&Connection`: criar, ligar, desligar, mudar papel e política, ler o time e
//! o fio de delegações. A tela (`commands`), a CLI e o MCP (`ipc/commands/team.rs`) passam por aqui.
//!
//! As regras que valem para todos:
//! - um agente está em no máximo um time (como orquestrador OU integrante);
//! - o orquestrador não se liga a si mesmo;
//! - um time tem no máximo [`MAX_MEMBERS`] integrantes.
//!
//! O canvas (as cordas que autorizam o `peer`) é do frontend: quem chama pede a ele que aplique o
//! time (`team.sync`), como `peer connect` faz.

use rusqlite::Connection;
use serde::Serialize;

use super::model::{self, Named, Policy, MAX_MEMBERS};
use super::store::{self, FeedRow, MemberPatch, MemberRow, NewMember, TeamRow};

/// O time inteiro, como a tela e `ags team list` mostram.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    #[serde(flatten)]
    pub team: TeamRow,
    pub members: Vec<MemberRow>,
    /// "4 agentes": o orquestrador conta.
    pub headcount: usize,
}

/// Quem vai coordenar.
#[derive(Clone, Debug, Default)]
pub struct NewTeam {
    pub orchestrator: String,
    pub agent_id: String,
    pub label: String,
    pub cwd: String,
    pub title: String,
}

pub fn view(conn: &Connection, team: TeamRow) -> Result<TeamView, String> {
    let members = store::members(conn, &team.id)?;
    Ok(TeamView { headcount: model::headcount(members.len()), members, team })
}

pub fn list(conn: &Connection) -> Result<Vec<TeamView>, String> {
    store::teams(conn)?.into_iter().map(|t| view(conn, t)).collect()
}

/// O time de `member` (orquestrador ou integrante).
pub fn team_of(conn: &Connection, member: &str) -> Result<Option<TeamView>, String> {
    store::team_of(conn, member)?.map(|t| view(conn, t)).transpose()
}

/// O escopo do chat da equipe de um time (`t:<id>`), para as mensagens e as entregas dele
/// (`missions::messages`). `None` = fora de time.
pub fn scope_of(conn: &Connection, member: &str) -> Option<String> {
    store::team_of(conn, member).ok().flatten().map(|t| format!("t:{}", t.id))
}

/// Como o `ags peer` chama o orquestrador (o nome que o integrante precisa digitar): o título da aba, ou
/// o rótulo do time quando é uma conversa por protocolo; sem nenhum dos dois, o agente. Pura.
pub fn peer_name(team_label: &str, title: &str, agent_label: &str, is_thread: bool) -> String {
    let pick = |a: &str, b: &str| if !a.trim().is_empty() { a.trim().to_string() } else { b.trim().to_string() };
    let name = if is_thread { pick(team_label, &pick(title, agent_label)) } else { pick(title, &pick(agent_label, team_label)) };
    if name.is_empty() { "o orquestrador".to_string() } else { name }
}

/// O nome do orquestrador no `ags peer` agora. O rótulo gravado no time é o do momento em que ele foi
/// criado ("Claude Code"), mas a aba se chama "Claude Code — pasta": o integrante que mandava para o
/// rótulo recebia `unknown_target` e a mensagem nunca chegava.
pub fn orchestrator_peer_name(conn: &Connection, team: &TeamRow) -> String {
    let (title, agent_label) = match model::thread_id_of(&team.orchestrator) {
        Some(thread) => {
            let title = crate::conversa::store::thread(conn, thread).ok().flatten().map(|t| t.title).unwrap_or_default();
            (title, crate::agents::agent_label(&team.agent_id).unwrap_or_default().to_string())
        }
        None => conn
            .query_row("SELECT COALESCE(title, ''), agent_label FROM tabs WHERE id = ?1", [&team.orchestrator], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap_or_default(),
    };
    peer_name(&team.label, &title, &agent_label, model::thread_id_of(&team.orchestrator).is_some())
}

/// Faz de `orchestrator` o orquestrador de um time novo. Idempotente: se já coordena um, devolve
/// esse. Recusa quem já é integrante de outro time.
pub fn create(conn: &Connection, input: NewTeam, now: i64) -> Result<(TeamView, bool), String> {
    let orchestrator = input.orchestrator.trim();
    if orchestrator.is_empty() {
        return Err("Falta a conversa do orquestrador.".into());
    }
    if let Some(existing) = store::team_led_by(conn, orchestrator)? {
        return Ok((view(conn, existing)?, false));
    }
    if let Some(other) = store::team_joined_by(conn, orchestrator)? {
        return Err(format!("Esta conversa já é integrante do time de {}: desligue-a de lá antes.", label_or(&other.label, &other.orchestrator)));
    }
    let row = TeamRow {
        id: uuid::Uuid::new_v4().to_string(),
        orchestrator: orchestrator.to_string(),
        agent_id: input.agent_id,
        label: model::clean_label(&input.label),
        cwd: input.cwd,
        title: model::clean_title(&input.title),
        created_at: now,
        updated_at: now,
        auto_decide: true,
        allow_tools: false,
        watch: true,
        watch_stall: false,
    };
    store::insert_team(conn, &row)?;
    Ok((view(conn, row)?, true))
}

fn label_or<'a>(label: &'a str, fallback: &'a str) -> &'a str {
    if label.trim().is_empty() { fallback } else { label }
}

/// Liga `new` ao time. Se já é integrante DESTE time, atualiza papel e política (idempotente).
/// `by_agent`: quem pede é um agente (CLI/MCP), que não aumenta permissão (`model::agent_may_set`).
pub fn link(conn: &Connection, team_id: &str, mut new: NewMember, by_agent: bool, now: i64) -> Result<MemberRow, String> {
    let team = store::team(conn, team_id)?.ok_or("Esse time não existe mais.")?;
    let member = new.member.trim().to_string();
    if member.is_empty() {
        return Err("Falta quem ligar.".into());
    }
    if member == team.orchestrator {
        return Err("O orquestrador não se liga ao próprio time.".into());
    }
    if store::team_led_by(conn, &member)?.is_some() {
        return Err("Esse agente já é orquestrador de outro time.".into());
    }
    let current = store::member(conn, &member)?;
    if current.as_ref().is_some_and(|row| row.team_id != team.id) {
        return Err("Esse agente já está em outro time: desligue-o de lá antes.".into());
    }
    new.role = if new.role.trim().is_empty() { "generalist".into() } else { new.role.trim().to_string() };
    let policy = new.policy.unwrap_or_else(|| current.as_ref().map(|c| c.policy).unwrap_or_else(|| model::default_policy(&new.role)));
    if by_agent {
        model::agent_may_set(current.as_ref().map(|c| c.policy), policy)?;
    }
    if let Some(row) = current {
        let patch = MemberPatch { role: Some(new.role), policy: Some(policy), subagent: new.subagent, ..Default::default() };
        store::patch_member(conn, &row.member, &patch, now)?;
        return store::member(conn, &member)?.ok_or_else(|| "O integrante sumiu.".to_string());
    }
    if store::members(conn, &team.id)?.len() >= MAX_MEMBERS {
        return Err(format!("O time já tem {MAX_MEMBERS} integrantes: desligue alguém antes."));
    }
    new.member = member.clone();
    new.label = model::clean_label(&new.label);
    if new.origin.is_empty() {
        new.origin = "existing".into();
    }
    store::insert_member(conn, &team.id, &new, policy, now)?;
    store::member(conn, &member)?.ok_or_else(|| "O integrante não foi gravado.".to_string())
}

/// Desliga um integrante. `false` = não estava no time.
pub fn unlink(conn: &Connection, team_id: &str, member: &str, now: i64) -> Result<bool, String> {
    match store::member(conn, member)? {
        Some(row) if row.team_id == team_id => store::delete_member(conn, member, now),
        _ => Ok(false),
    }
}

/// Muda papel, política, nome, modelo ou branch de um integrante do time.
pub fn update(conn: &Connection, team_id: &str, member: &str, patch: MemberPatch, by_agent: bool, now: i64) -> Result<MemberRow, String> {
    let row = store::member(conn, member)?.filter(|r| r.team_id == team_id).ok_or("Esse agente não está neste time.")?;
    if let (true, Some(policy)) = (by_agent, patch.policy) {
        model::agent_may_set(Some(row.policy), policy)?;
    }
    store::patch_member(conn, member, &patch, now)?;
    store::member(conn, member)?.ok_or_else(|| "O integrante sumiu.".to_string())
}

/// Os nomes dos integrantes para os textos dos agentes. `name_of` dá o nome atual (o título da aba ou
/// da conversa); sem ele, o rótulo gravado.
pub fn roster_notice(team: &TeamView, name_of: impl Fn(&str) -> Option<String>, role_label: impl Fn(&str) -> String) -> String {
    let names: Vec<(String, String, String, Policy, Option<String>, bool)> = team
        .members
        .iter()
        .map(|m| {
            let name = name_of(&m.member).unwrap_or_else(|| label_or(&m.label, &m.member).to_string());
            (name, m.agent_id.clone(), role_label(&m.role), m.policy, m.branch.clone(), m.subagent)
        })
        .collect();
    let named: Vec<Named<'_>> = names
        .iter()
        .map(|(name, agent, role, policy, branch, subagent)| Named { name, agent, role, policy: *policy, branch: branch.as_deref(), subagent: *subagent })
        .collect();
    model::roster_notice(&named)
}

/// Uma delegação ou uma entrega, como o fio do orquestrador mostra.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: i64,
    /// `delegation` (o orquestrador pediu), `delivery` (a entrega final, Handoff v1) ou `reply` (um
    /// integrante avisou ou respondeu).
    pub kind: &'static str,
    pub member: String,
    pub member_name: String,
    /// A linha `Tarefa:` do envelope, ou o começo do texto.
    pub task: String,
    /// O estado na fila (`queued`, `delivering`, `delivered`, `unconfirmed`…).
    pub state: String,
    pub at: i64,
    /// O número da entrega (`ENTREGA #id`), para ler o Handoff inteiro.
    pub handoff: Option<i64>,
}

/// O fio do time: delegações do orquestrador e o que volta dos integrantes. Pura sobre as linhas.
pub fn feed_items(orchestrator: &str, rows: &[FeedRow]) -> Vec<FeedItem> {
    rows.iter()
        .map(|r| {
            let outgoing = r.from == orchestrator;
            let kind = if outgoing { "delegation" } else if r.kind == "handoff" { "delivery" } else { "reply" };
            let (member, member_name) = if outgoing { (&r.to, &r.to_name) } else { (&r.from, &r.from_name) };
            FeedItem {
                id: r.id,
                kind,
                member: member.clone(),
                member_name: member_name.clone(),
                task: crate::peer_queue::store::task_gist(&r.text),
                state: r.state.clone(),
                at: r.delivered_at.unwrap_or(r.created_at),
                handoff: (r.kind == "handoff").then(|| handoff_number(&r.text)).flatten(),
            }
        })
        .collect()
}

/// O número de `ENTREGA #<id>: ...`. Pura.
pub fn handoff_number(line: &str) -> Option<i64> {
    let rest = line.trim_start().strip_prefix("ENTREGA #")?;
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

pub fn feed(conn: &Connection, team: &TeamView, limit: i64) -> Result<Vec<FeedItem>, String> {
    let members: Vec<String> = team.members.iter().map(|m| m.member.clone()).collect();
    let rows = store::feed(conn, &team.team.orchestrator, &members, limit)?;
    Ok(feed_items(&team.team.orchestrator, &rows))
}
