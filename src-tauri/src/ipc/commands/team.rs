//! `ags team create|link|unlink|list|role`: o time de agentes do modo chat pela CLI e pelo MCP (ver
//! `crate::chat_team`). E a ponte que deixa as conversas por protocolo (`thread:<id>`) entrarem no
//! `peer`: elas não têm PTY, então a mensagem vai como mensagem da conversa (`conversa::api::send`).
//!
//! As regras de quem pode o quê:
//! - só o orquestrador do time liga, desliga e muda papel, e só a quem está na mesma pasta que ele
//!   (como `peer connect`) ou já no time; ligar qualquer outra conversa é da pessoa, no painel Time;
//! - o agente nunca aumenta a permissão de ninguém (`chat_team::model::agent_may_set`);
//! - `team create` vale para quem a pessoa já coroou no canvas: virar orquestrador é decisão dela.
//!
//! O canvas continua sendo a autorização: depois de mudar o time, a tela aplica as cordas e a coroa
//! (`team.sync`) e grava na hora, antes de o comando voltar.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peer_queue::{self, Delivery, Sent};
use super::peers::{self, OpenTab};
use crate::chat_team::{api, model, store};
use crate::database::DbConnection;
use crate::ipc::protocol::{arg_str, arg_str_opt};
use crate::peer_queue::store::NewMessage;

/// Quanto uma mensagem para uma conversa ocupada espera o turno acabar (o mesmo teto da fila dos
/// terminais, `peer_queue`): depois vai mesmo assim.
const THREAD_QUEUE_MAX_WAIT: Duration = Duration::from_secs(15 * 60);

/// O agente "shell" das abas: não é um agente de código, não entra num time.
const SHELL_AGENT: &str = "bash";

fn db(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(super::shared::db(app)?.inner().clone())
}

