//! Skills que os providers acham no disco, para o menu do `/` antes de anunciarem a lista.
//!
//! Só metadados: o nome (a pasta, ou `plugin:pasta`) e a `description` do frontmatter do SKILL.md,
//! mais as configurações que decidem se a skill entra (`enabledPlugins`, `skillOverrides`). Nada aqui
//! executa código de skill, e o corpo do arquivo não é lido. Quando o agente informa a própria lista,
//! ela manda no menu; esta varredura só cobre o intervalo até lá.
//!
//! A precedência de cada provider é mantida por scanner; o primeiro nome encontrado vence.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Quanto do SKILL.md é lido. O frontmatter fica no começo; o corpo nunca entra.
const FRONTMATTER_READ_MAX: u64 = 16 * 1024;
const NAME_MAX: usize = 80;
const DESCRIPTION_MAX: usize = 500;
pub(super) const PROVIDER_SCAN_MAX_ENTRIES: usize = 10_000;
pub(super) const PROVIDER_SCAN_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROVIDER_SKILL_MAX_BYTES: u64 = 1024 * 1024;
const PROVIDER_SCAN_MAX_DEPTH: usize = 10;

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
    pub display_name: Option<String>,
    pub user_invocation_only: Option<bool>,
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
    display_name: Option<String>,
    user_invocation_only: Option<bool>,
    cli_visible: Option<bool>,
    name: Option<String>,
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
            user_invocable: map.get("user-invocable").or_else(|| map.get("userInvocable")).and_then(yaml_bool),
            display_name: map.get("displayName").or_else(|| map.get("display-name")).and_then(yaml_text),
            user_invocation_only: map.get("userInvocationOnly").or_else(|| map.get("user-invocation-only")).and_then(yaml_bool),
            cli_visible: map.get("cliVisible").or_else(|| map.get("cli-visible")).and_then(yaml_bool),
            name: map.get("name").and_then(yaml_text),
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
            "user-invocable" | "userInvocable" => frontmatter.user_invocable = bool_of_text(&value),
            "displayName" | "display-name" => frontmatter.display_name = non_empty(value.trim()),
            "userInvocationOnly" | "user-invocation-only" => frontmatter.user_invocation_only = bool_of_text(&value),
            "cliVisible" | "cli-visible" => frontmatter.cli_visible = bool_of_text(&value),
            "name" => frontmatter.name = non_empty(value.trim()),
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
                display_name: frontmatter.display_name,
                user_invocation_only: frontmatter.user_invocation_only,
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

/// O que a varredura lê do ambiente. A conta da aba (`account`) manda nas variáveis que ela define; o resto
/// vem do processo da ADE (`process`), que é o ambiente que o agente herda. Sem conta, vale só o processo.
pub struct SkillEnv<'a> {
    pub account: Option<&'a HashMap<String, String>>,
    pub process: &'a dyn Fn(&str) -> Option<String>,
    pub cwd: Option<&'a Path>,
    pub managed_settings: Option<&'a Path>,
}

impl SkillEnv<'_> {
    /// Valor de uma variável: a conta da aba primeiro, depois o processo da ADE. Vazio conta como ausente.
    fn var(&self, name: &str) -> Option<String> {
        self.account
            .and_then(|vars| vars.get(name).cloned())
            .or_else(|| (self.process)(name))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// O `HOME` que o agente vê: o da conta, se ela trouxer um; senão o do usuário.
    fn home(&self) -> Option<PathBuf> {
        self.var("HOME").map(PathBuf::from).or_else(dirs::home_dir)
    }
}

/// Skills que um agente acha no disco para o menu do `/`. Só metadados.
pub fn scan_agent_skills(agent_id: &str, env: &SkillEnv<'_>) -> Vec<AgentSkill> {
    match agent_id {
        "claude-code" => claude_skills(env),
        "codex" => codex_skills(env),
        "cursor" => cursor_skills(env),
        "antigravity" => antigravity_skills(env),
        _ => Vec::new(),
    }
}

#[derive(Default)]
pub(super) struct ProviderScanBudget {
    pub(super) entries: usize,
    pub(super) bytes: u64,
}

