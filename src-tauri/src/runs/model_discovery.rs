//! Model catalogs discovered from provider-owned sources.
//!
//! Discovery is read-only. It never sends prompts or probes inference endpoints.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use url::Url;

use super::roster::{account_command, ModelAvailability, RosterModel};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MODEL_LIST_PAGES: usize = 100;
const MODEL_LIST_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CodexModelPage {
    pub models: Vec<RosterModel>,
    pub next_cursor: Option<String>,
}

/// `Some(true)` si el modelo declara el nivel Fast (`additionalSpeedTiers` o `serviceTiers`);
/// `Some(false)` si el catálogo informa niveles pero no ese; `None` si no informa nada.
fn codex_fast_support(row: &Value) -> Option<bool> {
    let speed = row.get("additionalSpeedTiers").and_then(Value::as_array);
    let tiers = row.get("serviceTiers").and_then(Value::as_array);
    if speed.is_none() && tiers.is_none() {
        return None;
    }
    let is_fast = |value: &Value| value.as_str().is_some_and(|s| s.eq_ignore_ascii_case("fast"));
    let in_speed = speed.is_some_and(|items| items.iter().any(is_fast));
    let in_tiers = tiers.is_some_and(|items| {
        items.iter().any(|item| {
            item.get("name").is_some_and(is_fast) || item.get("id").is_some_and(is_fast)
        })
    });
    Some(in_speed || in_tiers)
}

/// Parses only stable fields needed by the roster; fields added by Codex are ignored.
pub(super) fn parse_codex_model_page(raw: &str) -> Result<CodexModelPage, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "Codex returned invalid model/list JSON".to_string())?;
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex model/list response is missing its data array".to_string())?;

    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        if row.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let levels = row
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.as_str()
                            .or_else(|| item.get("reasoningEffort").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            });
        models.push(RosterModel {
            id: id.to_string(),
            label: row
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(id)
                .to_string(),
            toolcall: None,
            local: false,
            cost_in: None,
            cost_out: None,
            context: row.get("contextWindow").and_then(Value::as_u64),
            source: Some("codex_app_server".into()),
            // A catalog entry says nothing about account entitlement.
            availability: ModelAvailability::Unknown,
            reasoning_levels: levels,
            default_reasoning: row
                .get("defaultReasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_string),
            fast_supported: codex_fast_support(row),
            unavailable: None,
        });
    }

    Ok(CodexModelPage {
        models,
        next_cursor: value
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Follows every page, rejects repeated cursors, and protects against a broken server loop.
pub(super) fn collect_codex_pages(
    mut fetch: impl FnMut(Option<&str>) -> Result<String, String>,
) -> Result<Vec<RosterModel>, String> {
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_models = HashSet::new();
    let mut models = Vec::new();

    for _ in 0..MAX_MODEL_LIST_PAGES {
        let raw = fetch(cursor.as_deref())?;
        let page = parse_codex_model_page(&raw)?;
        for model in page.models {
            if seen_models.insert(model.id.clone()) {
                models.push(model);
            }
        }
        match page.next_cursor {
            None => return Ok(models),
            Some(next) if !seen_cursors.insert(next.clone()) => {
                return Err("Codex model/list repeated a pagination cursor".into());
            }
            Some(next) => cursor = Some(next),
        }
    }

    Err(format!(
        "Codex model/list exceeded the {MAX_MODEL_LIST_PAGES}-page safety limit"
    ))
}

pub(super) fn discover_codex(
    program: &str,
    env: &HashMap<String, String>,
) -> Result<Vec<RosterModel>, String> {
    // `account_command` sai de `program()`, que já nasce com CREATE_NO_WINDOW.
    let mut command = account_command(program, &["app-server", "--listen", "stdio://"], env);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|_| "Codex app-server could not be started".to_string())?;
    let mut server = CodexServer::new(child)?;
    server.initialize()?;
    collect_codex_pages(|cursor| server.model_list(cursor))
}

/// Quién es una cuenta de Codex y cuánto cupo le queda, según su `app-server`.
#[derive(Debug, Clone, Default)]
pub(crate) struct CodexAccount {
    pub email: Option<String>,
    /// `plus`, `pro`, `team`… o `None` con API key.
    pub plan: Option<String>,
    /// `chatgpt` o `apiKey`.
    pub auth: Option<String>,
    pub quota: Option<super::quota::Quota>,
}

/// `account/read` y `account/rateLimits/read` en un solo `app-server`. Ninguna de las dos
/// gasta cupo. Con API key no hay ventanas de límite: `quota` queda en `None`.
pub(crate) fn codex_account(program: &str, env: &HashMap<String, String>) -> Result<CodexAccount, String> {
    let mut command = account_command(program, &["app-server", "--listen", "stdio://"], env);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn().map_err(|_| "Codex app-server could not be started".to_string())?;
    let mut server = CodexServer::new(child)?;
    server.initialize()?;
    let read = server.call("account/read", json!({ "refreshToken": false }))?;
    let account = read.get("account");
    let text = |key: &str| {
        account.and_then(|a| a.get(key)).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
    };
    let quota = server
        .call("account/rateLimits/read", json!({}))
        .ok()
        .and_then(|limits| super::quota::parse_codex_rate_limits(&limits));
    Ok(CodexAccount { email: text("email"), plan: text("planType"), auth: text("type"), quota })
}

pub(super) fn discover_claude(
    program: &str,
    env: &HashMap<String, String>,
) -> Result<Vec<RosterModel>, String> {
    let help = run_read_only(program, &["--help"], env).unwrap_or_default();
    let mut candidates = HashMap::<String, (u8, RosterModel)>::new();

    // This is the published catalog used by the installed CLI's /model picker,
    // discovered in its publishedCatalog implementation (not the gateway catalog).
    let version = run_read_only(program, &["--version"], env).unwrap_or_default();
    if let Some(document) = discover_claude_native_catalog() {
        for model in parse_claude_native_catalog(&document, &version) {
            candidates.insert(model.id.clone(), (4, model));
        }
    }

    for alias in parse_claude_help_aliases(&help) {
        insert_claude_model(
            &mut candidates,
            alias.clone(),
            alias_label(&alias),
            "claude_cli_alias",
            1,
        );
    }

    let config_dir = env
        .get("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")));
    if let Some(config_dir) = config_dir {
        for path in claude_config_paths(&config_dir) {
            let Ok(contents) = std::fs::read_to_string(path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&contents) else {
                continue;
            };
            collect_claude_config_models(&value, &mut candidates);
        }
    }

    if let Some(base_url) = claude_gateway_base_url(env) {
        if let Some(models) = discover_gateway_models(&base_url, env) {
            enrich_claude_models(&mut candidates, models);
        }
    }

    let mut models: Vec<_> = candidates.into_values().map(|(_, model)| model).collect();
    models.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then(left.id.cmp(&right.id))
    });
    if models.is_empty() {
        Err("Claude model discovery is unavailable".into())
    } else {
        Ok(models)
    }
}

