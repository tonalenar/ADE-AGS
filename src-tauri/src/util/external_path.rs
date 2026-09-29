//! Rutas que salen del proceso hacia un programa que no entiende el prefijo verbatim
//! de Windows.
//!
//! `Path::canonicalize` en Windows devuelve `\\?\C:\...`. Git 2.55 rechaza esa forma en
//! `worktree add` y `worktree remove` (`Invalid argument` al crear los directorios del
//! `.git` del worktree). Adentro de Rust el tipo sigue siendo `Path` / `PathBuf`; esta
//! función es la frontera, y solo se aplica al armar el `Command`.
//!
//! No es un `replace(r"\\?\", "")`. Ese recorte rompe un UNC verbatim: `\\?\UNC\server\share`
//! quedaría `UNC\server\share`, que no es una ruta. `dunce` solo quita `\\?\` de un disco
//! cuando el resultado sigue siendo una ruta Win32 válida (no reserva `CON`, no supera
//! el largo legado). Un UNC de verdad (`\\server\share`, o su forma `\\?\UNC\...`) se
//! reescribe a `\\server\share`. En Linux y macOS no cambia nada.

use std::path::{Path, PathBuf};

/// La forma de `path` que se le puede pasar a git y a otros programas externos.
pub fn external_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(unc) = verbatim_unc_to_win32(path) {
            return unc;
        }
    }
    dunce::simplified(path).to_path_buf()
}

/// `\\?\UNC\server\share\resto` → `\\server\share\resto`.
///
/// `dunce` deja esta forma como está: su prefijo no es un disco (`\\?\C:`), y recortar
/// los cuatro primeros caracteres produciría una ruta que no existe.
#[cfg(windows)]
fn verbatim_unc_to_win32(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};

    let mut comps = path.components();
    let Component::Prefix(prefix) = comps.next()? else { return None };
    let Prefix::VerbatimUNC(server, share) = prefix.kind() else { return None };
    let server = server.to_str()?;
    let share = share.to_str()?;
    if server.is_empty() || share.is_empty() {
        return None;
    }

    let mut out = PathBuf::from(format!(r"\\{server}\{share}"));
    for component in comps {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => out.push(part),
            // `..` dentro de un verbatim es literal. Reescribirlo cambiaría el destino.
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn una_ruta_win32_comun_no_cambia() {
        let path = Path::new(r"C:\Users\ada\proyecto");
        assert_eq!(external_path(path), path);
    }

    #[cfg(windows)]
    #[test]
    fn el_prefijo_verbatim_de_un_disco_se_quita() {
        let path = Path::new(r"\\?\C:\Users\ada\proyecto");
        assert_eq!(external_path(path), Path::new(r"C:\Users\ada\proyecto"));
    }

    #[cfg(windows)]
    #[test]
    fn un_unc_real_sigue_siendo_unc() {
        let plain = Path::new(r"\\servidor\compartido\repo");
        assert_eq!(external_path(plain), plain);

        let verbatim = Path::new(r"\\?\UNC\servidor\compartido\repo");
        assert_eq!(external_path(verbatim), plain);
    }

    #[cfg(windows)]
    #[test]
    fn espacios_y_unicode_se_conservan_sin_el_prefijo() {
        let path = Path::new(r"\\?\C:\Users\ada\mi carpeta\café\léeme.md");
        assert_eq!(external_path(path), Path::new(r"C:\Users\ada\mi carpeta\café\léeme.md"));

        let unc = Path::new(r"\\?\UNC\servidor\compartido\mi carpeta\café");
        assert_eq!(external_path(unc), Path::new(r"\\servidor\compartido\mi carpeta\café"));
    }

    #[cfg(windows)]
    #[test]
    fn un_nombre_reservado_no_se_recorta_a_ciegas() {
        // `CON` no es una ruta Win32 válida. Quitarle `\\?\` la haría inusable para
        // cualquier API, así que se deja verbatim.
        let path = Path::new(r"\\?\C:\CON");
        assert_eq!(external_path(path), path);
    }

    #[cfg(windows)]
    #[test]
    fn aplicarla_dos_veces_no_cambia_el_resultado() {
        for path in [
            Path::new(r"C:\Users\ada\proyecto"),
            Path::new(r"\\?\C:\Users\ada\mi carpeta"),
            Path::new(r"\\servidor\compartido\repo"),
            Path::new(r"\\?\UNC\servidor\compartido\café"),
            Path::new(r"\\?\C:\CON"),
        ] {
            let once = external_path(path);
            assert_eq!(external_path(&once), once, "{path:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn en_unix_la_ruta_pasa_igual() {
        let path = Path::new("/tmp/mi carpeta/café");
        assert_eq!(external_path(path), path);
        assert_eq!(external_path(&external_path(path)), path);
    }
}
