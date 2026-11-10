//! `ags chat …`: as conversas por protocolo do modo chat (ver `conversa`) pela CLI e pelo MCP.
//! Os mesmos passos da tela (`conversa::api`); o processo do agente vive no runtime do app, então as
//! partes assíncronas rodam com `tauri::async_runtime::block_on` (o handler está numa thread própria).
//!
//! Responder a uma aprovação do agente **não** existe aqui: quem aprova o que o agente da conversa
//! roda é a pessoa, na tela. `chat pending` só mostra o que espera.

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
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

/// Provedores que aceitam conversas estruturadas, separados da lista de agentes headless da Frota.
/// `commandAvailable: null` para ACP local: a configuração existe, mas seu executável fica
/// guardado no chaveiro e só é lido na hora de iniciar a conversa.
pub(super) fn chat_providers(app: &AppHandle, _args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let mut providers: Vec<Value> = [
        api::Engine::Codex,
        api::Engine::Claude,
        api::Engine::OpenCode,
        api::Engine::Antigravity,
        api::Engine::Cursor,
    ]
    .into_iter()
    .filter_map(|engine| {
        let agent_id = match engine {
            api::Engine::Codex => "codex",
            api::Engine::Claude => "claude-code",
            api::Engine::OpenCode => "opencode",
            api::Engine::Antigravity => "antigravity",
            api::Engine::Cursor => "cursor",
        };
        let def = crate::agents::agent_def(agent_id)?;
        Some(json!({
            "id": agent_id,
            "label": def.label,
            "kind": "built_in",
            "protocol": engine.protocol(),
            "configured": true,
            "commandAvailable": crate::agents::command_exists(def.command),
            "capabilities": engine.capabilities(),
        }))
    })
    .collect();

    for provider in crate::local_acp::list(&db)? {
        let mut capabilities = serde_json::to_value(api::Engine::OpenCode.capabilities())
            .map_err(|error| error.to_string())?;
        // O bridge ACP local não oferece escolha de modelo/esforço nem elevação de acesso.
        capabilities["accessModes"] = json!(["ask"]);
        capabilities["plan"] = json!(false);
        capabilities["persistentGoal"] = json!(false);
        capabilities["goalPauseResume"] = json!(false);
        providers.push(json!({
            "id": provider.id,
            "label": provider.label,
            "kind": "local_acp",
            "protocol": "agent-client-protocol",
            "configured": true,
            "commandAvailable": null,
            "capabilities": capabilities,
        }));
    }

    providers.sort_by(|left, right| {
        let left_builtin = left["kind"] == "built_in";
        let right_builtin = right["kind"] == "built_in";
        right_builtin.cmp(&left_builtin).then_with(|| {
            left["label"].as_str().unwrap_or_default()
                .to_lowercase()
                .cmp(&right["label"].as_str().unwrap_or_default().to_lowercase())
        })
    });
    Ok(json!({ "providers": providers }))
}

pub(super) fn chat_compact(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let instructions = arg_str_opt(args, "instructions");
    let db = db(app)?;
    tauri::async_runtime::block_on(api::compact_context(
        app,
        &db,
        &thread,
        instructions.as_deref(),
    ))?;
    Ok(json!({ "compacted": true, "thread": thread }))
}

pub(super) fn chat_goal(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let action = arg_str_opt(args, "action").unwrap_or_else(|| "show".into());
    let objective = arg_str_opt(args, "objective");
    let db = db(app)?;
    let goal = tauri::async_runtime::block_on(api::thread_goal_action(
        app,
        &db,
        &thread,
        &action,
        objective.as_deref(),
    ))?;
    Ok(json!({ "thread": thread, "goal": goal }))
}

