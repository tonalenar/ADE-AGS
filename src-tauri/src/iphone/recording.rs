//! Gravar o vídeo do espelho do iPhone: os quadros HEVC que a sessão já recebe (os mesmos que vão ao
//! VideoToolbox) também vão, sem recodificar, para um MP4 (`mp4.rs`). Não passa pelo `devicectl` (que neste
//! aparelho não oferece a gravação de tela) nem pela permissão de Gravação de Tela do macOS: é o stream do
//! aparelho, não a tela do Mac.
//!
//! Uma thread própria cuida do disco: a sessão só entrega o quadro por um canal, então escrever (ou um disco lento)
//! nunca segura a thread do vídeo nem a da interface, e nenhum mutex fica travado durante a escrita. Parar manda
//! `Finish` pelo mesmo canal (os quadros anteriores já estão na fila) e espera a resposta com prazo.
//!
//! O arquivo é escrito em `<destino>.part` e só vira o destino ao finalizar com sucesso; qualquer outro fim
//! apaga o `.part`.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::model::ParamSets;
use super::mp4::{self, Mp4Writer, Sample, Summary};

/// Quanto esperar o primeiro quadro-chave depois de pedir a gravação (o aparelho o manda em 30–150 ms).
pub const FIRST_FRAME_WAIT: Duration = Duration::from_secs(6);
/// Quanto esperar a finalização do arquivo ao parar.
pub const FINISH_WAIT: Duration = Duration::from_secs(30);

/// Um quadro entregue pela sessão.
pub struct Frame {
    /// Horário RTP (24 kHz).
    pub ts: u32,
    pub irap: bool,
    /// As NALs com o tamanho de 4 bytes na frente.
    pub data: Vec<u8>,
    pub params: ParamSets,
    /// A tela do aparelho em pixels, sem as bordas de alinhamento.
    pub display: Option<(u32, u32)>,
    pub arrived: Instant,
    /// O relógio do RTP recomeçou (nova conexão com o aparelho): o intervalo para o quadro anterior vem do relógio
    /// do Mac, não do horário RTP.
    pub discontinuity: bool,
}

/// Quem escreve o vídeo. O de verdade é o `FileWriter`; os testes usam um falso.
pub trait Writer: Send + 'static {
    fn write(&mut self, frame: &Frame) -> Result<(), String>;
    /// Fecha o arquivo. `tail` = há quanto tempo chegou o último quadro (o quanto ele ficou na tela).
    fn finish(&mut self, tail: Duration) -> Result<Summary, String>;
    /// Descarta o que foi escrito.
    fn abort(&mut self);
}

enum Cmd {
    Frame(Frame),
    Finish(Sender<Result<Summary, String>>),
    Abort,
}

#[derive(Default)]
struct Progress {
    frames: u64,
    error: Option<String>,
}

type Shared = Arc<(Mutex<Progress>, Condvar)>;

/// A ponta que a sessão usa para entregar quadros (barata de clonar, sem trava).
#[derive(Clone)]
pub struct Tap(Sender<Cmd>);

impl Tap {
    /// `false`: o gravador acabou (parou ou falhou); a sessão larga a ponta.
    pub fn push(&self, frame: Frame) -> bool {
        self.0.send(Cmd::Frame(frame)).is_ok()
    }
}

/// Uma gravação em andamento: dona da thread que escreve.
pub struct Recording {
    tx: Sender<Cmd>,
    shared: Shared,
}

impl Recording {
    pub fn start(writer: impl Writer) -> Recording {
        let (tx, rx) = mpsc::channel();
        let shared: Shared = Arc::default();
        let worker = shared.clone();
        let spawned = std::thread::Builder::new().name("ade-iphone-record".into()).spawn(move || run(writer, rx, worker));
        if spawned.is_err() {
            note_error(&shared, "Não consegui abrir a thread da gravação.".into());
        }
        Recording { tx, shared }
    }

    pub fn tap(&self) -> Tap {
        Tap(self.tx.clone())
    }

    /// Espera o primeiro quadro estar no arquivo (ou o escritor falhar). Dorme no aviso, sem polling.
    pub fn wait_first_frame(&self, timeout: Duration) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, result) = changed
            .wait_timeout_while(guard, timeout, |p| p.frames == 0 && p.error.is_none())
            .unwrap_or_else(|e| e.into_inner());
        if let Some(error) = &guard.error {
            return Err(error.clone());
        }
        if result.timed_out() {
            return Err("O espelho não entregou nenhum quadro de vídeo a tempo. Confira se a tela do iPhone aparece na ADE e grave de novo.".into());
        }
        Ok(())
    }

    /// O primeiro erro do escritor, se já houve (o botão pode perguntar sem parar).
    pub fn error(&self) -> Option<String> {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).error.clone()
    }

    /// Finaliza o arquivo.
    pub fn stop(self) -> Result<Summary, String> {
        let (reply, answer) = mpsc::channel();
        if self.tx.send(Cmd::Finish(reply)).is_err() {
            return Err(self.error().unwrap_or_else(|| "A gravação do espelho já tinha terminado.".into()));
        }
        match answer.recv_timeout(FINISH_WAIT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err("O arquivo do vídeo não foi finalizado a tempo.".into()),
            Err(RecvTimeoutError::Disconnected) => Err(self.error().unwrap_or_else(|| "A gravação do espelho terminou sem responder.".into())),
        }
    }

    /// Cancela e apaga o que foi escrito.
    pub fn abort(self) {
        let _ = self.tx.send(Cmd::Abort);
    }
}

