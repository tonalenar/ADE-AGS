//! Fila de efeitos com claim e lease (Fase 2, contrato §11).
//!
//! O efeito é gravado na mesma transação da intenção e executado depois, fora do lock do banco. Quem
//! reclama (`claim`) vira o dono até `lease_until`; dois donos simultâneos não existem, porque a posse
//! é **um único `UPDATE`** (o SQLite serializa as escritas e só quem vê `changes() == 1` é o dono). O
//! `agora` é sempre um parâmetro. O efeito não guarda payload, e o erro guardado é sanitizado.
//!
//! Lease vencido: o dono pode ter morrido antes **ou depois** de o efeito sair. Um efeito que não é
//! `retry_safe` (provider) nunca é repetido às cegas: vira `failed` com `outcome_unknown`, a menos que
//! [`recover_expired`] receba a capability do adapter que prove o desfecho.

use rusqlite::{Connection, OptionalExtension, params};

use super::receipts::{self, CommandIdentity, ReceiptState};

const COLUMNS: &str = "id, kind, dedupe_key, target_ref, state, retry_safe, attempts, max_attempts, lease_owner, lease_until, causation_event_id, outcome_unknown, last_error, created_at, updated_at, receipt_kind, receipt_caller, receipt_request";

/// O texto que fica em `last_error` quando o desfecho não se prova.
const UNKNOWN_CODE: &str = "outcome_unknown";
const EXHAUSTED_CODE: &str = "attempts_exhausted";
const ERROR_MAX_CHARS: usize = 200;
const REDACTED: &str = "[redigido]";

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
        match self {
            EffectState::Pending => "pending",
            EffectState::Running => "running",
            EffectState::Completed => "completed",
            EffectState::Failed => "failed",
            EffectState::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "pending" => EffectState::Pending,
            "running" => EffectState::Running,
            "completed" => EffectState::Completed,
            "failed" => EffectState::Failed,
            "cancelled" => EffectState::Cancelled,
            _ => return None,
        })
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
    /// O recibo que o efeito serve, quando há (`kind`, `caller_key`, `request_id`).
    pub receipt: Option<(String, String, String)>,
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

/// Criada num `migrate()` de módulo (chamado por `harness::store::migrate`). Sem `CHECK` de
/// enumeração e sem coluna de payload: o texto de uma mensagem nunca vai para a fila.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_effect (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            kind               TEXT NOT NULL,
            dedupe_key         TEXT NOT NULL UNIQUE,
            target_ref         TEXT NOT NULL,
            state              TEXT NOT NULL,
            retry_safe         INTEGER NOT NULL,
            attempts           INTEGER NOT NULL DEFAULT 0,
            max_attempts       INTEGER NOT NULL,
            lease_owner        TEXT,
            lease_until        INTEGER,
            causation_event_id INTEGER,
            receipt_kind       TEXT,
            receipt_caller     TEXT,
            receipt_request    TEXT,
            outcome_unknown    INTEGER NOT NULL DEFAULT 0,
            last_error         TEXT,
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_harness_effect_ready ON harness_effect(state, lease_until);",
    )
}

