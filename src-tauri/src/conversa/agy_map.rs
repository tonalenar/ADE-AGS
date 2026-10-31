//! O que vem do Antigravity (`agy`) em `--print --output-format stream-json` virando o que a
//! timeline do chat já desenha (`canal::timeline::Item`), e o que o chat escolhe virando flags.
//! Puro.
//!
//! O protocolo é o da versão instalada (agy 1.4.11). Conferido sem gastar cota: `--help`, o
//! changelog embutido (`agy changelog`), o `-p "/usage"` (que o CLI responde sozinho, sem modelo) e
//! o parser que o app já tem para as tarefas desatendidas (`runs/antigravity.rs`). **Não** conferido
//! com um turno real de modelo: os campos das ferramentas (`tool_info`, `parameters`) vêm do
//! changelog e do parser existente, e o mapeamento é tolerante a nomes que não conheço.
//! - Uma linha JSON por evento, com `event`: `init` (`conversation_id`), `step_update`
//!   (`step_update.{step_index, state, step_type, text_delta, tool_name, tool_info, parameters}`),
//!   `command_result` e `result` (`result.{conversation_id, status, response, usage,
//!   finished_reason, denied_actions, duration_seconds}`);
//! - o `step_type` é um vocabulário fechado: `agent_response` é a fala do agente (`text_delta` em
//!   pedaços) e os outros são ferramentas;
//! - um processo por turno: o `--input-format stream-json` (vários turnos num processo) lê
//!   mensagens `{"event": …}` cujo formato não está documentado, então o app continua a conversa
//!   com `--conversation <id>`;
//! - no modo `-p` não há como aprovar: o que precisaria de aprovação é negado e vem em
//!   `denied_actions`. O acesso decide o quanto o agente pode sem perguntar.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::canal::event::{clip, first_line};
use crate::canal::timeline::{claude_tool, Item, ItemKind, ToolKind, ToolStatus};

use super::claude_map::TurnResult;
use super::codex_map::DeltaKind;
use super::store::ThreadRow;

const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// As flags de modo do `agy` de cada acesso:
/// - Supervisionado (`ask`): nenhuma; no `-p` o que pede aprovação é negado e listado;
/// - Aceitar edições (`edits`): `--mode accept-edits`;
/// - Auto (`safe`): `--mode auto`, a revisão por outro agente dos comandos que saem do sandbox;
/// - Plano (`plan`): `--mode plan`;
/// - Acesso total (`full`): `--dangerously-skip-permissions`.
pub fn access_flags(access: &str) -> Vec<&'static str> {
    match access {
        "edits" => vec!["--mode", "accept-edits"],
        "safe" => vec!["--mode", "auto"],
        "plan" => vec!["--mode", "plan"],
        "full" => vec!["--dangerously-skip-permissions"],
        _ => Vec::new(),
    }
}

/// Os argumentos do `agy` de um turno. `conversation` é o id da conversa no `agy` (do `init` ou do
/// `result` do turno anterior); sem ele abre uma nova. A mensagem é o valor de `--print`, como no
/// parser das tarefas. As barras da mensagem não viram comandos do CLI (`--disable-slash-commands`).
pub fn launch_args(row: &ThreadRow, prompt: &str, conversation: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["--print", prompt, "--output-format", "stream-json", "--disable-slash-commands"].map(String::from).to_vec();
    args.extend(access_flags(&row.access).into_iter().map(String::from));
    if let Some(id) = conversation.filter(|c| !c.is_empty()) {
        args.extend(["--conversation".into(), id.into()]);
    }
    if let Some(model) = row.model.as_deref().filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = row.effort.as_deref().filter(|e| !e.is_empty()) {
        args.extend(["--effort".into(), effort.into()]);
    }
    args
}

/// O que uma linha da saída significa para a conversa.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Um item novo ou atualizado da timeline (numa caixa: o item é bem maior que as outras variantes).
    Item(Box<Item>),
    /// Um pedaço da fala (ou do raciocínio) chegando; `item_id` é o do item que vai fechar o texto.
    Delta { item_id: String, delta: String, kind: DeltaKind },
    /// O id da conversa no `agy` (para continuar com `--conversation`).
    Session(String),
    /// O turno acabou.
    Done(TurnResult),
}

struct Text {
    id: String,
    kind: DeltaKind,
    text: String,
    closed: bool,
}

/// Lê a saída do `agy` linha a linha, de UM turno (cada turno é um processo).
pub struct Mapper {
    turn: String,
    texts: HashMap<i64, Text>,
    tools: HashMap<i64, Item>,
    session: bool,
    spoke: bool,
}

