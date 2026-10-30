//! Injeção somente no nascimento do PTY; nunca modifica uma aba viva.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

pub(crate) const TABS_SETTING: &str = "ai_memory_tabs_enabled";

#[derive(Default)]
pub(crate) struct TabInjection {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub settings_file: Option<PathBuf>,
}
impl Drop for TabInjection {
    fn drop(&mut self) {
        if let Some(path) = &self.settings_file {
            let _ = std::fs::remove_file(path);
        }
    }
}

// O cache só guarda identidade do executável e a compatibilidade, nunca dados externos.
type VersionCache = HashMap<PathBuf, (Option<SystemTime>, u64, bool)>;
static VERSIONS: OnceLock<Mutex<VersionCache>> = OnceLock::new();

pub(crate) fn supported_binary(cwd: &Path) -> Option<PathBuf> {
    let program = crate::util::path_env::find_program("ai-memory")?;
    supported_program(&program, cwd).then_some(program)
}

pub(super) fn supported_program(program: &Path, cwd: &Path) -> bool {
    let Some(result) = supported_program_result(program, cwd) else {
        return false;
    };
    result
}

fn supported_program_result(program: &Path, cwd: &Path) -> Option<bool> {
    let program = program.to_path_buf();
    let meta = std::fs::metadata(&program).ok()?;
    let identity = (meta.modified().ok(), meta.len());
    let cache = VERSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((modified, len, ok)) = cache.lock().ok()?.get(&program).copied()
        && (modified, len) == identity
    {
        return Some(ok);
    }
    let ok = super::client::Client::at(Some(program.clone()), cwd.to_path_buf())
        .and_then(|c| c.ensure_supported())
        .is_ok();
    cache
        .lock()
        .ok()?
        .insert(program.clone(), (identity.0, identity.1, ok));
    Some(ok)
}

pub(crate) fn agent_from_program(program: &str) -> Option<&'static str> {
    let file = program.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let stem = file
        .strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".cmd"))
        .unwrap_or(&file);
    match stem {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        _ => None,
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn carries_hooks(value: &Value) -> bool {
    match value {
        Value::String(s) => s.to_ascii_lowercase().contains("ai-memory"),
        Value::Array(a) => a.iter().any(carries_hooks),
        Value::Object(o) => o.values().any(carries_hooks),
        _ => false,
    }
}

/// Config inválida ou ilegível faz a captura falhar fechada, sem duplicar hooks.
fn should_skip_hooks(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| match std::fs::read(path) {
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => serde_json::from_slice::<Value>(&bytes)
            .map(|v| v.get("hooks").is_some_and(carries_hooks))
            .unwrap_or(true),
        Ok(_) => true,
    })
}

fn hooks(program: &Path) -> Value {
    let mut events = serde_json::Map::new();
    for (name, event) in [
        ("SessionStart", "session-start"),
        ("UserPromptSubmit", "user-prompt-submit"),
        ("PreToolUse", "pre-tool-use"),
        ("PostToolUse", "post-tool-use"),
        ("PreCompact", "pre-compact"),
        ("Stop", "stop"),
        ("SessionEnd", "session-end"),
        ("SubagentStart", "subagent-start"),
        ("SubagentStop", "subagent-stop"),
    ] {
        let path = crate::util::external_path(program)
            .to_string_lossy()
            .into_owned();
        let mut handler = if cfg!(windows) {
            // Exec form oficial usado pelo install-hooks WindowsNative da 3.3.0.
            json!({"type":"command","command":path,"args":["hook","--event",event,"--agent","claude-code"]})
        } else {
            json!({"type":"command","command":format!("{} hook --event {event} --agent claude-code", shell_quote(&path))})
        };
        if name == "SessionEnd" {
            handler["timeout"] = json!(15);
        }
        events.insert(name.into(), json!([{"matcher":"","hooks":[handler]}]));
    }
    json!({"hooks":events})
}

fn read_owned_config(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"mcpServers":{}})),
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Config MCP da aba inválida.".into())
        }
        Err(_) => Err("Não foi possível ler o MCP da aba.".into()),
    }
}

