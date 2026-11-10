//! Log semântico do harness compartilhado por conversas estruturadas e pela Frota.
//!
//! A timeline (`chat_item`) e os JSONL dos providers continuam guardando conteúdo e frames.
//! Este log guarda a ordem das transições úteis à orquestração, com referências aos registros
//! de origem, sem duplicar mensagens, saídas de ferramentas ou frames crus.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{OnceLock, mpsc};
use tauri::Emitter;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEvent {
    pub sequence: i64,
    pub node_id: String,
    pub parent_node_id: Option<String>,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub kind: String,
    pub entity_id: Option<String>,
    pub payload: Value,
    pub created_at: i64,
}

struct EventDraft<'a> {
    thread_id: &'a str,
    parent_node_id: Option<&'a str>,
    turn_id: Option<&'a str>,
    run_id: Option<&'a str>,
    task_id: Option<&'a str>,
    attempt_id: Option<&'a str>,
    kind: &'a str,
    entity_id: Option<&'a str>,
    dedupe_key: &'a str,
    payload: Value,
    created_at: i64,
}

enum QueuedEvent {
    Chat {
        app: tauri::AppHandle,
        db: crate::database::DbConnection,
        thread_id: String,
        event_type: String,
        payload: Value,
    },
    Fleet {
        app: tauri::AppHandle,
        db: crate::database::DbConnection,
        task_id: String,
        attempt_id: String,
        event: super::types::AgentEvent,
    },
}

static WRITER: OnceLock<mpsc::Sender<QueuedEvent>> = OnceLock::new();

fn writer() -> &'static mpsc::Sender<QueuedEvent> {
    WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<QueuedEvent>();
        let _ = std::thread::Builder::new()
            .name("ags-harness-event-log".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    let (app, result) = match event {
                        QueuedEvent::Chat {
                            app,
                            db,
                            thread_id,
                            event_type,
                            payload,
                        } => {
                            let result = db
                                .lock()
                                .map_err(|error| error.to_string())
                                .and_then(|conn| {
                                    record_chat_event(&conn, &thread_id, &event_type, &payload)
                                        .map_err(|error| error.to_string())
                                })
                                .map(|()| {
                                    let mut affected = vec![thread_id];
                                    if event_type == "created" {
                                        if let Some(parent) = payload
                                            .get("thread")
                                            .and_then(|thread| thread.get("parentRef"))
                                            .and_then(Value::as_str)
                                            .and_then(|parent| parent.strip_prefix("thread:"))
                                        {
                                            affected.push(parent.to_string());
                                        }
                                    }
                                    affected
                                });
                            (app, result)
                        }
                        QueuedEvent::Fleet {
                            app,
                            db,
                            task_id,
                            attempt_id,
                            event,
                        } => {
                            let result = db
                                .lock()
                                .map_err(|error| error.to_string())
                                .and_then(|conn| {
                                    record_fleet_event(&conn, &task_id, &attempt_id, &event)
                                        .map_err(|error| error.to_string())
                                })
                                .map(|thread_id| thread_id.into_iter().collect());
                            (app, result)
                        }
                    };
                    match result {
                        Ok(thread_ids) => {
                            for thread_id in thread_ids {
                                let _ = app.emit("cc-harness-event", thread_id);
                            }
                        }
                        Err(error) => {
                            eprintln!("[harness] evento semântico não persistido: {error}")
                        }
                    }
                }
            });
        sender
    })
}

/// Enfileira fora do adapter: a gravação pode aguardar o lock curto do SQLite sem bloquear
/// emissão de UI nem correr o risco de um adapter segurar o mesmo lock.
pub(crate) fn queue_chat_event(
    app: &tauri::AppHandle,
    db: crate::database::DbConnection,
    thread_id: String,
    event_type: String,
    payload: Value,
) {
    let payload = compact_chat_payload(&event_type, &payload);
    let _ = writer().send(QueuedEvent::Chat {
        app: app.clone(),
        db,
        thread_id,
        event_type,
        payload,
    });
}

pub(crate) fn queue_fleet_event(
    app: &tauri::AppHandle,
    db: crate::database::DbConnection,
    task_id: String,
    attempt_id: String,
    event: super::types::AgentEvent,
) {
    if matches!(
        &event,
        super::types::AgentEvent::Text { .. }
            | super::types::AgentEvent::Quota { .. }
            | super::types::AgentEvent::Finished { .. }
    ) {
        return;
    }
    let _ = writer().send(QueuedEvent::Fleet {
        app: app.clone(),
        db,
        task_id,
        attempt_id,
        event,
    });
}

