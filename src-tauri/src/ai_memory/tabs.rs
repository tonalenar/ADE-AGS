//! Injeção somente no nascimento do PTY; nunca modifica uma aba viva.
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
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

pub(crate) fn supported_binary(cwd: &Path) -> Option<PathBuf> {
    let program = crate::util::path_env::find_program("ai-memory")?;
    supported_program(&program, cwd).then_some(program)
}

/// A versão confirmada fica em cache dentro do `Client`; uma falha não é guardada.
pub(super) fn supported_program(program: &Path, cwd: &Path) -> bool {
    super::client::Client::at(Some(program.to_path_buf()), cwd.to_path_buf())
        .and_then(|client| client.ensure_supported())
        .is_ok()
}

/// O que quem abre o agente (`pty_create`, a conversa por protocolo) precisa saber depois de preparar a injeção.
pub(crate) struct NewTab {
    pub plan: TabInjection,
    /// Binário aceito (versão mínima); `None` quando ausente ou antigo.
    pub binary: Option<PathBuf>,
    /// O usuário já tem o `SessionStart` do ai-memory nos próprios settings.
    pub hooks_configured: bool,
    /// O binário existe mas não deu para gravar os arquivos da injeção (a abertura segue sem memória).
    pub failed: bool,
}

/// Prepara hooks e MCP de uma nova aba. Faz subprocesso (`--version`) e I/O de arquivo: quem chama de
/// um contexto assíncrono deve usar `spawn_blocking`.
pub(crate) fn prepare_new_tab(
    tab: &str,
    agent: &str,
    dir: &Path,
    home: &Path,
    cwd: &Path,
    argv: &[String],
    extras: &HashMap<String, String>,
) -> NewTab {
    prepare_new_tab_with(supported_binary(cwd), tab, agent, dir, home, cwd, argv, extras)
}

