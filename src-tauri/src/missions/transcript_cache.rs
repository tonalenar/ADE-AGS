use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const MAX_CACHE_FILES: usize = 256;

/// JSONs completos encontrados em um transcript JSONL.
#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub lines: Vec<serde_json::Value>,
    pending: Vec<u8>,
    pending_parsed: bool,
}

struct Entry {
    mtime: SystemTime,
    len: u64,
    offset: u64,
    parsed: Arc<Parsed>,
    last_used: u64,
}

/// Cache local dos transcripts, limitado a 256 arquivos.
pub struct TranscriptCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
    clock: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    bytes_read: std::sync::atomic::AtomicU64,
}

impl Default for TranscriptCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            clock: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            bytes_read: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl TranscriptCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn read_incremental(&self, path: &Path) -> Result<Arc<Parsed>, String> {
        for _ in 0..3 {
            let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
            let mtime = metadata.modified().map_err(|e| e.to_string())?;
            let len = metadata.len();
            let stamp = (mtime, len);
            let (previous_stamp, offset, previous) = {
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = entries.get_mut(path) {
                    if (entry.mtime, entry.len) == stamp {
                        entry.last_used = self
                            .clock
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return Ok(entry.parsed.clone());
                    }
                    (
                        Some((entry.mtime, entry.len)),
                        entry.offset,
                        Some(entry.parsed.clone()),
                    )
                } else {
                    (None, 0, None)
                }
            };

            // Só um append comprovado pelo tamanho e pelo mtime pode continuar do offset anterior.
            let append = previous_stamp
                .is_some_and(|(old_mtime, old_len)| len > old_len && mtime != old_mtime);
            let start = if append { offset } else { 0 };
            let mut file = File::open(path).map_err(|e| e.to_string())?;
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
            if after_read.len() != len || after_read.modified().map_err(|e| e.to_string())? != mtime
            {
                continue;
            }
            let mut parsed = if append {
                previous.map(|p| (*p).clone()).unwrap_or_default()
            } else {
                Parsed::default()
            };
            add_bytes(&mut parsed, &bytes);
            let parsed = Arc::new(parsed);
            let tick = self
                .clock
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let current_stamp = entries.get(path).map(|entry| (entry.mtime, entry.len));
            if current_stamp != previous_stamp {
                if current_stamp == Some(stamp) {
                    let entry = entries.get_mut(path).expect("entrada confirmada");
                    entry.last_used = tick;
                    return Ok(entry.parsed.clone());
                }
                continue;
            }
            entries.insert(
                path.to_path_buf(),
                Entry {
                    mtime,
                    len,
                    offset: len,
                    parsed: parsed.clone(),
                    last_used: tick,
                },
            );
            if entries.len() > MAX_CACHE_FILES {
                if let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(path, _)| path.clone())
                {
                    entries.remove(&oldest);
                }
            }
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
}

fn add_bytes(parsed: &mut Parsed, bytes: &[u8]) {
    if parsed.pending_parsed {
        parsed.lines.pop();
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
            parsed.lines.push(value);
        }
        complete = index + 1;
    }
    if complete > 0 {
        parsed.pending.drain(..complete);
    }
    if !parsed.pending.is_empty() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&parsed.pending) {
            parsed.lines.push(value);
            parsed.pending_parsed = true;
        }
    }
}

/// Lê um transcript do cache global, que retém no máximo 256 arquivos.
pub fn read_incremental(path: &Path) -> Result<Arc<Parsed>, String> {
    static CACHE: OnceLock<TranscriptCache> = OnceLock::new();
    CACHE
        .get_or_init(TranscriptCache::new)
        .read_incremental(path)
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
}
