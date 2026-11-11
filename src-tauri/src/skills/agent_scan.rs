//! As skills que o Claude Code acha no disco, para o menu do `/` antes de o agente anunciar a lista.
//!
//! Só metadados: o nome (a pasta, ou `plugin:pasta`) e a `description` do frontmatter do SKILL.md,
//! mais as configurações que decidem se a skill entra (`enabledPlugins`, `skillOverrides`). Nada aqui
//! executa código de skill, e o corpo do arquivo não é lido. Quando o agente informa a própria lista,
//! ela manda no menu; esta varredura só cobre o intervalo até lá.
//!
//! A precedência é a do Claude: usuário, depois projeto, depois plugins. O primeiro nome vence.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Quanto do SKILL.md é lido. O frontmatter fica no começo; o corpo nunca entra.
const FRONTMATTER_READ_MAX: u64 = 16 * 1024;
const NAME_MAX: usize = 80;
const DESCRIPTION_MAX: usize = 500;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentSkillScope {
    User,
    Project,
    Plugin,
}

/// Uma skill achada no disco. `name` é o que se digita depois da barra: a pasta, ou `plugin:pasta`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: Option<String>,
    pub plugin: Option<String>,
    pub scope: AgentSkillScope,
}

/// Nome que o composer insere como `/nome` sem ambiguidade: começa por letra ou número, usa só letras,
/// números, `-`, `_` e `:` (o prefixo de plugin, como em `design:design-critique`), e cabe em 80 caracteres.
pub fn is_agent_command_name(name: &str) -> bool {
    name.chars().count() <= NAME_MAX
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

/// Parte de nome (pasta ou prefixo de plugin) sem surpresa no composer: letras, números, `-` e `_`.
fn is_name_part(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Default, Debug, PartialEq, Eq)]
struct Frontmatter {
    description: Option<String>,
    user_invocable: Option<bool>,
}

/// Lê o frontmatter do começo do arquivo. Sem `---` de abertura e de fechamento não há metadados:
/// a skill entra só pelo nome da pasta, como no Claude.
fn read_frontmatter(path: &Path) -> Frontmatter {
    let mut bytes = Vec::new();
    let read = fs::File::open(path).and_then(|file| file.take(FRONTMATTER_READ_MAX).read_to_end(&mut bytes));
    if read.is_err() {
        return Frontmatter::default();
    }
    let head = String::from_utf8_lossy(&bytes);
    let mut lines = head.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Frontmatter::default();
    }
    let mut block = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            return parse_block(&block);
        }
        block.push(line);
    }
    Frontmatter::default()
}

/// YAML completo quando o bloco é YAML válido. O que o Claude aceita e o YAML recusa (um `: ` solto
/// dentro de uma descrição, por exemplo) cai na leitura linha a linha.
fn parse_block(block: &[&str]) -> Frontmatter {
    let text = block.join("\n");
    if let Ok(serde_yaml::Value::Mapping(map)) = serde_yaml::from_str::<serde_yaml::Value>(&text) {
        return Frontmatter {
            description: map.get("description").and_then(yaml_text),
            user_invocable: map.get("user-invocable").and_then(yaml_bool),
        };
    }
    line_fallback(block)
}

fn yaml_text(value: &serde_yaml::Value) -> Option<String> {
    non_empty(value.as_str()?.trim())
}

fn yaml_bool(value: &serde_yaml::Value) -> Option<bool> {
    match value {
        serde_yaml::Value::Bool(flag) => Some(*flag),
        serde_yaml::Value::String(text) => bool_of_text(text),
        _ => None,
    }
}

/// Leitura por linha do frontmatter que o YAML recusou: chaves no começo da linha, valor solto (com
/// `: ` dentro) ou entre aspas, e bloco `>` / `|` com as linhas indentadas que vêm depois.
fn line_fallback(block: &[&str]) -> Frontmatter {
    let mut frontmatter = Frontmatter::default();
    let mut index = 0;
    while index < block.len() {
        let line = block[index];
        index += 1;
        // Linha indentada é continuação de um valor, nunca uma chave.
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, raw)) = line.split_once(':') else { continue };
        let raw = raw.trim();
        let value = if raw.starts_with('>') || raw.starts_with('|') {
            let mut parts = Vec::new();
            while index < block.len() && block[index].starts_with(char::is_whitespace) {
                parts.push(block[index].trim());
                index += 1;
            }
            parts.join(" ")
        } else {
            unquote(strip_comment(raw)).to_string()
        };
        match key.trim() {
            "description" => frontmatter.description = non_empty(value.trim()),
            "user-invocable" => frontmatter.user_invocable = bool_of_text(&value),
            _ => {}
        }
    }
    frontmatter
}

/// Um valor sem aspas perde o comentário (` #…`), como no YAML.
fn strip_comment(raw: &str) -> &str {
    if raw.starts_with('"') || raw.starts_with('\'') {
        return raw;
    }
    match raw.find(" #") {
        Some(at) => raw[..at].trim_end(),
        None => raw,
    }
}

