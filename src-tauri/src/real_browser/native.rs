//! A parte WebView2 do navegador do Portal, direto pela API do WebView2 (o que o wry faz por baixo do Tauri).
//!
//! Não é um `Webview` do Tauri (`Window::add_child`): com um WebView filho a janela principal deixa de ser
//! "uma janela com um WebView" para o Tauri (`is_webview_window` exige que todos tenham o rótulo dela), e
//! `get_webview_window("main")` passa a dar `None` — o app não aparecia, e todo comando que recebe a janela
//! quebraria. Aqui cada Portal é uma janela filha nossa dentro da janela do app (a região dela recorta a página),
//! com um controlador do WebView2 dentro.
//!
//! Tudo o que toca o WebView2 roda na thread da interface (`run_on_main_thread`), onde ficam os Portais.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT,
};
use webview2_com::{
    take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler, CallDevToolsProtocolMethodCompletedHandler, CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, DevToolsProtocolEventReceivedEventHandler, DocumentTitleChangedEventHandler,
    HistoryChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    SourceChangedEventHandler,
};
use windows::core::{BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, SetWindowPos, HWND_TOP, SWP_NOACTIVATE, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_VISIBLE,
};

use super::{emit, on_binding};

/// Um Portal aberto: a janela filha que o recorta e o WebView2 dentro dela.
struct Portal {
    host: HWND,
    controller: ICoreWebView2Controller,
    core: ICoreWebView2,
}

thread_local! {
    /// Só na thread da interface (os objetos COM do WebView2 não saem dela).
    static PORTALS: RefCell<HashMap<String, Portal>> = RefCell::new(HashMap::new());
    /// O ambiente do WebView2 dos Portais (um navegador para todos, na pasta deles).
    static ENVIRONMENT: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
}

/// Roda `f` na thread da interface com o Portal `id`, e devolve o resultado.
async fn with_portal<T: Send + 'static>(app: &AppHandle, id: &str, f: impl FnOnce(&Portal) -> T + Send + 'static) -> Result<T, String> {
    let (done, wait) = oneshot::channel();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        let result = PORTALS.with(|p| p.borrow().get(&id).map(f));
        let _ = done.send(result);
    })
    .map_err(|e| e.to_string())?;
    wait.await.map_err(|_| "A interface não respondeu.".to_string())?.ok_or_else(|| "O navegador deste Portal não está aberto.".to_string())
}

/// O mesmo, sem esperar (posicionar a cada quadro).
fn with_portal_now(app: &AppHandle, id: &str, f: impl FnOnce(&Portal) + Send + 'static) {
    let id = id.to_string();
    let _ = app.run_on_main_thread(move || PORTALS.with(|p| {
        if let Some(portal) = p.borrow().get(&id) {
            f(portal);
        }
    }));
}

/// As opções do ambiente iguais às do wry no WebView do app: o WebView2 recusa (`0x8007139F`) dois ambientes com
/// opções diferentes na mesma pasta, e `WEBVIEW2_USER_DATA_FOLDER` (uma instância isolada) põe todos na mesma.
fn options(args: &str) -> ICoreWebView2EnvironmentOptions {
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES, MAX_LOCALE_NAME};
    let options = CoreWebView2EnvironmentOptions::default();
    unsafe {
        options.set_additional_browser_arguments(args.to_string());
        options.set_are_browser_extensions_enabled(false);
        let mut lang = [0u16; MAX_LOCALE_NAME as usize];
        LCIDToLocaleName(u32::from(GetUserDefaultUILanguage()), Some(&mut lang), LOCALE_ALLOW_NEUTRAL_NAMES);
        let len = lang.iter().position(|c| *c == 0).unwrap_or(lang.len());
        options.set_language(String::from_utf16_lossy(&lang[..len]));
        options.set_scroll_bar_style(COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT);
    }
    ICoreWebView2EnvironmentOptions::from(options)
}

