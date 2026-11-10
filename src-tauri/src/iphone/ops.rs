//! O que se faz num iPhone ou iPad físico: tocar, deslizar, digitar, botões, gestos do sistema e a foto da tela. Usado
//! pelos controles da interface (a pessoa) e por `ags device`/`sim act` (os agentes, depois da autorização deles em
//! `ipc::commands::simulators` e `computer_use::ios`).
//!
//! Cada operação garante uma sessão de espelhamento ligada com o toque pronto (o helper só manda HID enquanto o vídeo
//! está aberto) e manda as linhas ao helper, que as executa em ordem. As coordenadas dos agentes são pontos do iOS,
//! como no simulador.

use std::time::Duration;

use tauri::AppHandle;

#[cfg(target_os = "macos")]
use super::model::{self, Edge, TouchPhase};

/// Quanto esperar o aparelho ficar pronto para o toque (abrir o túnel e o vídeo leva de 1 a 8 s no Wi-Fi).
pub const READY_WAIT: Duration = Duration::from_secs(20);

/// De onde veio a foto do computer use no iPhone físico.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScreenshotSource {
    MirrorFrame,
    DeviceCtl,
}

pub(crate) struct ComputerUseScreenshot {
    pub path: std::path::PathBuf,
    pub source: ScreenshotSource,
    pub elapsed: Duration,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::iphone::commands::mac as screens;
    use crate::iphone::session::{InputTx, Status};
    use std::collections::BTreeSet;

    struct Ready {
        input: InputTx,
        status: Status,
        presenter: std::sync::Arc<crate::iphone::native::view::Presenter>,
        family: String,
        device: String,
    }

    impl Ready {
        fn points(&self) -> Result<(f64, f64), String> {
            let d = self.status.display.ok_or("O tamanho da tela do aparelho ainda não é conhecido.")?;
            Ok(model::display_points((d.w, d.h), &self.family))
        }
    }

    impl Drop for Ready {
        fn drop(&mut self) {
            screens::release(&self.device);
        }
    }

    fn ready(app: &AppHandle, device: &str) -> Result<Ready, String> {
        ensure_session_active(device)?;
        let (input, status, presenter, family) = screens::agent(app, device, READY_WAIT)?;
        Ok(Ready { input, status, presenter, family, device: device.to_string() })
    }

    fn ensure_session_active(device: &str) -> Result<(), String> {
        if screens::is_disconnected(device) {
            Err("A sessão deste iPhone foi desconectada no painel da ADE. Reconecte o aparelho antes de pedir outra ação.".into())
        } else {
            Ok(())
        }
    }

    fn pause(ms: u64) {
        // O ritmo do dedo: o HID não tem relógio próprio, e o iOS lê a velocidade do arrasto pelo intervalo.
        std::thread::park_timeout(Duration::from_millis(ms));
    }

    pub fn ready_now(app: &AppHandle, device: &str) -> Result<bool, String> {
        ready(app, device).map(|_| true)
    }

    pub fn points(app: &AppHandle, device: &str) -> Result<(f64, f64), String> {
        ready(app, device)?.points()
    }

    /// Um toque em (x, y) pontos do iOS: desce e sobe.
    pub fn tap(app: &AppHandle, device: &str, x: f64, y: f64) -> Result<(), String> {
        let r = ready(app, device)?;
        let p = model::point_ratio(x, y, r.points()?)?;
        r.input.send(vec![model::touch_line(TouchPhase::Start, p, None, Edge::None)]);
        pause(60);
        r.input.send(vec![model::touch_line(TouchPhase::End, p, None, Edge::None)]);
        Ok(())
    }

    /// Um arrasto de `from` a `to` em `ms`; `hold` = quanto o dedo fica parado no fim antes de soltar.
    pub(crate) fn drag(input: &InputTx, from: (f64, f64), to: (f64, f64), ms: u64, edge: Edge, hold: u64) {
        let steps = (ms / 16).clamp(4, 120) as u32;
        let lines = model::swipe_lines(from, to, steps, edge);
        let last = lines.len() - 1;
        for (i, line) in lines.into_iter().enumerate() {
            if i == last && hold > 0 {
                pause(hold);
            }
            input.send(vec![line]);
            if i < last {
                pause(16);
            }
        }
    }

    /// Desliza de um ponto a outro em `ms` milissegundos (pontos do iOS).
    pub fn swipe(app: &AppHandle, device: &str, from: (f64, f64), to: (f64, f64), ms: u64) -> Result<(), String> {
        let r = ready(app, device)?;
        let size = r.points()?;
        let (a, b) = (model::point_ratio(from.0, from.1, size)?, model::point_ratio(to.0, to.1, size)?);
        drag(&r.input, a, b, ms, Edge::None, 0);
        Ok(())
    }

