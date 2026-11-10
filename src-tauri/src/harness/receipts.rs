//! Recibos idempotentes de comando (Fase 2, contrato §11).
//!
//! Um recibo liga quem chamou (`caller_key`), o `client_request_id`, o hash do payload e o resultado da
//! aceitação. A chave é `(kind, caller_key, request_id)`. Mesmo id e mesmo hash devolvem o recibo
//! gravado; mesmo id com hash diferente falha fechado. Unifica, sem apagar, os dois recibos antigos
//! (`chat_child_receipts`, `run_delegation_receipts`): a leitura cai neles.
//!
//! As funções recebem `&Connection` (ou a transação do chamador) e não fazem I/O além do banco.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const KIND_CHAT_SEND: &str = "chat_send";
pub const KIND_CHAT_NEW: &str = "chat_new";
pub const KIND_CHAT_INTERRUPT: &str = "chat_interrupt";
pub const KIND_FLEET_DELEGATE: &str = "fleet_delegate";

/// O erro de um id reaproveitado com outro conteúdo (o mesmo texto dos recibos antigos).
pub const MISMATCH: &str = "client_request_id já foi usado com outro conteúdo; use um ID novo";

const REQUEST_ID_MAX: usize = 128;

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
        match self {
            ReceiptState::Prepared => "prepared",
            ReceiptState::Submitting => "submitting",
            ReceiptState::Accepted => "accepted",
            ReceiptState::Retryable => "retryable",
            ReceiptState::Unknown => "unknown",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "prepared" => ReceiptState::Prepared,
            "submitting" => ReceiptState::Submitting,
            "accepted" => ReceiptState::Accepted,
            "retryable" => ReceiptState::Retryable,
            "unknown" => ReceiptState::Unknown,
            _ => return None,
        })
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

/// Criada num `migrate()` de módulo (chamado por `harness::store::migrate`): `database/schema.rs` não
/// muda. Sem FK de propósito: o recibo preserva a identidade do pedido mesmo se a conversa ou o run
/// forem apagados depois (mesma escolha de `run_delegation_receipts`).
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_command_receipt (
            kind           TEXT NOT NULL,
            caller_key     TEXT NOT NULL,
            request_id     TEXT NOT NULL,
            request_hash   TEXT NOT NULL,
            target_ref     TEXT NOT NULL,
            node_id        TEXT,
            state          TEXT NOT NULL,
            result_json    TEXT,
            event_sequence INTEGER,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            PRIMARY KEY (kind, caller_key, request_id)
        );",
    )
}

/// Hash canônico do payload: o chamador tira o próprio `client_request_id` antes.
pub fn payload_hash(payload: &Value) -> String {
    let bytes = serde_json::to_vec(payload).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

/// `client_request_id` válido: não vazio, até 128 caracteres, sem controles.
pub fn validate_request_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() {
        return Err("client_request_id não pode ficar vazio".into());
    }
    if id.len() > REQUEST_ID_MAX || id.chars().any(char::is_control) {
        return Err("client_request_id deve ter até 128 caracteres sem controles".into());
    }
    Ok(id.to_string())
}

