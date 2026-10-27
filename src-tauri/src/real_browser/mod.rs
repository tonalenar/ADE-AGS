//! O navegador do Portal: um WebView2 de verdade dentro da janela do app, como o navegador do T3 Code.
//!
//! O T3 Code (Electron) mostra sites numa `<webview>`: um Chromium embutido, com perfil próprio
//! (`persist:t3code-preview-…`), o user agent padrão e o controle do agente pelo `webContents.debugger` — o CDP de
//! dentro do processo, sem porta de depuração, então a página nunca se vê automatizada (`navigator.webdriver`
//! falso). O Google aceita o login nele sem nada especial: não há troca de user agent nem cópia de cookies.
//! O equivalente no Tauri é um WebView2 filho da janela (`Window::add_child`):
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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

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

/// Os Portais abertos: o rótulo do WebView de cada um.
fn portals() -> &'static Mutex<HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// O rótulo do WebView de um Portal (o Tauri só aceita letras, números e `-/:_`).
fn label_of(id: &str) -> String {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || "-_".contains(c) { c } else { '_' }).collect();
    format!("portal-{safe}")
}

fn webview(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    let label = lock(portals()).get(id).cloned().ok_or("O navegador deste Portal não está aberto.")?;
    app.get_webview(&label).ok_or_else(|| "O navegador deste Portal fechou.".to_string())
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

/// Abre o navegador do Portal `id` em cima dele, já com o piloto dos agentes, e carrega `url`. Aberto, só
/// reposiciona: navegar é com `real_browser_navigate`.
#[tauri::command]
pub async fn real_browser_open(app: AppHandle, window: tauri::Window, id: String, url: String, place: Place, script: Option<String>) -> Result<(), String> {
    if lock(portals()).contains_key(&id) {
        return real_browser_place(app, id, place);
    }
    open(&app, &window, &id, &url, &place, script).await
}

#[cfg(windows)]
async fn open(app: &AppHandle, window: &tauri::Window, id: &str, url: &str, place: &Place, script: Option<String>) -> Result<(), String> {
    use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    let label = label_of(id);
    let profile = crate::util::datadir::app_data_dir(app)?.join("portal-webview");
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let (popup_app, popup_label) = (app.clone(), label.clone());
    let (title_app, title_id) = (app.clone(), id.to_string());
    let (load_app, load_id) = (app.clone(), id.to_string());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External("about:blank".parse().map_err(|_| "about:blank")?))
        .data_directory(profile)
        .on_new_window(move |url, features| {
            if url.as_str() == "about:blank" && features.size().is_none() {
                return NewWindowResponse::Deny;
            }
            // Um pop-up (com tamanho: login do Google, OAuth) precisa do `opener` vivo: abre a janela do WebView2.
            if features.size().is_some() || features.position().is_some() {
                return NewWindowResponse::Allow;
            }
            // Um link para aba nova abre no mesmo Portal (o T3 abre uma aba dele; o Portal tem uma página só).
            if navigable(url.as_str()).is_some() {
                if let Some(page) = popup_app.get_webview(&popup_label) {
                    tauri::async_runtime::spawn(async move { let _ = page.navigate(url); });
                }
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| emit(&title_app, "real-browser-title", json!({ "id": title_id, "title": title })))
        .on_page_load(move |_, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit(&load_app, "real-browser-load", json!({ "id": load_id, "loading": loading, "url": payload.url().as_str() }));
        });
    let webview = window
        .add_child(builder, LogicalPosition::new(place.rect.x, place.rect.y), LogicalSize::new(place.rect.width.max(1.0), place.rect.height.max(1.0)))
        .map_err(|e| format!("Não consegui abrir o navegador do Portal: {e}"))?;
    lock(portals()).insert(id.to_string(), label);
    native::watch(&webview, app.clone(), id.to_string());
    // O piloto antes da primeira página: o canal (binding), os eventos dele e o script em todo documento novo.
    if let Some(script) = script {
        native::cdp(&webview, "Runtime.addBinding", json!({ "name": BINDING })).await?;
        native::cdp(&webview, "Runtime.enable", json!({})).await?;
        native::cdp(&webview, "Page.addScriptToEvaluateOnNewDocument", json!({ "source": format!("{BRIDGE}\n;{script}") })).await?;
    }
    native::cdp(&webview, "Emulation.setDefaultBackgroundColorOverride", json!({ "color": { "r": 255, "g": 255, "b": 255, "a": 1 } })).await?;
    apply_place(&webview, place)?;
    if let Some(target) = navigable(url) {
        webview.navigate(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
async fn open(_: &AppHandle, _: &tauri::Window, _: &str, _: &str, _: &Place, _: Option<String>) -> Result<(), String> {
    Err("O navegador do Portal por enquanto só existe no Windows.".into())
}

fn apply_place(webview: &tauri::Webview, place: &Place) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    let r = place.rect;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(r.x, r.y).into(),
            size: LogicalSize::new(r.width.max(1.0), r.height.max(1.0)).into(),
        })
        .map_err(|e| e.to_string())?;
    if place.zoom > 0.0 {
        webview.set_zoom(place.zoom).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    native::clip(webview, region(place));
    Ok(())
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
pub fn real_browser_place(app: AppHandle, id: String, place: Place) -> Result<(), String> {
    apply_place(&webview(&app, &id)?, &place)
}

/// A barra de endereço (ou um agente) mandou ir para `url`. A mesma URL de novo é recarregar, como no T3.
#[tauri::command]
pub fn real_browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let page = webview(&app, &id)?;
    let target = navigable(&url).ok_or("Endereço que o navegador não abre.")?;
    if page.url().ok().as_ref() == Some(&target) {
        return page.reload().map_err(|e| e.to_string());
    }
    page.navigate(target).map_err(|e| e.to_string())
}

/// Voltar (-1), avançar (+1) ou recarregar (0).
#[tauri::command]
pub async fn real_browser_history(app: AppHandle, id: String, delta: i32) -> Result<(), String> {
    let page = webview(&app, &id)?;
    if delta == 0 {
        return page.reload().map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    native::history(&page, delta);
    Ok(())
}

/// Fecha o navegador do Portal.
#[tauri::command]
pub fn real_browser_close(app: AppHandle, id: String) -> Result<(), String> {
    let Some(label) = lock(portals()).remove(&id) else { return Ok(()) };
    if let Some(page) = app.get_webview(&label) {
        page.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// O foco do teclado vai para a página (um clique nela já faz isso; aqui é para a barra de endereço devolver).
#[tauri::command]
pub fn real_browser_focus(app: AppHandle, id: String) -> Result<(), String> {
    webview(&app, &id)?.set_focus().map_err(|e| e.to_string())
}

/// Uma mensagem do app para o piloto da página (`page:run`, `connect`, `pick:on`…). Só as do app (`source: ade-ags`).
#[tauri::command]
pub async fn real_browser_post(app: AppHandle, id: String, message: Value) -> Result<(), String> {
    if message["source"] != "ade-ags" {
        return Err("Mensagem que não é do app.".into());
    }
    post_to_page(&webview(&app, &id)?, &message).await
}

/// A foto da página como está agora (PNG em base64) e o tamanho dela em px CSS: as fotos do piloto.
#[tauri::command]
pub async fn real_browser_screenshot(app: AppHandle, id: String) -> Result<Value, String> {
    let page = webview(&app, &id)?;
    let layout = cdp(&page, "Page.getLayoutMetrics", json!({})).await?;
    let viewport = &layout["cssLayoutViewport"];
    let shot = cdp(&page, "Page.captureScreenshot", json!({ "format": "png" })).await?;
    Ok(json!({ "data": shot["data"], "width": viewport["clientWidth"], "height": viewport["clientHeight"] }))
}

async fn cdp(page: &tauri::Webview, method: &str, params: Value) -> Result<Value, String> {
    #[cfg(windows)]
    return native::cdp(page, method, params).await;
    #[cfg(not(windows))]
    {
        let _ = (page, method, params);
        Err("só no Windows".into())
    }
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
        tauri::async_runtime::spawn(async move {
            if let Ok(page) = webview(&app, &id) {
                native_input(&page, message["payload"].clone()).await;
            }
        });
    } else {
        emit(app, "real-browser-page", json!({ "id": id, "message": message }));
    }
}

/// Entrega uma mensagem do app ao piloto da página (como o `postMessage` do iframe faz no outro navegador).
async fn post_to_page(page: &tauri::Webview, message: &Value) -> Result<(), String> {
    let expression = format!("window.postMessage({message}, \"*\")");
    cdp(page, "Runtime.evaluate", json!({ "expression": expression })).await.map(|_| ())
}

/// Um toque ou uma tecla de verdade que o piloto pediu (`input:request`), e a resposta `input:done`.
async fn native_input(page: &tauri::Webview, request: Value) {
    let ok = run_native_input(page, &request).await.is_ok();
    let _ = post_to_page(page, &json!({ "source": "ade-ags", "type": "input:done", "id": request["id"], "ok": ok })).await;
}

async fn run_native_input(page: &tauri::Webview, r: &Value) -> Result<(), String> {
    match r["kind"].as_str() {
        Some("click") => {
            let (x, y) = (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0));
            cdp(page, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" })).await?;
            for kind in ["mousePressed", "mouseReleased"] {
                let buttons = if kind == "mousePressed" { 1 } else { 0 };
                cdp(page, "Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": buttons, "clickCount": 1 })).await?;
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
            cdp(page, "Input.dispatchKeyEvent", down).await?;
            cdp(page, "Input.dispatchKeyEvent", json!({
                "type": "keyUp", "key": r["key"], "code": r["code"], "windowsVirtualKeyCode": r["keyCode"], "modifiers": r["modifiers"],
            }))
            .await?;
        }
        Some("text") => {
            cdp(page, "Input.insertText", json!({ "text": r["text"] })).await?;
        }
        _ => return Err("pedido de input desconhecido".into()),
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::{label_of, navigable, region, subtract, Place, Rect};

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
    fn rotulo_do_webview_so_com_caracteres_aceitos() {
        assert_eq!(label_of("view-1a2b"), "portal-view-1a2b");
        assert_eq!(label_of("a b/c:d"), "portal-a_b_c_d");
    }
}
