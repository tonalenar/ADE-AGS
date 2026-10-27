//! A parte WebView2 do navegador do Portal: o CDP de dentro do processo, os eventos da página e a região da janela.
//! Tudo o que toca o WebView2 roda na thread da interface (`with_webview`).

use serde_json::{json, Value};
use tauri::{AppHandle, Webview};
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler, HistoryChangedEventHandler,
    SourceChangedEventHandler,
};
use windows::core::{HSTRING, PWSTR};

use super::{emit, on_binding, Rect};

fn core(pw: &tauri::webview::PlatformWebview) -> windows::core::Result<ICoreWebView2> {
    unsafe { pw.controller().CoreWebView2() }
}

/// Um comando CDP na página (`webContents.debugger.sendCommand` do Electron), e a resposta dele.
pub async fn cdp(page: &Webview, method: &str, params: Value) -> Result<Value, String> {
    let (done, wait) = oneshot::channel::<Result<String, String>>();
    let (name, args) = (method.to_string(), params.to_string());
    page.with_webview(move |pw| {
        let started = (|| -> windows::core::Result<()> {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let _ = done.send(result.map(|()| json.clone()).map_err(|e| if json.is_empty() { e.message() } else { json }));
                Ok(())
            }));
            unsafe { core(&pw)?.CallDevToolsProtocolMethod(&HSTRING::from(name), &HSTRING::from(args), &handler) }
        })();
        // Falhou ao pedir: o handler nunca roda e, solto, fecha o canal (vira erro abaixo).
        drop(started);
    })
    .map_err(|e| e.to_string())?;
    let reply = tokio::time::timeout(std::time::Duration::from_secs(15), wait)
        .await
        .map_err(|_| format!("O navegador não respondeu a {method}."))?
        .map_err(|_| format!("O navegador recusou {method}."))??;
    serde_json::from_str(&reply).map_err(|e| e.to_string())
}

/// Os eventos da página que o Portal acompanha: a URL (inclusive `pushState`), o histórico e o canal do piloto.
pub fn watch(page: &Webview, app: AppHandle, id: String) {
    let _ = page.with_webview(move |pw| {
        let Ok(core) = core(&pw) else { return };
        let mut token = 0i64;
        let (url_app, url_id) = (app.clone(), id.clone());
        let handler = SourceChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                let mut uri = PWSTR::null();
                unsafe { core.Source(&mut uri)? };
                emit(&url_app, "real-browser-url", json!({ "id": url_id, "url": take_pwstr(uri) }));
            }
            Ok(())
        }));
        let _ = unsafe { core.add_SourceChanged(&handler, &mut token) };
        let (history_app, history_id) = (app.clone(), id.clone());
        let handler = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                let (mut back, mut forward) = (Default::default(), Default::default());
                unsafe {
                    core.CanGoBack(&mut back)?;
                    core.CanGoForward(&mut forward)?;
                }
                emit(&history_app, "real-browser-history", json!({ "id": history_id, "back": back.as_bool(), "forward": forward.as_bool() }));
            }
            Ok(())
        }));
        let _ = unsafe { core.add_HistoryChanged(&handler, &mut token) };
        let Ok(receiver) = (unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Runtime.bindingCalled")) }) else { return };
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut json = PWSTR::null();
                unsafe { args.ParameterObjectAsJson(&mut json)? };
                if let Ok(v) = serde_json::from_str::<Value>(&take_pwstr(json)) {
                    if v["name"] == super::BINDING {
                        on_binding(&app, &id, v["payload"].as_str().unwrap_or(""));
                    }
                }
            }
            Ok(())
        }));
        let _ = unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) };
    });
}

/// A região da janela da página: só os retângulos (em px CSS, relativos ao Portal) aparecem e recebem clique.
pub fn clip(page: &Webview, parts: Vec<Rect>) {
    let scale = page.window().scale_factor().unwrap_or(1.0);
    let parts: Vec<[i32; 4]> = parts
        .iter()
        .map(|r| {
            let (x, y) = ((r.x * scale).floor() as i32, (r.y * scale).floor() as i32);
            [x, y, ((r.x + r.width) * scale).ceil() as i32, ((r.y + r.height) * scale).ceil() as i32]
        })
        .collect();
    let _ = page.with_webview(move |pw| {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
        let mut hwnd = HWND::default();
        if unsafe { pw.controller().ParentWindow(&mut hwnd) }.is_err() || hwnd.is_invalid() {
            return;
        }
        unsafe {
            let region = CreateRectRgn(0, 0, 0, 0);
            for [x1, y1, x2, y2] in parts {
                let part = CreateRectRgn(x1, y1, x2, y2);
                CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
                let _ = DeleteObject(part.into());
            }
            // A janela fica dona da região (não se apaga depois).
            SetWindowRgn(hwnd, Some(region), true);
        }
    });
}

/// Voltar ou avançar `delta` páginas.
pub fn history(page: &Webview, delta: i32) {
    let _ = page.with_webview(move |pw| {
        if let Ok(core) = core(&pw) {
            let _ = unsafe { if delta < 0 { core.GoBack() } else { core.GoForward() } };
        }
    });
}
