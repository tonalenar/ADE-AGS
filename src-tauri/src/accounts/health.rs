//! ¿Esta cuenta funciona? Preguntándoselo a la CLI (o al proveedor), no al disco.
//!
//! El punto verde de la lista sale de un archivo marcador (ver `profiles::read_identity`):
//! dice que alguna vez hubo un login, no que siga valiendo. Acá se pregunta de verdad, con
//! el mismo entorno con que se lanzaría la cuenta:
//!
//! | Cuenta | Cómo |
//! |---|---|
//! | Claude Code, login | `claude auth status --json`: método, mail y plan |
//! | Claude Code, API key | `GET /v1/models` (gratis): 401/403 es una key inválida |
//! | Codex | `codex login status` |
//! | OpenCode | `opencode auth list`: cuántas credenciales tiene el perfil |
//!
//! Nada de esto gasta tokens. La key nunca aparece en lo que se devuelve.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use super::store::AccountKind;
use crate::database::DbConnection;

const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    /// La CLI (o el proveedor) dice que la cuenta está lista para usarse.
    Ok,
    /// No hay sesión: hay que hacer login (o la key se borró del llavero).
    NotLoggedIn,
    /// El proveedor rechazó la credencial.
    Invalid,
    /// No se pudo saber: sin red, la CLI no está, una respuesta que no se entiende.
    Unknown,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountHealth {
    pub status: HealthStatus,
    /// Lo que dijo la CLI o el proveedor, para mostrar tal cual (`claude.ai`, `HTTP 401`,
    /// `Logged in using ChatGPT`). Nunca la key.
    pub detail: String,
    pub email: Option<String>,
    /// El plan de la suscripción, cuando la CLI lo dice (`max`, `pro`).
    pub plan: Option<String>,
    pub checked_at: i64,
}

impl AccountHealth {
    fn new(status: HealthStatus, detail: impl Into<String>) -> Self {
        AccountHealth { status, detail: detail.into(), email: None, plan: None, checked_at: crate::util::now_ts() }
    }
}

/// Verifica una cuenta: una creada en la app (su id) o la del sistema (`system:<agente>`).
#[tauri::command]
pub async fn account_health(account_id: String, db: tauri::State<'_, DbConnection>) -> Result<AccountHealth, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || check(&db, &account_id))
        .await
        .map_err(|e| e.to_string())
}

fn check(db: &DbConnection, account_id: &str) -> AccountHealth {
    // La del sistema corre con el entorno de la app tal cual: es lo que reciben las tabs que
    // no eligen cuenta, así que es lo que hay que verificar.
    if let Some(agent_id) = account_id.strip_prefix("system:") {
        return check_cli(agent_id, &HashMap::new());
    }
    let row: Option<(String, String, Option<String>)> = db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT agent_id, kind, base_url FROM agent_accounts WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()
    });
    let Some((agent_id, kind, base_url)) = row else {
        return AccountHealth::new(HealthStatus::Unknown, "account not found");
    };
    if AccountKind::parse(&kind) == AccountKind::ApiKey && agent_id == "claude-code" {
        return match super::secrets::load(account_id) {
            Some(key) => check_anthropic_key(&key, base_url.as_deref()),
            None => AccountHealth::new(HealthStatus::NotLoggedIn, "API key missing from the system keyring"),
        };
    }
    match super::env_for_account(db, account_id) {
        Some(env) => check_cli(&agent_id, &env),
        None => AccountHealth::new(HealthStatus::Unknown, "account environment unavailable"),
    }
}

/// Corre la CLI con el entorno de la cuenta (sin lo que le ganaría al login, igual que al
/// lanzarla). `None` si no se pudo ni arrancar.
fn run_cli(agent_id: &str, args: &[&str], env: &HashMap<String, String>) -> Option<std::process::Output> {
    let program = crate::agents::agent_command(agent_id)?;
    let mut command = crate::util::program(program);
    command.args(args);
    crate::agents::apply_account_env(&mut command, env);
    crate::util::output_with_timeout(&mut command, CLI_TIMEOUT).ok()
}

fn check_cli(agent_id: &str, env: &HashMap<String, String>) -> AccountHealth {
    match agent_id {
        "claude-code" => match run_cli(agent_id, &["auth", "status", "--json"], env) {
            Some(out) => parse_claude_status(&String::from_utf8_lossy(&out.stdout)),
            None => AccountHealth::new(HealthStatus::Unknown, "could not run claude"),
        },
        "codex" => match run_cli(agent_id, &["login", "status"], env) {
            // Codex escribe el estado en stderr, no en stdout.
            Some(out) => parse_codex_status(out.status.success(), &combined(&out)),
            None => AccountHealth::new(HealthStatus::Unknown, "could not run codex"),
        },
        "opencode" => match run_cli(agent_id, &["auth", "list"], env) {
            Some(out) => parse_opencode_list(&String::from_utf8_lossy(&out.stdout)),
            None => AccountHealth::new(HealthStatus::Unknown, "could not run opencode"),
        },
        other => AccountHealth::new(HealthStatus::Unknown, format!("no health check for {other}")),
    }
}

