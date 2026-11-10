//! Comportamiento de cada TUI de fábrica.
//!
//! [`super::registry::AgentDef`] es la fila: id, comando, perfil, resume, sesiones, modelos
//! y MCP. Acá está lo que no cabe en una fila. Tres cosas cambian de una TUI a otra y el
//! resto de la app no debería decidirlas con un `match` sobre el id:
//!
//! - si la flota sabe lanzarla sin terminal ([`AgentAdapter::headless`]);
//! - cómo se arma el entorno de una cuenta ([`AgentAdapter::account_env`]);
//! - si se reporta instalada sin mirar el PATH ([`AgentAdapter::assumes_installed`]), que
//!   hoy solo es la terminal de emergencia.
//!
//! [`Capabilities`] sale de la fila más ese lanzamiento. No se marca a mano: lo que el
//! registro no declara, o lo que la flota no implementa, queda en falso.
//!
//! Sigue afuera a propósito, porque es el algoritmo de un formato y no la elección del
//! provider:
//!
//! - los parsers de `session/title.rs` (los elige `SessionSource`, que está en la fila);
//! - el archivo o la variable con los que entra el MCP (`McpStyle` en `ipc/mcp.rs`);
//! - pedir modelos a un binario (`ModelSource` en `runs/roster.rs`);
//! - leer el stream, que es cada `HeadlessAgent`.
//!
//! Una TUI custom no entra en esta tabla. No tiene fila estática. [`custom_capabilities`]
//! lee lo que el usuario declaró, con las mismas preguntas y sin inventarle flota ni cuenta.

use std::collections::HashMap;

use super::custom::CustomAgent;
use super::registry::{AgentDef, McpStyle, ModelSource, SHELL_AGENT_ID, SessionSource, agent_def};

/// Lo que esta TUI puede hacer hoy, con código que ya corre.
///
/// Una capacidad futura se queda en `false` hasta que el comportamiento exista. Gemini, por
/// ejemplo, descubre sesiones y la flota sabe lanzarlo, pero no aísla cuentas.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub accounts: bool,
    pub sessions: bool,
    pub resume: bool,
    pub skills: bool,
    pub mcp: bool,
    pub models: bool,
    pub headless: bool,
    pub orchestration: bool,
}

/// Comportamiento de una TUI de fábrica. La fila se lee con [`AgentAdapter::def`]; este
/// trait no vuelve a declarar comando, resume ni estilo de MCP.
pub trait AgentAdapter: Send + Sync {
    fn def(&self) -> &'static AgentDef;

    /// Ordem de fallback em consultas únicas somente leitura. A elegibilidade é confirmada
    /// novamente pelo `HeadlessAgent::enforces_read_only`.
    fn read_only_priority(&self) -> Option<u8> { None }

    /// Se o fluxo de contas aceita uma credencial em vez de login pela CLI.
    fn supports_api_key_account(&self) -> bool { false }
    /// Se o fluxo de conta por credencial permite usar endpoint compatível próprio.
    fn supports_custom_api_base_url(&self) -> bool { false }
    /// Se o seletor e a Frota podem usar a faixa de serviço rápida.
    fn supports_fast_mode(&self) -> bool { false }

    /// The headless launcher can receive the ADE MCP orchestration tools.
    fn supports_orchestration(&self) -> bool { false }
    /// The task launcher can inject ADE MCP independently of terminal/Lead support.
    fn has_task_mcp(&self) -> bool { self.supports_orchestration() }

    /// La flota sabe lanzarla. `false` en el shell: no es un agente headless.
    fn has_headless(&self) -> bool {
        false
    }

    /// El `HeadlessAgent` de una corrida. `None` si [`AgentAdapter::has_headless`] es falso.
    /// Se llama al lanzar, no al mirar el registro.
    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        None
    }

    /// Reportarla instalada sin buscar el binario. Solo el shell de emergencia: en Windows
    /// `bash` no está en el PATH con ese nombre, y sondearlo lo daría por ausente.
    fn assumes_installed(&self) -> bool {
        false
    }

    /// `{variable: directorio}` para lanzar un proceso en esa cuenta.
    ///
    /// `None` cuando la fila no declara perfil. El directorio se copia tal cual llegó de la
    /// base: convertirlo a `Path` y de vuelta cambiaría separadores que el PTY ya recibía.
    fn account_env(&self, dir: &str) -> Option<HashMap<String, String>> {
        let profile = self.def().profile?;
        Some(HashMap::from([(
            profile.env_var.to_string(),
            dir.to_string(),
        )]))
    }

    fn capabilities(&self) -> Capabilities {
        let def = self.def();
        Capabilities {
            accounts: def.profile.is_some(),
            sessions: def.sessions != SessionSource::None,
            resume: def.resume.is_some(),
            skills: def.skills_dir.is_some(),
            mcp: def.mcp != McpStyle::None || self.has_task_mcp(),
            // `Unknown` es "no sabemos listarlos", no una lista vacía que igual cuenta.
            models: !matches!(def.models, ModelSource::Unknown),
            headless: self.has_headless(),
            orchestration: self.supports_orchestration(),
        }
    }
}

fn row(id: &'static str) -> &'static AgentDef {
    agent_def(id).unwrap_or_else(|| panic!("el registro no tiene '{id}'"))
}

struct Claude;

impl AgentAdapter for Claude {
    fn read_only_priority(&self) -> Option<u8> { Some(0) }
    fn supports_api_key_account(&self) -> bool { true }
    fn supports_custom_api_base_url(&self) -> bool { true }
    fn supports_orchestration(&self) -> bool { true }
    fn def(&self) -> &'static AgentDef {
        row("claude-code")
    }

    fn has_headless(&self) -> bool {
        true
    }

    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::ClaudeCode))
    }
}