fn with_conn<T>(db: &DbConnection, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

// ── As conversas por protocolo no `peer` ─────────────────────────────

/// As conversas por protocolo que estão num time, como "abas" para o `peer` (o id é `thread:<id>`).
/// As que não estão em time nenhum ficam de fora: ninguém tem corda até elas.
pub(super) fn team_threads(app: &AppHandle) -> Vec<OpenTab> {
    let Ok(db) = db(app) else { return Vec::new() };
    let Ok((refs, labels)) = with_conn(&db, |conn| {
        let refs = store::thread_refs(conn)?;
        let mut labels = std::collections::HashMap::new();
        for team in store::teams(conn)? {
            labels.insert(team.orchestrator.clone(), team.label.clone());
            for m in store::members(conn, &team.id)? {
                labels.insert(m.member, m.label);
            }
        }
        Ok((refs, labels))
    }) else {
        return Vec::new();
    };
    if refs.is_empty() {
        return Vec::new();
    }
    let Ok(threads) = crate::conversa::api::threads(&db) else { return Vec::new() };
    threads
        .into_iter()
        .filter(|t| t.state == "active")
        .filter_map(|t| {
            let id = format!("{}{}", model::THREAD_PREFIX, t.id);
            if !refs.contains(&id) {
                return None;
            }
            let agent = crate::agents::agent_label(&t.agent_id).unwrap_or(&t.agent_id).to_string();
            let label = labels.get(&id).map(|l| l.trim()).filter(|l| !l.is_empty()).map(str::to_string);
            let name = label.unwrap_or_else(|| if t.title.trim().is_empty() { agent.clone() } else { t.title.clone() });
            Some(OpenTab { id, name, agent, agent_id: t.agent_id, cwd: t.cwd, window: "main".into() })
        })
        .collect()
}

/// Espera, no barramento e sem polling, a conversa terminar o turno (ou o prazo).
fn wait_idle(thread_id: &str, max: Duration) {
    let deadline = Instant::now() + max;
    let filter = crate::bus::Filter { topics: vec![super::conversas::BUS_TOPIC.into()], ..Default::default() };
    let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
    while crate::conversa::api::status(thread_id).working && Instant::now() < deadline {
        let page = crate::bus::wait(after, &filter, 50, deadline.saturating_duration_since(Instant::now()));
        after = page.last_seq;
    }
}

fn fresh(app: &AppHandle, id: i64) -> Option<crate::peer_queue::store::PeerMessage> {
    let db = db(app).ok()?;
    with_conn(&db, |conn| crate::peer_queue::store::get(conn, id)).ok().flatten()
}

fn send_now(app: &AppHandle, thread_id: &str, text: &str) -> Result<(), String> {
    let db = db(app)?;
    tauri::async_runtime::block_on(crate::conversa::api::send(app, &db, thread_id, text))
}

/// Entrega a uma conversa por protocolo. A mensagem entra na mesma fila (`peer_messages`: dedupe,
/// tetos, a tela da fila) e vai como mensagem da conversa, com o mesmo cabeçalho do terminal. Com o
/// agente no meio de um turno, espera o turno acabar (até [`THREAD_QUEUE_MAX_WAIT`]) para não desviar
/// o trabalho dele, como a fila dos terminais.
pub(super) fn deliver_to_thread(app: &AppHandle, thread_id: &str, new: &NewMessage<'_>) -> Result<Sent, String> {
    let msg = match peer_queue::begin_direct(app, new)? {
        Ok(msg) => msg,
        Err(sent) => return Ok(sent),
    };
    if !crate::conversa::api::status(thread_id).working {
        let result = send_now(app, thread_id, &peer_queue::compose(&msg, &msg.text, Duration::ZERO));
        peer_queue::end_direct(app, &msg, result.as_ref().err().map(String::as_str));
        result?;
        let message = fresh(app, msg.id).unwrap_or(msg);
        return Ok(Sent { delivery: Delivery::Now, message, repeat: false });
    }
    let (app2, thread, queued) = (app.clone(), thread_id.to_string(), msg.clone());
    std::thread::spawn(move || {
        let started = Instant::now();
        wait_idle(&thread, THREAD_QUEUE_MAX_WAIT);
        let result = send_now(&app2, &thread, &peer_queue::compose(&queued, &queued.text, started.elapsed()));
        peer_queue::end_direct(&app2, &queued, result.as_ref().err().map(String::as_str));
    });
    Ok(Sent { delivery: Delivery::Queued, message: msg, repeat: false })
}

/// Quantas falas do agente a conversa já tem (para o `peer ask` achar a resposta NOVA).
pub(super) fn assistant_count(app: &AppHandle, thread_id: &str) -> usize {
    let Ok(db) = db(app) else { return 0 };
    crate::conversa::api::items(&db, thread_id)
        .map(|items| items.iter().filter(|i| i.kind == crate::canal::timeline::ItemKind::Assistant).count())
        .unwrap_or(0)
}

/// Espera o turno da conversa acabar com uma fala nova do agente (depois de `before` falas), sem
/// polling. `(terminou, a última fala nova)`.
pub(super) fn await_reply(app: &AppHandle, thread_id: &str, before: usize, timeout: Duration) -> (bool, Option<String>) {
    let deadline = Instant::now() + timeout;
    let filter = crate::bus::Filter { topics: vec![super::conversas::BUS_TOPIC.into()], ..Default::default() };
    let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
    let Ok(db) = db(app) else { return (false, None) };
    loop {
        let replies: Vec<String> = crate::conversa::api::items(&db, thread_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|i| i.kind == crate::canal::timeline::ItemKind::Assistant)
            .skip(before)
            .filter_map(|i| i.text)
            .collect();
        let working = crate::conversa::api::status(thread_id).working;
        if !working && !replies.is_empty() {
            return (true, replies.last().cloned());
        }
        if Instant::now() >= deadline {
            return (false, replies.last().cloned());
        }
        let page = crate::bus::wait(after, &filter, 50, deadline.saturating_duration_since(Instant::now()));
        after = page.last_seq;
    }
}

// ── `ags team …` ─────────────────────────────────────────────────────

/// Pede à tela que aplique o time no canvas (cordas, coroa, papéis) e grave já. `removed`: quem saiu
/// (a corda dele com o orquestrador sai junto).
fn sync_canvas(app: &AppHandle, team_id: &str, window: Option<&str>, removed: Option<&str>) -> bool {
    let args = json!({ "teamId": team_id, "window": window, "removed": removed });
    super::shared::bridge_call(app, "team.sync", &args).is_ok()
}

fn window_of(me: Option<&OpenTab>) -> Option<String> {
    me.filter(|t| model::thread_id_of(&t.id).is_none()).map(|t| t.window.clone())
}

fn auto_of(policy: model::Policy) -> Value {
    use model::{decide, Ask};
    json!({ "edit": decide(policy, Ask::Edit, false), "command": decide(policy, Ask::Command, false), "network": decide(policy, Ask::Network, false) })
}

fn role_label(role: &str) -> String {
    crate::chat_team::role_info(role).0
}

/// O time com os nomes de agora e o que cada um é.
fn describe_team(view: &api::TeamView, tabs: &[OpenTab]) -> Value {
    let name_of = |id: &str| tabs.iter().find(|t| t.id == id).map(|t| t.name.clone());
    let members: Vec<Value> = view
        .members
        .iter()
        .map(|m| {
            let working = model::thread_id_of(&m.member).map(|t| crate::conversa::api::status(t).working).unwrap_or_else(|| crate::canal::busy(&m.member));
            json!({
                "id": m.member, "name": name_of(&m.member).unwrap_or_else(|| m.label.clone()), "agent": m.agent_id,
                "role": m.role, "roleLabel": role_label(&m.role), "subagent": m.subagent, "policy": m.policy, "model": m.model, "branch": m.branch,
                "worktree": m.worktree, "open": name_of(&m.member).is_some(), "working": working,
                // O que a política deixa passar sem a pessoa (risco alto sempre vai a ela).
                "auto": auto_of(m.policy),
            })
        })
        .collect();
    json!({
        "id": view.team.id,
        "title": view.team.title,
        "orchestrator": { "id": view.team.orchestrator, "name": name_of(&view.team.orchestrator).unwrap_or_else(|| view.team.label.clone()), "agent": view.team.agent_id },
        "members": members,
        "headcount": view.headcount,
    })
}

pub(super) fn team_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = peers::caller(args)?;
    let db = db(app)?;
    let Some(view) = with_conn(&db, |conn| api::team_of(conn, &from))? else {
        return Ok(json!({ "team": null, "note": "Você não está num time. A pessoa liga agentes no painel Time do modo chat; um orquestrador coroado no canvas cria o seu com `ags team create`." }));
    };
    let tabs = peers::open_tabs(app)?;
    let you = if view.team.orchestrator == from { "orchestrator" } else { "member" };
    Ok(json!({ "team": describe_team(&view, &tabs), "you": you }))
}

