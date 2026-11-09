//! Pedidos privados de segredo: o valor não passa pelo chat nem pela resposta MCP.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::ipc::{
    bridge::{ask_frontend_within, unwrap_frontend_result},
    protocol::{arg_str, arg_str_opt},
};

const REQUEST_TIMEOUT_MAX_SECS: u64 = 1800;

fn authorized_owner(args: &Value) -> Result<String, String> {
    let session = arg_str_opt(args, "session").filter(|value| !value.trim().is_empty());
    let from = arg_str_opt(args, "from").filter(|value| !value.trim().is_empty());
    crate::terminal::authorize_actor(
        session.as_deref(),
        from.as_deref(),
        crate::ipc::current_client_pid(),
    )
}

pub(super) fn request(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let owner = authorized_owner(args)?;
    if let Some(refusal) = super::ask::member_refusal(super::ask::lead_of(app, &owner).as_deref()) {
        return Ok(refusal);
    }
    let raw_label = arg_str(args, "label")?;
    let label = raw_label.trim();
    if label.is_empty() || label.chars().count() > 200 {
        return Err("Informe uma identificação de até 200 caracteres".into());
    }
    let description = args
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if description.chars().count() > 1000 {
        return Err("A descrição do pedido ultrapassa 1.000 caracteres".into());
    }
    let timeout = args
        .get("timeout_s")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, REQUEST_TIMEOUT_MAX_SECS);

    let raw = ask_frontend_within(
        app,
        "user.secret",
        &json!({
            "tabId": owner,
            "owner": {
                "kind": if owner.starts_with("thread:") { "thread" } else { "tab" },
                "id": owner,
            },
            "label": label,
            "description": description,
            "timeout_s": timeout,
        }),
        None,
        std::time::Duration::from_secs(timeout + 30),
    )?;
    let reply = unwrap_frontend_result(raw)?;
    if reply.get("status").and_then(Value::as_str) == Some("pending") {
        return Ok(
            json!({ "status": "pending", "text": "O pedido de segredo expirou sem resposta; nenhum segredo foi salvo." }),
        );
    }
    let secret = reply
        .get("secret")
        .and_then(Value::as_str)
        .filter(|secret| !secret.trim().is_empty())
        .ok_or("O pedido de segredo foi recusado")?;

    let (id, expires_at) = crate::agent_secrets::issue(&owner, label, secret)?;
    Ok(json!({
        "id": id,
        "expiresAt": expires_at,
        "text": format!("Segredo salvo no cofre do sistema para esta conversa por até 24 horas. Referência: {id}. Use secret_run para enviá-lo somente pelo stdin de um programa, ou secret_revoke para removê-lo antes."),
    }))
}

pub(super) fn consume(args: &Value) -> Result<Value, String> {
    let owner = authorized_owner(args)?;
    let id = arg_str(args, "secretId")?;
    let secret = crate::agent_secrets::consume(&owner, &id)?;
    Ok(json!({ "secret": secret }))
}

pub(super) fn revoke(args: &Value) -> Result<Value, String> {
    let owner = authorized_owner(args)?;
    let id = arg_str(args, "secretId")?;
    let revoked = crate::agent_secrets::revoke(&owner, &id)?;
    Ok(json!({
        "revoked": revoked,
        "text": if revoked { "Segredo revogado e removido do cofre." } else { "Esse segredo já foi removido ou expirou." },
    }))
}

pub(crate) fn cleanup_expired_agent_secrets() {
    crate::agent_secrets::cleanup_expired();
}
