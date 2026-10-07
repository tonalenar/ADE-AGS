//! Apertura de la base y el handle compartido que usa el resto de la app.
//!
//! Acá NO hay consultas: solo dónde vive el archivo, cómo se abre y en qué orden se deja
//! listo (migrar → sembrar → limpiar). El SQL vive en `queries`, el schema en `schema`.

use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

/// Abre (o crea) la base del usuario y la deja lista para usar.
pub fn init_db() -> SqlResult<DbConnection> {
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

    backup_before_upgrade(&conn, &path)?;
    super::schema::migrate(&conn)?;
    super::seeds::seed_defaults(&conn)?;
    super::queries::dedupe_session_history_once(&conn)?;

    // Las ventanas cerradas que no guardan tabs no representan nada y se acumulan: una por
    // cierre, y una por intento cuando un arranque falla en bucle.
    let purgadas = super::queries::purge_empty_closed_windows(&conn)?;
    if purgadas > 0 {
        eprintln!("se limpiaron {purgadas} filas de ventanas cerradas y vacías");
    }

    Ok(Arc::new(Mutex::new(conn)))
}

/// SQLite produces a consistent backup, including committed WAL pages. A failed
/// backup aborts startup before migrations; copying the main file alone is unsafe.
fn backup_before_upgrade(conn: &Connection, path: &std::path::Path) -> SqlResult<()> {
    let version:i32=conn.pragma_query_value(None,"user_version",|r|r.get(0))?;
    if version>0 && version<super::schema::SCHEMA_VERSION {
        let backup=path.with_extension(format!("v{version}-{}.backup",uuid::Uuid::new_v4()));
        conn.execute("VACUUM INTO ?1",[backup.to_string_lossy().as_ref()])?;
    }
    Ok(())
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[test]
    fn upgrading_copies_committed_wal_data_before_schema_changes() {
        let root=std::env::temp_dir().join(format!("ade-db-backup-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&root).unwrap();
        let path=root.join("isolated.sqlite");let c=Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE preserved(body TEXT);INSERT INTO preserved VALUES('keep');PRAGMA user_version=40;").unwrap();
        backup_before_upgrade(&c,&path).unwrap();
        let backup=std::fs::read_dir(&root).unwrap().map(|e|e.unwrap().path()).find(|p|p.extension().is_some_and(|ext|ext=="backup")).unwrap();
        let copy=Connection::open(&backup).unwrap();assert_eq!(copy.query_row("SELECT body FROM preserved",[],|r|r.get::<_,String>(0)).unwrap(),"keep");assert_eq!(copy.pragma_query_value(None,"user_version",|r|r.get::<_,i32>(0)).unwrap(),40);
        c.pragma_update(None,"user_version",super::super::schema::SCHEMA_VERSION).unwrap();backup_before_upgrade(&c,&path).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().map(|e|e.unwrap().path()).filter(|p|p.extension().is_some_and(|e|e=="backup")).count(),1);
        drop(copy);drop(c);std::fs::remove_dir_all(root).unwrap();
    }
}