pub(super) fn chat_new(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = arg_str(args, "text")
        .map_err(|_| "Falta a mensagem: ags chat new \"...\" --cwd <pasta>".to_string())?;
    let cwd = arg_str(args, "cwd").map_err(|_| "Falta a pasta: --cwd <pasta>".to_string())?;
    let db = db(app)?;
    let parent_ref = arg_str_opt(args, "parent_ref");
    let parent =
        match parent_ref.as_deref().and_then(|reference| reference.strip_prefix("thread:")) {
            Some(parent_id) => {
                let parent = api::thread(&db, parent_id)?;
                if parent.cwd != cwd {
                    return Err("A conversa filha precisa usar a mesma pasta da conversa de origem".into());
                }
                Some(parent)
            }
            None => None,
        };
    if parent_ref.as_deref().is_some_and(|reference| {
        !reference.starts_with("thread:") && !reference.starts_with("tab:")
    }) {
        return Err("A referência da conversa de origem precisa ser thread:<id> ou tab:<id>".into());
    }
    if parent_ref.as_deref().is_some_and(|reference| {
        reference.len() > 512 || reference.chars().any(char::is_control)
    }) {
        return Err("A referência da conversa de origem é inválida".into());
    }
    let agent_id = arg_str_opt(args, "agent")
        .or_else(|| parent.as_ref().map(|thread| thread.agent_id.clone()))
        .unwrap_or_else(|| "codex".into());
    let inherit_parent_settings = parent.as_ref().is_some_and(|thread| {
        thread.agent_id == agent_id && !crate::local_acp::is_local_acp_id(&agent_id)
    });
    let inherited_model = parent.as_ref().filter(|_| inherit_parent_settings).and_then(|thread| thread.model.clone());
    let inherited_effort = parent.as_ref().filter(|_| inherit_parent_settings).and_then(|thread| thread.effort.clone());
    let inherited_account = parent.as_ref().filter(|_| inherit_parent_settings).and_then(|thread| thread.account_id.clone());
    let context = arg_str_opt(args, "context");
    let prompt = crate::runs::delegated_prompt(&task, context.as_deref())?;
    let parented = parent_ref.is_some();
    let access = if parented {
        "ask".into()
    } else {
        arg_str_opt(args, "access").unwrap_or_else(|| "ask".into())
    };
    let input = NewThread {
        agent_id: agent_id.clone(),
        title: arg_str_opt(args, "title").unwrap_or_else(|| title_of(&task)),
        cwd: cwd.clone(),
        workspace_id: None,
        model: arg_str_opt(args, "model").or(inherited_model),
        effort: arg_str_opt(args, "effort").or(inherited_effort),
        // Aberta por um agente, a conversa começa supervisionada: o que ela rodar, a pessoa aprova.
        // Conversas-filhas também começam supervisionadas, sem herdar uma elevação de acesso.
        access,
        account_id: arg_str_opt(args, "account").or(inherited_account),
        parent_ref: parent_ref.clone(),
    };
    if let Some(identity) = child_request_identity(args, parent_ref.as_deref(), &cwd)? {
        let outcome = api::create_child(&db, input, &identity)?;
        let row = outcome.thread;
        if !outcome.reused {
            api::announce(app, &row);
        }
        match api::claim_child_delivery(&db, &identity)? {
            api::ChildDeliveryClaim::Claimed { thread_id } => {
                let send = tauri::async_runtime::block_on(api::send_mode(
                    app,
                    &db,
                    &thread_id,
                    &prompt,
                    crate::conversa::envio::SendMode::QueueAfterActive,
                    &[],
                ));
                match send {
                    Ok(()) => {
                        api::finish_child_delivery(&db, &identity, "accepted")?;
                        Ok(json!({
                            "thread": row,
                            "next": format!("ags chat wait {}", row.id),
                            "parented": parented,
                            "reused": outcome.reused,
                            "firstMessage": "accepted"
                        }))
                    }
                    Err(error) => {
                        let state = match &error {
                            crate::conversa::envio::SendError::Unknown(_) => "unknown",
                            crate::conversa::envio::SendError::Busy | crate::conversa::envio::SendError::NotSent(_) => "retryable",
                        };
                        api::finish_child_delivery(&db, &identity, state)?;
                        Ok(json!({
                            "thread": row,
                            "next": format!("ags chat wait {}", row.id),
                            "parented": parented,
                            "reused": outcome.reused,
                            "firstMessage": state,
                            "sendError": error.to_string(),
                            "retry": if state == "retryable" { "Repeat chat_new with the same client_request_id to retry safely." } else { "Do not resend this request; inspect the child chat because the provider may have received the message." }
                        }))
                    }
                }
            }
            api::ChildDeliveryClaim::AlreadyClaimed { state, .. } => {
                let warning = match state.as_str() {
                    "accepted" => "The first message was accepted by the provider; this repeated request did not send it again.",
                    "submitting" | "unknown" => "The first message may have reached the provider; inspect the child chat before sending another message.",
                    "retryable" | "prepared" => "The first message was not submitted; repeat chat_new with the same client_request_id to retry.",
                    _ => "The first-message state is unavailable; inspect the child chat before retrying.",
                };
                Ok(json!({
                    "thread": row,
                    "next": format!("ags chat wait {}", row.id),
                    "parented": parented,
                    "reused": true,
                    "firstMessage": state,
                    "note": warning
                }))
            }
        }
    } else {
        let row = api::create(&db, input)?;
        api::announce(app, &row);
        tauri::async_runtime::block_on(api::send(app, &db, &row.id, &prompt))?;
        Ok(json!({ "thread": row, "next": format!("ags chat wait {}", row.id), "parented": parented }))
    }
}

