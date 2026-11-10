//! Envio de mensagem com recibo idempotente (Fase 2, contrato §11.7).
//!
//! Com `client_request_id`, o envio vira um comando com recibo e efeito:
//! 1. **aceitar** (transação `Immediate`): grava a intenção (`harness_command_receipt`) e enfileira o
//!    efeito (`harness_effect`);
//! 2. **reclamar** (outra transação): o efeito ganha dono e prazo, e o recibo vai a `submitting`;
//! 3. **executar**, fora do lock do banco: o `execute` que o chamador passa fala com o provider;
//! 4. **concluir** (transação): efeito e recibo vão juntos a `completed/accepted`, a `pending/retryable`
//!    (nada saiu) ou a `failed/unknown` (pode ter saído).
//!
//! Repetir o mesmo id devolve o recibo e **não** reenvia. Um lease vencido num efeito de provider vira
//! `unknown`: sem a capability de reconciliar o envio, a repetição às cegas duplicaria a ordem. O texto
//! da mensagem nunca vai para o banco. Sem o id, o chamador usa o caminho de sempre (`api::send_with`).

use std::future::Future;

use rusqlite::TransactionBehavior;
use serde::Serialize;
use serde_json::json;

use super::envio::SendError;
use crate::database::DbConnection;
use crate::harness::effects::{self, Claim, Disposition, EffectState, NewEffect};
use crate::harness::receipts::{self, Begin, CommandIdentity, CommandReceipt, KIND_CHAT_SEND, ReceiptState};

/// Mais que o prazo de um `turn/start` do Codex.
pub const LEASE_MS: i64 = 120_000;
const MAX_ATTEMPTS: i64 = 5;
const EFFECT_KIND: &str = "chat_send";

/// O que o chamador devolve à tela, à CLI e ao MCP.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReceipt {
    pub request_id: String,
    pub delivery_state: String,
    /// `true` quando é uma repetição: o recibo veio do banco e nada foi enviado.
    pub replayed: bool,
    /// `true` só quando **esta** chamada enviou a mensagem ao provider.
    pub sent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn db_err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// A identidade do comando: o escopo de quem chamou (aba ou conversa do MCP; `ui`, `cli`), o id do
/// cliente e o hash de conversa, texto e imagens. O modo de envio não entra: é sempre o do usuário.
pub fn identity(
    scope: &str,
    request_id: &str,
    thread_id: &str,
    text: &str,
    images: &[String],
) -> Result<CommandIdentity, String> {
    let request_id = receipts::validate_request_id(request_id)?;
    let request_hash = receipts::payload_hash(&json!({ "thread": thread_id, "text": text, "images": images }));
    let caller_key = format!("chat-send:{}", receipts::payload_hash(&json!(scope)));
    Ok(CommandIdentity { kind: KIND_CHAT_SEND.into(), caller_key, request_id, request_hash })
}

fn effect_key(identity: &CommandIdentity) -> String {
    format!("{}\u{0}{}\u{0}{}", identity.kind, identity.caller_key, identity.request_id)
}

fn replay(receipt: &CommandReceipt) -> SendReceipt {
    let note = match receipt.state {
        ReceiptState::Accepted => Some("A mensagem já foi aceita; esta repetição não a enviou de novo."),
        ReceiptState::Submitting => Some("Outro envio com este client_request_id está em andamento; esta repetição não enviou nada."),
        ReceiptState::Unknown => Some("A mensagem pode ter chegado ao agente; confira a conversa antes de enviar outra. Esta repetição não enviou nada."),
        ReceiptState::Prepared | ReceiptState::Retryable => None,
    };
    SendReceipt {
        request_id: receipt.request_id.clone(),
        delivery_state: receipt.state.as_str().to_string(),
        replayed: true,
        sent: false,
        note: note.map(str::to_string),
    }
}

/// O passo 1: grava a intenção e enfileira o efeito, numa transação só. Devolve o recibo (novo ou o
/// que já existia). Hash diferente para o mesmo id é erro.
pub(super) fn accept(
    db: &DbConnection,
    identity: &CommandIdentity,
    thread_id: &str,
    now: i64,
) -> Result<CommandReceipt, String> {
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
    /// Esta chamada é a dona do efeito: pode executar.
    Owner { effect_id: i64 },
    /// Não executar: devolver este recibo.
    Replay(SendReceipt),
}