fn db_err(error: rusqlite::Error) -> String {
    error.to_string()
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Effect> {
    let state: String = row.get(4)?;
    let receipt = match (row.get::<_, Option<String>>(15)?, row.get::<_, Option<String>>(16)?, row.get::<_, Option<String>>(17)?) {
        (Some(kind), Some(caller), Some(request)) => Some((kind, caller, request)),
        _ => None,
    };
    Ok(Effect {
        id: row.get(0)?,
        kind: row.get(1)?,
        dedupe_key: row.get(2)?,
        target_ref: row.get(3)?,
        // Um estado desconhecido para este código nunca é tratado como pronto para executar.
        state: EffectState::parse(&state).unwrap_or(EffectState::Failed),
        retry_safe: row.get::<_, i64>(5)? != 0,
        attempts: row.get(6)?,
        max_attempts: row.get(7)?,
        lease_owner: row.get(8)?,
        lease_until: row.get(9)?,
        causation_event_id: row.get(10)?,
        outcome_unknown: row.get::<_, i64>(11)? != 0,
        last_error: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        receipt,
    })
}

/// Duas escritas que valem juntas (o efeito e o recibo ligado). `SAVEPOINT` serve dentro e fora de uma
/// transação do chamador.
fn atomically<T>(conn: &Connection, body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    conn.execute_batch("SAVEPOINT harness_effect_op").map_err(db_err)?;
    match body() {
        Ok(value) => {
            conn.execute_batch("RELEASE harness_effect_op").map_err(db_err)?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO harness_effect_op; RELEASE harness_effect_op");
            Err(error)
        }
    }
}

pub fn enqueue(conn: &Connection, new: &NewEffect, now: i64) -> Result<Enqueued, String> {
    let (receipt_kind, receipt_caller, receipt_request) = match new.receipt {
        Some(id) => (Some(id.kind.as_str()), Some(id.caller_key.as_str()), Some(id.request_id.as_str())),
        None => (None, None, None),
    };
    let created = conn
        .execute(
            "INSERT OR IGNORE INTO harness_effect
             (kind, dedupe_key, target_ref, state, retry_safe, max_attempts, causation_event_id,
              receipt_kind, receipt_caller, receipt_request, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                new.kind,
                new.dedupe_key,
                new.target_ref,
                new.retry_safe as i64,
                new.max_attempts.max(1),
                new.causation_event_id,
                receipt_kind,
                receipt_caller,
                receipt_request,
                now
            ],
        )
        .map_err(db_err)?
        > 0;
    let id = conn
        .query_row("SELECT id FROM harness_effect WHERE dedupe_key = ?1", [new.dedupe_key], |row| row.get(0))
        .map_err(db_err)?;
    Ok(Enqueued { id, created })
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Effect>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM harness_effect WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(db_err)
}

/// Atualiza o recibo que o efeito serve, se houver. Nunca sobrescreve um estado que já não é o esperado.
fn sync_receipt(conn: &Connection, effect: &Effect, from: &[ReceiptState], to: ReceiptState, now: i64) -> Result<(), String> {
    if let Some((kind, caller, request)) = &effect.receipt {
        receipts::transition(conn, kind, caller, request, from, to, now)?;
    }
    Ok(())
}

pub fn claim(conn: &Connection, id: i64, owner: &str, now: i64, lease_ms: i64) -> Result<Claim, String> {
    // A posse é um UPDATE só: `pending`, ou `running` de efeito seguro com o lease vencido.
    let claimed = conn
        .execute(
            "UPDATE harness_effect
             SET state = 'running', lease_owner = ?2, lease_until = ?3, attempts = attempts + 1, updated_at = ?4
             WHERE id = ?1 AND attempts < max_attempts
               AND (state = 'pending' OR (state = 'running' AND retry_safe = 1 AND lease_until <= ?4))",
            params![id, owner, now + lease_ms, now],
        )
        .map_err(db_err)?
        > 0;
    if claimed {
        return get(conn, id)?.map(Claim::Claimed).ok_or_else(|| "o efeito reclamado sumiu".to_string());
    }
    let Some(effect) = get(conn, id)? else { return Ok(Claim::Missing) };
    match effect.state {
        EffectState::Running => {
            let until = effect.lease_until.unwrap_or(0);
            if until > now {
                return Ok(Claim::Held { lease_until: until });
            }
            // Lease vencido que o UPDATE não reclamou: efeito de provider, ou tentativas esgotadas.
            let (code, unknown) = if effect.retry_safe { (EXHAUSTED_CODE, false) } else { (UNKNOWN_CODE, true) };
            let marked = atomically(conn, || {
                let changed = conn
                    .execute(
                        "UPDATE harness_effect
                         SET state = 'failed', outcome_unknown = ?3, last_error = ?4, lease_owner = NULL, lease_until = NULL, updated_at = ?2
                         WHERE id = ?1 AND state = 'running' AND lease_until <= ?2",
                        params![id, now, unknown as i64, code],
                    )
                    .map_err(db_err)?
                    > 0;
                if changed && unknown {
                    sync_receipt(conn, &effect, &[ReceiptState::Prepared, ReceiptState::Submitting], ReceiptState::Unknown, now)?;
                }
                Ok(changed)
            })?;
            let current = get(conn, id)?.ok_or_else(|| "o efeito sumiu".to_string())?;
            if marked && unknown {
                Ok(Claim::Unknown(current))
            } else {
                // Outro processo resolveu antes: devolve o que ele deixou.
                Ok(match current.state {
                    EffectState::Running => Claim::Held { lease_until: current.lease_until.unwrap_or(now) },
                    state => Claim::Done(state),
                })
            }
        }
        state => Ok(Claim::Done(state)),
    }
}

/// Para o worker: reclama o próximo efeito pronto (`pending`, ou `running` de `retry_safe` com lease vencido).
pub fn claim_next(
    conn: &Connection,
    kind: Option<&str>,
    owner: &str,
    now: i64,
    lease_ms: i64,
) -> Result<Option<Effect>, String> {
    let mut after = 0_i64;
    loop {
        let candidate: Option<i64> = conn
            .query_row(
                "SELECT id FROM harness_effect
                 WHERE id > ?1 AND (?2 IS NULL OR kind = ?2) AND attempts < max_attempts
                   AND (state = 'pending' OR (state = 'running' AND retry_safe = 1 AND lease_until <= ?3))
                 ORDER BY id LIMIT 1",
                params![after, kind, now],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(id) = candidate else { return Ok(None) };
        if let Claim::Claimed(effect) = claim(conn, id, owner, now, lease_ms)? {
            return Ok(Some(effect));
        }
        after = id;
    }
}

pub fn extend_lease(conn: &Connection, id: i64, owner: &str, now: i64, lease_ms: i64) -> Result<bool, String> {
    Ok(conn
        .execute(
            "UPDATE harness_effect SET lease_until = ?3, updated_at = ?4
             WHERE id = ?1 AND state = 'running' AND lease_owner = ?2",
            params![id, owner, now + lease_ms, now],
        )
        .map_err(db_err)?
        > 0)
}

/// Conclui. Só o dono, em `running`: o dono antigo de um lease já reclamado ou de um efeito cancelado é recusado.
pub fn complete(conn: &Connection, id: i64, owner: &str, now: i64) -> Result<bool, String> {
    Ok(conn
        .execute(
            "UPDATE harness_effect
             SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?3
             WHERE id = ?1 AND state = 'running' AND lease_owner = ?2",
            params![id, owner, now],
        )
        .map_err(db_err)?
        > 0)
}

/// Falha. Devolve o estado em que o efeito ficou, ou `None` se `owner` já não é o dono.
pub fn fail(
    conn: &Connection,
    id: i64,
    owner: &str,
    now: i64,
    disposition: Disposition,
    error: &str,
) -> Result<Option<EffectState>, String> {
    let error = sanitize_error(error);
    let changed = conn
        .execute(
            "UPDATE harness_effect
             SET state = CASE WHEN ?3 = 0 AND attempts < max_attempts THEN 'pending' ELSE 'failed' END,
                 outcome_unknown = ?4, last_error = ?5, lease_owner = NULL, lease_until = NULL, updated_at = ?6
             WHERE id = ?1 AND state = 'running' AND lease_owner = ?2",
            params![
                id,
                owner,
                (disposition != Disposition::NotApplied) as i64,
                (disposition == Disposition::Unknown) as i64,
                error,
                now
            ],
        )
        .map_err(db_err)?
        > 0;
    if !changed {
        return Ok(None);
    }
    Ok(get(conn, id)?.map(|effect| effect.state))
}

pub fn cancel(conn: &Connection, id: i64, now: i64) -> Result<bool, String> {
    Ok(conn
        .execute(
            "UPDATE harness_effect
             SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?2
             WHERE id = ?1 AND state IN ('pending', 'running')",
            params![id, now],
        )
        .map_err(db_err)?
        > 0)
}

/// Reconcilia os efeitos `running` de lease vencido com a capability do adapter (boot ou worker).
/// Efeito `retry_safe` não precisa de prova: volta a `pending` (ou `failed`, sem tentativas).
pub fn recover_expired(
    conn: &Connection,
    now: i64,
    reconcile: &mut dyn FnMut(&Effect) -> Reconcile,
) -> Result<Recovery, String> {
    let expired: Vec<Effect> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM harness_effect WHERE state = 'running' AND lease_until <= ?1 ORDER BY id"
            ))
            .map_err(db_err)?;
        stmt.query_map([now], from_row).map_err(db_err)?.collect::<Result<_, _>>().map_err(db_err)?
    };
    let mut report = Recovery::default();
    for effect in expired {
        let verdict = if effect.retry_safe { Reconcile::NotApplied } else { reconcile(&effect) };
        let resolved = atomically(conn, || {
            let (sql_state, unknown, code): (&str, bool, Option<&str>) = match verdict {
                Reconcile::Applied => ("completed", false, None),
                Reconcile::NotApplied if effect.attempts < effect.max_attempts => ("pending", false, None),
                Reconcile::NotApplied => ("failed", false, Some(EXHAUSTED_CODE)),
                Reconcile::Unknown => ("failed", true, Some(UNKNOWN_CODE)),
            };
            let changed = conn
                .execute(
                    "UPDATE harness_effect
                     SET state = ?2, outcome_unknown = ?3, last_error = ?4, lease_owner = NULL, lease_until = NULL, updated_at = ?5
                     WHERE id = ?1 AND state = 'running' AND lease_until <= ?5",
                    params![effect.id, sql_state, unknown as i64, code, now],
                )
                .map_err(db_err)?
                > 0;
            if changed {
                match (verdict, sql_state) {
                    (Reconcile::Applied, _) => {
                        sync_receipt(conn, &effect, &[ReceiptState::Prepared, ReceiptState::Submitting], ReceiptState::Accepted, now)?
                    }
                    (Reconcile::Unknown, _) => {
                        sync_receipt(conn, &effect, &[ReceiptState::Prepared, ReceiptState::Submitting], ReceiptState::Unknown, now)?
                    }
                    (Reconcile::NotApplied, _) => {
                        sync_receipt(conn, &effect, &[ReceiptState::Submitting], ReceiptState::Retryable, now)?
                    }
                }
            }
            Ok(changed)
        })?;
        if resolved {
            match verdict {
                Reconcile::Applied => report.completed.push(effect.id),
                Reconcile::NotApplied => report.requeued.push(effect.id),
                Reconcile::Unknown => report.unknown.push(effect.id),
            }
        }
    }
    Ok(report)
}