fn unquote(value: &str) -> &str {
    let bytes = value.as_bytes();
    let quoted = value.len() >= 2 && (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[value.len() - 1] == bytes[0];
    if quoted { &value[1..value.len() - 1] } else { value }
}

/// Booleano de YAML 1.1, que o Claude aceita (`yes`, `on`…) e o YAML 1.2 deixa como texto.
fn bool_of_text(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "y" => Some(true),
        "false" | "no" | "off" | "n" => Some(false),
        _ => None,
    }
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// Só estas duas chaves são guardadas; o parser descarta o resto do arquivo (inclusive `env`, onde
/// podem estar segredos). Arquivo com comentários ou vírgula sobrando não decodifica e é ignorado.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillSettings {
    #[serde(default)]
    enabled_plugins: HashMap<String, Value>,
    #[serde(default)]
    skill_overrides: HashMap<String, Value>,
}

fn read_settings(path: &Path) -> Option<SkillSettings> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Pasta de skills de um plugin habilitado. O prefixo é o nome do plugin, e a skill fica `prefixo:pasta`.
struct PluginRoot {
    prefix: String,
    dir: PathBuf,
}

/// Os plugins de `enabledPlugins` que valem para este projeto: os de usuário e os de projeto cujo
/// registro é deste `cwd`. Para cada um, a pasta `skills/` e as que o manifesto declara.
fn plugin_roots(plugins_dir: &Path, cwd: Option<&Path>, enabled: &HashMap<String, bool>) -> Vec<PluginRoot> {
    let Some(registry) = read_json(&plugins_dir.join("installed_plugins.json")) else { return Vec::new() };
    let Some(plugins) = registry.get("plugins").and_then(Value::as_object) else { return Vec::new() };
    let mut keys: Vec<&String> = plugins.keys().collect();
    keys.sort();
    let mut roots = Vec::new();
    for key in keys {
        if enabled.get(key) != Some(&true) {
            continue;
        }
        let records = plugins.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let Some(install) = records.iter().filter(|record| record_applies(record, cwd)).find_map(|record| install_dir(record, cwd)) else {
            continue;
        };
        let manifest = read_json(&install.join(".claude-plugin").join("plugin.json"));
        let prefix = manifest
            .as_ref()
            .and_then(|m| m.get("name"))
            .and_then(Value::as_str)
            .or_else(|| key.split('@').next())
            .filter(|p| is_name_part(p))
            .map(str::to_string);
        let Some(prefix) = prefix else { continue };
        let mut dirs = vec![install.join("skills")];
        dirs.extend(declared_dirs(manifest.as_ref(), &install));
        roots.extend(dirs.into_iter().filter(|dir| dir.is_dir()).map(|dir| PluginRoot { prefix: prefix.clone(), dir }));
    }
    roots
}

