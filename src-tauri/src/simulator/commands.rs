//! Comandos Tauri do simulador. Os que falam com o CoreSimulator bloqueiam (`async`: fora da thread da
//! interface); os que mexem na tela da janela vão para ela por `with_webview`.

use tauri::{Runtime, Webview};

use super::model::{Device, Place};
use super::ops;

#[tauri::command(async)]
pub fn simulator_devices() -> Result<Vec<Device>, String> {
    ops::devices()
}

/// Liga o aparelho (sem persist: desliga junto com a ADE). `light` = o iOS na prioridade baixa.
#[tauri::command(async)]
pub fn simulator_boot(udid: String, light: Option<bool>) -> Result<(), String> {
    ops::boot(&udid, light.unwrap_or(true))
}

/// Liga ou desliga o modo leve num aparelho já ligado: a prioridade do iOS muda na hora.
#[tauri::command(async)]
pub fn simulator_priority(udid: String, light: bool) -> Result<usize, String> {
    ops::set_priority(&udid, if light { 10 } else { 0 })
}

#[tauri::command(async)]
pub fn simulator_shutdown(udid: String) -> Result<(), String> {
    ops::shutdown(&udid)
}

#[tauri::command(async)]
pub fn simulator_button(udid: String, name: String) -> Result<(), String> {
    ops::button(&udid, &name)
}

#[tauri::command(async)]
pub fn simulator_open_url(udid: String, url: String) -> Result<(), String> {
    ops::open_url(&udid, &url)
}

/// A foto da tela (PNG temporário): o caminho, para anexar na conversa com os agentes.
#[tauri::command(async)]
pub fn simulator_screenshot(udid: String) -> Result<String, String> {
    ops::screenshot(&udid)
}

/// Mostra a tela do aparelho `udid` na janela, como a tela `id` (um nó do canvas ou uma aba), em `place`.
#[tauri::command]
pub async fn simulator_attach<R: Runtime>(webview: Webview<R>, id: String, udid: String, place: Place) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (screen, hid) = tokio::task::spawn_blocking(move || super::native::connect(&udid)).await.map_err(|e| e.to_string())??;
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                // SAFETY: `with_webview` roda na thread da interface e `inner()` é o WKWebView da janela.
                let result = unsafe { super::native::view::attach(platform.inner(), &id, screen, hid, &place) };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "A interface não respondeu.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, id, udid, place);
        Err("O simulador iOS só existe no macOS, com o Xcode instalado.".into())
    }
}

/// Onde a tela está agora (o canvas moveu, deu zoom, um menu abriu por cima). Sem resposta: vai a cada mudança.
#[tauri::command]
pub fn simulator_place<R: Runtime>(webview: Webview<R>, id: String, place: Place) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview
            .with_webview(move |platform| {
                // SAFETY: thread da interface e WKWebView da janela, como em `simulator_attach`.
                unsafe { super::native::view::place(platform.inner(), &id, &place) };
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, id, place);
        Ok(())
    }
}

/// Tira a tela `id` da janela (o aparelho continua ligado).
#[tauri::command]
pub fn simulator_detach<R: Runtime>(webview: Webview<R>, id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview.with_webview(move |_| super::native::view::detach(&id)).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, id);
        Ok(())
    }
}
