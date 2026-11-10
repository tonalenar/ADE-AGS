//! Fila de efeitos com claim e lease (Fase 2, contrato §11).
//!
//! O efeito é gravado na mesma transação da intenção e executado depois, fora do lock do banco. Quem
//! reclama (`claim`) vira o dono até `lease_until`; dois donos simultâneos não existem. O `agora` é
//! sempre um parâmetro. O efeito não guarda payload, e o erro guardado é sanitizado.

use rusqlite::Connection;

use super::receipts::CommandIdentity;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl EffectState {
    pub fn as_str(self) -> &'static str {
        unimplemented!()
    }
    pub fn parse(_raw: &str) -> Option<Self> {
        unimplemented!()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effect {
    pub id: i64,
    pub kind: String,
    pub dedupe_key: String,
    pub target_ref: String,
    pub state: EffectState,
    pub retry_safe: bool,
    pub attempts: i64,
    pub max_attempts: i64,
    pub lease_owner: Option<String>,
    pub lease_until: Option<i64>,
    pub causation_event_id: Option<i64>,
    pub outcome_unknown: bool,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct NewEffect<'a> {
    pub kind: &'a str,
    pub dedupe_key: &'a str,
    pub target_ref: &'a str,
    pub retry_safe: bool,
    pub max_attempts: i64,
    pub causation_event_id: Option<i64>,
    /// O recibo que o efeito serve: o `unknown` por lease vencido também o atualiza.
    pub receipt: Option<&'a CommandIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enqueued {
    pub id: i64,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    Claimed(Effect),
    /// Outro dono tem o lease, ainda válido.
    Held { lease_until: i64 },
    /// O efeito já acabou (`completed`, `failed` ou `cancelled`).
    Done(EffectState),
    /// O lease venceu num efeito que não se repete às cegas: virou `failed` com desfecho desconhecido.
    Unknown(Effect),
    Missing,
}

/// O que `fail` quer dizer do efeito.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Certamente não saiu: volta a `pending` enquanto houver tentativa.
    NotApplied,
    /// Falhou de vez.
    Permanent,
    /// Pode ter saído: `failed` com `outcome_unknown`.
    Unknown,
}

/// O que a capability do adapter prova de um efeito de lease vencido.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reconcile {
    Applied,
    NotApplied,
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    pub completed: Vec<i64>,
    pub requeued: Vec<i64>,
    pub unknown: Vec<i64>,
}

pub(crate) fn migrate(_conn: &Connection) -> rusqlite::Result<()> {
    unimplemented!()
}

pub fn enqueue(_conn: &Connection, _new: &NewEffect, _now: i64) -> Result<Enqueued, String> {
    unimplemented!()
}

pub fn get(_conn: &Connection, _id: i64) -> Result<Option<Effect>, String> {
    unimplemented!()
}

pub fn claim(_conn: &Connection, _id: i64, _owner: &str, _now: i64, _lease_ms: i64) -> Result<Claim, String> {
    unimplemented!()
}

/// Para o worker: reclama o próximo efeito pronto (`pending`, ou `running` de `retry_safe` com lease vencido).
pub fn claim_next(
    _conn: &Connection,
    _kind: Option<&str>,
    _owner: &str,
    _now: i64,
    _lease_ms: i64,
) -> Result<Option<Effect>, String> {
    unimplemented!()
}

pub fn extend_lease(_conn: &Connection, _id: i64, _owner: &str, _now: i64, _lease_ms: i64) -> Result<bool, String> {
    unimplemented!()
}

/// Conclui. Só o dono, em `running`: o dono antigo de um lease já reclamado ou de um efeito cancelado é recusado.
pub fn complete(_conn: &Connection, _id: i64, _owner: &str, _now: i64) -> Result<bool, String> {
    unimplemented!()
}

/// Falha. Devolve o estado em que o efeito ficou, ou `None` se `owner` já não é o dono.
pub fn fail(
    _conn: &Connection,
    _id: i64,
    _owner: &str,
    _now: i64,
    _disposition: Disposition,
    _error: &str,
) -> Result<Option<EffectState>, String> {
    unimplemented!()
}

pub fn cancel(_conn: &Connection, _id: i64, _now: i64) -> Result<bool, String> {
    unimplemented!()
}

/// Reconcilia os efeitos `running` de lease vencido com a capability do adapter (boot ou worker).
pub fn recover_expired(
    _conn: &Connection,
    _now: i64,
    _reconcile: &mut dyn FnMut(&Effect) -> Reconcile,
) -> Result<Recovery, String> {
    unimplemented!()
}

/// Uma linha, até 200 caracteres, sem controles e sem aparência de segredo.
pub fn sanitize_error(_raw: &str) -> String {
    unimplemented!()
}
