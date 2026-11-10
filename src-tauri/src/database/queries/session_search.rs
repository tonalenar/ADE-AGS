//! Busca sob demanda em mensagens TUI arquivadas. O texto do transcript fica só em memória.

use crate::database::{ArchivedMessageSearchHit, ArchivedMessageTurn, DbConnection};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

const INDEX_BATCH_SIZE: usize = 8;
const MAX_BATCHES_PER_QUERY: usize = 3;
const MAX_OPENCODE_EXPORTS_PER_CYCLE: usize = 1;
const TURN_MAX_CHARS: usize = 16_000;
const MEMORY_INDEX_MAX_BYTES: i64 = 64 * 1024 * 1024;
const SEARCH_DEFAULT_LIMIT: usize = 20;
const SEARCH_MAX_LIMIT: usize = 50;
const SEARCH_HIDDEN_SCAN_MULTIPLIER: usize = 10;
const SEARCH_HIDDEN_SCAN_MIN: usize = 50;
const INDEX_VERSION: i64 = 3;

static ARCHIVED_TRANSCRIPT_INDEXER_RUNNING: AtomicBool = AtomicBool::new(false);
static INDEXER_RUN_ID: OnceLock<String> = OnceLock::new();
static MEMORY_INDEX: OnceLock<Result<Mutex<Connection>, String>> = OnceLock::new();

struct Candidate {
    history_id: String,
    workspace_id: String,
    agent_id: String,
    cwd: String,
    session_id: String,
    account_id: Option<String>,
    closed_at: i64,
}

struct RawHit {
    history_id: String,
    closed_at: i64,
    turn_index: i64,
    source_id: Option<String>,
    kind: String,
    excerpt: String,
    partial: bool,
    turn_truncated: bool,
}

