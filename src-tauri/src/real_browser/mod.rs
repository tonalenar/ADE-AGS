//! O navegador do Portal: um WebView2 de verdade dentro da janela do app, como o navegador do T3 Code.
//!
//! O T3 Code (Electron) mostra sites numa `<webview>`: um Chromium embutido, com perfil próprio
//! (`persist:t3code-preview-…`), o user agent padrão e o controle do agente pelo `webContents.debugger` — o CDP de
//! dentro do processo, sem porta de depuração, então a página nunca se vê automatizada (`navigator.webdriver`
//! falso). O Google aceita o login nele sem nada especial: não há troca de user agent nem cópia de cookies.
//! O equivalente aqui é um WebView2 numa janela filha dentro da janela do app, criado direto pela API do WebView2
//! (ver `native`: um `Webview` filho do Tauri faz a janela principal deixar de ser achada pelo nome):
//!
//! - **Perfil próprio**: `<dados>/portal-webview`, uma pasta de dados só dos Portais (o WebView2 sobe outro
//!   navegador para ela), separada da do app. O login fica nela entre as sessões.
//! - **CDP de dentro**: `ICoreWebView2::CallDevToolsProtocolMethod` e `GetDevToolsProtocolEventReceiver`, o
//!   mesmo papel do `webContents.debugger`. Por ele passam o piloto dos agentes (o script em todo documento, o
//!   canal `Runtime.addBinding`), as fotos e os toques de verdade que o piloto pede.
//! - **Pop-ups de verdade**: um `window.open` com tamanho (o login do Google, OAuth) abre a janela do próprio
//!   WebView2, com o `opener` vivo, como a `BrowserWindow` filha do T3. Um link para aba nova abre no mesmo Portal.
//! - **Nada navega sozinho**: só a barra de endereço (`real_browser_navigate`), os botões e o agente mandam
//!   navegar. A URL que a página informa vai para a barra e para o estado salvo, e nunca volta como navegação —
//!   no T3 o `src` da `<webview>` é fixado na criação pelo mesmo motivo.
//!
//! A página é uma janela nativa por cima do app: quem decide onde ela fica é o Portal (`real_browser_place`),
//! que manda o retângulo dele, a parte à vista e os buracos onde há algo do app por cima (menus, diálogos,
//! painéis). Aqui isso vira a região da janela (`SetWindowRgn`): fora dela a página não aparece nem recebe
//! clique, e o app por baixo aparece. Fora de vista a região fica vazia, sem esconder a página: ela continua
//! desenhando, e as fotos dos agentes saem mesmo com o Portal em outra aba.

#[cfg(windows)]
mod native;
#[cfg(not(windows))]
mod native {
    //! Fora do Windows ainda não há navegador nativo no Portal.
    use serde_json::Value;
    use tauri::AppHandle;
    const NO: &str = "O navegador do Portal por enquanto só existe no Windows.";
    pub async fn create(_: &AppHandle, _: isize, _: &str, _: std::path::PathBuf, _: String, _: [i32; 4]) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn cdp(_: &AppHandle, _: &str, _: &str, _: Value) -> Result<Value, String> {
        Err(NO.into())
    }
    pub fn place(_: &AppHandle, _: &str, _: [i32; 4], _: f64, _: Vec<[i32; 4]>) {}
    pub async fn navigate(_: &AppHandle, _: &str, _: String) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn history(_: &AppHandle, _: &str, _: i32) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn focus(_: &AppHandle, _: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn close(_: &AppHandle, _: &str) {}
    pub async fn add_script(_: &AppHandle, _: &str, _: String) -> Result<(), String> {
        Err(NO.into())
    }
}

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Um retângulo em pixels CSS do app.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Onde o Portal está: `rect` relativo à janela; `visible` e `holes` relativos ao próprio Portal.
#[derive(Debug, Clone, Deserialize)]
pub struct Place {
    pub rect: Rect,
    /// O zoom da página (o do Portal vezes o do canvas).
    pub zoom: f64,
    /// A parte do Portal à vista (o resto está fora do canvas ou atrás de outra aba). `None` = nada à vista.
    pub visible: Option<Rect>,
    /// O que do app está por cima da página, dentro da parte à vista.
    #[serde(default)]
    pub holes: Vec<Rect>,
}

/// Os Portais abertos.
fn portals() -> &'static Mutex<HashSet<String>> {
    static P: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashSet::new()))
}

