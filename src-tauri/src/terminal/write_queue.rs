//! Fila de escrita de um PTY: uma thread por sessão escreve no processo, e quem chama só enfileira.
//!
//! Escrever no PTY pode bloquear: quando a TUI para de ler a entrada, o buffer do tty enche e o `write_all` espera.
//! Por isso a escrita fica numa thread própria, e quem chama recebe na hora `Full` (fila cheia) ou `Closed` (a escrita
//! já caiu), em vez de esperar.
//!
//! Garantias:
//! - Uma entrada aceita (`Ok`) é escrita, ou então vem na contagem de `FalhaEscrita::perdidas` entregue ao `avisar`.
//!   Nenhuma some em silêncio.
//! - Um pedido é uma lista de passos (bytes e pausas). A thread executa a lista inteira antes do próximo pedido, e o
//!   pedido é aceito ou recusado por inteiro.
//! - `reservar_envio` reserva a vaga do Enter junto com o texto: se o texto entrou, o Enter depois não é recusado por
//!   falta de espaço.
//! - Remover a fila (soltá-la, ou `encerrar_e_esperar`) chama o `fechar`. No Unix, o `fechar` do PTY escreve no pipe de
//!   cancelamento do escritor (`pty_io`), que acorda o `poll` de um `write` preso, e mata o processo. Assim a thread
//!   termina mesmo que outro processo segure o escravo. Um escritor que bloqueia sem esse cancelamento só volta quando o
//!   descritor ficar pronto.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Pedidos que uma sessão aceita antes de recusar: os que esperam na fila, o que a thread já pegou e ainda escreve, e as
/// vagas reservadas para um Enter.
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

/// Um passo de um pedido: bytes para o processo, ou uma pausa antes do próximo passo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Passo {
    Escreve(Vec<u8>),
    Pausa(Duration),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Estado {
    Aberta,
    /// A thread parou por erro de escrita. Daí em diante, nada mais entra.
    Caiu,
}

/// O que as duas pontas (quem enfileira e a thread) dividem.
struct Compartilhado {
    /// Trava a aceitação e a queda. Um pedido aceito fica na fila antes da queda, e a queda conta tudo o que ficou.
    estado: Mutex<Estado>,
    /// Pedidos aceitos e ainda não escritos, mais as vagas reservadas. Limita a fila a `CAPACIDADE`.
    pendentes: AtomicUsize,
    /// Envios reservados que saíram sem o Enter (o texto pode ter ficado na caixa da TUI).
    nao_confirmados: AtomicUsize,
}

/// Fila de escrita de uma sessão. Soltá-la fecha o lado mestre (pelo `fechar`) e faz a thread terminar.
pub struct WriteQueue {
    tx: SyncSender<Vec<Passo>>,
    compartilhado: Arc<Compartilhado>,
    cancelada: Arc<AtomicBool>,
    fechar: Option<Box<dyn FnOnce() + Send>>,
    /// A thread solta o `_feita` ao sair. `encerrar_e_esperar` espera a desconexão desse canal.
    feita: Receiver<()>,
}

/// O texto já entrou, e a vaga do Enter está reservada: o Enter só pode ser recusado se a fila já caiu.
pub struct EnvioReservado {
    tx: SyncSender<Vec<Passo>>,
    compartilhado: Arc<Compartilhado>,
    reservado: bool,
}

impl WriteQueue {
    /// Cria a fila e a thread que escreve em `writer`.
    ///
    /// `fechar` roda ao soltar a fila e precisa fazer a escrita presa voltar com erro. `avisar` recebe a falha, uma
    /// vez, se a escrita cair enquanto a fila ainda está em uso. Erro só se o SO recusar a thread.
    pub fn new(
        writer: Box<dyn Write + Send>,
        fechar: Box<dyn FnOnce() + Send>,
        avisar: Box<dyn FnOnce(FalhaEscrita) + Send>,
    ) -> std::io::Result<Self> {
        let (tx, rx) = sync_channel::<Vec<Passo>>(CAPACIDADE);
        let compartilhado = Arc::new(Compartilhado {
            estado: Mutex::new(Estado::Aberta),
            pendentes: AtomicUsize::new(0),
            nao_confirmados: AtomicUsize::new(0),
        });
        let cancelada = Arc::new(AtomicBool::new(false));
        let (feita_tx, feita_rx) = channel::<()>();
        let (c, k) = (compartilhado.clone(), cancelada.clone());
        let mut writer = writer;
        std::thread::Builder::new().name("pty-escrita".into()).spawn(move || {
            let _feita = feita_tx;
            while let Ok(pedido) = rx.recv() {
                // Um pedido vazio é o despertar do `encerrar`: a thread parada em `recv` sai sem esperar outro pedido.
                if k.load(Ordering::Acquire) {
                    break;
                }
                if pedido.is_empty() {
                    continue;
                }
                let resultado = executar(writer.as_mut(), &pedido);
                c.pendentes.fetch_sub(1, Ordering::AcqRel);
                if let Err(erro) = resultado {
                    let mut estado = c.estado.lock().unwrap_or_else(|e| e.into_inner());
                    *estado = Estado::Caiu;
                    let mut perdidas = 1;
                    while rx.try_recv().is_ok() {
                        perdidas += 1;
                    }
                    drop(estado);
                    // Quem já soltou a fila não tem para quem avisar.
                    if !k.load(Ordering::Acquire) {
                        avisar(FalhaEscrita { motivo: erro.to_string(), perdidas });
                    }
                    break;
                }
            }
        })?;
        Ok(Self { tx, compartilhado, cancelada, fechar: Some(fechar), feita: feita_rx })
    }

