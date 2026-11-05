//! As tarefas em segundo plano de uma conversa por protocolo: o que alimenta o painel "Tarefas em
//! segundo plano" do chat (`src/features/chat/tasks/`). Puro.
//!
//! O evento `task` da janela tem `op` (`started`, `updated`, `ended`, `live`), `taskId`, `at` e o
//! que o motor disse (`kind`, `title`, `status`, `summary`…). Nada disso vai ao banco da timeline: a
//! tela guarda a lista (ver `tasksStore.ts`).
//!
//! O que cada motor expõe:
//! - **Claude Code** (2.1.318, lido no binário e conferido numa conversa de verdade): as linhas
//!   `system` `task_started` (com `task_type` `local_bash`/`local_agent`, `tool_use_id`,
//!   `parent_task_id`, `is_backgrounded`, `prompt`), `task_progress`, `task_updated` (`patch.status`),
//!   `task_notification` (`completed`/`failed`/`stopped`, `summary`, `usage`) e
//!   `background_tasks_changed` (o conjunto inteiro das vivas). Para uma tarefa só: o `control_request`
//!   `stop_task`; a saída de um shell: `get_task_output` (os últimos 8 KiB). O que o subagente faz
//!   vem nas linhas com `parent_tool_use_id` (ver `claude_map::Out::SubItem`).
//! - **Codex** (`app-server` 0.166, pelos tipos gerados): o item `collabAgentToolCall` (`spawnAgent`
//!   cria o agente, os outros trazem `agentsStates`) e o `subAgentActivity`. Parar um agente só daqui
//!   pediria o turno da thread dele, que o app não acompanha: a tarefa não se para.

use serde_json::{json, Map, Value};

use crate::canal::event::{clip, first_line};

const TITLE_MAX: usize = 200;
const TEXT_MAX: usize = 4_000;

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Um evento `task` com os campos que vieram (os vazios ficam de fora).
fn event(op: &str, task_id: &str, at: i64, fields: &[(&str, Option<Value>)]) -> Value {
    let mut map = Map::new();
    map.insert("op".into(), json!(op));
    map.insert("taskId".into(), json!(task_id));
    map.insert("at".into(), json!(at));
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert((*key).into(), value.clone());
        }
    }
    Value::Object(map)
}

fn text(v: &Value, key: &str) -> Option<Value> {
    str_of(v, key).map(|s| json!(clip(s, TEXT_MAX)))
}

fn title(v: &Value, key: &str) -> Option<Value> {
    str_of(v, key).map(|s| json!(first_line(s, TITLE_MAX)))
}

fn plain(v: &Value, key: &str) -> Option<Value> {
    str_of(v, key).map(|s| json!(s))
}

/// O `task_type` do Claude no tipo do painel.
fn claude_kind(task_type: Option<&str>) -> &'static str {
    match task_type {
        Some("local_bash" | "monitor" | "local_monitor") => "shell",
        Some("local_agent" | "remote_agent") => "agent",
        _ => "other",
    }
}

/// O status de um `task_updated` do Claude: `None` para o que não muda o painel (`paused`).
fn claude_patch_status(status: &str) -> Option<&'static str> {
    match status {
        "completed" => Some("completed"),
        "failed" => Some("failed"),
        "killed" => Some("stopped"),
        "running" | "pending" => Some("running"),
        _ => None,
    }
}

fn usage_fields(usage: Option<&Value>) -> [(&'static str, Option<Value>); 3] {
    let num = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_i64).map(|n| json!(n));
    [("durationMs", num("duration_ms")), ("tokens", num("total_tokens")), ("toolUses", num("tool_uses"))]
}

