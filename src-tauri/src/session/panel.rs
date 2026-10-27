//! O painel lateral da aba ativa: quanto da janela de contexto a conversa já ocupa e quais
//! servidores MCP o agente tem configurados naquela pasta.
//!
//! Tudo é lido do disco que a própria TUI mantém (o transcript, `.claude.json`, `.mcp.json`,
//! `config.toml` do Codex). Do transcript só se lê o FIM (ver `canal::tail`): pode ter centenas
//! de MB. Dos MCP sai só o nome, o escopo, o transporte e o binário ou o host — nunca env,
//! headers, args nem a URL inteira, que é onde moram os tokens.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::canal::event::parse_ts_ms;
use crate::canal::tail::Tailer;
use crate::database::DbConnection;

/// Janela de contexto padrão do Claude Code quando o modelo não diz outra coisa.
const CLAUDE_WINDOW: u64 = 200_000;
/// A janela estendida (`[1m]`), deduzida também quando o uso já passou da padrão.
const CLAUDE_WINDOW_1M: u64 = 1_000_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub window_tokens: u64,
    pub percent: f64,
    pub model: Option<String>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub name: String,
    /// `user` | `project` | `local` | `ade`.
    pub scope: String,
    /// `stdio` | `http` | `sse`.
    pub transport: String,
    /// O nome do binário (sem a pasta) ou o host da URL. Nada além disso.
    pub detail: Option<String>,
}

fn usage(used: u64, window: u64, model: Option<String>, at: Option<i64>) -> ContextUsage {
    let percent = if window == 0 { 0.0 } else { used as f64 * 100.0 / window as f64 };
    ContextUsage { used_tokens: used, window_tokens: window, percent, model, updated_at_ms: at }
}

fn has(line: &[u8], needle: &[u8]) -> bool {
    line.windows(needle.len()).any(|w| w == needle)
}

fn timestamp(v: &Value) -> Option<i64> {
    v.get("timestamp").and_then(Value::as_str).and_then(parse_ts_ms)
}

// ── Contexto ──────────────────────────────────────────────────────────

fn claude_window(model: Option<&str>, used: u64) -> u64 {
    if model.is_some_and(|m| m.to_ascii_lowercase().contains("[1m]")) || used > CLAUDE_WINDOW {
        CLAUDE_WINDOW_1M
    } else {
        CLAUDE_WINDOW
    }
}

