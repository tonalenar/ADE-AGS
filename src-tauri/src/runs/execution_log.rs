//! Log semântico do harness compartilhado por conversas estruturadas e pela Frota.
//!
//! A timeline (`chat_item`) e os JSONL dos providers continuam guardando conteúdo e frames.
//! Este log guarda a ordem das transições úteis à orquestração, com referências aos registros
//! de origem, sem duplicar mensagens, saídas de ferramentas ou frames crus.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Once, OnceLock, mpsc};
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

/// Quantos eventos a janela do feed leva. Também é o teto de um delta: acima disso o front recebe a árvore inteira.
pub(crate) const EVENT_WINDOW: usize = 250;

/// "A árvore desta conversa mudou", o payload de `cc-harness-event`. Leva só o id e o cursor (a sequência
/// do último evento persistido da conversa): o front compara com o que já aplicou e pede o delta.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeChanged {
    pub thread_id: String,
    pub cursor: i64,
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
        /// O payload compactado, o que vai para o log.
        payload: Value,
        /// O payload completo que a janela recebe, quando é conclusão (fase, pedido ou fechamento).
        ui: Option<Value>,
    },
    Fleet {
        app: tauri::AppHandle,
        db: crate::database::DbConnection,
        task_id: String,
        attempt_id: String,
        event: super::types::AgentEvent,
    },
    Replay {
        app: tauri::AppHandle,
        db: crate::database::DbConnection,
    },
}

static WRITER: OnceLock<mpsc::Sender<QueuedEvent>> = OnceLock::new();
/// A repetição das falhas pendentes roda uma vez por processo, no primeiro trabalho da fila.
static REPLAY: Once = Once::new();

/// O sinal de uma gravação que falhou de vez: a janela recebe `LOG_FAILED_EVENT`, o barramento o `LOG_FAILED_TOPIC`.
pub const LOG_FAILED_EVENT: &str = "cc-harness-log-failed";
pub const LOG_FAILED_TOPIC: &str = "harness.log_failed";
/// O que a árvore da conversa recebe depois de uma gravação, com o cursor de cada uma.
const TREE_EVENT: &str = "cc-harness-event";
/// Quantas vezes a gravação de um evento é tentada antes de virar falha. A espera pelo lock do SQLite já vem do
/// `busy_timeout`; a repetição cobre só a falha passageira, sem dormir.
const PERSIST_ATTEMPTS: i64 = 3;
/// Quantas falhas pendentes uma repetição leva por vez.
const REPLAY_BATCH: i64 = 200;

fn writer() -> &'static mpsc::Sender<QueuedEvent> {
    WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<QueuedEvent>();
        let _ = std::thread::Builder::new()
            .name("ags-harness-event-log".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    handle(event);
                }
            });
        sender
    })
}

/// Executa um trabalho da fila: tenta gravar (com repetição), registra a falha se houver, e só então entrega à janela
/// e ao barramento. Roda na thread da fila; se ela já caiu, roda no chamador (`send_or_handle`).
fn handle(event: QueuedEvent) {
    let now = crate::util::now_ts_ms();
    match event {
        QueuedEvent::Chat { app, db, thread_id, event_type, payload, ui } => {
            let job = ChatJob { thread_id: &thread_id, event_type: &event_type, payload: &payload, ui: ui.as_ref() };
            settle_chat(&db, &job, now, &mut AppSink(&app));
        }
        QueuedEvent::Fleet { app, db, task_id, attempt_id, event } => match persist_settled(&db, |conn| persist_fleet_event(conn, &task_id, &attempt_id, &event)) {
            Settled::Persisted(changes) => {
                if !changes.is_empty() {
                    AppSink(&app).changed(changes);
                }
            }
            Settled::Orphan => {}
            Settled::Failed { error, attempts } => {
                let kind = event_kind(&event);
                fail_write(
                    &db,
                    &FailedWrite {
                        scope: "fleet",
                        thread_id: None,
                        task_id: Some(&task_id),
                        attempt_id: Some(&attempt_id),
                        event_kind: &kind,
                        payload_json: None,
                        error: &error,
                        attempts,
                    },
                    now,
                    &mut AppSink(&app),
                );
            }
        },
        QueuedEvent::Replay { app, db } => {
            let changes = replay_chat_failures(&db, now, |conn, thread_id, event_type, payload| persist_chat_event(conn, thread_id, event_type, payload));
            if !changes.is_empty() {
                AppSink(&app).changed(changes);
            }
        }
    }
}

