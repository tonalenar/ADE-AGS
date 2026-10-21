//! Portal com um Chrome de verdade (protótipo).
//!
//! O navegador normal do canvas passa a página pelo proxy local (`preview`), e o login do Google recusa
//! esse tipo de navegador de propósito. Aqui o Portal mostra um Chrome real, com um perfil só do app
//! (`<dados>/real-browser-profile`): a pessoa faz login nele como num Chrome comum, a sessão fica no
//! perfil, e o Portal recebe a tela por `Page.startScreencast` e devolve mouse e teclado por CDP.
//!
//! A conexão CDP fica toda aqui no Rust: o Chrome não é aberto com `--remote-allow-origins`, então
//! nenhuma página (nem a do app, nem um site qualquer) consegue falar com a porta de depuração e
//! pegar a sessão logada.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

struct Browser {
    /// `None` quando o Chrome deste perfil já estava aberto (de uma sessão anterior do app).
    child: Option<std::process::Child>,
    port: u16,
}

struct Page {
    tx: mpsc::UnboundedSender<String>,
    pending: std::sync::Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

fn browser() -> &'static tokio::sync::Mutex<Option<Browser>> {
    static B: OnceLock<tokio::sync::Mutex<Option<Browser>>> = OnceLock::new();
    B.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn pages() -> &'static Mutex<HashMap<String, Page>> {
    static P: OnceLock<Mutex<HashMap<String, Page>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// O Chrome instalado; sem ele, o Edge (também Chromium, mesmo protocolo).
fn chrome_path() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    [
        env("ProgramFiles").map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
        env("ProgramFiles(x86)").map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
        env("LOCALAPPDATA").map(|p| p.join(r"Google\Chrome\Application\chrome.exe")),
        env("ProgramFiles(x86)").map(|p| p.join(r"Microsoft\Edge\Application\msedge.exe")),
        env("ProgramFiles").map(|p| p.join(r"Microsoft\Edge\Application\msedge.exe")),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::util::datadir::app_data_dir(app)?.join("real-browser-profile"))
}

/// A porta que o Chrome anotou em `DevToolsActivePort`, se ele responde nela.
async fn live_port(profile: &std::path::Path) -> Option<u16> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let port: u16 = text.lines().next()?.trim().parse().ok()?;
    let url = format!("http://127.0.0.1:{port}/json/version");
    reqwest::Client::new().get(url).timeout(Duration::from_secs(2)).send().await.ok()?.status().is_success().then_some(port)
}

/// Abre o Chrome do perfil do app (ou acha o que já está aberto) e devolve a porta CDP.
async fn ensure_browser(app: &AppHandle) -> Result<u16, String> {
    let mut slot = browser().lock().await;
    if let Some(b) = slot.as_mut() {
        let alive = match b.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => true,
        };
        if alive {
            let profile = profile_dir(app)?;
            if live_port(&profile).await == Some(b.port) {
                return Ok(b.port);
            }
        }
        *slot = None;
    }
    let profile = profile_dir(app)?;
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    if let Some(port) = live_port(&profile).await {
        *slot = Some(Browser { child: None, port });
        return Ok(port);
    }
    let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
    prepare_profile(&profile);
    let exe = chrome_path().ok_or("Não achei o Chrome nem o Edge instalados.")?;
    // Janela fora da tela: quem mostra a página é o Portal. Sem `--enable-automation` nem
    // `--headless`: para o site, é um Chrome comum. Os três `--disable-*` mantêm a página
    // desenhando com a janela fora de vista (senão o screencast para).
    let child = std::process::Command::new(exe)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args([
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-position=-32000,-32000",
            "--window-size=1280,800",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "about:blank",
        ])
        .spawn()
        .map_err(|e| format!("Não consegui abrir o Chrome: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(port) = live_port(&profile).await {
            *slot = Some(Browser { child: Some(child), port });
            return Ok(port);
        }
        if Instant::now() >= deadline {
            return Err("O Chrome abriu mas não respondeu na porta de depuração.".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// Abre (ou reabre) a página do Portal `id` no Chrome real e começa a mandar a tela.
#[tauri::command]
pub async fn real_browser_open(app: AppHandle, id: String, url: String, width: u32, height: u32) -> Result<(), String> {
    if pages().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id) {
        send_raw(&id, "Emulation.setDeviceMetricsOverride", metrics(width, height))?;
        return send_raw(&id, "Page.navigate", json!({ "url": url }));
    }
    let port = ensure_browser(&app).await?;
    let target: Value = reqwest::Client::new()
        .put(format!("http://127.0.0.1:{port}/json/new?{url}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let ws_url = target["webSocketDebuggerUrl"].as_str().ok_or("O Chrome não devolveu a página nova.")?.to_string();
    let (ws, _) = tokio_tungstenite::connect_async(ws_url).await.map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let pending: std::sync::Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Default::default();

    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let reader_tx = tx.clone();
    let reader_pending = pending.clone();
    let reader_id = id.clone();
    let reader_app = app.clone();
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(n) = v["id"].as_u64() {
                if let Some(done) = reader_pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&n) {
                    let _ = done.send(v["result"].clone());
                }
                continue;
            }
            match v["method"].as_str() {
                Some("Page.screencastFrame") => {
                    let p = &v["params"];
                    emit(&reader_app, "real-browser-frame", json!({
                        "id": reader_id,
                        "data": p["data"],
                        "width": p["metadata"]["deviceWidth"],
                        "height": p["metadata"]["deviceHeight"],
                    }));
                    let ack = json!({ "id": next_id(), "method": "Page.screencastFrameAck", "params": { "sessionId": p["sessionId"] } });
                    let _ = reader_tx.send(ack.to_string());
                }
                Some("Page.frameNavigated") if v["params"]["frame"]["parentId"].is_null() => {
                    emit(&reader_app, "real-browser-url", json!({ "id": reader_id, "url": v["params"]["frame"]["url"] }));
                }
                Some("Page.domContentEventFired") => {
                    emit(&reader_app, "real-browser-loaded", json!({ "id": reader_id }));
                }
                _ => {}
            }
        }
        pages().lock().unwrap_or_else(|e| e.into_inner()).remove(&reader_id);
        emit(&reader_app, "real-browser-closed", json!({ "id": reader_id }));
    });

    pages().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), Page { tx, pending });
    send_raw(&id, "Page.enable", json!({}))?;
    send_raw(&id, "Emulation.setDeviceMetricsOverride", metrics(width, height))?;
    send_raw(&id, "Page.startScreencast", json!({ "format": "jpeg", "quality": 80, "everyNthFrame": 1 }))
}