fn discover_claude_native_catalog() -> Option<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5)).redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let response = client.get("https://downloads.claude.ai/model-catalog/v1/catalog.json")
        .send().ok()?.error_for_status().ok()?;
    if response.content_length().is_some_and(|size| size > 2_000_000) { return None; }
    let bytes = response.bytes().ok()?;
    if bytes.len() > 2_000_000 { return None; }
    serde_json::from_slice(&bytes).ok()
}

fn parse_claude_native_catalog(document: &Value, cli_version: &str) -> Vec<RosterModel> {
    let Some(installed) = version_numbers(cli_version) else { return vec![]; };
    let Some(configs) = document.pointer("/surfaces/cc/model_selector_config").and_then(Value::as_array) else { return vec![]; };
    let mut models = HashMap::new();
    for row in configs.iter().filter(|config| config.get("id").and_then(Value::as_str) == Some("cc"))
        .filter_map(|config| config.get("models").and_then(Value::as_array)).flatten() {
        if row.get("min_claude_code_version").and_then(Value::as_str).and_then(version_numbers)
            .is_some_and(|minimum| installed < minimum) { continue; }
        let (Some(id), Some(label)) = (row.get("id").and_then(Value::as_str), row.get("name").and_then(Value::as_str)) else { continue; };
        let source = if row.get("section").and_then(Value::as_str) == Some("main") { "native" } else { "native_more" };
        insert_claude_model(&mut models, id.into(), label.into(), source, 4);
        if let Some((_, model)) = models.get_mut(id) {
            model.context = row.pointer("/runtime/max_input_tokens").and_then(Value::as_u64);
            model.reasoning_levels = Some(row.pointer("/thinking/effort_options").and_then(Value::as_array)
                .map(|levels| levels.iter().filter_map(|level| level.get("id").and_then(Value::as_str))
                    .filter(|level| matches!(*level, "low" | "medium" | "high" | "xhigh" | "max"))
                    .map(str::to_string).collect()).unwrap_or_default());
            model.default_reasoning = row.pointer("/runtime/default_effort").and_then(Value::as_str).map(str::to_string);
        }
    }
    models.into_values().map(|(_, model)| model).collect()
}

