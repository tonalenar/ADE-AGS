//! Papéis do canvas: `ags roles | role show|create|edit`.
//!
//! Listar e ler está aberto a qualquer agente. Criar e editar é só do orquestrador: um
//! papel é uma instrução que vai para todo agente recrutado depois, então não é algo que
//! qualquer um deva poder mudar (ver `crate::canvas::roles`).

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::caller;
use crate::canvas::{self, roles};
use crate::ipc::protocol::{arg_str, arg_str_opt};

fn describe(r: &roles::Role) -> Value {
    json!({ "id": r.id, "name": r.label, "builtin": r.builtin })
}

pub(super) fn role_list(_app: &AppHandle, _args: &Value) -> Result<Value, String> {
    Ok(json!({ "roles": roles::all().iter().map(describe).collect::<Vec<_>>() }))
}

pub(super) fn role_show(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let all = roles::all();
    let role = roles::resolve(&all, &arg_str(args, "role")?)?;
    Ok(json!({ "role": { "id": role.id, "name": role.label, "builtin": role.builtin, "instructions": role.instructions } }))
}

/// Quem cria ou edita tem que ser orquestrador.
fn require_orchestrator(args: &Value) -> Result<(), String> {
    let from = caller(args)?;
    if canvas::is_orchestrator(&canvas::load_boards(), &from) {
        Ok(())
    } else {
        Err("Só um orquestrador cria ou edita papéis. O usuário marca um agente como orquestrador no canvas (coroa no cabeçalho do nó).".into())
    }
}

pub(super) fn role_create(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    require_orchestrator(args)?;
    // O texto vem como `--content` (ou `--file`, que a CLI converte em `content`).
    let role = roles::create(&arg_str(args, "name")?, &arg_str(args, "content")?)?;
    Ok(json!({ "created": describe(&role) }))
}

pub(super) fn role_edit(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    require_orchestrator(args)?;
    let role = roles::edit(
        &arg_str(args, "role")?,
        arg_str_opt(args, "name").as_deref(),
        arg_str_opt(args, "content").as_deref(),
    )?;
    Ok(json!({ "edited": describe(&role) }))
}
