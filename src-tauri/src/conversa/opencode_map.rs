//! O que vem do OpenCode pelo Agent Client Protocol (`opencode acp`, JSON-RPC 2.0 por linha no
//! stdio) virando o que a timeline do chat já desenha (`canal::timeline::Item`), e o que o chat
//! escolhe virando configuração e respostas do protocolo. Puro.
//!
//! O protocolo é o da versão instalada (OpenCode 2.2.1, conferido com `initialize` e `session/new`
//! reais, sem prompt de modelo):
//! - `initialize` devolve `agentCapabilities` (`loadSession`, `sessionCapabilities.resume`…);
//! - `session/new` devolve `sessionId` e `configOptions` (`model`, `effort`, `mode` com `build` e
//!   `plan`); `session/set_config_option {sessionId, configId, value}` troca cada um;
//! - `session/prompt` começa o turno e só responde no fim (`stopReason`); o que o agente faz
//!   chega em avisos `session/update`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
//!   `tool_call_update`, `plan`, `current_mode_update`, `session_info_update` (o título, que o app não usa);
//! - o agente pede permissão com o pedido `session/request_permission` (`toolCall` e `options`),
//!   e a resposta é `{outcome: {outcome: "selected", optionId} | {outcome: "cancelled"}}`;
//! - `session/cancel` (aviso) interrompe o turno, que responde `stopReason: "cancelled"`.
//!
//! As permissões não são do protocolo: o OpenCode decide pedir ou não pela configuração dele
//! (`permission`). O app a passa no ambiente do processo (`OPENCODE_CONFIG_CONTENT`), por acesso.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::canal::event::{clip, first_line};
use crate::canal::timeline::{claude_tool, plan_steps, Item, ItemKind, ToolKind, ToolStatus};

use super::claude_map::TurnResult;
use super::codex_map::{Ask, DeltaKind};
use super::store::ThreadRow;

const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// O modo do OpenCode de cada acesso: o Plano é o agente `plan` (só lê e planeja); o resto é o `build`.
pub fn mode_of(access: &str) -> &'static str {
    if access == "plan" { "plan" } else { "build" }
}

/// O inverso de [`mode_of`], para quando o OpenCode troca de modo sozinho. `build` não diz nada
/// (vale qualquer acesso que não seja o Plano); `plan` é o Plano.
pub fn access_of_mode(mode: &str) -> Option<&'static str> {
    (mode == "plan").then_some("plan")
}

/// A política de permissões do OpenCode de cada acesso (`permission` da configuração dele):
/// - Supervisionado (`ask`) e Plano: edição, comando e web perguntam;
/// - Aceitar edições (`edits`): edita sozinho, o resto pergunta;
/// - Auto (`safe`): edita e busca na web sozinho; comando ainda pergunta (o OpenCode não tem
///   sandbox nem classificador, então o nível seguro é não rodar comando sem aprovação);
/// - Acesso total (`full`): tudo liberado.
pub fn permission_config(access: &str) -> Value {
    let (edit, bash, web, external) = match access {
        "edits" => ("allow", "ask", "ask", "ask"),
        "safe" => ("allow", "ask", "allow", "ask"),
        "full" => ("allow", "allow", "allow", "allow"),
        _ => ("ask", "ask", "ask", "ask"),
    };
    json!({ "permission": { "edit": edit, "bash": bash, "webfetch": web, "external_directory": external } })
}

/// O ambiente do processo `opencode acp` de uma conversa: a política de permissões do acesso,
/// que o OpenCode lê de `OPENCODE_CONFIG_CONTENT` (conferido: o `session/new` já abre com a
/// configuração do ambiente). Pura.
pub fn launch_env(row: &ThreadRow) -> Vec<(String, String)> {
    vec![("OPENCODE_CONFIG_CONTENT".into(), permission_config(&row.access).to_string())]
}

pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
        "clientInfo": { "name": "ade-ags", "title": "ADE AGS", "version": env!("CARGO_PKG_VERSION") },
    })
}

pub fn new_session_params(cwd: &str) -> Value {
    json!({ "cwd": cwd, "mcpServers": [] })
}

pub fn resume_params(session_id: &str, cwd: &str) -> Value {
    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] })
}

pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
}

