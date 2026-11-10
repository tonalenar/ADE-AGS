//! O evento que os processos dos agentes (`codex`, `claude`) mandam à janela, e o aviso no
//! barramento que acorda `ags chat wait`.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// O evento da janela.
pub const EVENT: &str = "cc-chat-thread";

/// Os tipos que passam pela fila de gravação (o log de execução). Os deltas não entram: são transitórios.
const LOGGED_KINDS: [&str; 10] = ["created", "phase", "item", "request", "requestResolved", "task", "taskItem", "goal", "error", "closed"];

/// Fase, pedido e fechamento: o que acorda `ags chat wait` pelo barramento e o que só sai depois da gravação.
fn is_conclusion(kind: &str) -> bool {
    matches!(kind, "phase" | "request" | "requestResolved" | "closed")
}

/// Manda `cc-chat-thread` à janela. O que muda o "está esperando o quê" (fase, pedidos, processo fechado) vai também
/// ao barramento (`chat.changed`): é o que acorda `ags chat wait`, sem polling. A conclusão só sai depois da tentativa
/// de gravação (contrato §11.4): com banco, quem a publica é a fila de gravação.
pub fn emit(app: &AppHandle, thread_id: &str, kind: &str, mut payload: Value) {
    payload["threadId"] = json!(thread_id);
    payload["type"] = json!(kind);
    let conclusion = is_conclusion(kind);
    // Deltas são transitórios e não entram no log. Os demais tipos passam por uma fila serial para persistir sem
    // bloquear o adapter nem descartar evento se o SQLite estiver ocupado.
    if LOGGED_KINDS.contains(&kind) {
        if let Some(db) = app.try_state::<crate::database::DbConnection>() {
            if conclusion {
                crate::runs::execution_log::queue_chat_event(app, db.inner().clone(), thread_id.to_string(), kind.to_string(), payload, true);
                return;
            }
            crate::runs::execution_log::queue_chat_event(app, db.inner().clone(), thread_id.to_string(), kind.to_string(), payload.clone(), false);
        }
    }
    if conclusion {
        // Sem banco não há o que gravar: a conclusão sai já.
        publish_conversation(app, &payload, true);
        return;
    }
    let _ = app.emit(EVENT, payload);
}

/// Publica uma conversa na janela e, para fase, pedido ou fechamento, no barramento (`chat.changed`). `logged` diz se a
/// gravação está em dia: `false` quando a falha foi registrada e o sinal `harness.log_failed` saiu.
pub(crate) fn publish_conversation(app: &AppHandle, payload: &Value, logged: bool) {
    let kind = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    if is_conclusion(kind) {
        let data = json!({ "threadId": payload.get("threadId"), "type": kind, "phase": payload.get("phase"), "logged": logged });
        crate::bus::publish(Some(app), crate::bus::Publish::new(crate::ipc::commands::conversas::BUS_TOPIC).data(data));
    }
    let _ = app.emit(EVENT, payload);
}