fn looks_secret(token: &str, previous: Option<&str>) -> bool {
    let lower = token.to_ascii_lowercase();
    const PREFIXES: [&str; 8] = ["sk-", "ghp_", "gho_", "ghs_", "github_pat_", "xox", "akia", "eyj"];
    if PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    if let Some((key, _)) = token.split_once(['=', ':'])
        && !key.is_empty()
    {
        let key = key.to_ascii_lowercase();
        const KEYS: [&str; 8] = ["token", "key", "secret", "password", "passwd", "senha", "auth", "credential"];
        if KEYS.iter().any(|k| key.contains(k)) {
            return true;
        }
    }
    if previous.is_some_and(|p| matches!(p.to_ascii_lowercase().as_str(), "bearer" | "basic")) {
        return true;
    }
    token.len() >= 32 && token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '=' | '_' | '-'))
}

/// Uma linha, até 200 caracteres, sem controles e sem aparência de segredo.
pub fn sanitize_error(raw: &str) -> String {
    let flat: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut out: Vec<&str> = Vec::new();
    let mut previous: Option<&str> = None;
    for token in flat.split_whitespace() {
        out.push(if looks_secret(token, previous) { REDACTED } else { token });
        previous = Some(token);
    }
    out.join(" ").chars().take(ERROR_MAX_CHARS).collect()
}
