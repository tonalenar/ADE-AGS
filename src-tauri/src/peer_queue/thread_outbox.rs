//! O consumidor da fila de uma conversa por protocolo (`thread:<id>`): pega a próxima mensagem de
//! `peer_messages` e a envia à conversa, uma de cada vez e na ordem (`position, id`).
//!
//! Aqui não há thread, relógio nem barramento: [`drain`] processa tudo o que está pronto num dado
//! `now` e diz, em [`Next`], quando voltar. Quem dorme e acorda (o entregador de
//! `ipc/commands/peer_queue.rs`) só repete `drain` quando o barramento ou o prazo mandam; os testes
//! avançam um `i64` e chamam `drain`.
//!
//! Regras:
//! - o lock do banco nunca é segurado durante o envio (`ThreadPort::send` fala com o agente);
//! - a conversa trabalhando segura a fila (`queue_after_active`); só o "enviar agora" e o prazo de
//!   [`STEER_AFTER_MS`] entram no turno em andamento (`steer_active`);
//! - o resultado do envio decide o destino da mensagem pela CLASSE do erro (ver `conversa::envio`):
//!   `NotSent` volta à fila com backoff (até [`MAX_ATTEMPTS`]), `Unknown` nunca se repete,
//!   `Busy` volta sem gastar tentativa;
//! - a cabeça da fila com backoff segura as seguintes: a ordem não se inverte por causa de um erro.

use std::sync::MutexGuard;
use std::time::Duration;

use rusqlite::Connection;

use super::store::{self, PeerMessage};
use crate::canal::timeline::Item;
use crate::chat_team::model;
use crate::conversa::envio::{SendError, SendMode};
use crate::database::DbConnection;

/// Quantas vezes se tenta enviar uma mensagem que provadamente não saiu.
pub const MAX_ATTEMPTS: i64 = 5;
const BACKOFF_BASE_MS: i64 = 100;
const BACKOFF_MAX_MS: i64 = 30_000;
/// Quanto vale a posse do consumidor sobre uma mensagem `delivering` (ver `store::claim_for_thread`).
pub const LEASE_MS: i64 = 2 * 60 * 1000;
/// Depois disto na fila, a mensagem entra no turno em andamento em vez de esperar mais (como a fila dos
/// terminais, `QUEUE_MAX_WAIT`).
pub const STEER_AFTER_MS: i64 = 15 * 60 * 1000;

/// Pura: quanto esperar antes da tentativa seguinte, dado quantas já foram feitas.
/// 100 ms, 200, 400… até 30 s.
pub fn backoff_ms(attempts: i64) -> i64 {
    let shift = (attempts - 1).clamp(0, 20) as u32;
    (BACKOFF_BASE_MS << shift).min(BACKOFF_MAX_MS)
}

/// O que se sabe da conversa de destino.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    /// A conversa existe e está ativa (não foi concluída nem apagada).
    pub open: bool,
    /// O processo do agente está aberto.
    pub alive: bool,
    /// Há um turno em andamento.
    pub working: bool,
}

/// A conversa, vista pelo consumidor. A real (`ipc/commands/peer_queue.rs`) usa `conversa::api`; a dos
/// testes é roteirizada.
pub trait ThreadPort {
    fn target(&self, thread: &str) -> Target;
    /// Envia o texto à conversa. Não pode ser chamada com o lock do banco na mão.
    fn send(&self, thread: &str, text: &str, mode: SendMode) -> Result<(), SendError>;
    /// A timeline da conversa, para achar uma mensagem enviada (recuperação por marcador). `None` = não
    /// dá para ler.
    fn items(&self, thread: &str) -> Option<Vec<Item>>;
}

/// Quando o consumidor deve voltar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// Nada na fila.
    Empty,
    /// A conversa está num turno: volta quando ela ficar livre (ou o "enviar agora" chegar).
    Busy,
    /// A cabeça espera o backoff: volta neste instante (ms do relógio do banco).
    At(i64),
}

/// O que um `drain` fez.
#[derive(Debug)]
pub struct Drained {
    pub next: Next,
    pub delivered: Vec<PeerMessage>,
    /// As que terminaram sem chegar (`expired`/`unconfirmed`): o remetente precisa saber.
    pub failed: Vec<PeerMessage>,
}

