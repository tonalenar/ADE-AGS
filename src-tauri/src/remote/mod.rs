//! MCP remoto por HTTP (localhost e Tailscale), com pareamento por token no keyring.
//!
//! O servidor nasce desligado e nunca escuta em `0.0.0.0` nem `::`.

pub mod approval;
pub mod clients;
pub mod http;
#[cfg(test)]
mod test;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use clients::{Preset, RemoteClient, authenticate, list, pair, revoke};

/// Porta padrão do servidor MCP HTTP (configurável).
pub const DEFAULT_PORT: u16 = 47820;

const SETTING_ENABLED: &str = "remote_mcp_enabled";
const SETTING_PORT: &str = "remote_mcp_port";
const CLIENTS_CHANGED_EVENT: &str = "cc-remote-clients-changed";

static ACTIVE: LazyLock<Mutex<Option<http::RunningServer>>> = LazyLock::new(|| Mutex::new(None));

/// Estado atual do servidor MCP remoto para a tela de Configurações.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub tailscale_ip: Option<String>,
    pub bind_addrs: Vec<String>,
}

/// Resposta única do pareamento: o token bruto é devolvido só aqui e nunca fica salvo em claro.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedClientResult {
    pub client: RemoteClient,
    pub token: String,
}

/// Confere se um IPv4 pertence à faixa CGNAT do Tailscale (`100.64.0.0/10`).
pub fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// Endereços em que o servidor escuta na porta padrão: `127.0.0.1` e, se houver, o IP Tailscale (`100.x`).
/// Nunca devolve `0.0.0.0` nem `::`.
pub fn bind_addrs(tailscale_ip: Option<Ipv4Addr>) -> Vec<SocketAddr> {
    bind_addrs_on(tailscale_ip, DEFAULT_PORT)
}

/// Endereços em que o servidor escuta numa porta específica. Nunca devolve `0.0.0.0` nem `::`.
pub fn bind_addrs_on(tailscale_ip: Option<Ipv4Addr>, port: u16) -> Vec<SocketAddr> {
    let mut addrs = vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))];
    if let Some(ip) = tailscale_ip
        && !ip.is_unspecified()
        && !ip.is_loopback()
        && is_tailscale_ipv4(ip)
    {
        addrs.push(SocketAddr::from((ip, port)));
    }
    addrs
}

/// Detecta o IP IPv4 do Tailscale usando `tailscale ip -4` (via `util::spawn`).
/// No macOS, também procura o binário dentro de `/Applications/Tailscale.app`.
pub fn detect_tailscale_ip() -> Option<Ipv4Addr> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
    } else {
        &["tailscale"]
    };

    for program in candidates {
        let mut cmd = crate::util::spawn::hidden_command(program);
        cmd.args(["ip", "-4"]);
        let Ok(output) = crate::util::spawn::output(&mut cmd, Duration::from_secs(3)) else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(ip) = line.trim().parse::<Ipv4Addr>()
                && is_tailscale_ipv4(ip)
            {
                return Some(ip);
            }
        }
    }
    None
}

fn configured_port(app: &AppHandle) -> u16 {
    let Some(db) = app.try_state::<crate::database::DbConnection>() else {
        return DEFAULT_PORT;
    };
    crate::database::get_setting(&db, SETTING_PORT)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port >= 1024)
        .unwrap_or(DEFAULT_PORT)
}

fn configured_enabled(app: &AppHandle) -> bool {
    let Some(db) = app.try_state::<crate::database::DbConnection>() else {
        return false;
    };
    // O servidor nasce sempre desligado até a pessoa ativar nas configurações.
    crate::database::get_setting(&db, SETTING_ENABLED)
        .ok()
        .flatten()
        .is_some_and(|raw| raw.trim() == "true")
}

/// Inicia o servidor MCP HTTP no arranque somente se a pessoa o deixou ligado nas configurações.
pub fn start_if_enabled(app: AppHandle) {
    if !configured_enabled(&app) {
        return;
    }
    let port = configured_port(&app);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start_server(app, port).await {
            eprintln!("[ade-ags] não foi possível iniciar o servidor MCP remoto: {error}");
        }
    });
}

