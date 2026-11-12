//! Gravações locais de telas de aparelhos para o agente inspecionar os quadros depois.
//!
//! O vídeo é codificado pela ferramenta nativa do aparelho (H.264); nenhum quadro é enviado a um serviço.
//! Só há uma gravação ativa para evitar competir pelo codificador e pelo disco.
//!
//! A ferramenta de captura (`devicectl`, `simctl`, o helper do ScreenCaptureKit, `adb`) roda como processo filho.
//! Tudo o que ela escreve (stdout e stderr) fica num registro curto, e é ele que explica a falha: antes a saída era
//! descartada e qualquer problema virava "não gerou um vídeo finalizado".

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::{
    Arc, Condvar, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

const MAX_DEVICE_SECONDS: &str = "120";

/// Quanto da saída da ferramenta guardamos (o fim, que é onde está o motivo da falha).
const LOG_LIMIT: usize = 8 * 1024;
/// Quanto do registro entra na mensagem mostrada à pessoa.
const MESSAGE_TAIL: usize = 300;

/// Marcador que o frontend reconhece para oferecer o painel de Gravação de Tela.
pub(crate) const PERMISSION_MARKER: &str = "SCREEN_CAPTURE_PERMISSION_REQUIRED:";

/// Prazo para uma ferramenta de aparelho falhar logo ao iniciar (aparelho bloqueado, desconectado, simulador desligado…).
const EARLY_FAILURE_WINDOW: Duration = Duration::from_secs(3);
/// Prazo para o `simctl` dizer que começou a gravar.
const SIMULATOR_START_WINDOW: Duration = Duration::from_secs(10);
/// Prazo para o helper do ScreenCaptureKit responder (o macOS pode estar esperando a permissão).
const DESKTOP_START_WINDOW: Duration = Duration::from_secs(90);
/// Prazo para a ferramenta fechar o arquivo depois de pedirmos para parar.
const FINISH_WINDOW: Duration = Duration::from_secs(30);

/// Como o processo de captura terminou.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitInfo {
    fn from_status(status: ExitStatus) -> Self {
        #[cfg(unix)]
        let signal = std::os::unix::process::ExitStatusExt::signal(&status);
        #[cfg(not(unix))]
        let signal = None;
        Self {
            code: status.code(),
            signal,
        }
    }

    fn success(self) -> bool {
        self.code == Some(0)
    }

    fn describe(self) -> String {
        match (self.code, self.signal) {
            (Some(code), _) => format!("código {code}"),
            (None, Some(signal)) => format!("sinal {signal}"),
            (None, None) => "código desconhecido".into(),
        }
    }
}

/// As últimas linhas úteis do que a ferramenta escreveu, numa linha só e com tamanho limitado.
fn log_tail(log: &str) -> String {
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(3);
    let joined = lines[start..].join(" / ");
    let count = joined.chars().count();
    if count <= MESSAGE_TAIL {
        joined
    } else {
        let tail: String = joined.chars().skip(count - MESSAGE_TAIL).collect();
        format!("…{tail}")
    }
}

/// Explica por que a ferramenta falhou, a partir do que ela escreveu. Reconhece as causas que a pessoa consegue
/// resolver; o resto mostra o código de saída e o fim da saída, em vez de uma frase genérica.
fn explain_failure(kind: &str, exit: ExitInfo, log: &str) -> String {
    let lower = log.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));

    if kind == "desktop"
        && has(&[
            "declined tcc",
            "-3801",
            "tcc",
            "not authorized",
            "not permitted to capture",
            "screen_capture_permission",
        ])
    {
        return format!(
            "{PERMISSION_MARKER} O macOS não autorizou a Gravação de Tela para a ADE AGS. Abra Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema e habilite ADE AGS. Se ela já estiver na lista, remova e adicione de novo (trocar a assinatura do app invalida a autorização antiga) e reabra a ADE."
        );
    }
    if has(&["operation not permitted", "permission denied"]) {
        return format!(
            "O macOS não deixou a gravação escrever na pasta de vídeos. Abra Ajustes do Sistema → Privacidade e Segurança → Arquivos e Pastas (ou Acesso Total ao Disco) e autorize ADE AGS. Detalhe: {}",
            log_tail(log)
        );
    }
    if kind == "simulator"
        && has(&[
            "no devices are booted",
            "unable to find device",
            "invalid device state",
            "not booted",
        ])
    {
        return "O simulador iOS não está ligado (ou foi desligado durante a gravação). Ligue-o e grave de novo.".into();
    }
    if kind == "iphone" {
        if has(&["locked"]) {
            return format!(
                "O iPhone está bloqueado. Desbloqueie a tela e grave de novo. Detalhe: {}",
                log_tail(log)
            );
        }
        if has(&["developer mode"]) {
            return "O iPhone está com o Modo de Desenvolvedor desligado. Ligue em Ajustes → Privacidade e Segurança → Modo de Desenvolvedor.".into();
        }
        if has(&[
            "no devices found",
            "not connected",
            "unavailable",
            "disconnected",
            "could not connect",
            "tunnel",
        ]) {
            return format!(
                "O iPhone não está conectado à ADE. Reconecte o cabo (ou o Wi-Fi) e grave de novo. Detalhe: {}",
                log_tail(log)
            );
        }
    }
    let tail = log_tail(log);
    if tail.is_empty() {
        format!(
            "A ferramenta de gravação parou ({}) sem dizer o motivo. Confira se o aparelho continua conectado e desbloqueado.",
            exit.describe()
        )
    } else {
        format!(
            "A ferramenta de gravação parou ({}): {tail}",
            exit.describe()
        )
    }
}

