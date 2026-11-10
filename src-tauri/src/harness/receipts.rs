//! Recibos idempotentes de comando (Fase 2, contrato §11).
//!
//! Um recibo liga quem chamou (`caller_key`), o `client_request_id`, o hash do payload e o resultado da
//! aceitação. A chave é `(kind, caller_key, request_id)`. Mesmo id e mesmo hash devolvem o recibo
//! gravado; mesmo id com hash diferente falha fechado. Unifica, sem apagar, os dois recibos antigos
//! (`chat_child_receipts`, `run_delegation_receipts`): a leitura cai neles.
//!
//! As funções recebem `&Connection` (ou a transação do chamador) e não fazem I/O além do banco.

use rusqlite::Connection;
use serde_json::Value;

pub const KIND_CHAT_SEND: &str = "chat_send";
pub const KIND_CHAT_NEW: &str = "chat_new";
pub const KIND_FLEET_DELEGATE: &str = "fleet_delegate";

/// O erro de um id reaproveitado com outro conteúdo (o mesmo texto dos recibos antigos).
pub const MISMATCH: &str = "client_request_id já foi usado com outro conteúdo; use um ID novo";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptState {
    Prepared,
    Submitting,
    Accepted,
    Retryable,
    Unknown,
}

impl ReceiptState {
    pub fn as_str(self) -> &'static str {
        unimplemented!()
    }
    pub fn parse(_raw: &str) -> Option<Self> {
        unimplemented!()
    }
}

/// A chave de um comando e o hash do que ele pede.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandIdentity {
    pub kind: String,
    pub caller_key: String,
    pub request_id: String,
    pub request_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandReceipt {
    pub kind: String,
    pub caller_key: String,
    pub request_id: String,
    pub request_hash: String,
    pub target_ref: String,
    pub node_id: Option<String>,
    pub state: ReceiptState,
    pub result_json: Option<String>,
    pub event_sequence: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Begin {
    /// O comando é novo: o recibo acabou de ser gravado em `prepared`.
    Created(CommandReceipt),
    /// O mesmo comando já tinha recibo (mesmo hash).
    Existing(CommandReceipt),
}

pub(crate) fn migrate(_conn: &Connection) -> rusqlite::Result<()> {
    unimplemented!()
}

/// Hash canônico do payload: o chamador tira o próprio `client_request_id` antes.
pub fn payload_hash(_payload: &Value) -> String {
    unimplemented!()
}

/// `client_request_id` válido: não vazio, até 128 caracteres, sem controles.
pub fn validate_request_id(_raw: &str) -> Result<String, String> {
    unimplemented!()
}

pub fn lookup(
    _conn: &Connection,
    _kind: &str,
    _caller_key: &str,
    _request_id: &str,
) -> Result<Option<CommandReceipt>, String> {
    unimplemented!()
}

/// Grava a intenção ou devolve o recibo que já existe. Chamar dentro da transação `Immediate` do
/// comando. Hash diferente para o mesmo `(kind, caller_key, request_id)` é [`MISMATCH`].
pub fn begin(
    _conn: &Connection,
    _identity: &CommandIdentity,
    _target_ref: &str,
    _now: i64,
) -> Result<Begin, String> {
    unimplemented!()
}

/// Troca o estado só se o atual é um dos esperados (uma resposta tardia não sobrescreve outra tentativa).
pub fn transition(
    _conn: &Connection,
    _kind: &str,
    _caller_key: &str,
    _request_id: &str,
    _from: &[ReceiptState],
    _to: ReceiptState,
    _now: i64,
) -> Result<bool, String> {
    unimplemented!()
}

pub fn set_result(
    _conn: &Connection,
    _identity: &CommandIdentity,
    _result_json: &str,
    _now: i64,
) -> Result<(), String> {
    unimplemented!()
}

/// Escrita dupla da delegação (contrato §11.6): o recibo antigo continua sendo a fonte.
pub fn mirror_delegation(
    _conn: &Connection,
    _caller_key: &str,
    _request_id: &str,
    _request_hash: &str,
    _run_id: &str,
    _task_keys_json: &str,
    _now: i64,
) -> Result<(), String> {
    unimplemented!()
}
