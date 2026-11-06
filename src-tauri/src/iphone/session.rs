//! Uma sessão de espelhamento por aparelho: abre o helper, lê os pacotes, monta e decodifica os quadros e
//! cuida da conexão (reabre o helper quando cai, com espera crescente). Uma thread por aparelho, que só espera
//! no canal dela (mensagens do helper, das telas e os prazos do vigia): nada de laço com `sleep`.
//!
//! O helper é parado com `stop` no stdin (ele para o stream no aparelho antes de sair). Se não sair a tempo, só
//! o PID que esta sessão abriu é encerrado.

use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::model::{self, GateAction, HelperEvent, HelperMsg, Link, LinkState, Transport};
use super::native::decoder::Decoder;
use super::native::view::{debug_on, now_ns, Presenter, Sink};

pub const STATUS_EVENT: &str = "iphone-mirror-status";
const HELPER: &str = "ade-iphone-mirror";
/// Onde o Xcode 27 instala o CoreDevice.
pub const COREDEVICE: &str = "/Library/Developer/PrivateFrameworks/CoreDevice.framework";
/// O helper tem este tempo para sair depois do `stop` (ele mesmo espera até 4 s pelo aparelho).
const STOP_WAIT: Duration = Duration::from_secs(6);
/// O relógio do RTP do vídeo (medido: Δts/Δt ≈ 24.070 Hz).
const RTP_CLOCK: f64 = 24_000.0;

/// O que a interface mostra na linha de estado.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub device: String,
    pub state: LinkState,
    pub transport: Option<Transport>,
    /// A tela em pixels.
    pub display: Option<Display>,
    pub error: Option<String>,
    /// O toque do aparelho está pronto (HID do CoreDevice aberto).
    pub input: bool,
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Display {
    pub w: u32,
    pub h: u32,
}

impl Status {
    fn of(device: &str, link: &Link, input: bool, fps: Option<u32>) -> Status {
        Status {
            device: device.to_string(),
            state: link.state,
            transport: link.transport,
            display: link.display.map(|(w, h)| Display { w, h }),
            error: link.error.clone(),
            input: input && link.state == LinkState::Live,
            fps: fps.filter(|_| link.state == LinkState::Live),
        }
    }
}

enum Msg {
    Wanted(bool),
    Stop,
    Helper(u64, HelperMsg),
    /// O helper fechou o stdout (saiu ou vai sair).
    Closed(u64),
    /// Linhas de entrada (toque, botão, tecla) para o helper, na ordem.
    Input(Vec<String>),
}

/// O estado compartilhado e o aviso de mudança (quem espera o aparelho ficar pronto dorme no `Condvar`).
type Shared = Arc<(Mutex<Status>, Condvar)>;

/// Por onde a tela e os agentes mandam entrada ao aparelho.
#[derive(Clone)]
pub struct InputTx(Sender<Msg>);

impl InputTx {
    pub fn send(&self, lines: Vec<String>) {
        if !lines.is_empty() {
            let _ = self.0.send(Msg::Input(lines));
        }
    }
}

/// O que a thread da sessão expõe às telas.
pub struct Session {
    tx: Sender<Msg>,
    pub presenter: Arc<Presenter>,
    status: Shared,
}

impl Session {
    pub fn want(&self, visible: bool) {
        let _ = self.tx.send(Msg::Wanted(visible));
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Msg::Stop);
    }

    pub fn status(&self) -> Status {
        self.status.0.lock().map(|s| s.clone()).unwrap_or_else(|e| e.into_inner().clone())
    }

    pub fn input(&self) -> InputTx {
        InputTx(self.tx.clone())
    }

    /// Quem espera o aparelho ficar pronto, sem segurar nada da sessão.
    pub fn waiter(&self) -> Waiter {
        Waiter(self.status.clone())
    }
}

/// Espera o espelhamento ligar com o toque pronto.
pub struct Waiter(Shared);

impl Waiter {
    /// Até `timeout`, dormindo no aviso de mudança de estado (sem polling).
    pub fn wait(&self, timeout: Duration) -> Result<Status, String> {
        let (lock, changed) = &*self.0;
        let guard = lock.lock().map_err(|_| "O estado do aparelho travou.".to_string())?;
        let (guard, result) = changed
            .wait_timeout_while(guard, timeout, |s| !(s.state == LinkState::Live && s.input))
            .map_err(|_| "O estado do aparelho travou.".to_string())?;
        if result.timed_out() {
            return Err(match &guard.error {
                Some(e) => format!("O aparelho não ficou pronto para o toque: {}", model::device_error_help(e)),
                None => "O aparelho não ficou pronto para o toque a tempo (o espelhamento precisa estar ligado).".into(),
            });
        }
        Ok(guard.clone())
    }
}