/// Grava o evento do chat e devolve quem mudou, cada conversa com o cursor do seu último evento.
/// Criar uma conversa filha também muda a árvore da conversa pai.
pub(crate) fn persist_chat_event(
    conn: &Connection,
    thread_id: &str,
    event_type: &str,
    payload: &Value,
) -> Result<Vec<TreeChanged>, String> {
    record_chat_event(conn, thread_id, event_type, payload).map_err(|error| error.to_string())?;
    let mut affected = vec![thread_id.to_string()];
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
    with_cursors(conn, affected)
}

/// O mesmo para um evento de tentativa da Frota: avisa a conversa de origem do run, se houver.
pub(crate) fn persist_fleet_event(
    conn: &Connection,
    task_id: &str,
    attempt_id: &str,
    event: &super::types::AgentEvent,
) -> Result<Vec<TreeChanged>, String> {
    let thread_id = record_fleet_event(conn, task_id, attempt_id, event)
        .map_err(|error| error.to_string())?;
    with_cursors(conn, thread_id.into_iter().collect())
}

fn with_cursors(conn: &Connection, thread_ids: Vec<String>) -> Result<Vec<TreeChanged>, String> {
    thread_ids
        .into_iter()
        .map(|thread_id| {
            let cursor = lineage_cursor(conn, std::slice::from_ref(&thread_id))?;
            Ok(TreeChanged { thread_id, cursor })
        })
        .collect()
}

/// A sequência do último evento persistido das conversas dadas (0 se não há nenhum). A sequência é global
/// e só cresce, então o maior valor de uma linhagem serve de cursor para ela inteira.
pub(crate) fn lineage_cursor(conn: &Connection, thread_ids: &[String]) -> Result<i64, String> {
    let mut cursor = 0_i64;
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT COALESCE(MAX(sequence), 0) FROM harness_execution_events WHERE thread_id IN ({placeholders})"
        );
        let max: i64 = conn
            .query_row(&sql, rusqlite::params_from_iter(ids.iter()), |row| row.get(0))
            .map_err(|error| error.to_string())?;
        cursor = cursor.max(max);
    }
    Ok(cursor)
}

/// Enfileira fora do adapter: a gravação pode aguardar o lock curto do SQLite sem bloquear emissão de UI nem correr o
/// risco de um adapter segurar o mesmo lock. Com `publish`, a fase, o pedido ou o fechamento só saem à janela e ao
/// barramento depois da tentativa de gravação (contrato §11.4): quem os entrega é a fila.
pub(crate) fn queue_chat_event(
    app: &tauri::AppHandle,
    db: crate::database::DbConnection,
    thread_id: String,
    event_type: String,
    payload: Value,
    publish: bool,
) {
    let compact = compact_chat_payload(&event_type, &payload);
    let ui = publish.then_some(payload);
    ensure_replay(app, &db);
    send_or_handle(QueuedEvent::Chat {
        app: app.clone(),
        db,
        thread_id,
        event_type,
        payload: compact,
        ui,
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
    ensure_replay(app, &db);
    send_or_handle(QueuedEvent::Fleet {
        app: app.clone(),
        db,
        task_id,
        attempt_id,
        event,
    });
}

/// Na primeira vez que o processo enfileira algo, repete as falhas de conversa que ficaram abertas: as de antes de um
/// reinício, ou as desta vida se a gravação voltou. Uma vez por processo, sem relógio nem polling.
fn ensure_replay(app: &tauri::AppHandle, db: &crate::database::DbConnection) {
    REPLAY.call_once(|| {
        let _ = writer().send(QueuedEvent::Replay { app: app.clone(), db: db.clone() });
    });
}

/// Entrega o trabalho à thread da fila. Se ela já caiu, faz no chamador: o evento não se perde.
fn send_or_handle(job: QueuedEvent) {
    if let Err(mpsc::SendError(job)) = writer().send(job) {
        handle(job);
    }
}

/// O tipo do evento da Frota (o `kind` do `AgentEvent`), para o registro da falha.
fn event_kind(event: &super::types::AgentEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("kind").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

// Falha de gravação visível (contrato §11.11): tipos da fila e do registro de falhas.

/// Para onde vai o que a fila entrega à janela e ao barramento depois de tentar gravar.
pub(crate) trait LogSink {
    fn changed(&mut self, changes: Vec<TreeChanged>);
    fn failed(&mut self, signal: Value);
    fn conversation(&mut self, ui: &Value, logged: bool);
}

/// Um evento de conversa a gravar. `ui` é o payload completo que a janela recebe (só fase, pedido e fechamento).
pub(crate) struct ChatJob<'a> {
    pub thread_id: &'a str,
    pub event_type: &'a str,
    pub payload: &'a Value,
    pub ui: Option<&'a Value>,
}

/// O desfecho de uma gravação, depois das tentativas.
#[derive(Debug)]
pub(crate) enum Settled {
    Persisted(Vec<TreeChanged>),
    Orphan,
    Failed { error: String, attempts: i64 },
}

/// Uma falha de gravação a registrar para recuperar depois.
pub(crate) struct FailedWrite<'a> {
    pub scope: &'a str,
    pub thread_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub attempt_id: Option<&'a str>,
    pub event_kind: &'a str,
    pub payload_json: Option<&'a str>,
    pub error: &'a str,
    pub attempts: i64,
}

/// A janela e o barramento, de verdade: o que a fila entrega depois de tentar gravar.
struct AppSink<'a>(&'a tauri::AppHandle);