/// O último endereço pedido para um Portal que ainda está abrindo: a aba manda navegar logo ao montar, antes de o
/// navegador existir. Quem abre consome isto no lugar da URL inicial.
fn pending() -> &'static Mutex<HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Um Portal abre de cada vez (o primeiro cria o ambiente do WebView2 que os outros usam).
fn opening() -> &'static tokio::sync::Mutex<()> {
    static O: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    O.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// Só http(s) e `about:blank` abrem no Portal; um esquema de app (`mailto:`, `slack:`) não navega.
fn navigable(url: &str) -> Option<tauri::Url> {
    let parsed = tauri::Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed),
        "about" if url == "about:blank" => Some(parsed),
        _ => None,
    }
}

/// `r` (px CSS) em px físicos: `[x, y, largura, altura]`, cobrindo o retângulo inteiro.
fn physical(r: Rect, scale: f64) -> [i32; 4] {
    let (x, y) = ((r.x * scale).floor() as i32, (r.y * scale).floor() as i32);
    [x, y, ((r.x + r.width) * scale).ceil() as i32 - x, ((r.y + r.height) * scale).ceil() as i32 - y]
}

/// Abre o navegador do Portal `id` em cima dele, já com o piloto dos agentes, e carrega `url`. Aberto, só
/// reposiciona: navegar é com `real_browser_navigate`.
#[tauri::command]
pub async fn real_browser_open(app: AppHandle, window: tauri::Window, id: String, url: String, place: Place, script: Option<String>) -> Result<(), String> {
    let _one_at_a_time = opening().lock().await;
    if !lock(portals()).contains(&id) {
        let parent = window_handle(&window)?;
        let profile = crate::util::datadir::app_data_dir(&app)?.join("portal-webview");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        // As mesmas flags do WebView do app (`tauri.conf.json`): também mantêm a página desenhando encoberta ou
        // recortada (`CalculateNativeWinOcclusion` desligado).
        let args = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()).unwrap_or_default();
        let scale = window.scale_factor().unwrap_or(1.0);
        native::create(&app, parent, &id, profile, args, physical(place.rect, scale)).await?;
        lock(portals()).insert(id.clone());
        // O piloto antes da primeira página: o canal (binding) e o script em todo documento novo.
        if let Some(script) = script {
            native::cdp(&app, &id, "Runtime.addBinding", json!({ "name": BINDING })).await?;
            native::cdp(&app, &id, "Runtime.enable", json!({})).await?;
            native::add_script(&app, &id, format!("{BRIDGE}\n;{script}")).await?;
        }
        let white = json!({ "color": { "r": 255, "g": 255, "b": 255, "a": 1 } });
        let _ = native::cdp(&app, &id, "Emulation.setDefaultBackgroundColorOverride", white).await;
        let url = lock(pending()).remove(&id).unwrap_or(url);
        if navigable(&url).is_some() {
            native::navigate(&app, &id, url).await?;
        }
    }
    real_browser_place(app, window, id, place)
}

fn window_handle(window: &tauri::Window) -> Result<isize, String> {
    #[cfg(windows)]
    return window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(0)
    }
}

/// A parte da página que aparece, em retângulos relativos ao Portal: a parte à vista menos os buracos.
/// Vazia = nada aparece (a página continua desenhando).
pub fn region(place: &Place) -> Vec<Rect> {
    let Some(visible) = place.visible else { return Vec::new() };
    let mut parts = vec![visible];
    for hole in &place.holes {
        parts = parts.into_iter().flat_map(|part| subtract(part, *hole)).collect();
    }
    parts.retain(|r| r.width > 0.0 && r.height > 0.0);
    parts
}

/// `a` menos `b`: até quatro faixas (em cima, embaixo, à esquerda, à direita do pedaço de `b` dentro de `a`).
fn subtract(a: Rect, b: Rect) -> Vec<Rect> {
    let (ax2, ay2, bx2, by2) = (a.x + a.width, a.y + a.height, b.x + b.width, b.y + b.height);
    let (ix, iy, ix2, iy2) = (a.x.max(b.x), a.y.max(b.y), ax2.min(bx2), ay2.min(by2));
    if ix >= ix2 || iy >= iy2 {
        return vec![a];
    }
    let mut out = Vec::new();
    if iy > a.y {
        out.push(Rect { x: a.x, y: a.y, width: a.width, height: iy - a.y });
    }
    if iy2 < ay2 {
        out.push(Rect { x: a.x, y: iy2, width: a.width, height: ay2 - iy2 });
    }
    if ix > a.x {
        out.push(Rect { x: a.x, y: iy, width: ix - a.x, height: iy2 - iy });
    }
    if ix2 < ax2 {
        out.push(Rect { x: ix2, y: iy, width: ax2 - ix2, height: iy2 - iy });
    }
    out
}

