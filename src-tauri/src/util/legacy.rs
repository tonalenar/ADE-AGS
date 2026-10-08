//! Migración desde el nombre anterior del producto (`controlcode` → `ags`).
//!
//! Los datos del usuario —base de datos, canvas, rutinas, cuentas, skills, capturas— viven en
//! `~/.controlcode/`. Con el nuevo nombre viven en `~/.ags/`, y esto tiene que pasar ANTES de
//! que nada abra la base: si la app arrancara con una carpeta vacía, el usuario vería perdidas
//! sus misiones y su historial.
//!
//! Orden de preferencia:
//! 1. Si `~/.ags` ya existe, manda: no se toca nada (ya migró, o es una instalación nueva).
//! 2. Si solo existe `~/.controlcode`, se RENOMBRA a `~/.ags` (atómico, no copia nada).
//! 3. Si renombrar falla —típicamente porque una instancia vieja todavía tiene la base
//!    abierta y Windows no deja mover una carpeta en uso— se deja `~/.ags` como un enlace a la
//!    vieja: los dos nombres ven los mismos datos y nada se pierde.

use std::path::{Path, PathBuf};

/// Cómo terminó la migración. Para probarla y para que el arranque diga qué pasó.
#[derive(Debug, PartialEq, Eq)]
pub enum Migrated {
    /// No había nada que migrar (instalación nueva, o ya hecha).
    Nothing,
    /// La carpeta vieja se renombró a la nueva.
    Renamed,
    /// No se pudo renombrar: la nueva es un enlace a la vieja.
    Linked,
    /// No se pudo ni renombrar ni enlazar; sigue en la vieja y hay que avisar.
    Failed(String),
}

/// La carpeta de datos con el nombre nuevo y con el anterior, dentro de `home`.
pub fn data_dirs(home: &Path) -> (PathBuf, PathBuf) {
    (home.join(".ags"), home.join(".controlcode"))
}

/// Migra `<home>/.controlcode` a `<home>/.ags`. Idempotente.
pub fn migrate_home(home: &Path) -> Migrated {
    let (new, old) = data_dirs(home);
    if new.exists() || !old.is_dir() {
        return Migrated::Nothing;
    }
    match std::fs::rename(&old, &new) {
        Ok(()) => Migrated::Renamed,
        Err(rename_err) => match link_dir(&old, &new) {
            Ok(()) => Migrated::Linked,
            Err(link_err) => Migrated::Failed(format!("renombrar: {rename_err}; enlazar: {link_err}")),
        },
    }
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    // Junction direto (FSCTL_SET_REPARSE_POINT), sem `cmd /C mklink` e sem privilégio de symlink.
    crate::skills::junction_dir(target, link)
}

#[cfg(not(windows))]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Se llama una sola vez, lo primero de `run()`.
pub fn migrate_on_startup() {
    let Some(home) = dirs::home_dir() else { return };
    match migrate_home(&home) {
        Migrated::Nothing => {}
        Migrated::Renamed => eprintln!("[ags] datos migrados de ~/.controlcode a ~/.ags"),
        Migrated::Linked => eprintln!("[ags] ~/.ags enlazado a ~/.controlcode (la carpeta vieja estaba en uso)"),
        Migrated::Failed(e) => eprintln!("[ags] no se pudieron migrar los datos de ~/.controlcode: {e}"),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ags-legacy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn renombra_la_carpeta_vieja_conservando_los_datos() {
        let home = temp_home("rename");
        let (new, old) = data_dirs(&home);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("data.db"), "datos").unwrap();
        assert_eq!(migrate_home(&home), Migrated::Renamed);
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(new.join("data.db")).unwrap(), "datos");
        // Idempotente: la segunda vez no hay nada que hacer.
        assert_eq!(migrate_home(&home), Migrated::Nothing);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn si_la_nueva_ya_existe_no_toca_ninguna() {
        let home = temp_home("exists");
        let (new, old) = data_dirs(&home);
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("data.db"), "viejo").unwrap();
        assert_eq!(migrate_home(&home), Migrated::Nothing);
        assert!(old.join("data.db").is_file());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn sin_carpeta_vieja_no_hace_nada() {
        let home = temp_home("none");
        assert_eq!(migrate_home(&home), Migrated::Nothing);
        assert!(!data_dirs(&home).0.exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
