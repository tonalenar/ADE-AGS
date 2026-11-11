//! Armazenamento (Configurações → Armazenamento): quanto ocupa cada pasta do app e a limpeza das capturas
//! antigas. A limpeza só apaga arquivos comuns com mais de sete dias, dentro das pastas de captura, e só quando
//! a pessoa pede (com o tamanho mostrado antes). Banco e worktrees ficam de fora: o banco é dado do usuário, e as
//! worktrees têm o próprio fluxo de limpeza. Nada aqui segue link simbólico.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

/// As capturas com mais de sete dias saem; as recentes ficam (um agente pode ainda estar usando uma delas).
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AreaId {
    Database,
    ChatWorktrees,
    RunWorktrees,
    DeviceCaptures,
    BrowserCaptures,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageArea {
    pub id: AreaId,
    pub bytes: u64,
    pub files: u64,
    /// Quanto a limpeza removeria: os arquivos com mais de sete dias. Zero fora das áreas de captura.
    pub old_bytes: u64,
    pub old_files: u64,
    /// Se a limpeza por retenção mexe nesta área.
    pub cleanable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub files: u64,
    pub bytes: u64,
}

struct AreaSpec {
    id: AreaId,
    paths: Vec<PathBuf>,
    cleanable: bool,
}

/// As áreas e os caminhos delas. `home` é a pasta de dados; `captures` é a pasta de capturas do navegador.
fn areas(home: &Path, captures: &Path) -> Vec<AreaSpec> {
    vec![
        AreaSpec {
            id: AreaId::Database,
            paths: vec![home.join("data.db"), home.join("data.db-wal"), home.join("data.db-shm")],
            cleanable: false,
        },
        AreaSpec { id: AreaId::ChatWorktrees, paths: vec![home.join("chat-worktrees")], cleanable: false },
        AreaSpec { id: AreaId::RunWorktrees, paths: vec![home.join("worktrees")], cleanable: false },
        AreaSpec { id: AreaId::DeviceCaptures, paths: vec![home.join("screens")], cleanable: true },
        AreaSpec { id: AreaId::BrowserCaptures, paths: vec![captures.to_path_buf()], cleanable: true },
    ]
}

#[derive(Default)]
struct Tally {
    bytes: u64,
    files: u64,
    old_bytes: u64,
    old_files: u64,
}

/// Soma os arquivos comuns de `path` (ou o próprio arquivo). Não segue links: um link não conta nem entra.
fn tally(path: &Path, cutoff: SystemTime, into: &mut Tally) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.is_file() {
        into.bytes += meta.len();
        into.files += 1;
        if meta.modified().is_ok_and(|m| m < cutoff) {
            into.old_bytes += meta.len();
            into.old_files += 1;
        }
    } else if meta.is_dir() {
        let Ok(read) = std::fs::read_dir(path) else { return };
        for entry in read.flatten() {
            tally(&entry.path(), cutoff, into);
        }
    }
}

/// Apaga os arquivos comuns de `path` mais velhos que `cutoff`. As pastas ficam (são do app), mesmo vazias.
fn clean_older(path: &Path, cutoff: SystemTime, out: &mut CleanResult) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.is_file() {
        if meta.modified().is_ok_and(|m| m < cutoff) && std::fs::remove_file(path).is_ok() {
            out.files += 1;
            out.bytes += meta.len();
        }
    } else if meta.is_dir() {
        let Ok(read) = std::fs::read_dir(path) else { return };
        for entry in read.flatten() {
            clean_older(&entry.path(), cutoff, out);
        }
    }
}

fn cutoff_now() -> SystemTime {
    SystemTime::now().checked_sub(RETENTION).unwrap_or(SystemTime::UNIX_EPOCH)
}

fn measure(spec: &AreaSpec, cutoff: SystemTime) -> StorageArea {
    let mut tallied = Tally::default();
    for path in &spec.paths {
        tally(path, cutoff, &mut tallied);
    }
    // Só as áreas que a limpeza mexe mostram o "antigo": nas outras, o número enganaria.
    let (old_bytes, old_files) = if spec.cleanable { (tallied.old_bytes, tallied.old_files) } else { (0, 0) };
    StorageArea { id: spec.id, bytes: tallied.bytes, files: tallied.files, old_bytes, old_files, cleanable: spec.cleanable }
}

/// Aplica a limpeza de uma área. Recusa, com erro, uma área que não tem limpeza automática.
fn clean_area(spec: &AreaSpec, cutoff: SystemTime) -> Result<CleanResult, String> {
    if !spec.cleanable {
        return Err("Esta pasta não tem limpeza automática: ela fica como está.".into());
    }
    let mut out = CleanResult::default();
    for path in &spec.paths {
        clean_older(path, cutoff, &mut out);
    }
    Ok(out)
}

fn home_and_captures() -> Result<(PathBuf, PathBuf), String> {
    let home = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
    Ok((home, crate::preview::capture::capture_dir()))
}

/// Quanto ocupa cada área. Percorre as pastas, então roda fora da thread da janela.
#[tauri::command]
pub async fn storage_overview() -> Result<Vec<StorageArea>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<StorageArea>, String> {
        let (home, captures) = home_and_captures()?;
        let cutoff = cutoff_now();
        Ok(areas(&home, &captures).iter().map(|spec| measure(spec, cutoff)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove as capturas com mais de sete dias da área pedida. Só o que a pessoa confirmou na tela chega aqui.
#[tauri::command]
pub async fn storage_clean_old(area: AreaId) -> Result<CleanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (home, captures) = home_and_captures()?;
        let spec = areas(&home, &captures).into_iter().find(|s| s.id == area).ok_or("Área desconhecida")?;
        clean_area(&spec, cutoff_now())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod test;