/// Claude Code: a última resposta do agente principal (não de subagente) com `usage`. O contexto
/// é tudo o que entrou nela: entrada nova + o que veio do cache + o que foi gravado no cache.
pub(crate) fn claude_context(lines: &[Vec<u8>]) -> Option<ContextUsage> {
    for line in lines.iter().rev() {
        if !has(line, b"\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("assistant")
            || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(message) = v.get("message") else { continue };
        let model = message.get("model").and_then(Value::as_str);
        // Respostas `<synthetic>` (erro de API, interrupção) vêm com usage zerado: não dizem nada.
        if model == Some("<synthetic>") {
            continue;
        }
        let Some(u) = message.get("usage") else { continue };
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let used = n("input_tokens")
            .saturating_add(n("cache_read_input_tokens"))
            .saturating_add(n("cache_creation_input_tokens"));
        if used == 0 {
            continue;
        }
        let window = claude_window(model, used);
        return Some(usage(used, window, model.map(String::from), timestamp(&v)));
    }
    None
}

/// Codex: o último `token_count` com `info`. `last_token_usage.input_tokens` já inclui o cache e
/// é o tamanho da última chamada, ou seja, o contexto atual; a janela vem no próprio evento.
pub(crate) fn codex_context(lines: &[Vec<u8>]) -> Option<ContextUsage> {
    let mut found = None;
    for (i, line) in lines.iter().enumerate().rev() {
        if !has(line, b"\"token_count\"") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        let Some(payload) = v.get("payload").filter(|_| v.get("type").and_then(Value::as_str) == Some("event_msg")) else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info").filter(|i| i.is_object()) else { continue };
        let input = |k: &str| info.get(k).and_then(|t| t.get("input_tokens")).and_then(Value::as_u64);
        let Some(used) = input("last_token_usage").or_else(|| input("total_token_usage")) else { continue };
        let window = info.get("model_context_window").and_then(Value::as_u64).unwrap_or(0);
        if window == 0 {
            continue;
        }
        found = Some((i, used, window, timestamp(&v)));
        break;
    }
    let (_, used, window, at) = found?;
    // O modelo: o `turn_context` mais recente da janela lida (pode ter ficado antes dela).
    let model = lines.iter().rev().filter(|l| has(l, b"\"turn_context\"")).find_map(|l| {
        let v = serde_json::from_slice::<Value>(l).ok()?;
        if v.get("type").and_then(Value::as_str) != Some("turn_context") {
            return None;
        }
        v.get("payload")?.get("model")?.as_str().map(String::from)
    });
    Some(usage(used, window, model, at))
}

/// O contexto da sessão `session_id` desta aba, lendo só o fim do transcript.
pub(crate) fn context_usage(agent_id: &str, cwd: &str, session_id: &str, profile: Option<&Path>) -> Option<ContextUsage> {
    if !crate::canal::supported(agent_id) {
        return None;
    }
    let path = crate::canal::transcript_path(agent_id, cwd, session_id, profile)?;
    let lines = Tailer::new(path).poll().ok()?.lines;
    match agent_id {
        "claude-code" => claude_context(&lines),
        _ => codex_context(&lines),
    }
}

#[tauri::command]
pub async fn tab_context_usage(
    agent_id: String,
    cwd: String,
    session_id: String,
    // A conta da aba (id, não pasta: a pasta é resolvida aqui, como em `get_session_title`).
    account_id: Option<String>,
    db: tauri::State<'_, DbConnection>,
) -> Result<Option<ContextUsage>, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id)).map(PathBuf::from);
        context_usage(&agent_id, &cwd, &session_id, profile.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

// ── Conectores (MCP) ──────────────────────────────────────────────────

/// Só o nome do arquivo do comando: a pasta pode ter o usuário e não ajuda a reconhecer.
fn command_base(command: &str) -> Option<String> {
    let first = command.trim();
    let base = first.rsplit(['/', '\\']).next().unwrap_or(first).trim();
    (!base.is_empty()).then(|| base.to_string())
}

/// Só o host (com a porta) da URL: sem usuário/senha, caminho nem query, que podem ter token.
fn url_host(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://").map(|(_, r)| r).unwrap_or(url.trim());
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_string())
}

/// Um servidor de `mcpServers` (formato do Claude Code).
fn claude_connector(name: &str, scope: &str, spec: &Value) -> Connector {
    let url = spec.get("url").and_then(Value::as_str);
    let transport = match spec.get("type").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() {
        Some("sse") => "sse",
        Some("http" | "streamable-http") => "http",
        Some("stdio") => "stdio",
        _ if url.is_some() => "http",
        _ => "stdio",
    };
    let detail = match transport {
        "stdio" => spec.get("command").and_then(Value::as_str).and_then(command_base),
        _ => url.and_then(url_host),
    };
    Connector { name: name.to_string(), scope: scope.to_string(), transport: transport.to_string(), detail }
}

/// Mesma pasta? Barras de qualquer lado, sem a do fim, e sem caixa no Windows.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/').to_string();
        if cfg!(windows) { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

fn push_servers(out: &mut Vec<Connector>, servers: Option<&Value>, scope: &str) {
    let Some(map) = servers.and_then(Value::as_object) else { return };
    for (name, spec) in map {
        // O efetivo: um nome já visto num escopo mais forte tapa este (local > project > user).
        if out.iter().any(|c| &c.name == name) {
            continue;
        }
        out.push(claude_connector(name, scope, spec));
    }
}

/// Os MCP do Claude Code: o do ADE (`--mcp-config` da aba), o local (`projects[cwd]` em
/// `.claude.json`), o do projeto (`<cwd>/.mcp.json`) e o do usuário (`.claude.json`).
pub(crate) fn claude_connectors(
    claude_json: Option<&Value>,
    mcp_json: Option<&Value>,
    ade_config: Option<&Value>,
    cwd: &str,
) -> Vec<Connector> {
    let mut out = Vec::new();
    push_servers(&mut out, ade_config.and_then(|c| c.get("mcpServers")), "ade");
    let local = claude_json
        .and_then(|c| c.get("projects"))
        .and_then(Value::as_object)
        .and_then(|projects| projects.iter().find(|(dir, _)| same_dir(dir, cwd)))
        .and_then(|(_, p)| p.get("mcpServers"));
    push_servers(&mut out, local, "local");
    push_servers(&mut out, mcp_json.and_then(|c| c.get("mcpServers")), "project");
    push_servers(&mut out, claude_json.and_then(|c| c.get("mcpServers")), "user");
    out
}

/// Uma chave TOML pontilhada (`mcp_servers."meu server"`), respeitando as aspas.
fn toml_key_parts(key: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in key.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, '.') => parts.push(std::mem::take(&mut cur).trim().to_string()),
            (None, c) => cur.push(c),
        }
    }
    parts.push(cur.trim().to_string());
    parts
}