/// Decide se a gravação deu certo, olhando como a ferramenta terminou, o tamanho do arquivo e o que ela escreveu.
/// `len` é `None` quando o arquivo não existe.
pub(crate) fn check_output(
    kind: &str,
    exit: ExitInfo,
    killed: bool,
    len: Option<u64>,
    log: &str,
) -> Result<(), String> {
    if killed {
        return Err("A ferramenta de gravação não respondeu ao pedido de parada e foi encerrada; o vídeo pode estar incompleto. Tente gravar de novo.".into());
    }
    if len.is_some_and(|len| len > 0) {
        return Ok(());
    }
    if !exit.success() {
        return Err(explain_failure(kind, exit, log));
    }
    match len {
        None => Err("A ferramenta de gravação terminou sem erro, mas não criou o arquivo do vídeo. Tente gravar de novo.".into()),
        Some(_) => Err("O vídeo ficou vazio. Tente novamente depois de alguns segundos de gravação.".into()),
    }
}

// ── Processo supervisionado ─────────────────────────────────────────────────

struct State {
    log: String,
    exit: Option<ExitInfo>,
    open_pipes: usize,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// O que aconteceu enquanto esperávamos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Wait {
    /// A saída da ferramenta passou a conter o que se esperava.
    Matched,
    Exited(ExitInfo),
    TimedOut,
}

/// Um processo filho cujo término e cuja saída são acompanhados por threads, sem polling: quem espera dorme numa
/// `Condvar` até o processo sair, a saída mudar ou o prazo acabar.
pub(crate) struct Supervised {
    pid: u32,
    shared: Arc<Shared>,
}

fn drain<R: Read + Send + 'static>(mut reader: R, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let mut state = shared.lock();
                    state
                        .log
                        .push_str(&String::from_utf8_lossy(&buffer[..read]));
                    if state.log.len() > LOG_LIMIT {
                        let mut cut = state.log.len() - LOG_LIMIT;
                        while !state.log.is_char_boundary(cut) {
                            cut += 1;
                        }
                        state.log.drain(..cut);
                    }
                    shared.changed.notify_all();
                }
            }
        }
        let mut state = shared.lock();
        state.open_pipes = state.open_pipes.saturating_sub(1);
        shared.changed.notify_all();
    });
}