/// O passo 2: reclama o efeito (ganha dono e prazo) e leva o recibo a `submitting`.
pub(super) fn reserve(
    db: &DbConnection,
    identity: &CommandIdentity,
    owner: &str,
    now: i64,
) -> Result<Reserved, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let receipt = receipts::lookup(&tx, &identity.kind, &identity.caller_key, &identity.request_id)?
        .ok_or_else(|| "o recibo do envio não foi encontrado".to_string())?;
    if receipt.request_hash != identity.request_hash {
        return Err(receipts::MISMATCH.to_string());
    }
    // Aceito ou de desfecho desconhecido: nunca mais se envia com este id.
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
        // Outro envio com o mesmo id tem o lease vivo.
        Claim::Held { .. } => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Submitting, ..receipt })),
        // O lease venceu: o `claim` já levou efeito e recibo a `unknown`.
        Claim::Unknown(_) => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Unknown, ..receipt })),
        Claim::Done(EffectState::Completed) => Reserved::Replay(replay(&CommandReceipt { state: ReceiptState::Accepted, ..receipt })),
        Claim::Done(_) | Claim::Missing => {
            return Err("este envio esgotou as tentativas ou foi cancelado; use um client_request_id novo".into());
        }
    };
    tx.commit().map_err(db_err)?;
    Ok(outcome)
}

/// O passo 4: conclui efeito e recibo juntos, na mesma transação. Devolve o estado final do recibo.
pub(super) fn finish(
    db: &DbConnection,
    identity: &CommandIdentity,
    effect_id: i64,
    owner: &str,
    result: &Result<(), SendError>,
    now: i64,
) -> Result<ReceiptState, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let (state, from): (ReceiptState, &[ReceiptState]) = match result {
        Ok(()) => {
            effects::complete(&tx, effect_id, owner, now)?;
            // O dono perdeu o lease e o efeito foi marcado `unknown`, mas a mensagem foi aceita: a prova vence.
            (ReceiptState::Accepted, &[ReceiptState::Submitting, ReceiptState::Unknown])
        }
        // Só códigos fixos: a mensagem do provider pode repetir o texto do agente e não vai para o banco.
        Err(SendError::NotSent(_) | SendError::Busy) => {
            effects::fail(&tx, effect_id, owner, now, Disposition::NotApplied, "not_sent")?;
            (ReceiptState::Retryable, &[ReceiptState::Submitting])
        }
        Err(SendError::Unknown(_)) => {
            effects::fail(&tx, effect_id, owner, now, Disposition::Unknown, "outcome_unknown")?;
            (ReceiptState::Unknown, &[ReceiptState::Submitting])
        }
    };
    receipts::transition(&tx, &identity.kind, &identity.caller_key, &identity.request_id, from, state, now)?;
    tx.commit().map_err(db_err)?;
    Ok(state)
}

/// O envio com recibo, de ponta a ponta. `execute` é a conversa com o provider e roda **sem** o lock do
/// banco, só depois de o efeito ter dono. Um erro de envio volta como `Err` (a tela o mostra como
/// sempre) e deixa o recibo em `retryable` ou `unknown`.
pub async fn run<F, Fut>(
    db: &DbConnection,
    identity: &CommandIdentity,
    thread_id: &str,
    owner: &str,
    clock: &(dyn Fn() -> i64 + Sync),
    execute: F,
) -> Result<SendReceipt, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), SendError>>,
{
    accept(db, identity, thread_id, clock())?;
    let effect_id = match reserve(db, identity, owner, clock())? {
        Reserved::Replay(receipt) => return Ok(receipt),
        Reserved::Owner { effect_id } => effect_id,
    };
    let result = execute().await;
    let state = finish(db, identity, effect_id, owner, &result, clock())?;
    match result {
        Ok(()) => Ok(SendReceipt {
            request_id: identity.request_id.clone(),
            delivery_state: state.as_str().to_string(),
            replayed: false,
            sent: true,
            note: None,
        }),
        Err(error) => Err(String::from(error)),
    }
}
