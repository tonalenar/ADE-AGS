//! O evento que os processos dos agentes (`codex`, `claude`) mandam à janela, e o aviso no
//! barramento que acorda `ags chat wait`.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// O evento da janela.
pub const EVENT: &str = "cc-chat-thread";

/// Manda `cc-chat-thread` à janela. O que muda o "está esperando o quê" (fase, pedidos, processo
/// fechado) vai também ao barramento (`chat.changed`): é o que acorda `ags chat wait`, sem polling.
pub fn emit(app: &AppHandle, thread_id: &str, kind: &str, mut payload: Value) {
    payload["threadId"] = json!(thread_id);
    payload["type"] = json!(kind);
    if matches!(kind, "phase" | "request" | "requestResolved" | "closed") {
        let data = json!({ "threadId": thread_id, "type": kind, "phase": payload.get("phase") });
        crate::bus::publish(Some(app), crate::bus::Publish::new(crate::ipc::commands::conversas::BUS_TOPIC).data(data));
    }
    let _ = app.emit(EVENT, payload);
}
