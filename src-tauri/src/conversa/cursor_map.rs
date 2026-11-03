//! O que vem do Cursor (`cursor-agent -p --output-format stream-json --stream-partial-output`) virando o que a
//! timeline do chat já desenha (`canal::timeline::Item`), e o que o chat escolhe virando flags. Puro.
//!
//! Fonte: a documentação oficial do Cursor CLI (`cursor.com/docs/cli/reference/output-format` e `…/parameters`).
//! **Nenhum turno real foi feito** (gastaria a cota da pessoa): os testes usam as linhas de exemplo da doc. O que a doc
//! não mostra (os nomes das ferramentas além de `readToolCall`/`writeToolCall`, o evento `thinking`, o desfecho de uma
//! ação recusada) é lido de forma tolerante: o que não conheço vira ferramenta genérica com o próprio nome, nunca some.
//! - uma linha JSON por evento, com `type`: `system` (`subtype: init`, com `session_id`, `model`, `permissionMode`),
//!   `user` (o eco da mensagem, ignorado), `assistant` (a fala), `tool_call` (`subtype: started|completed`, `call_id`,
//!   e `tool_call.<nome>ToolCall.{args,result}`) e `result` (`subtype`, `is_error`, `duration_ms`, `result`);
//! - com `--stream-partial-output` os pedaços da fala são os `assistant` COM `timestamp_ms` e SEM `model_call_id`; os
//!   outros (o texto repetido ao fechar o bloco e o final sem carimbo) são duplicatas e são ignorados;
//! - um processo por turno, continuando com `--resume <session_id>`; não há uso de tokens nem cota no fluxo;
//! - sem `--force`, o que mudaria arquivos ou rodaria comandos não é aplicado (vira uma ação recusada).

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::canal::event::clip;
use crate::canal::timeline::{Item, ItemKind, ToolStatus};

use super::agy_map::tool_item;
pub use super::agy_map::Out;
use super::claude_map::TurnResult;
use super::codex_map::DeltaKind;
use super::store::ThreadRow;

const TEXT_MAX: usize = 20_000;
const OUTPUT_MAX: usize = 4_000;

const DENIED: &str = "Negado: o modo de execução do chat não aprova esta ação sem alguém para aprovar. Troque o acesso para liberar.";

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// As flags de modo do `cursor-agent` de cada acesso:
/// - Supervisionado (`ask`): nenhuma; no `-p` o que pede aprovação não é aplicado (vira ação recusada);
/// - Plano (`plan`): `--mode plan`;
/// - Acesso total (`full`): `--force`.
///
/// Aceitar edições e Auto não têm flag documentada: o motor não os aceita (`Engine::accepts`).
pub fn access_flags(access: &str) -> Vec<&'static str> {
    match access {
        "plan" => vec!["--mode", "plan"],
        "full" => vec!["--force"],
        _ => Vec::new(),
    }
}

/// Os argumentos do `cursor-agent` de um turno. `resume` é o `session_id` do turno anterior; sem ele abre uma conversa
/// nova. O modelo é o id da variante (o esforço já faz parte dele: `…-high`), por isso `row.effort` não vira flag.
/// A mensagem é o último argumento; uma que começa por «-» ganha um espaço na frente para não virar flag do CLI.
pub fn launch_args(row: &ThreadRow, prompt: &str, resume: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"].map(String::from).to_vec();
    args.extend(["--workspace".into(), crate::util::external_path(std::path::Path::new(&row.cwd)).to_string_lossy().into_owned()]);
    args.extend(access_flags(&row.access).into_iter().map(String::from));
    if let Some(model) = row.model.as_deref().filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(id) = resume.filter(|c| !c.is_empty()) {
        args.extend(["--resume".into(), id.into()]);
    }
    args.push(if prompt.starts_with('-') { format!(" {prompt}") } else { prompt.to_string() });
    args
}

struct Open {
    id: String,
    text: String,
}

/// Lê a saída do `cursor-agent` linha a linha, de UM turno (cada turno é um processo).
pub struct Mapper {
    turn: String,
    seq: usize,
    said: Option<Open>,
    thought: Option<Open>,
    tools: HashMap<String, Item>,
    session: bool,
    spoke: bool,
}

impl Mapper {
    pub fn new(turn: &str) -> Mapper {
        Mapper { turn: turn.to_string(), seq: 0, said: None, thought: None, tools: HashMap::new(), session: false, spoke: false }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("cursor:{}:{prefix}{}", self.turn, self.seq)
    }

