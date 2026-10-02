//! El pet: la mascota sube de nivel con lo que trabajan tus agentes.
//!
//! La experiencia (XP) son tokens: los que Claude Code deja anotados en sus transcripts
//! (entrada, salida y escritura de caché — la lectura de caché no cuenta: es el 90 % del
//! volumen y no es trabajo nuevo) más los que gastó la frota de la app (el ledger). Cada
//! minuto se mira el total, y lo que creció desde la última vez se suma al XP guardado.
//!
//! ## Por qué se acumula en vez de leerse
//!
//! Los transcripts solo dan la última semana, y ese total BAJA cuando un día viejo sale de
//! la ventana. Si el nivel saliera directo de ahí, el pet retrocedería. Con el acumulado,
//! el XP solo sube: un descenso del total no se resta, y el crecimiento posterior vuelve a
//! contar desde el nuevo nivel base.
//!
//! La primera vez, lo que ya hay en la semana cuenta como punto de partida (el pet nace con
//! algo de camino hecho, no en cero con meses de trabajo atrás).
//!
//! Las curvas están acá, no en la pantalla: el nivel que se muestra y el que se guarda no
//! pueden discrepar.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::DbConnection;

const XP_KEY: &str = "pet.xp";
const SEEN_KEY: &str = "pet.seen";
/// Cada cuánto se mira el total.
const TICK: Duration = Duration::from_secs(60);
/// Un tope para el nivel: más allá no hay más formas, y evita desbordes con números absurdos.
pub const MAX_LEVEL: u32 = 99;
/// Tokens del primer nivel: el escalón crece de ahí con `LEVEL_POWER`.
const LEVEL_UNIT: f64 = 10_000_000.0;
const LEVEL_POWER: f64 = 1.5;

/// El XP con que arranca un nivel: 0, 10 M, 28 M, 52 M, 80 M, 112 M… (`10 M · (n-1)^1,5`).
pub fn threshold(level: u32) -> u64 {
    if level <= 1 {
        return 0;
    }
    (LEVEL_UNIT * f64::from(level - 1).powf(LEVEL_POWER)).round() as u64
}

/// El nivel de un XP.
pub fn level_for(xp: u64) -> u32 {
    let mut level = 1;
    while level < MAX_LEVEL && xp >= threshold(level + 1) {
        level += 1;
    }
    level
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStatus {
    pub xp: u64,
    pub level: u32,
    /// XP que se lleva dentro del nivel actual.
    pub into_level: u64,
    /// XP que falta para el siguiente (0 en el último nivel).
    pub to_next: u64,
    /// Qué parte del nivel está hecha, de 0 a 1.
    pub progress: f64,
}

pub fn status_for(xp: u64) -> PetStatus {
    let level = level_for(xp);
    let start = threshold(level);
    let into_level = xp - start;
    if level >= MAX_LEVEL {
        return PetStatus { xp, level, into_level, to_next: 0, progress: 1.0 };
    }
    let span = threshold(level + 1) - start;
    PetStatus { xp, level, into_level, to_next: span - into_level, progress: into_level as f64 / span as f64 }
}

/// Suma lo nuevo al XP. Devuelve el XP y el total visto ahora. Un total más bajo que el
/// anterior (un día viejo salió de la semana) no resta nada.
pub fn accrue(xp: u64, seen: u64, current: u64) -> (u64, u64) {
    (xp.saturating_add(current.saturating_sub(seen)), current)
}

fn read_u64(db: &DbConnection, key: &str) -> u64 {
    crate::database::get_setting(db, key).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Lo que gastó la frota, en tokens, desde siempre.
fn fleet_tokens(db: &DbConnection) -> u64 {
    let Ok(conn) = db.lock() else { return 0 };
    conn.query_row("SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) FROM usage_events", [], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
}

/// Lo que dicen los transcripts de Claude Code para la última semana, sin la lectura de caché.
fn claude_week_tokens(app: &AppHandle) -> u64 {
    let state = app.state::<DbConnection>();
    let usage = tauri::async_runtime::block_on(crate::usage::agent_account_usage("claude-code".into(), None, state));
    let Ok(usage) = usage else { return 0 };
    usage
        .windows
        .iter()
        .find(|w| w.key == "7d")
        .map(|w| w.input_tokens + w.output_tokens + w.cache_write_tokens)
        .unwrap_or(0)
}

/// Una vuelta: mira el total, acumula y avisa a la pantalla si el XP cambió.
fn tick(app: &AppHandle) {
    let Some(db) = app.try_state::<DbConnection>().map(|s| s.inner().clone()) else { return };
    let current = claude_week_tokens(app) + fleet_tokens(&db);
    let (xp, seen) = (read_u64(&db, XP_KEY), read_u64(&db, SEEN_KEY));
    let (next_xp, next_seen) = accrue(xp, seen, current);
    if next_seen != seen {
        let _ = crate::database::set_setting(&db, SEEN_KEY, &next_seen.to_string());
    }
    if next_xp != xp {
        let _ = crate::database::set_setting(&db, XP_KEY, &next_xp.to_string());
        let _ = app.emit("cc-pet-changed", status_for(next_xp));
    }
}

/// Arranca el contador. Espera un poco al principio: el arranque de la app ya tiene bastante.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        loop {
            tick(&app);
            std::thread::sleep(TICK);
        }
    });
}

