//! Isolated native integration check: no ADE database, restored workspaces or agents.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::Manager;

fn main() {
    if ade_ags_lib::desktop_apps::recovery_entry() {
        return;
    }
    ade_ags_lib::desktop_apps::configure_host_dpi();
    let report = std::env::temp_dir().join("ade-gemini-native-smoke.json");
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = ade_ags_lib::desktop_apps::release_window(window.label());
            }
        })
        .setup(move |app| {
            let window = app.get_webview_window("main").ok_or("main window unavailable")?;
            window.navigate("about:blank".parse()?)?;
            window.set_title("ADE | Gemini native verification")?;
            window.show()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use ade_ags_lib::desktop_apps::*;
                let result: Result<serde_json::Value, String> = async {
                    let status = gemini_desktop_attach(window.clone(), "smoke".into()).await?;
                    let bounds = DesktopBounds { x: 20., y: 65., width: 950., height: 550., scale: window.scale_factor().map_err(|e| e.to_string())?, visible: true };
                    gemini_desktop_layout(window.clone(), "smoke".into(), bounds).await?;
                    let _ = std::fs::write(&report, serde_json::json!({ "phase": "attached", "status": status }).to_string());
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    gemini_desktop_layout(window.clone(), "smoke".into(), DesktopBounds { visible: false, ..bounds }).await?;
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    gemini_desktop_layout(window.clone(), "smoke".into(), DesktopBounds { width: 850., height: 500., ..bounds }).await?;
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    gemini_desktop_detach(window.clone(), "smoke".into()).await?;
                    Ok(serde_json::json!({ "phase": "completed", "attached": status.attached, "detached": !gemini_desktop_status().attached }))
                }.await;
                let _ = gemini_desktop_detach(window.clone(), "smoke".into()).await;
                let value = match result { Ok(value) => value, Err(error) => serde_json::json!({ "phase": "failed", "error": error }) };
                let _ = std::fs::write(&report, value.to_string());
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("native Gemini smoke host failed");
}
