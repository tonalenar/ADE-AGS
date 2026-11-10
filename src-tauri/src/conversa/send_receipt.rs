//! Envio de mensagem com recibo idempotente (Fase 2, contrato §11.7).
//!
//! O envio é um [`ReceiptCommand`] do núcleo comum (`harness::command`): aceitar, reclamar, executar e concluir.
//! Com `client_request_id`, repetir o mesmo id devolve o recibo e **não** reenvia. Um lease vencido num efeito de
//! provider vira `unknown`: sem a capability de reconciliar o envio, a repetição às cegas duplicaria a ordem. O texto
//! da mensagem nunca vai para o banco. Sem o id, o chamador usa o caminho de sempre (`api::send_with`).

use std::future::Future;

use serde::Serialize;
use serde_json::json;

use super::envio::SendError;
use crate::database::DbConnection;
use crate::harness::command::{self, ReceiptCommand, Settlement, Spec};
#[cfg(test)]
pub(super) use crate::harness::command::Reserved;
use crate::harness::receipts::{CommandIdentity, CommandReceipt, KIND_CHAT_SEND, ReceiptState};

/// Mais que o prazo de um `turn/start` do Codex.
pub const LEASE_MS: i64 = 120_000;
const MAX_ATTEMPTS: i64 = 5;

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

/// A identidade do envio: o escopo de quem chamou (aba ou conversa do MCP; `ui`, `cli`), o id do cliente e o hash de
/// conversa, texto e imagens. O modo de envio não entra: é sempre o do usuário.
pub fn identity(scope: &str, request_id: &str, thread_id: &str, text: &str, images: &[String]) -> Result<CommandIdentity, String> {
    command::identity(
        KIND_CHAT_SEND,
        "chat-send",
        scope,
        request_id,
        &json!({ "thread": thread_id, "text": text, "images": images }),
    )
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

/// O envio como comando com recibo.
struct SendCommand;

impl ReceiptCommand for SendCommand {
    type Output = ();
    type Error = SendError;
    type Reply = SendReceipt;
    const SPEC: Spec = Spec { effect_kind: "chat_send", max_attempts: MAX_ATTEMPTS, lease_ms: LEASE_MS, label: "envio" };

    fn settle(result: &Result<(), SendError>) -> Settlement {
        match result {
            Ok(()) => Settlement::Applied { result_json: None },
            // Nada chegou ao agente (`Busy` também não saiu): é seguro tentar de novo.
            Err(SendError::NotSent(_) | SendError::Busy) => Settlement::NotApplied,
            Err(SendError::Unknown(_)) => Settlement::Unknown,
        }
    }

    fn replay(receipt: &CommandReceipt) -> SendReceipt {
        replay(receipt)
    }

    fn reply(identity: &CommandIdentity, state: ReceiptState, result: Result<(), SendError>) -> Result<SendReceipt, String> {
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
}

/// Passo 1 do envio (aceitar). Os testes do recibo chamam o passo isolado, para simular uma queda entre os passos.
#[cfg(test)]
pub(super) fn accept(db: &DbConnection, identity: &CommandIdentity, thread_id: &str, now: i64) -> Result<CommandReceipt, String> {
    command::accept(db, &SendCommand::SPEC, identity, thread_id, now)
}

/// Passo 2 do envio (reclamar). Ver [`accept`].
#[cfg(test)]
pub(super) fn reserve(db: &DbConnection, identity: &CommandIdentity, owner: &str, now: i64) -> Result<Reserved, String> {
    command::reserve(db, &SendCommand::SPEC, identity, owner, now)
}

/// Passo 4 do envio (concluir). Ver [`accept`].
#[cfg(test)]
pub(super) fn finish(db: &DbConnection, identity: &CommandIdentity, effect_id: i64, owner: &str, result: &Result<(), SendError>, now: i64) -> Result<ReceiptState, String> {
    command::finish(db, identity, effect_id, owner, SendCommand::settle(result), now)
}

/// O envio com recibo, de ponta a ponta. `execute` é a conversa com o provider e roda **sem** o lock do banco, só
/// depois de o efeito ter dono. Um erro de envio volta como `Err` (a tela o mostra como sempre) e deixa o recibo em
/// `retryable` ou `unknown`.
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
    command::run::<SendCommand, F, Fut>(db, identity, thread_id, owner, clock, execute).await
}
