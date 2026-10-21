//! Portal com um Chrome de verdade.
//!
//! O navegador normal do canvas passa a página pelo proxy local (`preview`), e o Google recusa login em
//! navegador embutido de propósito: o app intermediário veria a senha. Aqui o Portal usa um Chrome real com
//! um perfil só do app (`<dados>/real-browser-profile`), em dois modos:
//!
//! - **Navegar** (o normal): o Chrome é aberto com `--remote-debugging-port=0` e fica fora da tela, sem
//!   botão na barra de tarefas. Cada Portal tem a **própria janela** do Chrome (o Chrome só desenha a aba
//!   ativa de cada janela; com várias abas numa janela só, os outros Portais congelavam). A tela chega por
//!   `Page.startScreencast` e mouse e teclado voltam por CDP. A porta 0 faz o Chrome se declarar
//!   automatizado (`navigator.webdriver`, ver MDN), e assim fica: o app não esconde isso de site nenhum.
//! - **Entrar numa conta**: por isso mesmo, o Google recusa o login no modo acima — e a tentativa ainda
//!   marca o perfil. O login é feito num Chrome COMUM (sem porta de depuração, sem nenhuma alteração), no
//!   mesmo perfil, numa janela que o app posiciona em cima do Portal (ver `win`). A pessoa digita direto no
//!   Chrome, que mostra o endereço; a senha não passa pelo app, que é o que o Google pede.
//!
//! A conexão CDP fica toda aqui no Rust: o Chrome não é aberto com `--remote-allow-origins`, então nenhuma
//! página (nem a do app, nem um site) consegue falar com a porta de depuração e pegar a sessão logada.
//! Os dois Chromes vão num Job Object (`terminal::containment`): morrem com o app, mesmo num fechamento
//! à força, e não sobra Chrome órfão segurando o perfil.