impl Supervised {
    /// Assume o filho. `stdin` deve ser retirado antes, se for preciso.
    pub(crate) fn new(mut child: Child) -> Self {
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                log: String::new(),
                exit: None,
                open_pipes: usize::from(stdout.is_some()) + usize::from(stderr.is_some()),
            }),
            changed: Condvar::new(),
        });
        if let Some(stdout) = stdout {
            drain(stdout, Arc::clone(&shared));
        }
        if let Some(stderr) = stderr {
            drain(stderr, Arc::clone(&shared));
        }
        let waiter = Arc::clone(&shared);
        std::thread::spawn(move || {
            let info = child.wait().map_or(
                ExitInfo {
                    code: None,
                    signal: None,
                },
                ExitInfo::from_status,
            );
            let state = waiter.lock();
            // Dá um instante para as últimas linhas chegarem antes de anunciar o fim.
            let (mut state, _) = waiter
                .changed
                .wait_timeout_while(state, Duration::from_millis(300), |s| s.open_pipes > 0)
                .unwrap_or_else(|e| e.into_inner());
            state.exit = Some(info);
            waiter.changed.notify_all();
        });
        Self { pid, shared }
    }

    pub(crate) fn log(&self) -> String {
        self.shared.lock().log.clone()
    }

    /// Espera até o processo sair, a saída satisfazer `matched` ou o prazo acabar. O fim do processo vale mais
    /// que a saída: quem saiu não está gravando.
    pub(crate) fn wait_until(&self, timeout: Duration, matched: impl Fn(&str) -> bool) -> Wait {
        let state = self.shared.lock();
        let (state, _) = self
            .shared
            .changed
            .wait_timeout_while(state, timeout, |s| s.exit.is_none() && !matched(&s.log))
            .unwrap_or_else(|e| e.into_inner());
        if let Some(exit) = state.exit {
            Wait::Exited(exit)
        } else if matched(&state.log) {
            Wait::Matched
        } else {
            Wait::TimedOut
        }
    }

    pub(crate) fn wait_exit(&self, timeout: Duration) -> Option<ExitInfo> {
        match self.wait_until(timeout, |_| false) {
            Wait::Exited(exit) => Some(exit),
            _ => None,
        }
    }

    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        let state = self.shared.lock();
        if state.exit.is_some() {
            return;
        }
        // SAFETY: sinal enviado só ao PID do filho que esta instância iniciou e ainda não foi dado como encerrado
        // (a checagem e o envio acontecem com o estado travado; quem publica o fim também o trava).
        unsafe {
            libc::kill(self.pid as libc::pid_t, signal);
        }
    }

    pub(crate) fn interrupt(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGINT);
    }

    pub(crate) fn kill(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(not(unix))]
        let _ = self.pid;
    }

    /// Para a ferramenta com Ctrl+C. Se ela não sair (o sinal pode chegar antes de ela instalar o tratador e se
    /// perder), repete e, por fim, encerra à força. Devolve como saiu e se foi preciso matar.
    pub(crate) fn stop_with_interrupt(&self, per_round: Duration, rounds: u32) -> (ExitInfo, bool) {
        for _ in 0..rounds {
            self.interrupt();
            if let Some(exit) = self.wait_exit(per_round) {
                return (exit, false);
            }
        }
        self.kill_and_wait()
    }

    /// Espera a ferramenta fechar o arquivo sozinha; passado o prazo, encerra à força.
    pub(crate) fn await_exit(&self, timeout: Duration) -> (ExitInfo, bool) {
        match self.wait_exit(timeout) {
            Some(exit) => (exit, false),
            None => self.kill_and_wait(),
        }
    }

    fn kill_and_wait(&self) -> (ExitInfo, bool) {
        self.kill();
        let exit = self.wait_exit(Duration::from_secs(5)).unwrap_or(ExitInfo {
            code: None,
            signal: Some(9),
        });
        (exit, true)
    }
}

// ── Estado da gravação ativa ────────────────────────────────────────────────

struct ActiveRecording {
    id: String,
    kind: String,
    process: Supervised,
    stop_stdin: Option<ChildStdin>,
    path: PathBuf,
    android: Option<AndroidRecording>,
}