    pub fn type_text(app: &AppHandle, device: &str, text: &str) -> Result<(), String> {
        let lines = model::text_lines(text)?;
        ready(app, device)?.input.send(lines);
        Ok(())
    }

    pub fn key(app: &AppHandle, device: &str, name: &str) -> Result<(), String> {
        let lines = model::key_lines(name)?;
        ready(app, device)?.input.send(lines.to_vec());
        Ok(())
    }

    /// Aperta e solta um botão físico (início, bloquear, volume, mudo, Siri).
    pub fn button(app: &AppHandle, device: &str, name: &str) -> Result<(), String> {
        let [down, up] = model::button_lines(name)?;
        let r = ready(app, device)?;
        r.input.send(vec![down]);
        pause(90);
        r.input.send(vec![up]);
        Ok(())
    }

    /// Um gesto do sistema: Central de Controle, Central de Notificações, Busca ou início.
    pub fn gesture(app: &AppHandle, device: &str, name: &str) -> Result<(), String> {
        let g = model::gesture(name).ok_or_else(|| format!("Gesto desconhecido: \"{name}\" (controlCenter, notificationCenter, spotlight, appSwitcher ou home)."))?;
        let r = ready(app, device)?;
        drag(&r.input, g.from, g.to, g.ms, g.edge, g.hold_ms);
        Ok(())
    }

    /// Aperta (`down`) ou solta um botão: para segurar (o lateral segurado chama a Siri).
    pub fn button_state(app: &AppHandle, device: &str, name: &str, down: bool) -> Result<(), String> {
        let line = model::button_state_line(name, down)?;
        ready(app, device)?.input.send(vec![line]);
        Ok(())
    }