pub fn set_option_params(session_id: &str, config_id: &str, value: &str) -> Value {
    json!({ "sessionId": session_id, "configId": config_id, "value": value })
}

/// O valor atual e os valores aceitos de uma opção (`model`, `effort`, `mode`) na resposta de
/// `session/new`/`session/resume` ou de `session/set_config_option`.
pub fn config_option(result: &Value, id: &str) -> Option<(Option<String>, Vec<String>)> {
    let option = result.get("configOptions")?.as_array()?.iter().find(|o| str_of(o, "id") == Some(id))?;
    let values = option.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| str_of(o, "value")).map(str::to_string).collect();
    Some((str_of(option, "currentValue").map(str::to_string), values))
}

/// O que um aviso `session/update` significa para a conversa.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Um item novo ou atualizado da timeline (numa caixa: o item é bem maior que as outras variantes).
    Item(Box<Item>),
    /// Um pedaço do texto (ou do raciocínio) chegando; `item_id` é o do item que vai fechar o texto.
    Delta { item_id: String, delta: String, kind: DeltaKind },
    /// O modo em que o OpenCode diz estar (`build`, `plan`).
    Mode(String),
}

#[derive(Default)]
struct Segment {
    id: String,
    text: String,
}

/// Lê os avisos do OpenCode um a um. Guarda o texto que chega em pedaços (para o item final ter o
/// mesmo id dos pedaços) e as ferramentas abertas (para fechar quando chega a atualização).
#[derive(Default)]
pub struct Mapper {
    turn: String,
    seq: usize,
    assistant: Option<Segment>,
    thought: Option<Segment>,
    /// As ferramentas abertas, com tudo que já se sabe delas (`tool_call` + atualizações).
    calls: HashMap<String, Value>,
    denied: HashSet<String>,
}

impl Mapper {
    /// Um mapeador novo para o turno `turn`: os ids dos itens levam o turno, para dois turnos
    /// nunca se sobrescreverem no banco.
    pub fn new(turn: &str) -> Mapper {
        Mapper { turn: turn.to_string(), ..Default::default() }
    }

    /// Começa outro turno (o processo é o mesmo; os ids passam a levar o turno novo).
    pub fn begin(&mut self, turn: &str) {
        self.turn = turn.to_string();
        self.seq = 0;
        self.assistant = None;
        self.thought = None;
    }

    /// A pessoa negou esta ferramenta: a atualização dela aparece como negada.
    pub fn deny(&mut self, tool_call_id: &str) {
        self.denied.insert(tool_call_id.to_string());
    }

    fn next_id(&mut self, what: &str) -> String {
        self.seq += 1;
        format!("oc:{}:{what}{}", self.turn, self.seq)
    }

    /// O que o `update` de um `session/update` vira. `now` é o carimbo dos itens.
    pub fn feed(&mut self, update: &Value, now: i64) -> Vec<Out> {
        let at = Some(now);
        match str_of(update, "sessionUpdate").unwrap_or("") {
            "agent_message_chunk" => self.chunk(update, DeltaKind::Assistant, at),
            "agent_thought_chunk" => self.chunk(update, DeltaKind::Reasoning, at),
            "tool_call" => {
                let mut out = self.flush(at);
                if str_of(update, "toolCallId").is_none_or(str::is_empty) {
                    return out;
                }
                out.extend(self.tool_update(update, at));
                out
            }
            "tool_call_update" => self.tool_update(update, at),
            "plan" => {
                let steps = plan_steps(update.get("entries"));
                let id = format!("oc:{}:plan", self.turn);
                match steps {
                    Some(steps) if !steps.is_empty() => {
                        let n = steps.len();
                        let item = Item { label: Some(n.to_string()), plan: Some(steps), tool: Some(ToolKind::Todo), name: Some("plan".into()), status: Some(ToolStatus::Done), ..Item::new(ItemKind::Tool, id, at) };
                        vec![Out::Item(Box::new(item))]
                    }
                    _ => Vec::new(),
                }
            }
            "current_mode_update" => str_of(update, "currentModeId").map(|m| vec![Out::Mode(m.to_string())]).unwrap_or_default(),
            // `user_message_chunk` (o eco do que a pessoa mandou), `available_commands_update`,
            // `usage_update`… não viram nada.
            _ => Vec::new(),
        }
    }

