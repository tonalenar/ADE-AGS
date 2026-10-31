//! O que vem do Claude Code em `--output-format stream-json` virando o que a timeline do chat já
//! desenha (`canal::timeline::Item`), e o que o chat escolhe virando flags e respostas do
//! protocolo. Puro.
//!
//! O protocolo é o da versão instalada (2.1.312, o mesmo que o Agent SDK usa): uma linha JSON por
//! mensagem nos dois sentidos.
//! - Saída: `system` (`init` e `status`, com `permissionMode`), `assistant` (UM bloco por linha:
//!   `thinking`, `text` ou `tool_use`, com o mesmo `message.id`), `user` (os `tool_result`, e o
//!   `[Request interrupted by user]`), `stream_event` (os pedaços do texto e do raciocínio, com
//!   `api_message_id` e `index` do bloco) e `result` (o fim do turno).
//! - Controle: `control_request` / `control_response` com `request_id`, nos dois sentidos. O
//!   cliente manda `initialize`, `interrupt` e `set_permission_mode`; o Claude manda `can_use_tool`
//!   (com `--permission-prompt-tool stdio`) e espera `{behavior: allow | deny}`.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::canal::event::{clip, first_line, parse_ts_ms};
use crate::canal::timeline::{claude_tokens, claude_tool, result_text, Item, ItemKind, ToolKind, ToolStatus};

use super::codex_map::{Ask, DeltaKind};
use super::store::ThreadRow;

const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;
const LABEL_MAX: usize = 200;
/// O texto que o Claude grava como fala do usuário quando o turno é interrompido.
const INTERRUPTED: &str = "[Request interrupted by user";

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// O acesso do chat no `--permission-mode` do Claude.
/// - Supervisionado (`ask`) → `default`: pergunta tudo que não é leitura;
/// - Aceitar edições (`edits`) → `acceptEdits`;
/// - Auto (`safe`) → `auto`, o mesmo nível seguro das missões (`withAutonomy`): um classificador
///   do Claude revisa cada ação, sem `bypassPermissions`;
/// - Acesso total (`full`) → `bypassPermissions`;
/// - Plano (`plan`) → `plan`: só lê e planeja; sair do plano é um pedido (`ExitPlanMode`).
pub fn permission_mode(access: &str) -> &'static str {
    match access {
        "edits" => "acceptEdits",
        "safe" => "auto",
        "full" => "bypassPermissions",
        "plan" => "plan",
        _ => "default",
    }
}

/// O inverso de [`permission_mode`]: o modo que o Claude diz estar usando, no acesso do chat.
/// `None` para um modo que o chat não tem (`dontAsk`).
pub fn access_of_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "default" | "manual" => Some("ask"),
        "acceptEdits" => Some("edits"),
        "auto" => Some("safe"),
        "bypassPermissions" => Some("full"),
        "plan" => Some("plan"),
        _ => None,
    }
}

/// Como o processo abre a sessão do Claude: uma nova com o id escolhido pelo app, ou a retomada.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start<'a> {
    New(&'a str),
    Resume(&'a str),
}

/// Os argumentos do `claude` de uma conversa. Pura.
pub fn launch_args(row: &ThreadRow, start: Start<'_>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        // Os pedidos de permissão vêm pelo próprio stdio (`can_use_tool`), não por uma tool MCP.
        "--permission-prompt-tool", "stdio",
        "--permission-mode", permission_mode(&row.access),
    ]
    .map(String::from)
    .to_vec();
    match start {
        Start::New(id) => args.extend(["--session-id".into(), id.into()]),
        Start::Resume(id) => args.extend(["--resume".into(), id.into()]),
    }
    if let Some(model) = row.model.as_deref().filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = row.effort.as_deref().filter(|e| !e.is_empty()) {
        args.extend(["--effort".into(), effort.into()]);
    }
    args
}

/// A mensagem do usuário no formato do `--input-format stream-json`.
pub fn user_message(text: &str) -> Value {
    user_message_with(text, Vec::new())
}