/// O Portal mudou de lugar, de tamanho, de zoom, saiu de vista ou ganhou algo por cima.
#[tauri::command]
pub fn real_browser_place(app: AppHandle, window: tauri::Window, id: String, place: Place) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let parts = region(&place).into_iter().map(|r| physical(r, scale)).map(|[x, y, w, h]| [x, y, x + w, y + h]).collect();
    native::place(&app, &id, physical(place.rect, scale), place.zoom, parts);
    Ok(())
}

/// A barra de endereço (ou um agente) mandou ir para `url`. A mesma URL de novo é recarregar, como no T3.
#[tauri::command]
pub async fn real_browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    navigable(&url).ok_or("Endereço que o navegador não abre.")?;
    if !lock(portals()).contains(&id) {
        // Ainda abrindo: vai direto para cá quando abrir.
        lock(pending()).insert(id, url);
        return Ok(());
    }
    native::navigate(&app, &id, url).await
}

/// Voltar (-1), avançar (+1) ou recarregar (0).
#[tauri::command]
pub async fn real_browser_history(app: AppHandle, id: String, delta: i32) -> Result<(), String> {
    native::history(&app, &id, delta).await
}

/// Fecha o navegador do Portal.
#[tauri::command]
pub fn real_browser_close(app: AppHandle, id: String) -> Result<(), String> {
    lock(pending()).remove(&id);
    if lock(portals()).remove(&id) {
        native::close(&app, &id);
    }
    Ok(())
}

/// O foco do teclado vai para a página.
#[tauri::command]
pub async fn real_browser_focus(app: AppHandle, id: String) -> Result<(), String> {
    native::focus(&app, &id).await
}

/// Uma mensagem do app para o piloto da página (`page:run`, `connect`, `pick:on`…). Só as do app (`source: ade-ags`).
#[tauri::command]
pub async fn real_browser_post(app: AppHandle, id: String, message: Value) -> Result<(), String> {
    if message["source"] != "ade-ags" {
        return Err("Mensagem que não é do app.".into());
    }
    post_to_page(&app, &id, &message).await
}

/// A foto da página como está agora (PNG em base64) e o tamanho dela em px CSS: as fotos do piloto.
#[tauri::command]
pub async fn real_browser_screenshot(app: AppHandle, id: String) -> Result<Value, String> {
    let layout = native::cdp(&app, &id, "Page.getLayoutMetrics", json!({})).await?;
    let viewport = &layout["cssLayoutViewport"];
    let shot = native::cdp(&app, &id, "Page.captureScreenshot", json!({ "format": "png" })).await?;
    Ok(json!({ "data": shot["data"], "width": viewport["clientWidth"], "height": viewport["clientHeight"] }))
}

/// O nome do canal da página para o app (`Runtime.addBinding`).
// Não pode ser `__agsPage`: é a marca de "piloto já instalado" do `runtime.ts`.
const BINDING: &str = "__agsCdpBridge";

/// Roda antes do piloto em cada documento. A página é a janela principal: o piloto manda para `window.parent`, que
/// é ela mesma, e a ponte repassa ao app pelo binding. A função do binding é guardada e tirada do `window` antes de
/// qualquer script da página rodar. `__ags_trusted_input` liga os toques e teclas pelo CDP.
const BRIDGE: &str = r#"(() => {
  if (window.__ags_bridge) return;
  Object.defineProperty(window, "__ags_bridge", { value: true });
  const send = window.__agsCdpBridge;
  try { delete window.__agsCdpBridge; } catch (_) {}
  self.__ags_trusted_input = typeof send === "function";
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source === window && d && d.source === "ags-preview" && typeof send === "function") {
      try { send(JSON.stringify(d)); } catch (_) {}
    }
  });
})();"#;

/// Uma mensagem que o piloto mandou pelo binding: `input:request` é com o Rust (toque ou tecla de verdade), o resto
/// vai para o Portal.
#[cfg_attr(not(windows), allow(dead_code))]
fn on_binding(app: &AppHandle, id: &str, payload: &str) {
    let Ok(message) = serde_json::from_str::<Value>(payload) else { return };
    if message["type"] == "input:request" {
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move { native_input(&app, &id, message["payload"].clone()).await });
    } else {
        emit(app, "real-browser-page", json!({ "id": id, "message": message }));
    }
}

/// Entrega uma mensagem do app ao piloto da página (como o `postMessage` do iframe faz no outro navegador).
async fn post_to_page(app: &AppHandle, id: &str, message: &Value) -> Result<(), String> {
    let expression = format!("window.postMessage({message}, \"*\")");
    native::cdp(app, id, "Runtime.evaluate", json!({ "expression": expression })).await.map(|_| ())
}

