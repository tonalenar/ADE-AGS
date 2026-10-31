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

/// Entrega a uma conversa por protocolo. A mensagem entra na fila de `peer_messages` (dedupe, tetos, a tela
/// da fila, `--id`) como qualquer outra e o consumidor da conversa (`peer_queue::thread_outbox`, um por
/// destino) a envia, na ordem e quando a conversa estiver livre. Aqui o `tell` só espera o consumidor
/// decidir a vez dele: `Now` = já entrou na conversa; `Queued` = espera (conversa ocupada, ou o envio falhou
/// e tenta de novo com backoff; se esgotar, o aviso de falha volta pela fila do remetente).
pub(super) fn deliver_to_thread(app: &AppHandle, thread_id: &str, new: &NewMessage<'_>) -> Result<Sent, String> {
    let sent = enqueue_to_thread(app, new)?;
    use crate::peer_queue::store::State;
    match (sent.delivery, sent.message.state) {
        (Delivery::Queued, State::Delivered) => Ok(Sent { delivery: Delivery::Now, ..sent }),
        (Delivery::Queued, State::Unconfirmed | State::Expired) => {
            Err(sent.message.note.clone().unwrap_or_else(|| format!("A mensagem não chegou à conversa {thread_id}.")))
        }
        _ => Ok(sent),
    }
}

/// Põe a mensagem na fila da conversa e deixa o consumidor decidir a vez dela agora. Devolve o registro como
/// ficou (entregue, esperando ou falho), sem transformar a falha em erro: o `ask` a lê do estado da mensagem.
pub(super) fn enqueue_to_thread(app: &AppHandle, new: &NewMessage<'_>) -> Result<Sent, String> {
    let sent = peer_queue::enqueue(app, new)?;
    if sent.delivery != Delivery::Queued {
        return Ok(sent);
    }
    peer_queue::pump_thread(app, &sent.message.to_tab_id.clone())?;
    let message = fresh(app, sent.message.id).unwrap_or(sent.message);
    Ok(Sent { delivery: Delivery::Queued, message, repeat: false })
}

fn fresh(app: &AppHandle, id: i64) -> Option<crate::peer_queue::store::PeerMessage> {
    let db = db(app).ok()?;
    with_conn(&db, |conn| crate::peer_queue::store::get(conn, id)).ok().flatten()
}

/// Como a espera de um `peer ask` a uma conversa acabou.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Awaited {
    /// O turno da pergunta acabou (com resposta ou sem ela: veja `stopped`).
    pub finished: bool,
    /// TODAS as falas novas do agente, na ordem (a última é a resposta).
    pub replies: Vec<String>,
    /// Por que o turno acabou sem fala nova (erro, interrompido, conversa fechada). Só quando é verdade.
    pub stopped: Option<String>,
    /// A pergunta nem chegou à conversa (esgotou as tentativas, a conversa sumiu…): o motivo.
    pub failed: Option<String>,
}

/// O que se pode dizer da espera de uma mensagem, dado o que está gravado.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    /// Ainda não dá para dizer: espere.
    Wait,
    Replied(Vec<String>),
    Stopped(String),
    Failed(String),
}

/// Pura: julga a espera da mensagem `id` pelo estado dela na fila e pela timeline da conversa. A resposta é
/// ancorada na mensagem (o marcador `#id`), não numa contagem de falas feita antes do envio.
pub(super) fn judge(msg: &crate::peer_queue::store::PeerMessage, items: &[crate::canal::timeline::Item], alive: bool) -> Verdict {
    use crate::peer_queue::store::State;
    match msg.state {
        State::Expired | State::Unconfirmed | State::Cancelled | State::Refused => {
            return Verdict::Failed(msg.note.clone().unwrap_or_else(|| format!("A mensagem ficou {}.", msg.state.label())));
        }
        State::Queued | State::Delivering => return Verdict::Wait,
        State::Delivered => {}
    }
    let window = model::reply_window(items, msg.id);
    let Some(start) = window.start else {
        // Entregue e a timeline ainda não a mostra (o Codex a grava quando o servidor avisa).
        return if alive { Verdict::Wait } else { Verdict::Stopped("A conversa fechou antes de responder.".into()) };
    };
    let reason = || model::stopped_reason(&items[start..], alive).unwrap_or_else(|| "O turno terminou sem nenhuma resposta escrita.".into());
    match (window.ended, window.replies.is_empty()) {
        (true, false) => Verdict::Replied(window.replies),
        (true, true) => Verdict::Stopped(reason()),
        (false, _) if !alive => Verdict::Stopped(reason()),
        (false, _) => Verdict::Wait,
    }
}

/// Pura: o aviso do barramento muda a espera da mensagem `id` na conversa `thread`?
fn concerns(data: &Value, thread: &str, id: i64) -> bool {
    data.get("threadId").and_then(Value::as_str) == Some(thread) || data.get("id").and_then(Value::as_i64) == Some(id)
}

