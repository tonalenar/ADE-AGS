use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const MAX_CACHE_FILES: usize = 256;
const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHED_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Heurística: compara até 4 KiB da cauda do prefixo já cacheado (ou o
/// offset inteiro, se menor). Hash do prefixo inteiro releria o arquivo
/// e anularia o ganho do cache.
const PREFIX_TAIL: usize = 4 * 1024;

/// JSONs completos encontrados em um transcript JSONL.
#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub lines: Arc<Vec<serde_json::Value>>,
    pending: Vec<u8>,
    pending_parsed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileId {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    index: u64,
    #[cfg(not(any(unix, windows)))]
    _unused: (),
}

struct Limits {
    max_files: usize,
    max_bytes: u64,
    max_file_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: MAX_CACHE_FILES,
            max_bytes: MAX_CACHE_BYTES,
            max_file_bytes: MAX_CACHED_FILE_BYTES,
        }
    }
}

struct Entry {
    mtime: SystemTime,
    len: u64,
    offset: u64,
    file_id: Option<FileId>,
    prefix_tail: Vec<u8>,
    parsed: Arc<Parsed>,
    last_used: u64,
}

/// Cache local dos transcripts, limitado a 256 arquivos e 64 MiB.
pub struct TranscriptCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
    clock: std::sync::atomic::AtomicU64,
    limits: Limits,
    #[cfg(test)]
    bytes_read: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    unknown_file_id: std::sync::atomic::AtomicBool,
}

impl Default for TranscriptCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            clock: std::sync::atomic::AtomicU64::new(0),
            limits: Limits::default(),
            #[cfg(test)]
            bytes_read: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            unknown_file_id: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl TranscriptCache {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn with_limits(max_files: usize, max_bytes: u64, max_file_bytes: u64) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            clock: std::sync::atomic::AtomicU64::new(0),
            limits: Limits {
                max_files,
                max_bytes,
                max_file_bytes,
            },
            bytes_read: std::sync::atomic::AtomicU64::new(0),
            unknown_file_id: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn read_incremental(&self, path: &Path) -> Result<Arc<Parsed>, String> {
        for _ in 0..3 {
            let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
            let mtime = metadata.modified().map_err(|e| e.to_string())?;
            let len = metadata.len();
            let id = self.resolve_file_id(&metadata);
            let stamp = (mtime, len);
            let (previous_stamp, offset, previous, previous_id, previous_tail) = {
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = entries.get_mut(path) {
                    if (entry.mtime, entry.len) == stamp && file_id_hit(entry.file_id, id) {
                        entry.last_used = self
                            .clock
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return Ok(entry.parsed.clone());
                    }
                    (
                        Some((entry.mtime, entry.len)),
                        entry.offset,
                        Some(entry.parsed.clone()),
                        entry.file_id,
                        Some(entry.prefix_tail.clone()),
                    )
                } else {
                    (None, 0, None, None, None)
                }
            };

            let mut file = File::open(path).map_err(|e| e.to_string())?;
            let too_big = len > self.limits.max_file_bytes;
            let size_mtime_append = previous_stamp
                .is_some_and(|(old_mtime, old_len)| len > old_len && mtime != old_mtime);
            // Sem FileId (file_index None no Windows, injeção nos testes, ou
            // qualquer None) não há como provar que é o mesmo inode: relê tudo.
            let identity_ok = match (previous_id, id) {
                (Some(previous), Some(current)) => previous == current,
                _ => false,
            };
            let tail_ok = !too_big
                && previous_tail.as_ref().is_some_and(|tail| {
                    prefix_tail_matches(&mut file, offset, tail).unwrap_or(false)
                });
            let append = !too_big && size_mtime_append && identity_ok && tail_ok;
            let start = if append { offset } else { 0 };
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            let mut bytes = Vec::with_capacity(len.saturating_sub(start) as usize);
            file.take(len.saturating_sub(start))
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 != len.saturating_sub(start) {
                continue;
            }
            #[cfg(test)]
            self.bytes_read
                .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);

            let after_read = fs::metadata(path).map_err(|e| e.to_string())?;
            if after_read.len() != len
                || after_read.modified().map_err(|e| e.to_string())? != mtime
                || self.resolve_file_id(&after_read) != id
            {
                continue;
            }

            if len > self.limits.max_file_bytes {
                let mut parsed = Parsed::default();
                add_bytes(&mut parsed, &bytes);
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                entries.remove(path);
                return Ok(Arc::new(parsed));
            }

            let mut parsed = if append {
                owned_parsed_for_append(self, path, previous_stamp, previous)
            } else {
                Parsed::default()
            };
            add_bytes(&mut parsed, &bytes);
            let prefix_tail = new_prefix_tail(previous_tail.as_deref().unwrap_or(&[]), &bytes, append);
            let parsed = Arc::new(parsed);
            let tick = self
                .clock
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let current_stamp = entries.get(path).map(|entry| (entry.mtime, entry.len));
            match current_stamp {
                Some(s) if s == stamp => {
                    let entry = entries.get_mut(path).expect("entrada confirmada");
                    entry.last_used = tick;
                    return Ok(entry.parsed.clone());
                }
                Some(s) if Some(s) != previous_stamp => continue,
                // None: tiramos a entrada para o make_mut único; reinserimos.
                _ => {}
            }
            entries.insert(
                path.to_path_buf(),
                Entry {
                    mtime,
                    len,
                    offset: len,
                    file_id: id,
                    prefix_tail,
                    parsed: parsed.clone(),
                    last_used: tick,
                },
            );
            evict_until_within_limits(&mut entries, path, &self.limits);
            return Ok(parsed);
        }
        Err("O transcript mudou durante a leitura; tente novamente".into())
    }

    #[cfg(test)]
    fn bytes_read(&self) -> u64 {
        self.bytes_read.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    fn reset_bytes_read(&self) {
        self.bytes_read
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    fn force_unknown_file_id(&self, unknown: bool) {
        self.unknown_file_id
            .store(unknown, std::sync::atomic::Ordering::Relaxed);
    }

    fn resolve_file_id(&self, metadata: &Metadata) -> Option<FileId> {
        #[cfg(test)]
        if self
            .unknown_file_id
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return None;
        }
        file_id(metadata)
    }
}