    fn chunk(&mut self, update: &Value, kind: DeltaKind, at: Option<i64>) -> Vec<Out> {
        let text = match update.pointer("/content/type").and_then(Value::as_str) {
            Some("text") | None => update.pointer("/content/text").and_then(Value::as_str).unwrap_or(""),
            _ => "",
        };
        if text.is_empty() {
            return Vec::new();
        }
        // O texto muda de tipo (pensou, depois falou): o trecho anterior fecha antes.
        let mut out = match kind {
            DeltaKind::Assistant => self.close_segment(DeltaKind::Reasoning, at),
            DeltaKind::Reasoning => self.close_segment(DeltaKind::Assistant, at),
        };
        let what = if kind == DeltaKind::Assistant { "m" } else { "t" };
        let current = match kind {
            DeltaKind::Assistant => self.assistant.is_some(),
            DeltaKind::Reasoning => self.thought.is_some(),
        };
        if !current {
            let id = self.next_id(what);
            let segment = Some(Segment { id, text: String::new() });
            match kind {
                DeltaKind::Assistant => self.assistant = segment,
                DeltaKind::Reasoning => self.thought = segment,
            }
        }
        let segment = if kind == DeltaKind::Assistant { self.assistant.as_mut() } else { self.thought.as_mut() };
        if let Some(segment) = segment {
            segment.text.push_str(text);
            out.push(Out::Delta { item_id: segment.id.clone(), delta: text.to_string(), kind });
        }
        out
    }

    fn close_segment(&mut self, kind: DeltaKind, at: Option<i64>) -> Vec<Out> {
        let segment = match kind {
            DeltaKind::Assistant => self.assistant.take(),
            DeltaKind::Reasoning => self.thought.take(),
        };
        let Some(segment) = segment else { return Vec::new() };
        let item = match kind {
            DeltaKind::Assistant => (!segment.text.trim().is_empty())
                .then(|| Item { text: Some(clip(&segment.text, TEXT_MAX)), ..Item::new(ItemKind::Assistant, segment.id, at) }),
            DeltaKind::Reasoning => Item::reasoning(segment.id, at, &segment.text),
        };
        item.map(|i| vec![Out::Item(Box::new(i))]).unwrap_or_default()
    }

    /// Fecha o texto e o raciocínio que estavam chegando (uma ferramenta começou, ou o turno acabou).
    pub fn flush(&mut self, at: Option<i64>) -> Vec<Out> {
        let mut out = self.close_segment(DeltaKind::Reasoning, at);
        out.extend(self.close_segment(DeltaKind::Assistant, at));
        out
    }

    fn tool_update(&mut self, update: &Value, at: Option<i64>) -> Vec<Out> {
        let Some(id) = str_of(update, "toolCallId").filter(|s| !s.is_empty()) else { return Vec::new() };
        let call = self.calls.entry(id.to_string()).or_insert_with(|| json!({ "_at": at }));
        merge(call, update);
        let started = call.get("_at").and_then(Value::as_i64).or(at);
        let mut item = tool_item(id, call, started);
        let status = str_of(call, "status").unwrap_or("pending");
        if self.denied.contains(id) && status == "failed" {
            item.status = Some(ToolStatus::Denied);
        }
        if let Some(output) = tool_output(call).filter(|o| !o.trim().is_empty()) {
            item.output = Some(clip(&output, OUTPUT_MAX));
        }
        if !matches!(item.status, Some(ToolStatus::Running)) {
            self.calls.remove(id);
            self.denied.remove(id);
        }
        vec![Out::Item(Box::new(item))]
    }
}

/// Junta uma atualização na ferramenta: o que ela traz (não nulo) vale; o resto fica como estava
/// (a atualização costuma trazer só o `status` e o que mudou).
fn merge(into: &mut Value, update: &Value) {
    if let (Some(into), Some(update)) = (into.as_object_mut(), update.as_object()) {
        for (key, value) in update.iter().filter(|(_, v)| !v.is_null()) {
            into.insert(key.clone(), value.clone());
        }
    }
}

fn tool_status(status: &str) -> ToolStatus {
    match status {
        "completed" => ToolStatus::Done,
        "failed" => ToolStatus::Error,
        _ => ToolStatus::Running,
    }
}

