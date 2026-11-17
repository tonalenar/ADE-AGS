//! Fila de escrita de um PTY: uma thread por sessão escreve no processo, e quem chama só enfileira.
//!
//! Escrever no PTY pode bloquear: quando a TUI para de ler a entrada, o buffer do tty enche e o
//! `write_all` espera sem prazo. Antes isso acontecia dentro do `pty_write` async e prendia um worker
//! do runtime do Tauri. Agora a escrita fica numa thread própria, e quem chama recebe na hora `Full`
//! (fila cheia) ou `Closed` (a escrita já terminou), em vez de esperar.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;

/// Pedaços que uma sessão aceita antes de recusar: os que esperam na fila e o que a thread já pegou
/// e ainda escreve.
pub const CAPACIDADE: usize = 256;

/// Por que a entrada não foi enviada. Nada cai em silêncio: quem chama sempre fica sabendo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyWriteError {
    /// A fila está cheia: a TUI não lê a entrada há tempo demais.
    Full,
    /// A thread de escrita já terminou (a sessão acabou ou a escrita falhou).
    Closed,
}

impl std::fmt::Display for PtyWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full => f.write_str("Terminal ocupado: a entrada não foi enviada"),
            Self::Closed => f.write_str("Terminal encerrado"),
        }
    }
}

/// Fila de escrita de uma sessão. Quando a sessão sai do registro e a fila é solta, a thread descarta
/// o que faltava e termina.
pub struct WriteQueue {
    tx: SyncSender<Vec<u8>>,
    /// Pedaços aceitos e ainda não escritos. Limita a fila a `CAPACIDADE` exatamente, contando o
    /// pedaço que a thread já tirou da fila.
    pendentes: Arc<AtomicUsize>,
    /// Ligado ao soltar a fila: a thread não escreve mais nada.
    cancelada: Arc<AtomicBool>,
}

impl WriteQueue {
    /// Cria a fila e a thread que escreve em `writer`. Erro só se o SO recusar a thread.
    pub fn new(mut writer: Box<dyn Write + Send>) -> std::io::Result<Self> {
        let (tx, rx) = sync_channel::<Vec<u8>>(CAPACIDADE);
        let pendentes = Arc::new(AtomicUsize::new(0));
        let cancelada = Arc::new(AtomicBool::new(false));
        let (pendentes_thread, cancelada_thread) = (pendentes.clone(), cancelada.clone());
        std::thread::Builder::new().name("pty-escrita".into()).spawn(move || {
            for pedaco in rx {
                if cancelada_thread.load(Ordering::Acquire) {
                    break;
                }
                let ok = writer.write_all(&pedaco).and_then(|()| writer.flush()).is_ok();
                pendentes_thread.fetch_sub(1, Ordering::AcqRel);
                if !ok {
                    // O processo não lê mais: a fila fecha, e os envios seguintes saem como `Closed`.
                    break;
                }
            }
        })?;
        Ok(Self { tx, pendentes, cancelada })
    }

    /// Enfileira `data` sem bloquear. A ordem de chegada é a ordem de escrita.
    pub fn enqueue(&self, data: &[u8]) -> Result<(), PtyWriteError> {
        // A vaga é reservada antes do envio. Se já estava tudo ocupado, desfaz a reserva.
        if self.pendentes.fetch_add(1, Ordering::AcqRel) >= CAPACIDADE {
            self.pendentes.fetch_sub(1, Ordering::AcqRel);
            return Err(PtyWriteError::Full);
        }
        let erro = match self.tx.try_send(data.to_vec()) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(_)) => PtyWriteError::Full,
            Err(TrySendError::Disconnected(_)) => PtyWriteError::Closed,
        };
        self.pendentes.fetch_sub(1, Ordering::AcqRel);
        Err(erro)
    }
}

impl Drop for WriteQueue {
    fn drop(&mut self) {
        // Sinaliza antes de o `tx` sair: a thread descarta o que faltava e termina.
        self.cancelada.store(true, Ordering::Release);
    }
}
