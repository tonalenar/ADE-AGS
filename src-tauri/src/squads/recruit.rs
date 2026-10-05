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