/// O valor de uma string TOML simples (`"..."` ou `'...'`). Basta para `command`/`url`.
fn toml_string(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let quote = raw.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let body = &raw[1..];
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == quote {
            return Some(out);
        }
        if c == '\\' && quote == '"' {
            match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                other => out.push(other),
            }
        } else {
            out.push(c);
        }
    }
    None
}

/// Os `[mcp_servers.<nome>]` do `config.toml` do Codex. Leitura mínima, sem crate de TOML: só as
/// tabelas e as chaves `command`, `url` e `enabled` — o resto (env, headers, args) nem se olha.
pub(crate) fn codex_connectors(config_toml: &str) -> Vec<Connector> {
    struct Entry {
        name: String,
        command: Option<String>,
        url: Option<String>,
        enabled: bool,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut current: Option<usize> = None;
    for raw in config_toml.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[') {
            let header = header.trim_start_matches('[');
            let header = header.split(']').next().unwrap_or("");
            let parts = toml_key_parts(header);
            current = None;
            if parts.len() == 2 && parts[0] == "mcp_servers" && !parts[1].is_empty() {
                let idx = entries.iter().position(|e| e.name == parts[1]).unwrap_or_else(|| {
                    entries.push(Entry { name: parts[1].clone(), command: None, url: None, enabled: true });
                    entries.len() - 1
                });
                current = Some(idx);
            }
            continue;
        }
        let Some(idx) = current else { continue };
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "command" => entries[idx].command = toml_string(value),
            "url" => entries[idx].url = toml_string(value),
            "enabled" => entries[idx].enabled = !value.trim().starts_with("false"),
            _ => {}
        }
    }
    entries
        .into_iter()
        .filter(|e| e.enabled)
        .map(|e| {
            let (transport, detail) = match (&e.url, &e.command) {
                (Some(url), _) => ("http", url_host(url)),
                (None, command) => ("stdio", command.as_deref().and_then(command_base)),
            };
            Connector { name: e.name, scope: "user".into(), transport: transport.into(), detail }
        })
        .collect()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// O `.claude.json` da conta: dentro de `CLAUDE_CONFIG_DIR` com conta alternativa, `~/.claude.json`
/// com a do sistema.
fn claude_json_path(profile: Option<&Path>) -> PathBuf {
    match profile {
        Some(dir) => dir.join(".claude.json"),
        None => dirs::home_dir().unwrap_or_default().join(".claude.json"),
    }
}

/// O `--mcp-config` que o ADE escreveu para esta aba (`~/.ags/mcp/tab-<id>.json`), se existe.
fn ade_tab_config(tab_id: &str) -> Option<Value> {
    let dir = crate::util::datadir::ags_home()?.join("mcp");
    read_json(&dir.join(format!("{}.json", crate::ipc::mcp::tab_config_name(tab_id))))
}