fn file_id_hit(cached: Option<FileId>, current: Option<FileId>) -> bool {
    match (cached, current) {
        (Some(a), Some(b)) => a == b,
        (None, None) => true,
        _ => false,
    }
}

fn owned_parsed_for_append(
    cache: &TranscriptCache,
    path: &Path,
    previous_stamp: Option<(SystemTime, u64)>,
    previous: Option<Arc<Parsed>>,
) -> Parsed {
    let taken = {
        let mut entries = cache.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.get(path).map(|entry| (entry.mtime, entry.len)) != previous_stamp {
            None
        } else {
            entries.remove(path).map(|entry| entry.parsed)
        }
    };
    match taken {
        Some(arc) => {
            // O clone em `previous` saiu do mapa; soltar antes do try_unwrap
            // para o make_mut ver unicidade quando não há leitor vivo.
            drop(previous);
            match Arc::try_unwrap(arc) {
                Ok(parsed) => parsed,
                Err(arc) => Parsed {
                    lines: arc.lines.clone(),
                    pending: arc.pending.clone(),
                    pending_parsed: arc.pending_parsed,
                },
            }
        }
        None => previous
            .map(|p| Parsed {
                lines: p.lines.clone(),
                pending: p.pending.clone(),
                pending_parsed: p.pending_parsed,
            })
            .unwrap_or_default(),
    }
}

fn file_id(metadata: &Metadata) -> Option<FileId> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileId {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_index().map(|index| FileId { index })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        None
    }
}

fn prefix_tail_matches(file: &mut File, offset: u64, expected: &[u8]) -> Result<bool, String> {
    if expected.is_empty() {
        return Ok(offset == 0);
    }
    if offset < expected.len() as u64 {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(offset - expected.len() as u64))
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; expected.len()];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf == expected)
}

fn new_prefix_tail(previous_tail: &[u8], new_bytes: &[u8], append: bool) -> Vec<u8> {
    let mut combined = if append {
        previous_tail.to_vec()
    } else {
        Vec::new()
    };
    combined.extend_from_slice(new_bytes);
    let n = combined.len().min(PREFIX_TAIL);
    combined[combined.len() - n..].to_vec()
}

