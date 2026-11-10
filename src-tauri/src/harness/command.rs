//! Núcleo comum dos comandos com recibo (Fase 2, contratos §11.7 e §11.11).
//!
//! Um comando que muda o mundo (enviar, Parar) passa pelos mesmos quatro passos:
//! 1. **aceitar** (transação `Immediate`): grava a intenção (`harness_command_receipt`) e enfileira o efeito
//!    (`harness_effect`), com a chave `kind\0caller\0request`;
//! 2. **reclamar** (outra transação): o efeito ganha dono e prazo, e o recibo vai a `submitting`;
//! 3. **executar**, fora do lock do banco: o `execute` do próprio comando fala com o provider ou com o motor;
//! 4. **concluir** (transação): efeito e recibo vão juntos ao estado que o desfecho pede ([`Settlement`]).
//!
//! O que muda de um comando para outro fica no [`ReceiptCommand`]: a [`Spec`] (o efeito, o limite de tentativas,
//! o prazo do lease e o rótulo das mensagens), o mapeamento do resultado para um [`Settlement`] e a forma da
//! resposta. Repetir o mesmo id devolve o recibo gravado e **não** executa de novo. Um lease vencido num efeito de
//! provider vira `unknown`, nunca repetido às cegas. O conteúdo do pedido (texto, prompt) nunca vai para o banco.

use std::future::Future;

use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::{Value, json};

use super::effects::{self, Claim, Disposition, EffectState, NewEffect};
use super::receipts::{self, Begin, CommandIdentity, CommandReceipt, ReceiptState};
use crate::database::DbConnection;

/// Como um tipo de comando usa o efeito e o lease. É constante por tipo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Spec {
    /// O tipo do efeito em `harness_effect.kind` (`chat_send`, `chat_interrupt`).
    pub effect_kind: &'static str,
    /// Quantas reclamações o efeito aceita antes de virar `failed`.
    pub max_attempts: i64,
    /// Prazo do lease, em ms. Vencido, um efeito de provider vira `unknown`.
    pub lease_ms: i64,
    /// Como as mensagens de erro chamam o comando (`envio`, `Parar`).
    pub label: &'static str,
}

/// O que o desfecho do provider ou do motor quer dizer para o efeito e para o recibo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Settlement {
    /// Aplicado: o efeito vira `completed` e o recibo `accepted`. `result_json` é o resultado pequeno (ids, desfecho),
    /// nunca texto de agente.
    Applied { result_json: Option<String> },
    /// Nada saiu: o efeito volta a `pending` enquanto houver tentativa, e o recibo fica `retryable`.
    NotApplied,
    /// Pode ter saído: o efeito vira `failed` com `outcome_unknown`, e o recibo `unknown`. Nunca se repete.
    Unknown,
}

/// Um tipo de comando com recibo. O núcleo cuida de aceitar, reclamar, concluir e de repetir; o tipo diz o resto.
pub(crate) trait ReceiptCommand {
    /// O que o `execute` devolve quando dá certo.
    type Output;
    /// O que o `execute` devolve quando falha. Só vira texto na resposta: o banco guarda apenas um código fixo.
    type Error: Into<String>;
    /// A resposta da chamada: o que a tela, a CLI e o MCP recebem.
    type Reply;
    /// O efeito, os limites e o rótulo deste comando.
    const SPEC: Spec;
    /// Decide o estado final do efeito e do recibo a partir do resultado do `execute`.
    fn settle(result: &Result<Self::Output, Self::Error>) -> Settlement;
    /// A resposta de uma repetição. Nunca executa: o desfecho vem do que ficou gravado.
    fn replay(receipt: &CommandReceipt) -> Self::Reply;
    /// A resposta de quem executou, já com o estado final do recibo.
    fn reply(identity: &CommandIdentity, state: ReceiptState, result: Result<Self::Output, Self::Error>) -> Result<Self::Reply, String>;
}

/// O resultado da reserva (passo 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reserved {
    /// Esta chamada é a dona do efeito: pode executar.
    Owner { effect_id: i64 },
    /// Não executar: o recibo gravado. Pode ser de um envio com lease vivo, de um desfecho `unknown` ou de um
    /// efeito que já acabou; o `claim` já levou o recibo ao estado que a repetição deve mostrar.
    Replay(CommandReceipt),
}

fn db_err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// A identidade de um comando: a chave `(kind, caller_key, request_id)` e o hash do pedido. O escopo de quem chamou
/// (`ui`, `cli`, aba ou conversa do MCP) entra na chave, e o payload entra só no hash. O prefixo é o rótulo da chave
/// (`chat-send`, `chat-interrupt`): recibos gravados dependem dele, por isso não muda.
pub(crate) fn identity(kind: &str, prefix: &str, scope: &str, request_id: &str, payload: &Value) -> Result<CommandIdentity, String> {
    let request_id = receipts::validate_request_id(request_id)?;
    Ok(CommandIdentity {
        kind: kind.to_string(),
        caller_key: format!("{prefix}:{}", receipts::payload_hash(&json!(scope))),
        request_id,
        request_hash: receipts::payload_hash(payload),
    })
}

/// A chave de dedupe do efeito: um efeito por intenção. Enfileirar duas vezes a mesma devolve o mesmo.
fn dedupe_key(identity: &CommandIdentity) -> String {
    format!("{}\u{0}{}\u{0}{}", identity.kind, identity.caller_key, identity.request_id)
}