/// Um registro de instalação vale para o usuário, ou para o projeto quando é deste `cwd`.
fn record_applies(record: &Value, cwd: Option<&Path>) -> bool {
    match record.get("scope").and_then(Value::as_str) {
        Some("user") | Some("managed") => true,
        Some("project") | Some("local") => match (record.get("projectPath").and_then(Value::as_str), cwd) {
            (Some(project), Some(cwd)) => same_dir(Path::new(project), cwd),
            _ => false,
        },
        _ => false,
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn install_dir(record: &Value, cwd: Option<&Path>) -> Option<PathBuf> {
    let path = Path::new(record.get("installPath")?.as_str()?);
    let dir = if path.is_absolute() { path.to_path_buf() } else { cwd?.join(path) };
    dir.is_dir().then_some(dir)
}

/// Pastas que o manifesto declara em `skills` (um caminho ou uma lista). Só caminhos relativos e
/// que não saem da instalação entram.
fn declared_dirs(manifest: Option<&Value>, install: &Path) -> Vec<PathBuf> {
    let paths: Vec<&str> = match manifest.and_then(|m| m.get("skills")) {
        Some(Value::String(path)) => vec![path.as_str()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    paths
        .into_iter()
        .filter(|rel| Path::new(rel).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)))
        .map(|rel| install.join(rel))
        .collect()
}

/// Acrescenta as skills de uma pasta (`<pasta>/<nome>/SKILL.md`). Nome já visto não entra de novo.
fn scan_root(
    root: &Path,
    prefix: Option<&str>,
    scope: AgentSkillScope,
    overrides: &HashMap<String, bool>,
    found: &mut BTreeMap<String, AgentSkill>,
) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut folders: Vec<PathBuf> = entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
    folders.sort();
    for folder in folders {
        let Some(folder_name) = folder.file_name().and_then(|n| n.to_str()) else { continue };
        let skill_md = folder.join("SKILL.md");
        if !is_name_part(folder_name) || !skill_md.is_file() {
            continue;
        }
        let frontmatter = read_frontmatter(&skill_md);
        // `user-invocable: false` é só para o agente chamar; o usuário não a vê no menu.
        if frontmatter.user_invocable == Some(false) {
            continue;
        }
        let name = match prefix {
            Some(prefix) => format!("{prefix}:{folder_name}"),
            None => folder_name.to_string(),
        };
        if !is_agent_command_name(&name) || found.contains_key(&name) {
            continue;
        }
        // Desligar nas configurações vale para as skills de usuário e de projeto, não para as de plugin.
        if prefix.is_none() && overrides.get(&name) == Some(&false) {
            continue;
        }
        found.insert(
            name.clone(),
            AgentSkill {
                name,
                description: frontmatter.description.map(|d| d.chars().take(DESCRIPTION_MAX).collect()),
                plugin: prefix.map(str::to_string),
                scope,
            },
        );
    }
}

/// As skills do Claude que valem para este projeto: as do usuário (`config_dir/skills`), as do projeto
/// (`cwd/.claude/skills`) e as dos plugins habilitados em `plugins_dir`. `managed_settings` é o arquivo
/// de política da máquina, quando existe, e tem a última palavra sobre `enabledPlugins` e `skillOverrides`.
pub fn scan_claude_skills(
    config_dir: &Path,
    plugins_dir: &Path,
    cwd: Option<&Path>,
    managed_settings: Option<&Path>,
) -> Vec<AgentSkill> {
    let mut settings_files = vec![config_dir.join("settings.json")];
    if let Some(cwd) = cwd {
        settings_files.push(cwd.join(".claude").join("settings.json"));
        settings_files.push(cwd.join(".claude").join("settings.local.json"));
    }
    settings_files.extend(managed_settings.map(Path::to_path_buf));

    let mut enabled_plugins: HashMap<String, bool> = HashMap::new();
    let mut overrides: HashMap<String, bool> = HashMap::new();
    for file in &settings_files {
        let Some(settings) = read_settings(file) else { continue };
        for (key, value) in settings.enabled_plugins {
            match value {
                Value::Bool(on) => {
                    enabled_plugins.insert(key, on);
                }
                // Formato estendido: substitui o valor de baixa prioridade sem ligar o plugin.
                _ => {
                    enabled_plugins.remove(&key);
                }
            }
        }
        for (name, value) in settings.skill_overrides {
            if let Some(mode) = value.as_str() {
                overrides.insert(name, mode != "off");
            }
        }
    }

    let mut found = BTreeMap::new();
    scan_root(&config_dir.join("skills"), None, AgentSkillScope::User, &overrides, &mut found);
    if let Some(cwd) = cwd {
        scan_root(&cwd.join(".claude").join("skills"), None, AgentSkillScope::Project, &overrides, &mut found);
    }
    for root in plugin_roots(plugins_dir, cwd, &enabled_plugins) {
        scan_root(&root.dir, Some(&root.prefix), AgentSkillScope::Plugin, &overrides, &mut found);
    }
    found.into_values().collect()
}

/// Caminho de configuração que o usuário escreveu (`~/…` ou relativo ao projeto, como o CLI resolve).
fn resolve_dir(value: &str, cwd: Option<&Path>) -> PathBuf {
    let home = dirs::home_dir();
    let expanded = match (value.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(value),
    };
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.map(|cwd| cwd.join(&expanded)).unwrap_or(expanded)
    }
}

/// `CLAUDE_CONFIG_DIR` quando está definido, senão `~/.claude`: a mesma pasta que o CLI usa.
fn claude_config_dir(cwd: Option<&Path>) -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(value) => Some(resolve_dir(&value, cwd)),
        None => dirs::home_dir().map(|home| home.join(".claude")),
    }
}

/// O arquivo de política da máquina (MDM), onde o Claude o procura em cada sistema.
fn managed_settings_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"))
    } else if cfg!(windows) {
        std::env::var_os("PROGRAMDATA").map(|dir| PathBuf::from(dir).join("ClaudeCode").join("managed-settings.json"))
    } else {
        Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
    }
}

/// Skills que o agente acha no disco, para o menu do `/`. Só o `claude-code` tem varredura: outro agente
/// recebe lista vazia. Roda numa thread de bloqueio, porque são leituras de disco.
#[tauri::command]
pub async fn agent_skills_scan(cwd: Option<String>, agent_id: String) -> Result<Vec<AgentSkill>, String> {
    if agent_id != "claude-code" {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AgentSkill>, String> {
        let cwd = cwd.map(PathBuf::from);
        let config_dir = claude_config_dir(cwd.as_deref()).ok_or("Não achei a pasta de configuração do Claude")?;
        let plugins_dir = match std::env::var("CLAUDE_CODE_PLUGIN_CACHE_DIR").ok().filter(|v| !v.trim().is_empty()) {
            Some(value) => resolve_dir(value.trim(), cwd.as_deref()),
            None => config_dir.join("plugins"),
        };
        Ok(scan_claude_skills(&config_dir, &plugins_dir, cwd.as_deref(), managed_settings_path().as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
