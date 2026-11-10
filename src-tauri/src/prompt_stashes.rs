//! Rascunhos salvos explicitamente no chaveiro do sistema.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::{Mutex, MutexGuard, OnceLock},
};
use tauri::async_runtime;

const SERVICE_PREFIX: &str = "ade-ags.prompt-stashes";
const INDEX_ACCOUNT: &str = "index";
const MAX_STASHES: usize = 10;
const MAX_PENDING: usize = 10;
const MAX_INDEX_BYTES: usize = 16 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024;
const MAX_STASH_BYTES: usize = 32 * 1024;
const CHUNK_BYTES: usize = 1800;
const MAX_CHUNKS: usize = (MAX_STASH_BYTES + CHUNK_BYTES - 1) / CHUNK_BYTES;
const MAX_ATTACHMENTS: usize = 10;
const MAX_QUOTES: usize = 10;
static KEYRING_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_keyring() -> Result<MutexGuard<'static, ()>, String> {
    KEYRING_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "O acesso ao chaveiro foi interrompido".into())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRef {
    id: String,
    version: String,
    chunks: usize,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashIndex {
    version: u8,
    active: Vec<String>,
    pending: Vec<PendingRef>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashManifest {
    version: String,
    chunks: usize,
    checksum: String,
    attachment_count: usize,
    quote_count: usize,
    saved_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQuote {
    text: String,
    comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_item_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredStash {
    id: String,
    text: String,
    attachment_paths: Vec<String>,
    quotes: Vec<StoredQuote>,
    quote_key: Option<String>,
    cwd: Option<String>,
    saved_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptStashInput {
    text: String,
    attachment_paths: Vec<String>,
    quotes: Vec<StoredQuote>,
    quote_key: Option<String>,
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptStashSummary {
    id: String,
    attachment_count: usize,
    quote_count: usize,
    saved_at: u64,
}

fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn service() -> Result<String, String> {
    let data_dir = crate::util::datadir::ags_home()
        .ok_or("Não foi possível identificar os dados desta instância")?;
    Ok(format!(
        "{SERVICE_PREFIX}.{}",
        digest(&data_dir.to_string_lossy())
    ))
}

fn data_dir() -> Result<PathBuf, String> {
    crate::util::datadir::ags_home()
        .ok_or_else(|| "Não foi possível identificar os dados desta instância".into())
}

struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            use std::os::fd::AsRawFd;
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Storage::FileSystem::UnlockFileEx, System::IO::OVERLAPPED};
            let mut overlapped = OVERLAPPED::default();
            UnlockFileEx(self.0.as_raw_handle() as _, 0, 1, 0, &mut overlapped);
        }
    }
}

/// Serializa acesso ao índice mesmo quando duas instâncias usam o mesmo diretório ADE_AGS_DATA_DIR.
fn lock_store() -> Result<StoreLock, String> {
    let root = data_dir()?;
    fs::create_dir_all(&root)
        .map_err(|_| "Não foi possível preparar o chaveiro local".to_string())?;
    let path = root.join(".prompt-stashes.lock");
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let file = options
            .open(&path)
            .map_err(|_| "Não foi possível abrir a trava local do chaveiro".to_string())?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err("Não foi possível travar o acesso aos rascunhos".into());
        }
        Ok(StoreLock(file))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::{
            Storage::FileSystem::{
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
                LOCKFILE_EXCLUSIVE_LOCK, LockFileEx,
            },
            System::IO::OVERLAPPED,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options
            .open(path)
            .map_err(|_| "Não foi possível abrir a trava local do chaveiro".to_string())?;
        if file
            .metadata()
            .map_err(|_| "Não foi possível conferir a trava local do chaveiro".to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("A trava local do chaveiro não pode ser um link do Windows".into());
        }
        let mut overlapped = OVERLAPPED::default();
        let result = unsafe {
            LockFileEx(
                file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if result == 0 {
            return Err("Não foi possível travar o acesso aos rascunhos".into());
        }
        Ok(StoreLock(file))
    }
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account)
        .map_err(|_| "O chaveiro do sistema não está disponível".into())
}

fn index_entry(service: &str) -> Result<keyring::Entry, String> {
    entry(service, INDEX_ACCOUNT)
}

fn manifest_entry(service: &str, id: &str) -> Result<keyring::Entry, String> {
    entry(service, &format!("{id}:manifest"))
}

fn part_entry(
    service: &str,
    id: &str,
    version: &str,
    index: usize,
) -> Result<keyring::Entry, String> {
    entry(service, &format!("{id}:{version}:{index}"))
}

fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok() && id.len() == 36
}

fn read_index(service: &str) -> Result<StashIndex, String> {
    match index_entry(service)?.get_password() {
        Ok(raw) => {
            if raw.len() > MAX_INDEX_BYTES {
                return Err("O índice dos rascunhos no chaveiro excede o limite seguro".into());
            }
            let index: StashIndex = serde_json::from_str(&raw)
                .map_err(|_| "O índice dos rascunhos no chaveiro está inválido".to_string())?;
            if index.version != 1
                || index.active.len() > MAX_STASHES
                || index.pending.len() > MAX_PENDING
                || index.active.iter().any(|id| !valid_id(id))
                || index.pending.iter().any(|item| {
                    !valid_id(&item.id)
                        || !valid_id(&item.version)
                        || item.chunks == 0
                        || item.chunks > MAX_CHUNKS
                })
            {
                return Err("O índice dos rascunhos no chaveiro está inválido".into());
            }
            let mut ids = std::collections::HashSet::new();
            if index
                .active
                .iter()
                .chain(index.pending.iter().map(|item| &item.id))
                .any(|id| !ids.insert(id))
            {
                return Err("O índice dos rascunhos no chaveiro contém duplicatas".into());
            }
            Ok(index)
        }
        Err(keyring::Error::NoEntry) => Ok(StashIndex {
            version: 1,
            ..StashIndex::default()
        }),
        Err(_) => Err("Não foi possível acessar o chaveiro do sistema".into()),
    }
}

fn write_index(service: &str, index: &StashIndex) -> Result<(), String> {
    let raw = serde_json::to_string(index)
        .map_err(|_| "Não foi possível preparar o índice dos rascunhos".to_string())?;
    index_entry(service)?
        .set_password(&raw)
        .map_err(|_| "Não foi possível atualizar o índice no chaveiro do sistema".into())
}

fn delete_parts(service: &str, reference: &PendingRef) -> Result<(), String> {
    for index in 0..reference.chunks {
        match part_entry(service, &reference.id, &reference.version, index)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Não foi possível limpar um rascunho do chaveiro".into()),
        }
    }
    match manifest_entry(service, &reference.id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Não foi possível limpar um rascunho do chaveiro".into()),
    }
}