fn version_numbers(text: &str) -> Option<[u64; 3]> {
    text.split_whitespace().find_map(|part| {
        let mut numbers = part.trim_start_matches('v').split('.');
        Some([numbers.next()?.parse().ok()?, numbers.next()?.parse().ok()?, numbers.next()?.parse().ok()?])
    })
}

/// A gateway catalog is global, not a list of Claude Code models or entitlements.
/// Enrich exact IDs already obtained from CLI/profile configuration without adding IDs.
fn enrich_claude_models(
    candidates: &mut HashMap<String, (u8, RosterModel)>,
    gateway: Vec<RosterModel>,
) {
    for metadata in gateway {
        if let Some((_, known)) = candidates.get_mut(&metadata.id) {
            if !matches!(known.source.as_deref(), Some("native" | "native_more")) && metadata.label != metadata.id && safe_model_label(&metadata.label) {
                known.label = metadata.label;
            }
            if metadata.context.is_some() {
                known.context = metadata.context;
            }
            // Keep origin and unknown entitlement; a matching gateway row grants no access.
        }
    }
}

fn run_read_only(program: &str, args: &[&str], env: &HashMap<String, String>) -> Option<String> {
    let output = crate::util::output_with_timeout(
        &mut account_command(program, args, env),
        Duration::from_secs(5),
    )
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_claude_help_aliases(help: &str) -> Vec<String> {
    // Parse only the help paragraph for --model; other options may also contain quoted
    // values that are not model aliases. The CLI formats this paragraph across lines.
    let Some(start) = help.find("--model") else {
        return Vec::new();
    };
    let rest = &help[start..];
    let end = rest.char_indices().find_map(|(at, ch)| {
        (ch == '\n' && rest[at + 1..].trim_start().starts_with('-')).then_some(at)
    }).unwrap_or(rest.len());
    let section = &rest[..end];
    let mut aliases = Vec::new();
    let mut delimiter = None;
    let mut current = String::new();
    let mut previous = ' ';
    for ch in section.chars() {
        if matches!(ch, '\'' | '"' | '`') {
            match delimiter {
                Some(open) if open == ch => {
                    let candidate = current.trim();
                    if !candidate.is_empty()
                        && candidate.chars().all(|c| {
                            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':')
                        })
                    {
                        aliases.push(candidate.to_string());
                    }
                    current.clear();
                    delimiter = None;
                }
                None if !previous.is_alphanumeric() => delimiter = Some(ch),
                None => {},
                _ => current.push(ch),
            }
        } else if delimiter.is_some() {
            current.push(ch);
        }
        previous = ch;
    }
    aliases.sort();
    aliases.dedup();
    aliases
}

fn alias_label(id: &str) -> String {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => id.to_string(),
    }
}

fn claude_config_paths(config_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        config_dir.join("settings.json"),
        config_dir.join("settings.local.json"),
        config_dir.join("model-config.json"),
        config_dir.join("models.json"),
        config_dir.join(".claude.json"),
    ];
    if let Some(home) = dirs::home_dir() {
        if config_dir == home.join(".claude") {
            paths.push(home.join(".claude.json"));
        }
    }
    paths
}