/// Abre o Portal `id`: a janela filha em `parent` (px físicos) e o WebView2 dentro, com os eventos ligados.
pub async fn create(app: &AppHandle, parent: isize, id: &str, profile: std::path::PathBuf, args: String, bounds: [i32; 4]) -> Result<(), String> {
    let (done, wait) = oneshot::channel::<Result<(), String>>();
    let (app2, id) = (app.clone(), id.to_string());
    app.run_on_main_thread(move || {
        let start = move |env: ICoreWebView2Environment| {
            let parent = HWND(parent as *mut _);
            let [x, y, w, h] = bounds;
            let host = match unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    &HSTRING::from("STATIC"),
                    &HSTRING::new(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                    x,
                    y,
                    w.max(1),
                    h.max(1),
                    Some(parent),
                    None,
                    None,
                    None,
                )
            } {
                Ok(host) => host,
                Err(e) => return Err(e.message()),
            };
            let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
                let made = (|| -> windows::core::Result<()> {
                    result?;
                    let controller = controller.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_POINTER))?;
                    let core = unsafe { controller.CoreWebView2()? };
                    unsafe {
                        controller.SetBounds(RECT { left: 0, top: 0, right: w.max(1), bottom: h.max(1) })?;
                        controller.SetIsVisible(true)?;
                    }
                    watch(&core, &app2, &id);
                    PORTALS.with(|p| p.borrow_mut().insert(id.clone(), Portal { host, controller, core }));
                    Ok(())
                })();
                if made.is_err() {
                    let _ = unsafe { DestroyWindow(host) };
                }
                let _ = done.send(made.map_err(|e| e.message()));
                Ok(())
            }));
            unsafe { env.CreateCoreWebView2Controller(host, &handler) }.map_err(|e| e.message())
        };
        // `start` leva o `done`: se não chegar a rodar, o canal fecha e quem espera recebe o erro.
        if let Some(env) = ENVIRONMENT.with(|e| e.borrow().clone()) {
            let _ = start(env);
            return;
        }
        let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, env| {
            if let (Ok(()), Some(env)) = (result, env) {
                ENVIRONMENT.with(|e| *e.borrow_mut() = Some(env.clone()));
                let _ = start(env);
            }
            Ok(())
        }));
        let _ = unsafe { CreateCoreWebView2EnvironmentWithOptions(None, &HSTRING::from(profile.as_os_str()), &options(&args), &handler) };
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(30), wait)
        .await
        .map_err(|_| "O navegador do Portal não abriu a tempo.".to_string())?
        .map_err(|_| "O WebView2 não abriu o navegador do Portal.".to_string())?
}

/// Os eventos da página que o Portal acompanha: a URL (inclusive `pushState`), o título, o carregamento, o
/// histórico, os pop-ups e o canal do piloto.
fn watch(core: &ICoreWebView2, app: &AppHandle, id: &str) {
    let mut token = 0i64;
    let (a, i) = (app.clone(), id.to_string());
    let handler = SourceChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            let mut uri = PWSTR::null();
            unsafe { core.Source(&mut uri)? };
            emit(&a, "real-browser-url", json!({ "id": i, "url": take_pwstr(uri) }));
        }
        Ok(())
    }));
    let _ = unsafe { core.add_SourceChanged(&handler, &mut token) };

    let (a, i) = (app.clone(), id.to_string());
    let handler = DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            let mut title = PWSTR::null();
            unsafe { core.DocumentTitle(&mut title)? };
            emit(&a, "real-browser-title", json!({ "id": i, "title": take_pwstr(title) }));
        }
        Ok(())
    }));
    let _ = unsafe { core.add_DocumentTitleChanged(&handler, &mut token) };

    let (a, i) = (app.clone(), id.to_string());
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, _| {
        emit(&a, "real-browser-load", json!({ "id": i, "loading": true }));
        Ok(())
    }));
    let _ = unsafe { core.add_NavigationStarting(&handler, &mut token) };
    let (a, i) = (app.clone(), id.to_string());
    let handler = NavigationCompletedEventHandler::create(Box::new(move |_, _| {
        emit(&a, "real-browser-load", json!({ "id": i, "loading": false }));
        Ok(())
    }));
    let _ = unsafe { core.add_NavigationCompleted(&handler, &mut token) };

    let (a, i) = (app.clone(), id.to_string());
    let handler = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            let (mut back, mut forward) = (BOOL::default(), BOOL::default());
            unsafe {
                core.CanGoBack(&mut back)?;
                core.CanGoForward(&mut forward)?;
            }
            emit(&a, "real-browser-history", json!({ "id": i, "back": back.as_bool(), "forward": forward.as_bool() }));
        }
        Ok(())
    }));
    let _ = unsafe { core.add_HistoryChanged(&handler, &mut token) };

    // Pop-up com tamanho ou posição (login do Google, OAuth): a janela do próprio WebView2, com o `opener` vivo, como
    // a `BrowserWindow` filha do T3. Sem (um link para aba nova): abre no mesmo Portal. `about:blank` vazio: nada.
    let handler = NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
        let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
        let mut uri = PWSTR::null();
        unsafe { args.Uri(&mut uri)? };
        let uri = take_pwstr(uri);
        let features = unsafe { args.WindowFeatures()? };
        let (mut sized, mut placed) = (BOOL::default(), BOOL::default());
        unsafe {
            features.HasSize(&mut sized)?;
            features.HasPosition(&mut placed)?;
        }
        if sized.as_bool() || placed.as_bool() {
            return Ok(());
        }
        unsafe { args.SetHandled(true)? };
        if super::navigable(&uri).is_some() && uri != "about:blank" {
            unsafe { core.Navigate(&HSTRING::from(uri))? };
        }
        Ok(())
    }));
    let _ = unsafe { core.add_NewWindowRequested(&handler, &mut token) };

    let (a, i) = (app.clone(), id.to_string());
    let Ok(receiver) = (unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Runtime.bindingCalled")) }) else { return };
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut json = PWSTR::null();
            unsafe { args.ParameterObjectAsJson(&mut json)? };
            if let Ok(v) = serde_json::from_str::<Value>(&take_pwstr(json)) {
                if v["name"] == super::BINDING {
                    on_binding(&a, &i, v["payload"].as_str().unwrap_or(""));
                }
            }
        }
        Ok(())
    }));
    let _ = unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) };
}