/// O texto que uma ferramenta devolveu: o `content` (blocos de texto) ou o `rawOutput`.
fn tool_output(update: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for block in update.get("content").and_then(Value::as_array).into_iter().flatten() {
        if str_of(block, "type") == Some("content")
            && let Some(text) = block.pointer("/content/text").and_then(Value::as_str)
        {
            parts.push(text.to_string());
        }
    }
    if !parts.is_empty() {
        return Some(parts.join("\n"));
    }
    match update.get("rawOutput")? {
        Value::String(s) => Some(s.clone()),
        other => other.get("output").and_then(Value::as_str).map(str::to_string),
    }
}

/// O primeiro `diff` do `content` de uma ferramenta: `(caminho, texto velho, texto novo)`.
fn diff_of(update: &Value) -> Option<(String, String, String)> {
    update.get("content")?.as_array()?.iter().find(|b| str_of(b, "type") == Some("diff")).map(|d| {
        (str_of(d, "path").unwrap_or("").to_string(), str_of(d, "oldText").unwrap_or("").to_string(), str_of(d, "newText").unwrap_or("").to_string())
    })
}

/// O caminho que a ferramenta mexe: o `locations`, o diff ou a entrada crua.
fn path_of(update: &Value) -> Option<String> {
    let input = update.get("rawInput").unwrap_or(&Value::Null);
    update.pointer("/locations/0/path").and_then(Value::as_str)
        .or_else(|| str_of(input, "filePath"))
        .or_else(|| str_of(input, "file_path"))
        .or_else(|| str_of(input, "path"))
        .map(str::to_string)
        .or_else(|| diff_of(update).map(|d| d.0).filter(|p| !p.is_empty()))
}

/// Uma ferramenta do OpenCode (o `tool_call` ou a `tool_call_update`) como a timeline do transcript
/// já mostra: vira a ferramenta do Claude equivalente e passa por `claude_tool`. Pura.
pub fn tool_item(id: &str, update: &Value, at: Option<i64>) -> Item {
    let input = update.get("rawInput").cloned().unwrap_or(Value::Null);
    let title = str_of(update, "title").unwrap_or("");
    let path = path_of(update);
    let mut item = match str_of(update, "kind").unwrap_or("other") {
        "read" => claude_tool(id, "Read", &json!({ "file_path": path }), at),
        "edit" | "delete" | "move" => {
            let kind = str_of(update, "kind").unwrap_or("edit");
            if let Some((diff_path, old, new)) = diff_of(update) {
                let file = if diff_path.is_empty() { path.clone().unwrap_or_default() } else { diff_path };
                if old.is_empty() {
                    claude_tool(id, "Write", &json!({ "file_path": file, "content": new }), at)
                } else {
                    claude_tool(id, "Edit", &json!({ "file_path": file, "old_string": old, "new_string": new }), at)
                }
            } else if kind == "edit" && input.get("content").is_some() && input.get("oldString").is_none() {
                claude_tool(id, "Write", &json!({ "file_path": path, "content": str_of(&input, "content").unwrap_or("") }), at)
            } else {
                claude_tool(id, "Edit", &json!({
                    "file_path": path,
                    "old_string": str_of(&input, "oldString").or_else(|| str_of(&input, "old_string")).unwrap_or(""),
                    "new_string": str_of(&input, "newString").or_else(|| str_of(&input, "new_string")).unwrap_or(""),
                }), at)
            }
        }
        "execute" => {
            let command = str_of(&input, "command").unwrap_or(title);
            claude_tool(id, "Bash", &json!({ "command": command }), at)
        }
        "search" => {
            let pattern = str_of(&input, "pattern").or_else(|| str_of(&input, "query")).unwrap_or(title);
            claude_tool(id, "Grep", &json!({ "pattern": pattern, "path": path }), at)
        }
        "fetch" => {
            let url = str_of(&input, "url").or_else(|| str_of(&input, "query")).unwrap_or(title);
            claude_tool(id, "WebFetch", &json!({ "url": url }), at)
        }
        // `think` é o subagente (`task`) do OpenCode; o que ele faz dentro fica na ferramenta.
        "think" => claude_tool(id, "Task", &json!({ "description": title }), at),
        _ => claude_tool(id, if title.is_empty() { "tool" } else { title }, &input, at),
    };
    item.status = Some(tool_status(str_of(update, "status").unwrap_or("pending")));
    item
}