/// Varredura limitada de uma árvore de skills: só abre SKILL.md e lê até o frontmatter.
pub(super) fn scan_provider_root(
    root: &Path,
    scope: AgentSkillScope,
    use_frontmatter_name: bool,
    found: &mut BTreeMap<String, AgentSkill>,
    budget: &mut ProviderScanBudget,
) {
    fn visit(
        dir: &Path,
        root: &Path,
        scope: AgentSkillScope,
        use_frontmatter_name: bool,
        depth: usize,
        found: &mut BTreeMap<String, AgentSkill>,
        budget: &mut ProviderScanBudget,
    ) {
        if depth > PROVIDER_SCAN_MAX_DEPTH || budget.entries >= PROVIDER_SCAN_MAX_ENTRIES {
            return;
        }
        let mut entries: Vec<_> = match fs::read_dir(dir) {
            Ok(entries) => entries.filter_map(Result::ok).collect(),
            Err(_) => return,
        };
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if budget.entries >= PROVIDER_SCAN_MAX_ENTRIES {
                break;
            }
            budget.entries += 1;
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let is_symlink = kind.is_symlink();
            if !kind.is_dir() && !(is_symlink && fs::metadata(&path).is_ok_and(|meta| meta.is_dir())) {
                continue;
            }
            let skill_path = path.join("SKILL.md");
            if let Ok(meta) = fs::metadata(&skill_path)
                && meta.is_file()
            {
                let remaining = PROVIDER_SCAN_MAX_BYTES.saturating_sub(budget.bytes);
                if meta.len() > PROVIDER_SKILL_MAX_BYTES || meta.len() > remaining {
                    continue;
                }
                budget.bytes = budget.bytes.saturating_add(meta.len());
                let frontmatter = read_frontmatter(&skill_path);
                if frontmatter.user_invocable == Some(false)
                    || frontmatter.cli_visible == Some(false)
                {
                    continue;
                }
                let folder_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                let name = if use_frontmatter_name {
                    frontmatter.name.as_deref().unwrap_or(folder_name)
                } else {
                    folder_name
                }
                .trim();
                if !is_agent_command_name(name) || found.contains_key(name) {
                    continue;
                }
                found.insert(
                    name.to_string(),
                    AgentSkill {
                        name: name.to_string(),
                        description: frontmatter
                            .description
                            .map(|value| value.chars().take(DESCRIPTION_MAX).collect()),
                        display_name: frontmatter.display_name.or_else(|| {
                            (!use_frontmatter_name)
                                .then_some(frontmatter.name)
                                .flatten()
                        }),
                        user_invocation_only: frontmatter.user_invocation_only,
                        plugin: None,
                        scope,
                    },
                );
                // A skill directory is a leaf, matching the provider loaders.
                continue;
            }
            if !is_symlink
                && let Ok(canonical_root) = root.canonicalize()
                && let Ok(canonical_path) = path.canonicalize()
                && canonical_path.starts_with(canonical_root)
            {
                visit(
                    &path,
                    root,
                    scope,
                    use_frontmatter_name,
                    depth + 1,
                    found,
                    budget,
                );
            }
        }
    }
    visit(root, root, scope, use_frontmatter_name, 0, found, budget);
}

/// Cursor: projeto antes da conta, em `.cursor/skills` e `.agents/skills`.
fn cursor_skills(env: &SkillEnv<'_>) -> Vec<AgentSkill> {
    let mut found = BTreeMap::new();
    let mut budget = ProviderScanBudget::default();
    for dir in env.cwd.map(repo_chain).unwrap_or_default() {
        for root in [dir.join(".cursor/skills"), dir.join(".agents/skills")] {
            scan_provider_root(
                &root,
                AgentSkillScope::Project,
                false,
                &mut found,
                &mut budget,
            );
        }
    }
    if let Some(home) = env.home() {
        for root in [home.join(".cursor/skills"), home.join(".agents/skills")] {
            scan_provider_root(&root, AgentSkillScope::User, false, &mut found, &mut budget);
        }
    }
    found.into_values().collect()
}

/// Antigravity: skills do GEMINI_HOME (ou HOME/.gemini) e `.agents/skills` só do projeto.
fn antigravity_skills(env: &SkillEnv<'_>) -> Vec<AgentSkill> {
    let home = env.home();
    let account_home = env.account.and_then(|account| account.get("HOME")).map(PathBuf::from);
    let gemini_home = env.account.and_then(|account| account.get("GEMINI_HOME")).map(|value| resolve_dir(value, env.cwd))
        .or_else(|| account_home.as_ref().map(|home| home.join(".gemini")))
        .or_else(|| env.var("GEMINI_HOME").map(|value| resolve_dir(&value, env.cwd)))
        .or_else(|| home.as_ref().map(|home| home.join(".gemini")));
    let mut found = BTreeMap::new();
    let mut budget = ProviderScanBudget::default();
    if let Some(gemini_home) = gemini_home.as_ref() {
        scan_provider_root(
            &gemini_home.join("config/skills"),
            AgentSkillScope::User,
            true,
            &mut found,
            &mut budget,
        );
    }
    if let Some(cwd) = env.cwd {
        for dir in repo_chain(cwd) {
            scan_provider_root(
                &dir.join(".agents/skills"),
                AgentSkillScope::Project,
                true,
                &mut found,
                &mut budget,
            );
        }
    }
    if let Some(gemini_home) = gemini_home.as_ref() {
        scan_provider_root(
            &gemini_home.join("antigravity-cli/skills"),
            AgentSkillScope::User,
            true,
            &mut found,
            &mut budget,
        );
    }
    found.into_values().collect()
}

