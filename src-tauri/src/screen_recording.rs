//! Gravações locais de telas de aparelhos para o agente inspecionar os quadros depois.
//!
//! O vídeo é codificado pela ferramenta nativa do aparelho (H.264); nenhum quadro é enviado a um serviço.
//! Só há uma gravação ativa para evitar competir pelo codificador e pelo disco.

use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::{io::Write, time::Duration};

const MAX_DEVICE_SECONDS: &str = "120";

struct ActiveRecording {
    id: String,
    child: Child,
    stop_stdin: Option<ChildStdin>,
    path: PathBuf,
    android: Option<AndroidRecording>,
}

struct StartedRecording {
    child: Child,
    stop_stdin: Option<ChildStdin>,
    android: Option<AndroidRecording>,
}

struct AndroidRecording {
    serial: String,
    remote_video: String,
    remote_pid_file: String,
}

fn active() -> &'static Mutex<Option<ActiveRecording>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveRecording>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

static STARTING: AtomicBool = AtomicBool::new(false);

struct StartingGuard;
impl Drop for StartingGuard {
    fn drop(&mut self) {
        STARTING.store(false, Ordering::Release);
    }
}

fn recordings_dir() -> Result<PathBuf, String> {
    let base = dirs::video_dir()
        .or_else(dirs::home_dir)
        .ok_or("Não encontrei a pasta Vídeos deste usuário.")?;
    let dir = base.join("ADE AGS");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Não consegui criar a pasta de gravações: {e}"))?;
    Ok(dir)
}

fn safe_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect()
}

fn video_path(label: &str, extension: &str) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    Ok(recordings_dir()?.join(format!(
        "ADE-AGS_{}_{}.{}",
        safe_name(label),
        stamp,
        extension
    )))
}

/// Começa a gravar uma fonte identificada por `kind` e pelo identificador estável do aparelho.
pub fn start(kind: &str, target: &str) -> Result<String, String> {
    STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Outra gravação está começando agora.".to_string())?;
    let _starting = StartingGuard;
    let id = format!("{kind}:{target}");
    if let Some(recording) = active()
        .lock()
        .map_err(|_| "O estado de gravação ficou indisponível.")?
        .as_ref()
    {
        return Err(format!(
            "Já existe uma gravação ativa ({}) — pare-a antes de iniciar outra.",
            recording.id
        ));
    }
    let label = match kind {
        "iphone" => "iPhone",
        "simulator" => "simulator",
        "android" => "android",
        "desktop" => "desktop",
        _ => return Err("Tipo de tela desconhecido para gravação.".into()),
    };
    let safe_target = safe_name(target);
    let target_label = if kind == "desktop" {
        "tela-principal"
    } else {
        &safe_target[..safe_target.len().min(16)]
    };
    let extension = if kind == "desktop" { "mov" } else { "mp4" };
    let path = video_path(&format!("{label}_{target_label}"), extension)?;
    if path.exists() {
        return Err("O arquivo desta gravação já existe; tente novamente.".into());
    }

    let started = match kind {
        "iphone" => start_iphone(target, &path),
        "simulator" => start_simulator(target, &path),
        "android" => start_android(target, &path),
        "desktop" => start_desktop(&path),
        _ => unreachable!(),
    };
    let StartedRecording {
        mut child,
        stop_stdin,
        android,
    } = match started {
        Ok(started) => started,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "A ferramenta de gravação terminou ao iniciar (código {}). Confira se o aparelho continua conectado.",
                status
                    .code()
                    .map_or_else(|| "desconhecido".into(), |n| n.to_string())
            ));
        }
        Ok(None) => {}
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&path);
            return Err(format!("Não consegui iniciar a gravação: {error}"));
        }
    }
    *active()
        .lock()
        .map_err(|_| "O estado de gravação ficou indisponível.")? = Some(ActiveRecording {
        id: id.clone(),
        child,
        stop_stdin,
        path,
        android,
    });
    Ok(id)
}