impl LogSink for AppSink<'_> {
    fn changed(&mut self, changes: Vec<TreeChanged>) {
        for change in changes {
            let _ = self.0.emit(TREE_EVENT, change);
        }
    }

    fn failed(&mut self, signal: Value) {
        let _ = self.0.emit(LOG_FAILED_EVENT, signal.clone());
        crate::bus::publish(Some(self.0), crate::bus::Publish::new(LOG_FAILED_TOPIC).data(signal));
    }

    fn conversation(&mut self, ui: &Value, logged: bool) {
        crate::conversa::events::publish_conversation(self.0, ui, logged);
    }
}

/// Tenta a gravação até `PERSIST_ATTEMPTS` vezes. Uma falha de chave estrangeira não se repete: a conversa do evento
/// já não existe, então não há onde gravar e não é perda.
pub(crate) fn persist_settled(
    db: &crate::database::DbConnection,
    mut persist: impl FnMut(&Connection) -> Result<Vec<TreeChanged>, String>,
) -> Settled {
    let mut last = String::new();
    for _ in 0..PERSIST_ATTEMPTS {
        let result = db.lock().map_err(|error| error.to_string()).and_then(|conn| persist(&*conn));
        match result {
            Ok(changes) => return Settled::Persisted(changes),
            Err(error) if error.contains("FOREIGN KEY constraint failed") => return Settled::Orphan,
            Err(error) => last = error,
        }
    }
    Settled::Failed { error: crate::harness::effects::sanitize_error(&last), attempts: PERSIST_ATTEMPTS }
}

/// O passo que a fila faz por evento de conversa: tenta gravar, registra a falha se houver, e só então entrega à janela
/// e ao barramento. A conclusão (fase, pedido, fechamento) sai sempre depois da tentativa (contrato §11.4); se a
/// gravação falhou, sai com `logged = false` e com o sinal de falha, para ninguém ficar esperando.
pub(crate) fn settle_chat_with(
    db: &crate::database::DbConnection,
    job: &ChatJob,
    now: i64,
    persist: impl FnMut(&Connection) -> Result<Vec<TreeChanged>, String>,
    sink: &mut dyn LogSink,
) {
    let logged = match persist_settled(db, persist) {
        Settled::Persisted(changes) => {
            if !changes.is_empty() {
                sink.changed(changes);
            }
            true
        }
        // A conversa já não existe: não há o que gravar, e não há perda.
        Settled::Orphan => true,
        Settled::Failed { error, attempts } => {
            let payload_json = job.payload.to_string();
            fail_write(
                db,
                &FailedWrite {
                    scope: "chat",
                    thread_id: Some(job.thread_id),
                    task_id: None,
                    attempt_id: None,
                    event_kind: job.event_type,
                    payload_json: Some(&payload_json),
                    error: &error,
                    attempts,
                },
                now,
                sink,
            );
            false
        }
    };
    if let Some(ui) = job.ui {
        sink.conversation(ui, logged);
    }
}