fn collect_claude_config_models(value: &Value, output: &mut HashMap<String, (u8, RosterModel)>) {
    if let Some(aliases) = value.get("modelAliases").and_then(Value::as_object) {
        for (alias, target) in aliases {
            insert_claude_model(output, alias.clone(), alias_label(alias), "claude_config", 2);
            if let Some(id) = target.as_str() { insert_claude_model(output, id.into(), id.into(), "claude_config", 2); }
        }
    }
    fn picker(
        value: &Value,
        output: &mut HashMap<String, (u8, RosterModel)>,
    ) {
        match value {
            Value::Object(object) => {
                let label = ["displayName", "label", "name"]
                    .iter()
                    .find_map(|key| object.get(*key).and_then(Value::as_str))
                    .map(str::to_string);
                let model_id = ["id", "model", "modelId", "model_id", "value", "slug"]
                    .iter()
                    .find_map(|key| object.get(*key).and_then(Value::as_str))
                    .map(str::to_string);
                if let Some(id) = model_id {
                        insert_claude_model(
                            output,
                            id.clone(),
                            label.unwrap_or(id),
                            "claude_config",
                            2,
                        );
                }
                // Only descend into documented model collections, never metadata/headers.
                for key in ["options", "availableModels", "customModels", "models"] {
                    if let Some(child) = object.get(key) {
                        picker(child, output);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    picker(item, output);
                }
            }
            Value::String(id) => {
                insert_claude_model(output, id.clone(), id.clone(), "claude_config", 2);
            }
            _ => {}
        }
    }
    for key in ["model", "modelId", "defaultModel"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            insert_claude_model(output, id.into(), id.into(), "claude_config", 2);
        }
    }
    for key in ["availableModels", "modelPicker", "customModels", "customModelOptions", "modelOptions", "models"] {
        if let Some(models) = value.get(key) {
            picker(models, output);
        }
    }
    if value.is_array() {
        picker(value, output);
    }
    // These are model IDs, unlike adjacent API key/base URL/header configuration.
    for key in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL"] {
        if let Some(id) = value.get("env").and_then(|env| env.get(key)).and_then(Value::as_str) {
            insert_claude_model(output, id.into(), id.into(), "claude_config", 2);
        }
    }
}

fn safe_model_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256
        && !id.starts_with(['/', '.', '\\'])
        && !id.contains("://") && !id.contains("..")
        && !(id.len() > 2 && id.as_bytes()[1] == b':')
        && !["sk-", "sk_", "api_key", "token_", "Bearer"].iter().any(|prefix| id.starts_with(prefix))
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '[' | ']'))
}

fn safe_model_label(label: &str) -> bool {
    !label.contains('@') && !label.contains("://") && !label.contains('\\')
        && !label.starts_with('/') && !label.starts_with("sk-")
        && !label.chars().any(char::is_control)
}

pub(super) fn insert_claude_model(
    models: &mut HashMap<String, (u8, RosterModel)>,
    id: String,
    label: String,
    source: &str,
    priority: u8,
) {
    let id = id.trim().to_string();
    if !safe_model_id(&id) {
        return;
    }
    let candidate = RosterModel {
        id: id.clone(),
        label: if label.trim().is_empty() || !safe_model_label(&label) {
            id.clone()
        } else {
            label
        },
        toolcall: None,
        local: false,
        cost_in: None,
        cost_out: None,
        context: None,
        source: Some(source.into()),
        availability: ModelAvailability::Unknown,
        reasoning_levels: None,
        default_reasoning: None,
        fast_supported: None,
        unavailable: None,
    };
    match models.get(&id) {
        Some((old_priority, _)) if *old_priority >= priority => {}
        _ => {
            models.insert(id, (priority, candidate));
        }
    }
}

fn claude_gateway_base_url(env: &HashMap<String, String>) -> Option<String> {
    let config_dir = env
        .get("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))?;
    let mut configured = None;
    for path in claude_config_paths(&config_dir) {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(url) = value
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(Value::as_str)
        {
            configured = Some(url.to_string());
        }
    }
    configured.or_else(|| env.get("ANTHROPIC_BASE_URL").cloned()).or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok())
}

fn discover_gateway_models(base: &str, env: &HashMap<String, String>) -> Option<Vec<RosterModel>> {
    use std::io::Read;
    let base = Url::parse(base).ok()?;
    let host = base.host_str()?;
    let local_http =
        base.scheme() == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1");
    if (base.scheme() != "https" && !local_http)
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return None;
    }
    let root = base.as_str().trim_end_matches('/');
    let endpoint = Url::parse(&format!(
        "{}/models", if root.ends_with("/v1") { root.to_string() } else { format!("{root}/v1") }
    ))
    .ok()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let mut request = client.get(endpoint);
    // Credentials are held only for this request and never included in the roster/errors.
    let dir = env.get("CLAUDE_CONFIG_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")));
    let mut auth = env.get("ANTHROPIC_AUTH_TOKEN").cloned().or_else(|| std::env::var("ANTHROPIC_AUTH_TOKEN").ok());
    let mut key = env.get("ANTHROPIC_API_KEY").cloned().or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());
    if let Some(dir) = dir {
        for path in claude_config_paths(&dir) {
            let Ok(raw) = std::fs::read_to_string(path) else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
            if let Some(token) = value.pointer("/env/ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str) { auth = Some(token.into()); }
            if let Some(token) = value.pointer("/env/ANTHROPIC_API_KEY").and_then(Value::as_str) { key = Some(token.into()); }
        }
    }
    if let Some(token) = auth { request = request.bearer_auth(token); }
    else if let Some(key) = key { request = request.header("x-api-key", key).header("anthropic-version", "2023-06-01"); }
    let response = request.send().ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 2 * 1024 * 1024)
    {
        return None;
    }
    let mut body = Vec::new();
    response.take(2 * 1024 * 1024 + 1).read_to_end(&mut body).ok()?;
    if body.len() > 2 * 1024 * 1024 {
        return None;
    }
    parse_gateway_models(&body)
}

