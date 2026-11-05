//! Comandos Tauri do iPhone físico: a lista (`devicectl`, público) e as telas que espelham um aparelho. As telas
//! seguem o mesmo contrato das do simulador (`simulator_attach/place/detach`): o frontend reserva o espaço e diz
//! onde a tela está; a view nativa fica por cima do webview.
//!
//! Uma sessão por aparelho, compartilhada pelas telas que o mostram (o nó do canvas e o painel do chat). Ela só
//! espelha enquanto alguma tela está à vista; sem ninguém olhando por um tempo, para (ver `model::IDLE_GRACE`).

use serde::Serialize;
use tauri::{Runtime, Webview};

use super::model::{self, PhysicalDevice};
use crate::simulator::model::Place;

/// A lista para o seletor. `unavailable`: por que não dá para espelhar neste Mac (`xcode`, `helper`, `platform`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub devices: Vec<PhysicalDevice>,
    pub unavailable: Option<&'static str>,
}

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::AppHandle;

    use super::super::model::{self, PhysicalDevice};
    use super::super::session::{self, Session, Status};

    #[derive(Default)]
    pub struct State {
        /// Tela → (aparelho, à vista).
        screens: HashMap<String, (String, bool)>,
        sessions: HashMap<String, Session>,
        /// O IPv6 do aparelho no túnel, pela última lista (o helper o usa se o CoreDevice não disser).
        tunnels: HashMap<String, String>,
        /// `iphone` ou `ipad`, pela última lista (para a tela em pontos).
        families: HashMap<String, String>,
    }

    impl State {
        fn visible(&self, device: &str) -> bool {
            self.screens.values().any(|(d, v)| d == device && *v)
        }
    }

    pub fn state() -> &'static Mutex<State> {
        static S: OnceLock<Mutex<State>> = OnceLock::new();
        S.get_or_init(Default::default)
    }

    pub fn devices() -> Result<Vec<PhysicalDevice>, String> {
        let file = std::env::temp_dir().join(format!("ade-devicectl-{}-{}.json", std::process::id(), crate::util::now_ts_ms()));
        let mut cmd = crate::util::spawn::hidden_command("xcrun");
        cmd.args(["devicectl", "list", "devices", "--quiet", "--json-output"]).arg(&file);
        let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(20)).map_err(|e| format!("devicectl: {e}"))?;
        let json = std::fs::read_to_string(&file);
        let _ = std::fs::remove_file(&file);
        if !out.status.success() {
            return Err(format!("devicectl: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let list = model::parse_devicectl(&json.map_err(|e| format!("devicectl: {e}"))?)?;
        if let Ok(mut s) = state().lock() {
            for d in &list {
                if let Some(ip) = &d.tunnel_ip {
                    s.tunnels.insert(d.id.clone(), ip.clone());
                }
                s.families.insert(d.id.clone(), d.family.clone());
            }
        }
        Ok(list)
    }

    pub fn unavailable() -> Option<&'static str> {
        session::unavailable()
    }

    /// A tela `id` passa a mostrar `device`: abre a sessão do aparelho, se for a primeira. Devolve os quadros e por
    /// onde mandar entrada.
    pub fn open(app: &AppHandle, id: &str, device: &str, identifier: &str, visible: bool) -> (std::sync::Arc<super::super::native::view::Presenter>, session::InputTx) {
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        // A tela trocou de aparelho: o anterior pode ter ficado sem ninguém.
        if let Some((old, _)) = s.screens.insert(id.to_string(), (device.to_string(), visible)) {
            if old != device {
                settle(&mut s, &old);
            }
        }
        let tunnel = s.tunnels.get(device).cloned();
        let any = s.visible(device);
        let session = s
            .sessions
            .entry(device.to_string())
            .or_insert_with(|| session::start(app.clone(), device.to_string(), identifier.to_string(), tunnel, any));
        session.want(any);
        (session.presenter.clone(), session.input())
    }

    /// O id da "tela" que um agente usa enquanto age (sem ninguém olhando, o aparelho também precisa espelhar para
    /// a foto e para o toque saber o tamanho da tela).
    fn agent_screen(device: &str) -> String {
        format!("agent:{device}")
    }

    /// A sessão do aparelho para um agente, já ligada e com o toque pronto (espera até `wait`). Abre uma se não
    /// houver; `release` a solta (ela para sozinha depois de um tempo sem ninguém olhando).
    pub fn agent(app: &AppHandle, device: &str, wait: Duration) -> Result<(session::InputTx, session::Status, std::sync::Arc<super::super::native::view::Presenter>, String), String> {
        let identifier = model::physical_identifier(device).ok_or("Esse não é um aparelho físico do CoreDevice.")?.to_string();
        if let Some(why) = session::unavailable() {
            return Err(match why {
                "xcode" => "O controle do aparelho precisa do Xcode 27 neste Mac.".into(),
                _ => "Este app veio sem o helper do espelhamento.".into(),
            });
        }
        let (presenter, input) = open(app, &agent_screen(device), device, &identifier, true);
        let (waiter, family) = {
            let s = state().lock().unwrap_or_else(|e| e.into_inner());
            let session = s.sessions.get(device).ok_or("A sessão do aparelho não abriu.")?;
            (session.waiter(), s.families.get(device).cloned().unwrap_or_else(|| "iphone".into()))
        };
        // Espera fora da trava do estado: as telas seguem atualizando enquanto o aparelho liga.
        let status = waiter.wait(wait)?;
        Ok((input, status, presenter, family))
    }

    /// O agente terminou: a "tela" dele sai de vista (a sessão para depois de um tempo, se ninguém mais olhar).
    pub fn release(device: &str) {
        seen(&agent_screen(device), false);
    }

    pub fn seen(id: &str, visible: bool) {
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        let Some(device) = s.screens.get_mut(id).map(|entry| {
            entry.1 = visible;
            entry.0.clone()
        }) else {
            return;
        };
        settle(&mut s, &device);
    }

    pub fn close(id: &str) {
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((device, _)) = s.screens.remove(id) {
            settle(&mut s, &device);
        }
    }

    /// Diz à sessão do aparelho se alguém olha; sem nenhuma tela, ela para (e para o stream no aparelho).
    fn settle(s: &mut State, device: &str) {
        let has_screen = s.screens.values().any(|(d, _)| d == device);
        if !has_screen {
            if let Some(session) = s.sessions.remove(device) {
                session.stop();
            }
            return;
        }
        let any = s.visible(device);
        if let Some(session) = s.sessions.get(device) {
            session.want(any);
        }
    }

    pub fn status(device: &str) -> Option<Status> {
        state().lock().ok()?.sessions.get(device).map(Session::status)
    }

    pub fn stop_all() {
        if let Ok(mut s) = state().lock() {
            for (_, session) in s.sessions.drain() {
                session.stop();
            }
            s.screens.clear();
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::stop_all;

#[cfg(not(target_os = "macos"))]
pub fn stop_all() {}

#[cfg(not(target_os = "macos"))]
const ONLY_MAC: &str = "O espelhamento de iPhone e iPad só existe no macOS, com o Xcode 27.";

/// Os iPhones e iPads físicos que o CoreDevice conhece (USB ou Wi-Fi), com modelo e versão do iOS.
#[tauri::command(async)]
pub fn iphone_devices() -> DeviceList {
    #[cfg(target_os = "macos")]
    {
        match mac::devices() {
            Ok(devices) => DeviceList { devices, unavailable: mac::unavailable() },
            Err(e) => {
                eprintln!("[iphone] {e}");
                DeviceList { devices: Vec::new(), unavailable: Some("xcode") }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        DeviceList { devices: Vec::new(), unavailable: Some("platform") }
    }
}

/// Espelha o aparelho `device` (`device:<identificador>`) na tela `id`, no lugar `place`. Só ver.
#[tauri::command]
pub async fn iphone_mirror_attach<R: Runtime>(app: tauri::AppHandle, webview: Webview<R>, id: String, device: String, place: Place) -> Result<(), String> {
    let identifier = model::physical_identifier(&device).ok_or("Esse não é um aparelho físico do CoreDevice.")?.to_string();
    #[cfg(target_os = "macos")]
    {
        let (presenter, input) = mac::open(&app, &id, &device, &identifier, place.visible.is_some());
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                // SAFETY: `with_webview` roda na thread da interface e `inner()` é o WKWebView da janela.
                let result = unsafe { super::native::view::attach(platform.inner(), &id, presenter, input, &place) };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "A interface não respondeu.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, webview, id, identifier, place);
        Err(ONLY_MAC.into())
    }
}

/// Onde a tela está agora (o canvas moveu, deu zoom, um menu abriu por cima).
#[tauri::command]
pub fn iphone_mirror_place<R: Runtime>(webview: Webview<R>, id: String, place: Place) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::seen(&id, place.visible.is_some());
        webview
            .with_webview(move |platform| {
                // SAFETY: thread da interface e WKWebView da janela, como em `iphone_mirror_attach`.
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

/// Tira a tela `id` da janela. A última tela de um aparelho para o espelhamento dele.
#[tauri::command]
pub fn iphone_mirror_detach<R: Runtime>(webview: Webview<R>, id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::close(&id);
        webview.with_webview(move |_| super::native::view::detach(&id)).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, id);
        Ok(())
    }
}

/// O estado atual do espelhamento de `device` (o mesmo do evento `iphone-mirror-status`); `null` = nenhuma tela.
#[tauri::command]
pub fn iphone_mirror_status(device: String) -> Option<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        mac::status(&device).and_then(|s| serde_json::to_value(s).ok())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = device;
        None
    }
}

/// A pessoa apertou um botão do aparelho na interface (início, bloquear, volume, mudo, Siri). É a pessoa: não pede
/// confirmação. Espera o toque ficar pronto, se o espelhamento ainda estiver abrindo.
#[tauri::command(async)]
pub fn iphone_button(app: tauri::AppHandle, device: String, name: String) -> Result<(), String> {
    super::ops::button(&app, &device, &name)
}

/// A pessoa pediu um gesto do sistema na interface: Central de Controle, Central de Notificações, Busca ou início.
#[tauri::command(async)]
pub fn iphone_gesture(app: tauri::AppHandle, device: String, name: String) -> Result<(), String> {
    super::ops::gesture(&app, &device, &name)
}
