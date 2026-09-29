//! El contrato de cada provider de fábrica. Una función por TUI: si una capacidad se marca
//! sin código detrás, falla acá y no en una tab.

use std::collections::{HashMap, HashSet};

use super::registry::{AGENTS, DefaultHome, McpStyle, SessionSource, SystemMarkerRoot};
use super::{CustomAgent, adapter_for, adapters, custom_capabilities};

fn adapter(id: &str) -> &'static dyn super::AgentAdapter {
    adapter_for(id).unwrap_or_else(|| panic!("falta {id} en el registro de adapters"))
}

#[test]
fn claude_code() {
    let agent = adapter("claude-code");
    let def = agent.def();
    let caps = agent.capabilities();

    assert_eq!(def.id, "claude-code");
    assert_eq!(def.command, "claude");
    assert_eq!(def.resume, Some("--resume {session}"));
    assert_eq!(def.sessions, SessionSource::ClaudeProjects);
    assert_eq!(def.mcp, McpStyle::ClaudeFlags);
    assert_eq!(def.skills_dir, Some(".claude/skills"));

    let profile = def.profile.expect("claude aísla cuentas");
    assert_eq!(profile.env_var, "CLAUDE_CONFIG_DIR");
    assert_eq!(profile.default_home, DefaultHome::HomeDot(".claude"));
    assert_eq!(profile.system_marker, SystemMarkerRoot::UserHome);

    let dir = r"C:\cuentas\trabajo";
    let env = agent.account_env(dir).expect("claude arma entorno");
    assert_eq!(env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some(dir));
    assert_eq!(env.len(), 1);

    assert!(caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(caps.skills);
    assert!(caps.mcp);
    assert!(caps.models);
    assert!(caps.headless);
    assert!(agent.headless().is_some());
    assert!(!agent.assumes_installed());
}

#[test]
fn codex() {
    let agent = adapter("codex");
    let def = agent.def();
    let caps = agent.capabilities();

    assert_eq!(def.command, "codex");
    assert_eq!(def.resume, Some("resume {session}"));
    assert_eq!(def.sessions, SessionSource::CodexRollouts);
    assert_eq!(def.mcp, McpStyle::None);
    assert_eq!(def.skills_dir, Some(".agents/skills"));

    let profile = def.profile.expect("codex aísla cuentas");
    assert_eq!(profile.env_var, "CODEX_HOME");
    assert_eq!(profile.default_home, DefaultHome::HomeDot(".codex"));
    assert_eq!(profile.system_marker, SystemMarkerRoot::DefaultDir);

    let dir = r"C:\cuentas\José trabajo";
    let env = agent.account_env(dir).expect("codex arma entorno");
    assert_eq!(env.get("CODEX_HOME").map(String::as_str), Some(dir));
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR"));

    assert!(caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(caps.skills);
    assert!(!caps.mcp);
    assert!(!caps.models);
    assert!(caps.headless);
    assert!(agent.headless().is_some());
}

#[test]
fn gemini_cli_sin_cuentas_y_sin_exigir_el_binario() {
    let agent = adapter("gemini-cli");
    let def = agent.def();
    let caps = agent.capabilities();

    assert_eq!(def.command, "gemini");
    assert_eq!(def.resume, Some("--resume {session}"));
    assert_eq!(def.sessions, SessionSource::GeminiTmp);
    assert_eq!(def.mcp, McpStyle::None);
    assert_eq!(def.skills_dir, Some(".agents/skills"));
    assert_ne!(def.skills_dir, Some(".claude/skills"));
    assert!(def.profile.is_none());

    // Sin perfil no hay variable que armar, y en particular no se hereda Claude.
    assert!(agent.account_env(r"C:\temp\perfil-a").is_none());
    assert!(agent.account_env(r"C:\Users\alguien\.claude").is_none());

    assert!(!caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(caps.skills);
    assert!(!caps.mcp);
    assert!(!caps.models);
    assert!(caps.headless);
    // El adapter existe aunque el binario no esté. La detección es otro paso.
    let _instalado = super::command_exists(def.command);
    assert!(agent.headless().is_some());
    assert!(adapter_for("gemini-cli").is_some());
}

#[test]
fn opencode() {
    let agent = adapter("opencode");
    let def = agent.def();
    let caps = agent.capabilities();

    assert_eq!(def.command, "opencode");
    assert_eq!(def.resume, Some("--session {session}"));
    assert_eq!(def.sessions, SessionSource::ProcessQuery);
    assert_eq!(def.mcp, McpStyle::OpencodeConfig);
    assert_eq!(def.skills_dir, Some(".agents/skills"));

    let profile = def.profile.expect("opencode aísla cuentas");
    assert_eq!(profile.env_var, "XDG_DATA_HOME");
    assert_eq!(profile.default_home, DefaultHome::XdgDataHome);
    assert_eq!(profile.system_marker, SystemMarkerRoot::DefaultDir);

    let env = agent.account_env("/tmp/oc").expect("opencode arma entorno");
    assert_eq!(
        env.get("XDG_DATA_HOME").map(String::as_str),
        Some("/tmp/oc")
    );
    assert!(!env.contains_key("CLAUDE_CONFIG_DIR"));

    assert!(caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(caps.skills);
    assert!(caps.mcp);
    assert!(caps.models);
    assert!(caps.headless);
    assert!(agent.headless().is_some());
}

#[test]
fn kimi_code() {
    let agent = adapter("kimi-code");
    let def = agent.def();
    let caps = agent.capabilities();

    assert_eq!(def.command, "kimi");
    assert_eq!(def.resume, Some("--session {session}"));
    assert_eq!(def.sessions, SessionSource::KimiSessions);
    assert_eq!(def.mcp, McpStyle::None);
    assert_eq!(def.skills_dir, Some(".agents/skills"));
    assert!(def.profile.is_none());
    assert!(agent.account_env("/tmp/kimi").is_none());

    assert!(!caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(caps.skills);
    assert!(!caps.mcp);
    assert!(!caps.models);
    assert!(caps.headless);
    assert!(agent.headless().is_some());
}

#[test]
fn bash_no_finge_capabilities_de_agente() {
    let agent = adapter("bash");
    let caps = agent.capabilities();

    assert_eq!(agent.def().command, "bash");
    assert!(agent.def().profile.is_none());
    assert_eq!(agent.def().sessions, SessionSource::None);
    assert_eq!(agent.def().mcp, McpStyle::None);
    assert!(agent.def().resume.is_none());
    assert!(agent.def().skills_dir.is_none());
    assert!(agent.account_env("/tmp").is_none());
    assert!(agent.assumes_installed());
    assert!(agent.headless().is_none());

    assert!(!caps.accounts);
    assert!(!caps.sessions);
    assert!(!caps.resume);
    assert!(!caps.skills);
    assert!(!caps.mcp);
    assert!(!caps.models);
    assert!(!caps.headless);
}

#[test]
fn un_provider_que_no_existe_no_esta_en_el_registro() {
    assert!(adapter_for("qwen-code").is_none());
    assert!(adapter_for("").is_none());
    assert!(adapter_for("claude").is_none());
}

#[test]
fn un_agente_custom_queda_fuera_del_registro_de_fabrica() {
    let declared = CustomAgent {
        id: "mitui".into(),
        label: "Mi TUI".into(),
        command: "mitui --foo".into(),
        resume_args: Some("--resume {session}".into()),
        skills_dir: Some("  ".into()),
        sessions_dir: Some("~/.mitui/sessions".into()),
        session_id_from: "filename".into(),
        env: HashMap::new(),
    };
    assert!(adapter_for(&declared.id).is_none());

    let caps = custom_capabilities(&declared);
    assert!(!caps.accounts);
    assert!(caps.sessions);
    assert!(caps.resume);
    assert!(
        !caps.skills,
        "un directorio en blanco no es una carpeta de skills"
    );
    assert!(!caps.mcp);
    assert!(!caps.models);
    assert!(!caps.headless);

    let empty = CustomAgent {
        resume_args: None,
        skills_dir: None,
        sessions_dir: None,
        ..declared
    };
    let none = custom_capabilities(&empty);
    assert!(!none.sessions);
    assert!(!none.resume);
    assert!(!none.skills);
}

#[test]
fn el_registro_no_repite_ids_y_cubre_el_catalogo() {
    let mut seen = HashSet::new();
    let listed: Vec<&str> = adapters()
        .iter()
        .map(|agent| {
            let id = agent.def().id;
            assert!(seen.insert(id), "id repetido: {id}");
            assert_eq!(agent.has_headless(), agent.headless().is_some(), "{id}");
            id
        })
        .collect();
    let catalog: Vec<&str> = AGENTS.iter().map(|def| def.id).collect();
    assert_eq!(listed, catalog);
}

#[test]
fn solo_claude_emite_claude_config_dir() {
    for agent in adapters() {
        let Some(env) = agent.account_env(r"D:\perfil") else {
            continue;
        };
        let claude = env.contains_key("CLAUDE_CONFIG_DIR");
        assert_eq!(
            claude,
            agent.def().id == "claude-code",
            "{}",
            agent.def().id
        );
    }
}
