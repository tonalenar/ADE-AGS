//! Fixed official commands. Unknown installation methods fail closed.
use crate::database::DbConnection;
use serde::Serialize;
use std::{
    cmp::Ordering,
    io::{self, Read},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{RwLock, RwLockReadGuard},
    time::{Duration, Instant},
};
use tauri::Manager;

pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
static UPDATE_GATE: RwLock<()> = RwLock::new(());
/// Starting terminals/missions takes this before taking database/PTY locks.
pub(crate) fn activity_guard() -> Result<RwLockReadGuard<'static, ()>, String> {
    UPDATE_GATE
        .try_read()
        .map_err(|_| "Atualização de agente em andamento; tente novamente.".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedCommand {
    pub program: &'static str,
    pub args: &'static [&'static str],
}
#[derive(Clone, Copy, Debug)]
pub struct UpdateDef {
    pub agent_id: &'static str,
    pub package: Option<&'static str>,
    pub check: Option<FixedCommand>,
    pub update: Option<FixedCommand>,
    /// O mesmo pacote instalado com `bun add --global`: o bun não roda scripts de instalação
    /// de pacotes que não estão no `trustedDependencies`, o equivalente ao `--ignore-scripts`.
    pub bun_update: Option<FixedCommand>,
}
/// O bin global do bun (`~/.bun/bin`) e o que ele tem instalado. Fixos, sem argumento externo.
pub const BUN_BIN: FixedCommand = FixedCommand { program: "bun", args: &["pm", "bin", "--global"] };
pub const BUN_LIST: FixedCommand = FixedCommand { program: "bun", args: &["pm", "ls", "--global"] };
/// Primeira instalação do Kimi. O pacote é o da documentação oficial (`npm install -g`);
/// os flags são os mesmos do Codex e do Gemini. Não entra na atualização automática.
const KIMI_INSTALL_NPM: FixedCommand = FixedCommand {
    program: "npm",
    args: &[
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@moonshot-ai/kimi-code",
    ],
};
const KIMI_INSTALL_BUN: FixedCommand = FixedCommand {
    program: "bun",
    args: &["add", "--global", "@moonshot-ai/kimi-code@latest"],
};
macro_rules! npm_def {
    ($id:literal, $pkg:literal) => {
        UpdateDef {
            agent_id: $id,
            package: Some($pkg),
            check: Some(FixedCommand {
                program: "npm",
                args: &["view", $pkg, "version", "--json"],
            }),
            update: Some(FixedCommand {
                program: "npm",
                args: &[
                    "install",
                    "--global",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    $pkg,
                ],
            }),
            bun_update: Some(FixedCommand {
                program: "bun",
                args: &["add", "--global", concat!($pkg, "@latest")],
            }),
        }
    };
}
pub const UPDATE_TABLE: &[UpdateDef] = &[
    // Verified locally: claude update --help, npm view/install/root --help.
    UpdateDef {
        agent_id: "claude-code",
        package: Some("@anthropic-ai/claude-code"),
        check: Some(FixedCommand {
            program: "npm",
            args: &["view", "@anthropic-ai/claude-code", "version", "--json"],
        }),
        update: Some(FixedCommand {
            program: "claude",
            args: &["update"],
        }),
        // O nativo se atualiza sozinho com `claude update`; pelo bun ele não é suportado.
        bun_update: None,
    },
    npm_def!("codex", "@openai/codex"),
    // Gemini is absent locally: npm mechanism verified, Gemini-specific help unverified.
    npm_def!("gemini-cli", "@google/gemini-cli"),
    // OpenCode help fails EEXIST; agy offers update but no verified read-only check.
    UpdateDef {
        agent_id: "opencode",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
    UpdateDef {
        agent_id: "antigravity",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
    UpdateDef {
        agent_id: "kimi-code",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
    UpdateDef {
        // Instalado por git no home do Hermes; ele mesmo se atualiza com `hermes update`.
        agent_id: "hermes",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
    UpdateDef {
        // O próprio CLI atualiza com `cursor-agent update`. Sem checagem só de leitura verificada.
        agent_id: "cursor",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
    UpdateDef {
        agent_id: "bash",
        package: None,
        check: None,
        update: None,
        bun_update: None,
    },
];
pub fn update_def(id: &str) -> Option<&'static UpdateDef> {
    UPDATE_TABLE.iter().find(|d| d.agent_id == id)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateInfo {
    pub agent_id: String,
    pub label: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub can_auto_update: bool,
    pub busy: bool,
    pub reason: Option<String>,
    /// Como o agente foi instalado, quando é um jeito que a ADE sabe atualizar: `native`
    /// (Claude nativo), `npm` ou `bun`. Escolhe o comando de atualizar.
    pub install: Option<String>,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateResult {
    pub agent_id: String,
    pub ok: bool,
    pub output: String,
    pub new_version: Option<String>,
    pub error: Option<String>,
}

/// Extract CLI prefixes while preserving semver prerelease/build suffixes.
pub fn version_cmp(current: &str, latest: &str) -> Option<Ordering> {
    fn parse(s: &str) -> Option<([u64; 3], Vec<String>)> {
        let re = regex::Regex::new(
            r"(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:$|\s)",
        )
        .ok()?;
        let c = re.captures(s)?;
        if (1..=3).any(|i| c[i].len() > 1 && c[i].starts_with('0')) {
            return None;
        }
        let pre: Vec<String> = c
            .get(4)
            .map(|m| m.as_str().split('.').map(str::to_string).collect())
            .unwrap_or_default();
        if pre.iter().any(|p| {
            p.is_empty()
                || (p.len() > 1 && p.starts_with('0') && p.bytes().all(|b| b.is_ascii_digit()))
        }) {
            return None;
        }
        Some((
            [c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?],
            pre,
        ))
    }
    let (a, ap) = parse(current)?;
    let (b, bp) = parse(latest)?;
    if a != b {
        return Some(a.cmp(&b));
    }
    if ap.is_empty() || bp.is_empty() {
        return Some(match (ap.is_empty(), bp.is_empty()) {
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            _ => Ordering::Equal,
        });
    }
    for (a, b) in ap.iter().zip(&bp) {
        let order = match (
            a.bytes().all(|c| c.is_ascii_digit()),
            b.bytes().all(|c| c.is_ascii_digit()),
        ) {
            (true, true) => a.len().cmp(&b.len()).then(a.cmp(b)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.cmp(b),
        };
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    Some(ap.len().cmp(&bp.len()))
}
pub fn policy_reason(
    terminal: bool,
    mission: bool,
    npm: bool,
    updater: bool,
) -> Option<&'static str> {
    if terminal {
        Some("busy_terminal")
    } else if mission {
        Some("busy_mission")
    } else if !updater {
        Some("no_updater")
    } else if !npm {
        Some("not_npm")
    } else {
        None
    }
}

fn official_command(spec: FixedCommand) -> bool {
    UPDATE_TABLE
        .iter()
        .any(|d| d.check == Some(spec) || d.update == Some(spec) || d.bun_update == Some(spec))
        || spec == KIMI_INSTALL_NPM
        || spec == KIMI_INSTALL_BUN
        || spec == BUN_BIN
        || spec == BUN_LIST
        || spec
            == (FixedCommand {
                program: "npm",
                args: &["root", "--global"],
            })
        || spec
            == (FixedCommand {
                program: "claude",
                args: &["--version"],
            })
}

pub trait UpdateExecutor {
    fn execute(&self, command: FixedCommand, timeout: Duration) -> Result<String, String>;
}
pub struct OfficialExecutor;
impl UpdateExecutor for OfficialExecutor {
    fn execute(&self, spec: FixedCommand, timeout: Duration) -> Result<String, String> {
        if !official_command(spec) {
            return Err("failed".into());
        }
        let mut cmd = if spec.program == "npm" {
            // Execute npm's JS entrypoint through node: never cmd.exe/sh or a .cmd shim.
            let npm = crate::util::find_program("npm").ok_or("failed")?;
            let parent = npm.parent().ok_or("failed")?;
            let candidates = [
                parent.join("node_modules/npm/bin/npm-cli.js"),
                parent.join("../lib/node_modules/npm/bin/npm-cli.js"),
            ];
            let cli = candidates
                .into_iter()
                .find(|p| p.is_file())
                .ok_or("failed")?;
            let mut c = crate::util::spawn::hidden_command(crate::util::find_program("node").ok_or("failed")?);
            c.arg(cli);
            c
        } else if spec.program == "claude" {
            let path = crate::util::find_program("claude").ok_or("failed")?;
            if !native_claude_path(&path) {
                return Err("not_npm".into());
            }
            crate::util::spawn::hidden_command(path)
        } else if spec.program == "bun" {
            // `bun.exe` é um binário de verdade, não um shim `.cmd`: roda direto, sem shell.
            crate::util::spawn::hidden_command(crate::util::find_program("bun").ok_or("failed")?)
        } else {
            return Err("no_updater".into());
        };
        cmd.args(spec.args)
            .env("npm_config_registry", "https://registry.npmjs.org/")
            .env("npm_config_ignore_scripts", "true")
            .env("npm_config_update_notifier", "false");
        execute_process(&mut cmd, timeout).map_err(|e| {
            if e.kind() == io::ErrorKind::TimedOut {
                "timeout".into()
            } else {
                format!("failed:{}", summarize(&e.to_string()))
            }
        })
    }
}
/// Bounded pipes and process containment: children cannot keep readers blocking on timeout.
pub fn execute_process(cmd: &mut Command, timeout: Duration) -> io::Result<String> {
    // Quem chama pode ter montado o comando por fora do helper: garante o `CREATE_NO_WINDOW`.
    crate::util::spawn::apply_window(cmd, crate::util::spawn::WindowMode::Hidden);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut group = crate::terminal::containment::ProcessGroup::new(child.id());
    group.adopt(&child);
    fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let keep = n.min(2048usize.saturating_sub(out.len()));
                out.extend_from_slice(&buf[..keep]);
            }
            out
        })
    }
    let out = drain(child.stdout.take().unwrap());
    let err = drain(child.stderr.take().unwrap());
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            drop(group);
            // Avoid waiting on escaped descendants even after a successful leader exit.
            let reader_deadline = Instant::now() + Duration::from_millis(100);
            while !(out.is_finished() && err.is_finished()) && Instant::now() < reader_deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            let stdout = if out.is_finished() {
                out.join().unwrap_or_default()
            } else {
                Vec::new()
            };
            let stderr = if err.is_finished() {
                err.join().unwrap_or_default()
            } else {
                Vec::new()
            };
            let output = summarize(&format!(
                "{}{}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            ));
            return if status.success() {
                Ok(output)
            } else {
                Err(io::Error::other(output))
            };
        }
        if Instant::now() >= deadline {
            drop(group);
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timeout"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
pub fn summarize(s: &str) -> String {
    let mut end = s.len().min(2048);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}
fn native_claude_path(path: &std::path::Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    #[cfg(windows)]
    {
        path == home.join(".local/bin/claude.exe")
    }
    #[cfg(not(windows))]
    {
        path == home.join(".local/bin/claude")
            && std::fs::canonicalize(path)
                .ok()
                .is_some_and(|p| p.starts_with(home.join(".local/share/claude")))
    }
}

pub fn npm_install_matches(agent: &super::AgentInfo, def: &UpdateDef, root: &str) -> bool {
    let Some(package) = def.package else {
        return false;
    };
    let root = PathBuf::from(root.trim());
    let Some(path) = agent.path.as_ref().map(PathBuf::from) else {
        return false;
    };
    let expected = root.join(package);
    let Ok(raw) = std::fs::read(expected.join("package.json")) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return false;
    };
    if manifest["name"].as_str() != Some(package) {
        return false;
    }
    #[cfg(windows)]
    {
        let Some(prefix) = root.parent() else {
            return false;
        };
        if path.parent() != Some(prefix) {
            return false;
        }
        let Ok(shim) = std::fs::read_to_string(&path) else {
            return false;
        };
        shim.replace('\\', "/")
            .contains(&format!("node_modules/{package}/"))
    }
    #[cfg(not(windows))]
    {
        std::fs::canonicalize(path).ok().is_some_and(|p| {
            std::fs::canonicalize(expected)
                .ok()
                .is_some_and(|root| p.starts_with(root))
        })
    }
}

/// A versão de `package` na listagem de `bun pm ls --global` (`├── @openai/codex@0.164.0`). Pura.
pub fn bun_global_version(listing: &str, package: &str) -> Option<String> {
    let prefix = format!("{package}@");
    listing.split_whitespace().find_map(|token| {
        let version = token.strip_prefix(&prefix)?;
        (!version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)))
            .then(|| version.to_string())
    })
}

/// O agente detectado é o do bun: o executável está no bin global do bun e o pacote consta
/// na listagem global dele. Qualquer dúvida = não (fail closed, como no npm).
pub fn bun_install_matches(agent: &super::AgentInfo, def: &UpdateDef, bin: &str, listing: &str) -> bool {
    let (Some(package), Some(path)) = (def.package, agent.path.as_ref()) else {
        return false;
    };
    let bin = PathBuf::from(bin.trim());
    let same_dir = PathBuf::from(path).parent().is_some_and(|dir| {
        dir == bin
            || std::fs::canonicalize(dir)
                .ok()
                .zip(std::fs::canonicalize(&bin).ok())
                .is_some_and(|(a, b)| a == b)
    });
    same_dir && bun_global_version(listing, package).is_some()
}

/// Como o agente foi instalado, se for um jeito que a ADE sabe atualizar.
fn install_method(agent: &super::AgentInfo, def: &UpdateDef, exec: &impl UpdateExecutor) -> Option<&'static str> {
    if agent.id == "claude-code" {
        return agent
            .path
            .as_ref()
            .is_some_and(|p| native_claude_path(std::path::Path::new(p)))
            .then_some("native");
    }
    def.package?;
    let npm = exec
        .execute(FixedCommand { program: "npm", args: &["root", "--global"] }, CHECK_TIMEOUT)
        .ok()
        .is_some_and(|root| npm_install_matches(agent, def, &root));
    if npm {
        return Some("npm");
    }
    let bun = def.bun_update.is_some()
        && exec.execute(BUN_BIN, CHECK_TIMEOUT).ok().zip(exec.execute(BUN_LIST, CHECK_TIMEOUT).ok())
            .is_some_and(|(bin, listing)| bun_install_matches(agent, def, &bin, &listing));
    bun.then_some("bun")
}

pub fn busy_reason(conn: &rusqlite::Connection, id: &str) -> Result<Option<&'static str>, String> {
    busy_reason_with(conn, id, false)
}

/// `terminals_released`: quien llama (la pantalla, tras el clic del usuario en "Actualizar")
/// ya cerró los procesos de este agente y va a volver a abrir sus pestañas con `--resume`.
/// Entonces las pestañas guardadas no bloquean, pero NUNCA se confía en eso a ciegas: un
/// proceso vivo del agente en el registro de PTYs sigue bloqueando, y una misión o un run en
/// curso con ese agente también.
pub fn busy_reason_with(
    conn: &rusqlite::Connection,
    id: &str,
    terminals_released: bool,
) -> Result<Option<&'static str>, String> {
    if !terminals_released {
        let terminal: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tabs t JOIN windows w ON w.id=t.window_id WHERE t.agent_id=?1 AND w.is_open=1)", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if terminal {
            return Ok(Some("busy_terminal"));
        }
    }
    for tab in crate::terminal::live_update_tabs() {
        let Some(tab) = tab else {
            return Ok(Some("busy_terminal"));
        };
        let owner: Option<String> = conn
            .query_row("SELECT agent_id FROM tabs WHERE id=?1", [tab], |r| r.get(0))
            .ok();
        if owner.as_deref() == Some(id) || owner.is_none() {
            return Ok(Some("busy_terminal"));
        }
    }
    let mission: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM missions m WHERE m.status='running' AND (m.lead_agent_id=?1 OR (m.lead_agent_id IS NULL AND m.squad_id IS NULL) OR EXISTS(SELECT 1 FROM squads s WHERE s.id=m.squad_id AND s.lead_agent_id=?1) OR EXISTS(SELECT 1 FROM squad_members s WHERE s.squad_id=m.squad_id AND s.agent_id=?1))) OR EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.run_id=r.id WHERE r.status='running' AND t.agent_id=?1) OR EXISTS(SELECT 1 FROM runs r JOIN run_squad_members s ON s.run_id=r.id WHERE r.status='running' AND s.agent_id=?1)", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(policy_reason(false, mission, true, true))
}
/// Reiniciar la app entera mata los terminales de TODOS los agentes: si hay una misión o un
/// run en curso (de cualquier agente) no se reinicia.
pub fn work_running(conn: &rusqlite::Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM missions WHERE status='running') OR EXISTS(SELECT 1 FROM runs WHERE status='running')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn agent_update_work_running(app: tauri::AppHandle) -> Result<bool, String> {
    let db = app.state::<DbConnection>().inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        work_running(&conn)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn elevated() -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(windows)]
    {
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
                System::Threading::{GetCurrentProcess, OpenProcessToken},
            };
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return true;
            }
            let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut size = 0;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            CloseHandle(token);
            ok == 0 || info.TokenIsElevated != 0
        }
    }
}
fn check_one(
    agent: &super::AgentInfo,
    busy: Option<&'static str>,
    exec: &impl UpdateExecutor,
) -> AgentUpdateInfo {
    let def = update_def(&agent.id).unwrap();
    let latest = def
        .check
        .and_then(|c| exec.execute(c, CHECK_TIMEOUT).ok())
        .and_then(|s| serde_json::from_str::<String>(&s).ok());
    let install = install_method(agent, def, exec);
    // Os impedimentos que fechar terminais não resolve vêm ANTES de "terminal aberto": senão o
    // "Atualizar" fechava as abas do agente para depois falhar com `not_npm`.
    let reason = policy_reason(false, false, install.is_some(), def.update.is_some())
        .or(
            if latest.is_none()
                || agent
                    .version
                    .as_ref()
                    .zip(latest.as_ref())
                    .and_then(|(a, b)| version_cmp(a, b))
                    .is_none()
            {
                Some("check_failed")
            } else {
                None
            },
        )
        .or(if elevated() { Some("no_updater") } else { None })
        .or(busy);
    AgentUpdateInfo {
        agent_id: agent.id.clone(),
        label: agent.label.clone(),
        // A versão já veio do `detect_agents` (cache de 5 min). Não se relança `claude --version` aqui.
        current_version: agent.version.clone(),
        update_available: agent
            .version
            .as_ref()
            .zip(latest.as_ref())
            .is_some_and(|(a, b)| version_cmp(a, b) == Some(Ordering::Less)),
        latest_version: latest,
        can_auto_update: reason.is_none() && !elevated(),
        busy: matches!(busy, Some("busy_terminal" | "busy_mission")),
        reason: reason.map(str::to_string),
        install: install.map(str::to_string),
    }
}
#[tauri::command]
pub async fn agent_updates_check(app: tauri::AppHandle) -> Vec<AgentUpdateInfo> {
    let agents = super::detect_agents(None).await.unwrap_or_default();
    let db = app.state::<DbConnection>().inner().clone();
    tokio::task::spawn_blocking(move || {
        agents
            .iter()
            .filter(|a| a.available && a.id != "bash" && update_def(&a.id).is_some())
            .map(|a| {
                let busy = match db.lock() {
                    Ok(conn) => busy_reason(&conn, &a.id).unwrap_or(Some("check_failed")),
                    Err(_) => Some("check_failed"),
                };
                check_one(a, busy, &OfficialExecutor)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}
pub fn update_with_executor(
    id: &str,
    info: &AgentUpdateInfo,
    exec: &impl UpdateExecutor,
) -> AgentUpdateResult {
    let mut result = AgentUpdateResult {
        agent_id: id.into(),
        ok: false,
        output: String::new(),
        new_version: None,
        error: None,
    };
    if let Some(reason) = &info.reason {
        result.error = Some(reason.clone());
        return result;
    }
    if info.busy {
        result.error = Some("busy_terminal".into());
        return result;
    }
    if !info.can_auto_update {
        result.error = Some("failed".into());
        return result;
    }
    let command = update_def(id).and_then(|d| match info.install.as_deref() {
        Some("bun") => d.bun_update,
        _ => d.update,
    });
    let Some(command) = command else {
        result.error = Some("no_updater".into());
        return result;
    };
    match exec.execute(command, UPDATE_TIMEOUT) {
        Ok(output) => {
            result.ok = true;
            result.output = summarize(&output)
        }
        Err(e) => {
            result.output = summarize(e.strip_prefix("failed:").unwrap_or(&e));
            result.error = Some(if e == "timeout" { "timeout" } else { "failed" }.into())
        }
    }
    result
}
#[tauri::command]
pub async fn agent_update(
    app: tauri::AppHandle,
    agent_id: String,
    terminals_released: Option<bool>,
) -> AgentUpdateResult {
    let terminals_released = terminals_released.unwrap_or(false);
    let agents = super::detect_agents(Some(true)).await.unwrap_or_default();
    let db = app.state::<DbConnection>().inner().clone();
    let fallback = agent_id.clone();
    tokio::task::spawn_blocking(move || {
        let failure=|reason:&str| AgentUpdateResult {agent_id:agent_id.clone(),ok:false,output:String::new(),new_version:None,error:Some(reason.into())};
        let operation=|| {
            let Ok(_gate)=UPDATE_GATE.try_write() else {return failure("failed")};
            if elevated() {return failure("failed")}
            let Some(agent)=agents.iter().find(|a|a.id==agent_id && a.available && update_def(&a.id).is_some()) else {return failure("no_updater")};
            let Ok(conn)=db.lock() else {return failure("check_failed")};
            let busy=busy_reason_with(&conn,&agent_id,terminals_released).unwrap_or(Some("check_failed")); drop(conn);
            if let Some(reason)=busy {return failure(reason)}
            let info=check_one(agent,busy,&OfficialExecutor);
            let mut result=update_with_executor(&agent_id,&info,&OfficialExecutor);
            if result.ok {
                result.new_version=if agent_id=="claude-code" {OfficialExecutor.execute(FixedCommand {program:"claude",args:&["--version"]},CHECK_TIMEOUT).ok().and_then(|s|super::version_line(s.as_bytes(),&[]))} else if info.install.as_deref()==Some("bun") {
                    OfficialExecutor.execute(BUN_LIST,CHECK_TIMEOUT).ok().zip(update_def(&agent_id).and_then(|d|d.package)).and_then(|(listing,package)|bun_global_version(&listing,package))
                } else {
                    OfficialExecutor.execute(FixedCommand {program:"npm",args:&["root","--global"]},CHECK_TIMEOUT).ok().and_then(|root|update_def(&agent_id).and_then(|d|d.package).and_then(|package|std::fs::read(PathBuf::from(root.trim()).join(package).join("package.json")).ok())).and_then(|raw|serde_json::from_slice::<serde_json::Value>(&raw).ok()).and_then(|m|m["version"].as_str().map(str::to_string))
                };
            } result
        };
        let result=operation();
        eprintln!("agent_update agent={} ok={} error={:?}",result.agent_id,result.ok,result.error);
        if let Ok(conn)=db.lock() {
            let _=conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_update_log (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, output TEXT NOT NULL, new_version TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");
            let _=conn.execute("INSERT INTO agent_update_log(agent_id,ok,error,output,new_version) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![result.agent_id,result.ok,result.error,result.output,result.new_version]);
        } result
    }).await.unwrap_or(AgentUpdateResult {agent_id:fallback,ok:false,output:String::new(),new_version:None,error:Some("failed".into())})
}

/// npm e bun que instalam do zero, e o texto do instalador que a ADE não executa.
///
/// Só entra aqui um `npm install` / `bun add` já fixo na tabela, com `--ignore-scripts`.
/// Instalador remoto (`curl | bash`, script do editor) fica em `manual` e a tela só mostra.
pub fn install_slots(id: &str) -> (Option<FixedCommand>, Option<FixedCommand>, Option<&'static str>) {
    if let Some(def) = update_def(id) {
        let npm = def.update.filter(|c| c.program == "npm" && c.args.first().copied() == Some("install"));
        if npm.is_some() || def.bun_update.is_some() {
            return (npm, def.bun_update, None);
        }
    }
    match id {
        "kimi-code" => (Some(KIMI_INSTALL_NPM), Some(KIMI_INSTALL_BUN), None),
        "claude-code" => (None, None, Some("npm install -g @anthropic-ai/claude-code")),
        "opencode" => (None, None, Some("npm install -g @opencode/cli")),
        "hermes" => (
            None,
            None,
            Some(if cfg!(windows) {
                "irm https://hermes-agent.nousresearch.com/install.ps1 | iex"
            } else {
                "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
            }),
        ),
        "cursor" => (
            None,
            None,
            Some(if cfg!(windows) {
                "irm 'https://cursor.com/install?win32=true' | iex"
            } else {
                "curl https://cursor.com/install -fsS | bash"
            }),
        ),
        _ => (None, None, None),
    }
}

pub fn choose_install(id: &str, bun_ok: bool, npm_ok: bool) -> Option<FixedCommand> {
    let (npm, bun, _) = install_slots(id);
    if bun_ok {
        if let Some(cmd) = bun {
            return Some(cmd);
        }
    }
    if npm_ok { npm } else { None }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallOffer {
    pub agent_id: String,
    pub can_install: bool,
    pub needs_runtime: bool,
    pub manual: Option<String>,
}

pub fn install_offer(id: &str, bun_ok: bool, npm_ok: bool) -> AgentInstallOffer {
    let (npm, bun, manual) = install_slots(id);
    let can = choose_install(id, bun_ok, npm_ok).is_some();
    AgentInstallOffer {
        agent_id: id.into(),
        can_install: can,
        needs_runtime: !can && (npm.is_some() || bun.is_some()),
        manual: if can { None } else { manual.map(str::to_string) },
    }
}

pub fn install_with_executor(
    id: &str,
    available: bool,
    bun_ok: bool,
    npm_ok: bool,
    exec: &impl UpdateExecutor,
) -> AgentUpdateResult {
    let mut result = AgentUpdateResult {
        agent_id: id.into(),
        ok: false,
        output: String::new(),
        new_version: None,
        error: None,
    };
    if available {
        result.error = Some("already_installed".into());
        return result;
    }
    let Some(command) = choose_install(id, bun_ok, npm_ok) else {
        let (npm, bun, _) = install_slots(id);
        result.error = Some(if npm.is_some() || bun.is_some() { "need_npm" } else { "no_installer" }.into());
        return result;
    };
    match exec.execute(command, UPDATE_TIMEOUT) {
        Ok(output) => {
            result.ok = true;
            result.output = summarize(&output);
        }
        Err(e) => {
            result.output = summarize(e.strip_prefix("failed:").unwrap_or(&e));
            result.error = Some(if e == "timeout" { "timeout" } else { "failed" }.into());
        }
    }
    result
}

fn runtime_present() -> (bool, bool) {
    let bun_ok = crate::util::find_program("bun").is_some();
    let npm_ok = crate::util::find_program("npm").is_some() && crate::util::find_program("node").is_some();
    (bun_ok, npm_ok)
}

#[tauri::command]
pub fn agent_install_offers() -> Vec<AgentInstallOffer> {
    let (bun_ok, npm_ok) = runtime_present();
    crate::agents::registry::AGENTS
        .iter()
        .filter(|a| a.id != "bash")
        .map(|a| install_offer(a.id, bun_ok, npm_ok))
        .collect()
}

#[tauri::command]
pub async fn agent_install(agent_id: String) -> AgentUpdateResult {
    let agents = super::detect_agents(Some(true)).await.unwrap_or_default();
    let fallback = agent_id.clone();
    tokio::task::spawn_blocking(move || {
        let failure = |reason: &str| AgentUpdateResult {
            agent_id: agent_id.clone(),
            ok: false,
            output: String::new(),
            new_version: None,
            error: Some(reason.into()),
        };
        let Ok(_gate) = UPDATE_GATE.try_write() else {
            return failure("running");
        };
        if elevated() {
            return failure("failed");
        }
        let available = agents.iter().any(|a| a.id == agent_id && a.available);
        let (bun_ok, npm_ok) = runtime_present();
        let result = install_with_executor(&agent_id, available, bun_ok, npm_ok, &OfficialExecutor);
        eprintln!("agent_install agent={} ok={} error={:?}", result.agent_id, result.ok, result.error);
        result
    })
    .await
    .unwrap_or(AgentUpdateResult {
        agent_id: fallback,
        ok: false,
        output: String::new(),
        new_version: None,
        error: Some("failed".into()),
    })
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