fn indexer_run_id() -> &'static str {
    INDEXER_RUN_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn memory_index() -> Result<&'static Mutex<Connection>, String> {
    MEMORY_INDEX
        .get_or_init(|| {
            let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
            conn.execute_batch(
                "PRAGMA temp_store = MEMORY;
                 CREATE VIRTUAL TABLE archived_transcript_fts USING fts5(
                    history_id UNINDEXED, workspace_id UNINDEXED, closed_at UNINDEXED,
                    turn_index UNINDEXED, source_id UNINDEXED, kind UNINDEXED,
                    partial UNINDEXED, turn_truncated UNINDEXED, text,
                    tokenize = 'unicode61 remove_diacritics 2'
                 );",
            )
            .map_err(|error| error.to_string())?;
            Ok(Mutex::new(conn))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Busca mensagens arquivadas no workspace atual e inicia a indexação de alguns arquivos.
/// O FTS é efêmero: nenhuma fala é copiada para o SQLite persistente.
#[tauri::command]
pub async fn db_search_archived_session_messages(
    app: AppHandle,
    workspace_id: Option<String>,
    query: String,
    limit: Option<usize>,
    db: State<'_, DbConnection>,
) -> Result<Vec<ArchivedMessageSearchHit>, String> {
    let Some(workspace_id) = workspace_id.filter(|id| !id.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let query = query.trim().chars().take(160).collect::<String>();
    let fts_query = make_fts_query(&query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let db = db.inner().clone();
    start_index_batch(app, db.clone(), workspace_id.clone());
    let limit = limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        search_archived_messages(&db, &workspace_id, &fts_query, limit)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Lê o arquivo original só depois que a pessoa abre um resultado. A prévia da lista nunca
/// carrega o corpo inteiro da mensagem nem o envia junto com a pesquisa.
#[tauri::command]
pub async fn db_get_archived_session_turn(
    workspace_id: String,
    history_id: String,
    turn_index: i64,
    source_id: Option<String>,
    db: State<'_, DbConnection>,
) -> Result<ArchivedMessageTurn, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        load_archived_turn(
            &db,
            &workspace_id,
            &history_id,
            turn_index,
            source_id.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn start_index_batch(app: AppHandle, db: DbConnection, workspace_id: String) {
    if ARCHIVED_TRANSCRIPT_INDEXER_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut indexed = 0;
        let mut opencode_exports_left = MAX_OPENCODE_EXPORTS_PER_CYCLE;
        for _ in 0..MAX_BATCHES_PER_QUERY {
            match index_pending_batch(&db, &workspace_id, &mut opencode_exports_left) {
                Ok(count) if count > 0 => indexed += count,
                _ => break,
            }
        }
        ARCHIVED_TRANSCRIPT_INDEXER_RUNNING.store(false, Ordering::Release);
        if indexed > 0 {
            let _ = app.emit("cc-archived-transcript-indexed", indexed);
        }
    });
}

fn index_pending_batch(
    db: &DbConnection,
    workspace_id: &str,
    opencode_exports_left: &mut usize,
) -> Result<usize, String> {
    let run_id = indexer_run_id();
    let now = now_seconds();
    let candidates = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(
                "SELECT h.id, h.workspace_id, h.agent_id, h.cwd,
                        h.session_id, h.account_id, h.closed_at
                 FROM session_history h
                 LEFT JOIN session_transcript_index_state s ON s.history_id = h.id
                 WHERE h.workspace_id = ?1
                   AND h.agent_id IN ('claude-code', 'codex', 'gemini-cli', 'hermes', 'kimi-code', 'opencode')
                   AND (h.agent_id != 'opencode' OR ?6 > 0)
                   AND h.session_id IS NOT NULL
                   AND COALESCE(h.hidden, 0) = 0
                   AND (
                     s.history_id IS NULL OR s.index_version != ?2
                     OR s.indexed_closed_at < h.closed_at OR s.loaded_run_id != ?3
                     OR (s.status = 'unavailable' AND s.retry_after <= ?4)
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM tabs t
                       JOIN windows w ON w.id = t.window_id
                       WHERE w.is_open = 1 AND w.workspace_id = h.workspace_id
                         AND (t.session_id = h.session_id OR t.history_id = h.id)
                   )
                 ORDER BY h.closed_at DESC LIMIT ?5",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    workspace_id,
                    INDEX_VERSION,
                    run_id,
                    now,
                    INDEX_BATCH_SIZE as i64,
                    *opencode_exports_left as i64,
                ],
                |row| {
                    Ok(Candidate {
                        history_id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        agent_id: row.get(2)?,
                        cwd: row.get(3)?,
                        session_id: row.get(4)?,
                        account_id: row.get(5)?,
                        closed_at: row.get(6)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    let mut indexed = 0;
    for candidate in candidates {
        if candidate.agent_id == "opencode" {
            if *opencode_exports_left == 0 {
                continue;
            }
            *opencode_exports_left -= 1;
        }
        if index_candidate(db, candidate).unwrap_or(false) {
            indexed += 1;
        }
    }
    Ok(indexed)
}

fn index_candidate(db: &DbConnection, candidate: Candidate) -> Result<bool, String> {
    let profile = candidate
        .account_id
        .as_deref()
        .and_then(|account_id| crate::accounts::dir_for(db, account_id));
    let opencode_profile_valid = candidate.agent_id != "opencode"
        || match candidate.account_id.as_deref() {
            Some(account_id) => {
                crate::accounts::agent_id_for_account(db, account_id).as_deref() == Some("opencode")
                    && profile.is_some()
            }
            None => true,
        };
    let (turns, partial, status) = if candidate.agent_id == "opencode" {
        if !opencode_profile_valid {
            (Vec::new(), false, "unavailable")
        } else {
            match crate::session::opencode_transcript_for_search(
                &candidate.session_id,
                profile.as_deref().map(std::path::Path::new),
                &candidate.cwd,
            ) {
                Ok((turns, partial)) => {
                    let status = if turns.is_empty() { "empty" } else { "indexed" };
                    (turns, partial, status)
                }
                Err(_) => (Vec::new(), false, "unavailable"),
            }
        }
    } else if candidate.agent_id == "hermes" {
        match crate::session::extract_hermes_transcript_for_search(
            &candidate.session_id,
            &candidate.cwd,
            None,
        ) {
            Ok((turns, partial)) => {
                let status = if turns.is_empty() { "empty" } else { "indexed" };
                (turns, partial, status)
            }
            Err(_) => (Vec::new(), false, "unavailable"),
        }
    } else if candidate.agent_id == "kimi-code" {
        match crate::session::extract_kimi_transcript_for_search(
            &candidate.session_id,
            &candidate.cwd,
            None,
        ) {
            Ok((turns, partial)) => {
                let status = if turns.is_empty() { "empty" } else { "indexed" };
                (turns, partial, status)
            }
            Err(_) => (Vec::new(), false, "unavailable"),
        }
    } else {
        let path = crate::session::session_file_for_db(
            &candidate.agent_id,
            &candidate.cwd,
            Some(&candidate.session_id),
            profile.as_deref().map(std::path::Path::new),
            db,
        );
        match path {
            Some(path)
                if candidate.agent_id == "gemini-cli"
                    && !crate::session::gemini_is_main_session(&path) =>
            {
                (Vec::new(), false, "empty")
            }
            Some(path) => match crate::session::extract_transcript_for_search(&path) {
                Ok((turns, partial)) => {
                    let status = if turns.is_empty() { "empty" } else { "indexed" };
                    (turns, partial, status)
                }
                Err(_) => (Vec::new(), false, "unavailable"),
            },
            None => (Vec::new(), false, "unavailable"),
        }
    };
    let retry_after = if status == "unavailable" {
        now_seconds().saturating_add(60)
    } else {
        0
    };

    // O texto é montado antes de pegar os locks; o banco fica livre durante qualquer leitura
    // de arquivo, e só há uma inserção curta na transação.
    let index_turns = turns
        .iter()
        .enumerate()
        .filter(|(_, turn)| turn.role == "user" || turn.role == "assistant")
        .filter_map(|(turn_index, turn)| {
            let (text, truncated) = truncate_chars(&turn.text, TURN_MAX_CHARS);
            (!text.trim().is_empty()).then_some((
                turn.source_index.unwrap_or(turn_index as i64),
                turn.source_id.as_deref(),
                turn.role.as_str(),
                text,
                truncated || turn.truncated,
            ))
        })
        .collect::<Vec<_>>();

    let mut db_conn = db.lock().map_err(|error| error.to_string())?;
    let transaction = db_conn.transaction().map_err(|error| error.to_string())?;
    let history_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_history WHERE id = ?1 AND workspace_id = ?2
                           AND session_id = ?3 AND closed_at = ?4 AND COALESCE(hidden, 0) = 0
                           AND NOT EXISTS (
                               SELECT 1 FROM tabs t
                               JOIN windows w ON w.id = t.window_id
                               WHERE w.is_open = 1 AND w.workspace_id = ?2
                                 AND (t.session_id = ?3 OR t.history_id = ?1)
                           ))",
            params![
                candidate.history_id,
                candidate.workspace_id,
                candidate.session_id,
                candidate.closed_at
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !history_exists {
        return Ok(false);
    }

    let index = memory_index()?;
    let mut memory_conn = index.lock().map_err(|error| error.to_string())?;
    let memory_transaction = memory_conn
        .transaction()
        .map_err(|error| error.to_string())?;
    memory_transaction
        .execute(
            "DELETE FROM archived_transcript_fts WHERE history_id = ?1",
            [&candidate.history_id],
        )
        .map_err(|error| error.to_string())?;
    if status == "indexed" {
        let mut statement = memory_transaction
            .prepare(
                "INSERT INTO archived_transcript_fts
                 (history_id, workspace_id, closed_at, turn_index, source_id,
                  kind, partial, turn_truncated, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|error| error.to_string())?;
        for (turn_index, source_id, kind, text, truncated) in &index_turns {
            statement
                .execute(params![
                    candidate.history_id,
                    candidate.workspace_id,
                    candidate.closed_at,
                    turn_index,
                    source_id,
                    kind,
                    if partial { 1_i64 } else { 0_i64 },
                    if *truncated { 1_i64 } else { 0_i64 },
                    text,
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    prune_memory_index(&memory_transaction)?;
    memory_transaction
        .commit()
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO session_transcript_index_state
             (history_id, indexed_closed_at, index_version, loaded_run_id, status, partial, retry_after)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(history_id) DO UPDATE SET
               indexed_closed_at = excluded.indexed_closed_at,
               index_version = excluded.index_version,
               loaded_run_id = excluded.loaded_run_id,
               status = excluded.status,
               partial = excluded.partial,
               retry_after = excluded.retry_after",
            params![
                candidate.history_id,
                candidate.closed_at,
                INDEX_VERSION,
                indexer_run_id(),
                status,
                if partial { 1_i64 } else { 0_i64 },
                retry_after,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn prune_memory_index(conn: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let mut total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM archived_transcript_fts",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    while total > MEMORY_INDEX_MAX_BYTES {
        let oldest: Option<String> = conn
            .query_row(
                "SELECT history_id FROM archived_transcript_fts
                 GROUP BY history_id ORDER BY MAX(CAST(closed_at AS INTEGER)) ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(oldest) = oldest else { break };
        conn.execute(
            "DELETE FROM archived_transcript_fts WHERE history_id = ?1",
            [&oldest],
        )
        .map_err(|error| error.to_string())?;
        total = conn
            .query_row(
                "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM archived_transcript_fts",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn search_archived_messages(
    db: &DbConnection,
    workspace_id: &str,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<ArchivedMessageSearchHit>, String> {
    let index = memory_index()?;
    let scan_limit = limit
        .saturating_mul(SEARCH_HIDDEN_SCAN_MULTIPLIER)
        .max(SEARCH_HIDDEN_SCAN_MIN)
        .min(SEARCH_MAX_LIMIT * SEARCH_HIDDEN_SCAN_MULTIPLIER);
    let raw_hits = {
        let conn = index.lock().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(
                "SELECT history_id, CAST(closed_at AS INTEGER), turn_index, source_id, kind,
                        snippet(archived_transcript_fts, 8, '‹', '›', ' … ', 28),
                        CAST(partial AS INTEGER), CAST(turn_truncated AS INTEGER)
                 FROM archived_transcript_fts
                 WHERE archived_transcript_fts MATCH ?1 AND workspace_id = ?2
                 ORDER BY bm25(archived_transcript_fts), CAST(closed_at AS INTEGER) DESC
                 LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![fts_query, workspace_id, scan_limit as i64], |row| {
                Ok(RawHit {
                    history_id: row.get(0)?,
                    closed_at: row.get(1)?,
                    turn_index: row.get(2)?,
                    source_id: row.get(3)?,
                    kind: row.get(4)?,
                    excerpt: row.get(5)?,
                    partial: row.get::<_, i64>(6)? != 0,
                    turn_truncated: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    let conn = db.lock().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT COALESCE(NULLIF(h.custom_title, ''), h.title, h.agent_label),
                    h.agent_id, h.agent_label, h.cwd, h.closed_at
             FROM session_history h
             WHERE h.id = ?1 AND h.workspace_id = ?2 AND h.closed_at = ?3
               AND COALESCE(h.hidden, 0) = 0
               AND NOT EXISTS (
                   SELECT 1 FROM tabs t
                   JOIN windows w ON w.id = t.window_id
                   WHERE w.is_open = 1 AND w.workspace_id = h.workspace_id
                     AND (t.session_id = h.session_id OR t.history_id = h.id)
               )",
        )
        .map_err(|error| error.to_string())?;
    let mut hits = Vec::with_capacity(raw_hits.len());
    for hit in raw_hits {
        let metadata = statement
            .query_row(
                params![hit.history_id, workspace_id, hit.closed_at],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((title, agent_id, agent_label, cwd, closed_at)) = metadata else {
            continue;
        };
        hits.push(ArchivedMessageSearchHit {
            history_id: hit.history_id,
            title,
            agent_id,
            agent_label,
            cwd,
            closed_at,
            turn_index: hit.turn_index,
            source_id: hit.source_id,
            kind: hit.kind,
            excerpt: hit.excerpt,
            partial: hit.partial,
            turn_truncated: hit.turn_truncated,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn load_archived_turn(
    db: &DbConnection,
    workspace_id: &str,
    history_id: &str,
    turn_index: i64,
    source_id: Option<&str>,
) -> Result<ArchivedMessageTurn, String> {
    if turn_index < 0 {
        return Err("A fala selecionada não é válida".into());
    }
    let (session_id, account_id, title, agent_id, agent_label, cwd, closed_at, indexed_partial) = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT h.session_id, h.account_id,
                    COALESCE(NULLIF(custom_title, ''), title, agent_label),
                    h.agent_id, h.agent_label, h.cwd, h.closed_at, COALESCE(s.partial, 0)
             FROM session_history h
             LEFT JOIN session_transcript_index_state s ON s.history_id = h.id
             WHERE h.id = ?1 AND h.workspace_id = ?2 AND COALESCE(h.hidden, 0) = 0
               AND s.indexed_closed_at = h.closed_at AND s.index_version = ?3
               AND NOT EXISTS (
                   SELECT 1 FROM tabs t
                   JOIN windows w ON w.id = t.window_id
                   WHERE w.is_open = 1 AND w.workspace_id = h.workspace_id
                     AND (t.session_id = h.session_id OR t.history_id = h.id)
               )",
            params![history_id, workspace_id, INDEX_VERSION],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)? != 0,
                ))
            },
        )
        .map_err(|error| error.to_string())?
    };
    let session_id =
        session_id.ok_or_else(|| "A sessão arquivada não tem um ID recuperável".to_string())?;
    let profile = account_id
        .as_deref()
        .and_then(|account_id| crate::accounts::dir_for(db, account_id));
    if agent_id == "opencode"
        && let Some(account_id) = account_id.as_deref()
        && (crate::accounts::agent_id_for_account(db, account_id).as_deref() != Some("opencode")
            || profile.is_none())
    {
        return Err("O perfil OpenCode desta conversa não está mais disponível".into());
    }
    let (turn, partial, text, turn_truncated) = if agent_id == "hermes" {
        let (mut turns, partial) = crate::session::extract_hermes_transcript_for_search(
            &session_id,
            &cwd,
            Some(turn_index),
        )?;
        let turn = turns
            .pop()
            .filter(|turn| turn.role == "user" || turn.role == "assistant")
            .ok_or_else(|| "A fala do Hermes não está mais disponível".to_string())?;
        let (text, truncated) = truncate_chars(&turn.text, TURN_MAX_CHARS);
        let source_truncated = turn.truncated;
        (turn, partial, text, truncated || source_truncated)
    } else if agent_id == "opencode" {
        let source_id = source_id
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or_else(|| "A fala OpenCode não tem um ID estável para reabertura".to_string())?;
        let (turns, partial) = crate::session::opencode_transcript_for_search(
            &session_id,
            profile.as_deref().map(std::path::Path::new),
            &cwd,
        )?;
        let turn = turns
            .into_iter()
            .find(|turn| turn.source_id.as_deref() == Some(source_id))
            .filter(|turn| turn.role == "user" || turn.role == "assistant")
            .ok_or_else(|| "A fala OpenCode não está mais disponível".to_string())?;
        let (text, truncated) = truncate_chars(&turn.text, TURN_MAX_CHARS);
        let source_truncated = turn.truncated;
        (turn, partial, text, truncated || source_truncated)
    } else if agent_id == "kimi-code" {
        let source_id = source_id
            .filter(|id| !id.is_empty() && id.len() <= 128 && id.starts_with("kimi:"))
            .ok_or_else(|| "A fala Kimi não tem um ID estável para reabertura".to_string())?;
        let (turns, partial) = crate::session::extract_kimi_transcript_for_search(
            &session_id,
            &cwd,
            Some(source_id),
        )?;
        let turn = turns
            .into_iter()
            .find(|turn| turn.source_id.as_deref() == Some(source_id))
            .filter(|turn| turn.role == "user" || turn.role == "assistant")
            .ok_or_else(|| "A fala Kimi não está mais disponível".to_string())?;
        let (text, truncated) = truncate_chars(&turn.text, TURN_MAX_CHARS);
        let source_truncated = turn.truncated;
        (turn, partial, text, truncated || source_truncated)
    } else {
        let path = crate::session::session_file_for_db(
            &agent_id,
            &cwd,
            Some(&session_id),
            profile.as_deref().map(std::path::Path::new),
            db,
        )
        .ok_or_else(|| "O arquivo original desta sessão não foi encontrado".to_string())?;
        if agent_id == "gemini-cli" && !crate::session::gemini_is_main_session(&path) {
            return Err(
                "A sessão arquivada é um subagente do Gemini, não uma conversa principal".into(),
            );
        }
        let (turns, partial) = crate::session::extract_transcript_for_search(&path)
            .map_err(|_| "Não foi possível ler o arquivo original desta sessão".to_string())?;
        let turn = turns
            .get(turn_index as usize)
            .filter(|turn| turn.role == "user" || turn.role == "assistant")
            .ok_or_else(|| "A fala não está mais disponível no arquivo original".to_string())?;
        let (text, truncated) = truncate_chars(&turn.text, TURN_MAX_CHARS);
        let source_truncated = turn.truncated;
        (turn.clone(), partial, text, truncated || source_truncated)
    };
    Ok(ArchivedMessageTurn {
        history_id: history_id.to_string(),
        workspace_id: workspace_id.to_string(),
        title,
        agent_id,
        agent_label,
        cwd,
        closed_at,
        turn_index,
        source_id: turn.source_id.clone(),
        kind: turn.role.clone(),
        text,
        partial: partial || indexed_partial,
        turn_truncated,
    })
}

pub(crate) fn forget_archived_message_index(history_id: &str) {
    let Ok(index) = memory_index() else { return };
    let Ok(conn) = index.lock() else { return };
    let _ = conn.execute(
        "DELETE FROM archived_transcript_fts WHERE history_id = ?1",
        [history_id],
    );
}

/// Invalida o cursor da indexação e remove o texto volátil quando o histórico muda de
/// visibilidade. Desocultar permite que a próxima consulta volte a indexar a sessão.
pub(crate) fn invalidate_archived_message_index(
    conn: &Connection,
    history_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE session_transcript_index_state SET loaded_run_id = '' WHERE history_id = ?1",
        [history_id],
    )
    .map_err(|error| error.to_string())?;
    forget_archived_message_index(history_id);
    Ok(())
}

fn make_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    let mut chars = text.chars();
    let bounded: String = chars.by_ref().take(max).collect();
    (bounded, chars.next().is_some())
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}