    /// O que uma linha da saída vira. `now` é o carimbo dos itens.
    pub fn feed(&mut self, line: &Value, now: i64) -> Vec<Out> {
        let at = Some(now);
        let mut out = Vec::new();
        if let Some(id) = str_of(line, "session_id").filter(|id| !id.is_empty())
            && !self.session
        {
            self.session = true;
            out.push(Out::Session(id.to_string()));
        }
        match str_of(line, "type").unwrap_or("") {
            "assistant" => self.assistant(line, &mut out),
            "thinking" => self.thinking(line, at, &mut out),
            "tool_call" => self.tool_call(line, at, &mut out),
            "result" => self.result(line, at, &mut out),
            _ => {}
        }
        out
    }

    /// Fecha o que ficou aberto: o processo acabou sem `result` (parado, ou caiu). Não fecha duas vezes.
    pub fn finish(&mut self, now: Option<i64>) -> Vec<Out> {
        let mut out = Vec::new();
        self.flush_thought(now, &mut out);
        self.flush_said(now, &mut out);
        out
    }

    fn assistant(&mut self, line: &Value, out: &mut Vec<Out>) {
        // Pedaço da fala: com carimbo e sem `model_call_id`. O resto repete o que já chegou.
        if line.get("timestamp_ms").is_none() || line.get("model_call_id").is_some() {
            return;
        }
        let text: String = line
            .pointer("/message/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|c| str_of(c, "type").is_none_or(|t| t == "text"))
            .filter_map(|c| str_of(c, "text"))
            .collect();
        if text.is_empty() {
            return;
        }
        if self.said.is_none() {
            let id = self.next_id("t");
            self.said = Some(Open { id, text: String::new() });
        }
        if let Some(open) = self.said.as_mut() {
            open.text.push_str(&text);
            out.push(Out::Delta { item_id: open.id.clone(), delta: text, kind: DeltaKind::Assistant });
        }
    }

    fn thinking(&mut self, line: &Value, at: Option<i64>, out: &mut Vec<Out>) {
        match str_of(line, "subtype").unwrap_or("") {
            "completed" => self.flush_thought(at, out),
            _ => {
                let text = str_of(line, "text").unwrap_or("");
                if text.is_empty() {
                    return;
                }
                if self.thought.is_none() {
                    let id = self.next_id("r");
                    self.thought = Some(Open { id, text: String::new() });
                }
                if let Some(open) = self.thought.as_mut() {
                    open.text.push_str(text);
                    out.push(Out::Delta { item_id: open.id.clone(), delta: text.to_string(), kind: DeltaKind::Reasoning });
                }
            }
        }
    }

    fn flush_said(&mut self, at: Option<i64>, out: &mut Vec<Out>) {
        if let Some(open) = self.said.take()
            && !open.text.trim().is_empty()
        {
            self.spoke = true;
            out.push(Out::Item(Box::new(Item { text: Some(clip(&open.text, TEXT_MAX)), ..Item::new(ItemKind::Assistant, open.id, at) })));
        }
    }

    fn flush_thought(&mut self, at: Option<i64>, out: &mut Vec<Out>) {
        if let Some(open) = self.thought.take()
            && let Some(item) = Item::reasoning(open.id, at, &open.text)
        {
            out.push(Out::Item(Box::new(item)));
        }
    }

    fn tool_call(&mut self, line: &Value, at: Option<i64>, out: &mut Vec<Out>) {
        // A ferramenta entra depois do que o agente já disse e pensou: a ordem do fio é a do que aconteceu.
        self.flush_thought(at, out);
        self.flush_said(at, out);
        let Some((key, body)) = line.get("tool_call").and_then(Value::as_object).and_then(tool_entry) else { return };
        let call = str_of(line, "call_id").map(str::to_string).unwrap_or_else(|| format!("n{}", self.tools.len()));
        let args = body.get("args").cloned().unwrap_or(Value::Null);
        let mut item = tool_item(&format!("cursor:{}:c{call}", self.turn), &agy_name(key), &with_aliases(&args), at);
        item.status = Some(ToolStatus::Running);
        if str_of(line, "subtype") == Some("completed") {
            let (status, output) = outcome(body.get("result"));
            item.status = Some(status);
            item.output = output;
        }
        // O mesmo passo repetido sem mudança não regrava o item.
        if self.tools.get(&call).is_some_and(|before| before == &item) {
            return;
        }
        self.tools.insert(call, item.clone());
        out.push(Out::Item(Box::new(item)));
    }

    fn result(&mut self, line: &Value, at: Option<i64>, out: &mut Vec<Out>) {
        self.flush_thought(at, out);
        self.flush_said(at, out);
        let text = str_of(line, "result").filter(|r| !r.trim().is_empty());
        let failed = line.get("is_error").and_then(Value::as_bool).unwrap_or(false) || str_of(line, "subtype").is_some_and(|s| s != "success");
        // Sem fala em pedaços, a resposta final do `result` é a fala.
        if !failed && !self.spoke && let Some(response) = text {
            out.push(Out::Item(Box::new(Item { text: Some(clip(response, TEXT_MAX)), ..Item::new(ItemKind::Assistant, self.next_id("final"), at) })));
        }
        let error = failed.then(|| clip(text.unwrap_or("O Cursor terminou com erro"), OUTPUT_MAX));
        let duration_ms = line.get("duration_ms").and_then(Value::as_i64);
        out.push(Out::Done(TurnResult { interrupted: false, error, duration_ms }));
    }
}

/// A ferramenta de um `tool_call`: a entrada `<nome>ToolCall`. O `cursor-agent` também põe campos soltos ao lado dela
/// (como `completedAtMs`, um número); pegar a primeira chave do objeto dava a ferramenta «completedatms», sem argumento
/// nem resultado. Sem nenhuma `…ToolCall`, vale a primeira entrada que é um objeto (nome novo ainda desconhecido).
fn tool_entry(object: &Map<String, Value>) -> Option<(&String, &Value)> {
    object.iter().find(|(k, v)| k.ends_with("ToolCall") && v.is_object()).or_else(|| object.iter().find(|(_, v)| v.is_object()))
}

/// O nome que o mapa de ferramentas do `agy_map` entende, a partir do `<nome>ToolCall` do Cursor.
fn agy_name(key: &str) -> String {
    let base = key.strip_suffix("ToolCall").unwrap_or(key).to_ascii_lowercase();
    match base.as_str() {
        "read" => "view_file",
        "write" => "write_to_file",
        "edit" | "strreplace" | "str_replace" | "applypatch" | "searchreplace" => "replace_file_content",
        "shell" | "bash" | "terminal" => "run_command",
        "grep" | "codebasesearch" | "semsearch" | "search" => "grep_search",
        "glob" | "ls" | "list" | "listdir" => "list_dir",
        "web" | "websearch" | "webfetch" | "fetch" => "read_url_content",
        "task" | "subagent" => "invoke_subagent",
        other => return other.to_string(),
    }
    .to_string()
}

/// Os argumentos com o conteúdo do arquivo também sob o nome que o mapa de ferramentas procura (`fileText` etc.).
fn with_aliases(args: &Value) -> Value {
    let Some(map) = args.as_object() else { return args.clone() };
    let mut out: Map<String, Value> = map.clone();
    if !out.contains_key("content")
        && let Some(text) = ["fileText", "contents", "streamContent"].iter().find_map(|k| map.get(*k).filter(|v| v.is_string()))
    {
        out.insert("content".into(), text.clone());
    }
    json!(out)
}

/// O desfecho de uma ferramenta pelo `result` do `completed`: sucesso, erro ou recusada, e o texto que ela devolveu.
fn outcome(result: Option<&Value>) -> (ToolStatus, Option<String>) {
    let Some(result) = result.filter(|r| !r.is_null()) else { return (ToolStatus::Done, None) };
    if ["rejected", "denied", "userRejected", "permissionDenied"].iter().any(|k| result.get(*k).is_some()) {
        return (ToolStatus::Denied, Some(DENIED.into()));
    }
    if let Some(error) = result.get("error").or_else(|| result.get("failure")) {
        let message = error.as_str().map(str::to_string).or_else(|| str_of(error, "message").map(str::to_string)).unwrap_or_else(|| error.to_string());
        return (ToolStatus::Error, Some(clip(&message, OUTPUT_MAX)));
    }
    let ok = result.get("success").unwrap_or(result);
    let text = |keys: &[&str]| keys.iter().find_map(|k| str_of(ok, k).filter(|s| !s.trim().is_empty())).map(|s| clip(s, OUTPUT_MAX));
    let failed_exit = ok.get("exitCode").and_then(Value::as_i64).is_some_and(|c| c != 0);
    if failed_exit {
        return (ToolStatus::Error, text(&["stderr", "stdout", "output"]));
    }
    (ToolStatus::Done, text(&["content", "stdout", "output", "text", "result"]))
}

/// O erro de um turno que acabou sem `result`: a última linha com texto do stderr. Pura.
pub fn error_from_stderr(tail: &[String]) -> String {
    let text = tail.iter().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string());
    clip(&text.unwrap_or_else(|| "O Cursor terminou sem responder".into()), 600)
}