/// O helper: no `.app`, em `Contents/Resources/binaries/`; em desenvolvimento, em `src-tauri/binaries/`
/// (`bun run build:iphone-mirror`).
pub fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let mut candidates = vec![dir.join("../Resources/binaries").join(HELPER), dir.join("binaries").join(HELPER), dir.join(HELPER)];
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(HELPER));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Por que não dá para espelhar neste Mac (`None` = dá).
pub fn unavailable() -> Option<&'static str> {
    if !Path::new(COREDEVICE).exists() {
        return Some("xcode");
    }
    if helper_path().is_none() {
        return Some("helper");
    }
    None
}

pub fn start(app: AppHandle, device: String, identifier: String, tunnel: Option<String>, visible: bool) -> Session {
    let (tx, rx) = mpsc::channel();
    let presenter = Presenter::new();
    let status: Shared = Arc::new((Mutex::new(Status::of(&device, &Link::default(), false, None)), Condvar::new()));
    let session = Session { tx: tx.clone(), presenter: presenter.clone(), status: status.clone() };
    let worker = Worker { app, device, identifier, tunnel, tx, rx, presenter, status, link: Link::default(), wanted: visible, generation: 0, input: false, fps: None };
    let _ = std::thread::Builder::new().name("ade-iphone-mirror".into()).spawn(move || worker.run());
    session
}

struct Worker {
    app: AppHandle,
    device: String,
    identifier: String,
    tunnel: Option<String>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    presenter: Arc<Presenter>,
    status: Shared,
    link: Link,
    wanted: bool,
    generation: u64,
    /// O helper desta vida abriu o toque.
    input: bool,
    fps: Option<u32>,
}

/// O helper aberto. O `std::process::Child` fica aqui até o `wait`: assim o `kill`, se preciso, nunca pega um PID
/// que já foi reaproveitado por outro processo.
struct Child {
    process: std::process::Child,
    stdin: Option<ChildStdin>,
    generation: u64,
    closed: bool,
}

/// Como uma sessão do helper terminou.
enum Ended {
    /// Caiu ou não abriu: tentar de novo.
    Lost(String),
    /// Falta algo no Mac: tentar de novo bem depois.
    Fatal(String),
    /// Ninguém olhando.
    Idle,
    /// A ADE fechou a sessão.
    Stop,
}

impl Worker {
    fn emit(&mut self) {
        let status = Status::of(&self.device, &self.link, self.input, self.fps);
        if let Ok(mut slot) = self.status.0.lock() {
            if *slot == status {
                return;
            }
            *slot = status.clone();
        }
        self.status.1.notify_all();
        if matches!(status.state, LinkState::Offline | LinkState::Paused) {
            self.presenter.blank();
        }
        let _ = self.app.emit(STATUS_EVENT, status);
    }

    fn run(mut self) {
        loop {
            // Ninguém olhando: espera alguém olhar.
            while !self.wanted {
                match self.rx.recv() {
                    Ok(Msg::Wanted(w)) => self.wanted = w,
                    Ok(Msg::Stop) | Err(_) => return,
                    Ok(_) => {}
                }
            }
            self.link.on_spawn();
            self.emit();
            let wait = match self.session() {
                Ended::Stop => return,
                Ended::Idle => {
                    self.link.on_paused();
                    self.emit();
                    continue;
                }
                Ended::Lost(reason) => self.link.on_lost(reason),
                Ended::Fatal(reason) => self.link.on_fatal(reason),
            };
            self.emit();
            if !self.pause(wait) {
                return;
            }
        }
    }

