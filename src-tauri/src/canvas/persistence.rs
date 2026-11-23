//! Cache em memória e persistência coalescida/atômica de `canvas.json`.
//!
//! - Leituras (`load_boards`) servem direto do cache em memória sem reler nem parsear o JSON.
//! - Escritas (`save_board`) atualizam o cache imediatamente (mantendo coerência imediata para
//!   peers, notas, portais e CLI) e agendam uma única gravação atômica (`tmp` + `rename`) após
//!   a janela de debounce (`SAVE_DEBOUNCE`).
//! - `fsync` (`sync_all`) roda só no fechamento (`flush_pending_saves`) ou após um intervalo
//!   maior (`FSYNC_INTERVAL`), evitando `F_FULLFSYNC` a cada edição.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{Board, Boards};
use crate::util::user_json::{self, SyncMode};

/// Janela de debounce no backend para coalescer rajadas de `canvas_save`.
pub(crate) const SAVE_DEBOUNCE: Duration = Duration::from_millis(300);

/// Intervalo mínimo entre `fsync`s durante o uso normal (no fechamento sempre faz `fsync`).
pub(crate) const FSYNC_INTERVAL: Duration = Duration::from_secs(30);

/// Backoff aplicado se uma gravação em disco falhar, evitando laço apertado no worker.
const ERROR_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Serialize, Deserialize, Default)]
struct CanvasFile {
    #[serde(default)]
    boards: Boards,
}

#[derive(Serialize)]
struct CanvasFileRef<'a> {
    boards: &'a Boards,
}

pub(crate) trait CanvasIo: Send + Sync {
    fn read(&self, path: &Path) -> Result<Boards, String>;
    fn write(&self, path: &Path, boards: &Boards, sync: SyncMode) -> Result<(), String>;
    fn sync(&self, path: &Path) -> Result<(), String>;
}

pub(crate) struct DiskCanvasIo;

impl CanvasIo for DiskCanvasIo {
    fn read(&self, path: &Path) -> Result<Boards, String> {
        user_json::read_user_json::<CanvasFile>(path)
            .map(|file| file.map(|f| f.boards).unwrap_or_default())
            .map_err(|e| e.to_string())
    }

    fn write(&self, path: &Path, boards: &Boards, sync: SyncMode) -> Result<(), String> {
        user_json::write_user_json_with_sync(path, &CanvasFileRef { boards }, sync)
    }

    fn sync(&self, path: &Path) -> Result<(), String> {
        user_json::sync_user_json(path)
    }
}

struct PathState {
    boards: Boards,
    generation: u64,
    written_generation: u64,
    synced_generation: u64,
    deadline: Option<Instant>,
    last_fsync: Instant,
}

struct StoreInner {
    paths: HashMap<PathBuf, PathState>,
    worker_started: bool,
    shutdown: bool,
}

enum PendingAction {
    Write {
        path: PathBuf,
        boards: Boards,
        generation: u64,
        sync: SyncMode,
    },
    SyncOnly {
        path: PathBuf,
        generation: u64,
    },
}

pub(crate) struct CanvasStore<I: CanvasIo = DiskCanvasIo> {
    io: I,
    debounce: Duration,
    fsync_interval: Duration,
    /// Serializa operações em disco sem manter `state` travado durante I/O.
    /// Ordem estrita de locks: sempre `io_lock` antes de `state` (nunca o inverso).
    io_lock: Mutex<()>,
    state: Mutex<StoreInner>,
    wake: Condvar,
}

impl<I: CanvasIo> CanvasStore<I> {
    pub(crate) fn new(io: I, debounce: Duration, fsync_interval: Duration) -> Self {
        Self {
            io,
            debounce,
            fsync_interval,
            io_lock: Mutex::new(()),
            state: Mutex::new(StoreInner {
                paths: HashMap::new(),
                worker_started: false,
                shutdown: false,
            }),
            wake: Condvar::new(),
        }
    }

    fn ensure_loaded(&self, path: &Path, now: Instant) -> Result<(), String> {
        {
            let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if inner.paths.contains_key(path) {
                return Ok(());
            }
        }
        let _io_guard = self.io_lock.lock().unwrap_or_else(|e| e.into_inner());
        {
            let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if inner.paths.contains_key(path) {
                return Ok(());
            }
        }
        let loaded = self.io.read(path)?;
        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
        inner.paths.entry(path.to_path_buf()).or_insert(PathState {
            boards: loaded,
            generation: 0,
            written_generation: 0,
            synced_generation: 0,
            deadline: None,
            last_fsync: now,
        });
        Ok(())
    }

