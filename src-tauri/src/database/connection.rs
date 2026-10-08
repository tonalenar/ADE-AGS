//! Apertura de la base y el handle compartido que usa el resto de la app.
//!
//! Acá NO hay consultas: solo dónde vive el archivo, cómo se abre y en qué orden se deja
//! listo (migrar → sembrar → limpiar). El SQL vive en `queries`, el schema en `schema`.

use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `false` mientras un upgrade de schema (copia + migración) no terminó. Las escrituras
/// de `settings` esperan esta bandera para no colarse en medio del `VACUUM INTO`.
static DB_READY: AtomicBool = AtomicBool::new(true);

pub fn mark_db_upgrading() {
    DB_READY.store(false, Ordering::SeqCst);
}

pub fn mark_db_ready() {
    DB_READY.store(true, Ordering::SeqCst);
}

pub fn db_is_ready() -> bool {
    DB_READY.load(Ordering::SeqCst)
}

pub fn db_upgrade_pending() -> bool {
    !db_is_ready()
}

/// Bloquea hasta que la base está en el schema de esta build. El splash es quien
/// impide que la UI dispare escrituras; esto cubre las que igual salen (el idioma).
pub fn wait_until_db_ready() {
    while !db_is_ready() {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbBootStatus {
    pub phase: &'static str,
}

#[tauri::command]
pub fn db_boot_status() -> DbBootStatus {
    DbBootStatus {
        phase: if db_is_ready() { "ready" } else { "upgrading" },
    }
}

/// La conexión es única y compartida por toda la app: SQLite en modo por defecto no
/// admite escrituras concurrentes, así que el `Mutex` es el que serializa el acceso.
pub type DbConnection = Arc<Mutex<Connection>>;

pub(crate) fn user_db_path() -> PathBuf {
    db_path()
}

fn db_path() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let dir = home.join(".ags");
    std::fs::create_dir_all(&dir).expect("Cannot create ~/.ags");
    dir.join("data.db")
}

/// Abre el archivo y deja WAL y las claves foráneas. No migra.
fn open_configured() -> SqlResult<DbConnection> {
    let path = db_path();
    let conn = Connection::open(&path)?;

    // SQLite trae el enforcement de FK apagado por defecto en cada conexión — sin esto,
    // todos los `ON DELETE CASCADE` del schema (workspaces→windows→tabs→project_skills,
    // skills→project_skills, workspaces→session_history) son un no-op silencioso: borrar
    // un workspace/ventana/skill deja filas huérfanas en las tablas hijas para siempre
    // en vez de limpiarlas.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // WAL: un commit escribe al final del log en vez de reescribir páginas con doble fsync,
    // que es lo que hacía que guardar las tabs o el progreso de la flota se notara.
    // `synchronous=NORMAL` es lo seguro en WAL (un corte de luz pierde a lo sumo la última
    // transacción, nunca corrompe), y `busy_timeout` espera en vez de fallar con
    // SQLITE_BUSY si otro proceso (la CLI, un `sqlite3` abierto) tiene la base un momento.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;

    Ok(Arc::new(Mutex::new(conn)))
}

fn needs_upgrade(conn: &DbConnection) -> SqlResult<bool> {
    let guard = conn.lock().unwrap_or_else(|err| err.into_inner());
    let version: i32 = guard.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(version > 0 && version < super::schema::SCHEMA_VERSION)
}

/// Abre la base. Si ya está en el schema de esta build (o es nueva: no hay `VACUUM`),
/// la deja lista acá. Si hay que subir de versión, no copia ni migra: la ventana tiene
/// que poder pintarse con el aviso de "actualizando datos" antes de ese trabajo.
pub fn prepare_db() -> SqlResult<(DbConnection, bool)> {
    let conn = open_configured()?;
    let pending = needs_upgrade(&conn)?;
    if pending {
        mark_db_upgrading();
    } else {
        finish_db(&conn)?;
        mark_db_ready();
    }
    Ok((conn, pending))
}

/// Abre (o crea) la base del usuario y la deja lista para usar.
///
/// El arranque usa [`prepare_db`]: si hay que subir el schema, la copia y la migración
/// no corren acá. Esta queda para quien necesita el camino completo en el mismo hilo.
#[allow(dead_code)]
pub fn init_db() -> SqlResult<DbConnection> {
    let conn = open_configured()?;
    finish_db(&conn)?;
    Ok(conn)
}

/// Copia consistente y migración, en ese orden, más la siembra y la limpieza.
///
/// Quien llama sostiene que nadie más está escribiendo un schema viejo: o esto corre
/// antes de que exista la ventana, o la UI está en el splash y las escrituras esperan
/// [`wait_until_db_ready`].
pub fn finish_db(conn: &DbConnection) -> SqlResult<()> {
    let path = db_path();
    let guard = conn.lock().unwrap_or_else(|err| err.into_inner());
    upgrade_schema(&guard, &path)
}

pub(crate) fn upgrade_schema(conn: &Connection, path: &std::path::Path) -> SqlResult<()> {
    backup_before_upgrade(conn, path)?;
    super::schema::migrate(conn)?;
    super::seeds::seed_defaults(conn)?;
    super::queries::dedupe_session_history_once(conn)?;

    // Las ventanas cerradas que no guardan tabs no representan nada y se acumulan: una por
    // cierre, y una por intento cuando un arranque falla en bucle.
    let purgadas = super::queries::purge_empty_closed_windows(conn)?;
    if purgadas > 0 {
        eprintln!("se limpiaron {purgadas} filas de ventanas cerradas y vacías");
    }
    Ok(())
}

/// SQLite produces a consistent backup, including committed WAL pages. A failed
/// backup aborts startup before migrations; copying the main file alone is unsafe.
fn backup_before_upgrade(conn: &Connection, path: &std::path::Path) -> SqlResult<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 0 && version < super::schema::SCHEMA_VERSION {
        let backup = path.with_extension(format!("v{version}-{}.backup", uuid::Uuid::new_v4()));
        conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])?;
    }
    Ok(())
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[test]
    fn upgrading_copies_committed_wal_data_before_schema_changes() {
        let root = std::env::temp_dir().join(format!("ade-db-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("isolated.sqlite");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE preserved(body TEXT);INSERT INTO preserved VALUES('keep');PRAGMA user_version=40;").unwrap();
        backup_before_upgrade(&c, &path).unwrap();
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|ext| ext == "backup"))
            .unwrap();
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(
            copy.query_row("SELECT body FROM preserved", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            copy.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
                .unwrap(),
            40
        );
        c.pragma_update(None, "user_version", super::super::schema::SCHEMA_VERSION)
            .unwrap();
        backup_before_upgrade(&c, &path).unwrap();
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|e| e == "backup"))
                .count(),
            1
        );
        drop(copy);
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn una_base_v40_llega_a_41_y_el_backup_existe() {
        let root = std::env::temp_dir().join(format!("ade-db-v40-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .unwrap();
        super::super::schema::migrate(&conn).unwrap();
        assert_eq!(user_version(&conn), super::super::schema::SCHEMA_VERSION);

        // El schema de esta build ya está aplicado. Se simula una base que se quedó en
        // v40: sin la columna que v41 agrega, y con `user_version` atrás.
        conn.execute("ALTER TABLE workspaces DROP COLUMN deleted_at", [])
            .unwrap();
        conn.pragma_update(None, "user_version", 40).unwrap();
        assert!(
            conn.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_err()
        );

        upgrade_schema(&conn, &path).unwrap();

        assert_eq!(user_version(&conn), 41);
        assert!(
            conn.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_ok()
        );
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|candidate| candidate.extension().is_some_and(|ext| ext == "backup"))
            .expect("el upgrade deja una copia");
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(user_version(&copy), 40, "la copia es la de antes de migrar");
        assert!(
            copy.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_err(),
            "la copia no incluye el schema nuevo"
        );
        drop(copy);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn user_version(conn: &Connection) -> i32 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }
}