    /// Espera `wait` antes da próxima tentativa; `false` = a ADE fechou a sessão.
    fn pause(&mut self, wait: Duration) -> bool {
        let until = Instant::now() + wait;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            match self.rx.recv_timeout(left) {
                Ok(Msg::Wanted(w)) => self.wanted = w,
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return false,
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => return true,
            }
        }
    }

    fn spawn(&mut self) -> Result<Child, Ended> {
        if !Path::new(COREDEVICE).exists() {
            return Err(Ended::Fatal("O espelhamento precisa do Xcode 27 (o CoreDevice não está neste Mac).".into()));
        }
        let Some(path) = helper_path() else {
            return Err(Ended::Fatal("O helper do espelhamento não veio com o app (rode `bun run build:iphone-mirror`).".into()));
        };
        self.generation += 1;
        let generation = self.generation;
        let mut cmd = crate::util::spawn::hidden_command(&path);
        cmd.arg("stream").arg(&self.identifier);
        if let Some(tunnel) = &self.tunnel {
            cmd.arg("--tunnel").arg(tunnel);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(if debug_on() { Stdio::inherit() } else { Stdio::null() });
        let mut child = cmd.spawn().map_err(|e| Ended::Fatal(format!("Não deu para abrir o helper do espelhamento: {e}")))?;
        let stdout = child.stdout.take().ok_or_else(|| Ended::Lost("O helper não tem stdout.".into()))?;
        let stdin = child.stdin.take();
        let tx = self.tx.clone();
        let _ = std::thread::Builder::new().name("ade-iphone-mirror-read".into()).spawn(move || {
            let mut reader = BufReader::with_capacity(1 << 16, stdout);
            while let Ok(Some(msg)) = model::read_msg(&mut reader) {
                if tx.send(Msg::Helper(generation, msg)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Msg::Closed(generation));
        });
        Ok(Child { process: child, stdin, generation, closed: false })
    }

    /// Uma vida do helper: do spawn até cair, parar ou ninguém olhar.
    fn session(&mut self) -> Ended {
        self.input = false;
        let mut child = match self.spawn() {
            Ok(child) => child,
            Err(ended) => return ended,
        };
        let ended = self.stream(&mut child);
        self.input = false;
        self.finish(child);
        self.presenter.clear();
        ended
    }

    fn stream(&mut self, child: &mut Child) -> Ended {
        let born = Instant::now();
        // Não fotografar quadros retidos de uma conexão anterior enquanto o novo vídeo ainda não se recuperou.
        self.presenter.invalidate_capture();
        let mut started = false;
        let mut last_packet = Instant::now();
        let mut idle_since: Option<Instant> = if self.wanted { None } else { Some(Instant::now()) };
        let mut depacketizer = model::Depacketizer::default();
        let mut gate = model::KeyframeGate::default();
        let mut decoder: Option<Decoder> = None;
        let mut failures = self.presenter.failures();
        let mut last_error: Option<(String, String)> = None;
        // O mapa horário RTP → relógio do Mac pelo último Sender Report, para o diagnóstico de atraso.
        let mut sender_report: Option<(f64, u32)> = None;
        let mut min_offset = f64::MAX;
        // Diagnóstico (`ADE_IPHONE_FPS=1`): o que a montagem fez no último segundo.
        let mut diag = (Instant::now(), 0u64, 0u64, 0u64, 0u64);
        let mut refreshed = Instant::now();
        // Para o diagnóstico: quando saiu a última entrada (o primeiro quadro depois dela é a reação do aparelho).
        let mut last_input: Option<Instant> = None;

        let interval = Duration::from_secs(1);
        let mut sampled_at = Instant::now();
        let mut presented = self.presenter.presented();
        self.fps = None;

        loop {
            let now = Instant::now();
            let elapsed = now.duration_since(sampled_at);
            if elapsed >= interval {
                let current = self.presenter.presented();
                if started {
                    self.fps = Some((current.saturating_sub(presented) as f64 / elapsed.as_secs_f64()).round() as u32);
                    if let Some(display) = self.presenter.display() {
                        self.link.display = Some(display);
                    }
                    self.emit();
                }
                presented = current;
                sampled_at = now;
            }
            let ms = |i: Instant| i.saturating_duration_since(born).as_millis() as u64;
            let mut deadline = if started { last_packet + model::STALL_AFTER } else { born + model::START_TIMEOUT };
            if let Some(since) = idle_since {
                deadline = deadline.min(since + model::IDLE_GRACE);
            }
            if gate.waiting() {
                deadline = deadline.min(now + model::KEYFRAME_RESEND);
            }
            if started {
                deadline = deadline.min(refreshed + model::KEYFRAME_REFRESH).min(sampled_at + interval);
            }
            let msg = match self.rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Disconnected) => return Ended::Stop,
                Err(RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    if idle_since.is_some_and(|since| now >= since + model::IDLE_GRACE) {
                        return Ended::Idle;
                    }
                    if !started && now >= born + model::START_TIMEOUT {
                        return Ended::Lost("O aparelho não abriu o espelhamento a tempo.".into());
                    }
                    if started && now >= last_packet + model::STALL_AFTER {
                        return Ended::Lost("O vídeo parou de chegar.".into());
                    }
                    if gate.gave_up(ms(now)) {
                        return Ended::Lost("O quadro-chave não chegou.".into());
                    }
                    if gate.should_ask(ms(now)) {
                        send(child, "keyframe");
                    }
                    if started && now >= refreshed + model::KEYFRAME_REFRESH {
                        refreshed = now;
                        send(child, "keyframe");
                    }
                    continue;
                }
            };
            match msg {
                Msg::Wanted(w) => {
                    self.wanted = w;
                    idle_since = if w { None } else { idle_since.or(Some(Instant::now())) };
                }
                Msg::Stop => return Ended::Stop,
                Msg::Input(lines) => {
                    if started && self.input {
                        for line in &lines {
                            send(child, line);
                        }
                        last_input = Some(Instant::now());
                    } else if debug_on() {
                        eprintln!("[iphone] entrada descartada: o toque ainda não está pronto");
                    }
                }
                Msg::Helper(g, _) | Msg::Closed(g) if g != child.generation => {}
                Msg::Closed(_) => {
                    child.closed = true;
                    // O stdout fecha quando o processo sai: o `wait` volta logo.
                    use std::os::unix::process::ExitStatusExt;
                    let (code, signal) = child.process.wait().map(|s| (s.code(), s.signal())).unwrap_or((None, None));
                    return lost(last_error, code, signal);
                }
                Msg::Helper(_, HelperMsg::Event(event)) => match event {
                    HelperEvent::Started { transport, display } => {
                        started = true;
                        last_packet = Instant::now();
                        self.presenter.set_display(display);
                        self.link.on_started(transport, display);
                        self.emit();
                    }
                    HelperEvent::Error { code, message } => last_error = Some((code, message)),
                    HelperEvent::InputReady { touch, buttons, keyboard } => {
                        if debug_on() {
                            eprintln!("[iphone] HID: toque={touch} botões={buttons} teclado={keyboard}");
                        }
                        self.input = touch;
                        self.emit();
                    }
                    HelperEvent::InputError(message) => eprintln!("[iphone] entrada: {message}"),
                    HelperEvent::Connecting | HelperEvent::Stopped | HelperEvent::Other(_) => {}
                },
                Msg::Helper(_, HelperMsg::Datagram(packet)) => {
                    let now = Instant::now();
                    last_packet = now;
                    let arrived = now_ns();
                    if model::is_rtcp(&packet) {
                        if debug_on() {
                            if let Some((ntp, rtp)) = sender_report_of(&packet) {
                                let wall = wall_now();
                                min_offset = min_offset.min(wall - ntp);
                                sender_report = Some((ntp, rtp));
                            }
                        }
                        continue;
                    }
                    let dropped_before = depacketizer.dropped;
                    let pushed = depacketizer.push(&packet);
                    if pushed.gap {
                        gate.on_gap(ms(now));
                        self.presenter.invalidate_capture();
                        diag.2 += 1;
                    }
                    if depacketizer.dropped != dropped_before {
                        // Um quadro saiu incompleto sem salto de sequência: os seguintes dependem dele. Mesmo caminho
                        // da perda: segura o último quadro bom e pede um quadro-chave.
                        gate.on_gap(ms(now));
                        self.presenter.invalidate_capture();
                    }
                    if debug_on() {
                        if let Some(u) = &pushed.unit {
                            diag.1 += 1;
                            diag.3 += u64::from(u.irap);
                        }
                        if now.duration_since(diag.0) >= Duration::from_secs(1) {
                            eprintln!(
                                "[iphone] montagem: {} quadros, {} perdas, {} IRAP, {} descartados por gate, {} incompletos (total) · tipos de pacote {:?}",
                                diag.1, diag.2, diag.3, diag.4, depacketizer.dropped, depacketizer.packet_kinds()
                            );
                            diag = (now, 0, 0, 0, 0);
                        }
                    }
                    let failed = self.presenter.failures();
                    if failed != failures {
                        // O decodificador recusou um quadro: as referências ficaram ruins até o próximo quadro-chave.
                        failures = failed;
                        gate.on_gap(ms(now));
                        self.presenter.invalidate_capture();
                    }
                    if let Some(unit) = pushed.unit {
                        if let Some(params) = &unit.params {
                            if decoder.as_ref().is_none_or(|d| d.params() != params) {
                                // O antigo sai antes: espera os quadros dele e solta a sessão do VideoToolbox.
                                drop(decoder.take());
                                self.presenter.invalidate_capture();
                                if debug_on() {
                                    eprintln!("[iphone] decodificador novo (VPS {} B, SPS {} B, PPS {} B)", params.vps.len(), params.sps.len(), params.pps.len());
                                }
                                match Decoder::new(params, Box::new(Sink(self.presenter.clone()))) {
                                    Ok(d) => {
                                        decoder = Some(d);
                                        gate.on_new_decoder(&unit, ms(now));
                                    }
                                    Err(e) => return Ended::Lost(e),
                                }
                            }
                        }
                        let action = gate.on_unit(&unit, ms(now));
                        if action == GateAction::Drop {
                            diag.4 += 1;
                        }
                        if action == GateAction::Decode {
                            if unit.irap {
                                // Quadros anteriores ao IDR não voltam a ser confiáveis, mesmo se o decodificador
                                // ainda estiver entregando uma saída atrasada.
                                self.presenter.capture_after_keyframe(arrived);
                            }
                            if let Some(d) = decoder.as_mut() {
                                if debug_on() {
                                    if let Some((ntp, rtp)) = sender_report {
                                        // Captura no relógio do aparelho → chegada no Mac, descontado o deslocamento
                                        // mínimo dos relógios (≈ atraso menos uma ida pela rede).
                                        let captured = ntp + f64::from(unit.ts.wrapping_sub(rtp) as i32) / RTP_CLOCK;
                                        self.presenter.note_capture(arrived, (wall_now() - captured - min_offset) * 1000.0);
                                    }
                                }
                                if let Some(sent) = last_input.take() {
                                    if debug_on() {
                                        eprintln!("[iphone] entrada→1º quadro novo chegou em {:.0} ms (+ ~4 ms de decodificação)", now.duration_since(sent).as_secs_f64() * 1000.0);
                                    }
                                }
                                self.presenter.note_rtp(arrived, unit.ts);
                                if let Err(e) = d.decode(&unit, arrived) {
                                    eprintln!("[iphone] {e}");
                                    gate.on_gap(ms(now));
                                    self.presenter.invalidate_capture();
                                }
                            }
                        }
                    }
                    if gate.gave_up(ms(now)) {
                        return Ended::Lost("O quadro-chave não chegou.".into());
                    }
                    if gate.should_ask(ms(now)) {
                        send(child, "keyframe");
                    }
                    if now >= refreshed + model::KEYFRAME_REFRESH {
                        refreshed = now;
                        send(child, "keyframe");
                    }
                }
            }
        }
    }

    /// Para o helper (que para o stream no aparelho) e espera ele sair; se não sair a tempo, encerra o processo que
    /// esta sessão abriu (e só ele).
    fn finish(&mut self, mut child: Child) {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }
        let until = Instant::now() + STOP_WAIT;
        let mut stopping = false;
        while !child.closed {
            match self.rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(Msg::Closed(g)) if g == child.generation => child.closed = true,
                Ok(Msg::Wanted(w)) => self.wanted = w,
                Ok(Msg::Stop) => stopping = true,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if !child.closed {
            eprintln!("[iphone] o helper não saiu depois do stop; encerrando o processo dele");
            let _ = child.process.kill();
        }
        // Com o stdout fechado o processo já está saindo: o `wait` volta logo.
        let _ = child.process.wait();
        if stopping {
            // A ADE está fechando a sessão: a próxima espera da thread vê isto e sai.
            let _ = self.tx.send(Msg::Stop);
        }
    }
}

fn send(child: &mut Child, command: &str) {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(format!("{command}\n").as_bytes());
        let _ = stdin.flush();
    }
}

fn lost(error: Option<(String, String)>, code: Option<i32>, signal: Option<i32>) -> Ended {
    match error {
        Some((code, message)) if model::is_fatal(&code) => Ended::Fatal(message),
        Some((_, message)) => Ended::Lost(message),
        None => Ended::Lost(model::exit_reason(code, signal)),
    }
}

fn wall_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// O NTP (em segundos Unix) e o horário RTP do primeiro Sender Report do pacote.
fn sender_report_of(packet: &[u8]) -> Option<(f64, u32)> {
    let mut off = 0;
    while off + 20 <= packet.len() {
        let words = (usize::from(packet[off + 2]) << 8 | usize::from(packet[off + 3])) + 1;
        if packet[off + 1] == 200 {
            let be = |i: usize| u32::from_be_bytes([packet[off + i], packet[off + i + 1], packet[off + i + 2], packet[off + i + 3]]);
            let ntp = f64::from(be(8)) - 2_208_988_800.0 + f64::from(be(12)) / 4_294_967_296.0;
            return Some((ntp, be(16)));
        }
        off += words * 4;
    }
    None
}
