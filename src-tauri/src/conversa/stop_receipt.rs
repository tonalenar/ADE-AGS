//! Parar com recibo idempotente (Fase 2, contrato §11.11).
//!
//! Com `client_request_id`, o Parar vira um comando com recibo e efeito, como o envio (`send_receipt`):
//! 1. **aceitar** (transação `Immediate`): grava a intenção (`harness_command_receipt`) e enfileira o efeito
//!    `chat_interrupt` (`harness_effect`);
//! 2. **reclamar** (outra transação): o efeito ganha dono e prazo, e o recibo vai a `submitting`;
//! 3. **executar**, fora do lock do banco: o `execute` fala com o motor (`api::stop_now`);
//! 4. **concluir** (transação): efeito e recibo vão a `accepted`, com o desfecho guardado (`sent`, `deferred` ou
//!    `no_turn`), ou a `unknown` quando o motor não disse se a parada chegou.
//!
//! Repetir o mesmo id devolve o recibo e **não** manda outra interrupção. Um Parar que chega depois de o turno ter
//! acabado fecha com `no_turn` e não manda nada ao agente. O Parar pendente do Codex (`codex_parar`) fica
//! `deferred`: o ADE já o aceitou, e ele sai quando o turno abrir. Um erro do motor deixa `unknown`: a
//! interrupção pode ter chegado, e repetir às cegas a mandaria de novo. Sem o id, o caminho é o de sempre
//! (`api::stop`), sem recibo e sem efeito.

use std::future::Future;

use rusqlite::TransactionBehavior;
use serde::Serialize;
use serde_json::{Value, json};

use super::api::Interrupted;
use crate::database::DbConnection;
use crate::harness::effects::{self, Claim, Disposition, EffectState, NewEffect};
use crate::harness::receipts::{self, Begin, CommandIdentity, CommandReceipt, KIND_CHAT_INTERRUPT, ReceiptState};

/// Mais que o prazo de uma interrupção: o `turn/interrupt` do Codex e o `control_request` do Claude esperam resposta.
pub const LEASE_MS: i64 = 30_000;
const MAX_ATTEMPTS: i64 = 3;
const EFFECT_KIND: &str = "chat_interrupt";

/// O que o Parar devolve à tela, à CLI e ao MCP.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReceipt {
    pub request_id: String,
    /// O estado do recibo: `accepted`, `submitting` ou `unknown`.
    pub delivery_state: String,
    /// O desfecho: `sent`, `deferred` ou `no_turn`. `None` quando não se sabe (`unknown`).
    pub outcome: Option<String>,
    /// `true` quando é uma repetição: o recibo veio do banco e o motor não foi chamado.
    pub replayed: bool,
    /// `true` só quando **esta** chamada mandou a interrupção ao agente.
    pub sent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn db_err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// O rótulo gravado no recibo e devolvido à tela.
fn label(outcome: Interrupted) -> &'static str {
    match outcome {
        Interrupted::Sent => "sent",
        Interrupted::Pending => "deferred",
        Interrupted::NoTurn => "no_turn",
    }
}

/// O desfecho gravado num recibo `accepted` (`result_json` = `{"outcome": …}`).
fn outcome_of(result_json: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(result_json?).ok()?;
    value.get("outcome")?.as_str().map(str::to_string)
}

/// O aviso de uma primeira chamada que aceitou o Parar sem mandar a interrupção agora.
fn accepted_note(outcome: Interrupted) -> Option<&'static str> {
    match outcome {
        Interrupted::Sent => None,
        Interrupted::Pending => Some("O Parar ficou pendente no Codex: sai quando o turno abrir; se o turno não abrir, nada é enviado."),
        Interrupted::NoTurn => Some("Não havia turno em andamento; nada foi parado nesta chamada."),
    }
}