impl Mapper {
    pub fn new(turn: &str) -> Mapper {
        Mapper { turn: turn.to_string(), texts: HashMap::new(), tools: HashMap::new(), session: false, spoke: false }
    }

    fn id_of(&self, index: i64) -> String {
        format!("agy:{}:{index}", self.turn)
    }

    /// O que uma linha da saída vira. `now` é o carimbo dos itens.
    pub fn feed(&mut self, line: &Value, now: i64) -> Vec<Out> {
        let at = Some(now);
        let mut out = Vec::new();
        match str_of(line, "event").unwrap_or("") {
            "init" => self.session_of(line.get("conversation_id"), &mut out),
            "step_update" => {
                let step = line.get("step_update").unwrap_or(&Value::Null);
                self.session_of(step.get("conversation_id"), &mut out);
                self.step(step, at, &mut out);
            }
            "result" => self.result(line.get("result").unwrap_or(&Value::Null), at, &mut out),
            _ => {}
        }
        out
    }

    fn session_of(&mut self, id: Option<&Value>, out: &mut Vec<Out>) {
        if let Some(id) = id.and_then(Value::as_str).filter(|id| !id.is_empty())
            && !self.session
        {
            self.session = true;
            out.push(Out::Session(id.to_string()));
        }
    }

    fn step(&mut self, step: &Value, at: Option<i64>, out: &mut Vec<Out>) {
        let Some(index) = step.get("step_index").and_then(Value::as_i64) else { return };
        let kind = str_of(step, "step_type").unwrap_or("");
        let lower = kind.to_ascii_lowercase();
        let state = str_of(step, "state").unwrap_or("");
        let done = matches!(state, "DONE" | "COMPLETED" | "SUCCESS" | "FINISHED");
        if is_speech(&lower) {
            self.text(index, DeltaKind::Assistant, step, &["text_delta", "text", "response"], done, at, out);
        } else if is_thought(&lower) {
            self.text(index, DeltaKind::Reasoning, step, &["text_delta", "thought_delta", "thinking_delta", "thought", "text"], done, at, out);
        } else if !SKIPPED.contains(&lower.as_str()) {
            self.tool(index, step, &lower, at, out);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, index: i64, kind: DeltaKind, step: &Value, keys: &[&str], done: bool, at: Option<i64>, out: &mut Vec<Out>) {
        let id = self.id_of(index);
        let entry = self.texts.entry(index).or_insert_with(|| Text { id: id.clone(), kind, text: String::new(), closed: false });
        if entry.closed {
            return;
        }
        let delta = keys.iter().find_map(|k| str_of(step, k)).unwrap_or("");
        if !delta.is_empty() {
            entry.text.push_str(delta);
            out.push(Out::Delta { item_id: id, delta: delta.to_string(), kind });
        }
        if done && let Some(item) = close(entry, at) {
            self.spoke |= kind == DeltaKind::Assistant;
            out.push(Out::Item(Box::new(item)));
        }
    }

    fn tool(&mut self, index: i64, step: &Value, step_type: &str, at: Option<i64>, out: &mut Vec<Out>) {
        let info = step.get("tool_info").unwrap_or(&Value::Null);
        let name = str_of(step, "tool_name").or_else(|| str_of(info, "name")).or_else(|| str_of(info, "tool_name")).unwrap_or(step_type);
        let params = step.get("parameters").or_else(|| info.get("parameters")).cloned().unwrap_or(Value::Null);
        let mut item = tool_item(&self.id_of(index), name, &params, at);
        item.status = Some(match str_of(step, "state").unwrap_or("") {
            "DONE" | "COMPLETED" | "SUCCESS" | "FINISHED" => ToolStatus::Done,
            "ERROR" | "FAILED" | "CANCELED" | "CANCELLED" | "INTERRUPTED" => ToolStatus::Error,
            "DENIED" | "REJECTED" => ToolStatus::Denied,
            _ => ToolStatus::Running,
        });
        let output = info.get("output").or_else(|| step.get("output")).map(|o| match o {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });
        item.output = output.filter(|o| !o.trim().is_empty() && o != "null").map(|o| clip(&o, OUTPUT_MAX));
        // O mesmo passo repetido sem mudança não regrava o item.
        if self.tools.get(&index).is_some_and(|before| before == &item) {
            return;
        }
        self.tools.insert(index, item.clone());
        out.push(Out::Item(Box::new(item)));
    }

    fn result(&mut self, result: &Value, at: Option<i64>, out: &mut Vec<Out>) {
        self.session_of(result.get("conversation_id"), out);
        // Os trechos de fala que não chegaram a fechar.
        let mut open: Vec<i64> = self.texts.iter().filter(|(_, t)| !t.closed).map(|(i, _)| *i).collect();
        open.sort_unstable();
        for index in open {
            if let Some(text) = self.texts.get_mut(&index)
                && let Some(item) = close(text, at)
            {
                self.spoke |= text.kind == DeltaKind::Assistant;
                out.push(Out::Item(Box::new(item)));
            }
        }
        let ok = str_of(result, "status") == Some("SUCCESS");
        let reason = str_of(result, "finished_reason");
        // Sem fala em pedaços, a resposta final do `result` é a fala.
        if ok && !self.spoke && let Some(response) = str_of(result, "response").filter(|r| !r.trim().is_empty()) {
            let item = Item { text: Some(clip(response, TEXT_MAX)), ..Item::new(ItemKind::Assistant, self.id_of(-1), at) };
            out.push(Out::Item(Box::new(item)));
        }
        for (n, action) in result.get("denied_actions").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let label = describe(action);
            let item = Item {
                name: Some("denied".into()),
                tool: Some(ToolKind::Other),
                label: Some(label.clone()),
                status: Some(ToolStatus::Denied),
                output: Some("Negado: o modo de execução do chat não aprova esta ação sem alguém para aprovar. Troque o acesso para liberar.".into()),
                ..Item::new(ItemKind::Tool, format!("agy:{}:denied{n}", self.turn), at)
            };
            out.push(Out::Item(Box::new(item)));
        }
        if let Some(tokens) = usage_tokens(result.get("usage")) {
            out.push(Out::Item(Box::new(Item::usage(format!("usage:{}", self.turn), at, tokens))));
        }
        let duration_ms = result.get("duration_seconds").and_then(Value::as_f64).map(|s| (s * 1000.0) as i64);
        let interrupted = reason == Some("interrupted");
        let error = if interrupted || (ok && reason.is_none()) {
            None
        } else if reason == Some("print_timeout") {
            Some("O Antigravity parou por tempo".to_string())
        } else {
            let text = str_of(result, "error").or_else(|| str_of(result, "message")).filter(|e| !e.trim().is_empty());
            Some(clip(&text.map(str::to_string).unwrap_or_else(|| format!("O Antigravity terminou com status {}", str_of(result, "status").unwrap_or("desconhecido"))), OUTPUT_MAX))
        };
        out.push(Out::Done(TurnResult { interrupted, error, duration_ms }));
    }
}