/// Claude: `CLAUDE_CONFIG_DIR` (da conta, se houver) ou `~/.claude`, mais os plugins do cache.
fn claude_skills(env: &SkillEnv<'_>) -> Vec<AgentSkill> {
    let config_dir = env.var("CLAUDE_CONFIG_DIR").map(|v| resolve_dir(&v, env.cwd)).or_else(|| env.home().map(|h| h.join(".claude")));
    let Some(config_dir) = config_dir else { return Vec::new() };
    let plugins_dir = env
        .var("CLAUDE_CODE_PLUGIN_CACHE_DIR")
        .map(|v| resolve_dir(&v, env.cwd))
        .unwrap_or_else(|| config_dir.join("plugins"));
    scan_claude_skills(&config_dir, &plugins_dir, env.cwd, env.managed_settings)
}

/// Codex: as `.agents/skills` do cwd até a raiz do repositório (a mais próxima primeiro), depois a do usuário
/// (`~/.agents/skills`) e a de `CODEX_HOME/skills`. O primeiro nome vence, como no Codex.
fn codex_skills(env: &SkillEnv<'_>) -> Vec<AgentSkill> {
    let overrides = HashMap::new();
    let mut found = BTreeMap::new();
    for dir in env.cwd.map(repo_chain).unwrap_or_default() {
        scan_root(&dir.join(".agents").join("skills"), None, AgentSkillScope::Project, &overrides, &mut found);
    }
    if let Some(home) = env.home() {
        scan_root(&home.join(".agents").join("skills"), None, AgentSkillScope::User, &overrides, &mut found);
    }
    let codex_home = env.var("CODEX_HOME").map(|v| resolve_dir(&v, env.cwd)).or_else(|| env.home().map(|h| h.join(".codex")));
    if let Some(codex_home) = codex_home {
        scan_root(&codex_home.join("skills"), None, AgentSkillScope::User, &overrides, &mut found);
    }
    found.into_values().collect()
}

/// O cwd e as pastas acima dele até a raiz do repositório (a que tem `.git`). Fora de um repositório, só o
/// cwd: o Codex não procura além da raiz do projeto.
fn repo_chain(cwd: &Path) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    for dir in cwd.ancestors() {
        chain.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            return chain;
        }
    }
    vec![cwd.to_path_buf()]
}

/// O ambiente da conta da aba (`chat_thread.account_id` → `agent_accounts`), só com o diretório do provedor.
/// Não usa `accounts::env_for_account`: ele também lê o keyring das contas com chave, e a varredura não precisa
/// de segredo. `None` quando a aba não tem conta, a conta é de outro provedor ou não existe mais.
pub fn account_env_for_thread(conn: &Connection, thread_id: &str, agent_id: &str) -> Option<HashMap<String, String>> {
    let account_id: Option<String> = conn.query_row("SELECT account_id FROM chat_thread WHERE id = ?1", [thread_id], |row| row.get(0)).ok()?;
    let (account_agent, dir): (String, String) = conn
        .query_row("SELECT agent_id, dir FROM agent_accounts WHERE id = ?1", [account_id?], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()?;
    if account_agent != agent_id {
        return None;
    }
    // Antigravity e Cursor usam HOME para suas skills globais; só passamos o diretório, nunca o keyring.
    if matches!(agent_id, "antigravity" | "cursor") {
        return Some(HashMap::from([("HOME".to_string(), dir)]));
    }
    crate::agents::adapter_for(agent_id)?.account_env(&dir)
}

/// Skills que o agente acha no disco, para o menu do `/`. `thread_id` diz a conta da aba: a varredura lê o
/// diretório dela, e não o do processo da ADE. Roda numa thread de bloqueio, porque são leituras de disco.
#[tauri::command]
pub async fn agent_skills_scan(
    db: tauri::State<'_, crate::database::DbConnection>,
    cwd: Option<String>,
    agent_id: String,
    thread_id: Option<String>,
) -> Result<Vec<AgentSkill>, String> {
    let account = match thread_id.as_deref() {
        Some(id) => {
            let conn = db.lock().map_err(|_| "Não foi possível acessar o banco local.".to_string())?;
            account_env_for_thread(&conn, id, &agent_id)
        }
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AgentSkill>, String> {
        let cwd = cwd.map(PathBuf::from);
        let process = |name: &str| std::env::var(name).ok();
        let managed = managed_settings_path();
        let env = SkillEnv {
            account: account.as_ref(),
            process: &process,
            cwd: cwd.as_deref(),
            managed_settings: managed.as_deref(),
        };
        Ok(scan_agent_skills(&agent_id, &env))
    })
    .await
    .map_err(|e| e.to_string())?
}