pub(crate) fn combined(out: &std::process::Output) -> String {
    format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

/// `claude auth status --json`: `{"loggedIn": true, "authMethod": "claude.ai", "email": …,
/// "subscriptionType": "max"}`. Sale con 1 sin sesión, pero el JSON igual llega.
pub(crate) fn parse_claude_status(stdout: &str) -> AccountHealth {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return AccountHealth::new(HealthStatus::Unknown, "unexpected output from claude auth status");
    };
    let text = |key: &str| json.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let logged_in = json.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    let status = if logged_in { HealthStatus::Ok } else { HealthStatus::NotLoggedIn };
    let mut detail = text("authMethod").unwrap_or_else(|| "none".into());
    if let Some(source) = text("apiKeySource") {
        detail = format!("{detail} ({source})");
    }
    AccountHealth { email: text("email"), plan: text("subscriptionType"), ..AccountHealth::new(status, detail) }
}

/// `codex login status`: "Logged in using ChatGPT" / "Logged in using an API key - ***" con
/// 0, "Not logged in" con 1.
pub(crate) fn parse_codex_status(success: bool, stdout: &str) -> AccountHealth {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("WARNING")).unwrap_or("");
    let status = if success && line.starts_with("Logged in") { HealthStatus::Ok } else { HealthStatus::NotLoggedIn };
    AccountHealth::new(status, line)
}

/// `opencode auth list` termina con "N credentials". Un perfil de OpenCode guarda varios
/// proveedores: con al menos uno se puede usar.
pub(crate) fn parse_opencode_list(stdout: &str) -> AccountHealth {
    let count = strip_ansi(stdout).lines().find_map(|l| {
        let l = l.trim_start_matches(|c: char| !c.is_ascii_digit());
        let (n, rest) = l.split_once(' ')?;
        rest.trim().starts_with("credential").then(|| n.parse::<u32>().ok()).flatten()
    });
    match count {
        Some(0) => AccountHealth::new(HealthStatus::NotLoggedIn, "0 credentials"),
        Some(n) => AccountHealth::new(HealthStatus::Ok, format!("{n} credentials")),
        None => AccountHealth::new(HealthStatus::Unknown, "unexpected output from opencode auth list"),
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Una key de Anthropic (o de un gateway compatible) contra `GET /v1/models`, que no gasta
/// tokens. Un 401/403 es una key rechazada; un 200 de un gateway solo dice que respondió
/// (hay gateways que no piden la key para listar modelos).
fn check_anthropic_key(key: &str, base_url: Option<&str>) -> AccountHealth {
    let client = match reqwest::blocking::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return AccountHealth::new(HealthStatus::Unknown, e.to_string()),
    };
    let base = base_url.unwrap_or("https://api.anthropic.com");
    let mut request = client
        .get(format!("{base}/v1/models"))
        .header("anthropic-version", "2023-06-01")
        .header("x-api-key", key);
    if base_url.is_some() {
        request = request.bearer_auth(key);
    }
    match request.send() {
        Ok(response) => http_health(response.status().as_u16(), base_url.is_some()),
        // Sin el error completo: reqwest puede incluir la URL, y la del gateway es del
        // usuario, pero no hay razón para arriesgar nada más que eso.
        Err(e) if e.is_timeout() => AccountHealth::new(HealthStatus::Unknown, "timed out"),
        Err(_) => AccountHealth::new(HealthStatus::Unknown, "could not reach the endpoint"),
    }
}

pub(crate) fn http_health(code: u16, gateway: bool) -> AccountHealth {
    let detail = format!("HTTP {code}");
    match code {
        200 if gateway => AccountHealth::new(HealthStatus::Ok, format!("{detail} (gateway)")),
        200 => AccountHealth::new(HealthStatus::Ok, detail),
        401 | 403 => AccountHealth::new(HealthStatus::Invalid, detail),
        _ => AccountHealth::new(HealthStatus::Unknown, detail),
    }
}

/// `codex login --with-api-key` en el perfil `dir`, con la key por stdin: en argumentos se
/// vería en la lista de procesos. Codex la guarda en `dir/auth.json`, como un login de ChatGPT.
pub(super) fn codex_login_with_api_key(dir: &Path, key: &str) -> Result<(), String> {
    let program = crate::agents::agent_command("codex").ok_or("codex no está registrado")?;
    let mut command = crate::util::program(program);
    command
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", dir)
        // Ni una key heredada de la app ni otra cuenta: solo la que se está guardando.
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("No se pudo ejecutar codex: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{key}\n").as_bytes())
            .map_err(|e| format!("No se pudo pasar la key a codex: {e}"))?;
    } // stdin se cierra acá: codex deja de esperar.
    let deadline = std::time::Instant::now() + CLI_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
                }
                let reason = stderr.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("WARNING")).unwrap_or("");
                return Err(format!("codex no aceptó la API key: {reason}"));
            }
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                return Err("codex login tardó demasiado".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}
