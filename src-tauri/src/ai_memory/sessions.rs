use std::io;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::types::Session;

const MAX_MESSAGE: usize = 2 * 1024 * 1024;

pub(super) fn validate_scope(workspace: &str, project: &str) -> Result<(), String> {
    for value in [workspace, project] {
        if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
            return Err(
                "Escolha workspace e projeto explícitos do ai-memory (até 512 bytes cada).".into(),
            );
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct Briefing {
    recent_sessions: Vec<Session>,
    scope: Scope,
}
#[derive(Deserialize)]
struct Scope {
    workspace: String,
    project: String,
}

fn invalid() -> io::Error {
    io::Error::other("Resposta MCP incompatível com a leitura de sessões.")
}

async fn send(input: &mut (impl AsyncWrite + Unpin), message: Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(&message).map_err(|_| invalid())?;
    bytes.push(b'\n');
    input.write_all(&bytes).await?;
    input.flush().await
}

async fn response(reader: &mut (impl AsyncBufRead + Unpin), id: u64) -> io::Result<Value> {
    // Notificações do servidor não são comandos e nunca são executadas.
    for _ in 0..16 {
        let mut line = Vec::new();
        loop {
            let buffer = reader.fill_buf().await?;
            if buffer.is_empty() {
                return Err(invalid());
            }
            let newline = buffer.iter().position(|b| *b == b'\n');
            let count = newline.map_or(buffer.len(), |i| i + 1);
            if line.len() + count > MAX_MESSAGE {
                return Err(invalid());
            }
            line.extend_from_slice(&buffer[..count]);
            reader.consume(count);
            if newline.is_some() {
                break;
            }
        }
        let value: Value = serde_json::from_slice(&line).map_err(|_| invalid())?;
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(invalid());
        }
        if value.get("id").is_none() && value.get("method").and_then(Value::as_str).is_some() {
            continue;
        }
        if value.get("id").and_then(Value::as_u64) != Some(id) || value.get("error").is_some() {
            return Err(invalid());
        }
        return value
            .get("result")
            .filter(|r| r.is_object())
            .cloned()
            .ok_or_else(invalid);
    }
    Err(invalid())
}

/// Protocolo fechado: não recebe nome de tool nem argumentos RPC do frontend.
pub(super) async fn briefing(
    mut input: impl AsyncWrite + Unpin,
    output: impl tokio::io::AsyncRead + Unpin,
    workspace: String,
    project: String,
) -> io::Result<Vec<Session>> {
    let mut reader = BufReader::new(output);
    send(&mut input, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ade-ai-memory-reader","version":"1"}
    }})).await?;
    response(&mut reader, 1).await?;
    send(
        &mut input,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await?;
    send(&mut input, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"memory_briefing","arguments":{"workspace":workspace,"project":project,"recent_pages_limit":0}
    }})).await?;
    let result = response(&mut reader, 2).await?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(invalid());
    }
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut parsed = None;
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let briefing: Briefing = serde_json::from_str(text).map_err(|_| invalid())?;
        if parsed.is_some()
            || briefing.scope.workspace != workspace
            || briefing.scope.project != project
        {
            return Err(invalid());
        }
        parsed = Some(briefing.recent_sessions);
    }
    parsed.ok_or_else(invalid)
}