fn add_bytes(parsed: &mut Parsed, bytes: &[u8]) {
    let lines = Arc::make_mut(&mut parsed.lines);
    if parsed.pending_parsed {
        lines.pop();
        parsed.pending_parsed = false;
    }
    parsed.pending.extend_from_slice(bytes);
    let mut complete = 0;
    for (index, byte) in parsed.pending.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = &parsed.pending[complete..=index];
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
            lines.push(value);
        }
        complete = index + 1;
    }
    if complete > 0 {
        parsed.pending.drain(..complete);
    }
    if !parsed.pending.is_empty() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&parsed.pending) {
            lines.push(value);
            parsed.pending_parsed = true;
        }
    }
}

fn evict_until_within_limits(
    entries: &mut HashMap<PathBuf, Entry>,
    keep: &Path,
    limits: &Limits,
) {
    loop {
        let bytes: u64 = entries.values().map(|entry| entry.len).sum();
        if entries.len() <= limits.max_files && bytes <= limits.max_bytes {
            return;
        }
        let oldest = entries
            .iter()
            .filter(|(path, _)| path.as_path() != keep)
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(path, _)| path.clone());
        match oldest {
            Some(path) => {
                entries.remove(&path);
            }
            None => return,
        }
    }
}

/// Lê um transcript do cache global, que retém no máximo 256 arquivos e 64 MiB.
pub fn read_incremental(path: &Path) -> Result<Arc<Parsed>, String> {
    static CACHE: OnceLock<TranscriptCache> = OnceLock::new();
    CACHE
        .get_or_init(TranscriptCache::new)
        .read_incremental(path)
        .inspect_err(|erro| {
            eprintln!("[transcript-cache] falha ao ler incremental: {erro}");
        })
}

