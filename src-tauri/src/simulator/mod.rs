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
    pub use super::native::{boot, booted, button, devices, key, orient, set_priority, shutdown, swipe, tap, type_text};

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
        pub fn orient(_: &str, _: u32) -> Result<(), String> { Err(NO.into()) }
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

    /// A aparência do iOS: com `mode`, aplica (`light`/`dark`); devolve sempre a que ficou.
    pub fn appearance(udid: &str, mode: Option<&str>) -> Result<String, String> {
        if let Some(mode) = mode {
            simctl(&["ui", udid, "appearance", super::model::appearance_mode(mode)?])?;
        }
        super::model::parse_appearance(&simctl(&["ui", udid, "appearance"])?)
    }

    /// A localização simulada (`Some` = fixa em lat/lon; `None` = volta a não ter).
    pub fn location(udid: &str, at: Option<(f64, f64)>) -> Result<(), String> {
        match at {
            Some((lat, lon)) => simctl(&["location", udid, "set", &super::model::location_arg(lat, lon)?]).map(|_| ()),
            None => simctl(&["location", udid, "clear"]).map(|_| ()),
        }
    }

    /// Face ID pelo `notifyutil` de dentro do aparelho (`model::biometric_steps`). Devolve se está cadastrado.
    pub fn biometric(udid: &str, action: &str) -> Result<bool, String> {
        const ENROLLED: &str = "com.apple.BiometricKit.enrollmentChanged";
        let (set, post) = super::model::biometric_steps(action)?;
        if let Some(value) = set {
            simctl(&["spawn", udid, "notifyutil", "-s", ENROLLED, &value.to_string()])?;
        }
        if let Some(name) = post {
            simctl(&["spawn", udid, "notifyutil", "-p", name])?;
        }
        super::model::parse_notify_state(&simctl(&["spawn", udid, "notifyutil", "-g", ENROLLED])?)
    }

    /// O bundle id do app do usuário rodando no aparelho (`None` = só os da Apple, ou nenhum).
    pub fn foreground_app(udid: &str) -> Result<Option<String>, String> {
        Ok(super::model::parse_foreground_app(&simctl(&["spawn", udid, "launchctl", "list"])?))
    }

    /// Fecha e abre de novo o app. Fechar um app que não estava aberto não é erro.
    pub fn relaunch(udid: &str, bundle: &str) -> Result<(), String> {
        super::model::check_bundle(bundle)?;
        if let Err(e) = close(udid, bundle) {
            eprintln!("[simulator] relaunch: {bundle} não estava aberto ({e})");
        }
        launch(udid, bundle)
    }

    /// A orientação de cada aparelho que a ADE girou. O iOS não diz a dele por API pública: começa em retrato
    /// (como o aparelho liga) e segue o que a ADE mandou.
    fn orientations() -> &'static std::sync::Mutex<std::collections::HashMap<String, u32>> {
        static O: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u32>>> = std::sync::OnceLock::new();
        O.get_or_init(Default::default)
    }

    /// A orientação atual do aparelho (`UIDeviceOrientation`; 1 = retrato, o padrão de quem a ADE nunca girou).
    pub fn orientation(udid: &str) -> u32 {
        orientations().lock().ok().and_then(|m| m.get(udid).copied()).unwrap_or(1)
    }

    /// Gira o aparelho um quarto de volta (`left`/`right`); devolve a orientação nova (`portrait`, `landscapeLeft`…).
    pub fn rotate(udid: &str, direction: &str) -> Result<String, String> {
        let next = super::model::next_orientation(orientation(udid), direction)?;
        orient(udid, next)?;
        if let Ok(mut map) = orientations().lock() {
            map.insert(udid.to_string(), next);
        }
        Ok(super::model::orientation_name(next).to_string())
    }

    /// Esquece a orientação guardada (o aparelho desligou e volta em retrato).
    pub fn forget_orientation(udid: &str) {
        if let Ok(mut map) = orientations().lock() {
            map.remove(udid);
        }
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