/// `ags team create [--title ...]`: um orquestrador do canvas (coroa dada pela pessoa) vira o
/// orquestrador de um time do modo chat. Quem já está ligado a ele por corda entra junto, com o papel
/// do canvas e supervisionado.
pub(super) fn team_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = peers::caller(args)?;
    let boards = crate::canvas::load_boards();
    if !crate::canvas::is_orchestrator(&boards, &from) {
        return Err("Só quem a pessoa marcou como orquestrador cria um time (a coroa no canvas, ou \"Tornar orquestrador\" no painel Time do modo chat).".into());
    }
    let tabs = peers::open_tabs(app)?;
    let me = tabs.iter().find(|t| t.id == from).cloned();
    let input = api::NewTeam {
        orchestrator: from.clone(),
        agent_id: me.as_ref().map(|m| m.agent_id.clone()).unwrap_or_default(),
        label: me.as_ref().map(|m| m.name.clone()).unwrap_or_default(),
        cwd: me.as_ref().map(|m| m.cwd.clone()).unwrap_or_default(),
        title: arg_str_opt(args, "title").unwrap_or_default(),
    };
    let roles = crate::canvas::roles::all();
    let direct = crate::canvas::peers_of(&boards, &from);
    let db = db(app)?;
    let (view, created, adopted) = with_conn(&db, |conn| {
        let now = crate::util::now_ts_ms();
        let (view, created) = api::create(conn, input, now)?;
        let mut adopted = Vec::new();
        for tab in tabs.iter().filter(|t| direct.contains(&t.id) && t.agent_id != SHELL_AGENT) {
            let role = crate::canvas::role_of(&boards, &tab.id).and_then(|r| model::role_id(&roles, &r)).unwrap_or_default();
            let new = store::NewMember { member: tab.id.clone(), agent_id: tab.agent_id.clone(), label: tab.name.clone(), role, origin: "existing".into(), ..Default::default() };
            // Quem já está em outro time fica onde está.
            if api::link(conn, &view.team.id, new, true, now).is_ok() {
                adopted.push(tab.name.clone());
            }
        }
        Ok((api::view(conn, store::team(conn, &view.team.id)?.ok_or("O time sumiu.")?)?, created, adopted))
    })?;
    crate::chat_team::announce(app, &view.team.id);
    let synced = sync_canvas(app, &view.team.id, window_of(me.as_ref()).as_deref(), None);
    Ok(json!({ "team": describe_team(&view, &tabs), "created": created, "adopted": adopted, "canvasSynced": synced }))
}