fn db_err(error: rusqlite::Error) -> String {
    error.to_string()
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommandReceipt> {
    let state: String = row.get(7)?;
    Ok(CommandReceipt {
        kind: row.get(0)?,
        caller_key: row.get(1)?,
        request_id: row.get(2)?,
        request_hash: row.get(3)?,
        target_ref: row.get(4)?,
        node_id: row.get(5)?,
        // Um estado que este código não conhece não vira `accepted`: é `unknown`, nunca repetir.
        state: ReceiptState::parse(&state).unwrap_or(ReceiptState::Unknown),
        result_json: row.get(6)?,
        event_sequence: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const COLUMNS: &str = "kind, caller_key, request_id, request_hash, target_ref, node_id, result_json, state, event_sequence, created_at, updated_at";

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .and_then(|mut stmt| stmt.exists([table]))
        .map_err(db_err)
}

/// Lê o recibo na tabela nova e, se não houver, nos dois recibos antigos (contrato §11.6). Ler o antigo
/// não o copia.
pub fn lookup(
    conn: &Connection,
    kind: &str,
    caller_key: &str,
    request_id: &str,
) -> Result<Option<CommandReceipt>, String> {
    let found = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM harness_command_receipt WHERE kind = ?1 AND caller_key = ?2 AND request_id = ?3"),
            params![kind, caller_key, request_id],
            from_row,
        )
        .optional()
        .map_err(db_err)?;
    if found.is_some() {
        return Ok(found);
    }
    legacy_lookup(conn, kind, caller_key, request_id)
}

fn legacy_lookup(
    conn: &Connection,
    kind: &str,
    caller_key: &str,
    request_id: &str,
) -> Result<Option<CommandReceipt>, String> {
    match kind {
        KIND_FLEET_DELEGATE if table_exists(conn, "run_delegation_receipts")? => conn
            .query_row(
                "SELECT request_hash, run_id, task_keys_json, created_at FROM run_delegation_receipts
                 WHERE caller_key = ?1 AND request_id = ?2",
                params![caller_key, request_id],
                |row| {
                    let created: i64 = row.get(3)?;
                    Ok(CommandReceipt {
                        kind: kind.to_string(),
                        caller_key: caller_key.to_string(),
                        request_id: request_id.to_string(),
                        request_hash: row.get(0)?,
                        target_ref: row.get(1)?,
                        node_id: None,
                        // O recibo antigo só existe depois de o run ser criado: já foi aceito.
                        state: ReceiptState::Accepted,
                        result_json: row.get(2)?,
                        event_sequence: None,
                        created_at: created,
                        updated_at: created,
                    })
                },
            )
            .optional()
            .map_err(db_err),
        KIND_CHAT_NEW if table_exists(conn, "chat_child_receipts")? => conn
            .query_row(
                "SELECT request_hash, thread_id, delivery_state, created_at, updated_at FROM chat_child_receipts
                 WHERE caller_key = ?1 AND request_id = ?2",
                params![caller_key, request_id],
                |row| {
                    let state: String = row.get(2)?;
                    Ok(CommandReceipt {
                        kind: kind.to_string(),
                        caller_key: caller_key.to_string(),
                        request_id: request_id.to_string(),
                        request_hash: row.get(0)?,
                        target_ref: row.get(1)?,
                        node_id: None,
                        state: ReceiptState::parse(&state).unwrap_or(ReceiptState::Unknown),
                        result_json: None,
                        event_sequence: None,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(db_err),
        _ => Ok(None),
    }
}

/// Grava a intenção ou devolve o recibo que já existe. Chamar dentro da transação `Immediate` do
/// comando. Hash diferente para o mesmo `(kind, caller_key, request_id)` é [`MISMATCH`].
pub fn begin(
    conn: &Connection,
    identity: &CommandIdentity,
    target_ref: &str,
    now: i64,
) -> Result<Begin, String> {
    if let Some(existing) = lookup(conn, &identity.kind, &identity.caller_key, &identity.request_id)? {
        if existing.request_hash != identity.request_hash {
            return Err(MISMATCH.to_string());
        }
        return Ok(Begin::Existing(existing));
    }
    conn.execute(
        "INSERT INTO harness_command_receipt
         (kind, caller_key, request_id, request_hash, target_ref, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            identity.kind,
            identity.caller_key,
            identity.request_id,
            identity.request_hash,
            target_ref,
            ReceiptState::Prepared.as_str(),
            now
        ],
    )
    .map_err(db_err)?;
    let created = lookup(conn, &identity.kind, &identity.caller_key, &identity.request_id)?
        .ok_or_else(|| "o recibo recém-gravado sumiu".to_string())?;
    Ok(Begin::Created(created))
}

/// Troca o estado só se o atual é um dos esperados (uma resposta tardia não sobrescreve outra tentativa).
pub fn transition(
    conn: &Connection,
    kind: &str,
    caller_key: &str,
    request_id: &str,
    from: &[ReceiptState],
    to: ReceiptState,
    now: i64,
) -> Result<bool, String> {
    let mut changed = false;
    for state in from {
        changed |= conn
            .execute(
                "UPDATE harness_command_receipt SET state = ?5, updated_at = ?6
                 WHERE kind = ?1 AND caller_key = ?2 AND request_id = ?3 AND state = ?4",
                params![kind, caller_key, request_id, state.as_str(), to.as_str(), now],
            )
            .map_err(db_err)?
            > 0;
    }
    Ok(changed)
}

pub fn set_result(
    conn: &Connection,
    identity: &CommandIdentity,
    result_json: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE harness_command_receipt SET result_json = ?4, updated_at = ?5
         WHERE kind = ?1 AND caller_key = ?2 AND request_id = ?3",
        params![identity.kind, identity.caller_key, identity.request_id, result_json, now],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Escrita dupla da delegação (contrato §11.6): o recibo antigo continua sendo a fonte. Idempotente.
pub fn mirror_delegation(
    conn: &Connection,
    caller_key: &str,
    request_id: &str,
    request_hash: &str,
    run_id: &str,
    task_keys_json: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO harness_command_receipt
         (kind, caller_key, request_id, request_hash, target_ref, state, result_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            KIND_FLEET_DELEGATE,
            caller_key,
            request_id,
            request_hash,
            run_id,
            ReceiptState::Accepted.as_str(),
            task_keys_json,
            now
        ],
    )
    .map_err(db_err)?;
    Ok(())
}