    /// Lê os quadros a partir do cache em memória; só acessa o disco na primeira leitura do caminho.
    pub(crate) fn load_at(&self, path: &Path, now: Instant) -> Result<Boards, String> {
        {
            let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = inner.paths.get(path) {
                return Ok(entry.boards.clone());
            }
        }
        self.ensure_loaded(path, now)?;
        let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Ok(inner
            .paths
            .get(path)
            .map(|entry| entry.boards.clone())
            .unwrap_or_default())
    }

    /// Atualiza o cache em memória imediatamente e agenda gravação coalescida após `debounce`.
    pub(crate) fn save_at(
        &self,
        path: &Path,
        key: &str,
        board: Board,
        now: Instant,
    ) -> Result<(), String> {
        self.ensure_loaded(path, now)?;
        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = inner
            .paths
            .get_mut(path)
            .ok_or_else(|| "Estado do canvas não inicializado".to_string())?;
        entry.boards.insert(key.to_string(), board);
        entry.generation = entry.generation.saturating_add(1);
        entry.deadline = Some(now + self.debounce);
        self.wake.notify_all();
        Ok(())
    }

    /// Persiste tudo cujo debounce (ou intervalo de `fsync`) venceu até `now`.
    /// Devolve quantas escritas em arquivo foram executadas.
    pub(crate) fn flush_due_at(&self, now: Instant) -> Result<usize, String> {
        let _io_guard = self.io_lock.lock().unwrap_or_else(|e| e.into_inner());
        let actions = {
            let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let mut list = Vec::new();
            for (path, entry) in &inner.paths {
                if entry.generation > entry.written_generation {
                    if entry.deadline.is_some_and(|deadline| now >= deadline) {
                        let sync = if now.saturating_duration_since(entry.last_fsync)
                            >= self.fsync_interval
                        {
                            SyncMode::Sync
                        } else {
                            SyncMode::AtomicNoSync
                        };
                        list.push(PendingAction::Write {
                            path: path.clone(),
                            boards: entry.boards.clone(),
                            generation: entry.generation,
                            sync,
                        });
                    }
                } else if entry.written_generation > entry.synced_generation
                    && now.saturating_duration_since(entry.last_fsync) >= self.fsync_interval
                {
                    list.push(PendingAction::SyncOnly {
                        path: path.clone(),
                        generation: entry.written_generation,
                    });
                }
            }
            list
        };

        let mut writes = 0usize;
        let mut first_error: Option<String> = None;

        for action in actions {
            match action {
                PendingAction::Write {
                    path,
                    boards,
                    generation,
                    sync,
                } => match self.io.write(&path, &boards, sync) {
                    Ok(()) => {
                        writes += 1;
                        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(entry) = inner.paths.get_mut(&path) {
                            entry.written_generation = entry.written_generation.max(generation);
                            if sync == SyncMode::Sync {
                                entry.synced_generation = entry.synced_generation.max(generation);
                                entry.last_fsync = now;
                            }
                            if entry.generation == generation {
                                entry.deadline = None;
                            }
                        }
                    }
                    Err(error) => {
                        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(entry) = inner.paths.get_mut(&path) {
                            entry.deadline = Some(now + self.debounce.max(ERROR_RETRY_DELAY));
                        }
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                },
                PendingAction::SyncOnly { path, generation } => match self.io.sync(&path) {
                    Ok(()) => {
                        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(entry) = inner.paths.get_mut(&path) {
                            entry.synced_generation = entry.synced_generation.max(generation);
                            entry.last_fsync = now;
                        }
                    }
                    Err(error) => {
                        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(entry) = inner.paths.get_mut(&path) {
                            entry.last_fsync = now;
                        }
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                },
            }
        }

        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(writes)
        }
    }

    /// Drena todas as alterações pendentes imediatamente com `fsync` (usado no encerramento).
    pub(crate) fn flush_all_with_fsync(&self, now: Instant) -> Result<(), String> {
        let _io_guard = self.io_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut first_error: Option<String> = None;

        loop {
            let actions = {
                let inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let mut list = Vec::new();
                for (path, entry) in &inner.paths {
                    if entry.generation > entry.written_generation {
                        list.push(PendingAction::Write {
                            path: path.clone(),
                            boards: entry.boards.clone(),
                            generation: entry.generation,
                            sync: SyncMode::Sync,
                        });
                    } else if entry.written_generation > entry.synced_generation {
                        list.push(PendingAction::SyncOnly {
                            path: path.clone(),
                            generation: entry.written_generation,
                        });
                    }
                }
                list
            };

            if actions.is_empty() {
                break;
            }

            let mut had_error = false;
            for action in actions {
                match action {
                    PendingAction::Write {
                        path,
                        boards,
                        generation,
                        sync,
                    } => match self.io.write(&path, &boards, sync) {
                        Ok(()) => {
                            let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(entry) = inner.paths.get_mut(&path) {
                                entry.written_generation = entry.written_generation.max(generation);
                                entry.synced_generation = entry.synced_generation.max(generation);
                                entry.last_fsync = now;
                                if entry.generation == generation {
                                    entry.deadline = None;
                                }
                            }
                        }
                        Err(error) => {
                            had_error = true;
                            if first_error.is_none() {
                                first_error = Some(error);
                            }
                        }
                    },
                    PendingAction::SyncOnly { path, generation } => match self.io.sync(&path) {
                        Ok(()) => {
                            let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(entry) = inner.paths.get_mut(&path) {
                                entry.synced_generation = entry.synced_generation.max(generation);
                                entry.last_fsync = now;
                            }
                        }
                        Err(error) => {
                            had_error = true;
                            if first_error.is_none() {
                                first_error = Some(error);
                            }
                        }
                    },
                }
            }

            if had_error {
                break;
            }
        }

        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(())
        }
    }