#[cfg(test)]
mod tests {
    use super::TranscriptCache;
    use std::fs::{self, File, FileTimes};
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    fn advance_mtime(path: &std::path::Path) {
        let file = File::open(path).expect("abre arquivo");
        file.set_times(FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(5)))
            .expect("atualiza mtime");
    }

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("ags-transcript-cache-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("cria diretório temporário");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_file(name: &str, contents: &str) -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new();
        let path = dir.0.join(name);
        fs::write(&path, contents).expect("grava transcript");
        (dir, path)
    }

    #[test]
    fn append_le_so_o_novo() {
        let (_dir, path) = temp_file("append.jsonl", "{\"n\":1}\n");
        let cache = TranscriptCache::new();
        cache.read_incremental(&path).expect("leitura inicial");

        let appended = b"{\"n\":2}\n";
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(appended).unwrap();
        advance_mtime(&path);
        cache.reset_bytes_read();

        let parsed = cache.read_incremental(&path).expect("leitura incremental");
        assert_eq!(parsed.lines.len(), 2);
        assert!(
            cache.bytes_read() <= appended.len() as u64,
            "append leu {} bytes para uma linha de {} bytes",
            cache.bytes_read(),
            appended.len()
        );
    }

    #[test]
    fn substituido_maior_com_conteudo_diferente_nao_append() {
        let (_dir, path) = temp_file("substituido.jsonl", "{\"n\":1}\n");
        let cache = TranscriptCache::new();
        cache.read_incremental(&path).expect("leitura inicial");

        let replacement = "{\"x\":0}\n{\"x\":1}\n{\"x\":2}\n";
        fs::write(&path, replacement).expect("substitui por arquivo maior");
        advance_mtime(&path);

        let parsed = cache
            .read_incremental(&path)
            .expect("releitura após substituição");
        assert_eq!(parsed.lines.len(), 3);
        assert!(
            parsed.lines.iter().all(|line| line.get("n").is_none()),
            "linhas do arquivo antigo não podem sobreviver a uma substituição maior"
        );
        assert_eq!(parsed.lines[0]["x"], 0);
        assert_eq!(parsed.lines[2]["x"], 2);
    }

    #[test]
    fn truncado_rele_tudo() {
        let (_dir, path) = temp_file("truncado.jsonl", "{\"n\":1}\n{\"n\":2}\n");
        let cache = TranscriptCache::new();
        cache.read_incremental(&path).expect("leitura inicial");

        let truncated = "{\"x\":0}\n";
        fs::write(&path, truncated).expect("trunca transcript");
        advance_mtime(&path);
        cache.reset_bytes_read();

        let parsed = cache.read_incremental(&path).expect("releitura completa");
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(cache.bytes_read(), truncated.len() as u64);
    }

    #[test]
    fn linha_incompleta_e_parseada_quando_termina() {
        let (_dir, path) = temp_file("parcial.jsonl", "{\"n\":1}\n{\"n\":");
        let cache = TranscriptCache::new();
        let first = cache.read_incremental(&path).expect("leitura inicial");
        assert_eq!(first.lines.len(), 1);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"2}\n").unwrap();
        advance_mtime(&path);
        let complete = cache.read_incremental(&path).expect("linha completada");
        assert_eq!(complete.lines.len(), 2);
        assert_eq!(complete.lines[1]["n"], 2);
    }

    #[test]
    fn mesmo_tamanho_com_mtime_novo_rele_tudo() {
        let (_dir, path) = temp_file("reescrito.jsonl", "{\"n\":1}\n");
        let cache = TranscriptCache::new();
        cache.read_incremental(&path).expect("leitura inicial");

        fs::write(&path, "{\"x\":1}\n").expect("reescreve com mesmo tamanho");
        advance_mtime(&path);
        cache.reset_bytes_read();
        let parsed = cache
            .read_incremental(&path)
            .expect("releitura após alteração");

        assert_eq!(parsed.lines[0]["x"], 1);
        assert_eq!(cache.bytes_read(), 8);
    }

    #[test]
    fn cache_fica_limitado_a_256_arquivos() {
        let dir = TempDir::new();
        let cache = TranscriptCache::new();
        for index in 0..=super::MAX_CACHE_FILES {
            let path = dir.0.join(format!("{index}.jsonl"));
            fs::write(&path, "{}\n").unwrap();
            cache.read_incremental(&path).expect("lê arquivo");
        }
        let entries = cache.entries.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(entries.len(), super::MAX_CACHE_FILES);
    }

    #[test]
    fn arquivo_acima_do_teto_nao_entra_no_cache() {
        let (_dir, path) = temp_file("grande.jsonl", "{\"n\":1}\n{\"n\":2}\n");
        let cache = TranscriptCache::with_limits(8, 1024, 8);
        let parsed = cache.read_incremental(&path).expect("lê direto");
        assert_eq!(parsed.lines.len(), 2);
        let entries = cache.entries.lock().unwrap_or_else(|e| e.into_inner());
        assert!(entries.is_empty());
    }

    #[test]
    fn evict_lru_quando_passa_do_teto_de_bytes() {
        let dir = TempDir::new();
        let cache = TranscriptCache::with_limits(8, 10, 16);
        let first = dir.0.join("a.jsonl");
        let second = dir.0.join("b.jsonl");
        fs::write(&first, "{\"n\":1}\n").unwrap();
        fs::write(&second, "{\"n\":2}\n").unwrap();
        cache.read_incremental(&first).expect("primeiro");
        cache.read_incremental(&second).expect("segundo");
        let entries = cache.entries.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key(&second));
        assert!(!entries.contains_key(&first));
    }

    #[test]
    fn append_sem_leitor_nao_clona_o_arc_das_linhas() {
        let (_dir, path) = temp_file("unico.jsonl", "{\"n\":1}\n");
        let cache = TranscriptCache::new();
        let first = cache.read_incremental(&path).expect("leitura inicial");
        let ptr_antes = std::sync::Arc::as_ptr(&first.lines);
        drop(first);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"n\":2}\n").unwrap();
        advance_mtime(&path);

        let second = cache.read_incremental(&path).expect("append sem leitores");
        assert_eq!(
            std::sync::Arc::as_ptr(&second.lines),
            ptr_antes,
            "sem leitores vivos o Vec tem de ser o mesmo Arc, sem clone no make_mut"
        );
        assert_eq!(second.lines.len(), 2);
        assert_eq!(std::sync::Arc::strong_count(&second.lines), 1);
    }

    #[test]
    fn identidade_desconhecida_rele_tudo() {
        let (_dir, path) = temp_file("id-none.jsonl", "{\"n\":1}\n");
        let cache = TranscriptCache::new();
        cache.read_incremental(&path).expect("leitura inicial");

        let appended = b"{\"n\":2}\n";
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(appended).unwrap();
        advance_mtime(&path);
        cache.force_unknown_file_id(true);
        cache.reset_bytes_read();

        let parsed = cache
            .read_incremental(&path)
            .expect("releitura sem identidade");
        assert_eq!(parsed.lines.len(), 2);
        let esperado = fs::read(&path).expect("lê arquivo").len() as u64;
        assert_eq!(
            cache.bytes_read(),
            esperado,
            "sem FileId não pode append; tem de reler o arquivo inteiro"
        );
    }
}
