//! Comandos Tauri do iPhone físico: a lista (`devicectl`, público) e as telas que espelham um aparelho. As telas
//! seguem o mesmo contrato das do simulador (`simulator_attach/place/detach`): o frontend reserva o espaço e diz
//! onde a tela está; a view nativa fica por cima do webview.
//!
//! Uma sessão por aparelho, compartilhada pelas telas que o mostram (o nó do canvas e o painel do chat). Ela só
//! espelha enquanto alguma tela está à vista; sem ninguém olhando por um tempo, para (ver `model::IDLE_GRACE`).

use serde::Serialize;
use tauri::{Emitter, Runtime, Webview};

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
    use std::collections::{HashMap, HashSet};
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::AppHandle;

    use super::super::model::{self, PhysicalDevice};
    use super::super::mp4::Summary;
    use super::super::recording::{FileWriter, Recording, FIRST_FRAME_WAIT};
    use super::super::session::{self, Session, Status};

    #[derive(Default)]
    pub struct State {
        /// Tela → (aparelho, à vista).
        screens: HashMap<String, (String, bool)>,
        sessions: HashMap<String, Session>,
        /// A pessoa pausou todas as superfícies ADE deste aparelho; agentes não podem reabrir a sessão até reconectar.
        disconnected: HashSet<String>,
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
    pub fn open(app: &AppHandle, id: &str, device: &str, identifier: &str, visible: bool) -> Result<(std::sync::Arc<super::super::native::view::Presenter>, session::InputTx), String> {
        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
        if s.disconnected.contains(device) {
            return Err("A sessão deste iPhone foi desconectada no painel da ADE. Reconecte o aparelho antes de abrir outra tela.".into());
        }
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
        Ok((session.presenter.clone(), session.input()))
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
        if is_disconnected(device) {
            return Err("A sessão deste iPhone foi desconectada no painel da ADE. Reconecte o aparelho no painel antes de pedir outra ação.".into());
        }
        if let Some(why) = session::unavailable() {
            return Err(match why {
                "xcode" => "Instale ou selecione o Xcode 27 neste Mac e tente de novo.".into(),
                _ => "O helper do espelhamento não está disponível. Recompile a ADE com `bun run build:iphone-mirror` e tente de novo.".into(),
            });
        }
        let (presenter, input) = open(app, &agent_screen(device), device, &identifier, true)?;
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

    /// A conexão do espelho deste aparelho (`None`: não há sessão aberta).
    pub fn link_state(device: &str) -> Option<model::LinkState> {
        status(device).map(|status| status.state)
    }

    /// Uma gravação do vídeo do espelho: os quadros que a sessão já recebe vão para o MP4, sem recodificar.
    pub struct MirrorRecording {
        recording: Recording,
        link: session::RecordTx,
    }

    impl MirrorRecording {
        /// Finaliza o arquivo (o `moov` é escrito e o `.part` vira o destino).
        pub fn stop(self) -> Result<Summary, String> {
            self.link.set(None);
            self.recording.stop()
        }
    }

    /// Começa a gravar o espelho de `device` em `dest`. Só com o espelho ligado (`live`). Volta depois do primeiro
    /// quadro-chave no arquivo, então um erro de vídeo ou de disco aparece aqui e não só ao parar.
    pub fn start_recording(device: &str, dest: &Path) -> Result<MirrorRecording, String> {
        // A trava do estado só é segurada para ler o estado e copiar o canal; o arquivo é aberto depois.
        let link = {
            let s = state().lock().unwrap_or_else(|e| e.into_inner());
            let session = s.sessions.get(device).ok_or(NOT_LIVE)?;
            if session.status().state != model::LinkState::Live {
                return Err(NOT_LIVE.into());
            }
            session.recorder()
        };
        let recording = Recording::start(FileWriter::create(dest)?);
        link.set(Some(recording.tap()));
        match recording.wait_first_frame(FIRST_FRAME_WAIT) {
            Ok(()) => Ok(MirrorRecording { recording, link }),
            Err(error) => {
                link.set(None);
                recording.abort();
                Err(error)
            }
        }
    }

    const NOT_LIVE: &str = "O espelho do iPhone não está ligado. Abra a tela do aparelho na ADE, espere ela aparecer e grave de novo.";

    pub fn is_disconnected(device: &str) -> bool {
        state().lock().is_ok_and(|s| s.disconnected.contains(device))
    }

    /// Para o stream compartilhado e bloqueia novas sessões até a pessoa reconectar no painel.
    pub fn disconnect(device: &str) {
        if let Ok(mut s) = state().lock() {
            s.disconnected.insert(device.to_string());
            if let Some(session) = s.sessions.remove(device) {
                session.stop();
            }
        }
    }

    pub fn reconnect(device: &str) {
        if let Ok(mut s) = state().lock() {
            s.disconnected.remove(device);
        }
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

/// Pausa o espelhamento de todas as telas ADE deste iPhone, sem remover a confiança entre o Mac e o aparelho.
#[tauri::command]
pub fn iphone_mirror_disconnect(app: tauri::AppHandle, device: String) -> Result<(), String> {
    model::physical_identifier(&device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
    #[cfg(target_os = "macos")]
    {
        mac::disconnect(&device);
        let _ = app.emit("iphone-mirror-session", serde_json::json!({ "device": device, "disconnected": true }));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, device);
        Err(ONLY_MAC.into())
    }
}

/// Libera novamente o espelhamento deste iPhone; as superfícies visíveis o reabrem.
#[tauri::command]
pub fn iphone_mirror_connect(app: tauri::AppHandle, device: String) -> Result<(), String> {
    model::physical_identifier(&device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
    #[cfg(target_os = "macos")]
    {
        mac::reconnect(&device);
        let _ = app.emit("iphone-mirror-session", serde_json::json!({ "device": device, "disconnected": false }));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, device);
        Err(ONLY_MAC.into())
    }
}

/// Informa se a pessoa pausou a sessão ADE deste iPhone nesta execução do app.
#[tauri::command]
pub fn iphone_mirror_session_paused(device: String) -> Result<bool, String> {
    model::physical_identifier(&device).ok_or("Esse não é um aparelho físico do CoreDevice.")?;
    #[cfg(target_os = "macos")]
    {
        Ok(mac::is_disconnected(&device))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ONLY_MAC.into())
    }
}

/// Espelha o aparelho `device` (`device:<identificador>`) na tela `id`, no lugar `place`. Só ver.
#[tauri::command]
pub async fn iphone_mirror_attach<R: Runtime>(app: tauri::AppHandle, webview: Webview<R>, id: String, device: String, place: Place) -> Result<(), String> {
    let identifier = model::physical_identifier(&device).ok_or("Esse não é um aparelho físico do CoreDevice.")?.to_string();
    #[cfg(target_os = "macos")]
    {
        if mac::is_disconnected(&device) {
            return Ok(());
        }
        let (presenter, input) = match mac::open(&app, &id, &device, &identifier, place.visible.is_some()) {
            Ok(opened) => opened,
            Err(_) if mac::is_disconnected(&device) => return Ok(()),
            Err(error) => return Err(error),
        };
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

/// A pessoa segura ou solta um botão da lateral da moldura (`down`): segurar o lateral chama a Siri, como no aparelho.
#[tauri::command(async)]
pub fn iphone_button_state(app: tauri::AppHandle, device: String, name: String, down: bool) -> Result<(), String> {
    super::ops::button_state(&app, &device, &name, down)
}

/// A pessoa digitou um texto para o aparelho (teclado US, só ASCII).
#[tauri::command(async)]
pub fn iphone_type(app: tauri::AppHandle, device: String, text: String) -> Result<(), String> {
    super::ops::type_text(&app, &device, &text)
}

/// A foto da tela (o último quadro do espelho, sem as bordas do vídeo) num PNG; devolve o caminho.
#[tauri::command(async)]
pub fn iphone_screenshot(app: tauri::AppHandle, device: String) -> Result<String, String> {
    let tmp = super::ops::screenshot(&app, &device)?;
    let dir = dirs::picture_dir().or_else(dirs::download_dir).unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!("iPhone {}.png", chrono::Local::now().format("%Y-%m-%d %H.%M.%S")));
    std::fs::rename(&tmp, &path).or_else(|_| std::fs::copy(&tmp, &path).map(|_| ())).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copia um PNG para a área de transferência do Mac (a foto da tela, para colar em outro lugar).
#[tauri::command(async)]
pub fn iphone_copy_image(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::sel;
        use crate::simulator::native::objc::{call, class, ns_string};
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if !bytes.starts_with(b"\x89PNG") {
            return Err("Isso não é um PNG.".into());
        }
        let data = objc2_foundation::NSData::with_bytes(&bytes);
        let kind = ns_string("public.png");
        // SAFETY: NSPasteboard público; os objetos vivem até o fim da chamada.
        unsafe {
            let board = call!(class(c"NSPasteboard").ok_or("Sem área de transferência.")?, sel!(generalPasteboard); -> *mut AnyObject);
            call!(board, sel!(clearContents); -> isize);
            let ok = call!(board, sel!(setData:forType:), Retained::as_ptr(&data) as *mut AnyObject => *mut AnyObject, Retained::as_ptr(&kind) as *mut AnyObject => *mut AnyObject; -> bool);
            if !ok {
                return Err("Não deu para copiar a foto.".into());
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Só no macOS.".into())
    }
}
