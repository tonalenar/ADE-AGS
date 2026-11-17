//! Fila de escrita de um PTY: uma thread por sessão escreve no processo, e quem chama só enfileira.
//!
//! Escrever no PTY pode bloquear: quando a TUI para de ler a entrada, o buffer do tty enche e o
//! `write_all` espera sem prazo. Por isso a escrita fica numa thread própria, e quem chama recebe na
//! hora `Full` (fila cheia) ou `Closed` (a escrita já caiu), em vez de esperar.
//!
//! Garantias:
//! - Uma entrada aceita (`Ok`) é escrita, ou então vem na contagem de `FalhaEscrita::perdidas`
//!   entregue ao `avisar`. Nenhuma some em silêncio.
//! - Uma linha (`enqueue_linha`) é um pedido só: texto e Enter entram juntos, ou nenhum dos dois.
//! - Remover a fila (soltá-la) fecha o lado mestre pelo `fechar`. Assim um `write_all` preso volta com erro
//!   e a thread termina. Sem o fechamento, a thread continuaria presa enquanto o processo não lesse.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

/// Pedidos que uma sessão aceita antes de recusar: os que esperam na fila e o que a thread já pegou
/// e ainda escreve.
pub const CAPACIDADE: usize = 256;

/// Por que a entrada não foi enviada. Quem chama sempre fica sabendo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyWriteError {
    /// A fila está cheia: a TUI não lê a entrada há tempo demais.
    Full,
    /// A escrita já caiu, ou a fila já foi removida.
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

/// O que a dona da fila precisa saber quando a escrita cai: o motivo e quantas entradas aceitas não saíram.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FalhaEscrita {
    pub motivo: String,
    /// A entrada que falhou mais as que estavam na fila (já aceitas com `Ok`).
    pub perdidas: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Estado {
    Aberta,
    /// A thread parou por erro de escrita. Daí em diante, nada mais entra.
    Caiu,
}

/// O que as duas pontas (quem enfileira e a thread) dividem.
struct Compartilhado {
    /// Trava a aceitação e a queda. Um pedido aceito fica na fila antes da queda, e a queda conta tudo o
    /// que ficou, então nenhum pedido aceito se perde sem contagem.
    estado: Mutex<Estado>,
    /// Pedidos aceitos e ainda não escritos (na fila e em escrita). Limita a fila a `CAPACIDADE`.
    pendentes: AtomicUsize,
}

/// Fila de escrita de uma sessão. Soltá-la fecha o lado mestre e faz a thread terminar.
pub struct WriteQueue {
    tx: SyncSender<Vec<u8>>,
    compartilhado: Arc<Compartilhado>,
    cancelada: Arc<AtomicBool>,
    fechar: Option<Box<dyn FnOnce() + Send>>,
}

impl WriteQueue {
    /// Cria a fila e a thread que escreve em `writer`.
    ///
    /// `fechar` roda ao soltar a fila e precisa fazer a escrita presa voltar com erro (na prática, matar o
    /// processo, o que fecha o escravo do PTY). `avisar` recebe a falha, uma vez, se a escrita cair enquanto
    /// a fila ainda está em uso. Erro só se o SO recusar a thread.
    pub fn new(
        writer: Box<dyn Write + Send>,
        fechar: Box<dyn FnOnce() + Send>,
        avisar: Box<dyn FnOnce(FalhaEscrita) + Send>,
    ) -> std::io::Result<Self> {
        let (tx, rx) = sync_channel::<Vec<u8>>(CAPACIDADE);
        let compartilhado = Arc::new(Compartilhado {
            estado: Mutex::new(Estado::Aberta),
            pendentes: AtomicUsize::new(0),
        });
        let cancelada = Arc::new(AtomicBool::new(false));
        let (compartilhado_thread, cancelada_thread) = (compartilhado.clone(), cancelada.clone());
        let mut writer = writer;
        std::thread::Builder::new().name("pty-escrita".into()).spawn(move || {
            while let Ok(pedido) = rx.recv() {
                if cancelada_thread.load(Ordering::Acquire) {
                    break;
                }
                let resultado = writer.write_all(&pedido).and_then(|()| writer.flush());
                compartilhado_thread.pendentes.fetch_sub(1, Ordering::AcqRel);
                if let Err(erro) = resultado {
                    let perdidas = registra_queda(&compartilhado_thread, &rx);
                    // Quem já soltou a fila não tem para quem avisar.
                    if !cancelada_thread.load(Ordering::Acquire) {
                        avisar(FalhaEscrita { motivo: erro.to_string(), perdidas });
                    }
                    break;
                }
            }
        })?;
        Ok(Self { tx, compartilhado, cancelada, fechar: Some(fechar) })
    }

    /// Enfileira `data` sem bloquear. A ordem de chegada é a ordem de escrita.
    pub fn enqueue(&self, data: &[u8]) -> Result<(), PtyWriteError> {
        self.aceita(data.to_vec())
    }

    /// Enfileira `texto` seguido de Enter como um pedido só: ou os dois entram, ou nenhum.
    pub fn enqueue_linha(&self, texto: &[u8]) -> Result<(), PtyWriteError> {
        let mut pedido = Vec::with_capacity(texto.len() + 1);
        pedido.extend_from_slice(texto);
        pedido.push(b'\r');
        self.aceita(pedido)
    }

    fn aceita(&self, pedido: Vec<u8>) -> Result<(), PtyWriteError> {
        let estado = self.compartilhado.estado.lock().unwrap_or_else(|e| e.into_inner());
        if *estado == Estado::Caiu {
            return Err(PtyWriteError::Closed);
        }
        // A vaga é reservada antes do envio. Se já estava tudo ocupado, desfaz a reserva.
        if self.compartilhado.pendentes.fetch_add(1, Ordering::AcqRel) >= CAPACIDADE {
            self.compartilhado.pendentes.fetch_sub(1, Ordering::AcqRel);
            return Err(PtyWriteError::Full);
        }
        let erro = match self.tx.try_send(pedido) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(_)) => PtyWriteError::Full,
            Err(TrySendError::Disconnected(_)) => PtyWriteError::Closed,
        };
        self.compartilhado.pendentes.fetch_sub(1, Ordering::AcqRel);
        Err(erro)
    }
}

/// Registra a queda sob a mesma trava que `aceita` usa, e conta os pedidos que ficaram na fila.
/// Quem chamou já tinha tirado o pedido que falhou (ele conta como um perdido).
fn registra_queda(compartilhado: &Compartilhado, rx: &Receiver<Vec<u8>>) -> usize {
    let mut estado = compartilhado.estado.lock().unwrap_or_else(|e| e.into_inner());
    *estado = Estado::Caiu;
    let mut perdidas = 1;
    while rx.try_recv().is_ok() {
        perdidas += 1;
    }
    perdidas
}

impl Drop for WriteQueue {
    fn drop(&mut self) {
        // Sinaliza antes de fechar: quem voltar da escrita presa não escreve mais nada da fila.
        self.cancelada.store(true, Ordering::Release);
        if let Some(fechar) = self.fechar.take() {
            fechar();
        }
    }
}
