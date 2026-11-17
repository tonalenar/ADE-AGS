//! Leitura e gravação segura de arquivos JSON pertencentes ao usuário.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum UserJsonError {
    Unreadable {
        path: PathBuf,
        quarantined: PathBuf,
        reason: String,
    },
    Io(String),
}

impl fmt::Display for UserJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable {
                path,
                quarantined,
                reason,
            } => write!(
                f,
                "O arquivo JSON do usuário está ilegível em {} ({reason}); uma cópia foi preservada em {}.",
                path.display(),
                quarantined.display()
            ),
            Self::Io(reason) => write!(
                f,
                "Não foi possível acessar o arquivo JSON do usuário: {reason}"
            ),
        }
    }
}

impl std::error::Error for UserJsonError {}

/// Lê JSON do usuário. Só um arquivo ausente é tratado como ausência de configuração.
pub fn read_user_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, UserJsonError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(UserJsonError::Io(format!("{}: {error}", path.display()))),
    };

    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let quarantined = quarantine_path(path)?;
            fs::copy(path, &quarantined).map_err(|copy_error| {
                UserJsonError::Io(format!(
                    "Não foi possível preservar {} em {}: {copy_error}",
                    path.display(),
                    quarantined.display()
                ))
            })?;
            Err(UserJsonError::Unreadable {
                path: path.to_path_buf(),
                quarantined,
                reason: error.to_string(),
            })
        }
    }
}

fn quarantine_path(path: &Path) -> Result<PathBuf, UserJsonError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| UserJsonError::Io(format!("{} não tem nome de arquivo", path.display())))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut candidate = parent.join(format!("{}.corrupt-{millis}", name.to_string_lossy()));
    let mut suffix = 0_u32;
    while candidate.exists() {
        suffix += 1;
        candidate = parent.join(format!(
            "{}.corrupt-{millis}-{suffix}",
            name.to_string_lossy()
        ));
    }
    Ok(candidate)
}

/// Grava JSON em arquivo temporário exclusivo, preserva a versão anterior e renomeia no fim.
pub fn write_user_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body =
        serde_json::to_vec(value).map_err(|e| format!("Não foi possível serializar JSON: {e}"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|e| format!("Não foi possível criar {}: {e}", parent.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} não tem nome de arquivo", path.display()))?;
    let name = name.to_string_lossy();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let existing_permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());

    let (tmp, mut file) = create_temp(parent, &name, timestamp, existing_permissions.as_ref())?;
    let write_result = file.write_all(&body).and_then(|()| file.sync_all());
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "Não foi possível gravar {}: {error}",
            tmp.display()
        ));
    }
    drop(file);

    if path.exists() {
        let backup = path.with_file_name(format!("{name}.bak"));
        fs::copy(path, &backup).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!(
                "Não foi possível preservar {} em {}: {e}",
                path.display(),
                backup.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "Não foi possível atualizar {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn create_temp(
    parent: &Path,
    name: &str,
    timestamp: u128,
    permissions: Option<&std::fs::Permissions>,
) -> Result<(PathBuf, File), String> {
    for attempt in 0..32_u32 {
        let tmp = parent.join(format!(
            ".{name}.{}.{timestamp}{attempt}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            use std::os::unix::fs::PermissionsExt;
            options.mode(permissions.map_or(0o600, |p| p.mode() & 0o777));
        }
        match options.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Não foi possível criar {}: {error}", tmp.display())),
        }
    }
    let _ = permissions;
    Err(format!(
        "Não foi possível reservar um arquivo temporário para {}",
        parent.display()
    ))
}