/// O miolo de [`prepare_new_tab`], com o binário já resolvido (`None` = ausente ou antigo): só grava arquivos.
pub(crate) fn prepare_new_tab_with(
    binary: Option<PathBuf>,
    tab: &str,
    agent: &str,
    dir: &Path,
    home: &Path,
    cwd: &Path,
    argv: &[String],
    extras: &HashMap<String, String>,
) -> NewTab {
    let mut out = NewTab { plan: TabInjection::default(), binary: None, hooks_configured: false, failed: false };
    let Some(binary) = binary else {
        return out;
    };
    if agent != "claude" {
        out.plan = static_plan(&binary, cwd, agent, extras).unwrap_or_default();
        return out;
    }
    let settings = user_settings(home, extras);
    out.hooks_configured = configured_hooks(&settings);
    out.binary = Some(binary.clone());
    match prepare(&binary, dir, tab, agent, argv, extras, &settings) {
        Ok(plan) => out.plan = plan,
        Err(_) => {
            out.failed = true;
            eprintln!("[ade-ags] integração ai-memory indisponível nesta nova aba");
        }
    }
    out
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

/// O que os `settings.json` do usuário já dizem sobre o ai-memory.
struct UserHooks {
    /// Eventos (`SessionStart`, `Stop`…) com um hook do ai-memory.
    events: HashSet<String>,
    /// Algum arquivo existe mas não dá para ler como JSON: a captura falha fechada, sem duplicar hooks.
    unreadable: bool,
}

impl UserHooks {
    fn read(paths: &[PathBuf]) -> Self {
        let mut found = Self { events: HashSet::new(), unreadable: false };
        for path in paths {
            let bytes = match std::fs::read(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => bytes,
                _ => {
                    found.unreadable = true;
                    continue;
                }
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                found.unreadable = true;
                continue;
            };
            if let Some(events) = value.get("hooks").and_then(Value::as_object) {
                found.events.extend(
                    events
                        .iter()
                        .filter(|(_, hooks)| carries_hooks(hooks))
                        .map(|(name, _)| name.clone()),
                );
            }
        }
        found
    }

    /// Com o `SessionStart` do ai-memory, a pessoa rodou o `setup` dele: a configuração é dela inteira.
    fn complete(&self) -> bool {
        self.events.contains("SessionStart")
    }
}

/// Hooks da aba, sem os eventos que o usuário já configurou com o ai-memory.
fn hooks(program: &Path, skip: &HashSet<String>) -> Value {
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
        if skip.contains(name) {
            continue;
        }
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
    _env: &HashMap<String, String>,
    settings: &[PathBuf],
) -> Result<TabInjection, String> {
    let name = crate::ipc::mcp::tab_config_name(tab_id);
    if name == "tab-" {
        return Err("Identificador de aba inválido.".into());
    }
    // Flags depois de `--` virariam parte do prompt; não alteramos esse comando.
    // Sem pin de escopo nativo, só Claude session-aware pode receber MCP.
    if agent != "claude" || argv.iter().any(|arg| arg == "--") {
        return Ok(TabInjection::default());
    }
    let binary = crate::util::external_path(program)
        .to_string_lossy()
        .into_owned();
    let mut plan = TabInjection::default();
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
    let user = UserHooks::read(settings);
    let tab_hooks = hooks(program, &user.events);
    if !argv
        .iter()
        .any(|a| a == "--settings" || a.starts_with("--settings="))
        && !user.unreadable
        && !user.complete()
        && !tab_hooks["hooks"].as_object().is_none_or(|h| h.is_empty())
    {
        let file = dir.join(format!(
            "{name}.ai-memory-{}.settings.json",
            uuid::Uuid::new_v4().simple()
        ));
        plan.settings_file = Some(file.clone());
        std::fs::write(&file, tab_hooks.to_string())
            .map_err(|_| "Não foi possível gravar hooks da aba.".to_string())?;
        plan.args.extend([
            "--settings".into(),
            crate::util::external_path(&file)
                .to_string_lossy()
                .into_owned(),
        ]);
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

/// Nunca deixa o `ai-memory run` reescrever configurações globais do agente, nem com a injeção desligada.
pub(crate) const PROTECT_ENV: (&str, &str) = ("AI_MEMORY_RUN_AUTOWIRE", "false");

pub(crate) fn protect_pty_env(command: &mut portable_pty::CommandBuilder) {
    command.env(PROTECT_ENV.0, PROTECT_ENV.1);
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

/// Só um `SessionStart` do ai-memory em JSON válido dispensa nosso arquivo (e vale para a continuidade).
pub(crate) fn configured_hooks(paths: &[PathBuf]) -> bool {
    UserHooks::read(paths).complete()
}

/// Prefere o par explícito do marcador; sem ele, guessProject exige correspondência única.
fn static_plan(
    binary: &Path,
    cwd: &Path,
    agent: &str,
    extras: &HashMap<String, String>,
) -> Option<TabInjection> {
    let (workspace, project) = match super::marker::scope(cwd, dirs::home_dir().as_deref()) {
        Some(scope) => scope,
        None => {
            let projects = super::client::Client::at(Some(binary.to_path_buf()), cwd.to_path_buf())
                .ok()?.read::<Vec<super::types::Project>>(super::client::Read::Projects).ok()?.data;
            let project = unique_project(&projects, cwd)?;
            (project.workspace_name.clone(), project.project_name.clone())
        }
    };
    let ags = std::env::current_exe()
        .ok()?
        .with_file_name(if cfg!(windows) { "ags.exe" } else { "ags" });
    if !ags.is_file() {
        return None;
    }
    scoped_plan(&ags, cwd, agent, extras, &workspace, &project).ok()
}
pub(super) fn scoped_plan(
    ags: &Path,
    cwd: &Path,
    agent: &str,
    extras: &HashMap<String, String>,
    workspace: &str,
    project: &str,
) -> Result<TabInjection, String> {
    super::sessions::validate_scope(workspace, project)?;
    let exe = crate::util::external_path(ags)
        .to_string_lossy()
        .into_owned();
    let args = vec![
        "ai-memory-bridge".to_string(),
        "--cwd".into(),
        crate::util::external_path(cwd)
            .to_string_lossy()
            .into_owned(),
        "--workspace".into(),
        workspace.into(),
        "--project".into(),
        project.into(),
    ];
    let mut plan = TabInjection::default();
    match agent {
        "codex" => {
            plan.args = vec![
                "-c".into(),
                format!("mcp_servers.ai-memory.command={}", json!(exe)),
                "-c".into(),
                format!("mcp_servers.ai-memory.args={}", json!(args)),
            ];
        }
        "opencode" => {
            let mut config: Value = extras
                .get("OPENCODE_CONFIG_CONTENT")
                .map(|s| serde_json::from_str(s))
                .transpose()
                .map_err(|_| "Config OpenCode inválida.")?
                .unwrap_or_else(|| json!({}));
            let root = config.as_object_mut().ok_or("Config OpenCode inválida.")?;
            let mcp = root
                .entry("mcp")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("Config MCP inválida.")?;
            let mut command = vec![exe];
            command.extend(args);
            mcp.insert(
                "ai-memory".into(),
                json!({"type":"local","command":command,"enabled":true}),
            );
            plan.env
                .insert("OPENCODE_CONFIG_CONTENT".into(), config.to_string());
        }
        _ => return Err("Cliente sem adaptador de escopo.".into()),
    }
    Ok(plan)
}

pub(super) fn unique_project<'a>(
    projects: &'a [super::types::Project],
    cwd: &Path,
) -> Option<&'a super::types::Project> {
    let folder = cwd.file_name()?.to_str()?;
    let mut matches = projects
        .iter()
        .filter(|p| p.project_name.eq_ignore_ascii_case(folder));
    let project = matches.next()?;
    if matches.next().is_some() || super::scoped_bridge::reserved_project(&project.project_name) {
        return None;
    }
    Some(project)
}
