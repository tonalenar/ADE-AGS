//! Detecção de missões duplicadas (mesmo título + objetivo, em andamento ou recente).
//!
//! Evita iniciar missões duplicadas por engano (por exemplo, duplo clique ou reexecuções
//! acidentais enquanto uma anterior ainda está em andamento ou foi iniciada recentemente).

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Janela padrão para considerar uma missão recente: 24 horas (em segundos).
pub const RECENT_MISSION_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMission {
    pub id: String,
    pub title: String,
    pub status: String,
    pub is_running: bool,
    pub is_recent: bool,
    pub created_at: i64,
    pub started_at: Option<i64>,
}

/// Normaliza o texto para comparação: espaços em branco múltiplos viram espaço único
/// e tudo é convertido para minúsculas. Pura.
pub fn normalize_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Verifica se já existe uma missão com o mesmo título e objetivo:
/// - em andamento (`running`), ou
/// - recente (criada ou iniciada nas últimas 24h).
pub fn check_duplicate(
    conn: &Connection,
    current_id: Option<&str>,
    workspace_id: Option<&str>,
    cwd: Option<&str>,
    title: &str,
    objective: Option<&str>,
    now: i64,
) -> Result<Option<DuplicateMission>, String> {
    let norm_title = normalize_text(title);
    if norm_title.is_empty() {
        return Ok(None);
    }
    let norm_obj = objective.map(normalize_text);

    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, cwd, title, objective, status, created_at, started_at \
             FROM missions \
             WHERE (?1 IS NULL OR id != ?1) \
               AND (?2 IS NULL OR workspace_id = ?2) \
               AND (?3 IS NULL OR cwd = ?3)",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([current_id, workspace_id, cwd], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (id, _ws, _cwd, m_title, m_obj, status, created_at, started_at) =
            row.map_err(|e| e.to_string())?;

        if normalize_text(&m_title) != norm_title {
            continue;
        }

        if let Some(target_obj) = &norm_obj {
            if normalize_text(&m_obj) != *target_obj {
                continue;
            }
        }

        let is_running = status == "running";
        let timestamp = started_at.unwrap_or(created_at);
        let is_recent = (now - timestamp).abs() <= RECENT_MISSION_SECS;

        if is_running || is_recent {
            return Ok(Some(DuplicateMission {
                id,
                title: m_title,
                status,
                is_running,
                is_recent,
                created_at,
                started_at,
            }));
        }
    }

    Ok(None)
}

/// Checa se uma missão específica tem uma duplicata em andamento ou recente.
pub fn check_mission_duplicate(
    conn: &Connection,
    mission_id: &str,
    now: i64,
) -> Result<Option<DuplicateMission>, String> {
    let (workspace_id, cwd, title, objective): (String, String, String, String) = conn
        .query_row(
            "SELECT workspace_id, cwd, title, objective FROM missions WHERE id = ?1",
            [mission_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    check_duplicate(
        conn,
        Some(mission_id),
        Some(&workspace_id),
        Some(&cwd),
        &title,
        Some(&objective),
        now,
    )
}

#[cfg(test)]
mod test {
    use super::*;

    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE missions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                objective TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                started_at INTEGER
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn detects_running_duplicate_mission() {
        let conn = create_test_db();
        let now = 100_000;
        conn.execute(
            "INSERT INTO missions (id, workspace_id, cwd, title, objective, status, created_at, started_at) \
             VALUES ('m1', 'w1', '/project', 'Refatorar auth', 'Migrar JWT', 'running', ?1, ?2)",
            [now - 3600 * 48, now - 3600 * 48],
        )
        .unwrap();

        let dup = check_duplicate(
            &conn,
            Some("m2"),
            Some("w1"),
            Some("/project"),
            "  Refatorar   auth  ",
            Some("Migrar JWT"),
            now,
        )
        .unwrap();

        assert!(dup.is_some());
        let d = dup.unwrap();
        assert_eq!(d.id, "m1");
        assert!(d.is_running);
    }

    #[test]
    fn detects_recent_duplicate_mission() {
        let conn = create_test_db();
        let now = 100_000;
        conn.execute(
            "INSERT INTO missions (id, workspace_id, cwd, title, objective, status, created_at, started_at) \
             VALUES ('m1', 'w1', '/project', 'Refatorar auth', 'Migrar JWT', 'cancelled', ?1, ?2)",
            [now - 1800, now - 1800],
        )
        .unwrap();

        let dup = check_duplicate(
            &conn,
            Some("m2"),
            Some("w1"),
            Some("/project"),
            "Refatorar auth",
            Some("Migrar JWT"),
            now,
        )
        .unwrap();

        assert!(dup.is_some());
        let d = dup.unwrap();
        assert_eq!(d.id, "m1");
        assert!(!d.is_running);
        assert!(d.is_recent);
    }

    #[test]
    fn ignores_self_and_different_missions() {
        let conn = create_test_db();
        let now = 100_000;
        conn.execute(
            "INSERT INTO missions (id, workspace_id, cwd, title, objective, status, created_at, started_at) \
             VALUES ('m1', 'w1', '/project', 'Refatorar auth', 'Migrar JWT', 'running', ?1, ?2)",
            [now, now],
        )
        .unwrap();

        // Mesma missão
        let self_dup = check_duplicate(
            &conn,
            Some("m1"),
            Some("w1"),
            Some("/project"),
            "Refatorar auth",
            Some("Migrar JWT"),
            now,
        )
        .unwrap();
        assert!(self_dup.is_none());

        // Objetivo diferente
        let diff_obj = check_duplicate(
            &conn,
            Some("m2"),
            Some("w1"),
            Some("/project"),
            "Refatorar auth",
            Some("Outro objetivo"),
            now,
        )
        .unwrap();
        assert!(diff_obj.is_none());

        // Título diferente
        let diff_title = check_duplicate(
            &conn,
            Some("m2"),
            Some("w1"),
            Some("/project"),
            "Outro titulo",
            Some("Migrar JWT"),
            now,
        )
        .unwrap();
        assert!(diff_title.is_none());
    }

    #[test]
    fn ignores_old_non_running_mission() {
        let conn = create_test_db();
        let now = 100_000;
        conn.execute(
            "INSERT INTO missions (id, workspace_id, cwd, title, objective, status, created_at, started_at) \
             VALUES ('m1', 'w1', '/project', 'Refatorar auth', 'Migrar JWT', 'done', ?1, ?2)",
            [now - (RECENT_MISSION_SECS + 100), now - (RECENT_MISSION_SECS + 100)],
        )
        .unwrap();

        let dup = check_duplicate(
            &conn,
            Some("m2"),
            Some("w1"),
            Some("/project"),
            "Refatorar auth",
            Some("Migrar JWT"),
            now,
        )
        .unwrap();
        assert!(dup.is_none());
    }
}