/// Todos os caminhos recebidos são do ADE; configurações de agente só são lidas.
pub(crate) fn prepare(
    program: &Path,
    dir: &Path,
    tab_id: &str,
    agent: &str,
    argv: &[String],
    env: &HashMap<String, String>,
    settings: &[PathBuf],
) -> Result<TabInjection, String> {
    let name = crate::ipc::mcp::tab_config_name(tab_id);
    if name == "tab-" {
        return Err("Identificador de aba inválido.".into());
    }
    // Flags depois de `--` virariam parte do prompt; não alteramos esse comando.
    if agent != "opencode" && argv.iter().any(|arg| arg == "--") {
        return Ok(TabInjection::default());
    }
    let binary = crate::util::external_path(program)
        .to_string_lossy()
        .into_owned();
    let mut plan = TabInjection::default();
    match agent {
        "claude" => {
            std::fs::create_dir_all(dir)
                .map_err(|_| "Não foi possível preparar o MCP da aba.".to_string())?;
            let config_path = dir.join(format!("{name}.json"));
            let mut config = read_owned_config(&config_path)?;
            let root = config
                .as_object_mut()
                .ok_or("Config MCP da aba inválida.")?;
            let servers = root
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("Servidores MCP da aba inválidos.")?;
            // Claude define CLAUDE_CODE_SESSION_ID ao abrir seu servidor MCP.
            servers.insert(
                "ai-memory".into(),
                json!({"command":binary,"args":["mcp-bridge"]}),
            );
            std::fs::write(&config_path, config.to_string())
                .map_err(|_| "Não foi possível gravar o MCP da aba.".to_string())?;
            let config_arg = crate::util::external_path(&config_path)
                .to_string_lossy()
                .into_owned();
            if !argv.iter().any(|a| a == &config_arg) {
                plan.args.extend(["--mcp-config".into(), config_arg]);
            }
            // Não substitui --settings que a pessoa colocou no comando.
            if !argv
                .iter()
                .any(|a| a == "--settings" || a.starts_with("--settings="))
                && !should_skip_hooks(settings)
            {
                let file = dir.join(format!(
                    "{name}.ai-memory-{}.settings.json",
                    uuid::Uuid::new_v4().simple()
                ));
                plan.settings_file = Some(file.clone());
                std::fs::write(&file, hooks(program).to_string())
                    .map_err(|_| "Não foi possível gravar hooks da aba.".to_string())?;
                plan.args.extend([
                    "--settings".into(),
                    crate::util::external_path(&file)
                        .to_string_lossy()
                        .into_owned(),
                ]);
            }
        }
        "opencode" => {
            let mut config: Value = match env.get("OPENCODE_CONFIG_CONTENT") {
                Some(raw) => serde_json::from_str(raw)
                    .map_err(|_| "Config OpenCode da aba inválida.".to_string())?,
                None => json!({}),
            };
            let root = config.as_object_mut().ok_or("Config OpenCode inválida.")?;
            let servers = root
                .entry("mcp")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("Servidores OpenCode inválidos.")?;
            servers.insert("ai-memory".into(), json!({"type":"local","command":[binary,"mcp-bridge","--no-session-id"],"enabled":true}));
            plan.env
                .insert("OPENCODE_CONFIG_CONTENT".into(), config.to_string());
        }
        "codex" => {
            // Literais TOML mantêm barras do Windows; apóstrofo usa string JSON/TOML.
            let toml_binary = if binary.contains('\'') {
                serde_json::to_string(&binary).map_err(|_| "Caminho de binário inválido.")?
            } else {
                format!("'{binary}'")
            };
            plan.args.extend([
                "-c".into(),
                format!("mcp_servers.ai-memory.command={toml_binary}"),
                "-c".into(),
                "mcp_servers.ai-memory.args=['mcp-bridge','--no-session-id']".into(),
            ]);
        }
        _ => {}
    }
    Ok(plan)
}

pub(crate) fn user_settings(home: &Path, env: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut paths = vec![home.join(".claude/settings.json")];
    if let Some(profile) = env
        .get("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
    {
        paths.push(profile.join("settings.json"));
    }
    paths
}

/// Prelaunch já é um shell; no lançamento direto os args entram sem reparse.
pub(crate) fn shell_args(args: &[String]) -> Result<String, String> {
    if cfg!(windows) {
        if args
            .iter()
            .any(|v| v.contains(['"', '%', '!', '^', '\n', '\r']))
        {
            return Err(
                "Prelaunch Windows não comporta estes argumentos de memória com segurança.".into(),
            );
        }
        Ok(args
            .iter()
            .map(|v| format!("\"{v}\""))
            .collect::<Vec<_>>()
            .join(" "))
    } else {
        Ok(args
            .iter()
            .map(|v| shell_quote(v))
            .collect::<Vec<_>>()
            .join(" "))
    }
}

pub(crate) fn enabled(value: Option<&str>) -> bool {
    value != Some("false")
}

pub(crate) fn protect_pty_env(command: &mut portable_pty::CommandBuilder) {
    command.env("AI_MEMORY_RUN_AUTOWIRE", "false");
}

pub(crate) fn remove_owned_server(dir: &Path, tab_id: &str) {
    let path = dir.join(format!("{}.json", crate::ipc::mcp::tab_config_name(tab_id)));
    if let Ok(mut config) = read_owned_config(&path)
        && let Some(servers) = config.get_mut("mcpServers").and_then(Value::as_object_mut)
        && servers.remove("ai-memory").is_some()
    {
        let _ = std::fs::write(path, config.to_string());
    }
}
