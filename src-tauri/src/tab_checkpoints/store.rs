//! As fichas dos pontos de restauração (`tab_checkpoints`). O conteúdo está no git; aqui fica o
//! que a tela mostra (quando, a primeira linha da mensagem, quem mandou) e onde achar a ref.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Quantos pontos uma aba guarda; os mais velhos saem (a ficha e a ref).
pub const MAX_PER_TAB: i64 = 50;

pub mod kind {
    /// Antes de uma mensagem chegar ao agente.
    pub const MESSAGE: &str = "message";
    /// "Marcar ponto", a pedido da pessoa.
    pub const MANUAL: &str = "manual";
    /// O estado de logo antes de uma restauração: é o que a desfaz.
    pub const SAFETY: &str = "safety";
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabCheckpoint {
    pub id: String,
    pub tab_id: String,
    /// O número do ponto na aba (`refs/ags/checkpoints/<aba>/<seq>`).
    pub seq: i64,
    pub kind: String,
    /// Quem mandou a mensagem: `pessoa`, `ags`, `peer`, `chat`, `rotina`…
    pub author: String,
    /// A primeira linha da mensagem (cortada), ou o rótulo do ponto manual.
    pub message: String,
    pub repo_root: String,
    pub ref_name: String,
    pub commit_sha: String,
    pub tree_sha: String,
    pub head_sha: Option<String>,
    /// Milissegundos.
    pub created_at: i64,
}

/// Só aditiva e idempotente, sem subir `user_version` (como as outras do fim de `schema.rs`).
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tab_checkpoints (
            id TEXT PRIMARY KEY,
            tab_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            repo_root TEXT NOT NULL,
            ref_name TEXT NOT NULL,
            commit_sha TEXT NOT NULL,
            tree_sha TEXT NOT NULL,
            head_sha TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tab_checkpoints_seq ON tab_checkpoints(tab_id, seq);",
    )
}

const COLS: &str = "id, tab_id, seq, kind, author, message, repo_root, ref_name, commit_sha, tree_sha, head_sha, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<TabCheckpoint> {
    Ok(TabCheckpoint {
        id: r.get(0)?,
        tab_id: r.get(1)?,
        seq: r.get(2)?,
        kind: r.get(3)?,
        author: r.get(4)?,
        message: r.get(5)?,
        repo_root: r.get(6)?,
        ref_name: r.get(7)?,
        commit_sha: r.get(8)?,
        tree_sha: r.get(9)?,
        head_sha: r.get(10)?,
        created_at: r.get(11)?,
    })
}

pub fn insert(conn: &Connection, c: &TabCheckpoint) -> Result<(), String> {
    conn.execute(
        &format!("INSERT INTO tab_checkpoints ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
        params![
            c.id, c.tab_id, c.seq, c.kind, c.author, c.message, c.repo_root, c.ref_name, c.commit_sha, c.tree_sha,
            c.head_sha, c.created_at
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Os pontos da aba, o mais novo primeiro.
pub fn list(conn: &Connection, tab_id: &str) -> Result<Vec<TabCheckpoint>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM tab_checkpoints WHERE tab_id = ?1 ORDER BY seq DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([tab_id], row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<TabCheckpoint>, String> {
    conn.query_row(&format!("SELECT {COLS} FROM tab_checkpoints WHERE id = ?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn last(conn: &Connection, tab_id: &str) -> Result<Option<TabCheckpoint>, String> {
    conn.query_row(&format!("SELECT {COLS} FROM tab_checkpoints WHERE tab_id = ?1 ORDER BY seq DESC LIMIT 1"), [tab_id], row)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn next_seq(conn: &Connection, tab_id: &str) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM tab_checkpoints WHERE tab_id = ?1", [tab_id], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Tira as fichas além das `keep` mais novas da aba e devolve as que saíram (para soltar as refs).
pub fn evict_beyond(conn: &Connection, tab_id: &str, keep: i64) -> Result<Vec<TabCheckpoint>, String> {
    let all = list(conn, tab_id)?;
    let gone: Vec<TabCheckpoint> = all.into_iter().skip(keep.max(0) as usize).collect();
    for c in &gone {
        conn.execute("DELETE FROM tab_checkpoints WHERE id = ?1", [&c.id]).map_err(|e| e.to_string())?;
    }
    Ok(gone)
}

/// Tira todas as fichas da aba e devolve as que saíram.
pub fn remove_tab(conn: &Connection, tab_id: &str) -> Result<Vec<TabCheckpoint>, String> {
    evict_beyond(conn, tab_id, 0)
}

/// As abas com pontos que já não existem: nem salvas (`tabs`), nem em `alive`, e cujo ponto mais
/// novo é anterior a `before_ms` (uma aba recém-aberta pode ainda não ter sido salva).
pub fn orphan_tabs(conn: &Connection, alive: &[String], before_ms: i64) -> Result<Vec<String>, String> {
    let saved_tabs = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tabs'", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        > 0;
    let sql = if saved_tabs {
        "SELECT tab_id FROM tab_checkpoints GROUP BY tab_id
         HAVING MAX(created_at) < ?1 AND tab_id NOT IN (SELECT id FROM tabs)"
    } else {
        "SELECT tab_id FROM tab_checkpoints GROUP BY tab_id HAVING MAX(created_at) < ?1"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([before_ms], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).filter(|t| !alive.contains(t)).collect())
}
