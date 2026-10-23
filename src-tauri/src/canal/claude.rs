//! Uma linha do transcript do Claude Code (`~/.claude/projects/<cwd codificado>/<sessão>.jsonl`)
//! virando eventos normalizados. Formato conferido no Claude Code 2.1.300–2.1.308 desta máquina
//! (ver `docs/ade-ags/CANAL_ESTRUTURADO.md`). Pura: nada aqui lê disco.

use serde_json::Value;

use super::event::{clip, first_line, Decision, EndReason, Event, Tokens};

/// O que o Claude Code escreve como mensagem do usuário quando a pessoa aperta Esc.
const INTERRUPTED: &str = "[Request interrupted by user";

/// Marcas de linhas de "usuário" que não são um prompt: saída de comando local (`/compact`,
/// `/model`), avisos que o próprio Claude Code injeta. Não abrem turno.
fn is_markup(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<command-name>")
        || t.starts_with("<command-message>")
        || t.starts_with("<local-command-stdout>")
        || t.starts_with("<local-command-stderr>")
        || t.starts_with("<local-command-caveat>")
        || t.starts_with("<bash-stdout>")
        || t.starts_with("<bash-stderr>")
}

/// O resumo de uma chamada de ferramenta: o comando do Bash, o arquivo do Edit/Write, a
/// primeira pergunta do AskUserQuestion. Nunca o input inteiro.
fn tool_summary(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let text = match name {
        "Bash" | "PowerShell" => field("command"),
        "Edit" | "Write" | "Read" | "MultiEdit" | "NotebookEdit" => field("file_path").or_else(|| field("notebook_path")),
        "AskUserQuestion" => input.pointer("/questions/0/question").and_then(Value::as_str),
        "Agent" | "Task" => field("description"),
        "WebFetch" => field("url"),
        "Grep" | "Glob" => field("pattern"),
        _ => None,
    };
    first_line(text.unwrap_or(""), 160)
}

/// As opções da primeira pergunta de um AskUserQuestion (`questions[0].options[].label`).
fn question_of(id: &str, input: &Value) -> Option<Event> {
    let first = input.pointer("/questions/0")?;
    let text = first.get("question").and_then(Value::as_str)?.to_string();
    let options = first
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| o.get("label").and_then(Value::as_str).or_else(|| o.as_str()))
                .map(|l| clip(l, 120))
                .collect()
        })
        .unwrap_or_default();
    Some(Event::Question { id: id.to_string(), text: clip(&text, 600), options })
}

/// A decisão de permissão que o Claude Code grava junto do resultado da ferramenta.
fn decision_of(line: &Value) -> Option<Decision> {
    if let Some(kind) = line.get("toolDenialKind").and_then(Value::as_str) {
        return Some(Decision { accepted: false, by_user: kind == "user-rejected" });
    }
    let d = line.get("permissionDecision")?;
    let accepted = d.get("decision").and_then(Value::as_str) == Some("accept");
    let by_user = d.get("source").and_then(Value::as_str).is_some_and(|s| s.starts_with("user"));
    Some(Decision { accepted, by_user })
}

fn usage_of(message: &Value) -> Option<Tokens> {
    let u = message.get("usage")?;
    let n = |key: &str| u.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(Tokens {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cached: n("cache_read_input_tokens"),
        cache_write: n("cache_creation_input_tokens"),
    })
}

/// Os eventos de uma linha já decodificada.
pub fn events(line: &Value) -> Vec<Event> {
    // Linhas de subagente (`isSidechain`) são de outra conversa, mesmo no mesmo arquivo.
    if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return vec![];
    }
    match line.get("type").and_then(Value::as_str) {
        Some("user") => user_events(line),
        Some("assistant") => assistant_events(line),
        Some("system") => match line.get("subtype").and_then(Value::as_str) {
            // O fim do turno com a duração: o sinal mais firme de "terminou".
            Some("turn_duration") => vec![Event::TurnEnded { reason: EndReason::Completed, text: None }],
            _ => vec![],
        },
        _ => vec![],
    }
}

fn user_events(line: &Value) -> Vec<Event> {
    // Conteúdo injetado pelo próprio Claude Code (lembretes, resumo da compactação).
    if line.get("isMeta").and_then(Value::as_bool) == Some(true)
        || line.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return vec![];
    }
    let Some(content) = line.pointer("/message/content") else { return vec![] };
    let mut out = Vec::new();
    let mut prompt = false;
    let mut interrupted = false;
    match content {
        Value::String(text) => {
            if text.starts_with(INTERRUPTED) {
                interrupted = true;
            } else if !is_markup(text) && !text.trim().is_empty() {
                prompt = true;
            }
        }
        Value::Array(blocks) => {
            let decision = decision_of(line);
            let results = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")).count();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_result") => {
                        if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                            // A decisão vale para a linha; com vários resultados nela, não se sabe de qual é.
                            out.push(Event::ToolFinished { id: id.to_string(), decision: decision.filter(|_| results == 1) });
                        }
                    }
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if text.starts_with(INTERRUPTED) {
                            interrupted = true;
                        } else if results == 0 && !is_markup(text) && !text.trim().is_empty() {
                            prompt = true;
                        }
                    }
                    Some("image") if results == 0 => prompt = true,
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if interrupted {
        out.push(Event::TurnEnded { reason: EndReason::Interrupted, text: None });
    } else if prompt {
        out.insert(0, Event::TurnStarted);
    }
    out
}

fn assistant_events(line: &Value) -> Vec<Event> {
    let Some(message) = line.get("message") else { return vec![] };
    let mut out = Vec::new();
    let mut last_text: Option<String> = None;
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                        let text = clip(text, 2000);
                        out.push(Event::AssistantText(text.clone()));
                        last_text = Some(text);
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    out.push(Event::ToolStarted { id: id.clone(), name: name.clone(), summary: tool_summary(&name, &input) });
                    if name == "AskUserQuestion" {
                        out.extend(question_of(&id, &input));
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(last) = usage_of(message) {
        let key = message.get("id").and_then(Value::as_str).map(str::to_string);
        out.push(Event::Usage { key, last, total: None });
    }
    if message.get("stop_reason").and_then(Value::as_str) == Some("end_turn") {
        out.push(Event::TurnEnded { reason: EndReason::Completed, text: last_text });
    }
    out
}