#[cfg(windows)]
mod win;
#[cfg(not(windows))]
mod win {
    //! Fora do Windows a janela de login abre como uma janela comum do Chrome.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Rect {
        pub x: i32,
        pub y: i32,
        pub w: i32,
        pub h: i32,
    }
    pub fn hide_from_taskbar(_: isize) {}
    pub fn adopt_as_owned(_: isize, _: isize) {}
    pub fn place(_: isize, _: Option<Rect>) {}
    pub fn focus(_: isize) {}
    pub fn close(_: isize) {}
    pub fn watch_windows(_: u32, _: impl FnMut(isize, bool) + Send + 'static) {}
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::terminal::containment::ProcessGroup;

pub use win::Rect;

/// O Chrome controlado. O `ProcessGroup` (Job Object) leva junto o Chrome e todos os processos dele.
struct Browser {
    child: std::process::Child,
    group: ProcessGroup,
    port: u16,
}

struct Page {
    target: String,
    tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

/// A janela de login em andamento.
struct Login {
    pid: u32,
    group: ProcessGroup,
    /// A janela do Chrome, quando aparecer.
    hwnd: Option<isize>,
    /// Onde ela deve ficar (em cima do Portal); `None` = o Portal não está à vista.
    rect: Option<Rect>,
}

fn browser() -> &'static tokio::sync::Mutex<Option<Browser>> {
    static B: OnceLock<tokio::sync::Mutex<Option<Browser>>> = OnceLock::new();
    B.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn pages() -> &'static Mutex<HashMap<String, Page>> {
    static P: OnceLock<Mutex<HashMap<String, Page>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A última posição do Portal que o front mandou durante um login. Fica fora de `Login` porque as primeiras chegam
/// enquanto o Chrome controlado ainda está fechando, antes de o login existir: sem isto a janela abria onde o Portal
/// estava no clique (com a barra dele ainda à vista) e não saía mais de lá.
fn last_place() -> &'static Mutex<Option<Option<Rect>>> {
    static P: OnceLock<Mutex<Option<Option<Rect>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

fn login() -> &'static Mutex<Option<Login>> {
    static L: OnceLock<Mutex<Option<Login>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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
    let dir = crate::util::datadir::app_data_dir(app)?.join("real-browser-profile");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Desliga o "continuar rodando em segundo plano" do perfil (`Local State`): sem isso, fechar a janela de
/// login não encerrava o Chrome e o Portal ficava esperando.
fn prepare_profile(profile: &Path) {
    let path = profile.join("Local State");
    let mut state: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    state["background_mode"] = json!({ "enabled": false });
    let _ = std::fs::write(&path, state.to_string());
}

/// O Chrome sem nada além do perfil e das telas de boas-vindas desligadas.
fn chrome(profile: &Path) -> Result<std::process::Command, String> {
    let exe = chrome_path().ok_or("Não achei o Chrome nem o Edge instalados.")?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"]);
    Ok(cmd)
}

/// A porta que o Chrome anotou em `DevToolsActivePort`, se ele responde nela.
async fn live_port(profile: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let port: u16 = text.lines().next()?.trim().parse().ok()?;
    let url = format!("http://127.0.0.1:{port}/json/version");
    reqwest::Client::new().get(url).timeout(Duration::from_secs(2)).send().await.ok()?.status().is_success().then_some(port)
}

/// Um comando no nível do navegador (não de uma página), numa conexão curta.
async fn browser_call(port: u16, method: &str, params: Value) -> Result<Value, String> {
    let version: Value = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let ws_url = version["webSocketDebuggerUrl"].as_str().ok_or("O Chrome não respondeu.")?;
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.map_err(|e| e.to_string())?;
    ws.send(Message::Text(json!({ "id": 1, "method": method, "params": params }).to_string().into()))
        .await
        .map_err(|e| e.to_string())?;
    let reply = async {
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            if v["id"] == 1 {
                return match v.get("error") {
                    Some(err) => Err(err["message"].as_str().unwrap_or("erro do Chrome").to_string()),
                    None => Ok(v["result"].clone()),
                };
            }
        }
        Err("A conexão com o Chrome caiu.".to_string())
    };
    tokio::time::timeout(Duration::from_secs(10), reply).await.map_err(|_| "O Chrome não respondeu.".to_string())?
}

/// Abre o Chrome controlado do perfil (ou devolve a porta do que já está aberto).
async fn ensure_browser(app: &AppHandle) -> Result<u16, String> {
    let mut slot = browser().lock().await;
    if let Some(b) = slot.as_mut() {
        if matches!(b.child.try_wait(), Ok(None)) {
            return Ok(b.port);
        }
        *slot = None;
    }
    if lock(login()).is_some() {
        return Err("Há um login em andamento: termine-o para o Portal voltar.".into());
    }
    let profile = profile_dir(app)?;
    // Um Chrome de uma versão anterior do app (sem Job Object) pode ter ficado aberto no perfil.
    if let Some(port) = live_port(&profile).await {
        let _ = browser_call(port, "Browser.close", json!({})).await;
        wait_profile_free(&profile).await;
    }
    let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
    prepare_profile(&profile);
    // Fora da tela e fora da barra de tarefas: quem mostra a página é o Portal. Os `--disable-*` mantêm
    // a página desenhando com a janela fora de vista (senão o screencast para).
    let child = chrome(&profile)?
        .args([
            "--remote-debugging-port=0",
            "--window-position=-32000,-32000",
            "--window-size=1280,800",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            // Barra de rolagem sobreposta (fina, sem setas, por cima do conteúdo, sem reservar largura), que o
            // Chromium traz desligada no desktop. Medido no Chrome 155: `FluentOverlayScrollbar` sozinha não muda
            // nada; esta sim. Só neste Chrome: a janela de login não leva nenhuma alteração.
            "--enable-features=OverlayScrollbar",
            "about:blank",
        ])
        .spawn()
        .map_err(|e| format!("Não consegui abrir o Chrome: {e}"))?;
    let mut group = ProcessGroup::new(child.id());
    group.adopt(&child);
    win::watch_windows(child.id(), |hwnd, _| win::hide_from_taskbar(hwnd));
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(port) = live_port(&profile).await {
            *slot = Some(Browser { child, group, port });
            return Ok(port);
        }
        if Instant::now() >= deadline {
            return Err("O Chrome abriu mas não respondeu na porta de depuração.".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Espera o perfil ficar livre (o mesmo perfil não abre em dois Chromes).
async fn wait_profile_free(profile: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while live_port(profile).await.is_some() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // O Chrome solta o perfil um instante depois de parar de responder.
    tokio::time::sleep(Duration::from_millis(800)).await;
}

/// Fecha o Chrome controlado: primeiro como o X da janela (grava a sessão), depois à força.
async fn shutdown_browser(app: &AppHandle) -> Result<(), String> {
    let mut slot = browser().lock().await;
    lock(pages()).clear();
    let Some(mut b) = slot.take() else { return Ok(()) };
    let _ = browser_call(b.port, "Browser.close", json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(8);
    while matches!(b.child.try_wait(), Ok(None)) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    b.group.kill_all();
    wait_profile_free(&profile_dir(app)?).await;
    Ok(())
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// Abre (ou reabre) a janela do Portal `id` no Chrome controlado e começa a mandar a tela.
#[tauri::command]
pub async fn real_browser_open(app: AppHandle, id: String, url: String, width: u32, height: u32, scale: Option<f64>) -> Result<(), String> {
    let scale = scale.filter(|s| *s > 0.0).unwrap_or(1.0);
    if lock(pages()).contains_key(&id) {
        send_raw(&id, "Emulation.setDeviceMetricsOverride", metrics(width, height, scale))?;
        return send_raw(&id, "Page.navigate", json!({ "url": url }));
    }
    let port = ensure_browser(&app).await?;
    // Uma janela por Portal, fora da tela.
    let created = browser_call(port, "Target.createTarget", json!({
        "url": url, "newWindow": true, "left": -32000, "top": -32000, "width": width.max(200), "height": height.max(200),
    }))
    .await?;
    let target = created["targetId"].as_str().ok_or("O Chrome não abriu a janela do Portal.")?.to_string();
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/devtools/page/{target}"))
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Default::default();

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
    let reader_target = target.clone();
    let reader_app = app.clone();
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(n) = v["id"].as_u64() {
                if let Some(done) = lock(&reader_pending).remove(&n) {
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
                _ => {}
            }
        }
        // Só esquece a página se ela ainda é esta (um Portal reaberto já tem outra).
        let mut pages = lock(pages());
        if pages.get(&reader_id).is_some_and(|p| p.target == reader_target) {
            pages.remove(&reader_id);
        }
        drop(pages);
        emit(&reader_app, "real-browser-closed", json!({ "id": reader_id }));
    });

    lock(pages()).insert(id.clone(), Page { target, tx, pending });
    send_raw(&id, "Page.enable", json!({}))?;
    send_raw(&id, "Emulation.setDeviceMetricsOverride", metrics(width, height, scale))?;
    // A janela fica fora de foco o tempo todo; sem isto o cursor de texto nem pisca e alguns campos
    // não reagem como se estivessem focados.
    send_raw(&id, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true }))?;
    send_raw(&id, "Page.startScreencast", json!({ "format": "jpeg", "quality": 80, "everyNthFrame": 1 }))
}

/// O tamanho da página em pixels CSS e quantos pixels de verdade cada um tem (zoom da página × densidade da tela).
fn metrics(width: u32, height: u32, scale: f64) -> Value {
    json!({ "width": width.max(200), "height": height.max(200), "deviceScaleFactor": scale, "mobile": false })
}

fn send_raw(id: &str, method: &str, params: Value) -> Result<(), String> {
    let pages = lock(pages());
    let page = pages.get(id).ok_or("O Chrome real deste Portal não está aberto.")?;
    let msg = json!({ "id": next_id(), "method": method, "params": params });
    page.tx.send(msg.to_string()).map_err(|_| "A conexão com o Chrome caiu.".to_string())
}

async fn call(id: &str, method: &str, params: Value) -> Result<Value, String> {
    let (done, wait) = oneshot::channel();
    let n = next_id();
    {
        let pages = lock(pages());
        let page = pages.get(id).ok_or("O Chrome real deste Portal não está aberto.")?;
        lock(&page.pending).insert(n, done);
        let msg = json!({ "id": n, "method": method, "params": params });
        page.tx.send(msg.to_string()).map_err(|_| "A conexão com o Chrome caiu.".to_string())?;
    }
    tokio::time::timeout(Duration::from_secs(5), wait).await.map_err(|_| "O Chrome não respondeu.".to_string())?.map_err(|e| e.to_string())
}

/// Os comandos CDP que o Portal pode mandar: entrada, navegação e tamanho. Nada que leia cookies ou rode
/// script arbitrário.
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

/// Fecha a janela do Portal. Fechada a última, fecha também o Chrome.
#[tauri::command]
pub async fn real_browser_close(app: AppHandle, id: String) -> Result<(), String> {
    let (target, empty) = {
        let mut pages = lock(pages());
        let target = pages.remove(&id).map(|p| p.target);
        (target, pages.is_empty())
    };
    let port = browser().lock().await.as_ref().map(|b| b.port);
    if let (Some(port), Some(target)) = (port, target) {
        let _ = browser_call(port, "Target.closeTarget", json!({ "targetId": target })).await;
    }
    if empty {
        shutdown_browser(&app).await?;
    }
    Ok(())
}

/// Onde o Portal está na janela do app, em pixels CSS (o `getBoundingClientRect` dele), e quantos pixels
/// físicos vale um pixel CSS ali (`devicePixelRatio`). A escala vem da página e não do monitor: ela já
/// inclui o zoom do próprio app.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PortalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// A menor janela de login que ainda mostra a página inteira; num Portal menor (canvas com zoom baixo)
/// ela fica centrada sobre ele.
const LOGIN_MIN: (i32, i32) = (480, 600);

/// O retângulo de tela (pixels físicos) da janela de login sobre o Portal. Pura.
pub fn login_rect(portal: PortalRect, client_origin: (i32, i32)) -> Rect {
    let scale = if portal.scale > 0.0 { portal.scale } else { 1.0 };
    let w = ((portal.width * scale).round() as i32).max(LOGIN_MIN.0);
    let h = ((portal.height * scale).round() as i32).max(LOGIN_MIN.1);
    let cx = client_origin.0 as f64 + (portal.x + portal.width / 2.0) * scale;
    let cy = client_origin.1 as f64 + (portal.y + portal.height / 2.0) * scale;
    Rect { x: (cx - w as f64 / 2.0).round() as i32, y: (cy - h as f64 / 2.0).round() as i32, w, h }
}

fn screen_rect(window: &WebviewWindow, portal: Option<PortalRect>) -> Option<Rect> {
    let portal = portal.filter(|p| p.width >= 1.0 && p.height >= 1.0)?;
    let origin = window.inner_position().ok()?;
    Some(login_rect(portal, (origin.x, origin.y)))
}

/// Login numa conta: fecha o Chrome controlado e abre o perfil num Chrome COMUM, em cima do Portal. A
/// sessão fica no perfil; quando a janela fecha, o app avisa (`real-browser-login-done`) e o Portal volta.
#[tauri::command]
pub async fn real_browser_login(app: AppHandle, window: WebviewWindow, url: String, rect: Option<PortalRect>) -> Result<(), String> {
    if lock(login()).is_some() {
        return Ok(());
    }
    *lock(last_place()) = Some(screen_rect(&window, rect));
    shutdown_browser(&app).await?;
    let profile = profile_dir(&app)?;
    prepare_profile(&profile);
    // Começa fora da tela: só aparece quando já estiver em cima do Portal.
    let mut child = chrome(&profile)?
        .args(["--window-position=-32000,-32000", "--window-size=1280,860", "--new-window", &url])
        .spawn()
        .map_err(|e| format!("Não consegui abrir o Chrome: {e}"))?;
    let pid = child.id();
    let mut group = ProcessGroup::new(pid);
    group.adopt(&child);
    let rect = lock(last_place()).unwrap_or_else(|| screen_rect(&window, rect));
    *lock(login()) = Some(Login { pid, group, hwnd: None, rect });

    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = 0isize;
    win::watch_windows(pid, move |hwnd, frame| {
        let mut slot = lock(login());
        let Some(l) = slot.as_mut().filter(|l| l.pid == pid) else { return };
        if !frame {
            return;
        }
        if l.hwnd.is_none() {
            l.hwnd = Some(hwnd);
            win::adopt_as_owned(hwnd, owner);
            win::place(hwnd, l.rect);
            if l.rect.is_some() {
                win::focus(hwnd);
            }
        } else if Some(hwnd) != l.hwnd {
            // Outra janela do mesmo login (um pop-up do Google): também fica com o app como dono.
            win::adopt_as_owned(hwnd, owner);
            win::place(hwnd, l.rect);
        }
    });

    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
        lock(login()).take();
        lock(last_place()).take();
        emit(&app, "real-browser-login-done", json!({}));
    });
    Ok(())
}