fn metrics(width: u32, height: u32) -> Value {
    json!({ "width": width.max(200), "height": height.max(200), "deviceScaleFactor": 1, "mobile": false })
}

fn send_raw(id: &str, method: &str, params: Value) -> Result<(), String> {
    let pages = pages().lock().unwrap_or_else(|e| e.into_inner());
    let page = pages.get(id).ok_or("O Chrome real deste Portal não está aberto.")?;
    let msg = json!({ "id": next_id(), "method": method, "params": params });
    page.tx.send(msg.to_string()).map_err(|_| "A conexão com o Chrome caiu.".to_string())
}

async fn call(id: &str, method: &str, params: Value) -> Result<Value, String> {
    let (done, wait) = oneshot::channel();
    let n = next_id();
    {
        let pages = pages().lock().unwrap_or_else(|e| e.into_inner());
        let page = pages.get(id).ok_or("O Chrome real deste Portal não está aberto.")?;
        page.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(n, done);
        let msg = json!({ "id": n, "method": method, "params": params });
        page.tx.send(msg.to_string()).map_err(|_| "A conexão com o Chrome caiu.".to_string())?;
    }
    tokio::time::timeout(Duration::from_secs(5), wait).await.map_err(|_| "O Chrome não respondeu.".to_string())?.map_err(|e| e.to_string())
}

/// Os comandos CDP que o Portal pode mandar: entrada, navegação e tamanho. Nada que leia cookies
/// ou rode script arbitrário.
const ALLOWED: &[&str] = &[
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Page.navigate",
    "Page.reload",
    "Emulation.setDeviceMetricsOverride",
];

#[tauri::command]
pub fn real_browser_send(id: String, method: String, params: Value) -> Result<(), String> {
    if !ALLOWED.contains(&method.as_str()) {
        return Err(format!("Comando não permitido no Chrome real: {method}"));
    }
    send_raw(&id, &method, params)
}

/// Voltar (-1) ou avançar (+1) no histórico da página.
#[tauri::command]
pub async fn real_browser_history(id: String, delta: i32) -> Result<(), String> {
    let history = call(&id, "Page.getNavigationHistory", json!({})).await?;
    let index = history["currentIndex"].as_i64().unwrap_or(0) + i64::from(delta);
    let Some(entry) = history["entries"].as_array().and_then(|e| e.get(usize::try_from(index).ok()?)) else {
        return Ok(());
    };
    send_raw(&id, "Page.navigateToHistoryEntry", json!({ "entryId": entry["id"] }))
}

/// Traz a janela do Chrome para a tela (`true`) ou a esconde de novo (`false`). Serve para quando
/// um site pede algo que o Portal não mostra (um diálogo do próprio Chrome, a chave de segurança…).
#[tauri::command]
pub async fn real_browser_window(id: String, show: bool) -> Result<(), String> {
    let win = call(&id, "Browser.getWindowForTarget", json!({})).await?;
    let window_id = win["windowId"].clone();
    let bounds = if show {
        json!({ "left": 120, "top": 80, "width": 1280, "height": 860, "windowState": "normal" })
    } else {
        json!({ "left": -32000, "top": -32000, "windowState": "normal" })
    };
    call(&id, "Browser.setWindowBounds", json!({ "windowId": window_id, "bounds": bounds })).await.map(|_| ())
}

