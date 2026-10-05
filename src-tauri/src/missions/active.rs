//! Tiempo activo de una misión: solo cuenta mientras algún agente trabaja.
//!
//! El reloj de pared (de `started_at` a `ended_at`) sigue corriendo con todos los agentes
//! esperando al usuario, y eso no es tiempo de trabajo. El frontend, que es quien ve la
//! actividad de cada terminal, manda aquí lo trabajado en bloques cortos.

use rusqlite::{params, Connection, OptionalExtension};

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

/// De onde vem o tempo ativo mostrado: `mission_active` (trabalho real, medido pelo frontend),
/// a união dos spans `turn` e `peer_ask` ou, por último, o relógio de parede.
pub const SOURCE_RECORDED: &str = "mission_active";
pub const SOURCE_SPANS: &str = "spans";
pub const SOURCE_WALL: &str = "wall";

/// Fonte oficial do tempo ativo. Uma só regra para lista, QG, painel e CLI.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub ms: Option<i64>,
    pub source: Option<&'static str>,
}

/// Escolhe a fonte: `mission_active` positivo manda; sem ele os spans; sem eles o relógio de
/// parede (só se a missão começou); sem nada, `None` (nunca se inventa número). Pura.
pub fn choose(recorded_ms: Option<i64>, spans_ms: Option<i64>, wall_ms: Option<i64>) -> Resolved {
    match (recorded_ms.filter(|ms| *ms > 0), spans_ms, wall_ms) {
        (Some(ms), _, _) => Resolved { ms: Some(ms), source: Some(SOURCE_RECORDED) },
        (None, Some(ms), _) => Resolved { ms: Some(ms), source: Some(SOURCE_SPANS) },
        (None, None, Some(ms)) => Resolved { ms: Some(ms), source: Some(SOURCE_WALL) },
        (None, None, None) => Resolved { ms: None, source: None },
    }
}

/// Relógio de parede da missão em ms; `None` se ainda não começou.
pub fn wall_ms(started_at: Option<i64>, ended_at: Option<i64>, now: i64) -> Option<i64> {
    started_at.map(|start| ended_at.unwrap_or(now).saturating_sub(start).max(0).saturating_mul(1000))
}

/// O que `mission_active` guardou para a missão; `None` sem linha (missões antigas).
pub fn recorded(conn: &Connection, mission_id: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT active_ms FROM mission_active WHERE mission_id = ?1", [mission_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn resolve(conn: &Connection, mission_id: &str, spans_ms: Option<i64>, wall_ms: Option<i64>) -> Result<Resolved, String> {
    Ok(choose(recorded(conn, mission_id)?, spans_ms, wall_ms))
}

/// Resolve lendo spans e relógio da própria missão (para quem não os tem à mão, como a lista).
pub fn resolve_mission(conn: &Connection, mission_id: &str, started_at: Option<i64>, ended_at: Option<i64>, now: i64) -> Result<Resolved, String> {
    let spans = super::timings::list(conn, mission_id)?;
    resolve(conn, mission_id, super::efficiency::turn_ms(&spans), wall_ms(started_at, ended_at, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escolhe_mission_active_e_cai_nos_spans_sem_inventar() {
        assert_eq!(choose(Some(9_000), Some(2_000), Some(50_000)), Resolved { ms: Some(9_000), source: Some(SOURCE_RECORDED) });
        assert_eq!(choose(None, Some(2_000), Some(50_000)), Resolved { ms: Some(2_000), source: Some(SOURCE_SPANS) });
        assert_eq!(choose(Some(0), Some(2_000), None).source, Some(SOURCE_SPANS), "zero gravado não é medição");
        assert_eq!(choose(None, None, Some(50_000)), Resolved { ms: Some(50_000), source: Some(SOURCE_WALL) });
        assert_eq!(choose(None, None, None), Resolved { ms: None, source: None });
        assert_eq!(wall_ms(None, None, 99), None);
        assert_eq!(wall_ms(Some(10), Some(14), 99), Some(4_000));
        assert_eq!(wall_ms(Some(10), None, 12), Some(2_000));
        let conn = db();
        assert_eq!(resolve(&conn, "run", Some(1_500), None).unwrap().source, Some(SOURCE_SPANS));
        add(&conn, "run", 4_000).unwrap();
        assert_eq!(resolve(&conn, "run", Some(1_500), None).unwrap().ms, Some(4_000));
    }

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
