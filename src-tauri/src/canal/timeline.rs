//! A conversa de uma aba como timeline, para o modo chat: as mensagens da pessoa, as falas do
//! agente e cada ferramenta (o que leu, editou, rodou), lidas do MESMO transcript do canal
//! (`claude.rs`, `codex.rs`). A TUI continua sendo o motor; isto só desenha o que ela gravou.
//!
//! Diferente do estado (`state.rs`), que só guarda o turno atual, aqui entra a conversa inteira
//! — limitada ao fim do arquivo (`MAX_BYTES`), porque um rollout pode passar de 100 MB.
//!
//! O builder é puro (linhas → itens). Quem lê o disco é [`read`].

use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::event::{clip, first_line, parse_ts_ms};

/// Quanto do fim do transcript vira timeline. O começo de conversas longas fica de fora (e a
/// timeline diz que foi cortada).
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
/// O tamanho máximo de um texto da conversa e do resultado de uma ferramenta.
const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    User,
    Assistant,
    Tool,
    TurnEnd,
}

/// Que tipo de ferramenta, para o ícone e o verbo da linha ("Leu", "Editou", "Rodou").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Read,
    Edit,
    Write,
    Command,
    Search,
    Web,
    Task,
    Question,
    Todo,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Running,
    Done,
    Error,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub text: String,
    pub options: Vec<String>,
}

/// Um item da timeline. Os campos que não valem para o tipo ficam de fora do JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: ItemKind,
    pub id: String,
    /// Quando (ms), se a linha tem carimbo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// A mensagem (pessoa ou agente).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    // Ferramenta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolKind>,
    /// O resumo: o comando, o padrão buscado, a URL…
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// O arquivo lido ou editado.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Linhas acrescentadas e tiradas numa edição (aproximado: linhas do trecho novo e do velho).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ToolStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<Question>,
    // Fim de turno.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

impl Item {
    pub(crate) fn new(kind: ItemKind, id: String, at: Option<i64>) -> Item {
        Item {
            kind, id, at, text: None, name: None, tool: None, label: None, path: None, added: None, removed: None,
            status: None, output: None, question: None, interrupted: None, duration_ms: None,
        }
    }

    fn message(kind: ItemKind, id: String, at: Option<i64>, text: &str) -> Item {
        Item { text: Some(clip(text, TEXT_MAX)), ..Item::new(kind, id, at) }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub items: Vec<Item>,
    /// O começo da conversa ficou de fora (arquivo maior que [`MAX_BYTES`]).
    pub truncated: bool,
}

/// Monta a timeline linha a linha.
#[derive(Default)]
pub struct Builder {
    items: Vec<Item>,
    tools: HashMap<String, usize>,
    /// Codex: quando o turno começou, para a duração no fim.
    turn_started: Option<i64>,
    seq: usize,
}

impl Builder {
    pub fn feed(&mut self, agent_id: &str, line: &Value) {
        let at = line.get("timestamp").and_then(Value::as_str).and_then(parse_ts_ms);
        match agent_id {
            "claude-code" => self.claude(line, at),
            "codex" => self.codex(line, at),
            _ => {}
        }
    }

    pub fn finish(self, truncated: bool) -> Timeline {
        Timeline { items: self.items, truncated }
    }

    fn next_id(&mut self, base: Option<&str>) -> String {
        self.seq += 1;
        match base {
            Some(b) if !b.is_empty() => format!("{b}#{}", self.seq),
            _ => format!("i{}", self.seq),
        }
    }

    fn push_tool(&mut self, item: Item) {
        self.tools.insert(item.id.clone(), self.items.len());
        self.items.push(item);
    }

    fn finish_tool(&mut self, id: &str, status: ToolStatus, output: Option<String>) {
        if let Some(&index) = self.tools.get(id) {
            let tool = &mut self.items[index];
            tool.status = Some(status);
            if output.as_deref().is_some_and(|o| !o.trim().is_empty()) {
                tool.output = output;
            }
        }
    }

    // ── Claude Code ──────────────────────────────────────────────────

    fn claude(&mut self, line: &Value, at: Option<i64>) {
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let uuid = line.get("uuid").and_then(Value::as_str).map(str::to_string);
        match line.get("type").and_then(Value::as_str) {
            Some("user") => self.claude_user(line, at, uuid.as_deref()),
            Some("assistant") => self.claude_assistant(line, at, uuid.as_deref()),
            Some("system") if line.get("subtype").and_then(Value::as_str) == Some("turn_duration") => {
                let id = self.next_id(uuid.as_deref());
                let duration = line.get("durationMs").and_then(Value::as_i64);
                self.items.push(Item { interrupted: Some(false), duration_ms: duration, ..Item::new(ItemKind::TurnEnd, id, at) });
            }
            _ => {}
        }
    }

