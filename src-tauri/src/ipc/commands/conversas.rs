//! `ags chat …`: as conversas por protocolo do modo chat (ver `conversa`) pela CLI e pelo MCP.
//! Os mesmos passos da tela (`conversa::api`); o processo do agente vive no runtime do app, então as
//! partes assíncronas rodam com `tauri::async_runtime::block_on` (o handler está numa thread própria).
//!
//! Responder a uma aprovação do agente **não** existe aqui: quem aprova o que o agente da conversa
//! roda é a pessoa, na tela. `chat pending` só mostra o que espera.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::canal::timeline::{Item, ItemKind};
use crate::conversa::api::{self, NewThread};
use crate::database::DbConnection;
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_checked};

use super::shared::bridge_call;

/// O tópico do barramento que `chat wait` escuta (ver `conversa::codex::emit`).
pub const BUS_TOPIC: &str = "chat.changed";
const WAIT_DEFAULT_SECS: u64 = 600;
const WAIT_MAX_SECS: u64 = 3600;
const SHOW_DEFAULT: u64 = 20;
const TITLE_MAX: usize = 60;

fn db(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(super::shared::db(app)?.inner().clone())
}

fn thread_arg(args: &Value) -> Result<String, String> {
    arg_str(args, "thread").map_err(|_| "Falta a conversa: ags chat <ação> <id>".to_string())
}

/// O título de uma conversa nova: a primeira linha da mensagem, curta. Pura.
pub fn title_of(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Conversa");
    let mut title: String = line.chars().take(TITLE_MAX).collect();
    if line.chars().count() > TITLE_MAX {
        title.push('…');
    }
    title
}

/// A última fala do agente na timeline (o que `wait` e `show` destacam). Pura.
pub fn last_reply(items: &[Item]) -> Option<String> {
    items.iter().rev().find(|i| i.kind == ItemKind::Assistant).and_then(|i| i.text.clone())
}

/// A última fala do agente DEPOIS da última mensagem da pessoa: a resposta do turno que `wait` acabou de esperar.
/// Sem fala nova (o turno errou, foi interrompido ou o processo caiu), é `None`: antes o `wait` devolvia a fala
/// do turno anterior como se fosse a resposta. Pura.
pub fn reply_since_last_user(items: &[Item]) -> Option<String> {
    let from = items.iter().rposition(|i| i.kind == ItemKind::User).map_or(0, |at| at + 1);
    last_reply(&items[from..])
}

pub(super) fn chat_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let all = args.get("all").is_some_and(|v| v.as_bool().unwrap_or(true));
    let db = db(app)?;
    let threads: Vec<Value> = api::threads(&db)?
        .into_iter()
        .filter(|t| all || t.state == "active")
        .map(|t| {
            let status = api::status(&t.id);
            let pending = api::requests(&db, &t.id).map(|r| r.len()).unwrap_or(0);
            json!({ "id": t.id, "title": t.title, "agent": t.agent_id, "cwd": t.cwd, "state": t.state,
                "working": status.working, "pending": pending, "updatedAt": t.updated_at })
        })
        .collect();
    Ok(json!({ "threads": threads }))
}

pub(super) fn chat_new(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let text = arg_str(args, "text").map_err(|_| "Falta a mensagem: ags chat new \"...\" --cwd <pasta>".to_string())?;
    let cwd = arg_str(args, "cwd").map_err(|_| "Falta a pasta: --cwd <pasta>".to_string())?;
    let db = db(app)?;
    let row = api::create(&db, NewThread {
        agent_id: arg_str_opt(args, "agent").unwrap_or_else(|| "codex".into()),
        title: arg_str_opt(args, "title").unwrap_or_else(|| title_of(&text)),
        cwd,
        model: arg_str_opt(args, "model"),
        effort: arg_str_opt(args, "effort"),
        // Aberta por um agente, a conversa começa supervisionada: o que ela rodar, a pessoa aprova.
        access: arg_str_opt(args, "access").unwrap_or_else(|| "ask".into()),
        account_id: arg_str_opt(args, "account"),
    })?;
    api::announce(app, &row);
    tauri::async_runtime::block_on(api::send(app, &db, &row.id, &text))?;
    Ok(json!({ "thread": row, "next": format!("ags chat wait {}", row.id) }))
}

pub(super) fn chat_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let text = arg_str(args, "text").map_err(|_| "Falta a mensagem: ags chat send <id> \"...\"".to_string())?;
    let db = db(app)?;
    api::thread(&db, &thread)?;
    tauri::async_runtime::block_on(api::send(app, &db, &thread, &text))?;
    Ok(json!({ "sent": true, "next": format!("ags chat wait {thread}") }))
}