/// Os passos que não são ferramenta nem fala: o que a pessoa mandou, o histórico, os lembretes.
const SKIPPED: &[&str] = &[
    "user_input", "user_message", "conversation_history", "ephemeral_message", "checkpoint", "system_message",
    "knowledge_artifacts", "knowledge_generation", "compaction", "error_message",
];

fn is_speech(step_type: &str) -> bool {
    matches!(step_type, "agent_response" | "assistant_response" | "model_response" | "planner_response")
}

fn is_thought(step_type: &str) -> bool {
    step_type.contains("thought") || step_type.contains("thinking") || step_type.contains("reasoning")
}

fn close(text: &mut Text, at: Option<i64>) -> Option<Item> {
    text.closed = true;
    match text.kind {
        DeltaKind::Assistant => (!text.text.trim().is_empty())
            .then(|| Item { text: Some(clip(&text.text, TEXT_MAX)), ..Item::new(ItemKind::Assistant, text.id.clone(), at) }),
        DeltaKind::Reasoning => Item::reasoning(text.id.clone(), at, &text.text),
    }
}

/// Os tokens do turno (`usage` do `result`): o total, ou entrada + saída + raciocínio.
fn usage_tokens(usage: Option<&Value>) -> Option<u64> {
    let usage = usage?;
    let n = |key: &str| usage.get(key).and_then(Value::as_u64);
    let total = n("total_tokens").filter(|t| *t > 0).unwrap_or_else(|| n("input_tokens").unwrap_or(0) + n("output_tokens").unwrap_or(0) + n("thinking_tokens").unwrap_or(0));
    (total > 0).then_some(total)
}

/// Uma ação negada (`denied_actions`) em uma linha: o texto, ou o primeiro campo que diga o quê.
fn describe(action: &Value) -> String {
    if let Some(s) = action.as_str() {
        return first_line(s, 200);
    }
    for key in ["command", "description", "summary", "action", "tool", "tool_name", "name", "reason"] {
        if let Some(s) = action.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            return first_line(s, 200);
        }
    }
    clip(&action.to_string(), 200)
}