    /// Enfileira `data` sem bloquear. A ordem de chegada é a ordem de escrita.
    pub fn enqueue(&self, data: &[u8]) -> Result<(), PtyWriteError> {
        self.aceita(vec![Passo::Escreve(data.to_vec())])
    }

    /// Enfileira `texto` seguido de Enter como um pedido só: ou os dois entram, ou nenhum.
    pub fn enqueue_linha(&self, texto: &[u8]) -> Result<(), PtyWriteError> {
        let mut bytes = texto.to_vec();
        bytes.push(b'\r');
        self.aceita(vec![Passo::Escreve(bytes)])
    }

    /// Enfileira os passos como um pedido só: a thread os executa em sequência, sem intercalar outros pedidos. Ou o
    /// pedido inteiro entra, ou nenhum passo dele.
    pub fn enqueue_composto(&self, passos: Vec<Passo>) -> Result<(), PtyWriteError> {
        self.aceita(passos)
    }

    /// Reserva o texto e a vaga do Enter, que entram ou são recusados juntos. Quem chama manda o Enter depois, com
    /// `EnvioReservado::enter`, e esse Enter não pode ser recusado por falta de espaço.
    pub fn reservar_envio(&self, texto: &[u8]) -> Result<EnvioReservado, PtyWriteError> {
        let estado = self.compartilhado.estado.lock().unwrap_or_else(|e| e.into_inner());
        if *estado == Estado::Caiu {
            return Err(PtyWriteError::Closed);
        }
        if self.compartilhado.pendentes.fetch_add(2, Ordering::AcqRel) + 2 > CAPACIDADE {
            self.compartilhado.pendentes.fetch_sub(2, Ordering::AcqRel);
            return Err(PtyWriteError::Full);
        }
        match self.tx.try_send(vec![Passo::Escreve(texto.to_vec())]) {
            Ok(()) => Ok(EnvioReservado { tx: self.tx.clone(), compartilhado: self.compartilhado.clone(), reservado: true }),
            Err(erro) => {
                self.compartilhado.pendentes.fetch_sub(2, Ordering::AcqRel);
                Err(match erro {
                    TrySendError::Full(_) => PtyWriteError::Full,
                    TrySendError::Disconnected(_) => PtyWriteError::Closed,
                })
            }
        }
    }

    /// Fecha a fila (como ao soltá-la) e espera a thread sair, até `limite`. `true` se ela saiu.
    pub fn encerrar_e_esperar(&mut self, limite: Duration) -> bool {
        self.encerrar();
        matches!(self.feita.recv_timeout(limite), Err(RecvTimeoutError::Disconnected))
    }

    fn encerrar(&mut self) {
        self.cancelada.store(true, Ordering::Release);
        // Acorda a thread se ela estiver parada em `recv`. Se o canal estiver cheio, a thread já está ocupada e vê o
        // cancelamento ao pegar o próximo pedido.
        let _ = self.tx.try_send(Vec::new());
        if let Some(fechar) = self.fechar.take() {
            fechar();
        }
    }

    /// Quantos envios reservados saíram sem o Enter desde a criação da fila. Só os testes leem isso: em produção, o
    /// erro já sai para quem chamou (`sem_enter`).
    #[cfg(test)]
    pub fn nao_confirmados(&self) -> usize {
        self.compartilhado.nao_confirmados.load(Ordering::Acquire)
    }

    fn aceita(&self, pedido: Vec<Passo>) -> Result<(), PtyWriteError> {
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

impl EnvioReservado {
    /// Manda o Enter na vaga reservada. Só recusa se a fila já caiu.
    pub fn enter(mut self) -> Result<(), PtyWriteError> {
        let estado = self.compartilhado.estado.lock().unwrap_or_else(|e| e.into_inner());
        if *estado == Estado::Caiu {
            return Err(PtyWriteError::Closed);
        }
        match self.tx.try_send(vec![Passo::Escreve(b"\r".to_vec())]) {
            Ok(()) => {
                // A vaga reservada virou um pedido de fato: a contagem já a tem, então não a devolve ao sair.
                self.reservado = false;
                Ok(())
            }
            // A vaga reservada garante espaço no canal: `Full` não acontece aqui. Se acontecesse, é uma fila que não
            // aceita mais nada, e isso é tratado como encerrado.
            Err(_) => Err(PtyWriteError::Closed),
        }
    }
}

impl Drop for EnvioReservado {
    fn drop(&mut self) {
        // Sem o Enter, a vaga reservada volta para a fila, e o envio fica registrado como não confirmado: o texto pode
        // ter ficado na caixa da TUI.
        if self.reservado {
            self.compartilhado.pendentes.fetch_sub(1, Ordering::AcqRel);
            self.compartilhado.nao_confirmados.fetch_add(1, Ordering::AcqRel);
        }
    }
}

/// Executa os passos de um pedido em ordem. Uma falha de escrita para o pedido.
fn executar(writer: &mut dyn Write, pedido: &[Passo]) -> std::io::Result<()> {
    for passo in pedido {
        match passo {
            Passo::Escreve(bytes) => {
                writer.write_all(bytes)?;
                writer.flush()?;
            }
            Passo::Pausa(duracao) => {
                if *duracao > Duration::ZERO {
                    std::thread::sleep(*duracao);
                }
            }
        }
    }
    Ok(())
}

impl Drop for WriteQueue {
    fn drop(&mut self) {
        self.encerrar();
    }
}