fn note_error(shared: &Shared, error: String) {
    let mut progress = shared.0.lock().unwrap_or_else(|e| e.into_inner());
    progress.error.get_or_insert(error);
    shared.1.notify_all();
}

fn run(mut writer: impl Writer, rx: Receiver<Cmd>, shared: Shared) {
    let mut last_arrival: Option<Instant> = None;
    let mut failed = false;
    // Sem laço de espera: dorme no canal. O fim do canal (ninguém mais com `Tap` nem `Recording`) encerra.
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Frame(frame) => {
                if failed {
                    continue;
                }
                match writer.write(&frame) {
                    Ok(()) => {
                        last_arrival = Some(frame.arrived);
                        let mut progress = shared.0.lock().unwrap_or_else(|e| e.into_inner());
                        progress.frames += 1;
                        shared.1.notify_all();
                    }
                    Err(error) => {
                        failed = true;
                        writer.abort();
                        note_error(&shared, error);
                    }
                }
            }
            Cmd::Finish(reply) => {
                let result = if failed {
                    Err(shared.0.lock().unwrap_or_else(|e| e.into_inner()).error.clone().unwrap_or_else(|| "A gravação falhou.".into()))
                } else {
                    let tail = last_arrival.map_or(Duration::ZERO, |at| at.elapsed());
                    let result = writer.finish(tail);
                    if let Err(error) = &result {
                        writer.abort();
                        note_error(&shared, error.clone());
                    }
                    result
                };
                let _ = reply.send(result);
                return;
            }
            Cmd::Abort => {
                writer.abort();
                return;
            }
        }
    }
    writer.abort();
}

// ── O escritor de arquivo ───────────────────────────────────────────────────

/// MP4 no disco: `<destino>.part` até a finalização.
pub struct FileWriter {
    mux: Option<Mp4Writer<BufWriter<File>>>,
    part: PathBuf,
    dest: PathBuf,
    /// Quando chegou o último quadro e qual era o horário RTP dele: o relógio do Mac mede o salto se o RTP recomeçar.
    last_arrival: Option<Instant>,
}

impl FileWriter {
    pub fn create(dest: &Path) -> Result<FileWriter, String> {
        let mut part = dest.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        let file = File::create(&part).map_err(|e| format!("Não consegui criar o arquivo do vídeo: {e}"))?;
        let mux = Mp4Writer::new(BufWriter::with_capacity(1 << 20, file))?;
        Ok(FileWriter { mux: Some(mux), part, dest: dest.to_path_buf(), last_arrival: None })
    }
}

/// `elapsed` em ticks do relógio do vídeo.
pub fn ticks(elapsed: Duration) -> u32 {
    (elapsed.as_secs_f64() * f64::from(mp4::TIMESCALE)).round().min(f64::from(mp4::MAX_FRAME_TICKS)) as u32
}

impl Writer for FileWriter {
    fn write(&mut self, frame: &Frame) -> Result<(), String> {
        let mux = self.mux.as_mut().ok_or("O arquivo do vídeo já foi fechado.")?;
        let previous_duration = match (frame.discontinuity, self.last_arrival) {
            (true, Some(at)) => Some(ticks(frame.arrived.saturating_duration_since(at))),
            _ => None,
        };
        mux.push(Sample { ts: frame.ts, sync: frame.irap, data: &frame.data, params: &frame.params, display: frame.display, previous_duration })?;
        self.last_arrival = Some(frame.arrived);
        Ok(())
    }

    fn finish(&mut self, tail: Duration) -> Result<Summary, String> {
        let mux = self.mux.take().ok_or("O arquivo do vídeo já foi fechado.")?;
        // O último quadro ficou na tela até agora; no mínimo um quadro, para a duração nunca ser zero.
        let tail = ticks(tail).max(mp4::NOMINAL_FRAME);
        let (summary, out) = mux.finish(tail)?;
        let file = out.into_inner().map_err(|e| format!("Não consegui fechar o vídeo: {}", e.error()))?;
        file.sync_all().map_err(|e| format!("Não consegui fechar o vídeo: {e}"))?;
        drop(file);
        std::fs::rename(&self.part, &self.dest).map_err(|e| format!("Não consegui salvar o vídeo: {e}"))?;
        Ok(summary)
    }

    fn abort(&mut self) {
        self.mux = None;
        let _ = std::fs::remove_file(&self.part);
    }
}

impl Drop for FileWriter {
    fn drop(&mut self) {
        // Terminou sem finalizar (a ADE caiu no meio, o canal fechou): não deixa um `.part` sem `moov`.
        if self.mux.is_some() {
            self.abort();
        }
    }
}
