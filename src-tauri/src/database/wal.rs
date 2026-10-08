//! Checkpoint del WAL fuera del purge.
//!
//! El purge ya hace `wal_checkpoint(TRUNCATE)`, pero solo cuando borra memoria. El autosave
//! de tabs escribe seguido y el `-wal` puede crecer con la app abierta y quieta. Este hilo
//! mira el archivo y, si pasa el techo, checkpointa sin esperar a que la UI suelte el
//! mutex: si la base está ocupada, lo intenta en la vuelta siguiente.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{user_db_path, DbConnection};

/// Por encima de esto se pide `wal_checkpoint(TRUNCATE)`. 8 MiB es bastante para el
/// autosave de unas pocas tabs y chico al lado de un `-wal` que se deja crecer una hora.
pub const WAL_CHECKPOINT_CEILING: u64 = 8 * 1024 * 1024;

const INTERVAL: Duration = Duration::from_secs(30);

/// SQLite nombra el sidecar `{archivo}-wal`, no `{stem}.wal`.
pub fn wal_sidecar(db_file: &Path) -> PathBuf {
    let mut name = db_file.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

pub fn wal_needs_checkpoint(size: u64, ceiling: u64) -> bool {
    size > ceiling
}

/// `true` si el `-wal` pasaba el techo y se pudo tomar la conexión para checkpointar.
/// `try_lock`: no se queda esperando detrás de un guardado de la UI.
pub fn checkpoint_wal(db: &DbConnection, db_file: &Path, ceiling: u64) -> bool {
    let wal = wal_sidecar(db_file);
    let size = std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0);
    if !wal_needs_checkpoint(size, ceiling) {
        return false;
    }
    let Ok(conn) = db.try_lock() else {
        return false;
    };
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    true
}

/// Hilo de fondo. No se arranca desde `init_db`: los tests abren la base del usuario.
///
/// Espera a que el upgrade de la onda 2 termine (`VACUUM INTO` + migración). Hasta
/// `mark_db_ready` el hilo no mira el `-wal` y no corre `wal_checkpoint`.
pub fn spawn_wal_maintenance(db: DbConnection) {
    let _ = std::thread::Builder::new().name("wal-checkpoint".into()).spawn(move || {
        super::connection::wait_until_db_ready();
        let path = user_db_path();
        loop {
            std::thread::sleep(INTERVAL);
            let _ = checkpoint_wal(&db, &path, WAL_CHECKPOINT_CEILING);
        }
    });
}

/// El guardado de la ventana no puede copiar el buffer del PTY con el mutex tomado.
#[cfg(test)]
fn save_window_source_avoids_pty_copy() {
    let src = include_str!("queries/windows.rs");
    let start = src.find("fn db_save_window_state_sync").expect("función");
    let rest = &src[start..];
    let end = rest.find("pub fn db_load_window_state").expect("función siguiente");
    let body = &rest[..end];
    let needle = ["scrollback", "_of"].concat();
    assert!(!body.contains(&needle), "db_save_window_state_sync no puede llamar al copiado del PTY");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    #[test]
    fn el_sidecar_es_el_archivo_con_sufijo_wal() {
        let path = wal_sidecar(Path::new("dir/data.db"));
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("data.db-wal"));
    }

    #[test]
    fn el_techo_deja_pasar_un_wal_chico() {
        assert!(!wal_needs_checkpoint(0, WAL_CHECKPOINT_CEILING));
        assert!(!wal_needs_checkpoint(WAL_CHECKPOINT_CEILING, WAL_CHECKPOINT_CEILING));
        assert!(wal_needs_checkpoint(WAL_CHECKPOINT_CEILING + 1, WAL_CHECKPOINT_CEILING));
    }

    #[test]
    fn bajo_el_techo_no_toca_la_conexion() {
        let dir = std::env::temp_dir().join(format!("ade-wal-bajo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES (1);").unwrap();
        let db = Arc::new(Mutex::new(conn));
        assert!(!checkpoint_wal(&db, &path, WAL_CHECKPOINT_CEILING));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_achica_un_wal_que_paso_el_techo() {
        let dir = std::env::temp_dir().join(format!("ade-wal-grande-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE t(b BLOB);",
        )
        .unwrap();
        let blob = vec![0u8; 64 * 1024];
        for _ in 0..80 {
            conn.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
        }
        let before = std::fs::metadata(wal_sidecar(&path)).unwrap().len();
        assert!(before > 1024 * 1024, "el wal de prueba quedó en {before} bytes");
        let db = Arc::new(Mutex::new(conn));
        assert!(checkpoint_wal(&db, &path, 1024 * 1024));
        let after = std::fs::metadata(wal_sidecar(&path)).map(|m| m.len()).unwrap_or(0);
        assert!(after < before, "el checkpoint no achicó el wal ({before} -> {after})");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_guardado_de_ventana_no_copia_el_pty_con_el_mutex() {
        save_window_source_avoids_pty_copy();
    }

    #[test]
    fn el_hilo_espera_el_upgrade_antes_de_checkpointar() {
        let src = include_str!("wal.rs");
        let start = src.find("fn spawn_wal_maintenance").expect("función");
        let body = &src[start..];
        let wait_at = body.find("wait_until_db_ready").expect("espera");
        let check_at = body.find("checkpoint_wal").expect("checkpoint");
        assert!(wait_at < check_at, "el checkpoint no puede correr antes de que termine el upgrade");
    }
}
