//! Chat con los agentes: `ccode say` (`say.send`) y `ccode recall` (`recall.get`), lado del agente y el envío del
//! usuario desde la pantalla (ver `crate::chat` para el modelo y las decisiones).
//!
//! `say` no necesita permiso ni conexión: le habla al usuario, no a otro agente, y lo único
//! que puede hacer es dejar un globo de texto en su pantalla. A cambio, el texto es solo
//! texto (la pantalla no lo interpreta) y el límite de tamaño es estricto.
//!
//! El chat es para agentes, no para terminales de shell: el mensaje del usuario se escribe
//! en la terminal del destino, y en un shell eso sería ejecutar lo que dijo como comando.

use std::time::Duration;

use chrono::{Local, TimeZone};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, open_tabs};
use super::tabs::{pty_id_for_tab, submit_prompt, wait_until_quiet};
use crate::chat::{self, Conversation, Kind, Message};
use crate::ipc::protocol::arg_str_opt;

/// El evento que avisa a la pantalla que cambió una conversación; lleva el id de la tab.
pub const CHANGED_EVENT: &str = "cc-chat-changed";

fn changed(app: &AppHandle, tab_id: &str) {
    let _ = app.emit(CHANGED_EVENT, tab_id);
}

fn flag(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "" | "true" | "1" | "yes"),
        _ => false,
    }
}

fn fmt_time(unix: i64) -> String {
    Local.timestamp_opt(unix, 0).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

fn as_json(m: &Message) -> Value {
    json!({
        "from": if m.kind == Kind::User { "user" } else { "agent" },
        "progress": m.kind == Kind::Progress,
        "text": m.text,
        "at": fmt_time(m.at),
    })
}

// ── Lado del agente ─────────────────────────────────────────────────

/// `ccode say "texto" [--progress] [--thread <color>]`: una respuesta al usuario, en su chat.
pub(super) fn chat_say(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    // El texto llega suelto, con `--text`, o desde un archivo (`--file`, que la CLI deja
    // en `content`).
    let raw = arg_str_opt(args, "text").or_else(|| arg_str_opt(args, "content")).ok_or("Falta a mensagem: ccode say \"...\"")?;
    let text = chat::clean_text(&raw)?;
    let kind = if flag(args, "progress") { Kind::Progress } else { Kind::Say };
    let asked = arg_str_opt(args, "thread");

    let thread = chat::update(&from, |conv| {
        let thread = chat::reply_thread(conv, asked.as_deref())?;
        chat::push(conv, thread, kind, text.clone(), Local::now().timestamp());
        Ok(thread)
    })?;
    changed(app, &from);
    Ok(json!({ "delivered": true, "thread": thread, "progress": kind == Kind::Progress }))
}

/// `ccode recall [thread|list] [--turns N | --all]`: lo que se habló, para quien llega sin
/// memoria (un agente reiniciado, o con la conversación compactada).
pub(super) fn chat_recall(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let conv: Conversation = chat::conversation(&from);
    let wanted = arg_str_opt(args, "thread").filter(|t| !t.trim().is_empty());

    if wanted.as_deref().is_some_and(|t| t.trim().eq_ignore_ascii_case("list")) {
        let threads: Vec<Value> = chat::THREADS
            .iter()
            .filter_map(|t| {
                let in_thread: Vec<&Message> = conv.messages.iter().filter(|m| m.thread == *t).collect();
                let last = in_thread.last()?;
                Some(json!({ "thread": t, "messages": in_thread.len(), "last": fmt_time(last.at), "current": conv.current_thread == *t }))
            })
            .collect();
        return Ok(json!({ "threads": threads }));
    }

    let thread = match wanted {
        Some(t) => chat::parse_thread(&t)?,
        None => chat::reply_thread(&conv, None)?,
    };
    let turns = if flag(args, "all") {
        None
    } else {
        let n = match args.get("turns") {
            None | Some(Value::Null) => 10,
            Some(Value::Number(n)) => n.as_u64().unwrap_or(10) as usize,
            Some(Value::String(s)) => s.trim().parse::<usize>().map_err(|_| format!("--turns tem que ser um número, veio '{s}'"))?,
            Some(_) => return Err("--turns inválido".into()),
        };
        Some(n.clamp(1, 500))
    };
    let messages: Vec<Value> = chat::recall(&conv, thread, turns).into_iter().map(as_json).collect();
    Ok(json!({ "thread": thread, "messages": messages }))
}

// ── Lado de la pantalla ─────────────────────────────────────────────

#[tauri::command]
pub fn chat_history(tab_id: String) -> Conversation {
    chat::conversation(&tab_id)
}

/// El mensaje del usuario a un agente. `async`: espera a que el agente se calle antes de
/// escribirle (hasta 60 s), y no se interrumpe a quien está a mitad de un turno.
#[tauri::command(async)]
pub fn chat_send(app: AppHandle, tab_id: String, thread: String, text: String) -> Result<Message, String> {
    let thread = chat::parse_thread(&thread)?;
    let text = chat::clean_text(&text)?;

    let tab = open_tabs(&app)?
        .into_iter()
        .find(|t| t.id == tab_id)
        .ok_or("Esse agente não está aberto.")?;
    if tab.agent_id == "bash" {
        return Err("O chat é para agentes. Num terminal de shell a mensagem seria executada como comando.".into());
    }
    let pty = pty_id_for_tab(&app, &tab.id, Some(&tab.window))?;

    // Se muestra enseguida, y si no se pudo entregar se retira: el usuario no puede quedar
    // viendo un mensaje que el agente nunca recibió.
    let message = chat::update(&tab_id, |conv| Ok(chat::push(conv, thread, Kind::User, text.clone(), Local::now().timestamp())))?;
    changed(&app, &tab_id);

    wait_until_quiet(pty, Duration::from_millis(1500), Duration::from_secs(60), false);
    if let Err(e) = submit_prompt(pty, &chat::framed(thread, &text)) {
        let _ = chat::update(&tab_id, |conv| {
            conv.messages.retain(|m| m.id != message.id);
            Ok(())
        });
        changed(&app, &tab_id);
        return Err(e);
    }
    Ok(message)
}