pub(crate) fn connectors(agent_id: &str, cwd: &str, profile: Option<&Path>, tab_id: Option<&str>) -> Vec<Connector> {
    match agent_id {
        "claude-code" => {
            let claude_json = read_json(&claude_json_path(profile));
            let mcp_json = read_json(&Path::new(cwd).join(".mcp.json"));
            let ade = tab_id.and_then(ade_tab_config);
            claude_connectors(claude_json.as_ref(), mcp_json.as_ref(), ade.as_ref(), cwd)
        }
        "codex" => {
            let root = crate::session::codex_root(profile);
            let config = root.parent().map(|home| home.join("config.toml"));
            config
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|text| codex_connectors(&text))
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

#[tauri::command]
pub async fn tab_connectors(
    agent_id: String,
    cwd: String,
    account_id: Option<String>,
    // A aba: para saber se o ADE enchufou o servidor `ags` nela (só Claude Code o recebe por arquivo).
    tab_id: Option<String>,
    db: tauri::State<'_, DbConnection>,
) -> Result<Vec<Connector>, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id)).map(PathBuf::from);
        connectors(&agent_id, &cwd, profile.as_deref(), tab_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    //! Linhas SINTÉTICAS no formato observado nesta máquina (Claude Code com `message.usage`,
    //! codex-cli com `event_msg/token_count` e `turn_context`), sem conteúdo real.
    use super::*;
    use serde_json::json;

    fn lines(values: &[Value]) -> Vec<Vec<u8>> {
        values.iter().map(|v| serde_json::to_vec(v).unwrap()).collect()
    }

    fn assistant(model: &str, input: u64, read: u64, write: u64, sidechain: bool) -> Value {
        json!({"type":"assistant","isSidechain":sidechain,"timestamp":"2026-10-27T16:30:20.451Z",
            "message":{"model":model,"usage":{"input_tokens":input,"cache_read_input_tokens":read,
            "cache_creation_input_tokens":write,"output_tokens":99}}})
    }

    #[test]
    fn claude_soma_entrada_e_cache_da_ultima_resposta_principal() {
        let ls = lines(&[
            assistant("claude-sonnet-4-5", 10, 1_000, 0, false),
            assistant("claude-sonnet-4-5", 2, 50_000, 1_000, false),
            json!({"type":"user","message":{"content":"oi"}}),
            assistant("claude-haiku-4-5", 5, 90_000, 0, true),
            assistant("<synthetic>", 0, 0, 0, false),
        ]);
        let u = claude_context(&ls).unwrap();
        assert_eq!(u.used_tokens, 51_002);
        assert_eq!(u.window_tokens, 200_000);
        assert_eq!(u.model.as_deref(), Some("claude-sonnet-4-5"));
        assert!((u.percent - 25.501).abs() < 1e-9);
        assert!(u.updated_at_ms.is_some());
    }

    #[test]
    fn claude_janela_de_1m_pelo_modelo_ou_pelo_uso() {
        let u = claude_context(&lines(&[assistant("claude-opus-4-6[1m]", 1, 10, 0, false)])).unwrap();
        assert_eq!(u.window_tokens, 1_000_000);
        let u = claude_context(&lines(&[assistant("claude-opus-5-5", 2, 229_222, 1_056, false)])).unwrap();
        assert_eq!(u.used_tokens, 230_280);
        assert_eq!(u.window_tokens, 1_000_000);
    }

    #[test]
    fn claude_sem_resposta_ou_linha_quebrada_e_none() {
        assert_eq!(claude_context(&[]), None);
        assert_eq!(claude_context(&[b"{\"type\":\"assistant\",".to_vec()]), None);
    }

    fn token_count(last: Option<u64>, total: u64, window: Option<u64>) -> Value {
        let mut info = json!({"total_token_usage":{"input_tokens":total,"cached_input_tokens":0}});
        if let Some(l) = last {
            info["last_token_usage"] = json!({"input_tokens":l,"cached_input_tokens":l/2});
        }
        if let Some(w) = window {
            info["model_context_window"] = json!(w);
        }
        json!({"timestamp":"2026-10-26T11:22:00.231Z","type":"event_msg","payload":{"type":"token_count","info":info}})
    }

    #[test]
    fn codex_usa_o_ultimo_token_count_e_o_modelo_do_turn_context() {
        let ls = lines(&[
            json!({"type":"turn_context","payload":{"model":"gpt-velho"}}),
            token_count(Some(1_000), 5_000, Some(272_000)),
            json!({"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}),
            token_count(Some(258_815), 63_528_117, Some(475_000)),
            json!({"type":"event_msg","payload":{"type":"token_count","info":null}}),
        ]);
        let u = codex_context(&ls).unwrap();
        assert_eq!(u.used_tokens, 258_815);
        assert_eq!(u.window_tokens, 475_000);
        assert_eq!(u.model.as_deref(), Some("gpt-6.1-sol"));
        assert!(u.updated_at_ms.is_some());
    }

    #[test]
    fn codex_cai_no_total_e_ignora_evento_sem_janela() {
        let ls = lines(&[token_count(None, 7_000, Some(100_000)), token_count(Some(5), 9, None)]);
        let u = codex_context(&ls).unwrap();
        assert_eq!(u.used_tokens, 7_000);
        assert_eq!(u.model, None);
        assert_eq!(codex_context(&lines(&[json!({"type":"turn_context","payload":{"model":"x"}})])), None);
    }

    #[test]
    fn context_usage_de_outro_agente_e_none() {
        assert_eq!(context_usage("gemini", "/repo", "abc", None), None);
    }

    #[test]
    fn claude_conectores_por_escopo_sem_segredos() {
        let claude_json = json!({
            "mcpServers": {
                "rea": {"command":"C:\\tools\\rea.exe","args":["--token","SEGREDO"],"env":{"KEY":"SEGREDO"}},
                "dup": {"command":"user-dup"}
            },
            "projects": {
                "C:/outro": {"mcpServers": {"nao": {"command":"x"}}},
                "C:/Users/u/proj/": {"mcpServers": {
                    "dup": {"type":"sse","url":"https://user:senha@mcp.example.com:8443/sse?token=SEGREDO"}
                }}
            }
        });
        let mcp_json = json!({"mcpServers": {"docs": {"type":"http","url":"https://docs.example.com/mcp","headers":{"Authorization":"Bearer SEGREDO"}}}});
        let ade = json!({"mcpServers": {"ags": {"command":"C:/Program Files/ADE/ags.exe","args":["mcp","--tab","t1"]}}});
        let got = claude_connectors(Some(&claude_json), Some(&mcp_json), Some(&ade), "C:\\Users\\u\\proj");
        let c = |name: &str, scope: &str, transport: &str, detail: &str| Connector {
            name: name.into(),
            scope: scope.into(),
            transport: transport.into(),
            detail: Some(detail.into()),
        };
        assert_eq!(
            got,
            vec![
                c("ags", "ade", "stdio", "ags.exe"),
                c("dup", "local", "sse", "mcp.example.com:8443"),
                c("docs", "project", "http", "docs.example.com"),
                c("rea", "user", "stdio", "rea.exe"),
            ]
        );
        let text = serde_json::to_string(&got).unwrap();
        assert!(!text.contains("SEGREDO") && !text.contains("senha"));
    }

    #[cfg(windows)]
    #[test]
    fn claude_projeto_casa_sem_caixa_no_windows() {
        let claude_json = json!({"projects": {"c:/users/U/Proj": {"mcpServers": {"a": {"command":"npx"}}}}});
        let got = claude_connectors(Some(&claude_json), None, None, "C:\\Users\\u\\proj\\");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].scope, "local");
    }

    #[test]
    fn codex_conectores_do_config_toml() {
        let toml = r#"
model = "gpt-6.1-sol"
# [mcp_servers.comentado]

[mcp_servers.node_repl]
command = 'C:\Users\u\AppData\node.exe'
args = ["--token", "SEGREDO"]

[mcp_servers.node_repl.env]
KEY = "SEGREDO"

[mcp_servers."remoto x"]
url = "https://api.example.com/mcp?key=SEGREDO"
bearer_token_env_var = "TOKEN"

[mcp_servers.desligado]
command = "x"
enabled = false

[outra]
command = "nao"
"#;
        let got = codex_connectors(toml);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].name.as_str(), got[0].transport.as_str(), got[0].detail.as_deref()), ("node_repl", "stdio", Some("node.exe")));
        assert_eq!((got[1].name.as_str(), got[1].transport.as_str(), got[1].detail.as_deref()), ("remoto x", "http", Some("api.example.com")));
        assert!(got.iter().all(|c| c.scope == "user"));
        assert!(!serde_json::to_string(&got).unwrap().contains("SEGREDO"));
    }

    #[test]
    fn conectores_de_agente_desconhecido_sao_vazios() {
        assert!(connectors("bash", "/repo", None, None).is_empty());
    }

    #[test]
    fn context_usage_le_o_fim_de_um_transcript_real_no_disco() {
        let root = std::env::temp_dir().join(format!("ags-panel-{}", uuid::Uuid::new_v4()));
        let cwd = "/home/u/proj";
        let dir = crate::session::claude_project_dir(cwd, Some(&root));
        std::fs::create_dir_all(&dir).unwrap();
        let body: Vec<u8> = lines(&[assistant("claude-sonnet-4-5", 1, 2, 3, false)]).concat();
        std::fs::write(dir.join("sess-1.jsonl"), [body, b"\n".to_vec()].concat()).unwrap();
        let u = context_usage("claude-code", cwd, "sess-1", Some(&root)).unwrap();
        assert_eq!(u.used_tokens, 6);
        let _ = std::fs::remove_dir_all(&root);
    }
}
