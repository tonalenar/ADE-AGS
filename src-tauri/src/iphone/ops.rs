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

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::iphone::commands::mac as screens;
    use crate::iphone::session::{InputTx, Status};

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
        let (input, status, presenter, family) = screens::agent(app, device, READY_WAIT)?;
        Ok(Ready { input, status, presenter, family, device: device.to_string() })
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

    fn drag(input: &InputTx, from: (f64, f64), to: (f64, f64), ms: u64, edge: Edge) {
        let steps = (ms / 16).clamp(4, 120) as u32;
        let lines = model::swipe_lines(from, to, steps, edge);
        let last = lines.len() - 1;
        for (i, line) in lines.into_iter().enumerate() {
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
        drag(&r.input, a, b, ms, Edge::None);
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
        let g = model::gesture(name).ok_or_else(|| format!("Gesto desconhecido: \"{name}\" (controlCenter, notificationCenter, spotlight ou home)."))?;
        let r = ready(app, device)?;
        drag(&r.input, g.from, g.to, g.ms, g.edge);
        Ok(())
    }

    /// A foto da tela num PNG temporário: o último quadro do espelho (sem as bordas do vídeo); sem quadro, a do
    /// `devicectl` (pública, ~1 s).
    pub fn screenshot(app: &AppHandle, device: &str) -> Result<String, String> {
        let dir = std::env::temp_dir().join("ade-iphone");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("shot-{}.png", crate::util::now_ts_ms()));
        if let Ok(r) = ready(app, device) {
            if let Some((mut data, w, h)) = r.presenter.snapshot() {
                if crate::computer_use::png_from_bgra(&mut data, w, h, &path).is_ok() {
                    return Ok(path.to_string_lossy().into_owned());
                }
            }
        }
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.args(["devicectl", "device", "capture", "screenshot", "--device", identifier, "--quiet", "--destination"]).arg(&path);
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(40)).map_err(|e| format!("devicectl: {e}"))?;
        if !out.status.success() || !path.is_file() {
            return Err(format!("Não deu para fotografar o aparelho: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(path.to_string_lossy().into_owned())
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
    pub fn screenshot(_: &AppHandle, _: &str) -> Result<String, String> { Err(NO.into()) }
}

#[cfg(not(target_os = "macos"))]
pub use none::*;
