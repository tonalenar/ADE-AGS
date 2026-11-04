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
use super::store::{self, FeedRow, MemberPatch, MemberRow, NewMember, ProvisionRow, TeamRow};

/// O time inteiro, como a tela e `ags team list` mostram.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    #[serde(flatten)]
    pub team: TeamRow,
    pub members: Vec<MemberRow>,
    /// "4 agentes": o orquestrador conta.
    pub headcount: usize,
    /// Os integrantes novos que ainda não entraram (`provisioning`) ou que não chegaram a entrar (`failed`).
    pub provisions: Vec<ProvisionRow>,
}

/// Quem vai coordenar.
#[derive(Clone, Debug, Default)]
pub struct NewTeam {
    pub orchestrator: String,
    pub agent_id: String,
    pub label: String,
    pub cwd: String,
    pub title: String,
    /// `chat` (padrão), `canvas` ou `mission`.
    pub origin: Option<String>,
    pub board_key: Option<String>,
    pub mission_id: Option<String>,
}

pub fn view(conn: &Connection, team: TeamRow) -> Result<TeamView, String> {
    let members = store::members(conn, &team.id)?;
    let provisions = store::provisions(conn, Some(&team.id))?.into_iter().filter(|p| p.state != "active").collect();
    Ok(TeamView { headcount: model::headcount(members.len()), members, team, provisions })
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
        origin: input.origin.filter(|o| matches!(o.as_str(), store::ORIGIN_CHAT | store::ORIGIN_CANVAS | store::ORIGIN_MISSION)).unwrap_or_else(|| store::ORIGIN_CHAT.to_string()),
        board_key: input.board_key.filter(|k| !k.trim().is_empty()),
        mission_id: input.mission_id.filter(|k| !k.trim().is_empty()),
    };
    store::insert_team(conn, &row)?;
    Ok((view(conn, row)?, true))
}

/// O que a promoção de uma coroa do canvas devolve.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Promoted {
    pub team: TeamView,
    /// `true` = o time nasceu agora; `false` = a coroa já liderava um (ou assumiu um sem orquestrador).
    pub created: bool,
    /// Os cordados que entraram agora.
    pub adopted: Vec<String>,
    /// Os que ficaram de fora e por quê (já são de outro time ou de uma missão).
    pub skipped: Vec<Skipped>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Skipped {
    pub member: String,
    pub reason: String,
}

/// O que a promoção recebe: a coroa do canvas e os agentes ligados a ela por corda.
#[derive(Clone, Debug, Default)]
pub struct Promotion {
    pub team: NewTeam,
    /// Os cordados, já com papel e subagente lidos do quadro.
    pub members: Vec<NewMember>,
}

/// Promove uma coroa do canvas a time do chat. **Só linhas no banco**: nunca abre processo, PTY nem worktree
/// (a corda já existe; o time só a reflete). Idempotente. Regras:
/// - a coroa que já lidera um time devolve esse (e liga os cordados que faltam);
/// - se a coroa é integrante de um time **sem orquestrador**, ou algum cordado é, o time continua e ela assume
///   (é assim que o time sobrevive à coroa tirada e "recebe outro");
/// - quem já é de outro time (ou de uma missão: `mission_refs`) fica de fora, sem derrubar o resto.
pub fn promote(conn: &Connection, promotion: Promotion, mission_refs: &std::collections::HashSet<String>, now: i64) -> Result<Promoted, String> {
    let mut input = promotion.team;
    let orchestrator = input.orchestrator.trim().to_string();
    if orchestrator.is_empty() {
        return Err("Falta a conversa do orquestrador.".into());
    }
    if mission_refs.contains(&orchestrator) {
        return Err("Esta conversa é de uma missão: o time dela é o da missão.".into());
    }
    input.origin = Some(store::ORIGIN_CANVAS.into());
    let orphan_of = |member: &str| -> Result<Option<TeamRow>, String> { Ok(store::team_joined_by(conn, member)?.filter(|t| !t.led())) };
    let (view, created) = if let Some(existing) = store::team_led_by(conn, &orchestrator)? {
        (view(conn, existing)?, false)
    } else if let Some(orphan) = match orphan_of(&orchestrator)? {
        Some(t) => Some(t),
        None => {
            let mut found = None;
            for m in &promotion.members {
                if let Some(t) = orphan_of(m.member.trim())? {
                    found = Some(t);
                    break;
                }
            }
            found
        }
    } {
        (lead(conn, &orphan.id, &orchestrator, &input.agent_id, &input.label, now)?, false)
    } else {
        let (v, c) = create(conn, input.clone(), now)?;
        (v, c)
    };
    let team_id = view.team.id.clone();
    if created {
        // A coroa nasceu num quadro: guarda a chave, sem tocar em mais nada.
        if let Some(key) = input.board_key.as_deref() {
            store::set_board_key(conn, &team_id, Some(key), now)?;
        }
    } else if view.team.board_key.is_none()
        && let Some(key) = input.board_key.as_deref()
    {
        store::set_board_key(conn, &team_id, Some(key), now)?;
    }
    let (mut adopted, mut skipped) = (Vec::new(), Vec::new());
    for mut member in promotion.members {
        let id = member.member.trim().to_string();
        if id.is_empty() || id == orchestrator {
            continue;
        }
        if mission_refs.contains(&id) {
            skipped.push(Skipped { member: id, reason: "é de uma missão".into() });
            continue;
        }
        if member.origin.is_empty() {
            member.origin = "existing".into();
        }
        let already = store::member(conn, &id)?.is_some_and(|m| m.team_id == team_id);
        match link(conn, &team_id, member, false, now) {
            Ok(_) if already => {}
            Ok(_) => adopted.push(id),
            Err(reason) => skipped.push(Skipped { member: id, reason }),
        }
    }
    let view = view_by_id(conn, &team_id)?;
    Ok(Promoted { team: view, created, adopted, skipped })
}

