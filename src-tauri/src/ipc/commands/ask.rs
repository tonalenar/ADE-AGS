//! `user.ask`: un agente preguntándole algo a la persona que lo está mirando.
//!
//! Hay cosas que un agente no puede averiguar leyendo: con qué usuario probar, si el diseño
//! nuevo va arriba o al costado, cuál de dos caminos prefiere quien pidió el trabajo.
//! Hasta ahora la única salida era adivinar o dejarlo escrito en el resultado y frenar.
//!
//! Es lo contrario de `approve_tool_use`: ahí el agente pide permiso para algo que ya
//! decidió; acá pide que decidan por él. Por eso no pasa por el broker ni por reglas —una
//! pregunta no se puede "recordar"— y lo resuelve el frontend, que es donde está la persona.
//!
//! Prazo (ponto 19 do deepseek-harness): ao vencer, o agente recebe `status: "pending"` — nunca
//! uma resposta nem uma aprovação — e segue com o que é independente. A pergunta continua na tela;
//! se a pessoa responder depois, a resposta chega à aba como mensagem. E um integrante de time não
//! pergunta direto à pessoa: recebe `refused` com o nome do orquestrador para levar a dúvida a ele.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};

/// Cuánto espera una pregunta. Largo como el de los permisos y por lo mismo: del otro lado
/// hay alguien que puede estar en otra cosa, y cortar a los treinta segundos convertiría
/// "todavía no la vi" en "no contestó".
const ASK_TIMEOUT_SECS: u64 = 1800;
/// Prazo padrão: depois disso o agente segue com `pending` e a resposta tardia vira mensagem.
const ASK_DEFAULT_SECS: u64 = 600;

/// Cuántas opciones se pueden ofrecer. Más que esto no es una pregunta: es un menú, y
/// entra mejor como texto libre.
const MAX_OPTIONS: usize = 6;

/// A frase para o integrante que tentou perguntar à pessoa. `None` = pode perguntar (orquestrador,
/// aba solta ou tarefa da frota). Pura.
pub(crate) fn member_refusal(lead: Option<&str>) -> Option<Value> {
    let lead = lead?.trim();
    let lead = if lead.is_empty() { "o orquestrador" } else { lead };
    Some(json!({
        "refused": true,
        "reason": "ask_lead",
        "lead": lead,
        "text": format!(
            "Você é integrante de um time: não pergunte direto à pessoa. Leve a dúvida ao orquestrador com \
`ags peer tell \"{lead}\" \"<pergunta>\"` (ele decide ou pergunta à pessoa) e siga com o que não depende dela."
        ),
    }))
}

/// O orquestrador do time de `tab`, se ela é integrante (não o próprio orquestrador): o time do modo
/// chat, senão a equipe do canvas.
fn lead_of(app: &AppHandle, tab: &str) -> Option<String> {
    use tauri::Manager;
    if let Some(db) = app.try_state::<crate::database::DbConnection>()
        && let Ok(conn) = db.lock()
        && let Some(view) = crate::chat_team::api::team_of(&conn, tab).ok().flatten()
    {
        return (view.team.led() && view.team.orchestrator != tab).then(|| crate::chat_team::api::orchestrator_peer_name(&conn, &view.team));
    }
    let boards = crate::canvas::load_boards();
    if crate::canvas::is_orchestrator(&boards, tab) {
        return None;
    }
    let lead = crate::canvas::team_of(&boards, tab).into_iter().find(|t| t != tab && crate::canvas::is_orchestrator(&boards, t))?;
    let name = super::peers::open_tabs(app).ok().and_then(|tabs| tabs.into_iter().find(|t| t.id == lead).map(|t| t.name));
    Some(name.unwrap_or(lead))
}

/// O que o agente recebe quando o prazo vence sem resposta. Nunca é aprovação. Pura.
pub(crate) fn pending_reply(timeout: u64, late_as_message: bool) -> Value {
    let later = if late_as_message {
        "Se a pessoa responder depois, a resposta chega a você como mensagem: não pergunte de novo."
    } else {
        "Se precisar mesmo da resposta, registre a dúvida no seu resultado."
    };
    json!({
        "status": "pending",
        "text": format!(
            "PENDENTE: a pessoa não respondeu em {timeout} s. Isto NÃO é uma resposta nem uma aprovação. \
Siga com o que não depende dela e não decida por ela o que perguntou. {later}"
        ),
    })
}

pub(super) fn user_ask(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let question = args
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| "falta a pergunta ('question')".to_string())?;

    let options: Vec<String> = args
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|o| !o.is_empty())
                .take(MAX_OPTIONS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let timeout = args
        .get("timeout_s")
        .and_then(Value::as_u64)
        .unwrap_or(ASK_DEFAULT_SECS)
        .clamp(30, ASK_TIMEOUT_SECS);

    let tab = args.get("tabId").and_then(Value::as_str).filter(|t| !t.is_empty());
    if let Some(refusal) = tab.and_then(|tab| member_refusal(lead_of(app, tab).as_deref())) {
        return Ok(refusal);
    }
    let task = args.get("taskId").and_then(Value::as_str).filter(|t| !t.is_empty());
    let owner = match (tab, task) {
        (Some(tab), _) => json!({ "kind": "tab", "id": tab }),
        (None, Some(task)) => json!({ "kind": "task", "id": task }),
        (None, None) => Value::Null,
    };

    let raw = ask_frontend_within(
        app,
        "user.ask",
        &json!({
            "question": question,
            "options": options,
            "placeholder": args.get("placeholder").and_then(Value::as_str),
            // Quién pregunta, para que la tarjeta lo diga: con varios agentes corriendo,
            // "¿cuál de todos me está preguntando esto?" no puede quedar sin respuesta.
            "taskId": task,
            "tabId": tab,
            "owner": owner,
            "cwd": args.get("cwd").and_then(Value::as_str),
            // O mesmo prazo dos dois lados: a tela vence antes e devolve `pending`.
            "timeout_s": timeout,
        }),
        None,
        // Margen sobre lo que espera el frontend: si vence allá, vence allá y contesta.
        Duration::from_secs(timeout + 30),
    )?;
    let reply = unwrap_frontend_result(raw)?;
    if reply.get("status").and_then(Value::as_str) == Some("pending") {
        // Só a tela sabe se a aba ainda existe para receber a resposta tardia.
        return Ok(pending_reply(timeout, reply.get("lateAsMessage").and_then(Value::as_bool) == Some(true)));
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::{member_refusal, pending_reply};

    #[test]
    fn integrante_leva_a_duvida_ao_orquestrador() {
        assert!(member_refusal(None).is_none(), "orquestrador ou aba solta pergunta à pessoa");
        let out = member_refusal(Some("Líder")).unwrap();
        assert_eq!(out["refused"], true);
        assert_eq!(out["reason"], "ask_lead");
        assert!(out["text"].as_str().unwrap().contains("ags peer tell \"Líder\""));
        assert_eq!(member_refusal(Some(" ")).unwrap()["lead"], "o orquestrador");
    }

    #[test]
    fn prazo_vencido_e_pendente_nunca_aprovacao() {
        let out = pending_reply(600, true);
        assert_eq!(out["status"], "pending");
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("NÃO é uma resposta nem uma aprovação") && text.contains("como mensagem"), "{text}");
        assert!(!pending_reply(600, false)["text"].as_str().unwrap().contains("como mensagem"));
    }
}