/// O time que `from` coordena, ou o erro que explica.
fn led_team(db: &DbConnection, from: &str) -> Result<api::TeamView, String> {
    with_conn(db, |conn| {
        let team = store::team_led_by(conn, from)?.ok_or("Só o orquestrador do time liga, desliga e muda o papel dos integrantes (veja `ags team list`).")?;
        api::view(conn, team)
    })
}

/// Com quem o orquestrador pode mexer: o time e as conversas abertas na mesma pasta (abas de agente
/// e conversas por protocolo ativas). Ligar outra pasta é da pessoa, no painel.
fn candidates(app: &AppHandle, db: &DbConnection, me: &OpenTab, team: &api::TeamView) -> Result<Vec<OpenTab>, String> {
    let in_team = |id: &str| team.members.iter().any(|m| m.member == id);
    let mut out: Vec<OpenTab> = peers::open_tabs(app)?
        .into_iter()
        .filter(|t| t.id != me.id && t.agent_id != SHELL_AGENT && (in_team(&t.id) || t.cwd == me.cwd))
        .collect();
    for thread in crate::conversa::api::threads(db)?.into_iter().filter(|t| t.state == "active" && t.cwd == me.cwd) {
        let id = format!("{}{}", model::THREAD_PREFIX, thread.id);
        if id == me.id || out.iter().any(|t| t.id == id) {
            continue;
        }
        let agent = crate::agents::agent_label(&thread.agent_id).unwrap_or(&thread.agent_id).to_string();
        let name = if thread.title.trim().is_empty() { agent.clone() } else { thread.title.clone() };
        out.push(OpenTab { id, name, agent, agent_id: thread.agent_id, cwd: thread.cwd, window: "main".into() });
    }
    Ok(out)
}

fn me_of(app: &AppHandle, from: &str) -> Result<OpenTab, String> {
    peers::open_tabs(app)?.into_iter().find(|t| t.id == from).ok_or_else(|| "A sua conversa não está aberta em nenhuma janela.".to_string())
}

/// `--subagent` (sem valor = ligado) ou `--subagent false`; ausente = não disse (`None`).
fn arg_subagent(args: &Value) -> Option<bool> {
    match args.get("subagent")? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => Some(!matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off")),
        _ => None,
    }
}

fn parse_role(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else { return Ok(None) };
    let roles = crate::canvas::roles::all();
    model::role_id(&roles, &raw).map(Some).ok_or_else(|| {
        format!("Não existe o papel '{raw}'. Papéis do time: {}. Veja também `ags roles`.", model::TEAM_ROLES.join(", "))
    })
}

/// Manda o briefing do papel a quem entrou (aba: pela fila do terminal; conversa: como mensagem).
fn brief(app: &AppHandle, me: &OpenTab, target: &OpenTab, text: &str) -> bool {
    let new = NewMessage {
        kind: "role", from_tab_id: &me.id, from_name: &me.name, to_tab_id: &target.id, to_name: &target.name, text, ..Default::default()
    };
    let sent = match model::thread_id_of(&target.id) {
        Some(thread) => deliver_to_thread(app, thread, &new),
        None => super::tabs::pty_id_for_tab(app, &target.id, Some(&target.window)).and_then(|pty| peer_queue::deliver_now_or_queue(app, pty, &new)),
    };
    sent.is_ok_and(|s| matches!(s.delivery, Delivery::Now | Delivery::Queued))
}

