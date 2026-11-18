//! Lo que se le hace a un archivo desde el menú del árbol: crear, renombrar, copiar, mover
//! y mandar a la papelera.
//!
//! Ninguna operación pisa nada. Crear o renombrar sobre algo que ya existe falla; copiar
//! o pegar sobre un nombre ocupado elige otro (`a copy.ts`, `a copy 2.ts`), como VS Code.
//! Borrar va a la papelera del sistema y no se pierde: es un click derecho, y un click
//! derecho mal apuntado no puede costar un archivo.

use std::fs;
use std::path::{Path, PathBuf};

fn exists(p: &Path) -> bool {
    // `exists()` sigue symlinks: uno roto daría `false` y se escribiría encima.
    p.symlink_metadata().is_ok()
}

/// Un nombre, no una ruta. Sin esto, "../../x" como nombre nuevo escaparía de la carpeta.
fn check_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("nombre inválido".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("\"{name}\" no puede llevar separadores de ruta"));
    }
    #[cfg(windows)]
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with('.') || name.ends_with(' ') {
        return Err(format!("\"{name}\" no es un nombre válido en Windows"));
    }
    Ok(())
}

fn child(dir: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let dir = Path::new(dir);
    if !dir.is_dir() {
        return Err(format!("{} no es un directorio", dir.display()));
    }
    Ok(dir.join(name.trim()))
}

fn out(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn same_file_identity(from: &Path, to: &Path) -> Option<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return match (fs::symlink_metadata(from), fs::symlink_metadata(to)) {
            (Ok(a), Ok(b)) => Some(a.dev() == b.dev() && a.ino() == b.ino()),
            _ => Some(false),
        };
    }
    #[cfg(not(unix))]
    {
        // No Windows estável, `MetadataExt::{volume_serial_number, file_index}` exige a feature
        // instável `windows_by_handle`. Sem adicionar dependência nova, tratamos a identidade por
        // handle/inode como desconhecida (`None`) e usamos `same_file_fallback` como fallback seguro.
        let _ = (from, to);
        None
    }
}

fn is_link_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

pub(super) fn same_file_fallback(from: &Path, to: &Path) -> bool {
    // Fallback seguro quando a identidade por handle/inode é desconhecida: recusa symlinks e
    // reparse points para que `canonicalize` não iguale atalho e alvo, e exige o mesmo caminho
    // real em disco (qualquer erro ou dúvida devolve `false` para nunca sobrescrever `to`).
    let (Ok(a), Ok(b)) = (fs::symlink_metadata(from), fs::symlink_metadata(to)) else {
        return false;
    };
    if is_link_or_reparse(&a) || is_link_or_reparse(&b) {
        return false;
    }
    match (from.canonicalize(), to.canonicalize()) {
        (Ok(from), Ok(to)) => from.as_os_str() == to.as_os_str(),
        _ => false,
    }
}

fn same_file(from: &Path, to: &Path) -> bool {
    same_file_identity(from, to).unwrap_or_else(|| same_file_fallback(from, to))
}

pub(crate) fn create_file(dir: String, name: String) -> Result<String, String> {
    let path = child(&dir, &name)?;
    // `create_new` falla si ya existe, en el mismo syscall: no hay carrera entre mirar y
    // crear en la que un agente pueda escribir el archivo y perderlo.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
    Ok(out(&path))
}

#[tauri::command]
pub async fn explorer_create_file(dir: String, name: String) -> Result<String, String> {
    super::off_ui(move || create_file(dir, name)).await
}

pub(crate) fn create_dir(dir: String, name: String) -> Result<String, String> {
    let path = child(&dir, &name)?;
    fs::create_dir(&path).map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
    Ok(out(&path))
}

#[tauri::command]
pub async fn explorer_create_dir(dir: String, name: String) -> Result<String, String> {
    super::off_ui(move || create_dir(dir, name)).await
}

pub(crate) fn rename(path: String, name: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let parent = from.parent().ok_or("no se puede renombrar la raíz")?;
    let to = child(&parent.to_string_lossy(), &name)?;
    if to == from {
        return Ok(path);
    }
    // Só é o mesmo arquivo quando os metadados confirmam que identidade e inode coincidem.
    if exists(&to) && !same_file(&from, &to) {
        return Err(format!("ya existe {}", to.display()));
    }
    fs::rename(&from, &to).map_err(|e| format!("no se pudo renombrar: {e}"))?;
    Ok(out(&to))
}

#[tauri::command]
pub async fn explorer_rename(path: String, name: String) -> Result<String, String> {
    super::off_ui(move || rename(path, name)).await
}

/// `a.ts` → `a copy.ts` → `a copy 2.ts`… El primero libre en `dir`. Las carpetas y los
/// archivos sin extensión llevan el sufijo al final; los ocultos (`.env`) también, porque
/// su "extensión" es el nombre entero.
pub(crate) fn free_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") };
        let p = dir.join(candidate);
        if !exists(&p) {
            return p;
        }
        n += 1;
    }
}

/// Copia recursiva. Los symlinks se copian como symlinks: seguirlos metería adentro una
/// carpeta de skills entera (o se colgaría con uno que apunta a un ancestro).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    copy_tree_with(from, to, &mut |_| Ok(()))
}