/// Fecha a página do Portal. Fechada a última, fecha também o Chrome que o app abriu.
#[tauri::command]
pub async fn real_browser_close(id: String) -> Result<(), String> {
    let _ = call(&id, "Page.close", json!({})).await;
    let empty = {
        let mut pages = pages().lock().unwrap_or_else(|e| e.into_inner());
        pages.remove(&id);
        pages.is_empty()
    };
    if empty {
        if let Some(mut b) = browser().lock().await.take() {
            if let Some(child) = b.child.as_mut() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

/// Fecha o Chrome do perfil do app (o que o app abriu ou um que já estava aberto) e espera o perfil
/// ficar livre: o mesmo perfil não abre em dois Chromes.
async fn shutdown_browser(app: &AppHandle) -> Result<(), String> {
    let profile = profile_dir(app)?;
    let mut slot = browser().lock().await;
    pages().lock().unwrap_or_else(|e| e.into_inner()).clear();
    if let Some(port) = live_port(&profile).await {
        let version: Result<Value, _> = async {
            reqwest::Client::new().get(format!("http://127.0.0.1:{port}/json/version")).send().await?.json().await
        }
        .await;
        if let Some(ws_url) = version.ok().and_then(|v| v["webSocketDebuggerUrl"].as_str().map(str::to_string)) {
            if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(ws_url).await {
                let _ = ws.send(Message::Text(json!({ "id": 1, "method": "Browser.close" }).to_string().into())).await;
            }
        }
    }
    if let Some(mut b) = slot.take() {
        if let Some(child) = b.child.as_mut() {
            let deadline = Instant::now() + Duration::from_secs(8);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            let _ = child.kill();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while live_port(&profile).await.is_some() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // O Chrome solta o perfil um instante depois de parar de responder.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    Ok(())
}

/// Login numa conta (Google e outros que recusam navegador controlado): abre o perfil do app num
/// Chrome COMUM, sem porta de depuração, numa janela normal. A pessoa entra na conta ali; quando fecha
/// a janela, a sessão fica salva no perfil e o app avisa (`real-browser-login-done`) para o Portal
/// reabrir. Nada é disfarçado: quem faz o login é um Chrome sem nenhuma alteração.
#[tauri::command]
pub async fn real_browser_login(app: AppHandle, url: String) -> Result<(), String> {
    shutdown_browser(&app).await?;
    let profile = profile_dir(&app)?;
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    prepare_profile(&profile);
    let exe = chrome_path().ok_or("Não achei o Chrome nem o Edge instalados.")?;
    let mut child = std::process::Command::new(exe)
        .arg(format!("--user-data-dir={}", profile.display()))
        // Posição explícita: o perfil lembra a janela escondida do Chrome controlado, e sem isto a
        // janela de login abria fora da tela.
        .args(["--no-first-run", "--no-default-browser-check", "--window-position=120,80", "--window-size=1280,860", "--new-window", &url])
        .spawn()
        .map_err(|e| format!("Não consegui abrir o Chrome: {e}"))?;
    *login_pid().lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
        login_pid().lock().unwrap_or_else(|e| e.into_inner()).take();
        emit(&app, "real-browser-login-done", json!({}));
    });
    Ok(())
}

fn login_pid() -> &'static Mutex<Option<u32>> {
    static P: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

/// "Terminei o login": fecha a janela do Chrome comum como a pessoa faria (WM_CLOSE, sem `/F`), para o
/// Chrome gravar os cookies da sessão. Só força se ele não sair em 15 s. O aviso de fim vem da thread
/// que espera o processo, em `real_browser_login`.
#[tauri::command]
pub async fn real_browser_login_finish() -> Result<(), String> {
    let Some(pid) = *login_pid().lock().unwrap_or_else(|e| e.into_inner()) else { return Ok(()) };
    let close = |force: bool| {
        let mut cmd = std::process::Command::new("taskkill");
        if force {
            cmd.arg("/F");
        }
        let _ = cmd.args(["/T", "/PID", &pid.to_string()]).output();
    };
    close(false);
    let deadline = Instant::now() + Duration::from_secs(15);
    while login_pid().lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        if Instant::now() >= deadline {
            close(true);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

/// Desliga o "continuar rodando em segundo plano" do perfil (`Local State`): sem isso, fechar a janela
/// de login não encerrava o Chrome e o Portal ficava esperando para sempre.
fn prepare_profile(profile: &std::path::Path) {
    let path = profile.join("Local State");
    let mut state: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    state["background_mode"] = json!({ "enabled": false });
    let _ = std::fs::write(&path, state.to_string());
}