/// Com imagens em linha: os blocos `image` (base64) vêm antes do texto, como o Claude Code os monta.
pub fn user_message_with(text: &str, images: Vec<Value>) -> Value {
    let mut content = images;
    content.push(json!({ "type": "text", "text": text }));
    json!({ "type": "user", "message": { "role": "user", "content": content }, "parent_tool_use_id": null, "session_id": "" })
}

/// O que uma linha da saída significa para a conversa.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Um item novo ou atualizado da timeline (numa caixa: o item é bem maior que as outras variantes).
    Item(Box<Item>),
    /// Um pedaço do texto (ou do raciocínio) do agente chegando (`item_id` é o do item que vai
    /// fechar o texto).
    Delta { item_id: String, delta: String, kind: DeltaKind },
    /// O modo de permissão que o Claude diz estar usando.
    Mode(String),
    /// O id da sessão do Claude (para retomar).
    Session(String),
    /// O turno acabou.
    Done(TurnResult),
}

#[derive(Debug, Default, PartialEq)]
pub struct TurnResult {
    pub interrupted: bool,
    /// A mensagem de um turno que falhou.
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
}

/// Lê a saída do Claude linha a linha. Guarda o que precisa para dar ids estáveis (o texto que
/// chega em pedaços e o item final têm o mesmo id) e para fechar as ferramentas.
#[derive(Default)]
pub struct Mapper {
    /// As ferramentas abertas, para atualizar quando chega o resultado.
    tools: HashMap<String, Item>,
    /// Quantos blocos de cada mensagem já chegaram (o `index` do bloco na mensagem).
    blocks: HashMap<String, usize>,
    /// As ferramentas que a pessoa negou.
    denied: HashSet<String>,
    interrupted: bool,
}

impl Mapper {
    /// A pessoa negou esta ferramenta: o resultado dela aparece como negado.
    pub fn deny(&mut self, tool_use_id: &str) {
        self.denied.insert(tool_use_id.to_string());
    }