/// O que o espelho de uma missão recebe: o orquestrador (a aba do lead) e os integrantes abertos.
#[derive(Clone, Debug, Default)]
pub struct MissionMirror {
    pub team: NewTeam,
    pub members: Vec<NewMember>,
}

/// O que `mirror_mission` devolve.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirrored {
    pub team: TeamView,
    /// Os que não entraram no espelho e por quê (já são de um time do chat, por exemplo).
    pub skipped: Vec<Skipped>,
}

/// Grava (ou regrava) a linha-espelho `origin = 'mission'` de uma missão iniciada em terminais. **Só linhas no
/// banco**: não abre processo, PTY nem worktree, e não funde a missão no roster do chat (a missão segue dona do
/// motor, do chat da equipe `m:<id>` e do vigia: o espelho é invisível para `scope_of`, política e alias de peer,
/// ver `store::team_of`). Idempotente: o espelho anterior da mesma missão é trocado pelo roster atual.
/// Recusa um orquestrador que já lidera ou integra um time do chat.
pub fn mirror_mission(conn: &Connection, mirror: MissionMirror, now: i64) -> Result<Mirrored, String> {
    let mut input = mirror.team;
    let mission_id = input.mission_id.clone().unwrap_or_default();
    if mission_id.trim().is_empty() {
        return Err("Falta a missão do espelho.".into());
    }
    if let Some(old) = store::team_of_mission(conn, &mission_id)? {
        store::delete_team(conn, &old.id)?;
    }
    input.origin = Some(store::ORIGIN_MISSION.into());
    let orchestrator = input.orchestrator.trim().to_string();
    if let Some(other) = store::team_of_any(conn, &orchestrator)? {
        return Err(format!("Esta conversa já está no time de {}: o espelho da missão não a toma.", label_or(&other.label, &other.orchestrator)));
    }
    let (view, _) = create(conn, input, now)?;
    let team_id = view.team.id.clone();
    let mut skipped = Vec::new();
    for mut member in mirror.members {
        let id = member.member.trim().to_string();
        if id.is_empty() || id == orchestrator {
            continue;
        }
        if member.origin.is_empty() {
            member.origin = "existing".into();
        }
        if let Err(reason) = link(conn, &team_id, member, false, now) {
            skipped.push(Skipped { member: id, reason });
        }
    }
    Ok(Mirrored { team: view_by_id(conn, &team_id)?, skipped })
}

/// Tira o espelho de uma missão (ela fechou). Idempotente: `false` se não havia. Não fecha agente nenhum.
pub fn unmirror_mission(conn: &Connection, mission_id: &str) -> Result<bool, String> {
    match store::team_of_mission(conn, mission_id)? {
        Some(team) => store::delete_team(conn, &team.id),
        None => Ok(false),
    }
}

fn view_by_id(conn: &Connection, team_id: &str) -> Result<TeamView, String> {
    let team = store::team(conn, team_id)?.ok_or("Esse time não existe mais.")?;
    view(conn, team)
}

