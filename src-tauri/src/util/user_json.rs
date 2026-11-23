//! Leitura e gravação segura de arquivos JSON pertencentes ao usuário.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserJsonSnapshot {
    len: u64,
    modified: Option<SystemTime>,
    sha256: [u8; 32],
}

const SNAPSHOT_CHANGED: &str = " foi alterado durante a atualização; a versão mais recente foi preservada.";

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
    read_user_json_snapshot(path).map(|snapshot| snapshot.map(|(value, _)| value))
}

/// Lê o valor junto dos bytes observados, para operações de leitura-modificação-gravação.
pub fn read_user_json_snapshot<T: DeserializeOwned>(
    path: &Path,
) -> Result<Option<(T, UserJsonSnapshot)>, UserJsonError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(UserJsonError::Io(format!("{}: {error}", path.display()))),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| UserJsonError::Io(format!("{}: {error}", path.display())))?;
    let metadata = file
        .metadata()
        .map_err(|error| UserJsonError::Io(format!("{}: {error}", path.display())))?;
    let snapshot = snapshot(&metadata, &bytes);

    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some((value, snapshot))),
        Err(error) => {
            let quarantined = quarantine(path, &bytes)?;
            Err(UserJsonError::Unreadable {
                path: path.to_path_buf(),
                quarantined,
                reason: error.to_string(),
            })
        }
    }
}

fn quarantine(path: &Path, bytes: &[u8]) -> Result<PathBuf, UserJsonError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| UserJsonError::Io(format!("{} não tem nome de arquivo", path.display())))?;
    let prefix = format!("{}.corrupt-", name.to_string_lossy());
    let digest = Sha256::digest(bytes);
    let mut previous: Vec<_> = fs::read_dir(parent)
        .map_err(|e| UserJsonError::Io(format!("{}: {e}", parent.display())))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .collect();
    previous.sort_by_key(|entry| entry.file_name());
    if let Some(entry) = previous.last() {
        if fs::read(entry.path()).ok().is_some_and(|old| Sha256::digest(old).as_slice() == digest.as_slice()) {
            return Ok(entry.path());
        }
    }

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut suffix = 0_u32;
    let candidate = loop {
        let candidate = parent.join(format!("{}.corrupt-{millis}-{suffix}", name.to_string_lossy()));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|e| UserJsonError::Io(format!("{}: {e}", candidate.display())))?;
                break candidate;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => suffix += 1,
            Err(error) => return Err(UserJsonError::Io(format!("{}: {error}", candidate.display()))),
        }
    };
    let mut matching: Vec<_> = fs::read_dir(parent)
        .map_err(|e| UserJsonError::Io(format!("{}: {e}", parent.display())))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .collect();
    matching.sort_by_key(|entry| entry.file_name());
    while matching.len() > 5 {
        let old = matching.remove(0);
        fs::remove_file(old.path()).map_err(|e| UserJsonError::Io(format!("{}: {e}", old.path().display())))?;
    }
    Ok(candidate)
}

/// Política de durabilidade na gravação atômica de JSON do usuário.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Força `sync_all()` antes de renomear (padrão seguro para gravações esporádicas e fechamento).
    Sync,
    /// Escrita atômica (`tmp` + `.bak` + `rename`) sem `sync_all()` por gravação;
    /// o chamador garante durabilidade em intervalo maior ou no fechamento via [`sync_user_json`].
    AtomicNoSync,
}

/// Grava JSON em arquivo temporário exclusivo, preserva a versão anterior e renomeia no fim.
pub fn write_user_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    write_user_json_inner(path, value, None, SyncMode::Sync)
}

/// Como [`write_user_json`], permitindo escolher se chama `sync_all()` antes do `rename`.
pub fn write_user_json_with_sync<T: Serialize>(
    path: &Path,
    value: &T,
    sync: SyncMode,
) -> Result<(), String> {
    write_user_json_inner(path, value, None, sync)
}

/// Força `sync_all()` no arquivo já gravado (ex.: em intervalo periódico ou no fechamento).
/// Se o arquivo não existir, não faz nada.
pub fn sync_user_json(path: &Path) -> Result<(), String> {
    let file = match OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Não foi possível abrir {} para sincronização: {error}",
                path.display()
            ));
        }
    };
    file.sync_all().map_err(|error| {
        format!(
            "Não foi possível sincronizar {} em disco: {error}",
            path.display()
        )
    })
}

/// Grava apenas se o arquivo ainda corresponde ao snapshot usado para montar `value`.
/// `None` representa que o arquivo não existia quando foi lido.
pub fn write_user_json_if_unchanged<T: Serialize>(
    path: &Path,
    value: &T,
    expected: Option<&UserJsonSnapshot>,
) -> Result<(), String> {
    write_user_json_inner(path, value, Some(expected), SyncMode::Sync)
}

fn write_user_json_inner<T: Serialize>(
    path: &Path,
    value: &T,
    expected: Option<Option<&UserJsonSnapshot>>,
    sync: SyncMode,
) -> Result<(), String> {
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
    let write_result = match sync {
        SyncMode::Sync => file.write_all(&body).and_then(|()| file.sync_all()),
        SyncMode::AtomicNoSync => file.write_all(&body),
    };
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "Não foi possível gravar {}: {error}",
            tmp.display()
        ));
    }
    drop(file);

    if let Some(expected) = expected {
        verify_snapshot(path, expected, &tmp)?;
    }

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

    // Confere depois do backup, imediatamente antes da troca. O Claude CLI não usa lock da ADE,
    // então uma escrita externa ainda pode acontecer entre esta checagem e o rename.
    if let Some(expected) = expected {
        verify_snapshot(path, expected, &tmp)?;
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

fn matches_snapshot(path: &Path, expected: Option<&UserJsonSnapshot>) -> Result<bool, String> {
    let current = match File::open(path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            let metadata = file.metadata().map_err(|e| format!("{}: {e}", path.display()))?;
            Some(snapshot(&metadata, &bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Não foi possível reler {}: {error}",
                path.display()
            ))
        }
    };
    Ok(current.as_ref() == expected)
}

fn verify_snapshot(path: &Path, expected: Option<&UserJsonSnapshot>, tmp: &Path) -> Result<(), String> {
    match matches_snapshot(path, expected) {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = fs::remove_file(tmp);
            Err(format!(
                "O arquivo {}{SNAPSHOT_CHANGED}",
                path.display()
            ))
        }
        Err(error) => {
            let _ = fs::remove_file(tmp);
            Err(error)
        }
    }
}

fn snapshot(metadata: &std::fs::Metadata, bytes: &[u8]) -> UserJsonSnapshot {
    UserJsonSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        sha256: Sha256::digest(bytes).into(),
    }
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