    fn next_wake_locked(&self, inner: &StoreInner) -> Option<Instant> {
        let mut earliest: Option<Instant> = None;
        for entry in inner.paths.values() {
            let candidate = if entry.generation > entry.written_generation {
                entry.deadline
            } else if entry.written_generation > entry.synced_generation {
                Some(entry.last_fsync + self.fsync_interval)
            } else {
                None
            };
            if let Some(at) = candidate {
                earliest = Some(match earliest {
                    Some(cur) => cur.min(at),
                    None => at,
                });
            }
        }
        earliest
    }

    #[cfg(test)]
    pub(crate) fn stop_worker(&self) {
        let mut inner = self.state.lock().unwrap_or_else(|e| e.into_inner());
        inner.shutdown = true;
        self.wake.notify_all();
    }
}

pub(crate) fn ensure_worker<I: CanvasIo + 'static>(store: &Arc<CanvasStore<I>>) {
    let should_spawn = {
        let mut inner = store.state.lock().unwrap_or_else(|e| e.into_inner());
        if inner.worker_started || inner.shutdown {
            false
        } else {
            inner.worker_started = true;
            true
        }
    };
    if !should_spawn {
        return;
    }
    let worker_store = Arc::clone(store);
    if std::thread::Builder::new()
        .name("canvas-save-writer".into())
        .spawn(move || worker_loop(&worker_store))
        .is_err()
    {
        let mut inner = store.state.lock().unwrap_or_else(|e| e.into_inner());
        inner.worker_started = false;
    }
}

fn worker_loop<I: CanvasIo>(store: &CanvasStore<I>) {
    loop {
        {
            let mut inner = store.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if inner.shutdown {
                    return;
                }
                let now = Instant::now();
                match store.next_wake_locked(&inner) {
                    None => {
                        inner = store.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
                    }
                    Some(target) if target <= now => break,
                    Some(target) => {
                        let timeout = target.saturating_duration_since(now);
                        let (guard, _) = store
                            .wake
                            .wait_timeout(inner, timeout)
                            .unwrap_or_else(|e| e.into_inner());
                        inner = guard;
                    }
                }
            }
        }
        let _ = store.flush_due_at(Instant::now());
    }
}

static GLOBAL_STORE: OnceLock<Arc<CanvasStore<DiskCanvasIo>>> = OnceLock::new();

fn global_store() -> &'static Arc<CanvasStore<DiskCanvasIo>> {
    GLOBAL_STORE.get_or_init(|| {
        Arc::new(CanvasStore::new(DiskCanvasIo, SAVE_DEBOUNCE, FSYNC_INTERVAL))
    })
}

pub(crate) fn load_boards(path: &Path) -> Result<Boards, String> {
    global_store().load_at(path, Instant::now())
}

pub(crate) fn save_board(path: &Path, key: &str, board: Board) -> Result<(), String> {
    let store = global_store();
    store.save_at(path, key, board, Instant::now())?;
    ensure_worker(store);
    Ok(())
}

pub(crate) fn flush_pending_saves() -> Result<(), String> {
    if let Some(store) = GLOBAL_STORE.get() {
        store.flush_all_with_fsync(Instant::now())
    } else {
        Ok(())
    }
}
