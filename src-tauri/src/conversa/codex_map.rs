//! O que vem do `codex app-server` virando o que a timeline do chat já desenha
//! (`canal::timeline::Item`), e o que o chat escolhe virando parâmetros do protocolo. Puro.
//!
//! O protocolo é o da versão instalada (`codex app-server generate-ts`): `ThreadItem` com `type`
//! (`userMessage`, `agentMessage`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`…),
//! `Turn` com `status` e `durationMs`, e os pedidos `item/*/requestApproval`.

use serde_json::{json, Value};

use crate::canal::event::{clip, first_line};
use crate::canal::timeline::{count_lines, Item, ItemKind, ToolKind, ToolStatus};

const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;
const LABEL_MAX: usize = 200;

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn status_of(raw: Option<&str>) -> ToolStatus {
    match raw {
        Some("completed") => ToolStatus::Done,
        Some("failed") => ToolStatus::Error,
        Some("declined") => ToolStatus::Denied,
        _ => ToolStatus::Running,
    }
}

fn tool(id: String, at: Option<i64>, kind: ToolKind, name: &str) -> Item {
    Item { name: Some(name.to_string()), tool: Some(kind), status: Some(ToolStatus::Running), ..Item::new(ItemKind::Tool, id, at) }
}

/// As linhas `+` e `-` de um diff unificado (sem os cabeçalhos `+++`/`---`).
fn diff_stats(diff: &str) -> (u32, u32) {
    let (mut added, mut removed) = (0, 0);
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// Os itens da timeline de um `ThreadItem`. Uma edição vira um item por arquivo (o cartão de
/// arquivos alterados e a linha de cada edição são por arquivo). O que a timeline não mostra
/// (raciocínio, compactação, revisão) não vira nada.
pub fn items_of(item: &Value, at: Option<i64>) -> Vec<Item> {
    let Some(id) = str_of(item, "id").map(str::to_string) else { return Vec::new() };
    match str_of(item, "type").unwrap_or("") {
        "userMessage" => {
            let text: Vec<&str> = item.get("content").and_then(Value::as_array).into_iter().flatten()
                .filter(|c| str_of(c, "type") == Some("text"))
                .filter_map(|c| str_of(c, "text"))
                .collect();
            if text.is_empty() {
                return Vec::new();
            }
            vec![Item { text: Some(clip(&text.join("\n\n"), TEXT_MAX)), ..Item::new(ItemKind::User, id, at) }]
        }
        "agentMessage" => {
            let text = str_of(item, "text").unwrap_or("");
            if text.trim().is_empty() {
                return Vec::new();
            }
            vec![Item { text: Some(clip(text, TEXT_MAX)), ..Item::new(ItemKind::Assistant, id, at) }]
        }
        "commandExecution" => {
            let mut it = tool(id, at, ToolKind::Command, "Bash");
            it.label = str_of(item, "command").map(|c| first_line(c, LABEL_MAX));
            it.status = Some(status_of(str_of(item, "status")));
            it.output = str_of(item, "aggregatedOutput").filter(|o| !o.is_empty()).map(|o| clip(o, OUTPUT_MAX));
            if it.status == Some(ToolStatus::Done) && item.get("exitCode").and_then(Value::as_i64).is_some_and(|c| c != 0) {
                it.status = Some(ToolStatus::Error);
            }
            it.duration_ms = item.get("durationMs").and_then(Value::as_i64);
            vec![it]
        }
        "fileChange" => {
            let status = status_of(str_of(item, "status"));
            let changes = item.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
            changes.iter().enumerate().map(|(i, change)| {
                let kind = change.pointer("/kind/type").and_then(Value::as_str).unwrap_or("update");
                let tool_kind = if kind == "add" { ToolKind::Write } else { ToolKind::Edit };
                let mut it = tool(format!("{id}#{i}"), at, tool_kind, if kind == "add" { "Write" } else { "Edit" });
                let diff = str_of(change, "diff").unwrap_or("");
                let (added, removed) = if kind == "add" && !diff.lines().any(|l| l.starts_with('+')) {
                    (count_lines(diff), 0)
                } else {
                    diff_stats(diff)
                };
                it.path = str_of(change, "path").map(str::to_string);
                it.added = Some(added);
                it.removed = Some(removed);
                it.status = Some(status);
                it
            }).collect()
        }
        "mcpToolCall" => {
            let name = format!("{}.{}", str_of(item, "server").unwrap_or("mcp"), str_of(item, "tool").unwrap_or("?"));
            let mut it = tool(id, at, ToolKind::Other, &name);
            it.label = Some(first_line(&name, LABEL_MAX));
            it.status = Some(status_of(str_of(item, "status")));
            vec![it]
        }
        "webSearch" => {
            let mut it = tool(id, at, ToolKind::Web, "WebSearch");
            it.label = str_of(item, "query").map(|q| first_line(q, LABEL_MAX));
            it.status = Some(ToolStatus::Done);
            vec![it]
        }
        "plan" => {
            let text = str_of(item, "text").unwrap_or("");
            if text.trim().is_empty() {
                return Vec::new();
            }
            let mut it = tool(id, at, ToolKind::Todo, "Plan");
            it.label = Some(first_line(text, LABEL_MAX));
            it.output = Some(clip(text, OUTPUT_MAX));
            it.status = Some(ToolStatus::Done);
            vec![it]
        }
        _ => Vec::new(),
    }
}

/// O fim de um turno (`Turn` com status final). `None` enquanto está em andamento.
pub fn turn_end(turn: &Value, at: Option<i64>) -> Option<Item> {
    let id = str_of(turn, "id")?;
    let status = str_of(turn, "status")?;
    if status == "inProgress" {
        return None;
    }
    let mut it = Item::new(ItemKind::TurnEnd, format!("end:{id}"), at);
    it.interrupted = Some(status == "interrupted");
    it.duration_ms = turn.get("durationMs").and_then(Value::as_i64);
    if status == "failed" {
        it.text = turn.pointer("/error/message").and_then(Value::as_str).map(|m| clip(m, OUTPUT_MAX));
    }
    Some(it)
}

/// O acesso do chat (`ask`, `edits`, `safe`, `full`) em política de aprovação e sandbox do Codex.
/// Supervisionado pede aprovação para o que não é confiável; Auto (e Aceitar edições, que o Codex
/// não separa) escreve na pasta e pede quando precisa; Acesso total não pede nada.
pub fn access_policy(access: &str) -> (&'static str, &'static str) {
    match access {
        "full" => ("never", "danger-full-access"),
        "safe" | "edits" => ("on-request", "workspace-write"),
        _ => ("untrusted", "workspace-write"),
    }
}

/// Um pedido do agente que o chat sabe mostrar.
#[derive(Debug, PartialEq)]
pub struct Ask {
    pub kind: &'static str,
    pub item_id: Option<String>,
    pub title: String,
    pub detail: String,
    pub options: Value,
}

/// O pedido do `app-server` em algo para mostrar. `None` = um pedido que o chat não atende.
pub fn ask_of(method: &str, params: &Value) -> Option<Ask> {
    let item_id = str_of(params, "itemId").map(str::to_string);
    let reason = str_of(params, "reason").unwrap_or("").to_string();
    match method {
        "item/commandExecution/requestApproval" => Some(Ask {
            kind: "command",
            item_id,
            title: str_of(params, "command").map(|c| first_line(c, LABEL_MAX)).unwrap_or_default(),
            detail: reason,
            options: Value::Array(Vec::new()),
        }),
        "item/fileChange/requestApproval" => Some(Ask {
            kind: "fileChange",
            item_id,
            title: str_of(params, "grantRoot").unwrap_or("").to_string(),
            detail: reason,
            options: Value::Array(Vec::new()),
        }),
        "item/tool/requestUserInput" => {
            let questions: Vec<Value> = params.get("questions").and_then(Value::as_array).into_iter().flatten().map(|q| json!({
                "id": str_of(q, "id").unwrap_or(""),
                "question": str_of(q, "question").unwrap_or(""),
                "options": q.get("options").and_then(Value::as_array).into_iter().flatten()
                    .filter_map(|o| str_of(o, "label")).collect::<Vec<_>>(),
            })).collect();
            let title = questions.first().and_then(|q| q.get("question")).and_then(Value::as_str).unwrap_or("").to_string();
            Some(Ask { kind: "question", item_id, title, detail: String::new(), options: Value::Array(questions) })
        }
        _ => None,
    }
}

/// A resposta ao pedido. Aprovação: `allow` (só esta vez), `allowSession` (até o fim da conversa)
/// ou `deny` (recusa e o agente segue). Pergunta: o texto vira a resposta da primeira pergunta.
pub fn answer_of(kind: &str, choice: &str, options: &Value) -> Value {
    if kind == "question" {
        let first = options.as_array().and_then(|q| q.first()).and_then(|q| q.get("id")).and_then(Value::as_str).unwrap_or("");
        return json!({ "answers": { first: { "answers": [choice] } } });
    }
    let decision = match choice {
        "allow" => "accept",
        "allowSession" => "acceptForSession",
        "cancel" => "cancel",
        _ => "decline",
    };
    json!({ "decision": decision })
}
