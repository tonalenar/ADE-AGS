//! Qué se puede lanzar ahora: agentes, modelos y cuentas, con el cupo de cada una.
//!
//! El registro de agentes es estático; esto no. Qué está instalado, qué modelos ofrece cada
//! TUI, qué cuentas tienen sesión y cuánto cupo les queda cambia de un momento a otro, así
//! que se sondea en vez de declararse. Es la foto que mira el ruteo antes de asignar, y la
//! que va a mirar la AI central cuando reparta.
//!
//! Lo caro de sondear (lanzar `opencode models` y `ollama list`) se guarda unos minutos. Lo
//! barato (cuentas, cupo, tareas corriendo) se lee de nuevo cada vez: son filas de la base y
//! un archivo por cuenta, y es justo lo que cambia entre dos tareas lanzadas seguidas.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agents::ModelSource;
use crate::database::DbConnection;

use super::agents::adapter_for;
use super::quota::{self, Quota};

/// Cuánto vale lo sondeado. Instalar un modelo es algo que se hace a mano y de vez en
/// cuando; volver a lanzar opencode cada vez que se abre el diálogo sería un segundo de
/// espera para enterarse de lo mismo.
const PROBE_TTL: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub agents: Vec<RosterAgent>,
}

impl Roster {
    pub fn agent(&self, id: &str) -> Option<&RosterAgent> {
        self.agents.iter().find(|a| a.agent_id == id)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterAgent {
    pub capabilities: crate::agents::Capabilities,
    pub agent_id: String,
    pub label: String,
    pub installed: bool,
    /// Se puede correr sin terminal: está instalada Y existe su adaptador.
    pub launchable: bool,
    /// Por qué no se puede lanzar. `None` si se puede.
    pub unavailable: Option<String>,
    pub models: Vec<RosterModel>,
    pub model_discovery: ModelDiscoveryState,
    /// Vacío = la TUI no maneja cuentas: corre con la que tenga el sistema.
    pub accounts: Vec<RosterAccount>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterModel {
    /// Lo que recibe el flag de modelo de la TUI.
    pub id: String,
    pub label: String,
    /// Puede usar herramientas. `Some(false)` = no puede trabajar como agente: leería el
    /// pedido y contestaría con texto, sin tocar un archivo. `None` = no se sabe.
    pub toolcall: Option<bool>,
    /// Corre en esta máquina.
    pub local: bool,
    /// USD por millón de tokens.
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
    pub context: Option<u64>,
    pub source: Option<String>,
    pub availability: ModelAvailability,
    pub reasoning_levels: Option<Vec<String>>,
    pub default_reasoning: Option<String>,
    /// Por qué no se puede usar aunque la TUI lo liste (un modelo de Ollama sin descargar).
    pub unavailable: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelAvailability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelDiscoveryState {
    Available,
    Unavailable,
    Unsupported,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterAccount {
    /// `None` = la cuenta del sistema.
    pub account_id: Option<String>,
    /// La clave con la que se guarda su cupo (ver `quota::account_key`).
    pub key: String,
    pub name: String,
    /// El mail, cuando la TUI lo expone.
    pub label: Option<String>,
    pub logged_in: bool,
    pub quota: Option<Quota>,
    /// Tareas de la flota que están usando esta cuenta ahora mismo.
    pub running: u32,
    pub models: Vec<RosterModel>,
    pub model_discovery: ModelDiscoveryState,
}

// ── Los parsers ─────────────────────────────────────────────────

/// Un modelo tal como lo lista `opencode models --verbose`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeModel {
    /// `proveedor/modelo`, lo que recibe `opencode run -m`.
    pub id: String,
    pub provider: String,
    pub name: Option<String>,
    pub toolcall: Option<bool>,
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
    pub context: Option<u64>,
}

/// Traduce la salida de `opencode models --verbose`.
///
/// Verificado contra opencode 1.18.30: una línea `proveedor/modelo` pegada al margen y
/// debajo un objeto JSON indentado, que abre con `{` y cierra con `}` también pegados al
/// margen. Sin `--verbose` salen solo las líneas de id, y eso también se acepta: da modelos
/// sin precio ni capacidades, que es mejor que ningún modelo.
pub fn parse_opencode_models(text: &str) -> Vec<OpencodeModel> {
    let mut models = Vec::new();
    let mut current: Option<(String, String)> = None;

    let flush = |current: &mut Option<(String, String)>, models: &mut Vec<OpencodeModel>| {
        if let Some((id, body)) = current.take() {
            models.push(opencode_model(&id, &body));
        }
    };

    for line in text.lines() {
        let is_header = !line.is_empty()
            && !line.starts_with(char::is_whitespace)
            && !line.starts_with('{')
            && !line.starts_with('}')
            && line.contains('/');
        if is_header {
            flush(&mut current, &mut models);
            current = Some((line.trim().to_string(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut current, &mut models);
    models
}

fn opencode_model(id: &str, body: &str) -> OpencodeModel {
    let provider = id.split('/').next().unwrap_or_default().to_string();
    let meta = serde_json::from_str::<serde_json::Value>(body).ok();
    let get = |ptr: &str| meta.as_ref().and_then(|m| m.pointer(ptr));

    // Un contexto de 0 es lo que opencode pone cuando no lo sabe (así vienen los de
    // Ollama): se informa como desconocido y no como un modelo sin contexto.
    let context = get("/limit/context")
        .and_then(|c| c.as_u64())
        .filter(|c| *c > 0);
    OpencodeModel {
        id: id.to_string(),
        provider,
        name: get("/name").and_then(|n| n.as_str()).map(str::to_string),
        toolcall: get("/capabilities/toolcall").and_then(|t| t.as_bool()),
        cost_in: get("/cost/input").and_then(|c| c.as_f64()),
        cost_out: get("/cost/output").and_then(|c| c.as_f64()),
        context,
    }
}

/// Los nombres de la tabla de `ollama list` (`NAME  ID  SIZE  MODIFIED`).
pub fn parse_ollama_list(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("NAME"))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Los modelos de opencode ya cruzados con lo que Ollama tiene de verdad.
///
/// opencode lista los modelos de Ollama que alguien escribió en su configuración, estén
/// descargados o no; en esta máquina lista `ollama/kimi-k2.6:cloud` y `ollama list` no lo
/// tiene. Ofrecerlo daría una tarea que falla al primer mensaje.
///
/// `ollama`: `None` = Ollama no está instalado o no respondió.
pub fn opencode_roster_models(
    models: &[OpencodeModel],
    ollama: Option<&[String]>,
) -> Vec<RosterModel> {
    let pulled: Option<HashSet<&str>> =
        ollama.map(|names| names.iter().map(String::as_str).collect());

    models
        .iter()
        .map(|m| {
            let is_ollama = m.provider == "ollama";
            let tag = m.id.split_once('/').map(|(_, t)| t).unwrap_or(&m.id);
            let unavailable = match (is_ollama, &pulled) {
                (false, _) => None,
                (true, None) => Some("Ollama no está instalado o no responde".to_string()),
                (true, Some(set)) if !set.contains(tag) => {
                    Some(format!("no está descargado en Ollama (ollama pull {tag})"))
                }
                (true, Some(_)) => None,
            };
            RosterModel {
                id: m.id.clone(),
                label: m.name.clone().unwrap_or_else(|| m.id.clone()),
                toolcall: m.toolcall,
                // Los `:cloud` de Ollama se sirven desde afuera aunque pasen por el
                // Ollama local: no son gratis ni privados.
                local: is_ollama && !tag.ends_with(":cloud"),
                cost_in: m.cost_in,
                cost_out: m.cost_out,
                context: m.context,
                source: Some("opencode".into()),
                availability: if is_ollama {
                    if unavailable.is_some() {
                        ModelAvailability::Unavailable
                    } else {
                        ModelAvailability::Available
                    }
                } else {
                    ModelAvailability::Unknown
                },
                reasoning_levels: None,
                default_reasoning: None,
                unavailable,
            }
        })
        .collect()
}

// ── El sondeo ───────────────────────────────────────────────────

/// Lo caro: qué hay instalado y qué modelos ofrece cada TUI.
#[derive(Clone)]
struct Probed {
    installed: HashMap<&'static str, bool>,
    catalogs: HashMap<(String, Option<String>), ModelCatalog>,
}

#[derive(Clone)]
struct ModelCatalog {
    models: Vec<RosterModel>,
    state: ModelDiscoveryState,
}

impl ModelCatalog {
    fn unavailable() -> Self {
        Self {
            models: Vec::new(),
            state: ModelDiscoveryState::Unavailable,
        }
    }

    fn unsupported() -> Self {
        Self {
            models: Vec::new(),
            state: ModelDiscoveryState::Unsupported,
        }
    }
}

lazy_static::lazy_static! {
    static ref MODEL_CACHE: Mutex<ModelCache> = Mutex::new(ModelCache::default());
}

type CatalogKey = (String, Option<String>);

#[derive(Default)]
struct ModelCache {
    entries: HashMap<CatalogKey, (Instant, ModelCatalog)>,
}

impl ModelCache {
    fn get(&self, key: &CatalogKey, now: Instant) -> Option<ModelCatalog> {
        self.entries.get(key)
            .filter(|(at, _)| now.saturating_duration_since(*at) < PROBE_TTL)
            .map(|(_, catalog)| catalog.clone())
    }

    fn insert(&mut self, key: CatalogKey, catalog: ModelCatalog) {
        self.entries.insert(key, (Instant::now(), catalog));
    }

    fn invalidate(&mut self, key: &CatalogKey) {
        self.entries.remove(key);
    }

    fn clear(&mut self) { self.entries.clear(); }
}

pub fn refresh_models(db: &DbConnection, agent_id: &str, account_id: Option<&str>) -> Result<Roster, String> {
    let adapter = crate::agents::adapter_for(agent_id).ok_or("provider is not registered")?;
    if matches!(adapter.def().models, ModelSource::Unknown) { return Err("provider does not support model discovery".into()); }
    if let Some(id) = account_id {
        let conn = db.lock().map_err(|error| error.to_string())?;
        if !crate::accounts::list_accounts(&conn)?.iter().any(|account| account.id == id && account.agent_id == agent_id) {
            return Err("account does not belong to this provider or is unavailable".into());
        }
    }
    MODEL_CACHE.lock().unwrap_or_else(|error| error.into_inner())
        .invalidate(&(agent_id.to_string(), account_id.map(str::to_string)));
    snapshot(db, false)
}

pub(super) fn validate_effort(
    roster: &Roster, agent_id: &str, account_id: Option<&str>, model: Option<&str>, effort: Option<&str>,
) -> Result<(), String> {
    let Some(effort) = effort else { return Ok(()); };
    let agent = roster.agent(agent_id).ok_or("Reasoning effort cannot be verified for this provider")?;
    let models = match account_id {
        Some(id) => &agent.accounts.iter().find(|account| account.account_id.as_deref() == Some(id))
            .ok_or("Reasoning effort cannot be verified for this account")?.models,
        None => &agent.models,
    };
    let supported = models.iter().find(|entry| Some(entry.id.as_str()) == model)
        .and_then(|entry| entry.reasoning_levels.as_ref())
        .is_some_and(|levels| levels.iter().any(|level| level == effort));
    if supported && matches!(effort, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
        Ok(())
    } else {
        Err("Reasoning effort is not supported by this provider/account/model. Select Automatic or a supported level.".into())
    }
}

fn discover_catalog(
    def: &crate::agents::AgentDef,
    env: &HashMap<String, String>,
    installed: bool,
) -> ModelCatalog {
    if matches!(def.models, ModelSource::GeminiCatalogue) {
        return ModelCatalog {
            models: gemini_catalogue(),
            state: ModelDiscoveryState::Available,
        };
    }
    if !installed {
        return ModelCatalog::unavailable();
    }
    let result = match def.models {
        ModelSource::Aliases(aliases) => Ok(aliases
            .iter()
            .map(|alias| RosterModel {
                id: alias.id.to_string(),
                label: alias.label.to_string(),
                toolcall: Some(true),
                local: false,
                cost_in: Some(alias.cost_in),
                cost_out: Some(alias.cost_out),
                context: Some(alias.context),
                source: Some("adapter_alias".into()),
                availability: ModelAvailability::Unknown,
                reasoning_levels: None,
                default_reasoning: None,
                unavailable: None,
            })
            .collect()),
        ModelSource::CodexAppServer => super::model_discovery::discover_codex(def.command, env),
        ModelSource::ClaudeCode => super::model_discovery::discover_claude(def.command, env),
        ModelSource::OpencodeModels => {
            let Some(output) = run_with_env(def.command, &["models", "--verbose"], env) else {
                return ModelCatalog::unavailable();
            };
            let listed = parse_opencode_models(&output);
            let ollama = run("ollama", &["list"]).map(|out| parse_ollama_list(&out));
            Ok(opencode_roster_models(&listed, ollama.as_deref()))
        }
        ModelSource::AntigravityModels => {
            let Some(output) = run_with_env(def.command, &["models"], env) else {
                return ModelCatalog::unavailable();
            };
            let models = parse_antigravity_models(&output);
            if models.is_empty() { return ModelCatalog::unavailable(); }
            Ok(models)
        }
        ModelSource::GeminiCatalogue => unreachable!("handled before the installation check"),
        ModelSource::Unknown => return ModelCatalog::unsupported(),
    };

    match result {
        Ok(models) => ModelCatalog {
            models,
            state: ModelDiscoveryState::Available,
        },
        Err(_) => ModelCatalog::unavailable(),
    }
}

fn catalogue_model(id: &str, label: &str, source: &str, availability: ModelAvailability) -> RosterModel {
    RosterModel {
        id: id.into(), label: label.into(), toolcall: None, local: false,
        cost_in: None, cost_out: None, context: None, source: Some(source.into()),
        availability, reasoning_levels: None, default_reasoning: None, unavailable: None,
    }
}

fn parse_antigravity_models(output: &str) -> Vec<RosterModel> {
    let mut seen = HashSet::new();
    output.lines().filter_map(|line| {
        let (id, label) = line.split_once('\t')?;
        let (id, label) = (id.trim(), label.trim());
        if id.is_empty() || label.is_empty()
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
            || !seen.insert(id.to_owned()) { return None; }
        let mut model = catalogue_model(id, label, "native", ModelAvailability::Available);
        // Native IDs already pin effort. agy rejects a conflicting --effort and
        // rejects explicit effort entirely for models without an effort suffix.
        if let Some((_, effort)) = id.rsplit_once('-')
            && matches!(effort, "low" | "medium" | "high" | "max")
        {
            model.reasoning_levels = Some(vec![effort.into()]);
            model.default_reasoning = Some(effort.into());
        }
        Some(model)
    }).collect()
}

fn gemini_catalogue() -> Vec<RosterModel> {
    // https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts
    // These are provider IDs/aliases, not proof of access by the current account.
    [
        ("auto", "Gemini Auto"), ("pro", "Gemini Pro"),
        ("flash", "Gemini Flash"), ("flash-lite", "Gemini Flash Lite"),
        ("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ("gemini-3.5-flash", "Gemini 3.5 Flash"),
        ("gemini-3.8-flash", "Gemini 3.8 Flash"),
        ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
        ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
        ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
        ("gemini-3-pro-preview", "Gemini 3 Pro Preview"),
        ("gemini-3-flash-preview", "Gemini 3 Flash Preview"),
    ].into_iter().map(|(id, label)| catalogue_model(id, label, "provider_catalog", ModelAvailability::Unknown)).collect()
}

fn probed(refresh: bool, accounts: &[crate::accounts::AgentAccount]) -> Probed {
    if refresh {
        MODEL_CACHE.lock().unwrap_or_else(|error| error.into_inner()).clear();
    }
    let mut installed = HashMap::new();
    let mut catalogs = HashMap::new();

    for adapter in crate::agents::adapters()
        .iter()
        .copied()
        .filter(|a| a.def().id != crate::agents::SHELL_AGENT_ID)
    {
        let def = adapter.def();
        let present = crate::agents::command_exists(def.command);
        installed.insert(def.id, present);

        let mut scopes: Vec<(Option<String>, HashMap<String, String>)> =
            vec![(None, HashMap::new())];
        if def.profile.is_some() {
            scopes.extend(
                accounts
                    .iter()
                    .filter(|account| account.agent_id == def.id)
                    .map(|account| {
                        (
                            Some(account.id.clone()),
                            adapter.account_env(&account.dir).unwrap_or_default(),
                        )
                    }),
            );
        }

        for (account_id, env) in scopes {
            let key = (def.id.to_string(), account_id.clone());
            let cached = MODEL_CACHE.lock().unwrap_or_else(|error| error.into_inner())
                .get(&key, Instant::now());
            let catalog = cached.unwrap_or_else(|| {
                    let fresh = discover_catalog(def, &env, present);
                    MODEL_CACHE.lock().unwrap_or_else(|error| error.into_inner()).insert(key.clone(), fresh.clone());
                    fresh
                });
            catalogs.insert(key, catalog);
        }
    }
    Probed {
        installed,
        catalogs,
    }
}

/// La salida de un comando, o `None` si no está, falla o tarda demasiado.
fn run(program: &str, args: &[&str]) -> Option<String> {
    let out =
        crate::util::output_with_timeout(crate::util::program(program).args(args), PROBE_TIMEOUT)
            .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Un sondeo con el entorno de una cuenta: sin las variables que le ganarían a su login (ver
/// `agents::overriding_env`), o los modelos serían los de otra credencial.
pub(super) fn account_command(program: &str, args: &[&str], env: &HashMap<String, String>) -> std::process::Command {
    let mut command = crate::util::program(program);
    command.args(args);
    crate::agents::apply_account_env(&mut command, env);
    command
}

fn run_with_env(program: &str, args: &[&str], env: &HashMap<String, String>) -> Option<String> {
    let out = crate::util::output_with_timeout(
        &mut account_command(program, args, env),
        PROBE_TIMEOUT,
    )
    .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Saved IDs are account-scoped history, not proof of CLI support or entitlement.
/// Read them on every snapshot so saving a manual model never requires a cache reset.
fn include_claude_history(
    conn: &rusqlite::Connection,
    agent_id: &str,
    account_id: Option<&str>,
    catalog: &mut Vec<RosterModel>,
) -> Result<(), String> {
    let mut stmt = conn.prepare(
        "SELECT model FROM tasks WHERE agent_id = ?1 AND account_id IS ?2
         UNION SELECT lead_model FROM missions WHERE lead_agent_id = ?1 AND lead_account_id IS ?2
         UNION SELECT lead_model FROM squads WHERE lead_agent_id = ?1 AND lead_account_id IS ?2
         UNION SELECT model FROM squad_members WHERE agent_id = ?1 AND account_id IS ?2
         UNION SELECT model FROM run_squad_members WHERE agent_id = ?1 AND account_id IS ?2"
    ).map_err(|error| error.to_string())?;
    let rows = stmt.query_map(rusqlite::params![agent_id, account_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| error.to_string())?;
    let mut historical = HashMap::new();
    for row in rows {
        if let Some(id) = row.map_err(|error| error.to_string())? {
            super::model_discovery::insert_claude_model(&mut historical, id.clone(), id, "ade_history", 0);
        }
    }
    // Tiers have no account field; show only actually saved entries on the system catalog.
    if account_id.is_none() {
        use rusqlite::OptionalExtension;
        let saved: Option<String> = conn.query_row(
            "SELECT value FROM settings WHERE key = 'runs.routing.tiers'", [], |row| row.get(0)
        ).optional().map_err(|error| error.to_string())?;
        if let Some(tiers) = saved.and_then(|raw| serde_json::from_str::<super::routing::Tiers>(&raw).ok()) {
            for entry in tiers.trivial.into_iter().chain(tiers.standard).chain(tiers.hard) {
                if entry.agent_id == agent_id {
                    super::model_discovery::insert_claude_model(&mut historical, entry.model.clone(), entry.model, "ade_history", 0);
                }
            }
        }
    }
    let known: HashSet<_> = catalog.iter().map(|model| model.id.clone()).collect();
    let mut additions: Vec<_> = historical.into_values().map(|(_, model)| model)
        .filter(|model| !known.contains(&model.id)).collect();
    additions.sort_by(|left, right| left.id.cmp(&right.id));
    catalog.extend(additions);
    Ok(())
}

/// La foto de ahora. Bloquea: la primera vez (o con `refresh`) lanza procesos.
pub fn snapshot(db: &DbConnection, refresh: bool) -> Result<Roster, String> {
    let (created, running) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        (
            crate::accounts::list_accounts(&conn)?,
            running_by_account(&conn)?,
        )
    };
    let probed = probed(refresh, &created);
    let conn = db.lock().map_err(|e| e.to_string())?;

    let mut agents: Vec<RosterAgent> = crate::agents::adapters()
        .iter()
        .copied()
        .filter(|adapter| adapter.def().id != crate::agents::SHELL_AGENT_ID)
        .map(|adapter| {
            let def = adapter.def();
            let installed = probed.installed.get(def.id).copied().unwrap_or(false);
            let has_adapter = adapter_for(def.id).is_some();
            let unavailable = if !installed {
                Some(format!("{} no está instalado", def.label))
            } else if !has_adapter {
                Some(format!(
                    "todavía no se sabe correr {} sin terminal",
                    def.label
                ))
            } else {
                None
            };

            let mut accounts = Vec::new();
            if adapter.capabilities().accounts {
                let system = crate::accounts::system_account(def.id);
                let rows = created.iter().filter(|a| a.agent_id == def.id);
                for (account_id, account) in system
                    .iter()
                    .map(|a| (None, a))
                    .chain(rows.map(|a| (Some(a.id.clone()), a)))
                {
                    let key = quota::account_key(def.id, account_id.as_deref());
                    let catalog = probed
                        .catalogs
                        .get(&(def.id.to_string(), account_id.clone()))
                        .cloned()
                        .unwrap_or_else(ModelCatalog::unsupported);
                    accounts.push(RosterAccount {
                        quota: quota::load(&conn, &key),
                        running: running
                            .get(&(def.id.to_string(), account_id.clone()))
                            .copied()
                            .unwrap_or(0),
                        account_id,
                        key,
                        name: account.name.clone(),
                        label: account.label.clone(),
                        logged_in: account.logged_in,
                        models: catalog.models,
                        model_discovery: catalog.state,
                    });
                }
            }

            let catalog = probed
                .catalogs
                .get(&(def.id.to_string(), None))
                .cloned()
                .unwrap_or_else(ModelCatalog::unsupported);

            RosterAgent {
                capabilities: adapter.capabilities(),
                agent_id: def.id.to_string(),
                label: def.label.to_string(),
                installed,
                launchable: unavailable.is_none(),
                unavailable,
                models: catalog.models,
                model_discovery: catalog.state,
                accounts,
            }
        })
        .collect();

    for agent in &mut agents {
        if crate::agents::agent_def(&agent.agent_id).is_some_and(|def| matches!(def.models, ModelSource::ClaudeCode)) {
            include_claude_history(&conn, &agent.agent_id, None, &mut agent.models)?;
            for account in &mut agent.accounts {
                include_claude_history(&conn, &agent.agent_id, account.account_id.as_deref(), &mut account.models)?;
            }
        }
    }

    Ok(Roster { agents })
}

/// Cuántas tareas vivas usa cada (agente, cuenta).
fn running_by_account(
    conn: &rusqlite::Connection,
) -> Result<HashMap<(String, Option<String>), u32>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT agent_id, account_id, COUNT(*) FROM tasks
             WHERE status IN ('ready', 'running') GROUP BY agent_id, account_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?),
                row.get::<_, u32>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod model_cache_tests {
    use super::*;
    #[test]
    fn antigravity_catalogue_uses_native_ids_without_inventing_metadata() {
        let models = parse_antigravity_models("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngemini-3.8-flash-high\tDuplicate\ninvalid id\tInvalid\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-3.8-flash-high");
        assert_eq!(models[1].id, "claude-sonnet-4-6");
        assert!(models.iter().all(|m| m.source.as_deref() == Some("native") && m.cost_in.is_none()));
        assert_eq!(models[0].reasoning_levels.as_deref(), Some(["high".to_string()].as_slice()));
        assert_eq!(models[0].default_reasoning.as_deref(), Some("high"));
        assert!(models[1].reasoning_levels.is_none());
        assert!(parse_antigravity_models("not a model catalogue").is_empty());
    }
    #[test]
    fn gemini_reference_catalogue_is_visible_without_claiming_account_access() {
        let def = crate::agents::agent_def("gemini-cli").unwrap();
        let catalog = discover_catalog(def, &HashMap::new(), false);
        assert!(!catalog.models.is_empty());
        assert!(catalog.models.iter().any(|m| m.id == "gemini-3.8-flash"));
        assert!(catalog.models.iter().all(|m| m.availability == ModelAvailability::Unknown && m.source.as_deref() == Some("provider_catalog")));
        let agy = crate::agents::agent_def("antigravity").unwrap();
        assert!(discover_catalog(agy, &HashMap::new(), false).models.is_empty());
    }
    #[test]
    fn claude_history_keeps_saved_ids_unverified_and_account_scoped() {
        let conn = crate::database::test_db();
        conn.execute("INSERT INTO squads (id, name, lead_agent_id, lead_model, lead_account_id, created_at, updated_at) VALUES ('a','A','claude-code','custom/old-a','account-a',0,0), ('b','B','claude-code','custom/old-b','account-b',0,0), ('s','System','claude-code','old-system',NULL,0,0)", []).unwrap();
        conn.execute("INSERT INTO settings (key,value) VALUES ('runs.routing.tiers', ?1)",
            [r#"{"trivial":[{"agentId":"claude-code","model":"haiku"}],"standard":[],"hard":[]}"#]).unwrap();
        let mut a = vec![];
        include_claude_history(&conn, "claude-code", Some("account-a"), &mut a).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].id, "custom/old-a");
        assert_eq!(a[0].source.as_deref(), Some("ade_history"));
        assert_eq!(a[0].availability, ModelAvailability::Unknown);
        let mut b = vec![];
        include_claude_history(&conn, "claude-code", Some("account-b"), &mut b).unwrap();
        assert_eq!(b[0].id, "custom/old-b");
        let mut system = vec![];
        include_claude_history(&conn, "claude-code", None, &mut system).unwrap();
        assert_eq!(system.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["haiku", "old-system"]);
        include_claude_history(&conn, "claude-code", Some("account-a"), &mut a).unwrap();
        assert_eq!(a.len(), 1);
        let mut other = vec![];
        include_claude_history(&conn, "other-provider", None, &mut other).unwrap();
        assert!(other.is_empty());
    }
    #[test]
    fn cache_isolates_accounts_and_providers_expires_and_refreshes_one_key() {
        let mut cache = ModelCache::default();
        let a = ("codex".into(), Some("a".into()));
        let b = ("codex".into(), Some("b".into()));
        let other = ("claude-code".into(), Some("a".into()));
        assert!(cache.get(&a, Instant::now()).is_none());
        cache.insert(a.clone(), ModelCatalog::unavailable());
        cache.insert(b.clone(), ModelCatalog::unsupported());
        assert_eq!(cache.get(&a, Instant::now()).unwrap().state, ModelDiscoveryState::Unavailable);
        assert_eq!(cache.get(&b, Instant::now()).unwrap().state, ModelDiscoveryState::Unsupported);
        assert!(cache.get(&other, Instant::now()).is_none());
        assert!(cache.get(&a, Instant::now() + PROBE_TTL).is_none());
        cache.invalidate(&a);
        assert!(cache.get(&a, Instant::now()).is_none());
        assert!(cache.get(&b, Instant::now()).is_some());
        cache.clear(); assert!(cache.get(&b, Instant::now()).is_none());
    }
    #[test]
    fn discovery_profile_environment_matches_runtime_adapter() {
        for (provider, variable) in [("codex", "CODEX_HOME"), ("claude-code", "CLAUDE_CONFIG_DIR")] {
            let adapter = crate::agents::adapter_for(provider).unwrap();
            let a = adapter.account_env("profile-a").unwrap();
            let b = adapter.account_env("profile-b").unwrap();
            assert_eq!(a[variable], "profile-a"); assert_eq!(b[variable], "profile-b");
            assert_ne!(a, b);
        }
    }
}
