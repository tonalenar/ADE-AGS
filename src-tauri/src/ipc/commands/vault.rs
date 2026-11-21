//! Comandos IPC do cofre de logins (`vault.list`, `vault.request`, `vault.fill`).
//!
//! Nenhuma senha transita pela resposta IPC: `vault.list` devolve apenas metadados;
//! `vault.request` pede ao frontend que salve direto via comando Tauri `vault_add`;
//! `vault.fill` pede ao frontend que preencha no navegador da aba usando `vault_secret_for_fill`.

use std::time::Duration;

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::ipc::{
    bridge::{ask_frontend_within, unwrap_frontend_result},
    protocol::{arg_str, arg_str_opt},
};

const REQUEST_TIMEOUT_MAX_SECS: u64 = 1800;
const FILL_TIMEOUT_SECS: u64 = 360;

fn authorized_owner(args: &Value) -> Result<String, String> {
    let session = arg_str_opt(args, "session").filter(|value| !value.trim().is_empty());
    let from = arg_str_opt(args, "from").filter(|value| !value.trim().is_empty());
    crate::terminal::authorize_actor(
        session.as_deref(),
        from.as_deref(),
        crate::ipc::current_client_pid(),
    )
}

fn owner_payload(owner: &str) -> Value {
    json!({
        "kind": if owner.starts_with("thread:") { "thread" } else { "tab" },
        "id": owner,
    })
}

pub(super) fn list(args: &Value) -> Result<Value, String> {
    let _owner = authorized_owner(args)?;
    let entries: Vec<Value> = crate::vault::list()?
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "origin": entry.origin,
                "username": entry.username,
                "label": entry.label,
            })
        })
        .collect();
    Ok(json!({ "entries": entries }))
}

pub(super) fn request(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let owner = authorized_owner(args)?;
    let raw_origin = arg_str(args, "origin")?;
    let origin = crate::vault::normalize_origin(&raw_origin)?;
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if reason.chars().count() > 1000 {
        return Err("O motivo do pedido ultrapassa 1.000 caracteres".into());
    }
    let timeout = args
        .get("timeout_s")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, REQUEST_TIMEOUT_MAX_SECS);

    let raw = ask_frontend_within(
        app,
        "vault.request",
        &json!({
            "tabId": owner,
            "owner": owner_payload(&owner),
            "origin": origin,
            "reason": reason,
            "timeout_s": timeout,
        }),
        None,
        Duration::from_secs(timeout + 30),
    )?;
    let reply = unwrap_frontend_result(raw)?;
    if reply.get("declined").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "declined": true }));
    }
    if reply.get("status").and_then(Value::as_str) == Some("pending") {
        return Ok(json!({ "declined": true, "status": "pending" }));
    }
    let id = reply
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("O cadastro no cofre foi recusado")?;
    Ok(json!({ "id": id }))
}

pub(super) fn fill(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let owner = authorized_owner(args)?;
    let cwd = arg_str(args, "cwd")?;
    let id = arg_str_opt(args, "id").filter(|value| !value.trim().is_empty());
    let origin = arg_str_opt(args, "origin").filter(|value| !value.trim().is_empty());
    let submit = args.get("submit").and_then(Value::as_bool).unwrap_or(false);

    if let Some(ref requested_id) = id {
        let entries = crate::vault::list()?;
        if !entries.iter().any(|candidate| candidate.id == *requested_id) {
            return Err("not_found: Login não encontrado no cofre".into());
        }
    }

    let window = super::browser::window_for_caller(app, Some(owner.as_str()), &cwd)?;
    let mut request = json!({
        "op": "fillLogin",
        "submit": submit,
        "agentId": owner,
    });
    if let Some(id) = id {
        request["id"] = json!(id);
    }
    if let Some(origin) = origin {
        request["origin"] = json!(origin);
    }

    let raw = ask_frontend_within(
        app,
        "browser.run",
        &json!({
            "cwd": cwd,
            "owner": owner_payload(&owner),
            "request": request,
        }),
        window.as_deref(),
        Duration::from_secs(FILL_TIMEOUT_SECS),
    )?;
    unwrap_frontend_result(raw)
}