    /// A foto da tela num PNG temporário: o último quadro do espelho (sem as bordas do vídeo); sem quadro, a do
    /// `devicectl` (pública, ~1 s).
    pub fn screenshot(app: &AppHandle, device: &str) -> Result<String, String> {
        ensure_session_active(device)?;
        let started = std::time::Instant::now();
        let dir = std::env::temp_dir().join("ade-iphone");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("shot-{}.png", crate::util::now_ts_ms()));
        if let Ok(r) = ready(app, device) {
            if let Some((mut data, w, h)) = r.presenter.snapshot() {
                if crate::computer_use::png_from_bgra(&mut data, w, h, &path).is_ok() {
                    eprintln!("[iphone] foto do agente: fonte=espelho duração={} ms", started.elapsed().as_millis());
                    return Ok(path.to_string_lossy().into_owned());
                }
            }
        }
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        capture_devicectl(identifier, &path)?;
        eprintln!("[iphone] foto do agente: fonte=devicectl duração={} ms", started.elapsed().as_millis());
        Ok(path.to_string_lossy().into_owned())
    }

    /// Foto do iPhone para o computer use. Abre uma sessão silenciosa quando necessário, mas só usa o quadro se
    /// ele estiver depois do último IDR confiável; em qualquer outro caso, captura diretamente com devicectl.
    pub fn screenshot_for_computer_use(app: &AppHandle, device: &str, out: &std::path::Path) -> Result<ComputerUseScreenshot, String> {
        ensure_session_active(device)?;
        let started = std::time::Instant::now();
        let parent = out.parent().ok_or("Pasta da captura indisponível.")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("Pasta da captura indisponível: {e}"))?;
        let mirror_reason = match ready(app, device) {
            Ok(r) => match r.presenter.snapshot() {
                Some((mut data, w, h)) => match crate::computer_use::png_from_bgra_max(
                    &mut data, w, h, out, crate::computer_use::MAX_CAPTURE_SIDE,
                ) {
                    Ok(()) => return Ok(ComputerUseScreenshot { path: out.to_path_buf(), source: ScreenshotSource::MirrorFrame, elapsed: started.elapsed() }),
                    Err(e) => format!("não foi possível preparar o quadro do espelho: {e}"),
                },
                None => "o quadro do espelho está ausente ou foi invalidado até o próximo quadro-chave".into(),
            },
            Err(e) => e,
        };

        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        if let Err(e) = capture_devicectl(identifier, out) {
            let _ = std::fs::remove_file(out);
            return Err(format!("A foto do espelho não estava segura ({mirror_reason}) e o devicectl também não conseguiu fotografar: {e}"));
        }
        Ok(ComputerUseScreenshot { path: out.to_path_buf(), source: ScreenshotSource::DeviceCtl, elapsed: started.elapsed() })
    }

    fn capture_devicectl(identifier: &str, path: &std::path::Path) -> Result<(), String> {
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.args(["devicectl", "device", "capture", "screenshot", "--device", identifier, "--quiet", "--destination"]).arg(path);
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(40))
            .map_err(|e| format!("devicectl: {}", model::device_error_help(&e.to_string())))?;
        if !out.status.success() || !path.is_file() {
            return Err(format!("Não deu para fotografar o iPhone: {}", model::device_error_help(&String::from_utf8_lossy(&out.stderr))));
        }
        Ok(())
    }

    /// Lista só nome e bundle id: o caminho dos containers não vai para o contexto do agente.
    pub fn apps(device: &str) -> Result<Vec<serde_json::Value>, String> {
        ensure_session_active(device)?;
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        let root = devicectl_json(&["device", "info", "apps", "--device", identifier, "--include-all-apps"])?;
        let rows = root.pointer("/result/apps").and_then(serde_json::Value::as_array)
            .ok_or("O devicectl não devolveu a lista de apps instalados.")?;
        Ok(rows.iter().filter_map(|app| {
            let bundle = app.get("bundleIdentifier").and_then(serde_json::Value::as_str)?;
            let name = ["name", "displayName", "appName"].iter()
                .find_map(|key| app.get(key).and_then(serde_json::Value::as_str))
                .unwrap_or(bundle);
            Some(serde_json::json!({ "name": name, "bundleIdentifier": bundle }))
        }).collect())
    }

    /// Abre um app instalado pelo bundle id, com o CoreDevice do Xcode.
    pub fn launch(device: &str, bundle: &str) -> Result<(), String> {
        ensure_session_active(device)?;
        validate_bundle_id(bundle)?;
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        devicectl_ok(&["device", "process", "launch", "--device", identifier, bundle])
    }

    /// Encerra o processo do app pelo bundle id (o devicectl exige que a ADE resolva primeiro o PID).
    pub fn close(device: &str, bundle: &str) -> Result<usize, String> {
        ensure_session_active(device)?;
        validate_bundle_id(bundle)?;
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        let installed = devicectl_json(&["device", "info", "apps", "--device", identifier, "--include-all-apps"])?;
        let app = installed.pointer("/result/apps").and_then(serde_json::Value::as_array)
            .and_then(|apps| apps.iter().find(|app| app.get("bundleIdentifier").and_then(serde_json::Value::as_str) == Some(bundle)))
            .ok_or_else(|| format!("O app {bundle} não está instalado neste iPhone."))?;
        let app_url = path_field(app, &["url", "bundleURL", "bundleUrl", "applicationPath"]);
        let processes = devicectl_json(&["device", "info", "processes", "--device", identifier])?;
        let rows = processes.pointer("/result/runningProcesses")
            .or_else(|| processes.pointer("/result/processes"))
            .and_then(serde_json::Value::as_array)
            .ok_or("O devicectl não devolveu os processos em execução.")?;
        let pids: BTreeSet<u64> = rows.iter().filter_map(|process| {
            let declared_bundle = ["bundleIdentifier", "bundleID", "bundleId"].iter()
                .find_map(|key| process.get(key).and_then(serde_json::Value::as_str));
            let executable = path_field(process, &["executable", "executablePath"]);
            let path_matches = executable.is_some_and(|executable| {
                let app_bundle = app_url.map(device_path).unwrap_or_default();
                let executable = device_path(executable);
                let app_bundle = app_bundle.trim_end_matches('/');
                let by_app_url = !app_bundle.is_empty() && executable.strip_prefix(app_bundle)
                    .is_some_and(|tail| tail.starts_with('/') && !tail.trim_start_matches('/').is_empty() && !tail.trim_start_matches('/').contains('/'));
                let marker = format!("/{bundle}.app/");
                let by_bundle_id = executable.find(&marker).is_some_and(|at| {
                    let binary = &executable[at + marker.len()..];
                    !binary.is_empty() && !binary.contains('/')
                });
                by_app_url || by_bundle_id
            });
            if declared_bundle != Some(bundle) && !path_matches {
                return None;
            }
            let pid = process.get("processIdentifier").or_else(|| process.get("pid"))?;
            pid.as_u64().or_else(|| pid.as_str()?.parse().ok())
        }).collect();
        if pids.is_empty() {
            return Ok(0);
        }
        for pid in &pids {
            let pid = pid.to_string();
            devicectl_ok(&["device", "process", "terminate", "--device", identifier, "--pid", &pid])?;
        }
        Ok(pids.len())
    }

    /// O `devicectl` representa alguns caminhos como URL ou como objeto `{ path | url }`.
    fn path_field<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
        keys.iter().find_map(|key| {
            let field = value.get(*key)?;
            field.as_str().or_else(|| ["path", "url"].iter().find_map(|nested| field.get(*nested).and_then(serde_json::Value::as_str)))
        })
    }

    /// Converte file:// para caminho local e mantém caminhos absolutos como vieram do aparelho.
    fn device_path(raw: &str) -> String {
        if let Ok(url) = url::Url::parse(raw) {
            if url.scheme() == "file" {
                if let Ok(path) = url.to_file_path() {
                    return path.to_string_lossy().into_owned();
                }
            }
        }
        raw.to_string()
    }

    /// Abre uma URL pelo app padrão do iOS, incluindo esquemas próprios de apps.
    pub fn open_url(device: &str, raw_url: &str) -> Result<(), String> {
        ensure_session_active(device)?;
        if raw_url.len() > 4096 || raw_url.chars().any(char::is_control) || url::Url::parse(raw_url).is_err() {
            return Err("Informe uma URL absoluta válida para abrir no iPhone.".into());
        }
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        devicectl_ok(&["device", "process", "openURL", "--device", identifier, raw_url])
            .map_err(|error| error.replace(raw_url, "[URL omitida]"))
    }

    fn validate_bundle_id(bundle: &str) -> Result<(), String> {
        let parts: Vec<_> = bundle.split('.').collect();
        if bundle.len() > 255 || parts.len() < 2 || parts.iter().any(|part| {
            part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) {
            return Err("Use o bundle id do app (por exemplo, com.apple.mobilesafari), não um caminho local.".into());
        }
        Ok(())
    }

    fn devicectl_json(args: &[&str]) -> Result<serde_json::Value, String> {
        let path = std::env::temp_dir().join(format!("ade-devicectl-{}-{}.json", std::process::id(), crate::util::now_ts_ms()));
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.args(["devicectl"]).args(args).args(["--quiet", "--json-output"]).arg(&path);
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(40))
            .map_err(|e| format!("devicectl: {}", model::device_error_help(&e.to_string())))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&path);
            return Err(devicectl_error(&out.stderr));
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("Não foi possível ler a resposta do devicectl: {e}"));
        let _ = std::fs::remove_file(&path);
        serde_json::from_str(&raw?).map_err(|e| format!("O devicectl devolveu JSON inválido: {e}"))
    }

    fn devicectl_ok(args: &[&str]) -> Result<(), String> {
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.args(["devicectl"]).args(args).arg("--quiet");
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(40))
            .map_err(|e| format!("devicectl: {}", model::device_error_help(&e.to_string())))?;
        if !out.status.success() {
            return Err(devicectl_error(&out.stderr));
        }
        Ok(())
    }

    fn devicectl_error(stderr: &[u8]) -> String {
        let raw = String::from_utf8_lossy(stderr);
        format!("devicectl: {}", model::device_error_help(&raw))
    }
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(not(target_os = "macos"))]
mod none {
    use super::*;
    const NO: &str = "O iPhone físico só existe no macOS, com o Xcode 27.";
    pub fn ready_now(_: &AppHandle, _: &str) -> Result<bool, String> { Err(NO.into()) }
    pub fn points(_: &AppHandle, _: &str) -> Result<(f64, f64), String> { Err(NO.into()) }
    pub fn tap(_: &AppHandle, _: &str, _: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
    pub fn swipe(_: &AppHandle, _: &str, _: (f64, f64), _: (f64, f64), _: u64) -> Result<(), String> { Err(NO.into()) }
    pub fn type_text(_: &AppHandle, _: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn key(_: &AppHandle, _: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn button(_: &AppHandle, _: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn gesture(_: &AppHandle, _: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn button_state(_: &AppHandle, _: &str, _: &str, _: bool) -> Result<(), String> { Err(NO.into()) }
    pub fn apps(_: &str) -> Result<Vec<serde_json::Value>, String> { Err(NO.into()) }
    pub fn launch(_: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn close(_: &str, _: &str) -> Result<usize, String> { Err(NO.into()) }
    pub fn open_url(_: &str, _: &str) -> Result<(), String> { Err(NO.into()) }
    pub fn screenshot(_: &AppHandle, _: &str) -> Result<String, String> { Err(NO.into()) }
    pub fn screenshot_for_computer_use(_: &AppHandle, _: &str, _: &std::path::Path) -> Result<ComputerUseScreenshot, String> { Err(NO.into()) }
}

#[cfg(not(target_os = "macos"))]
pub use none::*;
