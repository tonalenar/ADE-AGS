//! Tabelas `harness_run` e `harness_node` e a ligação preguiçosa (Fase 1, contrato §4.2 e §7).
//!
//! - O run nasce no **primeiro filho** de um turno (filho de chat ou delegação à Frota). Turno sem
//!   filho não ganha linha, e nenhum adapter de conversa é tocado.
//! - Nenhuma coluna de estado: o estado do nó é derivado do registro nativo (`state.rs`).
//! - Só aditiva: `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`, sem backfill e sem apagar nada.
//! - As funções recebem `&Connection` (ou a transação do chamador, que deriva para ele) e não fazem
//!   I/O além do banco, então cabem dentro do lock e da transação de quem as chama.
//! - Idempotentes: ligar duas vezes o mesmo registro nativo devolve o mesmo nó.

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use uuid::Uuid;

use super::identity::{
    NodeKind, SourceKind, chat_run_source_ref, fleet_run_legacy_ref, fleet_task_legacy_ref,
    thread_legacy_ref, turn_legacy_ref,
};

/// Criada num `migrate()` de módulo (chamado por `conversa::store::migrate`, depois de `chat_thread`,
/// `runs` e `tasks`), como `harness_execution_events`. Assim `database/schema.rs` não muda.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_run (
            id          TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            turn_id     TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            UNIQUE (thread_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS harness_node (
            id          TEXT PRIMARY KEY,
            run_id      TEXT NOT NULL REFERENCES harness_run(id) ON DELETE CASCADE,
            parent_id   TEXT REFERENCES harness_node(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_ref  TEXT NOT NULL,
            legacy_ref  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            UNIQUE (source_kind, source_ref),
            UNIQUE (legacy_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_harness_node_run ON harness_node(run_id, parent_id);",
    )?;
    // O CASCADE de `harness_run.thread_id` só cobre apagar a RAIZ do run. Um nó cuja origem é outra
    // linha (conversa filha, run ou tarefa da Frota) ficaria apontando para nada se ela fosse apagada
    // sozinha, por qualquer rota (hoje `delete_side_chat`; o apagar em cascata do workspace, no caso
    // da Frota). O gatilho tira o nó na mesma operação, sem depender de cada chamador lembrar.
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS harness_node_drop_child_chat AFTER DELETE ON chat_thread
        BEGIN
            DELETE FROM harness_node WHERE source_kind = 'chat_thread' AND source_ref = old.id;
        END;",
    )?;
    for (table, source_kind) in [("runs", "fleet_run"), ("tasks", "fleet_task")] {
        let exists = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
            .exists([table])?;
        if exists {
            conn.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS harness_node_drop_{source_kind} AFTER DELETE ON {table}
                BEGIN
                    DELETE FROM harness_node WHERE source_kind = '{source_kind}' AND source_ref = old.id;
                END;"
            ))?;
        }
    }
    // Fase 2: recibos de comando e fila de efeitos (contrato §11). Aditivas e independentes das de cima.
    super::receipts::migrate(conn)?;
    super::effects::migrate(conn)?;
    Ok(())
}

/// O `HarnessRun` do par `(thread_id, turn_id)` e o nó raiz do turno.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRoot {
    pub run_id: String,
    pub root_node_id: String,
}

/// Um nó já gravado, com o que a projeção precisa para decorar a árvore antiga.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeLink {
    pub node_id: String,
    pub legacy_ref: String,
    pub harness_run_id: String,
    /// `legacy_ref` do pai durável, quando há.
    pub parent_legacy_ref: Option<String>,
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

struct NodeRow {
    id: String,
    run_id: String,
}

fn node_by_source(
    conn: &Connection,
    kind: SourceKind,
    source_ref: &str,
) -> rusqlite::Result<Option<NodeRow>> {
    conn.query_row(
        "SELECT id, run_id FROM harness_node WHERE source_kind = ?1 AND source_ref = ?2",
        params![kind.as_str(), source_ref],
        |row| Ok(NodeRow { id: row.get(0)?, run_id: row.get(1)? }),
    )
    .optional()
}

#[allow(clippy::too_many_arguments)]
fn insert_node(
    conn: &Connection,
    run_id: &str,
    parent_id: Option<&str>,
    kind: NodeKind,
    source_ref: &str,
    legacy_ref: &str,
    now: i64,
) -> rusqlite::Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO harness_node (id, run_id, parent_id, kind, source_kind, source_ref, legacy_ref, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            run_id,
            parent_id,
            kind.as_str(),
            kind.source_kind().as_str(),
            source_ref,
            legacy_ref,
            now
        ],
    )?;
    Ok(id)
}