    /// O que uma linha da saída vira. `now` é o carimbo das linhas que não trazem o seu.
    pub fn feed(&mut self, line: &Value, now: i64) -> Vec<Out> {
        // O que um subagente faz fica dentro da ferramenta dele (como `isSidechain` no transcript).
        if line.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return Vec::new();
        }
        let at = Some(str_of(line, "timestamp").and_then(parse_ts_ms).unwrap_or(now));
        match str_of(line, "type").unwrap_or("") {
            "system" => self.system(line),
            "assistant" => self.assistant(line, at),
            "user" => self.user(line),
            "stream_event" => delta_of(line).into_iter().collect(),
            "result" => {
                let interrupted = std::mem::take(&mut self.interrupted)
                    || str_of(line, "terminal_reason").is_some_and(|r| r.starts_with("aborted"));
                let failed = line.get("is_error").and_then(Value::as_bool) == Some(true) && !interrupted;
                let error = failed.then(|| error_of(line));
                vec![Out::Done(TurnResult { interrupted, error, duration_ms: line.get("duration_ms").and_then(Value::as_i64) })]
            }
            _ => Vec::new(),
        }
    }

    fn system(&self, line: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        if str_of(line, "subtype") == Some("init")
            && let Some(id) = str_of(line, "session_id")
        {
            out.push(Out::Session(id.to_string()));
        }
        if let Some(mode) = str_of(line, "permissionMode") {
            out.push(Out::Mode(mode.to_string()));
        }
        out
    }

    fn assistant(&mut self, line: &Value, at: Option<i64>) -> Vec<Out> {
        let message_id = line.pointer("/message/id").and_then(Value::as_str).or_else(|| str_of(line, "uuid")).unwrap_or("").to_string();
        let blocks = line.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut out = Vec::new();
        // Os tokens da mensagem: cada linha repete o `usage`, e o item (mesmo id) fica com o último.
        if let Some(tokens) = claude_tokens(line.pointer("/message/usage")).filter(|_| !message_id.is_empty()) {
            out.push(Out::Item(Box::new(Item::usage(format!("usage:{message_id}"), at, tokens))));
        }
        for block in &blocks {
            let seen = self.blocks.entry(message_id.clone()).or_insert(0);
            let index = *seen;
            *seen += 1;
            match str_of(block, "type") {
                Some("thinking") => {
                    if let Some(item) = Item::reasoning(block_id(&message_id, index), at, str_of(block, "thinking").unwrap_or("")) {
                        out.push(Out::Item(Box::new(item)));
                    }
                }
                Some("text") => {
                    let text = str_of(block, "text").unwrap_or("");
                    if !text.trim().is_empty() {
                        out.push(Out::Item(Box::new(Item { text: Some(clip(text, TEXT_MAX)), ..Item::new(ItemKind::Assistant, block_id(&message_id, index), at) })));
                    }
                }
                Some("tool_use") => {
                    let Some(id) = str_of(block, "id").filter(|s| !s.is_empty()) else { continue };
                    let name = str_of(block, "name").unwrap_or("");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    let item = tool_item(id, name, &input, at);
                    self.tools.insert(id.to_string(), item.clone());
                    out.push(Out::Item(Box::new(item)));
                }
                _ => {}
            }
        }
        out
    }

    fn user(&mut self, line: &Value) -> Vec<Out> {
        let content = line.pointer("/message/content");
        if let Some(Value::String(text)) = content {
            self.interrupted |= text.starts_with(INTERRUPTED);
            return Vec::new();
        }
        let meta: HashMap<&str, &str> = line.get("tool_result_meta").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|m| Some((str_of(m, "id")?, m.pointer("/permission_decision/decision").and_then(Value::as_str)?)))
            .collect();
        let mut out = Vec::new();
        for block in content.and_then(Value::as_array).into_iter().flatten() {
            match str_of(block, "type") {
                Some("text") => self.interrupted |= str_of(block, "text").is_some_and(|t| t.starts_with(INTERRUPTED)),
                Some("tool_result") => {
                    let Some(id) = str_of(block, "tool_use_id") else { continue };
                    let Some(mut item) = self.tools.remove(id) else { continue };
                    let denied = self.denied.remove(id) || meta.get(id).is_some_and(|d| *d != "accept");
                    let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    item.status = Some(if denied { ToolStatus::Denied } else if error { ToolStatus::Error } else { ToolStatus::Done });
                    if let Some(output) = result_text(block.get("content")).filter(|o| !o.trim().is_empty()) {
                        // O plano já está no item; o "ok" do Claude não acrescenta nada.
                        if item.name.as_deref() != Some("ExitPlanMode") || denied || error {
                            item.output = Some(clip(&output, OUTPUT_MAX));
                        }
                    }
                    out.push(Out::Item(Box::new(item)));
                }
                _ => {}
            }
        }
        out
    }
}

/// O id de um bloco de texto: o mesmo para os pedaços (`stream_event`) e para o item final.
fn block_id(message_id: &str, index: usize) -> String {
    format!("{message_id}#{index}")
}

/// Um `stream_event` com um pedaço de texto (`text_delta`) ou de raciocínio (`thinking_delta`):
/// o id é o do bloco (`api_message_id` + `index`), o mesmo do item final. O resto dos eventos
/// parciais (o JSON da ferramenta, as assinaturas) não vira nada.
fn delta_of(line: &Value) -> Option<Out> {
    let event = line.get("event")?;
    if str_of(event, "type") != Some("content_block_delta") {
        return None;
    }
    let (kind, delta) = match event.pointer("/delta/type").and_then(Value::as_str)? {
        "text_delta" => (DeltaKind::Assistant, event.pointer("/delta/text").and_then(Value::as_str)?),
        "thinking_delta" => (DeltaKind::Reasoning, event.pointer("/delta/thinking").and_then(Value::as_str)?),
        _ => return None,
    };
    if delta.is_empty() {
        return None;
    }
    let message_id = str_of(line, "api_message_id")?;
    let index = event.get("index").and_then(Value::as_u64)? as usize;
    Some(Out::Delta { item_id: block_id(message_id, index), delta: delta.to_string(), kind })
}