struct Gemini;

impl AgentAdapter for Gemini {
    fn read_only_priority(&self) -> Option<u8> { Some(2) }
    fn def(&self) -> &'static AgentDef {
        row("gemini-cli")
    }

    fn has_headless(&self) -> bool {
        true
    }

    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::Gemini::default()))
    }
}

struct Codex;

impl AgentAdapter for Codex {
    fn read_only_priority(&self) -> Option<u8> { Some(1) }
    fn supports_api_key_account(&self) -> bool { true }
    fn supports_fast_mode(&self) -> bool { true }
    fn supports_orchestration(&self) -> bool { true }
    fn has_task_mcp(&self) -> bool { true }
    fn def(&self) -> &'static AgentDef {
        row("codex")
    }

    fn has_headless(&self) -> bool {
        true
    }

    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::Codex::default()))
    }
}

struct OpenCode;

impl AgentAdapter for OpenCode {
    fn read_only_priority(&self) -> Option<u8> { Some(3) }
    fn supports_orchestration(&self) -> bool { true }
    fn def(&self) -> &'static AgentDef {
        row("opencode")
    }

    fn has_headless(&self) -> bool {
        true
    }

    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::OpenCode::default()))
    }
}

struct Kimi;

impl AgentAdapter for Kimi {
    fn def(&self) -> &'static AgentDef {
        row("kimi-code")
    }

    fn has_headless(&self) -> bool {
        true
    }

    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::Kimi::default()))
    }
}

struct Hermes;

impl AgentAdapter for Hermes {
    fn def(&self) -> &'static AgentDef {
        row("hermes")
    }
}

struct Bash;

impl AgentAdapter for Bash {
    fn def(&self) -> &'static AgentDef {
        row(SHELL_AGENT_ID)
    }

    fn assumes_installed(&self) -> bool {
        true
    }
}

static CLAUDE: Claude = Claude;
static GEMINI: Gemini = Gemini;
static CODEX: Codex = Codex;
static OPENCODE: OpenCode = OpenCode;
static KIMI: Kimi = Kimi;
static HERMES: Hermes = Hermes;
static CURSOR: Cursor = Cursor;
static BASH: Bash = Bash;

struct Cursor;

impl AgentAdapter for Cursor {
    fn def(&self) -> &'static AgentDef {
        row("cursor")
    }
}

/// El mismo orden que [`super::registry::AGENTS`]. La detección y el catálogo del frontend
/// dependen de ese orden.
struct Antigravity;
impl AgentAdapter for Antigravity {
    fn def(&self) -> &'static AgentDef { row("antigravity") }
    fn supports_orchestration(&self) -> bool { true }
    fn has_headless(&self) -> bool { true }
    fn headless(&self) -> Option<Box<dyn crate::runs::HeadlessAgent + Send + Sync>> {
        Some(Box::new(crate::runs::Antigravity::default()))
    }
    /// As contas por HOME valem para terminais e conversas. A Frota roda o `agy` num home temporário
    /// próprio (`runs/antigravity.rs`) e não aplica o da conta: oferecê-las ali atribuiria o gasto à
    /// conta errada.
    fn capabilities(&self) -> Capabilities {
        let def = self.def();
        Capabilities {
            accounts: false,
            sessions: def.sessions != SessionSource::None,
            resume: def.resume.is_some(),
            skills: def.skills_dir.is_some(),
            mcp: def.mcp != McpStyle::None || self.has_task_mcp(),
            models: !matches!(def.models, ModelSource::Unknown),
            headless: self.has_headless(),
            orchestration: self.supports_orchestration(),
        }
    }
}
static ANTIGRAVITY: Antigravity = Antigravity;
static ADAPTERS: [&dyn AgentAdapter; 9] = [&CLAUDE, &GEMINI, &CODEX, &OPENCODE, &KIMI, &HERMES, &ANTIGRAVITY, &CURSOR, &BASH];

/// Todos los providers de fábrica. No aloca: son estáticos.
pub fn adapters() -> &'static [&'static dyn AgentAdapter] {
    &ADAPTERS
}

/// El provider de fábrica con ese id, o `None` si no está en la tabla.
///
/// Una TUI custom cae en `None`. Quien la tiene en la mano pregunta
/// [`custom_capabilities`]; no hay una segunda tabla de comportamiento.
pub fn adapter_for(id: &str) -> Option<&'static dyn AgentAdapter> {
    ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.def().id == id)
}

/// Lo que una TUI custom puede hacer con lo que el usuario escribió.
///
/// Cuentas, MCP, modelos y flota quedan en falso: no hay aislamiento verificado, ni estilo
/// de MCP, ni lanzamiento headless para una TUI arbitraria. Sesiones, resume y skills salen
/// de los campos que sí declaró. Un string vacío es "no configurado".
pub fn custom_capabilities(agent: &CustomAgent) -> Capabilities {
    let declared = |value: &Option<String>| value.as_deref().is_some_and(|s| !s.trim().is_empty());
    Capabilities {
        accounts: false,
        sessions: declared(&agent.sessions_dir),
        resume: declared(&agent.resume_args),
        skills: declared(&agent.skills_dir),
        mcp: false,
        models: false,
        headless: false,
        orchestration: false,
    }
}