pub(super) fn chat_show(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let last = arg_u64_checked(args, "last")?.unwrap_or(SHOW_DEFAULT) as usize;
    let db = db(app)?;
    let row = api::thread(&db, &thread)?;
    // Os tokens de cada chamada são só para a conta do turno na tela: não entram na conversa.
    let items: Vec<_> = api::items(&db, &thread)?.into_iter().filter(|i| i.kind != ItemKind::Usage).collect();
    let from = items.len().saturating_sub(last);
    Ok(json!({
        "thread": row,
        "status": api::status(&thread),
        "pending": api::requests(&db, &thread)?,
        "reply": last_reply(&items),
        "items": &items[from..],
    }))
}

/// Espera o turno acabar ou o agente pedir algo à pessoa (o que vier primeiro), sem polling: dorme
/// no barramento até um `chat.changed` desta conversa.
pub(super) fn chat_wait(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let secs = arg_u64_checked(args, "timeout")?.unwrap_or(WAIT_DEFAULT_SECS).clamp(1, WAIT_MAX_SECS);
    let db = db(app)?;
    api::thread(&db, &thread)?;
    let deadline = Instant::now() + Duration::from_secs(secs);
    let filter = crate::bus::Filter { topics: vec![BUS_TOPIC.into()], ..Default::default() };
    // O `seq` antes de olhar o estado: o que mudar depois disso acorda a espera.
    let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
    loop {
        let status = api::status(&thread);
        let pending = api::requests(&db, &thread)?;
        let timed_out = Instant::now() >= deadline;
        if !status.working || !pending.is_empty() || timed_out {
            let items = api::items(&db, &thread)?;
            let reply = reply_since_last_user(&items);
            // Terminou sem resposta nova: diga por quê (erro, interrompido, processo caído), lido do turnEnd gravado.
            let stopped = if !status.working && reply.is_none() { crate::chat_team::model::stopped_reason(&items, status.alive) } else { None };
            return Ok(json!({
                "done": !status.working,
                "waitingForUser": !pending.is_empty(),
                "timedOut": timed_out && status.working && pending.is_empty(),
                "reply": reply,
                "stopped": stopped,
                "pending": pending,
            }));
        }
        let page = crate::bus::wait(after, &filter, 50, deadline.saturating_duration_since(Instant::now()));
        after = page.last_seq;
    }
}

pub(super) fn chat_stop(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    tauri::async_runtime::block_on(api::interrupt(&thread))?;
    Ok(json!({ "stopped": true }))
}

/// O que os agentes das conversas esperam da pessoa (de uma conversa, ou de todas).
pub(super) fn chat_pending(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let ids: Vec<String> = match arg_str_opt(args, "thread") {
        Some(id) => vec![id],
        None => api::threads(&db)?.into_iter().filter(|t| t.state == "active").map(|t| t.id).collect(),
    };
    let mut pending = Vec::new();
    for id in ids {
        pending.extend(api::requests(&db, &id)?);
    }
    Ok(json!({ "pending": pending }))
}

/// Mostra a conversa na tela (liga a casca do chat, se o modo estiver ligado).
pub(super) fn chat_open(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    api::thread(&db(app)?, &thread)?;
    bridge_call(app, "chat.open", &json!({ "thread": thread }))
}

pub(super) fn chat_settle(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let reopen = args.get("reopen").is_some_and(|v| v.as_bool().unwrap_or(true));
    api::settle(&db(app)?, &thread, !reopen)?;
    Ok(json!({ "settled": !reopen }))
}

#[cfg(test)]
mod test {
    use super::*;

    fn item(kind: ItemKind, id: &str, text: &str) -> Item {
        Item { text: Some(text.into()), ..Item::new(kind, id.into(), None) }
    }

    #[test]
    fn o_wait_so_devolve_a_fala_do_turno_que_esperou() {
        let items = vec![
            item(ItemKind::User, "u1", "faça A"),
            item(ItemKind::Assistant, "a1", "A feito"),
            item(ItemKind::TurnEnd, "e1", ""),
            item(ItemKind::User, "u2", "faça B"),
            item(ItemKind::TurnEnd, "e2", "o processo caiu"),
        ];
        assert_eq!(last_reply(&items).as_deref(), Some("A feito"), "o `show` segue destacando a última fala");
        assert_eq!(reply_since_last_user(&items), None, "o turno de B errou: a fala de A não é a resposta dele");
        let mut done = items.clone();
        done.insert(4, item(ItemKind::Assistant, "a2", "B feito"));
        assert_eq!(reply_since_last_user(&done).as_deref(), Some("B feito"));
        assert_eq!(reply_since_last_user(&[item(ItemKind::Assistant, "a0", "só fala")]).as_deref(), Some("só fala"));
    }
}