/// Um comando CDP na página (`webContents.debugger.sendCommand` do Electron), e a resposta dele.
pub async fn cdp(app: &AppHandle, id: &str, method: &str, params: Value) -> Result<Value, String> {
    let (done, wait) = oneshot::channel::<Result<String, String>>();
    let (name, args) = (method.to_string(), params.to_string());
    with_portal(app, id, move |portal| {
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            let _ = done.send(result.map(|()| json.clone()).map_err(|e| if json.is_empty() { e.message() } else { json }));
            Ok(())
        }));
        // Falhou ao pedir: o handler nunca roda e, solto, fecha o canal (vira erro abaixo).
        let _ = unsafe { portal.core.CallDevToolsProtocolMethod(&HSTRING::from(name), &HSTRING::from(args), &handler) };
    })
    .await?;
    let reply = tokio::time::timeout(std::time::Duration::from_secs(15), wait)
        .await
        .map_err(|_| format!("O navegador não respondeu a {method}."))?
        .map_err(|_| format!("O navegador recusou {method}."))??;
    serde_json::from_str(&reply).map_err(|e| e.to_string())
}

/// Um script em todo documento novo, antes dos da página (o `AddScriptToExecuteOnDocumentCreated` do WebView2, o
/// mesmo dos scripts de inicialização do Tauri). Pelo CDP (`Page.addScriptToEvaluateOnNewDocument`) o WebView2
/// aceitava e não rodava.
pub async fn add_script(app: &AppHandle, id: &str, source: String) -> Result<(), String> {
    let (done, wait) = oneshot::channel::<Result<(), String>>();
    with_portal(app, id, move |portal| {
        let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, _| {
            let _ = done.send(result.map_err(|e| e.message()));
            Ok(())
        }));
        let _ = unsafe { portal.core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(source), &handler) };
    })
    .await?;
    wait.await.map_err(|_| "O navegador recusou o piloto.".to_string())?
}

/// Onde a janela do Portal fica (px físicos, relativos à janela do app), o zoom da página e o que dela aparece
/// (retângulos em px físicos, relativos ao Portal; vazio = nada aparece, mas a página continua desenhando).
pub fn place(app: &AppHandle, id: &str, bounds: [i32; 4], zoom: f64, parts: Vec<[i32; 4]>) {
    with_portal_now(app, id, move |portal| unsafe {
        let [x, y, w, h] = bounds;
        let _ = SetWindowPos(portal.host, Some(HWND_TOP), x, y, w.max(1), h.max(1), SWP_NOACTIVATE);
        let _ = portal.controller.SetBounds(RECT { left: 0, top: 0, right: w.max(1), bottom: h.max(1) });
        if zoom > 0.0 {
            let _ = portal.controller.SetZoomFactor(zoom);
        }
        let region = CreateRectRgn(0, 0, 0, 0);
        for [x1, y1, x2, y2] in parts {
            let part = CreateRectRgn(x1, y1, x2, y2);
            CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
            let _ = DeleteObject(part.into());
        }
        // A janela fica dona da região (não se apaga depois).
        SetWindowRgn(portal.host, Some(region), true);
    });
}

/// Vai para `url`; a mesma URL de novo é recarregar, como no T3.
pub async fn navigate(app: &AppHandle, id: &str, url: String) -> Result<(), String> {
    with_portal(app, id, move |portal| unsafe {
        let mut current = PWSTR::null();
        let same = portal.core.Source(&mut current).is_ok() && take_pwstr(current) == url;
        if same { portal.core.Reload() } else { portal.core.Navigate(&HSTRING::from(url)) }.map_err(|e| e.message())
    })
    .await?
}

/// Voltar (-1), avançar (+1) ou recarregar (0).
pub async fn history(app: &AppHandle, id: &str, delta: i32) -> Result<(), String> {
    with_portal(app, id, move |portal| unsafe {
        match delta {
            0 => portal.core.Reload(),
            d if d < 0 => portal.core.GoBack(),
            _ => portal.core.GoForward(),
        }
        .map_err(|e| e.message())
    })
    .await?
}

pub async fn focus(app: &AppHandle, id: &str) -> Result<(), String> {
    with_portal(app, id, |portal| unsafe { portal.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) }.map_err(|e| e.message())).await?
}

pub fn close(app: &AppHandle, id: &str) {
    let id = id.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(portal) = PORTALS.with(|p| p.borrow_mut().remove(&id)) {
            unsafe {
                let _ = portal.controller.Close();
                let _ = DestroyWindow(portal.host);
            }
        }
    });
}