fn error_of(result: &Value) -> String {
    let text = str_of(result, "result").filter(|r| !r.trim().is_empty()).map(str::to_string).or_else(|| {
        let errors: Vec<&str> = result.get("errors").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        (!errors.is_empty()).then(|| errors.join("\n"))
    });
    clip(&text.unwrap_or_else(|| "O Claude não concluiu o turno".into()), OUTPUT_MAX)
}

/// Uma ferramenta do Claude como a timeline do transcript já mostra (`claude_tool`); o
/// `ExitPlanMode` vira o plano, como o item `plan` do Codex.
pub fn tool_item(id: &str, name: &str, input: &Value, at: Option<i64>) -> Item {
    let mut item = claude_tool(id, name, input, at);
    if name == "ExitPlanMode" {
        let plan = str_of(input, "plan").unwrap_or("");
        item.tool = Some(ToolKind::Todo);
        item.label = Some(if plan.trim().is_empty() { name.to_string() } else { first_line(plan, LABEL_MAX) });
        item.output = (!plan.trim().is_empty()).then(|| clip(plan, OUTPUT_MAX));
    }
    item
}

/// As ferramentas que editam arquivos.
fn edits_files(tool: &str) -> bool {
    matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
}

/// O pedido `can_use_tool` (o `request` do `control_request`) em algo para mostrar. As opções de
/// uma aprovação levam o nome da ferramenta (`{tool}`), para a tela saber quando é a saída do Plano;
/// as de uma pergunta, as perguntas (o `id` de cada uma é o próprio texto, que é a chave da resposta).
pub fn ask_of(request: &Value) -> Option<Ask> {
    if str_of(request, "subtype") != Some("can_use_tool") {
        return None;
    }
    let tool = str_of(request, "tool_name")?;
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let item_id = str_of(request, "tool_use_id").map(str::to_string);
    let description = str_of(request, "description").unwrap_or("");
    let approval = |kind: &'static str, title: String, detail: String| Ask { kind, item_id: item_id.clone(), title, detail, options: json!({ "tool": tool }) };
    match tool {
        "AskUserQuestion" => {
            let questions: Vec<Value> = input.get("questions").and_then(Value::as_array).into_iter().flatten().map(|q| {
                let text = str_of(q, "question").unwrap_or("");
                json!({
                    "id": text,
                    "question": text,
                    "options": q.get("options").and_then(Value::as_array).into_iter().flatten()
                        .filter_map(|o| str_of(o, "label")).collect::<Vec<_>>(),
                })
            }).collect();
            let title = questions.first().and_then(|q| q.get("question")).and_then(Value::as_str).unwrap_or("").to_string();
            Some(Ask { kind: "question", item_id, title, detail: String::new(), options: Value::Array(questions) })
        }
        // O título fica para a tela ("o plano está pronto"); o plano vai no detalhe.
        "ExitPlanMode" => Some(approval("command", String::new(), clip(str_of(&input, "plan").unwrap_or(""), OUTPUT_MAX))),
        _ if edits_files(tool) => {
            let path = str_of(&input, "file_path").or_else(|| str_of(&input, "notebook_path")).unwrap_or(description);
            Some(approval("fileChange", path.to_string(), str_of(request, "blocked_path").unwrap_or("").to_string()))
        }
        "Bash" | "PowerShell" => {
            let command = str_of(&input, "command").map(|c| first_line(c, LABEL_MAX)).unwrap_or_default();
            Some(approval("command", command, str_of(&input, "description").unwrap_or("").to_string()))
        }
        _ => {
            let item = claude_tool("", tool, &input, None);
            let what = item.label.or(item.path).filter(|l| l != tool);
            let title = match what {
                Some(what) => format!("{tool}: {what}"),
                None => tool.to_string(),
            };
            let detail = if description.is_empty() || title.contains(description) { String::new() } else { description.to_string() };
            Some(approval("command", title, detail))
        }
    }
}

/// O que o app guarda de um `can_use_tool` pendente para responder depois (só em memória: se o
/// processo fecha, o pedido expira).
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub tool: String,
    pub input: Value,
    pub suggestions: Vec<Value>,
}

