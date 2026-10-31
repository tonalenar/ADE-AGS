//! Intermediário fechado para clientes sem identidade de sessão (contrato v3.3.0).
use serde_json::{Value, json};
use std::{io, path::Path, time::Duration};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};

// Fonte: ai-memory-mcp/src/server.rs, Args e handlers da tag v3.3.0.
const TOOLS: &[&str] = &[
    "memory_query",
    "memory_recent",
    "memory_status",
    "memory_read_page",
    "memory_write_page",
    "memory_patch_page",
];
pub(super) fn reserved_project(project: &str) -> bool {
    let name = project.trim().to_ascii_lowercase();
    name == "_global" || name == "_profile" || name.starts_with("_profile.")
}
const LIMIT: u64 = 2 * 1024 * 1024;

fn stamp(message: &mut Value, workspace: &str, project: &str) -> Result<(), &'static str> {
    match message["method"].as_str() {
        Some("initialize" | "notifications/initialized" | "ping" | "tools/list") => return Ok(()),
        Some("tools/call") => {}
        _ => return Err("Método indisponível neste intermediário."),
    }
    if !TOOLS.contains(&message["params"]["name"].as_str().unwrap_or("")) {
        return Err("Tool indisponível neste intermediário com escopo fixo.");
    }
    let params = message["params"]
        .as_object_mut()
        .ok_or("Parâmetros inválidos.")?;
    let args = params.entry("arguments").or_insert_with(|| json!({}));
    let args = args.as_object_mut().ok_or("Argumentos devem ser objeto.")?;
    for (key, fixed) in [("workspace", workspace), ("project", project)] {
        if args
            .get(key)
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(fixed))
        {
            return Err("Escopo divergente da pasta da aba.");
        }
    }
    if args
        .get("global")
        .is_some_and(|v| !v.is_null() && v != false)
        || args
            .get("scope")
            .is_some_and(|v| !v.is_null() && v != "project")
        || args
            .get("scopes")
            .is_some_and(|v| !v.is_null() && v != &json!([]))
    {
        return Err("Escopo global, perfil ou múltiplos projetos não permitido.");
    }
    args.remove("scope");
    args.insert("workspace".into(), json!(workspace));
    args.insert("project".into(), json!(project));
    Ok(())
}
async fn line(
    reader: &mut (impl AsyncBufRead + Unpin),
    bytes: &mut Vec<u8>,
) -> io::Result<Option<Value>> {
    let n = reader
        .take(LIMIT + 1 - bytes.len() as u64)
        .read_until(b'\n', bytes)
        .await?;
    if n == 0 {
        return Ok(None);
    }
    if bytes.len() as u64 > LIMIT || bytes.last() != Some(&b'\n') {
        return Err(io::Error::other("Mensagem MCP excede o limite."));
    }
    let value = serde_json::from_slice(bytes)
        .map(Some)
        .map_err(io::Error::other);
    bytes.clear();
    value
}
async fn send(writer: &mut (impl AsyncWrite + Unpin), value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}
async fn relay(
    client: impl tokio::io::AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
    mut input: impl AsyncWrite + Unpin,
    server: impl tokio::io::AsyncRead + Unpin,
    workspace: &str,
    project: &str,
) -> io::Result<()> {
    let (mut client, mut server) = (BufReader::new(client), BufReader::new(server));
    let (mut client_bytes, mut server_bytes) = (Vec::new(), Vec::new());
    loop {
        tokio::select! {
            request = line(&mut client, &mut client_bytes) => {
                let Some(mut request) = request? else { return Ok(()); };
                if request["jsonrpc"] != "2.0" { return Err(io::Error::other("JSON-RPC inválido.")); }
                match stamp(&mut request, workspace, project) {
                    Ok(()) => send(&mut input, &request).await?,
                    Err(reason) => if let Some(id) = request.get("id") {
                        send(&mut output, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":reason}})).await?;
                    }
                }
            },
            response = line(&mut server, &mut server_bytes) => {
                let Some(mut response) = response? else { return Ok(()); };
                // Nunca expõe tools fora da lista, mesmo se o upstream ganhar novas tools.
                if let Some(tools) = response.pointer_mut("/result/tools").and_then(Value::as_array_mut) {
                    tools.retain(|t| TOOLS.contains(&t["name"].as_str().unwrap_or("")));
                }
                // Servidor não pode solicitar execução no cliente por este canal.
                if response.get("method").is_none() { send(&mut output, &response).await?; }
            }
        }
    }
}
async fn serve_with(
    program: &Path,
    cwd: &Path,
    workspace: &str,
    project: &str,
    client: impl tokio::io::AsyncRead + Unpin,
    output: impl AsyncWrite + Unpin,
) -> io::Result<()> {
    super::sessions::validate_scope(workspace, project).map_err(io::Error::other)?;
    if reserved_project(project) {
        return Err(io::Error::other("Projeto reservado não permitido."));
    }
    let mut command = crate::util::spawn::hidden_command(crate::util::external_path(program));
    command
        .args(["mcp-bridge", "--no-session-id"])
        .current_dir(cwd)
        .env("AI_MEMORY_RUN_AUTOWIRE", "false")
        .env("AI_MEMORY_HOST_CWD", cwd)
        .env_remove("AI_MEMORY_SCOPE_CWD")
        .env("AI_MEMORY_EMBEDDING_PROVIDER", "none");
    crate::util::spawn::with_stdio(
        command,
        Duration::from_secs(24 * 60 * 60),
        |input, server| relay(client, output, input, server, workspace, project),
    )
    .await
}
/// Entrada local do ags: nenhum token ou arquivo de configuração é lido pelo ADE.
pub async fn serve(cwd: &Path, workspace: &str, project: &str) -> io::Result<()> {
    let program = super::tabs::supported_binary(cwd)
        .ok_or_else(|| io::Error::other("ai-memory compatível indisponível."))?;
    serve_with(
        &program,
        cwd,
        workspace,
        project,
        tokio::io::stdin(),
        tokio::io::stdout(),
    )
    .await
}

#[cfg(test)]
mod test;