/// O evento de conversa gravado de verdade (`persist_chat_event`), pelo mesmo caminho dos testes.
fn settle_chat(db: &crate::database::DbConnection, job: &ChatJob, now: i64, sink: &mut dyn LogSink) {
    settle_chat_with(db, job, now, |conn| persist_chat_event(conn, job.thread_id, job.event_type, job.payload), sink);
}

/// Registra a falha para recuperar depois (`harness_log_failure`) e avisa a janela e o barramento. Se nem o registro
/// cabe no banco, o aviso sai mesmo assim, com `failureId` nulo, e o motivo vai ao stderr.
pub(crate) fn fail_write(db: &crate::database::DbConnection, write: &FailedWrite, now: i64, sink: &mut dyn LogSink) {
    let failure_id = match db.lock() {
        Ok(conn) => match conn.execute(
            "INSERT INTO harness_log_failure
             (scope, thread_id, task_id, attempt_id, event_kind, payload_json, last_error, attempts, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                write.scope,
                write.thread_id,
                write.task_id,
                write.attempt_id,
                write.event_kind,
                write.payload_json,
                write.error,
                write.attempts,
                now
            ],
        ) {
            Ok(_) => Some(conn.last_insert_rowid()),
            Err(error) => {
                eprintln!("[harness] falha de gravação sem registro: {error}");
                None
            }
        },
        Err(error) => {
            eprintln!("[harness] falha de gravação sem registro: {error}");
            None
        }
    };
    sink.failed(json!({
        "scope": write.scope,
        "threadId": write.thread_id,
        "taskId": write.task_id,
        "attemptId": write.attempt_id,
        "eventType": write.event_kind,
        "error": write.error,
        "attempts": write.attempts,
        "failureId": failure_id,
    }));
}

/// Repete as falhas de conversa ainda abertas: regrava o evento (já compactado, sem texto de agente) e fecha a linha.
/// Uma conversa que sumiu também fecha a linha, porque não há o que recuperar. A Frota não guarda payload para repetir,
/// então a falha dela só fica visível. Devolve o que mudou na árvore, para a janela atualizar.
pub(crate) fn replay_chat_failures(
    db: &crate::database::DbConnection,
    now: i64,
    mut persist: impl FnMut(&Connection, &str, &str, &Value) -> Result<Vec<TreeChanged>, String>,
) -> Vec<TreeChanged> {
    let pending = match db.lock() {
        Ok(conn) => pending_chat(&conn).unwrap_or_default(),
        Err(_) => return Vec::new(),
    };
    let mut changes = Vec::new();
    for (id, thread_id, event_kind, payload_json) in pending {
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({}));
        match persist_settled(db, |conn| persist(conn, &thread_id, &event_kind, &payload)) {
            Settled::Persisted(found) => {
                changes.extend(found);
                close_failure(db, id, now);
            }
            Settled::Orphan => close_failure(db, id, now),
            Settled::Failed { error, attempts } => keep_failure(db, id, &error, attempts),
        }
    }
    changes
}

/// As falhas de conversa ainda abertas, a mais antiga primeiro.
fn pending_chat(conn: &Connection) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
    let mut statement = conn.prepare(
        "SELECT id, thread_id, event_kind, payload_json FROM harness_log_failure
         WHERE scope = 'chat' AND resolved_at IS NULL AND thread_id IS NOT NULL AND payload_json IS NOT NULL
         ORDER BY id LIMIT ?1",
    )?;
    let found = statement
        .query_map(params![REPLAY_BATCH], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(found)
}

fn close_failure(db: &crate::database::DbConnection, id: i64, now: i64) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute("UPDATE harness_log_failure SET resolved_at = ?2 WHERE id = ?1", params![id, now]);
    }
}

