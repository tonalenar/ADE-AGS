//! Cópia temporária privada dos arquivos de um navegador. Só a cópia é aberta: o original nunca
//! recebe nada (nem `-wal`, nem `-shm`, nem bloqueio).

use std::path::{Path, PathBuf};

use super::ImportError;

/// Uma pasta temporária privada, que se apaga ao sair de escopo, também quando algo falha.
pub(crate) struct TempCopy(PathBuf);

impl TempCopy {
    pub(crate) fn create(root: &Path) -> Result<Self, ImportError> {
        std::fs::create_dir_all(root).map_err(|e| ImportError::new("unreadable").with(e.to_string()))?;
        let path = root.join(format!("ade-ags-importar-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|e| ImportError::new("unreadable").with(e.to_string()))?;
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("[preview] não foi possível apagar a cópia temporária da importação: {e}");
        }
    }
}

/// Copia um arquivo para a pasta privada (modo `0600` em Unix). Uma recusa de permissão do sistema
/// (`EPERM`, o Acesso Total ao Disco do macOS) vira `needs-full-disk-access`.
pub(crate) fn copy_file(from: &Path, to: &Path) -> Result<(), ImportError> {
    std::fs::copy(from, to).map_err(|e| read_error(&e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| ImportError::new("unreadable").with(e.to_string()))?;
    }
    Ok(())
}

/// O erro de leitura de um arquivo do navegador. No macOS, o TCC nega com `EPERM` (1) quando falta o
/// Acesso Total ao Disco; `EACCES` (13) é uma permissão comum de arquivo, que o Acesso Total não resolve.
pub(crate) fn read_error(e: &std::io::Error) -> ImportError {
    if is_full_disk_access_denied(e) {
        ImportError::new("needs-full-disk-access")
    } else {
        ImportError::new("unreadable").with(e.to_string())
    }
}

pub(crate) fn is_full_disk_access_denied(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(1)
}

/// Copia `file` e, se existirem, os arquivos laterais do SQLite (`-wal`, `-journal`) para `dir`.
/// O `-shm` não se copia: o SQLite o refaz a partir do `-wal`.
pub(crate) fn copy_sqlite_with_sidecars(file: &Path, dir: &Path) -> Result<PathBuf, ImportError> {
    let name = file.file_name().ok_or_else(|| ImportError::new("unreadable"))?;
    let target = dir.join(name);
    copy_file(file, &target)?;
    for suffix in ["-wal", "-journal"] {
        let mut side = file.as_os_str().to_owned();
        side.push(suffix);
        let side = PathBuf::from(side);
        if side.is_file() {
            let mut to = target.as_os_str().to_owned();
            to.push(suffix);
            copy_file(&side, Path::new(&to))?;
        }
    }
    Ok(target)
}