/// O Portal mudou de lugar (canvas arrastado, zoom, janela do app movida) ou saiu de vista (`None`).
#[tauri::command]
pub fn real_browser_login_place(window: WebviewWindow, rect: Option<PortalRect>) {
    let rect = screen_rect(&window, rect);
    {
        let mut last = lock(last_place());
        if last.is_some() {
            *last = Some(rect);
        }
    }
    let mut slot = lock(login());
    let Some(l) = slot.as_mut() else { return };
    if l.rect == rect {
        return;
    }
    l.rect = rect;
    if let Some(hwnd) = l.hwnd {
        win::place(hwnd, rect);
    }
}

/// "Terminei o login": fecha a janela como o X dela (o Chrome grava a sessão e sai). Só força se ele
/// não sair em 15 s. O aviso de fim vem da thread que espera o processo, em `real_browser_login`.
#[tauri::command]
pub async fn real_browser_login_finish() -> Result<(), String> {
    let Some((pid, hwnd)) = lock(login()).as_ref().map(|l| (l.pid, l.hwnd)) else { return Ok(()) };
    if let Some(hwnd) = hwnd {
        win::close(hwnd);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while lock(login()).as_ref().is_some_and(|l| l.pid == pid) {
        if Instant::now() >= deadline {
            if let Some(l) = lock(login()).as_mut() {
                l.group.kill_all();
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::{login_rect, PortalRect, Rect};

    #[test]
    fn janela_de_login_fica_em_cima_do_portal() {
        let portal = PortalRect { x: 100.0, y: 50.0, width: 800.0, height: 700.0, scale: 1.25 };
        // Janela do app em (10, 20), página em 125%.
        assert_eq!(login_rect(portal, (10, 20)), Rect { x: 135, y: 83, w: 1000, h: 875 });
    }

    #[test]
    fn portal_pequeno_ganha_janela_minima_centrada_nele() {
        let portal = PortalRect { x: 0.0, y: 0.0, width: 200.0, height: 100.0, scale: 1.0 };
        assert_eq!(login_rect(portal, (0, 0)), Rect { x: -140, y: -250, w: 480, h: 600 });
    }
}