impl Pending {
    pub fn of(request: &Value) -> Pending {
        Pending {
            tool: str_of(request, "tool_name").unwrap_or("").to_string(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            suggestions: request.get("permission_suggestions").and_then(Value::as_array).cloned().unwrap_or_default(),
        }
    }
}

/// O que dizer ao agente quando a pessoa nega.
const DENIED: &str = "A pessoa negou esta ação. Não tente de novo do mesmo jeito; pergunte o que ela prefere.";
const KEEP_PLANNING: &str = "A pessoa quer continuar no modo Plano: ajuste o plano antes de editar qualquer coisa.";

fn set_mode(mode: &str) -> Value {
    json!({ "type": "setMode", "mode": mode, "destination": "session" })
}

/// A resposta ao `can_use_tool` e o acesso que a conversa passa a ter (quando a resposta troca o
/// modo). Aprovação: `allow` (só esta vez), `allowSession` (até o fim da sessão: as sugestões do
/// Claude, sempre só na sessão, nunca gravadas nos settings do projeto), `deny` ou `cancel` (nega e
/// para o turno). Saída do Plano: `allow` segue Supervisionado, `allowSession` segue aceitando
/// edições, `deny` continua planejando. Pergunta: o texto vira a resposta da primeira pergunta.
pub fn answer_of(pending: &Pending, choice: &str) -> (Value, Option<&'static str>) {
    if pending.tool == "AskUserQuestion" {
        let first = pending.input.pointer("/questions/0/question").and_then(Value::as_str).unwrap_or("");
        let mut input = pending.input.clone();
        if let Some(map) = input.as_object_mut() {
            map.insert("answers".into(), json!({ first: choice }));
        }
        return (json!({ "behavior": "allow", "updatedInput": input }), None);
    }
    if pending.tool == "ExitPlanMode" {
        return match choice {
            "allow" => (json!({ "behavior": "allow", "updatedInput": pending.input, "updatedPermissions": [set_mode("default")] }), Some("ask")),
            "allowSession" => (json!({ "behavior": "allow", "updatedInput": pending.input, "updatedPermissions": [set_mode("acceptEdits")] }), Some("edits")),
            "cancel" => (json!({ "behavior": "deny", "message": KEEP_PLANNING, "interrupt": true }), None),
            _ => (json!({ "behavior": "deny", "message": KEEP_PLANNING }), None),
        };
    }
    match choice {
        "allow" => (json!({ "behavior": "allow", "updatedInput": pending.input }), None),
        "allowSession" => {
            let mut access = None;
            let mut rules: Vec<Value> = pending.suggestions.iter().cloned().map(|mut s| {
                if let Some(map) = s.as_object_mut() {
                    map.insert("destination".into(), json!("session"));
                }
                if str_of(&s, "type") == Some("setMode") {
                    access = str_of(&s, "mode").and_then(access_of_mode);
                }
                s
            }).collect();
            if rules.is_empty() {
                rules.push(json!({ "type": "addRules", "rules": [{ "toolName": pending.tool }], "behavior": "allow", "destination": "session" }));
            }
            (json!({ "behavior": "allow", "updatedInput": pending.input, "updatedPermissions": rules }), access)
        }
        "cancel" => (json!({ "behavior": "deny", "message": DENIED, "interrupt": true }), None),
        _ => (json!({ "behavior": "deny", "message": DENIED }), None),
    }
}

/// O fim de um turno na timeline.
pub fn turn_end(turn_id: &str, result: &TurnResult, at: Option<i64>) -> Item {
    let mut it = Item::new(ItemKind::TurnEnd, format!("end:{turn_id}"), at);
    it.interrupted = Some(result.interrupted);
    it.duration_ms = result.duration_ms;
    it.text = result.error.clone();
    it
}

/// O status do turno em `chat_run` (o mesmo vocabulário do Codex).
pub fn run_status(result: &TurnResult) -> &'static str {
    if result.interrupted {
        "interrupted"
    } else if result.error.is_some() {
        "failed"
    } else {
        "completed"
    }
}