/// Espera, no barramento e sem polling, a resposta da mensagem `message_id` (o `ask`): para no que vier
/// primeiro, a resposta, o fim do turno sem fala, a falha da entrega ou o prazo. Acorda com qualquer aviso da
/// conversa (`chat.changed`: fase, `closed`…) ou da própria mensagem (`peer.message`).
pub(super) fn await_message(app: &AppHandle, thread_id: &str, message_id: i64, timeout: Duration) -> Awaited {
    let deadline = Instant::now() + timeout;
    let filter = crate::bus::Filter { topics: vec![super::conversas::BUS_TOPIC.into(), super::peer_queue::MESSAGE_TOPIC.into()], ..Default::default() };
    // O ponto de partida vem ANTES da primeira leitura: um aviso entre ler e dormir não se perde.
    let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
    let Ok(db) = db(app) else { return Awaited::default() };
    loop {
        let msg = with_conn(&db, |conn| crate::peer_queue::store::get(conn, message_id)).ok().flatten();
        let items = crate::conversa::api::items(&db, thread_id).unwrap_or_default();
        let alive = crate::conversa::api::status(thread_id).alive;
        let verdict = msg.as_ref().map_or(Verdict::Failed("A mensagem sumiu da fila.".into()), |m| judge(m, &items, alive));
        match verdict {
            Verdict::Replied(replies) => return Awaited { finished: true, replies, ..Default::default() },
            Verdict::Stopped(reason) => return Awaited { finished: true, stopped: Some(reason), ..Default::default() },
            Verdict::Failed(reason) => return Awaited { failed: Some(reason), ..Default::default() },
            Verdict::Wait => {}
        }
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Awaited::default();
            }
            let page = crate::bus::wait(after, &filter, 50, left);
            after = page.last_seq;
            if page.events.iter().any(|e| concerns(&e.data, thread_id, message_id)) {
                break;
            }
        }
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

#[cfg(test)]
mod test {
    use super::*;
    use crate::canal::timeline::{Item, ItemKind};
    use crate::peer_queue::store::{PeerMessage, State};

    fn msg(id: i64, state: State, note: Option<&str>) -> PeerMessage {
        PeerMessage {
            id, client_id: None, kind: "ask".into(), from_tab_id: "thread:lead".into(), from_name: "Líder".into(), to_tab_id: "thread:t1".into(),
            to_name: "QA".into(), text: "?".into(), raw: false, reply: true, state, position: 1, force_now: false, attempts: 1, created_at: 1,
            updated_at: 1, delivered_at: None, edited_at: None, note: note.map(str::to_string), depth: 0, parent_id: None, answer_of: None,
            reason: None, available_at: None, lease_until: None, delivery_mode: None, settled_at: None,
        }
    }

    fn user(id: i64) -> Item {
        Item { text: Some(format!("[Mensagem #{id} de Líder via ADE AGS] ?")), ..Item::new(ItemKind::User, format!("u{id}"), None) }
    }
    fn said(text: &str) -> Item {
        Item { text: Some(text.into()), ..Item::new(ItemKind::Assistant, format!("a-{text}"), None) }
    }
    fn end(error: Option<&str>) -> Item {
        Item { text: error.map(str::to_string), interrupted: Some(false), ..Item::new(ItemKind::TurnEnd, "end".into(), None) }
    }

    #[test]
    fn a_pergunta_que_nao_chegou_sai_com_o_motivo_sem_esperar_o_prazo() {
        let failed = msg(7, State::Expired, Some("A conversa de destino foi concluída ou apagada."));
        assert_eq!(judge(&failed, &[], true), Verdict::Failed("A conversa de destino foi concluída ou apagada.".into()));
        assert!(matches!(judge(&msg(7, State::Unconfirmed, None), &[], true), Verdict::Failed(m) if m.contains("sem confirmação")));
        assert_eq!(judge(&msg(7, State::Queued, None), &[], true), Verdict::Wait, "ainda na fila: espera");
        assert_eq!(judge(&msg(7, State::Delivering, None), &[], true), Verdict::Wait);
    }

    #[test]
    fn devolve_todas_as_falas_do_turno_e_so_quando_ele_acaba() {
        let delivered = msg(7, State::Delivered, None);
        let open = [said("antes"), user(7), said("primeira"), said("segunda")];
        assert_eq!(judge(&delivered, &open, true), Verdict::Wait, "o turno segue aberto");
        let ended = [said("antes"), user(7), said("primeira"), said("segunda"), end(None)];
        assert_eq!(judge(&delivered, &ended, true), Verdict::Replied(vec!["primeira".into(), "segunda".into()]));
    }

    #[test]
    fn a_ancora_e_a_mensagem_nao_a_contagem_de_falas() {
        // A fala de uma mensagem anterior (#6) e a de outra mensagem na frente não são a resposta de #7.
        let items = [user(6), said("resposta de seis"), end(None), user(7), said("resposta de sete"), end(None), user(8), said("de oito"), end(None)];
        assert_eq!(judge(&msg(7, State::Delivered, None), &items, true), Verdict::Replied(vec!["resposta de sete".into()]));
        assert_eq!(judge(&msg(8, State::Delivered, None), &items, true), Verdict::Replied(vec!["de oito".into()]));
    }

    #[test]
    fn sai_com_o_motivo_quando_o_turno_erra_acaba_mudo_ou_a_conversa_fecha() {
        let delivered = msg(7, State::Delivered, None);
        assert!(matches!(judge(&delivered, &[user(7), end(Some("falhou"))], true), Verdict::Stopped(m) if m.contains("falhou")));
        assert!(matches!(judge(&delivered, &[user(7), end(None)], true), Verdict::Stopped(m) if m.contains("sem nenhuma resposta")));
        assert!(matches!(judge(&delivered, &[user(7), said("parcial")], false), Verdict::Stopped(m) if m.contains("fechou")));
        assert_eq!(judge(&delivered, &[], true), Verdict::Wait, "entregue, mas a timeline ainda não mostra");
        assert!(matches!(judge(&delivered, &[], false), Verdict::Stopped(_)));
    }

    #[test]
    fn so_acorda_com_o_aviso_da_conversa_ou_da_mensagem() {
        assert!(concerns(&json!({ "threadId": "t1" }), "t1", 7));
        assert!(concerns(&json!({ "id": 7, "state": "delivered" }), "t1", 7));
        assert!(!concerns(&json!({ "threadId": "t2", "id": 8 }), "t1", 7));
    }
}