/// O run do turno `(thread_id, turn_id)` e o nó raiz dele; cria o que faltar.
pub fn ensure_run(
    conn: &Connection,
    thread_id: &str,
    turn_id: &str,
    now: i64,
) -> rusqlite::Result<RunRoot> {
    let source_ref = chat_run_source_ref(thread_id, turn_id);
    if let Some(root) = node_by_source(conn, SourceKind::ChatRun, &source_ref)? {
        return Ok(RunRoot { run_id: root.run_id, root_node_id: root.id });
    }
    // Pode haver o run sem o nó raiz só se algo o tiver apagado à mão: refaz o nó, não o run.
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM harness_run WHERE thread_id = ?1 AND turn_id = ?2",
            params![thread_id, turn_id],
            |row| row.get(0),
        )
        .optional()?;
    let run_id = match existing {
        Some(id) => id,
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO harness_run (id, thread_id, turn_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, thread_id, turn_id, now],
            )?;
            id
        }
    };
    let root_node_id = insert_node(
        conn,
        &run_id,
        None,
        NodeKind::RootAgent,
        &source_ref,
        &turn_legacy_ref(thread_id, turn_id),
        now,
    )?;
    Ok(RunRoot { run_id, root_node_id })
}

/// Liga a conversa filha ao turno pai que a originou. Devolve o id do nó `child_chat`.
pub fn link_child_chat(
    conn: &Connection,
    parent_thread_id: &str,
    parent_turn_id: &str,
    child_thread_id: &str,
    now: i64,
) -> rusqlite::Result<String> {
    if let Some(node) = node_by_source(conn, SourceKind::ChatThread, child_thread_id)? {
        return Ok(node.id);
    }
    let root = ensure_run(conn, parent_thread_id, parent_turn_id, now)?;
    insert_node(
        conn,
        &root.run_id,
        Some(&root.root_node_id),
        NodeKind::ChildChat,
        child_thread_id,
        &thread_legacy_ref(child_thread_id),
        now,
    )
}

/// Liga o run da Frota ao turno que o criou. Devolve o id do nó `fleet_run`.
pub fn link_fleet_run(
    conn: &Connection,
    thread_id: &str,
    turn_id: &str,
    fleet_run_id: &str,
    now: i64,
) -> rusqlite::Result<String> {
    if let Some(node) = node_by_source(conn, SourceKind::FleetRun, fleet_run_id)? {
        return Ok(node.id);
    }
    let root = ensure_run(conn, thread_id, turn_id, now)?;
    insert_node(
        conn,
        &root.run_id,
        Some(&root.root_node_id),
        NodeKind::FleetRun,
        fleet_run_id,
        &fleet_run_legacy_ref(fleet_run_id),
        now,
    )
}

/// Liga a tarefa ao nó do run da Frota, ou ao da tarefa pai quando ele existe.
///
/// Devolve `None` quando o run da Frota não tem nó (criado fora de conversa, ou sem turno ativo):
/// uma tarefa nunca cria um run, só entra num que já está ligado.
pub fn link_fleet_task(
    conn: &Connection,
    fleet_run_id: &str,
    task_id: &str,
    parent_task_id: Option<&str>,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let Some(run_node) = node_by_source(conn, SourceKind::FleetRun, fleet_run_id)? else {
        return Ok(None);
    };
    if let Some(node) = node_by_source(conn, SourceKind::FleetTask, task_id)? {
        return Ok(Some(node.id));
    }
    let parent_node = match parent_task_id {
        Some(parent) => node_by_source(conn, SourceKind::FleetTask, parent)?
            .filter(|node| node.run_id == run_node.run_id),
        None => None,
    };
    let parent_id = parent_node.as_ref().map_or(run_node.id.as_str(), |node| node.id.as_str());
    insert_node(
        conn,
        &run_node.run_id,
        Some(parent_id),
        NodeKind::FleetTask,
        task_id,
        &fleet_task_legacy_ref(task_id),
        now,
    )
    .map(Some)
}

/// Os nós gravados nos runs das conversas dadas (a linhagem inteira de uma árvore), em lotes
/// limitados como o resto da projeção.
pub fn nodes_for_threads(
    conn: &Connection,
    thread_ids: &[String],
) -> rusqlite::Result<Vec<NodeLink>> {
    let mut links = Vec::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT n.id, n.legacy_ref, n.run_id, p.legacy_ref
             FROM harness_node n
             JOIN harness_run r ON r.id = n.run_id
             LEFT JOIN harness_node p ON p.id = n.parent_id
             WHERE r.thread_id IN ({placeholders})
             ORDER BY n.created_at, n.rowid"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
            Ok(NodeLink {
                node_id: row.get(0)?,
                legacy_ref: row.get(1)?,
                harness_run_id: row.get(2)?,
                parent_legacy_ref: row.get(3)?,
            })
        })?;
        for row in rows {
            links.push(row?);
        }
    }
    Ok(links)
}