/// Um toque ou uma tecla de verdade que o piloto pediu (`input:request`), e a resposta `input:done`.
async fn native_input(app: &AppHandle, id: &str, request: Value) {
    let ok = run_native_input(app, id, &request).await.is_ok();
    let _ = post_to_page(app, id, &json!({ "source": "ade-ags", "type": "input:done", "id": request["id"], "ok": ok })).await;
}

async fn run_native_input(app: &AppHandle, id: &str, r: &Value) -> Result<(), String> {
    match r["kind"].as_str() {
        Some("click") => {
            let (x, y) = (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0));
            native::cdp(app, id, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" })).await?;
            for kind in ["mousePressed", "mouseReleased"] {
                let buttons = if kind == "mousePressed" { 1 } else { 0 };
                native::cdp(app, id, "Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": buttons, "clickCount": 1 })).await?;
            }
        }
        Some("key") => {
            let mut down = json!({
                "type": if r["text"].is_string() { "keyDown" } else { "rawKeyDown" },
                "key": r["key"], "code": r["code"], "windowsVirtualKeyCode": r["keyCode"], "modifiers": r["modifiers"],
            });
            if r["text"].is_string() {
                down["text"] = r["text"].clone();
                down["unmodifiedText"] = r["text"].clone();
            }
            if r["commands"].is_array() {
                down["commands"] = r["commands"].clone();
            }
            native::cdp(app, id, "Input.dispatchKeyEvent", down).await?;
            native::cdp(app, id, "Input.dispatchKeyEvent", json!({
                "type": "keyUp", "key": r["key"], "code": r["code"], "windowsVirtualKeyCode": r["keyCode"], "modifiers": r["modifiers"],
            }))
            .await?;
        }
        Some("text") => {
            native::cdp(app, id, "Input.insertText", json!({ "text": r["text"] })).await?;
        }
        _ => return Err("pedido de input desconhecido".into()),
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::{navigable, physical, region, subtract, Place, Rect};

    fn r(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    fn area(parts: &[Rect]) -> f64 {
        parts.iter().map(|p| p.width * p.height).sum()
    }

    #[test]
    fn buraco_no_meio_deixa_quatro_faixas() {
        let parts = subtract(r(0.0, 0.0, 100.0, 100.0), r(40.0, 40.0, 20.0, 20.0));
        assert_eq!(parts.len(), 4);
        assert_eq!(area(&parts), 100.0 * 100.0 - 20.0 * 20.0);
    }

    #[test]
    fn buraco_fora_nao_muda_nada_e_buraco_maior_apaga_tudo() {
        assert_eq!(subtract(r(0.0, 0.0, 10.0, 10.0), r(20.0, 20.0, 5.0, 5.0)), vec![r(0.0, 0.0, 10.0, 10.0)]);
        assert!(subtract(r(10.0, 10.0, 10.0, 10.0), r(0.0, 0.0, 50.0, 50.0)).is_empty());
    }

    #[test]
    fn regiao_e_a_parte_a_vista_menos_o_que_esta_por_cima() {
        let place = |visible, holes| Place { rect: r(0.0, 0.0, 800.0, 600.0), zoom: 1.0, visible, holes };
        assert!(region(&place(None, vec![])).is_empty(), "fora de vista não aparece nada");
        assert_eq!(region(&place(Some(r(0.0, 0.0, 800.0, 300.0)), vec![])), vec![r(0.0, 0.0, 800.0, 300.0)]);
        // Um menu de 200×100 no canto de cima à direita.
        let parts = region(&place(Some(r(0.0, 0.0, 800.0, 600.0)), vec![r(600.0, 0.0, 200.0, 100.0)]));
        assert_eq!(area(&parts), 800.0 * 600.0 - 200.0 * 100.0);
    }

    #[test]
    fn so_http_https_e_about_blank_navegam() {
        assert!(navigable("https://accounts.google.com/").is_some());
        assert!(navigable("http://localhost:5173/").is_some());
        assert!(navigable("about:blank").is_some());
        for bad in ["javascript:alert(1)", "file:///C:/Windows/win.ini", "mailto:a@b.c", "about:config", "nada"] {
            assert!(navigable(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn px_fisicos_cobrem_o_retangulo_inteiro() {
        assert_eq!(physical(r(10.0, 20.0, 100.0, 50.0), 1.0), [10, 20, 100, 50]);
        // Em 125% um retângulo de 10,4 px não pode perder a última coluna.
        assert_eq!(physical(r(0.5, 0.5, 10.4, 10.4), 1.25), [0, 0, 14, 14]);
    }
}