fn rollback_pending(service: &str, index: &mut StashIndex, id: &str, reference: &PendingRef) {
    if delete_parts(service, reference).is_ok() {
        index.pending.retain(|item| item.id != id);
        let _ = write_index(service, index);
    }
}

/// Finaliza limpezas iniciadas por uma ação explícita antes de permitir novas gravações.
fn cleanup_pending(service: &str, index: &mut StashIndex) -> Result<(), String> {
    if index.pending.is_empty() {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for reference in index.pending.drain(..) {
        if delete_parts(service, &reference).is_err() {
            remaining.push(reference);
        }
    }
    index.pending = remaining;
    write_index(service, index)
}

fn split_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if !current.is_empty() && current.len() + character.len_utf8() > CHUNK_BYTES {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn validate_input(input: &PromptStashInput) -> Result<(), String> {
    if input.text.contains('\0')
        || input.text.len() > MAX_STASH_BYTES
        || input.attachment_paths.len() > MAX_ATTACHMENTS
        || input.quotes.len() > MAX_QUOTES
        || input.attachment_paths.iter().any(|path| {
            path.is_empty()
                || path.len() > 4096
                || path.contains('\0')
                || !PathBuf::from(path).is_absolute()
        })
        || input
            .quote_key
            .as_ref()
            .is_some_and(|key| key.len() > 512 || key.contains('\0'))
        || input
            .cwd
            .as_ref()
            .is_some_and(|cwd| cwd.len() > 4096 || cwd.contains('\0'))
        || input.quotes.iter().any(|quote| {
            quote.text.len() > 8 * 1024
                || quote.comment.len() > 8 * 1024
                || quote.text.contains('\0')
                || quote.comment.contains('\0')
                || quote
                    .origin_item_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 512 || id.contains('\0'))
        })
    {
        return Err("O rascunho excede os limites de armazenamento seguro".into());
    }
    Ok(())
}

fn validate_manifest(manifest: &StashManifest) -> Result<(), String> {
    if !valid_id(&manifest.version)
        || manifest.chunks == 0
        || manifest.chunks > MAX_CHUNKS
        || manifest.checksum.len() != 64
        || !manifest
            .checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || manifest.attachment_count > MAX_ATTACHMENTS
        || manifest.quote_count > MAX_QUOTES
    {
        return Err("Os metadados do rascunho no chaveiro estão inválidos".into());
    }
    Ok(())
}

fn read_manifest(service: &str, id: &str) -> Result<Option<StashManifest>, String> {
    match manifest_entry(service, id)?.get_password() {
        Ok(raw) => {
            if raw.len() > MAX_MANIFEST_BYTES {
                return Err("Os metadados do rascunho excedem o limite seguro".into());
            }
            let manifest: StashManifest = serde_json::from_str(&raw)
                .map_err(|_| "Os metadados do rascunho no chaveiro estão inválidos".to_string())?;
            validate_manifest(&manifest)?;
            Ok(Some(manifest))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Não foi possível acessar o rascunho no chaveiro do sistema".into()),
    }
}

fn read_payload(service: &str, id: &str, manifest: &StashManifest) -> Result<StoredStash, String> {
    let mut raw = String::new();
    for index in 0..manifest.chunks {
        let chunk = part_entry(service, id, &manifest.version, index)?
            .get_password()
            .map_err(|_| "Uma parte do rascunho não está disponível no chaveiro".to_string())?;
        if chunk.len() > CHUNK_BYTES || raw.len().saturating_add(chunk.len()) > MAX_STASH_BYTES {
            return Err("O rascunho no chaveiro excede o limite seguro de 32 KiB".into());
        }
        raw.push_str(&chunk);
    }
    if digest(&raw) != manifest.checksum {
        return Err("A verificação de integridade do rascunho falhou".into());
    }
    let stash: StoredStash = serde_json::from_str(&raw)
        .map_err(|_| "O conteúdo do rascunho no chaveiro está inválido".to_string())?;
    if stash.id != id
        || stash.attachment_paths.len() != manifest.attachment_count
        || stash.quotes.len() != manifest.quote_count
        || stash.saved_at != manifest.saved_at
        || stash.attachment_paths.len() > MAX_ATTACHMENTS
        || stash.quotes.len() > MAX_QUOTES
    {
        return Err("O rascunho não corresponde ao índice do chaveiro".into());
    }
    validate_stored_stash(&stash)?;
    Ok(stash)
}

fn validate_stored_stash(stash: &StoredStash) -> Result<(), String> {
    if stash.text.contains('\0')
        || stash.text.len() > MAX_STASH_BYTES
        || stash.attachment_paths.len() > MAX_ATTACHMENTS
        || stash.quotes.len() > MAX_QUOTES
        || stash.attachment_paths.iter().any(|path| {
            path.is_empty()
                || path.len() > 4096
                || path.contains('\0')
                || !PathBuf::from(path).is_absolute()
        })
        || stash
            .quote_key
            .as_ref()
            .is_some_and(|key| key.len() > 512 || key.contains('\0'))
        || stash
            .cwd
            .as_ref()
            .is_some_and(|cwd| cwd.len() > 4096 || cwd.contains('\0'))
        || stash.quotes.iter().any(|quote| {
            quote.text.len() > 8 * 1024
                || quote.comment.len() > 8 * 1024
                || quote.text.contains('\0')
                || quote.comment.contains('\0')
                || quote
                    .origin_item_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 512 || id.contains('\0'))
        })
    {
        return Err("O conteúdo do rascunho excede os limites seguros".into());
    }
    Ok(())
}

fn summary(id: &str, manifest: &StashManifest) -> PromptStashSummary {
    PromptStashSummary {
        id: id.to_owned(),
        attachment_count: manifest.attachment_count,
        quote_count: manifest.quote_count,
        saved_at: manifest.saved_at,
    }
}

/// Lista apenas resumos; o texto é lido do chaveiro somente ao restaurar um rascunho.
#[tauri::command]
pub async fn chat_prompt_stashes_list() -> Result<Vec<PromptStashSummary>, String> {
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let _store_lock = lock_store()?;
        let service = service()?;
        let mut index = read_index(&service)?;
        cleanup_pending(&service, &mut index)?;
        index
            .active
            .iter()
            .map(|id| {
                let manifest = read_manifest(&service, id)?
                    .ok_or_else(|| "Um rascunho não está disponível no chaveiro".to_string())?;
                Ok(summary(id, &manifest))
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Salva um rascunho somente após a ação explícita da pessoa no composer.
#[tauri::command]
pub async fn chat_prompt_stash_save(input: PromptStashInput) -> Result<PromptStashSummary, String> {
    validate_input(&input)?;
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let _store_lock = lock_store()?;
        let service = service()?;
        let mut index = read_index(&service)?;
        cleanup_pending(&service, &mut index)?;
        if index.active.len() >= MAX_STASHES {
            return Err("Já há 10 rascunhos guardados. Remova um antes de guardar outro.".into());
        }
        if index.pending.len() >= MAX_PENDING {
            return Err("O chaveiro precisa concluir a limpeza de rascunhos removidos".into());
        }

        let id = uuid::Uuid::new_v4().to_string();
        let version = uuid::Uuid::new_v4().to_string();
        let saved_at = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let stash = StoredStash {
            id: id.clone(),
            text: input.text,
            attachment_paths: input.attachment_paths,
            quotes: input.quotes,
            quote_key: input.quote_key,
            cwd: input.cwd,
            saved_at,
        };
        let raw = serde_json::to_string(&stash)
            .map_err(|_| "Não foi possível preparar o rascunho para o chaveiro".to_string())?;
        if raw.len() > MAX_STASH_BYTES {
            return Err("O rascunho excede o limite seguro de 32 KiB".into());
        }
        let chunks = split_chunks(&raw);
        if chunks.is_empty() || chunks.len() > MAX_CHUNKS {
            return Err("O rascunho excede o limite de armazenamento seguro".into());
        }

        let reference = PendingRef {
            id: id.clone(),
            version: version.clone(),
            chunks: chunks.len(),
        };
        index.pending.push(reference.clone());
        write_index(&service, &index)?;

        for (part_index, chunk) in chunks.iter().enumerate() {
            if part_entry(&service, &id, &version, part_index)?
                .set_password(chunk)
                .is_err()
            {
                rollback_pending(&service, &mut index, &id, &reference);
                return Err("Não foi possível guardar o rascunho no chaveiro do sistema".into());
            }
        }

        let manifest = StashManifest {
            version: version.clone(),
            chunks: chunks.len(),
            checksum: digest(&raw),
            attachment_count: stash.attachment_paths.len(),
            quote_count: stash.quotes.len(),
            saved_at,
        };
        let encoded = serde_json::to_string(&manifest)
            .map_err(|_| "Não foi possível preparar o resumo do rascunho".to_string())?;
        if manifest_entry(&service, &id)?
            .set_password(&encoded)
            .is_err()
        {
            rollback_pending(&service, &mut index, &id, &reference);
            return Err("Não foi possível ativar o rascunho no chaveiro do sistema".into());
        }

        index.active.insert(0, id.clone());
        index.pending.retain(|item| item.id != id);
        if let Err(error) = write_index(&service, &index) {
            return Err(error);
        }
        Ok(summary(&id, &manifest))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Lê o conteúdo para restaurar sem remover o rascunho guardado.
#[tauri::command]
pub async fn chat_prompt_stash_get(id: String) -> Result<Option<StoredStash>, String> {
    if !valid_id(&id) {
        return Err("O identificador do rascunho está inválido".into());
    }
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let _store_lock = lock_store()?;
        let service = service()?;
        let mut index = read_index(&service)?;
        cleanup_pending(&service, &mut index)?;
        if !index.active.iter().any(|active_id| active_id == &id) {
            return Ok(None);
        }
        let manifest = read_manifest(&service, &id)?
            .ok_or_else(|| "O rascunho não está disponível no chaveiro".to_string())?;
        let stash = read_payload(&service, &id, &manifest)?;
        Ok(Some(stash))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Remove um rascunho após a confirmação explícita no menu.
#[tauri::command]
pub async fn chat_prompt_stash_delete(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("O identificador do rascunho está inválido".into());
    }
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let _store_lock = lock_store()?;
        let service = service()?;
        let mut index = read_index(&service)?;
        cleanup_pending(&service, &mut index)?;
        if !index.active.iter().any(|active_id| active_id == &id) {
            return Ok(());
        }
        if index.pending.len() >= MAX_PENDING {
            return Err("A limpeza de rascunhos removidos precisa ser concluída antes de remover outro".into());
        }
        let manifest = read_manifest(&service, &id)?
            .ok_or_else(|| "O rascunho não está disponível no chaveiro".to_string())?;
        let reference = PendingRef {
            id: id.clone(),
            version: manifest.version,
            chunks: manifest.chunks,
        };
        index.active.retain(|active_id| active_id != &id);
        index.pending.push(reference.clone());
        write_index(&service, &index)?;
        if delete_parts(&service, &reference).is_err() {
            return Err("O rascunho foi ocultado, mas a limpeza no chaveiro falhou; a ADE tentará concluí-la novamente".into());
        }
        index.pending.retain(|item| item.id != id);
        write_index(&service, &index)
    })
    .await
    .map_err(|error| error.to_string())?
}