/// Encerra o servidor MCP HTTP se estiver rodando.
pub fn stop() {
    if let Some(running) = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).take() {
        running.shutdown();
    }
}

pub async fn start_server(app: AppHandle, port: u16) -> Result<Vec<SocketAddr>, String> {
    stop();
    let tailscale_ip = tokio::task::spawn_blocking(detect_tailscale_ip)
        .await
        .ok()
        .flatten();
    let addrs = bind_addrs_on(tailscale_ip, port);
    let config = http::ServerConfig {
        store: clients::ClientStore::default_store(),
        handler: Arc::new(move |client, req| {
            let context = crate::ipc::mcp::McpContext::remote_from_client(client);
            let app = app.clone();
            let client_id = client.id.clone();
            let preset = client.preset;
            crate::ipc::mcp::handle_frame(&context, "", &req, &mut |command, args| {
                crate::ipc::dispatch_in_process(
                    &app,
                    command,
                    args,
                    crate::terminal::Principal::Remote {
                        client: client_id.clone(),
                        preset,
                    },
                )
            })
        }),
        audit: http::default_audit_sink(),
        now_fn: Arc::new(crate::util::now_ts),
    };
    let running = http::start_on(&addrs, config).await?;
    let bound = running.addrs().to_vec();
    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
    Ok(bound)
}

fn current_status_sync(app: &AppHandle, tailscale_ip: Option<Ipv4Addr>) -> RemoteServerStatus {
    let enabled = configured_enabled(app);
    let port = configured_port(app);
    let guard = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    let (running, bind_addrs) = match guard.as_ref() {
        Some(active) => (
            true,
            active.addrs().iter().map(|a| a.to_string()).collect(),
        ),
        None => (
            false,
            bind_addrs_on(tailscale_ip, port)
                .into_iter()
                .map(|a| a.to_string())
                .collect(),
        ),
    };
    RemoteServerStatus {
        enabled,
        running,
        port,
        tailscale_ip: tailscale_ip.map(|ip| ip.to_string()),
        bind_addrs,
    }
}

#[tauri::command]
pub async fn remote_status(app: AppHandle) -> Result<RemoteServerStatus, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ts = detect_tailscale_ip();
        current_status_sync(&app_clone, ts)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_set_enabled(
    app: AppHandle,
    enabled: bool,
    port: Option<u16>,
) -> Result<RemoteServerStatus, String> {
    if let Some(p) = port
        && p < 1024
    {
        return Err("Escolha uma porta entre 1024 e 65535".into());
    }
    let app_save = app.clone();
    let effective_port = tauri::async_runtime::spawn_blocking(move || -> Result<u16, String> {
        let Some(db) = app_save.try_state::<crate::database::DbConnection>() else {
            return Err("Banco de dados indisponível".into());
        };
        crate::database::set_setting(&db, SETTING_ENABLED, if enabled { "true" } else { "false" })?;
        let p = port.unwrap_or_else(|| configured_port(&app_save));
        crate::database::set_setting(&db, SETTING_PORT, &p.to_string())?;
        Ok(p)
    })
    .await
    .map_err(|e| e.to_string())??;

    if enabled {
        start_server(app.clone(), effective_port).await?;
    } else {
        stop();
    }

    let app_status = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ts = detect_tailscale_ip();
        current_status_sync(&app_status, ts)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_clients_list() -> Result<Vec<RemoteClient>, String> {
    tauri::async_runtime::spawn_blocking(clients::list)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_client_pair(
    app: AppHandle,
    name: String,
    preset: Preset,
    folders: Vec<String>,
    default_folder: String,
    ttl_days: Option<u32>,
) -> Result<PairedClientResult, String> {
    let (client, token) = tauri::async_runtime::spawn_blocking(move || {
        clients::pair(&name, preset, folders, &default_folder, ttl_days)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(CLIENTS_CHANGED_EVENT, ());
    Ok(PairedClientResult { client, token })
}

#[tauri::command]
pub async fn remote_client_revoke(app: AppHandle, id: String) -> Result<bool, String> {
    let revoked = tauri::async_runtime::spawn_blocking(move || clients::revoke(&id))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.emit(CLIENTS_CHANGED_EVENT, ());
    Ok(revoked)
}
