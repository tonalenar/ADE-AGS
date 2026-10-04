//! Tiempo activo de una misión: solo cuenta mientras algún agente trabaja.
//!
//! El reloj de pared (de `started_at` a `ended_at`) sigue corriendo con todos los agentes
//! esperando al usuario, y eso no es tiempo de trabajo. El frontend, que es quien ve la
//! actividad de cada terminal, manda aquí lo trabajado en bloques cortos.

use rusqlite::{params, Connection};

/// Un bloque más largo que esto es un error del reloj, no trabajo (5 min).
const MAX_CHUNK_MS: i64 = 5 * 60 * 1000;

pub fn add(conn: &Connection, mission_id: &str, ms: i64) -> Result<(), String> {
    if ms <= 0 {
        return Ok(());
    }
    let ms = ms.min(MAX_CHUNK_MS);
    // Solo se acumula sobre una misión que exista y siga en curso.
    conn.execute(
        "INSERT INTO mission_active (mission_id, active_ms)
         SELECT id, ?2 FROM missions WHERE id = ?1 AND status = 'running'
         ON CONFLICT(mission_id) DO UPDATE SET active_ms = active_ms + excluded.active_ms",
        params![mission_id, ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT NOT NULL);
             CREATE TABLE mission_active (mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE, active_ms INTEGER NOT NULL DEFAULT 0);
             INSERT INTO missions VALUES ('run','running'), ('done','done');",
        )
        .unwrap();
        conn
    }

    fn total(conn: &Connection, id: &str) -> Option<i64> {
        conn.query_row("SELECT active_ms FROM mission_active WHERE mission_id = ?1", [id], |r| r.get(0)).ok()
    }

    #[test]
    fn acumula_solo_en_misiones_en_curso() {
        let conn = db();
        add(&conn, "run", 4_000).unwrap();
        add(&conn, "run", 6_000).unwrap();
        assert_eq!(total(&conn, "run"), Some(10_000));
        add(&conn, "done", 4_000).unwrap();
        add(&conn, "no-existe", 4_000).unwrap();
        assert_eq!(total(&conn, "done"), None);
        assert_eq!(total(&conn, "no-existe"), None);
    }

    #[test]
    fn ignora_bloques_invalidos_y_recorta_los_enormes() {
        let conn = db();
        add(&conn, "run", 0).unwrap();
        add(&conn, "run", -5).unwrap();
        assert_eq!(total(&conn, "run"), None);
        add(&conn, "run", 10 * 60 * 1000).unwrap();
        assert_eq!(total(&conn, "run"), Some(MAX_CHUNK_MS));
    }
}