/// `ags team link <nome> [--role <papel>] [--policy read|ask] [--branch <b>] [--subagent]`.
pub(super) fn team_link(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = peers::caller(args)?;
    let db = db(app)?;
    let team = led_team(&db, &from)?;
    let me = me_of(app, &from)?;
    let list = candidates(app, &db, &me, &team)?;
    let target = peers::resolve_peer(&list, &arg_str(args, "to")?)?.clone();
    let role = parse_role(arg_str_opt(args, "role"))?;
    let policy = arg_str_opt(args, "policy").as_deref().map(model::Policy::parse).transpose()?;
    let branch = arg_str_opt(args, "branch");
    let new = store::NewMember {
        member: target.id.clone(),
        agent_id: target.agent_id.clone(),
        label: target.name.clone(),
        role: role.unwrap_or_default(),
        policy,
        branch,
        origin: "existing".into(),
        subagent: arg_subagent(args),
        ..Default::default()
    };
    let member = with_conn(&db, |conn| api::link(conn, &team.team.id, new, true, crate::util::now_ts_ms()))?;
    crate::chat_team::announce(app, &team.team.id);
    let synced = sync_canvas(app, &team.team.id, window_of(Some(&me)).as_deref(), None);
    let (label, instructions) = crate::chat_team::role_info(&member.role);
    let briefed = brief(app, &me, &target, &crate::chat_team::briefing_for(&me.name, &member, &label, &instructions));
    Ok(json!({ "member": member, "roleLabel": label, "briefed": briefed, "canvasSynced": synced,
        "note": format!("{} está no time. Delegue com `ags peer tell \"{}\" --task \"...\"`.", target.name, target.name) }))
}

/// `ags team unlink <nome>`: tira do time (a corda sai; a conversa continua aberta).
pub(super) fn team_unlink(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = peers::caller(args)?;
    let db = db(app)?;
    let team = led_team(&db, &from)?;
    let me = me_of(app, &from)?;
    let tabs = peers::open_tabs(app)?;
    let to = arg_str(args, "to")?;
    let member = team
        .members
        .iter()
        .find(|m| m.member == to || m.label.eq_ignore_ascii_case(to.trim()) || tabs.iter().any(|t| t.id == m.member && t.name.eq_ignore_ascii_case(to.trim())))
        .ok_or_else(|| format!("'{to}' não está no seu time. Integrantes: {}", team.members.iter().map(|m| m.label.as_str()).collect::<Vec<_>>().join(", ")))?
        .clone();
    let removed = with_conn(&db, |conn| api::unlink(conn, &team.team.id, &member.member, crate::util::now_ts_ms()))?;
    crate::chat_team::announce(app, &team.team.id);
    // A corda sai pela tela (ela recalcula o time); sem o integrante, o `peer` já não o alcança.
    let synced = sync_canvas(app, &team.team.id, window_of(Some(&me)).as_deref(), Some(&member.member));
    Ok(json!({ "removed": removed, "member": member.member, "canvasSynced": synced }))
}

/// `ags team role <nome> <papel> [--policy read|ask|...]`: muda o papel (e, para baixo, a política).
pub(super) fn team_role(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = peers::caller(args)?;
    let db = db(app)?;
    let team = led_team(&db, &from)?;
    let me = me_of(app, &from)?;
    let list = candidates(app, &db, &me, &team)?;
    let target = peers::resolve_peer(&list, &arg_str(args, "to")?)?.clone();
    let role = parse_role(arg_str_opt(args, "role"))?;
    let policy = arg_str_opt(args, "policy").as_deref().map(model::Policy::parse).transpose()?;
    let subagent = arg_subagent(args);
    if role.is_none() && policy.is_none() && subagent.is_none() {
        return Err("Diga o papel (ou --policy, ou --subagent): ags team role <nome> <papel>".into());
    }
    let patch = store::MemberPatch { role: role.clone(), policy, subagent, ..Default::default() };
    let member = with_conn(&db, |conn| api::update(conn, &team.team.id, &target.id, patch, true, crate::util::now_ts_ms()))?;
    crate::chat_team::announce(app, &team.team.id);
    let synced = sync_canvas(app, &team.team.id, window_of(Some(&me)).as_deref(), None);
    let briefed = (role.is_some() || subagent.is_some()) && {
        let (label, instructions) = crate::chat_team::role_info(&member.role);
        brief(app, &me, &target, &crate::chat_team::briefing_for(&me.name, &member, &label, &instructions))
    };
    Ok(json!({ "member": member, "roleLabel": role_label(&member.role), "briefed": briefed, "canvasSynced": synced }))
}