enum Step {
    Done(Next),
    Expired(Vec<PeerMessage>),
    Send(PeerMessage, SendMode),
}

fn lock(db: &DbConnection) -> Result<MutexGuard<'_, Connection>, String> {
    db.lock().map_err(|e| e.to_string())
}

/// Lê e decide, só com o banco: a próxima mensagem, se pode ir agora e como.
fn step(conn: &Connection, to: &str, target: Target, now: i64) -> Result<Step, String> {
    let Some(head) = store::head(conn, to)? else { return Ok(Step::Done(Next::Empty)) };
    if !target.open {
        let note = "A conversa de destino foi concluída ou apagada.";
        return Ok(Step::Expired(store::expire_undeliverable(conn, to, note, now)?));
    }
    if let Some(at) = head.available_at.filter(|at| *at > now) {
        return Ok(Step::Done(Next::At(at)));
    }
    let may_steer = head.force_now || now - head.created_at >= STEER_AFTER_MS;
    if target.working && !may_steer {
        return Ok(Step::Done(Next::Busy));
    }
    let mode = if target.working { SendMode::SteerActive } else { SendMode::QueueAfterActive };
    match store::claim_for_thread(conn, head.id, mode.as_str(), now, LEASE_MS)? {
        Some(claimed) => Ok(Step::Send(claimed, mode)),
        // Cancelada nesse meio tempo: lê a próxima.
        None => step(conn, to, target, now),
    }
}

/// Grava o resultado de um envio. `Some(Next::Busy)` = a conversa estava ocupada: pare.
fn settle(conn: &Connection, msg: &PeerMessage, result: Result<(), SendError>, now: i64, out: &mut Drained) -> Result<Option<Next>, String> {
    let again = |id| store::get(conn, id);
    match result {
        Ok(()) => {
            store::finish(conn, msg.id, true, None, now)?;
            out.delivered.extend(again(msg.id)?);
        }
        Err(SendError::Busy) => {
            store::release(conn, msg.id, None, None, true, now)?;
            return Ok(Some(Next::Busy));
        }
        Err(SendError::NotSent(error)) if msg.attempts >= MAX_ATTEMPTS => {
            store::fail_delivery(conn, msg.id, &error, now)?;
            out.failed.extend(again(msg.id)?);
        }
        Err(SendError::NotSent(error)) => {
            store::release(conn, msg.id, Some(&error), Some(now + backoff_ms(msg.attempts)), false, now)?;
        }
        Err(SendError::Unknown(error)) => {
            store::finish(conn, msg.id, false, Some(&error), now)?;
            out.failed.extend(again(msg.id)?);
        }
    }
    Ok(None)
}

/// Processa a fila de `to` (`thread:<id>`) até não haver mais nada pronto em `now`.
/// `compose` monta o texto que a conversa recebe (cabeçalho, marcador, aviso de atraso).
pub fn drain(
    db: &DbConnection,
    port: &dyn ThreadPort,
    compose: &dyn Fn(&PeerMessage, Duration) -> String,
    to: &str,
    now: i64,
) -> Result<Drained, String> {
    let thread = model::thread_id_of(to).ok_or_else(|| format!("{to} não é uma conversa por protocolo"))?;
    let mut out = Drained { next: Next::Empty, delivered: Vec::new(), failed: Vec::new() };
    loop {
        let target = port.target(thread);
        // O passo é lido e a guarda do lock solta antes de agir: o envio nunca roda com o banco preso.
        let next_step = step(&*lock(db)?, to, target, now)?;
        match next_step {
            Step::Done(next) => {
                out.next = next;
                return Ok(out);
            }
            Step::Expired(list) => {
                out.failed.extend(list);
                return Ok(out);
            }
            Step::Send(msg, mode) => {
                let waited = Duration::from_millis((now - msg.created_at).max(0) as u64);
                let result = port.send(thread, &compose(&msg, waited), mode);
                if let Some(next) = settle(&*lock(db)?, &msg, result, now, &mut out)? {
                    out.next = next;
                    return Ok(out);
                }
            }
        }
    }
}
