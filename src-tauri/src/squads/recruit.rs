//! Qué LLM recibe un subagente recrutado con `ags peer recruit`.
//!
//! El Squad de la misión en ejecución puede traer un *subagente padrão* (ver
//! [`SubagentDefault`]). Reglas, en orden:
//!
//! 1. `--model` o `--effort` explícitos siempre ganan, y entonces el padrão no se mezcla
//!    (un esfuerzo pensado para otro modelo no se hereda por accidente).
//! 2. Sin ninguno de los dos, y si el agente recrutado es el del padrão, se usa el padrão
//!    entero: modelo, esfuerzo y Fast.
//! 3. Sin `--agent`, el agente del padrão es el que se recluta. Con Automático (o sin Squad)
//!    `--agent` sigue siendo obligatorio y el comportamiento es el de siempre.
//! 4. Un `--agent` distinto del padrão no hereda nada: el modelo de un agente no vale en otro.

use rusqlite::{Connection, OptionalExtension};

use super::types::SubagentDefault;

/// De dónde salieron el modelo/esfuerzo con que se abre el subagente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecruitSource {
    /// Lo pidió quien recrutó (`--model` / `--effort`).
    Explicit,
    /// El subagente padrão del Squad.
    SquadDefault,
    /// Nada pedido ni configurado: el que traiga la TUI.
    ProviderDefault,
}

impl RecruitSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::SquadDefault => "squad_default",
            Self::ProviderDefault => "provider_default",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecruitLlm {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub source: RecruitSource,
}

fn present(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Resuelve agente, modelo, esfuerzo y Fast del subagente. Pura: no toca la base ni la app.
pub fn resolve_recruit_llm(
    agent: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    fast_flag: bool,
    default: Option<&SubagentDefault>,
) -> Result<RecruitLlm, String> {
    let model = present(model);
    let effort = present(effort);
    let agent = match (present(agent), default) {
        (Some(agent), _) => agent,
        (None, Some(default)) => default.agent_id.clone(),
        (None, None) => return Err("Falta o argumento --agent (o Squad desta missão está em Automático: escolha o agente).".into()),
    };
    let explicit = model.is_some() || effort.is_some();
    match default {
        Some(default) if !explicit && default.agent_id == agent => Ok(RecruitLlm {
            agent,
            model: default.model.clone(),
            effort: default.reasoning_effort.clone(),
            fast: fast_flag || default.fast_mode,
            source: RecruitSource::SquadDefault,
        }),
        _ => {
            let source = if explicit { RecruitSource::Explicit } else { RecruitSource::ProviderDefault };
            Ok(RecruitLlm { agent, model, effort, fast: fast_flag, source })
        }
    }
}

/// El subagente padrão del Squad de una misión **en ejecución**. Sin misión, sin Squad, con la
/// misión ya cerrada o en Automático devuelve `None`: el comportamiento anterior.
pub fn default_for_mission(conn: &Connection, mission_id: &str) -> Result<Option<SubagentDefault>, String> {
    let squad_id: Option<String> = conn
        .query_row(
            "SELECT squad_id FROM missions WHERE id = ?1 AND status = 'running' AND squad_id IS NOT NULL",
            [mission_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(squad_id) = squad_id else { return Ok(None) };
    Ok(super::store::get(conn, &squad_id)?.and_then(|squad| squad.default_subagent))
}

// ── Profundidade de delegação e teto de ativos ─────────────────────────────────────────────
//
// Antes, `ags peer recruit` só exigia que quem chama fosse orquestrador (a coroa no canvas):
// não havia teto de profundidade nem de integrantes abertos. Um integrante recrutado que a
// pessoa marcasse como orquestrador recrutava de novo, e um agente retomado "voltava a ser topo".
// Agora a profundidade de cada recrutado fica gravada em `<ags_home>/recruits.json` e só sobe:
// vale `max(gravado, atual)`. A aba aberta pela pessoa é profundidade 0.

/// Padrão: a aba da pessoa (0) recruta; um recrutado (1) não recruta de novo.
pub const DEFAULT_MAX_DEPTH: u32 = 1;
/// Recrutados abertos por um mesmo orquestrador. O mesmo teto do time do chat (`chat_team::model::MAX_MEMBERS`).
pub const MAX_ACTIVE_RECRUITS: usize = 12;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RecruitRecord {
    pub depth: u32,
    pub by: String,
    #[serde(default)]
    pub at: i64,
}

pub type RecruitBook = std::collections::BTreeMap<String, RecruitRecord>;

/// Profundidade monotônica: o que está gravado nunca desce, mesmo se o "atual" vier menor.
pub fn effective_depth(recorded: Option<u32>, current: u32) -> u32 {
    recorded.map_or(current, |r| r.max(current))
}

/// O que o recruit decide antes de abrir qualquer aba. Pura.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecruitGate {
    /// Pode recrutar; o novo nasce com esta profundidade.
    Allowed { child_depth: u32 },
    /// Recusado, com a frase para o agente (sem esconder o comando).
    Refused(String),
}

/// `recruiter_depth` já é o efetivo; `active` são os recrutados dele ainda abertos.
pub fn gate(recruiter_depth: u32, max_depth: u32, active: usize, max_active: usize) -> RecruitGate {
    let child_depth = recruiter_depth.saturating_add(1);
    if child_depth > max_depth {
        return RecruitGate::Refused(format!(
            "Recrutamento recusado: você já é um agente recrutado (profundidade {recruiter_depth}, limite {max_depth}). \
Delegue ao orquestrador que te recrutou ou faça a tarefa você mesmo; peça à pessoa se precisar de mais gente."
        ));
    }
    if active >= max_active {
        return RecruitGate::Refused(format!(
            "Recrutamento recusado: você já tem {active} agentes recrutados abertos (limite {max_active}). \
Reaproveite um deles com `ags peer tell` ou peça à pessoa para fechar algum."
        ));
    }
    RecruitGate::Allowed { child_depth }
}

/// Quantos recrutados de `by` continuam abertos. Pura.
pub fn active_recruits(book: &RecruitBook, by: &str, open: &[String]) -> usize {
    book.iter().filter(|(tab, r)| r.by == by && open.iter().any(|o| o == *tab)).count()
}

/// Registros mais velhos que isto saem na próxima gravação (os ids de aba são UUID, nunca reusados).
pub const KEEP_SECS: i64 = 90 * 24 * 60 * 60;

/// Grava o recrutado sem nunca baixar uma profundidade que já estava gravada, e poda o que passou
/// de [`KEEP_SECS`]. Pura.
pub fn record(book: &mut RecruitBook, tab: &str, by: &str, depth: u32, at: i64) {
    let depth = effective_depth(book.get(tab).map(|r| r.depth), depth);
    book.retain(|_, r| at - r.at <= KEEP_SECS);
    book.insert(tab.to_string(), RecruitRecord { depth, by: by.to_string(), at });
}

static BOOK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn book_path() -> Option<std::path::PathBuf> {
    crate::util::datadir::ags_home().map(|home| home.join("recruits.json"))
}

pub fn load_book() -> RecruitBook {
    book_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Lê, aplica `change` e grava com rename atômico, sob um mutex do processo.
pub fn update_book(change: impl FnOnce(&mut RecruitBook)) -> Result<(), String> {
    let _guard = BOOK_LOCK.lock().map_err(|e| e.to_string())?;
    let path = book_path().ok_or("Home indisponível.")?;
    let mut book = load_book();
    change(&mut book);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&book).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