/// O valor de um parâmetro pelo nome, sem ligar para caixa e `_` (`CommandLine`, `command_line`).
fn param<'a>(params: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let norm = |s: &str| s.chars().filter(|c| *c != '_' && *c != '-').collect::<String>().to_ascii_lowercase();
    let map = params.as_object()?;
    keys.iter().find_map(|want| map.iter().find(|(k, v)| norm(k) == *want && !v.is_null()).map(|(_, v)| v))
}

fn param_str<'a>(params: &'a Value, keys: &[&str]) -> Option<&'a str> {
    param(params, keys).and_then(Value::as_str)
}

/// Uma ferramenta do Antigravity como a timeline do transcript já mostra: vira a ferramenta do
/// Claude equivalente e passa por `claude_tool`. Os nomes que não conheço ficam como ferramenta
/// genérica com o próprio nome. Pura.
pub fn tool_item(id: &str, name: &str, params: &Value, at: Option<i64>) -> Item {
    let key: String = name.chars().filter(|c| *c != '_' && *c != '-').collect::<String>().to_ascii_lowercase();
    let path = param_str(params, &["absolutepath", "targetfile", "filepath", "path", "file", "directorypath", "searchpath"]);
    let has = |needles: &[&str]| needles.iter().any(|n| key.contains(n));
    if has(&["url", "websearch", "searchweb", "webfetch", "browser"]) && !has(&["subagent"]) {
        let url = param_str(params, &["url", "query"]).unwrap_or(name);
        return claude_tool(id, "WebFetch", &json!({ "url": url }), at);
    }
    if has(&["subagent", "invokeagent", "delegate"]) {
        let what = param_str(params, &["prompt", "task", "description", "taskname"]).unwrap_or(name);
        return claude_tool(id, "Task", &json!({ "description": what }), at);
    }
    if has(&["mcp"]) {
        let server = param_str(params, &["servername", "server"]);
        let tool = param_str(params, &["toolname", "tool"]);
        let label = match (server, tool) {
            (Some(s), Some(t)) => format!("{s}: {t}"),
            (None, Some(t)) => t.to_string(),
            _ => name.to_string(),
        };
        return claude_tool(id, &label, params, at);
    }
    if has(&["runcommand", "command", "bash", "shell", "terminal"]) {
        let command = param_str(params, &["commandline", "command", "cmd"]).unwrap_or(name);
        return claude_tool(id, "Bash", &json!({ "command": command }), at);
    }
    if has(&["writetofile", "createfile", "writefile"]) {
        let content = param_str(params, &["codecontent", "content", "filecontent"]).unwrap_or("");
        return claude_tool(id, "Write", &json!({ "file_path": path, "content": content }), at);
    }
    if has(&["edit", "replace", "patch"]) {
        let new = param_str(params, &["replacementcontent", "newstring", "newcontent", "codeedit"]).unwrap_or("");
        let old = param_str(params, &["targetcontent", "oldstring", "oldcontent"]).unwrap_or("");
        return claude_tool(id, "Edit", &json!({ "file_path": path, "old_string": old, "new_string": new }), at);
    }
    if has(&["grep", "findbyname", "search", "find"]) {
        let pattern = param_str(params, &["query", "pattern", "searchpattern", "regex"]).unwrap_or(name);
        return claude_tool(id, "Grep", &json!({ "pattern": pattern, "path": path }), at);
    }
    if has(&["viewfile", "readfile", "view", "read", "listdir", "outline"]) {
        return claude_tool(id, "Read", &json!({ "file_path": path }), at);
    }
    claude_tool(id, name, params, at)
}

/// O erro de um turno que acabou sem `result`: o `AGY_ERROR: {...}` que o `agy` escreve no stderr
/// (com `message`, `error` ou `status`), ou a última linha com texto. Pura.
pub fn error_from_stderr(tail: &[String]) -> String {
    let structured = tail.iter().rev().find_map(|line| {
        let json = &line[line.find("AGY_ERROR")? + "AGY_ERROR".len()..];
        let value: Value = serde_json::from_str(json[json.find('{')?..].trim()).ok()?;
        ["message", "error", "status"].iter().find_map(|k| value.get(*k).and_then(Value::as_str).map(str::to_string))
    });
    let text = structured.or_else(|| tail.iter().rev().find(|l| !l.trim().is_empty()).cloned());
    clip(&text.unwrap_or_else(|| "O Antigravity terminou sem responder".into()), 600)
}