fn pick(value: &Value, keys: &[&str]) -> Value {
    let mut picked = serde_json::Map::new();
    for key in keys {
        if let Some(value) = value.get(*key) {
            picked.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(picked)
}

/// Evita que a fila mantenha mensagens, saídas de ferramentas ou frames completos em memória.
fn compact_chat_payload(event_type: &str, payload: &Value) -> Value {
    match event_type {
        "created" => {
            let thread = payload.get("thread").unwrap_or(payload);
            json!({ "thread": pick(thread, &["id", "agentId", "title", "parentRef", "parentTurnId"]) })
        }
        "phase" => pick(payload, &["phase", "turnId"]),
        "item" => {
            let Some(item) = payload.get("item") else {
                return json!({});
            };
            let mut compact = pick(
                item,
                &[
                    "id",
                    "kind",
                    "name",
                    "tool",
                    "label",
                    "path",
                    "status",
                    "interrupted",
                    "durationMs",
                    "tokens",
                    "contextTokens",
                ],
            );
            if let Some(object) = compact.as_object_mut() {
                object.insert(
                    "hasText".into(),
                    Value::Bool(item.get("text").is_some_and(|value| !value.is_null())),
                );
            }
            json!({ "item": compact })
        }
        "request" => {
            json!({ "request": pick(payload.get("request").unwrap_or(payload), &["id", "kind", "title"]) })
        }
        "requestResolved" => pick(payload, &["id"]),
        "task" => {
            json!({ "task": pick(payload.get("task").unwrap_or(payload), &["id", "title", "status"]) })
        }
        "taskItem" => json!({
            "parentToolUseId": payload.get("parentToolUseId").cloned(),
            "item": pick(payload.get("item").unwrap_or(payload), &["id", "kind", "status"]),
        }),
        "goal" => {
            let goal = payload.get("goal").unwrap_or(payload);
            json!({ "goal": pick(goal, &["status"]) })
        }
        "error" => {
            json!({ "hasMessage": payload.get("message").is_some_and(|value| !value.is_null()) })
        }
        _ => json!({}),
    }
}

/// Tabela criada depois de `chat_thread`, para a FK preservar o histórico junto da conversa.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_execution_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            parent_node_id TEXT,
            turn_id TEXT,
            run_id TEXT,
            task_id TEXT,
            attempt_id TEXT,
            kind TEXT NOT NULL,
            entity_id TEXT,
            dedupe_key TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            UNIQUE(thread_id, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_harness_events_thread_sequence
            ON harness_execution_events(thread_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_harness_events_run_sequence
            ON harness_execution_events(run_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_harness_events_task_sequence
            ON harness_execution_events(task_id, sequence);",
    )?;

    // `CREATE TABLE IF NOT EXISTS` não acrescenta colunas em instalações já abertas durante
    // desenvolvimento. Esta alteração é aditiva e mantém os eventos gravados antes do grafo.
    let mut statement = conn.prepare("PRAGMA table_info(harness_execution_events)")?;
    let mut rows = statement.query([])?;
    let mut has_parent_node_id = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        has_parent_node_id |= name == "parent_node_id";
    }
    drop(rows);
    drop(statement);
    if !has_parent_node_id {
        conn.execute_batch("ALTER TABLE harness_execution_events ADD COLUMN parent_node_id TEXT")?;
    }
    conn.execute(
        "UPDATE harness_execution_events
         SET parent_node_id = CASE
             WHEN attempt_id IS NOT NULL THEN 'attempt:' || attempt_id
             WHEN kind = 'child_thread.created' AND entity_id = thread_id THEN 'thread:' || thread_id
             WHEN turn_id IS NOT NULL THEN 'turn:' || thread_id || ':' || turn_id
             ELSE 'thread:' || thread_id
         END
         WHERE parent_node_id IS NULL",
        [],
    )?;
    Ok(())
}

fn append(conn: &Connection, event: EventDraft<'_>) -> rusqlite::Result<Option<i64>> {
    let payload = serde_json::to_string(&event.payload).unwrap_or_else(|_| "{}".into());
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO harness_execution_events
         (thread_id, parent_node_id, turn_id, run_id, task_id, attempt_id, kind, entity_id, dedupe_key, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            event.thread_id,
            event.parent_node_id,
            event.turn_id,
            event.run_id,
            event.task_id,
            event.attempt_id,
            event.kind,
            event.entity_id,
            event.dedupe_key,
            payload,
            event.created_at,
        ],
    )?;
    Ok((inserted > 0).then(|| conn.last_insert_rowid()))
}

fn active_turn_id(conn: &Connection, thread_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM chat_run WHERE thread_id = ?1 AND status = 'inProgress'
         ORDER BY COALESCE(started_at, 0) DESC, id DESC LIMIT 1",
        [thread_id],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn short_text(value: Option<&str>, max_chars: usize) -> Option<String> {
    value.map(|text| text.chars().take(max_chars).collect())
}

/// Adapta eventos já normalizados da conversa a transições semânticas estáveis.
/// Deltas de texto e configuração do provider ficam fora do log; o conteúdo completo vive
/// em `chat_item` e os pedidos em `chat_request`.
pub(crate) fn record_chat_event(
    conn: &Connection,
    thread_id: &str,
    event_type: &str,
    payload: &Value,
) -> rusqlite::Result<()> {
    let now = crate::util::now_ts_ms();
    let record = |kind: &str,
                  entity_id: Option<&str>,
                  turn_id: Option<&str>,
                  dedupe_key: String,
                  details: Value| {
        let parent_node_id = turn_id
            .map(|turn_id| format!("turn:{thread_id}:{turn_id}"))
            .unwrap_or_else(|| format!("thread:{thread_id}"));
        append(
            conn,
            EventDraft {
                thread_id,
                parent_node_id: Some(&parent_node_id),
                turn_id,
                run_id: None,
                task_id: None,
                attempt_id: None,
                kind,
                entity_id,
                dedupe_key: &dedupe_key,
                payload: details,
                created_at: now,
            },
        )
        .map(|_| ())
    };

    match event_type {
        "created" => {
            let thread = payload.get("thread").unwrap_or(payload);
            let entity_id = value_str(thread, "id").unwrap_or(thread_id);
            record(
                "thread.created",
                Some(entity_id),
                None,
                format!("thread.created:{entity_id}"),
                json!({
                    "agentId": value_str(thread, "agentId"),
                    "title": short_text(value_str(thread, "title"), 160),
                }),
            )?;

            if value_str(thread, "parentRef").is_some_and(|value| value.starts_with("thread:")) {
                let parent = value_str(thread, "parentRef")
                    .unwrap_or_default()
                    .trim_start_matches("thread:");
                if !parent.is_empty() {
                    // A árvore lê a criação pelo pai sem copiar a conversa nem expor seu conteúdo.
                    if parent != thread_id {
                        let parent_exists = conn
                            .query_row("SELECT 1 FROM chat_thread WHERE id = ?1", [parent], |_| {
                                Ok(())
                            })
                            .optional()?
                            .is_some();
                        if parent_exists {
                            let parent_turn_id = value_str(thread, "parentTurnId");
                            let parent_node_id = parent_turn_id
                                .map(|turn_id| format!("turn:{parent}:{turn_id}"))
                                .unwrap_or_else(|| format!("thread:{parent}"));
                            let dedupe_key = format!("child_thread.created:{entity_id}");
                            append(
                                conn,
                                EventDraft {
                                    thread_id: parent,
                                    parent_node_id: Some(&parent_node_id),
                                    turn_id: parent_turn_id,
                                    run_id: None,
                                    task_id: None,
                                    attempt_id: None,
                                    kind: "child_thread.created",
                                    entity_id: Some(entity_id),
                                    dedupe_key: &dedupe_key,
                                    payload: json!({
                                        "childThreadId": entity_id,
                                        "title": short_text(value_str(thread, "title"), 160),
                                        "agentId": value_str(thread, "agentId"),
                                    }),
                                    created_at: now,
                                },
                            )?;
                        }
                    }
                }
            }
        }
        "phase" if value_str(payload, "phase") == Some("working") => {
            if let Some(turn_id) = value_str(payload, "turnId") {
                record(
                    "turn.started",
                    Some(turn_id),
                    Some(turn_id),
                    format!("turn.started:{turn_id}"),
                    json!({}),
                )?;
            }
        }
        "item" => {
            let null = Value::Null;
            let item = payload.get("item").unwrap_or(&null);
            let Some(item_id) = value_str(item, "id") else {
                return Ok(());
            };
            let active_turn = active_turn_id(conn, thread_id);
            match value_str(item, "kind") {
                Some("user") | Some("assistant") => {
                    let item_kind = value_str(item, "kind").unwrap_or("message");
                    record(
                        if item_kind == "user" {
                            "message.user"
                        } else {
                            "message.assistant"
                        },
                        Some(item_id),
                        active_turn.as_deref(),
                        format!("message:{item_kind}:{item_id}"),
                        json!({ "itemId": item_id }),
                    )?;
                }
                Some("tool") => {
                    let status = value_str(item, "status").unwrap_or("running");
                    let (kind, state) = match status {
                        "running" => ("tool.started", "started"),
                        "done" => ("tool.completed", "completed"),
                        "error" => ("tool.failed", "failed"),
                        "denied" => ("tool.denied", "denied"),
                        _ => return Ok(()),
                    };
                    record(
                        kind,
                        Some(item_id),
                        active_turn.as_deref(),
                        format!("tool:{item_id}:{state}"),
                        json!({
                            "itemId": item_id,
                            "name": value_str(item, "name"),
                            "tool": value_str(item, "tool"),
                            "label": short_text(value_str(item, "label").or_else(|| value_str(item, "path")), 240),
                        }),
                    )?;
                }
                Some("turnEnd") => {
                    let turn_id = item_id.strip_prefix("end:").or(active_turn.as_deref());
                    if let Some(turn_id) = turn_id {
                        let interrupted = item
                            .get("interrupted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        record(
                            if interrupted {
                                "turn.interrupted"
                            } else {
                                "turn.ended"
                            },
                            Some(turn_id),
                            Some(turn_id),
                            format!("turn.ended:{turn_id}"),
                            json!({
                                "interrupted": interrupted,
                                "hasError": item.get("hasText").and_then(Value::as_bool)
                                    .unwrap_or_else(|| value_str(item, "text").is_some()),
                                "durationMs": item.get("durationMs").and_then(Value::as_i64),
                            }),
                        )?;
                    }
                }
                Some("usage") => {
                    record(
                        "turn.usage",
                        Some(item_id),
                        active_turn.as_deref(),
                        format!("usage:{item_id}"),
                        json!({
                            "tokens": item.get("tokens").and_then(Value::as_u64),
                            "contextTokens": item.get("contextTokens").and_then(Value::as_u64),
                        }),
                    )?;
                }
                Some("notice") => {
                    record(
                        "runtime.notice",
                        Some(item_id),
                        active_turn.as_deref(),
                        format!("notice:{item_id}"),
                        json!({ "label": value_str(item, "label") }),
                    )?;
                }
                // Reasoning stays in its provider-native timeline item; do not copy it to the
                // cross-provider execution log.
                _ => {}
            }
        }
        "request" => {
            let request = payload.get("request").unwrap_or(payload);
            let Some(id) = value_str(request, "id") else {
                return Ok(());
            };
            let request_kind = value_str(request, "kind").unwrap_or("permission");
            record(
                if request_kind == "question" {
                    "question.requested"
                } else {
                    "permission.requested"
                },
                Some(id),
                active_turn_id(conn, thread_id).as_deref(),
                format!("request.opened:{id}"),
                json!({
                    "requestId": id,
                    "requestKind": request_kind,
                    "title": short_text(value_str(request, "title"), 240),
                }),
            )?;
        }
        "requestResolved" => {
            if let Some(id) = value_str(payload, "id") {
                record(
                    "request.resolved",
                    Some(id),
                    active_turn_id(conn, thread_id).as_deref(),
                    format!("request.resolved:{id}"),
                    json!({ "requestId": id }),
                )?;
            }
        }
        "task" => {
            let task = payload.get("task").unwrap_or(payload);
            if let Some(id) = value_str(task, "id") {
                let status = value_str(task, "status").unwrap_or("updated");
                record(
                    "subagent.status",
                    Some(id),
                    active_turn_id(conn, thread_id).as_deref(),
                    format!("subagent:{id}:{status}"),
                    json!({
                        "taskId": id,
                        "title": short_text(value_str(task, "title"), 160),
                        "status": status,
                    }),
                )?;
            }
        }
        "taskItem" => {
            let item = payload.get("item").unwrap_or(payload);
            if let Some(item_id) = value_str(item, "id") {
                let parent = value_str(payload, "parentToolUseId").unwrap_or("agent");
                let state = value_str(item, "status").unwrap_or("updated");
                record(
                    "subagent.item",
                    Some(item_id),
                    active_turn_id(conn, thread_id).as_deref(),
                    format!("subagent.item:{parent}:{item_id}:{state}"),
                    json!({
                        "parentToolUseId": parent,
                        "itemId": item_id,
                        "kind": value_str(item, "kind"),
                        "status": state,
                    }),
                )?;
            }
        }
        "goal" => {
            let null = Value::Null;
            let goal = payload.get("goal").unwrap_or(&null);
            let status = value_str(goal, "status");
            record(
                "goal.updated",
                Some(thread_id),
                active_turn_id(conn, thread_id).as_deref(),
                format!("goal.updated:{now}"),
                json!({ "status": status }),
            )?;
        }
        "error" => {
            let turn = active_turn_id(conn, thread_id);
            let has_message = payload
                .get("hasMessage")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| payload.get("message").is_some_and(|value| !value.is_null()));
            record(
                "turn.error",
                turn.as_deref(),
                turn.as_deref(),
                format!("turn.error:{}", turn.as_deref().unwrap_or("unknown")),
                json!({ "hasMessage": has_message }),
            )?;
        }
        "closed" => record(
            "thread.closed",
            Some(thread_id),
            None,
            format!("thread.closed:{thread_id}:{now}"),
            json!({}),
        )?,
        _ => {}
    }
    Ok(())
}

/// Registra o fim interrompido dentro da mesma transação que reconcilia um turno órfão.
/// A chave coincide com a usada pelo fim normal para que um append repetido após crash seja seguro.
pub(crate) fn record_interrupted_turn(
    conn: &Connection,
    thread_id: &str,
    turn_id: &str,
    reason: &str,
    created_at: i64,
) -> rusqlite::Result<()> {
    let parent_node_id = format!("turn:{thread_id}:{turn_id}");
    append(
        conn,
        EventDraft {
            thread_id,
            parent_node_id: Some(&parent_node_id),
            turn_id: Some(turn_id),
            run_id: None,
            task_id: None,
            attempt_id: None,
            kind: "turn.interrupted",
            entity_id: Some(turn_id),
            dedupe_key: &format!("turn.ended:{turn_id}"),
            payload: json!({
                "interrupted": true,
                "hasError": false,
                "reason": short_text(Some(reason), 240),
            }),
            created_at,
        },
    )
    .map(|_| ())
}

/// Eventos adaptados dos processos headless. O texto fica no JSONL de diagnóstico; aqui entram
/// somente início, ferramenta e desfecho ligados à mesma tentativa persistente.
pub(crate) fn record_fleet_event(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    event: &super::types::AgentEvent,
) -> rusqlite::Result<Option<String>> {
    let execution = conn.query_row(
        "SELECT r.source_thread_id, t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?1",
        [task_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    let Some((Some(thread_id), run_id)) = execution else {
        return Ok(None);
    };
    let now = crate::util::now_ts_ms();
    let (kind, entity_id, dedupe_key, payload) = match event {
        super::types::AgentEvent::Started { .. } => (
            "fleet.attempt.started",
            attempt_id.to_string(),
            format!("fleet.attempt.started:{attempt_id}"),
            json!({}),
        ),
        super::types::AgentEvent::Tool { name, label } => (
            "fleet.tool.started",
            attempt_id.to_string(),
            format!("fleet.tool:{}", uuid::Uuid::new_v4()),
            json!({ "name": name, "label": short_text(Some(label), 240) }),
        ),
        super::types::AgentEvent::Finished { .. } => return Ok(None),
        super::types::AgentEvent::Text { .. } | super::types::AgentEvent::Quota { .. } => {
            return Ok(None);
        }
    };
    let inserted = append(
        conn,
        EventDraft {
            thread_id: &thread_id,
            parent_node_id: Some(&format!("attempt:{attempt_id}")),
            turn_id: None,
            run_id: Some(&run_id),
            task_id: Some(task_id),
            attempt_id: Some(attempt_id),
            kind,
            entity_id: Some(&entity_id),
            dedupe_key: &dedupe_key,
            payload,
            created_at: now,
        },
    )?;
    Ok(inserted.map(|_| thread_id))
}

pub(crate) fn record_fleet_final(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    outcome: &super::types::TaskOutcome,
) -> rusqlite::Result<()> {
    let execution = conn.query_row(
        "SELECT r.source_thread_id, t.run_id FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?1",
        [task_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    let Some((Some(thread_id), run_id)) = execution else {
        return Ok(());
    };
    let now = crate::util::now_ts_ms();
    let attempt_ref = attempt_id.to_string();
    append(
        conn,
        EventDraft {
            thread_id: &thread_id,
            parent_node_id: Some(&format!("attempt:{attempt_id}")),
            turn_id: None,
            run_id: Some(&run_id),
            task_id: Some(task_id),
            attempt_id: Some(attempt_id),
            kind: "fleet.attempt.finished",
            entity_id: Some(&attempt_ref),
            dedupe_key: &format!("fleet.attempt.finished:{attempt_id}"),
            payload: json!({
                "ok": outcome.ok,
                "hasError": outcome.error.is_some(),
                "tokensIn": outcome.tokens_in,
                "tokensOut": outcome.tokens_out,
                "costUsd": outcome.cost_usd,
            }),
            created_at: now,
        },
    )?;
    Ok(())
}

/// Grava a interrupção da tentativa na mesma transação que fecha uma task órfã no boot.
/// A sessão fica no registro nativo da tentativa; o evento carrega só um booleano, nunca o handle.
pub(crate) fn record_fleet_interrupted(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    reason: &str,
    created_at: i64,
) -> rusqlite::Result<()> {
    let execution = conn
        .query_row(
            "SELECT r.source_thread_id, t.run_id, EXISTS(
                 SELECT 1 FROM run_attempts a WHERE a.id = ?2 AND a.session_id != ''
             )
             FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?1",
            rusqlite::params![task_id, attempt_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((Some(thread_id), run_id, has_session)) = execution else {
        return Ok(());
    };
    let parent_node_id = format!("attempt:{attempt_id}");
    append(
        conn,
        EventDraft {
            thread_id: &thread_id,
            parent_node_id: Some(&parent_node_id),
            turn_id: None,
            run_id: Some(&run_id),
            task_id: Some(task_id),
            attempt_id: Some(attempt_id),
            kind: "fleet.attempt.interrupted",
            entity_id: Some(attempt_id),
            dedupe_key: &format!("fleet.attempt.interrupted:{attempt_id}"),
            payload: json!({
                "reason": short_text(Some(reason), 240),
                "hasSession": has_session,
            }),
            created_at,
        },
    )
    .map(|_| ())
}

/// Carrega a atividade semântica mais recente de uma linhagem para o feed do harness.
pub(crate) fn list_for_threads(
    conn: &Connection,
    thread_ids: &[String],
    limit: usize,
) -> Result<Vec<HarnessEvent>, String> {
    if thread_ids.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let mut events = Vec::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT sequence, thread_id, parent_node_id, turn_id, run_id, task_id, attempt_id, kind, entity_id, payload_json, created_at
             FROM harness_execution_events WHERE thread_id IN ({placeholders}) ORDER BY sequence DESC LIMIT ?"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let mut bindings = ids
            .iter()
            .cloned()
            .map(rusqlite::types::Value::Text)
            .collect::<Vec<_>>();
        bindings.push(rusqlite::types::Value::Integer(
            limit.min(i64::MAX as usize) as i64,
        ));
        let mut rows = statement
            .query(rusqlite::params_from_iter(bindings.iter()))
            .map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let sequence: i64 = row.get(0).map_err(|error| error.to_string())?;
            let payload_json: String = row.get(9).map_err(|error| error.to_string())?;
            let payload = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
            events.push(HarnessEvent {
                sequence,
                node_id: format!("event:{sequence}"),
                thread_id: row.get(1).map_err(|error| error.to_string())?,
                parent_node_id: row.get(2).map_err(|error| error.to_string())?,
                turn_id: row.get(3).map_err(|error| error.to_string())?,
                run_id: row.get(4).map_err(|error| error.to_string())?,
                task_id: row.get(5).map_err(|error| error.to_string())?,
                attempt_id: row.get(6).map_err(|error| error.to_string())?,
                kind: row.get(7).map_err(|error| error.to_string())?,
                entity_id: row.get(8).map_err(|error| error.to_string())?,
                payload,
                created_at: row.get(10).map_err(|error| error.to_string())?,
            });
        }
    }
    events.sort_by_key(|event| event.sequence);
    if events.len() > limit {
        events.drain(..events.len() - limit);
    }
    Ok(events)
}