/// Enfileira o efeito do comando. Dentro da transação que o chama.
fn enqueue(tx: &Transaction, spec: &Spec, identity: &CommandIdentity, target_ref: &str, now: i64) -> Result<effects::Enqueued, String> {
    effects::enqueue(
        tx,
        &NewEffect {
            kind: spec.effect_kind,
            dedupe_key: &dedupe_key(identity),
            target_ref,
            retry_safe: false,
            max_attempts: spec.max_attempts,
            causation_event_id: None,
            receipt: Some(identity),
        },
        now,
    )
}

/// Passo 1: grava a intenção e enfileira o efeito, numa transação só. Devolve o recibo (novo, ou o que já existia).
/// Hash diferente para o mesmo id é erro.
pub(crate) fn accept(db: &DbConnection, spec: &Spec, identity: &CommandIdentity, target_ref: &str, now: i64) -> Result<CommandReceipt, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let receipt = match receipts::begin(&tx, identity, target_ref, now)? {
        Begin::Created(receipt) | Begin::Existing(receipt) => receipt,
    };
    enqueue(&tx, spec, identity, target_ref, now)?;
    tx.commit().map_err(db_err)?;
    Ok(receipt)
}

/// Passo 2: reclama o efeito (ganha dono e prazo) e leva o recibo a `submitting`, ou devolve o recibo para repetir.
pub(crate) fn reserve(db: &DbConnection, spec: &Spec, identity: &CommandIdentity, owner: &str, now: i64) -> Result<Reserved, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let receipt = receipts::lookup(&tx, &identity.kind, &identity.caller_key, &identity.request_id)?
        .ok_or_else(|| format!("o recibo do {} não foi encontrado", spec.label))?;
    if receipt.request_hash != identity.request_hash {
        return Err(receipts::MISMATCH.to_string());
    }
    // Aceito ou de desfecho desconhecido: nunca mais se executa com este id.
    if matches!(receipt.state, ReceiptState::Accepted | ReceiptState::Unknown) {
        return Ok(Reserved::Replay(receipt));
    }
    let effect = enqueue(&tx, spec, identity, &receipt.target_ref, now)?;
    let outcome = match effects::claim(&tx, effect.id, owner, now, spec.lease_ms)? {
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
        // Outro com o mesmo id tem o lease vivo.
        Claim::Held { .. } => Reserved::Replay(CommandReceipt { state: ReceiptState::Submitting, ..receipt }),
        // O lease venceu: o `claim` já levou efeito e recibo a `unknown`.
        Claim::Unknown(_) => Reserved::Replay(CommandReceipt { state: ReceiptState::Unknown, ..receipt }),
        Claim::Done(EffectState::Completed) => Reserved::Replay(CommandReceipt { state: ReceiptState::Accepted, ..receipt }),
        Claim::Done(_) | Claim::Missing => {
            return Err(format!("este {} esgotou as tentativas ou foi cancelado; use um client_request_id novo", spec.label));
        }
    };
    tx.commit().map_err(db_err)?;
    Ok(outcome)
}

/// Passo 4: conclui efeito e recibo juntos, na mesma transação. Devolve o estado final do recibo.
pub(crate) fn finish(db: &DbConnection, identity: &CommandIdentity, effect_id: i64, owner: &str, settlement: Settlement, now: i64) -> Result<ReceiptState, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let state = match settlement {
        Settlement::Applied { result_json } => {
            effects::complete(&tx, effect_id, owner, now)?;
            if let Some(json) = result_json {
                receipts::set_result(&tx, identity, &json, now)?;
            }
            // Se o dono perdeu o lease, o efeito foi marcado `unknown`, mas o provider aceitou: a prova vence.
            transition(&tx, identity, &[ReceiptState::Submitting, ReceiptState::Unknown], ReceiptState::Accepted, now)?;
            ReceiptState::Accepted
        }
        // Só código fixo: a mensagem do provider pode repetir texto do agente, e ela não vai para o banco.
        Settlement::NotApplied => {
            effects::fail(&tx, effect_id, owner, now, Disposition::NotApplied, "not_sent")?;
            transition(&tx, identity, &[ReceiptState::Submitting], ReceiptState::Retryable, now)?;
            ReceiptState::Retryable
        }
        Settlement::Unknown => {
            effects::fail(&tx, effect_id, owner, now, Disposition::Unknown, "outcome_unknown")?;
            transition(&tx, identity, &[ReceiptState::Submitting], ReceiptState::Unknown, now)?;
            ReceiptState::Unknown
        }
    };
    tx.commit().map_err(db_err)?;
    Ok(state)
}

fn transition(tx: &Connection, identity: &CommandIdentity, from: &[ReceiptState], to: ReceiptState, now: i64) -> Result<bool, String> {
    receipts::transition(tx, &identity.kind, &identity.caller_key, &identity.request_id, from, to, now)
}

/// O comando de ponta a ponta: aceita, reclama, executa (fora do lock) e conclui. `execute` roda só depois de o efeito
/// ter dono. Uma repetição devolve a resposta de [`ReceiptCommand::replay`] sem executar.
pub(crate) async fn run<C, F, Fut>(
    db: &DbConnection,
    identity: &CommandIdentity,
    target_ref: &str,
    owner: &str,
    clock: &(dyn Fn() -> i64 + Sync),
    execute: F,
) -> Result<C::Reply, String>
where
    C: ReceiptCommand,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<C::Output, C::Error>>,
{
    accept(db, &C::SPEC, identity, target_ref, clock())?;
    let effect_id = match reserve(db, &C::SPEC, identity, owner, clock())? {
        Reserved::Replay(receipt) => return Ok(C::replay(&receipt)),
        Reserved::Owner { effect_id } => effect_id,
    };
    let result = execute().await;
    let state = finish(db, identity, effect_id, owner, C::settle(&result), clock())?;
    C::reply(identity, state, result)
}