/// O pedido `session/request_permission` em algo para mostrar. As opções do protocolo ficam em
/// `options.acp` (a tela só lê `options` de uma pergunta ou do `ExitPlanMode`, que aqui não são).
/// `None` = um pedido sem opções para escolher.
pub fn ask_of(params: &Value) -> Option<Ask> {
    let options: Vec<Value> = params.get("options")?.as_array()?.iter()
        .filter_map(|o| Some(json!({ "optionId": str_of(o, "optionId")?, "kind": str_of(o, "kind").unwrap_or(""), "name": str_of(o, "name").unwrap_or("") })))
        .collect();
    if options.is_empty() {
        return None;
    }
    let call = params.get("toolCall").unwrap_or(&Value::Null);
    let item_id = str_of(call, "toolCallId").map(str::to_string);
    let input = call.get("rawInput").unwrap_or(&Value::Null);
    let title = str_of(call, "title").unwrap_or("");
    let acp = json!({ "acp": options });
    Some(match str_of(call, "kind").unwrap_or("other") {
        "edit" | "delete" | "move" => {
            let path = path_of(call).unwrap_or_else(|| title.to_string());
            Ask { kind: "fileChange", item_id, title: path, detail: String::new(), options: acp }
        }
        "execute" => {
            let command = str_of(input, "command").map(|c| first_line(c, 200)).unwrap_or_else(|| title.to_string());
            Ask { kind: "command", item_id, title: command, detail: str_of(input, "description").unwrap_or("").to_string(), options: acp }
        }
        _ => Ask { kind: "command", item_id, title: title.to_string(), detail: String::new(), options: acp },
    })
}

fn option_of(options: &Value, kinds: &[&str]) -> Option<String> {
    let list = options.get("acp").and_then(Value::as_array)?;
    kinds.iter().find_map(|kind| list.iter().find(|o| str_of(o, "kind") == Some(kind)).and_then(|o| str_of(o, "optionId")).map(str::to_string))
}

/// A resposta ao `session/request_permission` pela escolha da pessoa: `allow` (só esta vez),
/// `allowSession` (`allow_always` do OpenCode: vale até o fim da sessão), `deny` (`reject_once`) ou
/// `cancel` (cancela o pedido). Sem a opção pedida (o OpenCode não ofereceu), `allowSession` cai em
/// `allow` e a negação em cancelar: nunca dá mais permissão do que a pedida.
pub fn answer_of(options: &Value, choice: &str) -> Value {
    let picked = match choice {
        "allow" => option_of(options, &["allow_once"]),
        "allowSession" => option_of(options, &["allow_always", "allow_once"]),
        "cancel" => None,
        _ => option_of(options, &["reject_once", "reject_always"]),
    };
    match picked {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// O resultado de `session/prompt` (`stopReason`) no fim do turno. Os tokens vêm à parte
/// ([`usage_item`]).
pub fn turn_result(response: &Value, duration_ms: Option<i64>) -> TurnResult {
    match str_of(response, "stopReason").unwrap_or("end_turn") {
        "cancelled" => TurnResult { interrupted: true, error: None, duration_ms },
        "refusal" => TurnResult { interrupted: false, error: Some("O modelo recusou o pedido".into()), duration_ms },
        "max_tokens" => TurnResult { interrupted: false, error: Some("O turno parou no limite de tokens do modelo".into()), duration_ms },
        "max_turn_requests" => TurnResult { interrupted: false, error: Some("O turno parou no limite de chamadas ao modelo".into()), duration_ms },
        _ => TurnResult { interrupted: false, error: None, duration_ms },
    }
}

/// Os tokens do turno, se o OpenCode os mandou na resposta (`usage`, do ACP).
pub fn usage_item(turn: &str, response: &Value, at: Option<i64>) -> Option<Item> {
    let usage = response.get("usage")?;
    let n = |key: &str| usage.get(key).and_then(Value::as_u64);
    let total = n("totalTokens").or_else(|| Some(n("inputTokens")? + n("outputTokens").unwrap_or(0) + n("thoughtTokens").unwrap_or(0)))?;
    (total > 0).then(|| Item::usage(format!("usage:{turn}"), at, total))
}

/// O texto do erro de um `session/prompt` que falhou, curto.
pub fn error_text(message: &str) -> String {
    clip(message, OUTPUT_MAX)
}