pub(super) fn copy_tree_new(from: &Path, to: &Path) -> std::io::Result<()> {
    copy_tree_new_with(from, to, || Ok(()))
}

fn copy_tree_new_with(
    from: &Path,
    to: &Path,
    before_copy: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<()> {
    if exists(to) {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "o destino já existe"));
    }
    before_copy()?;
    copy_tree(from, to)
}

pub(super) fn copy_into_free_name(
    from: &Path,
    name: &str,
    dir: &Path,
    copy: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf, String> {
    let to = free_name(dir, name, from.is_dir());
    copy(from, &to).map_err(|e| format!("no se pudo copiar {}: {e}", from.display()))?;
    Ok(to)
}

pub(super) fn copy_tree_with(
    from: &Path,
    to: &Path,
    before_file: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let meta = from.symlink_metadata()?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, to);
        #[cfg(windows)]
        return if from.is_dir() {
            std::os::windows::fs::symlink_dir(target, to)
        } else {
            std::os::windows::fs::symlink_file(target, to)
        };
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        let result = (|| {
            let mut entries = fs::read_dir(from)?.collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                copy_tree_with(&entry.path(), &to.join(entry.file_name()), before_file)?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(to);
        }
        return result;
    }
    before_file(from)?;
    let mut input = fs::File::open(from)?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        let _ = fs::remove_file(to);
        return Err(error);
    }
    if let Err(error) = fs::set_permissions(to, meta.permissions()) {
        let _ = fs::remove_file(to);
        return Err(error);
    }
    Ok(())
}

/// `inner` es `outer` o está adentro. Se compara canonicalizado: con symlinks o `..` de
/// por medio, comparar strings no alcanza.
fn is_within(inner: &Path, outer: &Path) -> bool {
    match (inner.canonicalize(), outer.canonicalize()) {
        (Ok(i), Ok(o)) => i.starts_with(o),
        _ => false,
    }
}

fn source(path: &str) -> Result<(PathBuf, String), String> {
    let from = PathBuf::from(path);
    if !exists(&from) {
        return Err(format!("{path} ya no existe"));
    }
    let name = from
        .file_name()
        .ok_or("no se puede copiar la raíz")?
        .to_string_lossy()
        .to_string();
    Ok((from, name))
}

fn target_dir(dir: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(format!("{} no es un directorio", dir.display()));
    }
    Ok(dir)
}

/// Copia `path` adentro de `dir`. Pegar en la misma carpeta es duplicar: el nombre libre
/// que le toca es `x copy`.
pub(crate) fn copy(path: String, dir: String) -> Result<String, String> {
    let (from, name) = source(&path)?;
    let dir = target_dir(&dir)?;
    if from.is_dir() && is_within(&dir, &from) {
        return Err("no se puede copiar una carpeta adentro de sí misma".into());
    }
    let to = copy_into_free_name(&from, &name, &dir, copy_tree_new)?;
    Ok(out(&to))
}

#[tauri::command]
pub async fn explorer_copy(path: String, dir: String) -> Result<String, String> {
    super::off_ui(move || copy(path, dir)).await
}

/// Mueve `path` adentro de `dir`, con el mismo nombre. Si ya hay algo con ese nombre
/// falla: mover es arrastrar, y un arrastre no debería reemplazar nada sin preguntar.
pub(crate) fn move_path(path: String, dir: String) -> Result<String, String> {
    let (from, name) = source(&path)?;
    let dir = target_dir(&dir)?;
    if from.parent() == Some(dir.as_path()) {
        return Ok(path);
    }
    if from.is_dir() && is_within(&dir, &from) {
        return Err("no se puede mover una carpeta adentro de sí misma".into());
    }
    let to = dir.join(&name);
    if exists(&to) {
        return Err(format!("ya existe {name} en {}", dir.display()));
    }
    if fs::rename(&from, &to).is_err() {
        // `rename` no cruza discos (EXDEV en Unix, otra letra de unidad en Windows): ahí
        // se copia y después se borra el original, solo si la copia salió entera.
        copy_tree(&from, &to).map_err(|e| format!("no se pudo mover {}: {e}", from.display()))?;
        let removed = if from.is_dir() && !from.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            fs::remove_dir_all(&from)
        } else {
            fs::remove_file(&from)
        };
        removed.map_err(|e| format!("se copió, pero no se pudo borrar el original: {e}"))?;
    }
    Ok(out(&to))
}

#[tauri::command]
pub async fn explorer_move(path: String, dir: String) -> Result<String, String> {
    super::off_ui(move || move_path(path, dir)).await
}

/// A la papelera del sistema (Papelera de reciclaje en Windows, Papelera en macOS, la de
/// freedesktop en Linux), no un borrado definitivo.
pub(crate) fn trash(paths: Vec<String>) -> Result<(), String> {
    let existing: Vec<&String> = paths.iter().filter(|p| exists(Path::new(p))).collect();
    if existing.is_empty() {
        return Ok(());
    }
    trash::delete_all(existing).map_err(|e| format!("no se pudo mandar a la papelera: {e}"))
}

#[tauri::command]
pub async fn explorer_trash(paths: Vec<String>) -> Result<(), String> {
    super::off_ui(move || trash(paths)).await
}
