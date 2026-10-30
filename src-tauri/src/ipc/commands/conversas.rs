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
            return Ok(json!({
                "done": !status.working,
                "waitingForUser": !pending.is_empty(),
                "timedOut": timed_out && status.working && pending.is_empty(),
                "reply": last_reply(&items),
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