/// A identidade do Parar: o escopo de quem chamou (aba ou conversa do MCP; `ui`, `cli`), o id do cliente e a
/// conversa. O motivo não entra: é sempre parar o turno em andamento.
pub fn identity(scope: &str, request_id: &str, thread_id: &str) -> Result<CommandIdentity, String> {
    let request_id = receipts::validate_request_id(request_id)?;
    let request_hash = receipts::payload_hash(&json!({ "thread": thread_id }));
    let caller_key = format!("chat-interrupt:{}", receipts::payload_hash(&json!(scope)));
    Ok(CommandIdentity { kind: KIND_CHAT_INTERRUPT.into(), caller_key, request_id, request_hash })
}

fn effect_key(identity: &CommandIdentity) -> String {
    format!("{}\u{0}{}\u{0}{}", identity.kind, identity.caller_key, identity.request_id)
}

/// A resposta de uma repetição: nunca chama o motor. O desfecho vem do que foi gravado.
fn replay(receipt: &CommandReceipt) -> StopReceipt {
    let note = match receipt.state {
        ReceiptState::Accepted => Some("O Parar já tinha sido aceito; esta repetição não mandou outra interrupção."),
        ReceiptState::Submitting => Some("Outro Parar com este client_request_id está em andamento; esta repetição não mandou nada."),
        ReceiptState::Unknown => Some("A interrupção pode ter chegado ao agente; confira a conversa antes de pedir outra. Esta repetição não mandou nada."),
        ReceiptState::Prepared | ReceiptState::Retryable => None,
    };
    let outcome = match receipt.state {
        ReceiptState::Accepted => outcome_of(receipt.result_json.as_deref()),
        _ => None,
    };
    StopReceipt {
        request_id: receipt.request_id.clone(),
        delivery_state: receipt.state.as_str().to_string(),
        outcome,
        replayed: true,
        sent: false,
        note: note.map(str::to_string),
    }
}

/// O passo 1: grava a intenção e enfileira o efeito, numa transação só. Devolve o recibo (novo ou o que já
/// existia). Hash diferente para o mesmo id é erro.
pub(super) fn accept(db: &DbConnection, identity: &CommandIdentity, thread_id: &str, now: i64) -> Result<CommandReceipt, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let receipt = match receipts::begin(&tx, identity, thread_id, now)? {
        Begin::Created(receipt) | Begin::Existing(receipt) => receipt,
    };
    effects::enqueue(
        &tx,
        &NewEffect {
            kind: EFFECT_KIND,
            dedupe_key: &effect_key(identity),
            target_ref: thread_id,
            retry_safe: false,
            max_attempts: MAX_ATTEMPTS,
            causation_event_id: None,
            receipt: Some(identity),
        },
        now,
    )?;
    tx.commit().map_err(db_err)?;
    Ok(receipt)
}

/// O resultado do passo 2.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Reserved {
    /// Esta chamada é a dona do efeito: pode interromper.
    Owner { effect_id: i64 },
    /// Não interromper: devolver este recibo.
    Replay(StopReceipt),
}

