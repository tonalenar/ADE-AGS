//! Simulador iOS dentro da ADE: os aparelhos do Xcode ligados sem o app Simulator, com a tela mostrada direto
//! na janela (a `IOSurface` do simulador numa camada nossa, sem copiar quadros) e o toque pelo mesmo HID que o
//! Simulator usa. Aparece solto no canvas e numa aba; os agentes conectados o pilotam com `ags device …`.
//!
//! Como funciona por dentro, e por que cada API privada: `docs/ade-ags/SIMULADOR_IOS.md`.

pub mod model;
mod commands;
pub mod lifecycle;
pub mod slim;
#[cfg(target_os = "macos")]
pub mod native;
#[cfg(test)]
mod test;

pub use commands::*;

/// As operações que a CLI usa (`ags device …` num nó iOS). Fora do macOS, todas dizem que não há simulador.
#[allow(unused_imports)] // a CLI usa o resto (ipc::commands::devices)
pub mod ops {
    #[cfg(not(target_os = "macos"))]
    use super::model::Device;

    #[cfg(target_os = "macos")]
    pub use super::native::{boot, booted, button, devices, key, set_priority, shutdown, swipe, tap, type_text};

    #[cfg(not(target_os = "macos"))]
    mod none {
        use super::Device;
        const NO: &str = "O simulador iOS só existe no macOS, com o Xcode instalado.";
        pub fn devices() -> Result<Vec<Device>, String> { Err(NO.into()) }
        pub fn boot(_: &str, _: bool) -> Result<(), String> { Err(NO.into()) }
        pub fn booted(_: &str) -> Result<bool, String> { Err(NO.into()) }
        pub fn shutdown(_: &str) -> Result<(), String> { Err(NO.into()) }
        pub fn tap(_: &str, _: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
        pub fn swipe(_: &str, _: (f64, f64), _: (f64, f64), _: u64) -> Result<(), String> { Err(NO.into()) }
        pub fn type_text(_: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
        pub fn key(_: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
        pub fn button(_: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
        pub fn set_priority(_: &str, _: i32) -> Result<usize, String> { Err(NO.into()) }
    }
    #[cfg(not(target_os = "macos"))]
    pub use none::*;

    /// `xcrun simctl <args…>`: as partes públicas (abrir URL, abrir app, foto da tela) vão pelo próprio simctl.
    pub fn simctl(args: &[&str]) -> Result<String, String> {
        use std::time::Duration;
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.arg("simctl").args(args);
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(60)).map_err(|e| format!("simctl: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!("simctl {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()))
        }
    }

    pub fn open_url(udid: &str, url: &str) -> Result<(), String> {
        let url = super::model::normalize_url(url)?;
        simctl(&["openurl", udid, &url]).map(|_| ())
    }

    pub fn launch(udid: &str, bundle: &str) -> Result<(), String> {
        simctl(&["launch", udid, bundle]).map(|_| ())
    }

    /// Fecha o app (como deslizá-lo para fora no seletor de apps).
    pub fn close(udid: &str, bundle: &str) -> Result<(), String> {
        simctl(&["terminate", udid, bundle]).map(|_| ())
    }

    /// A foto da tela num PNG temporário; devolve o caminho.
    pub fn screenshot(udid: &str) -> Result<String, String> {
        let dir = std::env::temp_dir().join("ade-simulator");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{}-{}.png", &udid[..udid.len().min(8)], crate::util::now_ts_ms()));
        let path = file.to_string_lossy().into_owned();
        simctl(&["io", udid, "screenshot", &path])?;
        Ok(path)
    }
}
