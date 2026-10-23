//! Uma linha do rollout do Codex (`~/.codex/sessions/AAAA/MM/DD/rollout-<data>-<id>.jsonl`)
//! virando eventos normalizados. Formato conferido no codex-cli 0.163.0 desta máquina (ver
//! `docs/ade-ags/CANAL_ESTRUTURADO.md`). Pura: nada aqui lê disco.
//!
//! O rollout NÃO grava os pedidos de aprovação (`exec_approval_request`) nem as respostas: em 14
//! turnos com `approval_policy: on-request` não há nenhum. Os braços `*_approval_request`
//! abaixo existem para uma versão futura que passe a gravá-los; nenhuma linha desta máquina os tem.

use serde_json::Value;

use super::event::{clip, first_line, EndReason, Event, Tokens};

fn tokens_of(v: &Value) -> Option<Tokens> {
    let n = |key: &str| v.get(key).and_then(Value::as_u64).unwrap_or(0);
    v.get("input_tokens")?;
    let cached = n("cached_input_tokens");
    Some(Tokens {
        // No Codex o `input_tokens` já inclui o que veio do cache.
        input: n("input_tokens").saturating_sub(cached),
        output: n("output_tokens"),
        cached,
        cache_write: n("cache_write_input_tokens"),
    })
}

/// O resumo de uma chamada: o comando do `exec`/`shell`, ou a primeira linha do input.
fn call_summary(payload: &Value) -> String {
    let parsed = payload
        .get("arguments")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    if let Some(args) = &parsed {
        let cmd = args.get("cmd").or_else(|| args.get("command"));
        match cmd {
            Some(Value::String(s)) => return first_line(s, 160),
            Some(Value::Array(parts)) => {
                let joined: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
                return first_line(&joined.join(" "), 160);
            }
            _ => {}
        }
    }
    if let Some(input) = payload.get("input").and_then(Value::as_str) {
        return first_line(input, 160);
    }
    String::new()
}

/// A pergunta de um `request_user_input` (modo plano). Formato não visto nesta máquina: lê-se o
/// que der, sem falhar.
fn question_of(id: &str, payload: &Value) -> Option<Event> {
    let args: Value = serde_json::from_str(payload.get("arguments")?.as_str()?).ok()?;
    let first = args.pointer("/questions/0").unwrap_or(&args);
    let text = first.get("question").or_else(|| first.get("prompt")).and_then(Value::as_str)?;
    let options = first
        .get("options")
        .and_then(Value::as_array)
        .map(|o| o.iter().filter_map(|x| x.get("label").and_then(Value::as_str).or_else(|| x.as_str())).map(|l| clip(l, 120)).collect())
        .unwrap_or_default();
    Some(Event::Question { id: id.to_string(), text: clip(text, 600), options })
}

pub fn events(line: &Value) -> Vec<Event> {
    let Some(payload) = line.get("payload") else { return vec![] };
    let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
    match line.get("type").and_then(Value::as_str) {
        Some("event_msg") => match kind {
            "task_started" => vec![Event::TurnStarted],
            "task_complete" => {
                let text = payload.get("last_agent_message").and_then(Value::as_str).map(|t| clip(t, 2000));
                vec![Event::TurnEnded { reason: EndReason::Completed, text }]
            }
            "turn_aborted" => vec![Event::TurnEnded { reason: EndReason::Interrupted, text: None }],
            "token_count" => {
                let Some(info) = payload.get("info").filter(|i| !i.is_null()) else { return vec![] };
                let Some(last) = info.get("last_token_usage").and_then(tokens_of) else { return vec![] };
                let total = info.get("total_token_usage").and_then(tokens_of);
                vec![Event::Usage { key: None, last, total }]
            }
            "agent_message" => payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(|t| vec![Event::AssistantText(clip(t, 2000))])
                .unwrap_or_default(),
            "exec_approval_request" | "apply_patch_approval_request" => {
                let id = payload.get("call_id").and_then(Value::as_str).unwrap_or_default().to_string();
                let summary = match payload.get("command") {
                    Some(Value::Array(parts)) => first_line(&parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "), 160),
                    Some(Value::String(s)) => first_line(s, 160),
                    _ => first_line(payload.get("reason").and_then(Value::as_str).unwrap_or("aplicar patch"), 160),
                };
                if id.is_empty() { vec![] } else { vec![Event::ApprovalRequested { id, summary }] }
            }
            _ => vec![],
        },
        Some("response_item") => match kind {
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let Some(id) = payload.get("call_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return vec![] };
                let name = payload.get("name").and_then(Value::as_str).unwrap_or(kind).to_string();
                let mut out = vec![Event::ToolStarted { id: id.to_string(), name: name.clone(), summary: call_summary(payload) }];
                if name == "request_user_input" {
                    out.extend(question_of(id, payload));
                }
                out
            }
            "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => payload
                .get("call_id")
                .and_then(Value::as_str)
                .map(|id| vec![Event::ToolFinished { id: id.to_string(), decision: None }])
                .unwrap_or_default(),
            "message" if payload.get("role").and_then(Value::as_str) == Some("assistant") => {
                let text: Vec<&str> = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|blocks| blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect())
                    .unwrap_or_default();
                let joined = text.join("\n");
                if joined.trim().is_empty() { vec![] } else { vec![Event::AssistantText(clip(&joined, 2000))] }
            }
            _ => vec![],
        },
        _ => vec![],
    }
}