/// O passo 2: reclama o efeito (ganha dono e prazo) e leva o recibo a `submitting`.
pub(super) fn reserve(db: &DbConnection, identity: &CommandIdentity, owner: &str, now: i64) -> Result<Reserved, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let receipt = receipts::lookup(&tx, &identity.kind, &identity.caller_key, &identity.request_id)?
        .ok_or_else(|| "o recibo do Parar não foi encontrado".to_string())?;
    if receipt.request_hash != identity.request_hash {
        return Err(receipts::MISMATCH.to_string());
    }
    // Aceito ou de desfecho desconhecido: nunca mais se interrompe com este id.
    if matches!(receipt.state, ReceiptState::Accepted | ReceiptState::Unknown) {
        return Ok(Reserved::Replay(replay(&receipt)));
    }
    let effect = effects::enqueue(
        &tx,
        &NewEffect {
            kind: EFFECT_KIND,
            dedupe_key: &effect_key(identity),
            target_ref: &receipt.target_ref,
            retry_safe: false,
            max_attempts: MAX_ATTEMPTS,
            causation_event_id: None,
            receipt: Some(identity),
        },
        now,
    )?;
    let outcome = match effects::claim(&tx, effect.id, owner, now, LEASE_MS)? {
        Claim::Claimed(_) => {
            receipts::transition(
                &tx,
                &identity.kind,
                &identity.caller_key,
                &identity.request_id,
                &[ReceiptState::Prepared, ReceiptState::Retryable],
                ReceiptState::Submitting,
                now,
            )?;
            Reserved::Owner { effect_id: effect.id }
        }
        // Outro Parar com o mesmo id tem o lease vivo.
        Claim::Held { .. } => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Submitting, ..receipt })),
        // O lease venceu: o `claim` já levou efeito e recibo a `unknown`.
        Claim::Unknown(_) => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Unknown, ..receipt })),
        Claim::Done(EffectState::Completed) => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Accepted, ..receipt })),
        Claim::Done(_) | Claim::Missing => {
            return Err("este Parar esgotou as tentativas ou foi cancelado; use um client_request_id novo".into());
        }
    };
    tx.commit().map_err(db_err)?;
    Ok(outcome)
}

/// O passo 4: conclui efeito e recibo juntos, na mesma transação. Devolve o estado final do recibo.
fn finish(
    db: &DbConnection,
    identity: &CommandIdentity,
    effect_id: i64,
    owner: &str,
    result: &Result<Interrupted, String>,
    now: i64,
) -> Result<ReceiptState, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let state = match result {
        Ok(outcome) => {
            effects::complete(&tx, effect_id, owner, now)?;
            let result_json = json!({ "outcome": label(*outcome) }).to_string();
            receipts::set_result(&tx, identity, &result_json, now)?;
            // Se o dono perdeu o lease e o efeito foi marcado `unknown`, mas o motor respondeu: a resposta vence.
            receipts::transition(
                &tx,
                &identity.kind,
                &identity.caller_key,
                &identity.request_id,
                &[ReceiptState::Submitting, ReceiptState::Unknown],
                ReceiptState::Accepted,
                now,
            )?;
            ReceiptState::Accepted
        }
        // Só código fixo: a mensagem do motor pode repetir texto do agente, e ela não vai para o banco.
        Err(_) => {
            effects::fail(&tx, effect_id, owner, now, Disposition::Unknown, "outcome_unknown")?;
            receipts::transition(
                &tx,
                &identity.kind,
                &identity.caller_key,
                &identity.request_id,
                &[ReceiptState::Submitting],
                ReceiptState::Unknown,
                now,
            )?;
            ReceiptState::Unknown
        }
    };
    tx.commit().map_err(db_err)?;
    Ok(state)
}

/// O Parar com recibo, de ponta a ponta. `execute` é o motor (`api::stop_now`) e roda **sem** o lock do banco,
/// só depois de o efeito ter dono. Um erro do motor volta como `Err` (a tela o mostra como sempre) e deixa o
/// recibo em `unknown`.
pub async fn run<F, Fut>(
    db: &DbConnection,
    identity: &CommandIdentity,
    thread_id: &str,
    owner: &str,
    clock: &(dyn Fn() -> i64 + Sync),
    execute: F,
) -> Result<StopReceipt, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Interrupted, String>>,
{
    accept(db, identity, thread_id, clock())?;
    let effect_id = match reserve(db, identity, owner, clock())? {
        Reserved::Replay(receipt) => return Ok(receipt),
        Reserved::Owner { effect_id } => effect_id,
    };
    let result = execute().await;
    let state = finish(db, identity, effect_id, owner, &result, clock())?;
    match result {
        Ok(outcome) => Ok(StopReceipt {
            request_id: identity.request_id.clone(),
            delivery_state: state.as_str().to_string(),
            outcome: Some(label(outcome).to_string()),
            replayed: false,
            sent: outcome == Interrupted::Sent,
            note: accepted_note(outcome).map(str::to_string),
        }),
        Err(error) => Err(error),
    }
}
