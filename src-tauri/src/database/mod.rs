//! Persistencia SQLite de la app.
//!
//! - [`connection`] — dónde vive la base, cómo se abre y el handle compartido.
//! - [`schema`] — el DDL y sus migraciones.
//! - [`seeds`] — las filas que la app siembra sola al primer arranque.
//! - [`models`] — los tipos que viajan al frontend.
//! - [`queries`] — el SQL, agrupado por dominio.

mod connection;
mod models;
mod wal;
mod queries;
mod schema;
mod seeds;
#[cfg(test)]
mod test;

pub use wal::spawn_wal_maintenance;
pub(crate) use connection::user_db_path;
pub use connection::{
    __cmd__db_boot_status, __tauri_command_name_db_boot_status, DbConnection, db_boot_status,
    db_upgrade_pending, finish_db, mark_db_ready, prepare_db, wait_until_db_ready,
};
pub use schema::migrate;

pub use models::*;
pub use queries::*;
/// Base en memoria con el schema real, para los tests de cualquier módulo.
#[cfg(test)]
pub(crate) use schema::in_memory as test_db;
/// La migración real, para probar saltos de versión desde otros módulos.
#[cfg(test)]
pub(crate) use schema::migrate as migrate_for_tests;
