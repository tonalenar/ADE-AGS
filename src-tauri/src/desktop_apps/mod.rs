//! Gemini Desktop is a graphical participant, separate from the Gemini CLI provider.
//! Native window ownership never implies headless/MCP or autonomous Lead capabilities.
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

#[cfg(windows)]
mod native;
#[cfg(windows)]
mod accessibility;
mod tasks;
pub(crate) mod participant;
pub const GEMINI_DESKTOP: &str = "gemini-desktop";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub supported: bool,
    pub installed: bool,
    pub attached: bool,
    pub owner_window: Option<String>,
    pub owner_view: Option<String>,
    pub automatic_messaging: bool,
    pub orchestration: &'static str,
}

pub fn status() -> DesktopStatus {
    #[cfg(windows)]
    {
        native::status()
    }
    #[cfg(not(windows))]
    {
        DesktopStatus {
            supported: false,
            installed: false,
            attached: false,
            owner_window: None,
            owner_view: None,
            automatic_messaging: false,
            orchestration: "assisted",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub visible: bool,
}

impl DesktopBounds {
    fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height, self.scale]
            .iter()
            .any(|n| !n.is_finite())
            || !(0.25..=8.0).contains(&self.scale)
            || self.width < 0.0
            || self.height < 0.0
            || self.width > 32768.0
            || self.height > 32768.0
            || self.x.abs() > 32768.0
            || self.y.abs() > 32768.0
        {
            return Err("Invalid Gemini panel bounds".into());
        }
        Ok(self)
    }
}

#[tauri::command]
pub fn gemini_desktop_status() -> DesktopStatus {
    status()
}

// All HWND mutations (including release of the named mutex) run on the UI thread.
async fn on_ui<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gemini_desktop_attach(
    window: WebviewWindow,
    view_id: String,
) -> Result<DesktopStatus, String> {
    if view_id.is_empty() || view_id.len() > 128 {
        return Err("Invalid Gemini view id".into());
    }
    #[cfg(windows)]
    {
        // Signature checking / process startup must not block the UI thread.
        let executable = tokio::task::spawn_blocking(native::prepare)
            .await
            .map_err(|e| e.to_string())??;
        let app = window.app_handle().clone();
        on_ui(app, move || native::attach(&window, view_id, &executable)).await
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("Gemini Desktop embedding requires Windows".into())
    }
}

#[tauri::command]
pub async fn gemini_desktop_layout(
    window: WebviewWindow,
    view_id: String,
    bounds: DesktopBounds,
) -> Result<(), String> {
    let bounds = bounds.validate()?;
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        on_ui(app, move || {
            native::layout(window.label(), &view_id, bounds)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, view_id, bounds);
        Err("Gemini Desktop embedding requires Windows".into())
    }
}

#[tauri::command]
pub async fn gemini_desktop_detach(window: WebviewWindow, view_id: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        on_ui(app, move || {
            native::detach(Some((window.label(), &view_id)))
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, view_id);
        Ok(())
    }
}

pub fn release_window(label: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::release_window(label)
    }
    #[cfg(not(windows))]
    {
        let _ = label;
        Ok(())
    }
}

/// Must run before Tauri/database initialization in the application entry point.
pub fn recovery_entry() -> bool {
    #[cfg(windows)]
    {
        native::recovery_entry()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Select the UI thread's window-creation context before Tauri creates any HWNDs.
/// Other threads/processes and system DPI settings are not changed.
pub fn configure_host_dpi() {
    #[cfg(windows)]
    native::configure_host_dpi();
}

pub(crate) use tasks::dispatch as task_dispatch;
pub use tasks::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panel_rejects_nonfinite_and_extreme_coordinates() {
        let b = DesktopBounds {
            x: 10.,
            y: 20.,
            width: 800.,
            height: 600.,
            scale: 1.25,
            visible: true,
        };
        assert!(b.validate().is_ok());
        assert!(DesktopBounds { x: f64::NAN, ..b }.validate().is_err());
        assert!(DesktopBounds { scale: 0., ..b }.validate().is_err());
        assert!(DesktopBounds { width: -1., ..b }.validate().is_err());
        assert!(
            DesktopBounds {
                height: 100000.,
                ..b
            }
            .validate()
            .is_err()
        );
    }
}