/// Tira só o papel de orquestrador (a coroa saiu do canvas): o time, os integrantes, as regras e o histórico
/// ficam. Idempotente: `false` se o time não existe ou já estava sem orquestrador.
pub fn unlead(conn: &Connection, team_id: &str, now: i64) -> Result<bool, String> {
    store::clear_orchestrator(conn, team_id, now)
}

/// Dá `orchestrator` a um time sem orquestrador (ou o troca). Se ele era integrante deste mesmo time, deixa de
/// ser (o papel de integrante não soma com o de orquestrador). Recusa quem lidera ou integra outro time.
pub fn lead(conn: &Connection, team_id: &str, orchestrator: &str, agent_id: &str, label: &str, now: i64) -> Result<TeamView, String> {
    let orchestrator = orchestrator.trim();
    if orchestrator.is_empty() {
        return Err("Falta a conversa do orquestrador.".into());
    }
    let team = store::team(conn, team_id)?.ok_or("Esse time não existe mais.")?;
    if team.orchestrator == orchestrator {
        return view(conn, team);
    }
    if let Some(other) = store::team_led_by(conn, orchestrator)? {
        return Err(format!("Esta conversa já é orquestradora do time de {}.", label_or(&other.label, &other.orchestrator)));
    }
    match store::team_joined_by(conn, orchestrator)? {
        Some(other) if other.id != team.id => {
            return Err(format!("Esta conversa já é integrante do time de {}: desligue-a de lá antes.", label_or(&other.label, &other.orchestrator)));
        }
        Some(_) => {
            store::delete_member(conn, orchestrator, now)?;
        }
        None => {}
    }
    let agent = if agent_id.is_empty() { team.agent_id.as_str() } else { agent_id };
    let name = if label.trim().is_empty() { team.label.clone() } else { model::clean_label(label) };
    store::set_orchestrator(conn, team_id, orchestrator, agent, &name, now)?;
    view_by_id(conn, team_id)
}

/// O que `rebind` mudou.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rebound {
    pub team_id: String,
    /// `orchestrator` ou `member`.
    pub role: &'static str,
}