fn parse_gateway_models(body: &[u8]) -> Option<Vec<RosterModel>> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let data = value.get("data")?.as_array()?;
    Some(
        data.iter()
            .filter_map(|entry| {
                let id = entry.get("id")?.as_str()?.trim();
                if !safe_model_id(id) {
                    return None;
                }
                let label = entry
                    .get("display_name")
                    .or_else(|| entry.get("displayName"))
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str)
                    .filter(|label| safe_model_label(label))
                    .unwrap_or(id);
                Some(RosterModel {
                    id: id.into(),
                    label: label.into(),
                    toolcall: None,
                    local: false,
                    cost_in: None,
                    cost_out: None,
                    context: None,
                    source: Some("claude_gateway".into()),
                    availability: ModelAvailability::Unknown,
                    reasoning_levels: None,
                    default_reasoning: None,
        fast_supported: None,
                    unavailable: None,
                })
            })
            .collect(),
    )
}

struct CodexServer {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl CodexServer {
    fn new(mut child: Child) -> Result<Self, String> {
        let Some(stdin) = child.stdin.take() else {
            terminate_process_tree(&mut child);
            return Err("Codex app-server stdin is unavailable".into());
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_process_tree(&mut child);
            return Err("Codex app-server stdout is unavailable".into());
        };
        if let Some(mut stderr) = child.stderr.take() {
            // Drain diagnostics to prevent a full stderr pipe from blocking the server.
            // Never surface stderr: it may contain profile paths or provider details.
            thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            });
        }
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            lines,
            next_id: 1,
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "Codex app-server stdin is closed".to_string())?;
        serde_json::to_writer(&mut *stdin, message)
            .map_err(|_| "Could not write Codex app-server request".to_string())?;
        stdin
            .write_all(b"\n")
            .map_err(|_| "Could not write Codex app-server request".to_string())?;
        stdin
            .flush()
            .map_err(|_| "Could not flush Codex app-server request".to_string())
    }

    fn response(&mut self, id: u64, method: &str) -> Result<Value, String> {
        receive_response(&self.lines, id, method, REQUEST_TIMEOUT)
    }

    fn initialize(&mut self) -> Result<(), String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({
            "id": id,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "ade-ags", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": {}
            }
        }))?;
        let _ = self.response(id, "initialize")?;
        self.send(&json!({ "method": "initialized", "params": {} }))
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        self.response(id, method)
    }

    fn model_list(&mut self, cursor: Option<&str>) -> Result<String, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut params = json!({ "includeHidden": false, "limit": MODEL_LIST_PAGE_SIZE });
        if let (Some(cursor), Some(object)) = (cursor, params.as_object_mut()) {
            object.insert("cursor".into(), Value::String(cursor.to_string()));
        }
        self.send(&json!({ "id": id, "method": "model/list", "params": params }))?;
        let result = self.response(id, "model/list")?;
        serde_json::to_string(&result)
            .map_err(|_| "Could not parse Codex model/list response".to_string())
    }
}

fn receive_response(
    lines: &Receiver<String>,
    id: u64,
    method: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("Timed out waiting for Codex {method}"));
        }
        let line = lines.recv_timeout(remaining).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => format!("Timed out waiting for Codex {method}"),
            mpsc::RecvTimeoutError::Disconnected => {
                format!("Codex app-server closed before replying to {method}")
            }
        })?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue; // Ignore notifications and unrelated server requests.
        }
        if let Some(error) = message.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            return Err(format!("Codex app-server rejected {method} (error {code})"));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| format!("Codex {method} response has no result"));
    }
}

impl Drop for CodexServer {
    fn drop(&mut self) {
        self.stdin.take(); // EOF gives the server a chance to shut down cleanly.
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        terminate_process_tree(&mut self.child);
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = crate::util::program("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = child.kill();

    let _ = child.wait();
}

#[cfg(test)]
#[path = "model_discovery_test.rs"]
mod test;
