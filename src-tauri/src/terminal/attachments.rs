//! Local clipboard attachments. Callers supply bytes and MIME, never a destination.
use std::{fs, io::Write, path::{Path, PathBuf}, time::{Duration, SystemTime}};

pub(crate) const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn pasted_dir() -> Result<PathBuf, String> {
    dirs::home_dir().map(|p| p.join(".ags/tmp/pasted"))
        .ok_or_else(|| "Diretorio do usuario indisponivel".into())
}

pub fn save_pasted_image(bytes: &[u8], mime: &str) -> Result<String, String> {
    save_pasted_image_in(&pasted_dir()?, bytes, mime)
}

pub fn cleanup_pasted(max_age: Duration) -> usize {
    pasted_dir().map(|dir| cleanup_dir(&dir, max_age)).unwrap_or(0)
}

fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0; // all reparse points, including junctions
    }
    #[cfg(not(windows))] { false }
}

// Reject redirected ancestors as well as a redirected pasted directory.
fn check_path(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() || dir.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Pasta de anexos deve ser absoluta".into());
    }
    let mut path = PathBuf::new();
    for component in dir.components() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(m) if linked(&m) || !m.is_dir() => return Err("Pasta de anexos redirecionada ou invalida".into()),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn prepare_dir(dir: &Path) -> Result<(), String> {
    check_path(dir)?;
    #[cfg(unix)] {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)] {
        // Inherit the user profile ACL, as with other local .ags directories.
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    check_path(dir)
}

pub(crate) fn save_pasted_image_in(dir: &Path, bytes: &[u8], mime: &str) -> Result<String, String> {
    let ext = match mime {
        "image/png" => "png", "image/jpeg" => "jpg", "image/webp" => "webp", "image/gif" => "gif",
        _ => return Err("Tipo de imagem nao suportado".into()),
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES { return Err("Imagem vazia ou maior que 20 MB".into()); }
    prepare_dir(dir)?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    if let Err(e) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(e.to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub(crate) fn cleanup_dir(dir: &Path, max_age: Duration) -> usize {
    if check_path(dir).is_err() { return 0; }
    let Ok(entries) = fs::read_dir(dir) else { return 0; };
    let now = SystemTime::now();
    entries.flatten().filter(|entry| {
        let Ok(m) = fs::symlink_metadata(entry.path()) else { return false; };
        if !m.is_file() || linked(&m) { return false; }
        let expired = m.modified().ok().and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        expired && fs::remove_file(entry.path()).is_ok()
    }).count()
}