fn child_request_identity(
    args: &Value,
    parent_ref: Option<&str>,
    cwd: &str,
) -> Result<Option<api::ChildRequestIdentity>, String> {
    let read_id = |key: &str| -> Result<Option<String>, String> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim().to_string())),
            Some(Value::String(_)) => Err("client_request_id não pode ficar vazio".into()),
            Some(_) => Err("client_request_id precisa ser texto".into()),
        }
    };
    let snake = read_id("client_request_id")?;
    let camel = read_id("clientRequestId")?;
    if snake.is_some() && camel.is_some() && snake != camel {
        return Err("client_request_id e clientRequestId não podem ter valores diferentes".into());
    }
    let Some(request_id) = snake.or(camel) else { return Ok(None) };
    if request_id.len() > 128 || request_id.chars().any(char::is_control) {
        return Err("client_request_id deve ter até 128 caracteres sem controles".into());
    }
    let mut normalized = args.clone();
    if let Some(object) = normalized.as_object_mut() {
        object.remove("client_request_id");
        object.remove("clientRequestId");
    }
    let bytes = serde_json::to_vec(&normalized).map_err(|error| error.to_string())?;
    let request_hash = format!("{:x}", Sha256::digest(bytes));
    let scope = parent_ref.map(str::to_string).unwrap_or_else(|| format!("cwd:{cwd}"));
    let caller_key = format!("chat-new:{:x}", Sha256::digest(scope.as_bytes()));
    Ok(Some(api::ChildRequestIdentity { caller_key, request_id, request_hash }))
}

pub(super) fn chat_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let text = arg_str(args, "text").map_err(|_| "Falta a mensagem: ags chat send <id> \"...\"".to_string())?;
    let db = db(app)?;
    api::thread(&db, &thread)?;
    let next = format!("ags chat wait {thread}");
    // Sem `client_request_id`, o caminho é o de sempre: sem recibo e sem efeito.
    let Some(request_id) = send_request_id(args)? else {
        tauri::async_runtime::block_on(api::send(app, &db, &thread, &text))?;
        return Ok(json!({ "sent": true, "next": next }));
    };
    // Quem chamou: o MCP carimba o escopo da sessão (aba ou conversa); a CLI e o resto caem em `cli`.
    let scope = arg_str_opt(args, "caller_scope").unwrap_or_else(|| "cli".into());
    let receipt = tauri::async_runtime::block_on(api::send_with_request(app, &db, &thread, &text, &[], &scope, &request_id))?;
    Ok(json!({ "sent": receipt.sent, "receipt": receipt, "next": next }))
}

/// O `client_request_id` (ou `clientRequestId`) de um envio, validado. `None` quando não veio.
pub(crate) fn send_request_id(args: &Value) -> Result<Option<String>, String> {
    let read = |key: &str| -> Result<Option<String>, String> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => crate::harness::receipts::validate_request_id(value).map(Some),
            Some(_) => Err("client_request_id precisa ser texto".into()),
        }
    };
    let (snake, camel) = (read("client_request_id")?, read("clientRequestId")?);
    if snake.is_some() && camel.is_some() && snake != camel {
        return Err("client_request_id e clientRequestId não podem ter valores diferentes".into());
    }
    Ok(snake.or(camel))
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

pub(super) fn chat_stop(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let thread = thread_arg(args)?;
    let db = db(app)?;
    // O escopo de quem para vem da sessão do MCP (`caller_scope`). Sem ele, quem para é a pessoa.
    let scope = arg_str_opt(args, "caller_scope");
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        api::check_stop_scope(&conn, scope.as_deref(), &thread)?;
    }
    // Sem `client_request_id`, o caminho é o de sempre: sem recibo e sem efeito.
    let Some(request_id) = send_request_id(args)? else {
        tauri::async_runtime::block_on(api::stop(app, &db, &thread))?;
        return Ok(json!({ "stopped": true }));
    };
    // Com o id, o Parar tem recibo: repetir não manda outra interrupção (contrato §11.11).
    let scope = scope.unwrap_or_else(|| "cli".into());
    let receipt = tauri::async_runtime::block_on(api::stop_with_request(app, &db, &thread, &scope, &request_id))?;
    Ok(json!({ "stopped": true, "sent": receipt.sent, "receipt": receipt, "next": format!("ags chat wait {thread}") }))
}

/// O que os agentes das conversas esperam da pessoa (de uma conversa, ou de todas).
pub(super) fn chat_pending(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let ids: Vec<String> = match arg_str_opt(args, "thread") {
        Some(id) => vec![id],
        None => api::threads(&db)?.into_iter().filter(|t| t.state == "active").map(|t| t.id).collect(),
    };
    let mut pending = Vec::new();
    let mut decided = Vec::new();
    for id in ids {
        pending.extend(api::requests(&db, &id)?);
        // Quem respondeu os últimos pedidos (a pessoa, a política do time ou uma regra dela) e por quê.
        let recent = db.lock().map_err(|e| e.to_string())?;
        for d in crate::conversa::store::recent_decisions(&recent, &id, 5).map_err(|e| e.to_string())? {
            decided.push(json!({ "requestId": d.request_id, "threadId": id, "answer": d.answer, "decidedBy": d.by, "why": d.why }));
        }
    }
    Ok(json!({ "pending": pending, "decided": decided }))
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
