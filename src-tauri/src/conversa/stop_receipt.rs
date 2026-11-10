//! Parar com recibo idempotente (Fase 2, contrato §11.11).
//!
//! O Parar é um [`ReceiptCommand`] do núcleo comum (`harness::command`), como o envio (`send_receipt`):
//! aceitar, reclamar, executar (`api::stop_now`) e concluir, com o desfecho guardado em `result_json`
//! (`sent`, `deferred`, `no_turn`). Um erro do motor deixa `unknown`: a interrupção pode ter chegado, e repetir às
//! cegas a mandaria de novo. Repetir o mesmo id devolve o recibo e **não** manda outra interrupção. Sem o id, o
//! caminho é o de sempre (`api::stop`), sem recibo e sem efeito.
//!
//! `deferred` é o Parar que o ADE já aceitou e que sai quando o turno mostrar que roda (o Codex no `turn/started`;
//! Claude e OpenCode no primeiro aviso do turno, ver `codex_parar`). Se o turno não abrir, nada é enviado.

use serde::Serialize;
use serde_json::{Value, json};

use super::api::Interrupted;
use crate::database::DbConnection;
use crate::harness::command::{self, ReceiptCommand, Settlement, Spec};
#[cfg(test)]
pub(super) use crate::harness::command::Reserved;
use crate::harness::receipts::{CommandIdentity, CommandReceipt, KIND_CHAT_INTERRUPT, ReceiptState};

/// Mais que o prazo de uma interrupção: o `turn/interrupt` do Codex e o `control_request` do Claude esperam resposta.
pub const LEASE_MS: i64 = 30_000;
const MAX_ATTEMPTS: i64 = 3;

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
        Interrupted::Pending => Some("O Parar ficou pendente: sai quando o agente mostrar que o turno roda; se o turno não abrir, nada é enviado."),
        Interrupted::NoTurn => Some("Não havia turno em andamento; nada foi parado nesta chamada."),
    }
}

/// A identidade do Parar: o escopo de quem chamou (aba ou conversa do MCP; `ui`, `cli`), o id do cliente e a
/// conversa. O motivo não entra: é sempre parar o turno em andamento.
pub fn identity(scope: &str, request_id: &str, thread_id: &str) -> Result<CommandIdentity, String> {
    command::identity(KIND_CHAT_INTERRUPT, "chat-interrupt", scope, request_id, &json!({ "thread": thread_id }))
}

/// O Parar como comando com recibo.
struct StopCommand;

impl ReceiptCommand for StopCommand {
    type Output = Interrupted;
    type Error = String;
    type Reply = StopReceipt;
    const SPEC: Spec = Spec { effect_kind: "chat_interrupt", max_attempts: MAX_ATTEMPTS, lease_ms: LEASE_MS, label: "Parar" };

    fn settle(result: &Result<Interrupted, String>) -> Settlement {
        match result {
            // O desfecho vai ao recibo. Só o rótulo: nada do motor (que pode repetir texto do agente) vai para o banco.
            Ok(outcome) => Settlement::Applied { result_json: Some(json!({ "outcome": label(*outcome) }).to_string()) },
            // O motor não disse se a parada chegou: nunca se repete às cegas.
            Err(_) => Settlement::Unknown,
        }
    }

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

    fn reply(identity: &CommandIdentity, state: ReceiptState, result: Result<Interrupted, String>) -> Result<StopReceipt, String> {
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
}

/// Passo 1 do Parar (aceitar). Os testes do recibo chamam o passo isolado, para simular uma queda entre os passos.
#[cfg(test)]
pub(super) fn accept(db: &DbConnection, identity: &CommandIdentity, thread_id: &str, now: i64) -> Result<CommandReceipt, String> {
    command::accept(db, &StopCommand::SPEC, identity, thread_id, now)
}

/// Passo 2 do Parar (reclamar). Ver [`accept`].
#[cfg(test)]
pub(super) fn reserve(db: &DbConnection, identity: &CommandIdentity, owner: &str, now: i64) -> Result<Reserved, String> {
    command::reserve(db, &StopCommand::SPEC, identity, owner, now)
}

/// O Parar com recibo, de ponta a ponta. `execute` é o motor (`api::stop_now`) e roda **sem** o lock do banco, só
/// depois de o efeito ter dono. Um erro do motor volta como `Err` (a tela o mostra como sempre) e deixa o recibo em
/// `unknown`.
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
    Fut: std::future::Future<Output = Result<Interrupted, String>>,
{
    command::run::<StopCommand, F, Fut>(db, identity, thread_id, owner, clock, execute).await
}