struct StartedRecording {
    process: Supervised,
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
static STOPPING: AtomicBool = AtomicBool::new(false);

struct FlagGuard(&'static AtomicBool);
impl Drop for FlagGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
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

/// Confere que a ferramenta não morreu logo depois de iniciar. Antes só se checava o instante do `spawn`, quando
/// o processo ainda estava vivo; o erro só aparecia ao parar, sem motivo. `marker` é o texto que a ferramenta
/// escreve ao começar a gravar (quando se conhece); sem ele, o prazo inteiro vale como janela de falha rápida.
fn ensure_started(
    kind: &str,
    process: &Supervised,
    marker: Option<&'static str>,
    window: Duration,
) -> Result<(), String> {
    match process.wait_until(window, |log| marker.is_some_and(|m| log.contains(m))) {
        Wait::Exited(exit) => Err(explain_failure(kind, exit, &process.log())),
        Wait::Matched | Wait::TimedOut => Ok(()),
    }
}

/// Começa a gravar uma fonte identificada por `kind` e pelo identificador estável do aparelho.
pub fn start(kind: &str, target: &str) -> Result<String, String> {
    STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Outra gravação está começando agora.".to_string())?;
    let _starting = FlagGuard(&STARTING);
    if STOPPING.load(Ordering::Acquire) {
        return Err("A gravação anterior ainda está sendo finalizada.".into());
    }
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
        process,
        stop_stdin,
        android,
    } = match started {
        Ok(started) => started,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
    };
    *active()
        .lock()
        .map_err(|_| "O estado de gravação ficou indisponível.")? = Some(ActiveRecording {
        id: id.clone(),
        kind: kind.to_string(),
        process,
        stop_stdin,
        path,
        android,
    });
    Ok(id)
}

/// Abre a ferramenta com a saída capturada, para que o motivo de uma falha não se perca.
fn capture_output(command: &mut std::process::Command) {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
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
        ]);
    capture_output(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui abrir a gravação do iPhone: {e}"))?;
    let process = Supervised::new(child);
    ensure_started("iphone", &process, None, EARLY_FAILURE_WINDOW)?;
    Ok(StartedRecording {
        process,
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
        .arg(path);
    capture_output(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui abrir a gravação do simulador: {e}"))?;
    let process = Supervised::new(child);
    // O `simctl` imprime "Recording started" quando instala o tratador de parada: antes disso um Ctrl+C se perde.
    ensure_started(
        "simulator",
        &process,
        Some("Recording started"),
        SIMULATOR_START_WINDOW,
    )?;
    Ok(StartedRecording {
        process,
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
    capture_output(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("Não consegui iniciar a gravação do Android: {e}"))?;
    let process = Supervised::new(child);
    ensure_started("android", &process, None, Duration::from_secs(2))?;
    Ok(StartedRecording {
        process,
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
        .stdin(Stdio::piped());
    capture_output(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Não consegui iniciar o ScreenCaptureKit: {e}"))?;
    let stop_stdin = child.stdin.take();
    let process = Supervised::new(child);
    let answered = |log: &str| {
        log.lines().any(|line| {
            let line = line.trim();
            line == "READY" || line.starts_with("ERROR:")
        })
    };
    match process.wait_until(DESKTOP_START_WINDOW, answered) {
        Wait::Exited(exit) => Err(explain_failure("desktop", exit, &process.log())),
        Wait::TimedOut => {
            process.kill();
            Err("A captura de tela não respondeu. Confira a permissão de Gravação de Tela do macOS e reabra a ADE depois de autorizá-la.".into())
        }
        Wait::Matched => {
            let log = process.log();
            if log.lines().any(|line| line.trim() == "READY") {
                return Ok(StartedRecording {
                    process,
                    stop_stdin,
                    android: None,
                });
            }
            let exit = process
                .wait_exit(Duration::from_secs(5))
                .unwrap_or(ExitInfo {
                    code: Some(2),
                    signal: None,
                });
            Err(explain_failure("desktop", exit, &process.log()))
        }
    }
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

/// Para a gravação, finaliza o MP4 e devolve o caminho local. Qualquer que seja o resultado, a gravação deixa
/// de estar ativa: antes, uma falha deixava o botão preso em "gravando" até reiniciar a ADE.
pub fn stop(id: &str) -> Result<String, String> {
    let recording = {
        let mut current = active()
            .lock()
            .map_err(|_| "O estado de gravação ficou indisponível.")?;
        match current.as_ref() {
            None => return Err("Não há gravação ativa.".into()),
            Some(recording) if recording.id != id => {
                return Err("A gravação ativa pertence a outra tela.".into());
            }
            Some(_) => current.take().expect("gravação ativa conferida acima"),
        }
    };
    // O mutex já foi solto: esperar a ferramenta fechar o arquivo não trava o `status` (que roda na thread da UI).
    STOPPING.store(true, Ordering::Release);
    let _stopping = FlagGuard(&STOPPING);
    finish(recording)
}

fn finish(mut recording: ActiveRecording) -> Result<String, String> {
    let (exit, killed) = if let Some(android) = &recording.android {
        if let Err(error) = crate::android::stop_screen_record(
            &android.serial,
            &android.remote_video,
            &android.remote_pid_file,
        ) {
            recording.process.kill();
            return Err(error);
        }
        recording.process.await_exit(FINISH_WINDOW)
    } else if let Some(mut input) = recording.stop_stdin.take() {
        // Se o helper já morreu, a escrita falha; o motivo está no registro e sai da conferência abaixo.
        let _ = input.write_all(b"stop\n");
        drop(input);
        recording.process.await_exit(FINISH_WINDOW)
    } else {
        recording
            .process
            .stop_with_interrupt(Duration::from_secs(6), 4)
    };
    let log = recording.process.log();
    if let (Some(android), false) = (&recording.android, killed) {
        crate::android::pull_screen_record(
            &android.serial,
            &android.remote_video,
            &android.remote_pid_file,
            &recording.path,
        )?;
    }
    let len = std::fs::metadata(&recording.path).ok().map(|m| m.len());
    // O Android não tem o código de saída do `screenrecord` (o `adb shell` devolve o do `wait`): vale o arquivo.
    let exit = if recording.android.is_some() {
        ExitInfo {
            code: Some(0),
            signal: None,
        }
    } else {
        exit
    };
    match check_output(&recording.kind, exit, killed, len, &log) {
        Ok(()) => Ok(recording.path.to_string_lossy().into_owned()),
        Err(error) => {
            if len == Some(0) {
                let _ = std::fs::remove_file(&recording.path);
            }
            Err(error)
        }
    }
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

#[cfg(test)]
mod test;