#[tauri::command]
pub fn pet_status(db: tauri::State<'_, DbConnection>) -> PetStatus {
    status_for(read_u64(&db, XP_KEY))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn los_umbrales_crecen_y_arrancan_en_cero() {
        assert_eq!(threshold(1), 0);
        assert_eq!(threshold(2), 10_000_000);
        assert_eq!(threshold(3), 28_284_271);
        let mut last = 0;
        for level in 1..=MAX_LEVEL {
            assert!(threshold(level) >= last, "el nivel {level} no puede pedir menos que el anterior");
            last = threshold(level);
        }
    }

    #[test]
    fn el_nivel_cambia_exactamente_en_el_umbral() {
        assert_eq!(level_for(0), 1);
        assert_eq!(level_for(9_999_999), 1);
        assert_eq!(level_for(10_000_000), 2);
        assert_eq!(level_for(28_284_270), 2);
        assert_eq!(level_for(28_284_271), 3);
        assert_eq!(level_for(u64::MAX), MAX_LEVEL, "un número absurdo no desborda");
    }

    #[test]
    fn el_estado_dice_cuanto_falta() {
        let s = status_for(15_000_000);
        assert_eq!((s.level, s.into_level), (2, 5_000_000));
        assert_eq!(s.to_next, threshold(3) - 15_000_000);
        assert!((s.progress - 5_000_000.0 / (threshold(3) - threshold(2)) as f64).abs() < 1e-9);
        assert_eq!(status_for(0).progress, 0.0);
        let top = status_for(threshold(MAX_LEVEL) + 5);
        assert_eq!((top.level, top.to_next, top.progress), (MAX_LEVEL, 0, 1.0));
    }

    #[test]
    fn el_xp_solo_sube() {
        // Primera vez: lo que ya había en la semana es el punto de partida.
        assert_eq!(accrue(0, 0, 40_000_000), (40_000_000, 40_000_000));
        // Crece: se suma lo nuevo.
        assert_eq!(accrue(40_000_000, 40_000_000, 45_000_000), (45_000_000, 45_000_000));
        // Un día viejo sale de la semana: el total baja, el XP no.
        assert_eq!(accrue(45_000_000, 45_000_000, 30_000_000), (45_000_000, 30_000_000));
        // Y el crecimiento posterior cuenta desde el nuevo total.
        assert_eq!(accrue(45_000_000, 30_000_000, 32_000_000), (47_000_000, 32_000_000));
        assert_eq!(accrue(u64::MAX, 0, 10), (u64::MAX, 10), "sin desborde");
    }
}