fn keep_failure(db: &crate::database::DbConnection, id: i64, error: &str, attempts: i64) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute(
            "UPDATE harness_log_failure SET attempts = attempts + ?2, last_error = ?3 WHERE id = ?1",
            params![id, attempts, error],
        );
    }
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
    // Falhas de gravação do log que ainda não foram regravadas (contrato §11.11): aditiva, só cria.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_log_failure (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            scope        TEXT NOT NULL,
            thread_id    TEXT,
            task_id      TEXT,
            attempt_id   TEXT,
            event_kind   TEXT NOT NULL,
            payload_json TEXT,
            last_error   TEXT NOT NULL,
            attempts     INTEGER NOT NULL,
            created_at   INTEGER NOT NULL,
            resolved_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_harness_log_failure_open ON harness_log_failure(resolved_at);",
    )?;
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

const EVENT_COLUMNS: &str = "sequence, thread_id, parent_node_id, turn_id, run_id, task_id, attempt_id, kind, entity_id, payload_json, created_at";

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HarnessEvent> {
    let sequence: i64 = row.get(0)?;
    let payload_json: String = row.get(9)?;
    Ok(HarnessEvent {
        sequence,
        node_id: format!("event:{sequence}"),
        thread_id: row.get(1)?,
        parent_node_id: row.get(2)?,
        turn_id: row.get(3)?,
        run_id: row.get(4)?,
        task_id: row.get(5)?,
        attempt_id: row.get(6)?,
        kind: row.get(7)?,
        entity_id: row.get(8)?,
        payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
        created_at: row.get(10)?,
    })
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
            "SELECT {EVENT_COLUMNS} FROM harness_execution_events
             WHERE thread_id IN ({placeholders}) ORDER BY sequence DESC LIMIT ?"
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
        let rows = statement
            .query_map(rusqlite::params_from_iter(bindings.iter()), event_from_row)
            .map_err(|error| error.to_string())?;
        for row in rows {
            events.push(row.map_err(|error| error.to_string())?);
        }
    }
    events.sort_by_key(|event| event.sequence);
    if events.len() > limit {
        events.drain(..events.len() - limit);
    }
    Ok(events)
}

/// Os eventos da linhagem depois do cursor, em ordem cronológica. `None` quando há mais de `limit`:
/// um delta com buraco não se remenda, e quem chamou precisa da janela inteira.
pub(crate) fn list_since(
    conn: &Connection,
    thread_ids: &[String],
    after: i64,
    limit: usize,
) -> Result<Option<Vec<HarnessEvent>>, String> {
    let mut events = Vec::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM harness_execution_events
             WHERE thread_id IN ({placeholders}) AND sequence > ? ORDER BY sequence ASC LIMIT ?"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let mut bindings = ids
            .iter()
            .cloned()
            .map(rusqlite::types::Value::Text)
            .collect::<Vec<_>>();
        bindings.push(rusqlite::types::Value::Integer(after));
        bindings.push(rusqlite::types::Value::Integer(
            limit.saturating_add(1).min(i64::MAX as usize) as i64,
        ));
        let rows = statement
            .query_map(rusqlite::params_from_iter(bindings.iter()), event_from_row)
            .map_err(|error| error.to_string())?;
        for row in rows {
            events.push(row.map_err(|error| error.to_string())?);
        }
    }
    events.sort_by_key(|event| event.sequence);
    Ok((events.len() <= limit).then_some(events))
}

/// A razão legível de cada turno interrompido (chave: o nó do turno). Lida à parte porque a projeção
/// precisa dela mesmo quando a resposta traz só o delta dos eventos.
pub(crate) fn interruption_reasons(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut reasons = std::collections::HashMap::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT parent_node_id, payload_json FROM harness_execution_events
             WHERE kind = 'turn.interrupted' AND parent_node_id IS NOT NULL AND thread_id IN ({placeholders})
             ORDER BY sequence ASC"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (node_id, payload_json) = row.map_err(|error| error.to_string())?;
            let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
            if let Some(reason) = payload.get("reason").and_then(Value::as_str) {
                reasons.insert(node_id, reason.to_string());
            }
        }
    }
    Ok(reasons)
}