/// Troca a ref de uma conversa (aba ↔ `thread:<id>`) no roster, mantendo time, papel e política. Recusa se a
/// ref nova já está em time (o invariante de um time só). `None` = a ref antiga não estava em time nenhum.
pub fn rebind(conn: &Connection, old_ref: &str, new_ref: &str, now: i64) -> Result<Option<Rebound>, String> {
    let (old, new) = (old_ref.trim(), new_ref.trim());
    if old.is_empty() || new.is_empty() {
        return Err("Faltam a ref antiga e a nova.".into());
    }
    if old == new {
        return Ok(None);
    }
    if store::team_of_any(conn, new)?.is_some() {
        return Err("A conversa nova já está em um time: desligue-a de lá antes.".into());
    }
    Ok(store::rebind(conn, old, new, now)?.map(|(team_id, role)| Rebound { team_id, role }))
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

/// O nome de quem entra, sem repetir nenhum que o time já teve (ligado, saindo ou que falhou ao entrar):
/// "Claude Code · Frontend", depois "Claude Code · Frontend 2". Sem distinguir maiúsculas. Pura.
pub fn unique_label(taken: &[String], wanted: &str) -> String {
    let wanted = wanted.trim();
    let used: std::collections::HashSet<String> = taken.iter().map(|t| t.trim().to_lowercase()).collect();
    if !used.contains(&wanted.to_lowercase()) {
        return wanted.to_string();
    }
    (2..).map(|n| format!("{wanted} {n}")).find(|label| !used.contains(&label.to_lowercase())).unwrap_or_default()
}

/// Grava o integrante novo como `provisioning` ANTES de abrir a conversa e o worktree. O nome sai único
/// ([`unique_label`]); o teto do time conta quem ainda está entrando.
pub fn provision_begin(conn: &Connection, team_id: &str, agent_id: &str, role: &str, label: &str, now: i64) -> Result<ProvisionRow, String> {
    let team = store::team(conn, team_id)?.ok_or("Esse time não existe mais.")?;
    let members = store::members(conn, &team.id)?;
    let provisions = store::provisions(conn, Some(&team.id))?;
    let entering = provisions.iter().filter(|p| p.state == "provisioning").count();
    if members.len() + entering >= MAX_MEMBERS {
        return Err(format!("O time já tem {MAX_MEMBERS} integrantes: desligue alguém antes."));
    }
    let wanted = model::clean_label(label);
    if wanted.is_empty() {
        return Err("O integrante novo precisa de um nome.".into());
    }
    let taken: Vec<String> = members.iter().map(|m| m.label.clone()).chain(provisions.iter().map(|p| p.label.clone())).collect();
    let row = ProvisionRow {
        id: uuid::Uuid::new_v4().to_string(),
        team_id: team.id,
        label: unique_label(&taken, &wanted),
        agent_id: agent_id.to_string(),
        role: role.trim().to_string(),
        member: None,
        worktree: None,
        branch: None,
        state: "provisioning".into(),
        failure: None,
        created_at: now,
        updated_at: now,
    };
    store::insert_provision(conn, &row)?;
    Ok(row)
}

/// Abrir a conversa ou o worktree falhou: fica `failed`, com o motivo. A conversa que chegou a abrir
/// (`member`) fica anotada para a pessoa achar.
pub fn provision_fail(conn: &Connection, id: &str, member: Option<&str>, reason: &str, now: i64) -> Result<bool, String> {
    store::settle_provision(conn, id, "failed", member, Some(reason), now)
}

/// Liga a conversa aberta para um integrante em `provisioning`: ele passa a `active`. Sem `provision`, é
/// o [`link`] de sempre (uma conversa que já existia).
pub fn link_provisioned(conn: &Connection, team_id: &str, mut new: NewMember, provision: Option<&str>, by_agent: bool, now: i64) -> Result<MemberRow, String> {
    let Some(id) = provision else { return link(conn, team_id, new, by_agent, now) };
    let row = store::provision(conn, id)?.filter(|p| p.team_id == team_id).ok_or("Esse integrante novo não é deste time.")?;
    if row.state != "provisioning" {
        return Err(format!("{} não está mais entrando no time ({}).", row.label, row.state));
    }
    new.label = row.label.clone();
    let member = link(conn, team_id, new, by_agent, now).inspect_err(|error| {
        let _ = provision_fail(conn, id, None, error, now);
    })?;
    store::settle_provision(conn, id, "active", Some(&member.member), None, now)?;
    Ok(member)
}

/// No boot: quem ficou `provisioning` (o app caiu no meio) vira `active` se a conversa dele está no time,
/// senão `failed`. Devolve quantos mudaram.
pub fn reconcile_provisions(conn: &Connection, now: i64) -> Result<usize, String> {
    let mut changed = 0;
    for row in store::provisions(conn, None)? {
        let linked = row.member.as_deref().map(|m| store::member(conn, m)).transpose()?.flatten().is_some_and(|m| m.team_id == row.team_id);
        let (state, failure) = match (linked, &row.member) {
            (true, _) => ("active", None),
            (false, Some(_)) => ("failed", Some("o app fechou depois de abrir a conversa e antes de ligá-la ao time")),
            (false, None) => ("failed", Some("o app fechou antes de a conversa do integrante abrir")),
        };
        if store::settle_provision(conn, &row.id, state, None, failure, now)? {
            changed += 1;
        }
    }
    Ok(changed)
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

/// As delegações em andamento do time que declaram escopos sobrepostos (`Escopo:` na delegação). Só aviso:
/// a tela mostra, nada é bloqueado (ver `missions::conflicts::scopes`).
pub fn scope_overlaps(conn: &Connection, team: &TeamView) -> Result<Vec<crate::missions::conflicts::scopes::Overlap>, String> {
    use crate::missions::conflicts::scopes;
    let members: Vec<String> = team.members.iter().map(|m| m.member.clone()).collect();
    // As 200 mais novas bastam: uma delegação em andamento mais velha que isso já não é "agora".
    let rows = store::feed(conn, &team.team.orchestrator, &members, 200)?;
    let messages: Vec<scopes::Message> = rows
        .iter()
        .map(|r| scopes::Message { kind: r.kind.clone(), to: r.to.clone(), to_name: r.to_name.clone(), from: r.from.clone(), text: r.text.clone() })
        .collect();
    Ok(scopes::overlaps(&scopes::in_progress(&messages)))
}

pub fn feed(conn: &Connection, team: &TeamView, limit: i64) -> Result<Vec<FeedItem>, String> {
    let members: Vec<String> = team.members.iter().map(|m| m.member.clone()).collect();
    let rows = store::feed(conn, &team.team.orchestrator, &members, limit)?;
    Ok(feed_items(&team.team.orchestrator, &rows))
}