#[cfg(target_os = "macos")]
fn start_iphone(device: &str, path: &Path) -> Result<StartedRecording, String> {
    let identifier = crate::iphone::model::physical_identifier(device)
        .ok_or("Selecione um iPhone ou iPad físico conectado à ADE.")?;
    let mut command = crate::util::spawn::hidden_command("xcrun");
    command
        .args([
            "devicectl",
            "device",
            "capture",
            "screen-record",
            "--device",
        ])
        // A ADE guarda o alvo como `device:<CoreDevice id>`; o devicectl espera só o UUID.
        .arg(identifier)
        .arg("--destination")
        .arg(path)
        .args([
            "--codec",
            "h264",
            "--duration",
            MAX_DEVICE_SECONDS,
            "--quiet",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui abrir a gravação do iPhone: {e}"))?;
    Ok(StartedRecording {
        child,
        stop_stdin: None,
        android: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn start_iphone(_: &str, _: &Path) -> Result<StartedRecording, String> {
    Err("A gravação do iPhone físico exige o devicectl no macOS.".into())
}

#[cfg(target_os = "macos")]
fn start_simulator(udid: &str, path: &Path) -> Result<StartedRecording, String> {
    let known = crate::simulator::ops::devices()?
        .iter()
        .any(|device| device.udid == udid && device.state == "booted");
    if !known {
        return Err("Ligue um simulador iOS antes de gravar.".into());
    }
    let mut command = crate::util::spawn::hidden_command("xcrun");
    command
        .args([
            "simctl",
            "io",
            udid,
            "recordVideo",
            "--codec=h264",
            "--force",
        ])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui abrir a gravação do simulador: {e}"))?;
    Ok(StartedRecording {
        child,
        stop_stdin: None,
        android: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn start_simulator(_: &str, _: &Path) -> Result<StartedRecording, String> {
    Err("A gravação do simulador iOS exige o Xcode no macOS.".into())
}

fn start_android(serial: &str, _path: &Path) -> Result<StartedRecording, String> {
    let device = crate::android::devices()?
        .into_iter()
        .any(|device| device.serial == serial && device.state == "device");
    if !device {
        return Err("Selecione um Android conectado e autorizado.".into());
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let remote_video = format!("/sdcard/Movies/ADE-AGS-{token}.mp4");
    let remote_pid_file = format!("/data/local/tmp/ade-ags-record-{token}.pid");
    let script = format!(
        "mkdir -p /sdcard/Movies; screenrecord --bit-rate 6000000 --time-limit {MAX_DEVICE_SECONDS} '{remote_video}' >/dev/null 2>&1 & pid=$!; echo $pid > '{remote_pid_file}'; wait $pid"
    );
    let mut command = crate::android::screen_record_command(serial, &script)?;
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui iniciar a gravação do Android: {e}"))?;
    Ok(StartedRecording {
        child,
        stop_stdin: None,
        android: Some(AndroidRecording {
            serial: serial.to_string(),
            remote_video,
            remote_pid_file,
        }),
    })
}

#[cfg(target_os = "macos")]
fn start_desktop(path: &Path) -> Result<StartedRecording, String> {
    let mut command = crate::util::spawn::hidden_command("/usr/bin/swift");
    command
        .arg("-e")
        .arg(include_str!("screen_recording.swift"))
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Não consegui iniciar o ScreenCaptureKit: {e}"))?;
    let mut output = child
        .stdout
        .take()
        .ok_or("A captura de tela não abriu a saída de estado.")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result =
            std::io::BufRead::read_line(&mut std::io::BufReader::new(&mut output), &mut line);
        let _ = tx.send(result.map(|_| line));
    });
    let state = match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Não consegui iniciar a captura de tela: {error}"));
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("A captura de tela não respondeu. Confira a permissão de Gravação de Tela do macOS e reabra a ADE depois de autorizá-la.".into());
        }
    };
    if !state.trim().eq("READY") {
        let _ = child.wait();
        return Err(state
            .trim()
            .strip_prefix("ERROR:")
            .unwrap_or("O macOS recusou a captura de tela.")
            .to_string());
    }
    let stop_stdin = child.stdin.take();
    Ok(StartedRecording {
        child,
        stop_stdin,
        android: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn start_desktop(_: &Path) -> Result<StartedRecording, String> {
    Err("A gravação da tela do computador está disponível no macOS nesta versão.".into())
}

/// O estado atual para restaurar o controle ao reabrir o painel.
pub fn status() -> Option<String> {
    active()
        .lock()
        .ok()?
        .as_ref()
        .map(|recording| recording.id.clone())
}

/// Para a gravação, finaliza o MP4 e devolve o caminho local.
pub fn stop(id: &str) -> Result<String, String> {
    let mut current = active()
        .lock()
        .map_err(|_| "O estado de gravação ficou indisponível.")?;
    let recording = current.as_mut().ok_or("Não há gravação ativa.")?;
    if recording.id != id {
        return Err("A gravação ativa pertence a outra tela.".into());
    }

    if let Some(android) = &recording.android {
        crate::android::stop_screen_record(
            &android.serial,
            &android.remote_video,
            &android.remote_pid_file,
        )?;
    } else if let Some(mut input) = recording.stop_stdin.take() {
        input
            .write_all(b"stop\n")
            .map_err(|e| format!("Não consegui pedir o encerramento da gravação: {e}"))?;
    } else {
        interrupt(&mut recording.child)?;
    }
    let status = recording
        .child
        .wait()
        .map_err(|e| format!("Não consegui finalizar o vídeo: {e}"))?;
    if !status.success() && !recording.path.exists() && recording.android.is_none() {
        return Err("A gravação não gerou um vídeo finalizado. Tente gravar novamente.".into());
    }
    if let Some(android) = &recording.android {
        crate::android::pull_screen_record(
            &android.serial,
            &android.remote_video,
            &android.remote_pid_file,
            &recording.path,
        )?;
    }
    let metadata =
        std::fs::metadata(&recording.path).map_err(|e| format!("O MP4 não foi salvo: {e}"))?;
    if metadata.len() == 0 {
        let _ = std::fs::remove_file(&recording.path);
        *current = None;
        return Err(
            "O vídeo ficou vazio. Tente novamente depois de alguns segundos de gravação.".into(),
        );
    }
    let path = recording.path.to_string_lossy().into_owned();
    *current = None;
    Ok(path)
}

#[cfg(unix)]
fn interrupt(child: &mut Child) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    // SAFETY: sinal enviado exclusivamente ao PID do filho que esta instância iniciou.
    let result = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGINT) };
    if result == 0 {
        Ok(())
    } else {
        Err("Não consegui parar a gravação nativa.".into())
    }
}

#[cfg(windows)]
fn interrupt(child: &mut Child) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    child
        .kill()
        .map_err(|e| format!("Não consegui parar a gravação nativa: {e}"))
}

/// Para a gravação na saída do app, sem deixar processo ou vídeo aberto.
pub fn stop_all() {
    let id = status();
    if let Some(id) = id {
        let _ = stop(&id);
    }
}

#[tauri::command(async)]
pub fn screen_recording_start(kind: String, target: String) -> Result<String, String> {
    start(&kind, &target)
}

#[tauri::command]
pub fn screen_recording_status() -> Option<String> {
    status()
}

#[tauri::command(async)]
pub fn screen_recording_stop(id: String) -> Result<String, String> {
    stop(&id)
}