/// O evento `task` de uma linha do Claude Code, ou `None` se a linha não é de tarefa. As tarefas de
/// bastidor (`ambient`: os vigias que o próprio Claude liga) ficam de fora. O caminho do arquivo de
/// saída (`output_file`) nunca sai daqui. `now` é o carimbo das linhas que não trazem o seu.
pub fn claude_task(line: &Value, now: i64) -> Option<Value> {
    if str_of(line, "type") != Some("system") {
        return None;
    }
    let subtype = str_of(line, "subtype")?;
    if subtype == "background_tasks_changed" {
        let live: Vec<&str> = line.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .filter(|t| t.get("ambient").and_then(Value::as_bool) != Some(true))
            .filter_map(|t| str_of(t, "task_id"))
            .collect();
        return Some(event("live", "", now, &[("live", Some(json!(live)))]));
    }
    let task_id = str_of(line, "task_id")?;
    match subtype {
        "task_started" => {
            if line.get("ambient").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let kind = claude_kind(str_of(line, "task_type"));
            Some(event("started", task_id, now, &[
                ("toolUseId", plain(line, "tool_use_id")),
                ("parentTaskId", plain(line, "parent_task_id")),
                ("kind", Some(json!(kind))),
                ("title", title(line, "description")),
                ("subagent", plain(line, "subagent_type")),
                ("prompt", text(line, "prompt")),
                ("status", Some(json!("running"))),
                ("background", Some(json!(line.get("is_backgrounded").and_then(Value::as_bool).unwrap_or(false)))),
                // O `stop_task` vale para os shells e os subagentes desta sessão.
                ("stoppable", Some(json!(kind != "other"))),
            ]))
        }
        "task_progress" => {
            let mut fields = vec![("title", title(line, "description")), ("summary", text(line, "summary")), ("lastTool", plain(line, "last_tool_name"))];
            fields.extend(usage_fields(line.get("usage")));
            Some(event("updated", task_id, now, &fields))
        }
        "task_updated" => {
            let patch = line.get("patch")?;
            let status = str_of(patch, "status").and_then(claude_patch_status);
            let at = patch.get("end_time").and_then(Value::as_i64).unwrap_or(now);
            let ends = status.is_some_and(|s| s != "running");
            Some(event(if ends { "ended" } else { "updated" }, task_id, at, &[
                ("status", status.filter(|_| ends).map(|s| json!(s))),
                ("title", title(patch, "description")),
                ("summary", text(patch, "error")),
            ]))
        }
        "task_notification" => {
            let status = match str_of(line, "status") {
                Some("failed") => "failed",
                Some("stopped") => "stopped",
                _ => "completed",
            };
            let mut fields = vec![("toolUseId", plain(line, "tool_use_id")), ("status", Some(json!(status))), ("summary", text(line, "summary"))];
            fields.extend(usage_fields(line.get("usage")));
            Some(event("ended", task_id, now, &fields))
        }
        _ => None,
    }
}

/// O status de um agente do Codex (`CollabAgentStatus`) no painel; `None` para o que não existe.
fn codex_status(status: &str) -> Option<&'static str> {
    match status {
        "pendingInit" | "running" => Some("running"),
        "completed" | "shutdown" => Some("completed"),
        "errored" => Some("failed"),
        "interrupted" => Some("stopped"),
        _ => None,
    }
}

/// Os eventos `task` de um item do Codex: o agente que o `spawnAgent` criou (um por thread nova), o
/// estado que as outras chamadas trazem (`agentsStates`) e a atividade do subagente. Pura.
pub fn codex_tasks(item: &Value, now: i64) -> Vec<Value> {
    match str_of(item, "type") {
        Some("collabAgentToolCall") => {
            let states = item.get("agentsStates").and_then(Value::as_object);
            if str_of(item, "tool") == Some("spawnAgent") {
                let call_failed = str_of(item, "status") == Some("failed");
                return item.get("receiverThreadIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|thread| {
                    let state = states.and_then(|s| s.get(thread));
                    let status = state.and_then(|s| str_of(s, "status")).and_then(codex_status).unwrap_or(if call_failed { "failed" } else { "running" });
                    event("started", thread, now, &[
                        ("toolUseId", plain(item, "id")),
                        ("kind", Some(json!("agent"))),
                        ("title", title(item, "prompt")),
                        ("prompt", text(item, "prompt")),
                        ("status", Some(json!(status))),
                        ("summary", state.and_then(|s| text(s, "message"))),
                        ("background", Some(json!(true))),
                        ("stoppable", Some(json!(false))),
                    ])
                }).collect();
            }
            let mut out: Vec<Value> = states.into_iter().flatten().filter_map(|(thread, state)| {
                let status = str_of(state, "status").and_then(codex_status)?;
                let ends = status != "running";
                Some(event(if ends { "ended" } else { "updated" }, thread, now, &[("status", ends.then(|| json!(status))), ("summary", text(state, "message"))]))
            }).collect();
            out.sort_by(|a, b| a["taskId"].as_str().cmp(&b["taskId"].as_str()));
            out
        }
        Some("subAgentActivity") => {
            let Some(thread) = str_of(item, "agentThreadId") else { return Vec::new() };
            match str_of(item, "kind") {
                Some("started") => vec![event("started", thread, now, &[
                    ("kind", Some(json!("agent"))),
                    ("title", title(item, "agentPath")),
                    ("status", Some(json!("running"))),
                    ("background", Some(json!(true))),
                    ("stoppable", Some(json!(false))),
                ])],
                Some("completed") => vec![event("ended", thread, now, &[("status", Some(json!("completed")))])],
                Some("interrupted") => vec![event("ended", thread, now, &[("status", Some(json!("stopped")))])],
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}