    fn claude_user(&mut self, line: &Value, at: Option<i64>, uuid: Option<&str>) {
        if line.get("isMeta").and_then(Value::as_bool) == Some(true)
            || line.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let denied = line.get("toolDenialKind").is_some()
            || line.pointer("/permissionDecision/decision").and_then(Value::as_str).is_some_and(|d| d != "accept");
        let mut prompt: Vec<String> = Vec::new();
        let mut interrupted = false;
        match line.pointer("/message/content") {
            Some(Value::String(text)) => {
                if text.starts_with(INTERRUPTED) {
                    interrupted = true;
                } else if !is_markup(text) && !text.trim().is_empty() {
                    prompt.push(text.clone());
                }
            }
            Some(Value::Array(blocks)) => {
                let has_results = blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"));
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else { continue };
                            let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                            let status = if denied { ToolStatus::Denied } else if error { ToolStatus::Error } else { ToolStatus::Done };
                            let output = result_text(block.get("content")).map(|o| clip(&o, OUTPUT_MAX));
                            self.finish_tool(id, status, output);
                        }
                        Some("text") if !has_results => {
                            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                            if text.starts_with(INTERRUPTED) {
                                interrupted = true;
                            } else if !is_markup(text) && !text.trim().is_empty() {
                                prompt.push(text.to_string());
                            }
                        }
                        Some("image") if !has_results => prompt.push("[imagem]".into()),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if interrupted {
            let id = self.next_id(uuid);
            self.items.push(Item { interrupted: Some(true), ..Item::new(ItemKind::TurnEnd, id, at) });
        } else if !prompt.is_empty() {
            let id = self.next_id(uuid);
            self.items.push(Item::message(ItemKind::User, id, at, &prompt.join("\n\n")));
        }
    }

    fn claude_assistant(&mut self, line: &Value, at: Option<i64>, uuid: Option<&str>) {
        let Some(blocks) = line.pointer("/message/content").and_then(Value::as_array) else { return };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                        let id = self.next_id(uuid);
                        self.items.push(Item::message(ItemKind::Assistant, id, at, text));
                    }
                }
                Some("tool_use") => {
                    let Some(id) = block.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
                    let name = block.get("name").and_then(Value::as_str).unwrap_or_default();
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    self.push_tool(claude_tool(id, name, &input, at));
                }
                _ => {}
            }
        }
    }

    // ── Codex ────────────────────────────────────────────────────────

    fn codex(&mut self, line: &Value, at: Option<i64>) {
        let Some(payload) = line.get("payload") else { return };
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match line.get("type").and_then(Value::as_str) {
            Some("event_msg") => match kind {
                "task_started" => self.turn_started = at,
                "user_message" => {
                    if let Some(text) = payload.get("message").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                        let id = self.next_id(None);
                        self.items.push(Item::message(ItemKind::User, id, at, text));
                    }
                }
                "agent_message" => {
                    if let Some(text) = payload.get("message").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                        let id = self.next_id(None);
                        self.items.push(Item::message(ItemKind::Assistant, id, at, text));
                    }
                }
                "task_complete" | "turn_aborted" => {
                    let id = self.next_id(None);
                    let duration = match (self.turn_started.take(), at) {
                        (Some(start), Some(end)) if end >= start => Some(end - start),
                        _ => None,
                    };
                    self.items.push(Item { interrupted: Some(kind == "turn_aborted"), duration_ms: duration, ..Item::new(ItemKind::TurnEnd, id, at) });
                }
                _ => {}
            },
            Some("response_item") => match kind {
                "function_call" | "custom_tool_call" | "local_shell_call" => {
                    let Some(id) = payload.get("call_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return };
                    let name = payload.get("name").and_then(Value::as_str).unwrap_or(kind);
                    self.push_tool(codex_tool(id, name, payload, at));
                }
                "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                    let Some(id) = payload.get("call_id").and_then(Value::as_str) else { return };
                    let (status, output) = codex_output(payload.get("output"));
                    self.finish_tool(id, status, output.map(|o| clip(&o, OUTPUT_MAX)));
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// O que o Claude Code escreve como mensagem do usuário quando a pessoa aperta Esc.
const INTERRUPTED: &str = "[Request interrupted by user";

/// Linhas de "usuário" que não são um prompt (saída de comando local, avisos do próprio Claude).
fn is_markup(text: &str) -> bool {
    let t = text.trim_start();
    ["<command-name>", "<command-message>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>", "<bash-stdout>", "<bash-stderr>", "<system-reminder>"]
        .iter()
        .any(|tag| t.starts_with(tag))
}

/// O texto de um `tool_result`: string, ou blocos `{type: text}`.
fn result_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

/// Linhas de um trecho de texto (0 para vazio).
pub fn count_lines(text: &str) -> u32 {
    if text.is_empty() { 0 } else { text.lines().count().max(1) as u32 }
}

fn tool_item(id: &str, name: &str, kind: ToolKind, at: Option<i64>) -> Item {
    Item { name: Some(name.to_string()), tool: Some(kind), status: Some(ToolStatus::Running), ..Item::new(ItemKind::Tool, id.to_string(), at) }
}

/// Uma ferramenta do Claude Code, com o que importa para a linha da timeline. Pura.
pub fn claude_tool(id: &str, name: &str, input: &Value, at: Option<i64>) -> Item {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let mut item = match name {
        "Read" => Item { path: field("file_path").map(str::to_string), ..tool_item(id, name, ToolKind::Read, at) },
        "Edit" => Item {
            path: field("file_path").map(str::to_string),
            added: Some(count_lines(field("new_string").unwrap_or(""))),
            removed: Some(count_lines(field("old_string").unwrap_or(""))),
            ..tool_item(id, name, ToolKind::Edit, at)
        },
        "MultiEdit" => {
            let edits = input.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
            let sum = |key: &str| edits.iter().map(|e| count_lines(e.get(key).and_then(Value::as_str).unwrap_or(""))).sum::<u32>();
            Item { path: field("file_path").map(str::to_string), added: Some(sum("new_string")), removed: Some(sum("old_string")), ..tool_item(id, name, ToolKind::Edit, at) }
        }
        "NotebookEdit" => Item { path: field("notebook_path").map(str::to_string), ..tool_item(id, name, ToolKind::Edit, at) },
        "Write" => Item {
            path: field("file_path").map(str::to_string),
            added: Some(count_lines(field("content").unwrap_or(""))),
            removed: Some(0),
            ..tool_item(id, name, ToolKind::Write, at)
        },
        "Bash" | "PowerShell" => Item { label: field("command").map(|c| first_line(c, 200)), ..tool_item(id, name, ToolKind::Command, at) },
        "Grep" | "Glob" => Item { label: field("pattern").map(|p| first_line(p, 160)), path: field("path").map(str::to_string), ..tool_item(id, name, ToolKind::Search, at) },
        "WebFetch" => Item { label: field("url").map(|u| first_line(u, 200)), ..tool_item(id, name, ToolKind::Web, at) },
        "WebSearch" => Item { label: field("query").map(|q| first_line(q, 200)), ..tool_item(id, name, ToolKind::Web, at) },
        "Task" | "Agent" => Item { label: field("description").map(|d| first_line(d, 160)), ..tool_item(id, name, ToolKind::Task, at) },
        "TodoWrite" => {
            let n = input.get("todos").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            Item { label: Some(n.to_string()), ..tool_item(id, name, ToolKind::Todo, at) }
        }
        "AskUserQuestion" => Item { question: question_of(input), ..tool_item(id, name, ToolKind::Question, at) },
        _ => Item { label: Some(first_line(name, 120)), ..tool_item(id, name, ToolKind::Other, at) },
    };
    if item.label.is_none() && item.path.is_none() && item.question.is_none() {
        item.label = Some(name.to_string());
    }
    item
}

/// A primeira pergunta de um AskUserQuestion / request_user_input, com as opções.
fn question_of(input: &Value) -> Option<Question> {
    let first = input.pointer("/questions/0").unwrap_or(input);
    let text = first.get("question").or_else(|| first.get("prompt")).and_then(Value::as_str)?;
    let options = first
        .get("options")
        .and_then(Value::as_array)
        .map(|o| o.iter().filter_map(|x| x.get("label").and_then(Value::as_str).or_else(|| x.as_str())).map(|l| clip(l, 120)).collect())
        .unwrap_or_default();
    Some(Question { text: clip(text, 600), options })
}

/// Uma ferramenta do Codex. O `apply_patch` vira edição, com os arquivos e o `+/−` do patch. Pura.
pub fn codex_tool(id: &str, name: &str, payload: &Value, at: Option<i64>) -> Item {
    let args: Option<Value> = payload.get("arguments").and_then(Value::as_str).and_then(|raw| serde_json::from_str(raw).ok());
    let input = payload.get("input").and_then(Value::as_str);
    let patch = input.filter(|i| i.contains("*** Begin Patch")).or_else(|| {
        args.as_ref().and_then(|a| a.get("input").or_else(|| a.get("patch"))).and_then(Value::as_str).filter(|p| p.contains("*** Begin Patch"))
    });
    if name == "apply_patch" || patch.is_some() {
        let stats = patch.map(patch_stats).unwrap_or_default();
        let mut item = Item { added: Some(stats.added), removed: Some(stats.removed), ..tool_item(id, name, ToolKind::Edit, at) };
        item.path = stats.files.first().cloned();
        if stats.files.len() > 1 {
            item.label = Some(stats.files.join(", "));
        }
        return item;
    }
    if name == "update_plan" {
        let n = args.as_ref().and_then(|a| a.get("plan")).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        return Item { label: Some(n.to_string()), ..tool_item(id, name, ToolKind::Todo, at) };
    }
    if name == "request_user_input" {
        return Item { question: args.as_ref().and_then(question_of), ..tool_item(id, name, ToolKind::Question, at) };
    }
    let command = args.as_ref().and_then(|a| a.get("cmd").or_else(|| a.get("command"))).and_then(|c| match c {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        _ => None,
    });
    if let Some(command) = command.or_else(|| input.map(str::to_string)).filter(|c| !c.trim().is_empty()) {
        return Item { label: Some(first_line(&command, 200)), ..tool_item(id, name, ToolKind::Command, at) };
    }
    Item { label: Some(name.to_string()), ..tool_item(id, name, ToolKind::Other, at) }
}

#[derive(Default, Debug, PartialEq)]
pub struct PatchStats {
    pub files: Vec<String>,
    pub added: u32,
    pub removed: u32,
}

/// Os arquivos e as linhas de um patch do Codex (`*** Update File: …`, linhas `+`/`-`). Pura.
pub fn patch_stats(patch: &str) -> PatchStats {
    let mut stats = PatchStats::default();
    for line in patch.lines() {
        if let Some(path) = ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|p| line.strip_prefix(p)) {
            stats.files.push(path.trim().to_string());
        } else if line.starts_with("***") || line.starts_with("@@") {
            continue;
        } else if line.starts_with('+') {
            stats.added += 1;
        } else if line.starts_with('-') {
            stats.removed += 1;
        }
    }
    stats
}

/// O resultado de uma ferramenta do Codex: texto, ou `{output, metadata: {exit_code}}`.
fn codex_output(raw: Option<&Value>) -> (ToolStatus, Option<String>) {
    let text = match raw {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => return (ToolStatus::Done, None),
    };
    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
        if let Some(output) = parsed.get("output").and_then(Value::as_str) {
            let code = parsed.pointer("/metadata/exit_code").and_then(Value::as_i64).unwrap_or(0);
            return (if code == 0 { ToolStatus::Done } else { ToolStatus::Error }, Some(output.to_string()));
        }
    }
    (ToolStatus::Done, Some(text))
}

/// A timeline de linhas já lidas. Pura.
pub fn build<'a>(agent_id: &str, lines: impl IntoIterator<Item = &'a [u8]>, truncated: bool) -> Timeline {
    let mut builder = Builder::default();
    for line in lines {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            builder.feed(agent_id, &value);
        }
    }
    builder.finish(truncated)
}

/// Lê o fim do transcript (até [`MAX_BYTES`]) e monta a timeline. Abre e fecha o arquivo.
pub fn read(path: &Path, agent_id: &str) -> io::Result<Timeline> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let truncated = len > MAX_BYTES;
    if truncated {
        file.seek(SeekFrom::Start(len - MAX_BYTES))?;
    }
    let mut bytes = Vec::with_capacity(len.min(MAX_BYTES) as usize);
    file.read_to_end(&mut bytes)?;
    // Começando no meio, a primeira linha está cortada.
    let start = if truncated { bytes.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(bytes.len()) } else { 0 };
    let lines = bytes[start..].split(|&b| b == b'\n').filter(|l| !l.is_empty());
    Ok(build(agent_id, lines, truncated))
}
