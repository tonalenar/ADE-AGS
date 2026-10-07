//! Background export of the approved-memory Markdown repository.
//!
//! SQLite is committed first. Git runs afterwards, on one worker, without the database
//! mutex. Approvals of the same workspace that arrive during an export collapse into a
//! single follow-up, so a batch does not start one git process per item.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::database::DbConnection;

use super::repo::{self, ExportResult, GitRunner};

pub const SYNC_EVENT: &str = "cc-memory-repo-sync";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSyncStatus {
    pub workspace_id: String,
    pub phase: String,
    pub error: Option<String>,
    pub commit: Option<String>,
    pub pending: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Queued,
    Syncing,
    Synced,
    Failed,
}

struct Slot {
    generation: u64,
    synced: u64,
    phase: Phase,
    error: Option<String>,
    commit: Option<String>,
    path: Option<String>,
    files: Vec<String>,
    attempts: u32,
    retry_at: Option<Instant>,
    latest_approval: Option<(String, i64)>,
    pending_approvals: u32,
    last_attempt_gen: u64,
    last_ok: bool,
}

impl Default for Slot {
    fn default() -> Self {
        Self {
            generation: 0,
            synced: 0,
            phase: Phase::Idle,
            error: None,
            commit: None,
            path: None,
            files: Vec::new(),
            attempts: 0,
            retry_at: None,
            latest_approval: None,
            pending_approvals: 0,
            last_attempt_gen: 0,
            last_ok: true,
        }
    }
}

struct Job {
    workspace: String,
    generation: u64,
    approval: Option<(String, i64)>,
    pending_approvals: u32,
}

struct SyncState {
    slots: BTreeMap<String, Slot>,
}

struct Inner {
    db: DbConnection,
    root: PathBuf,
    git: GitRunner,
    backoff: Arc<dyn Fn(u32) -> Duration + Send + Sync>,
    state: Mutex<SyncState>,
    wake: Condvar,
    stop: AtomicBool,
    running: AtomicBool,
    notify: Mutex<Option<Arc<dyn Fn(&RepoSyncStatus) + Send + Sync>>>,
}

pub struct RepoSync {
    inner: Arc<Inner>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RepoSync {
    pub fn new(db: DbConnection, root: PathBuf) -> Self {
        Self::with_runner(db, root, repo::real_git_runner(), default_backoff())
    }

    pub fn with_runner(
        db: DbConnection,
        root: PathBuf,
        git: GitRunner,
        backoff: Arc<dyn Fn(u32) -> Duration + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                root,
                git,
                backoff,
                state: Mutex::new(SyncState { slots: BTreeMap::new() }),
                wake: Condvar::new(),
                stop: AtomicBool::new(false),
                running: AtomicBool::new(false),
                notify: Mutex::new(None),
            }),
            worker: Mutex::new(None),
        }
    }

    pub fn set_notifier(&self, notify: Arc<dyn Fn(&RepoSyncStatus) + Send + Sync>) {
        *self.inner.notify.lock().unwrap_or_else(|err| err.into_inner()) = Some(notify);
    }

    pub fn spawn(&self) {
        let mut worker = self.worker.lock().unwrap_or_else(|err| err.into_inner());
        if worker.is_some() {
            return;
        }
        self.inner.running.store(true, Ordering::SeqCst);
        let inner = Arc::clone(&self.inner);
        *worker = Some(
            std::thread::Builder::new()
                .name("memory-repo-sync".into())
                .spawn(move || worker_loop(inner))
                .expect("memory repo sync thread"),
        );
    }

    /// Records that `workspace` needs an export. Returns the generation the caller is waiting on.
    /// Never runs git and never needs the database lock.
    pub fn enqueue(&self, workspace: &str, approval: Option<(String, i64)>) -> u64 {
        let (generation, status) = {
            let mut state = self.lock_state();
            let slot = state.slots.entry(workspace.to_string()).or_default();
            slot.generation = slot.generation.saturating_add(1);
            if let Some(approval) = approval {
                slot.latest_approval = Some(approval);
                slot.pending_approvals = slot.pending_approvals.saturating_add(1);
            }
            if slot.phase == Phase::Failed {
                // Keep the error on screen, but don't make a new approval wait out the full backoff.
                let soon = Instant::now() + Duration::from_millis(200);
                slot.retry_at = Some(slot.retry_at.map_or(soon, |at| at.min(soon)));
            } else if slot.phase != Phase::Syncing {
                slot.phase = Phase::Queued;
                slot.retry_at = None;
            }
            let generation = slot.generation;
            self.inner.wake.notify_all();
            (generation, snapshot(&state, workspace))
        };
        self.emit(&status);
        generation
    }

    pub fn retry(&self, workspace: &str) -> RepoSyncStatus {
        let status = {
            let mut state = self.lock_state();
            if let Some(slot) = state.slots.get_mut(workspace) {
                if slot.generation > slot.synced {
                    slot.retry_at = Some(Instant::now());
                    self.inner.wake.notify_all();
                }
            }
            snapshot(&state, workspace)
        };
        self.emit(&status);
        status
    }

    pub fn status(&self, workspace: &str) -> RepoSyncStatus {
        snapshot(&self.lock_state(), workspace)
    }

    /// Explicit export. Waits for the worker, but the caller must not be holding the database lock:
    /// the worker needs it to render.
    pub fn export_now(&self, workspace: &str) -> Result<ExportResult, String> {
        if !self.inner.running.load(Ordering::SeqCst) {
            return Err("O sincronizador do repositório de memória não está ativo.".into());
        }
        let generation = self.enqueue(workspace, None);
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut state = self.lock_state();
        loop {
            if let Some(done) = export_now_result(&state, workspace, generation) {
                return done;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("A exportação do repositório de memória excedeu o tempo.".into());
            }
            let (guard, wait) = self.inner.wake.wait_timeout(state, deadline - now).unwrap_or_else(|err| err.into_inner());
            state = guard;
            if wait.timed_out() && Instant::now() >= deadline {
                if let Some(done) = export_now_result(&state, workspace, generation) {
                    return done;
                }
                return Err("A exportação do repositório de memória excedeu o tempo.".into());
            }
        }
    }

    pub fn wait_until(
        &self,
        workspace: &str,
        mut pred: impl FnMut(&RepoSyncStatus) -> bool,
        timeout: Duration,
    ) -> Result<RepoSyncStatus, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock_state();
        loop {
            let status = snapshot(&state, workspace);
            if pred(&status) {
                return Ok(status);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("timeout waiting for memory sync ({})", status.phase));
            }
            let (guard, wait) = self.inner.wake.wait_timeout(state, deadline - now).unwrap_or_else(|err| err.into_inner());
            state = guard;
            if wait.timed_out() && Instant::now() >= deadline {
                let status = snapshot(&state, workspace);
                if pred(&status) {
                    return Ok(status);
                }
                return Err(format!("timeout waiting for memory sync ({})", status.phase));
            }
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, SyncState> {
        self.inner.state.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn emit(&self, status: &RepoSyncStatus) {
        let notify = self.inner.notify.lock().unwrap_or_else(|err| err.into_inner()).clone();
        if let Some(notify) = notify {
            notify(status);
        }
    }
}

impl Drop for RepoSync {
    fn drop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        self.inner.wake.notify_all();
        if let Some(handle) = self.worker.lock().unwrap_or_else(|err| err.into_inner()).take() {
            let _ = handle.join();
        }
    }
}

fn default_backoff() -> Arc<dyn Fn(u32) -> Duration + Send + Sync> {
    Arc::new(|attempts: u32| {
        let shift = attempts.saturating_sub(1).min(6);
        Duration::from_millis(500u64.saturating_mul(1_u64 << shift))
    })
}

fn export_now_result(state: &SyncState, workspace: &str, generation: u64) -> Option<Result<ExportResult, String>> {
    let slot = state.slots.get(workspace)?;
    if slot.synced >= generation {
        return Some(Ok(ExportResult {
            path: slot.path.clone().unwrap_or_default(),
            commit: slot.commit.clone(),
            files: slot.files.clone(),
        }));
    }
    if !slot.last_ok && slot.last_attempt_gen >= generation && slot.phase == Phase::Failed {
        return Some(Err(slot.error.clone().unwrap_or_else(|| "export failed".into())));
    }
    None
}

fn snapshot(state: &SyncState, workspace: &str) -> RepoSyncStatus {
    let Some(slot) = state.slots.get(workspace) else {
        return RepoSyncStatus {
            workspace_id: workspace.to_string(),
            phase: "idle".into(),
            error: None,
            commit: None,
            pending: 0,
        };
    };
    RepoSyncStatus {
        workspace_id: workspace.to_string(),
        phase: phase_name(slot.phase).into(),
        error: slot.error.clone(),
        commit: slot.commit.clone(),
        pending: slot.generation.saturating_sub(slot.synced) as u32,
    }
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Idle => "idle",
        Phase::Queued => "queued",
        Phase::Syncing => "syncing",
        Phase::Synced => "synced",
        Phase::Failed => "failed",
    }
}

fn next_job(state: &SyncState, now: Instant) -> Option<Job> {
    for (id, slot) in &state.slots {
        if slot.generation <= slot.synced {
            continue;
        }
        if slot.retry_at.is_some_and(|at| at > now) {
            continue;
        }
        return Some(Job {
            workspace: id.clone(),
            generation: slot.generation,
            approval: slot.latest_approval.clone(),
            pending_approvals: slot.pending_approvals,
        });
    }
    None
}

fn next_delay(state: &SyncState, now: Instant) -> Option<Duration> {
    let mut soonest: Option<Duration> = None;
    for slot in state.slots.values() {
        if slot.generation <= slot.synced {
            continue;
        }
        if let Some(at) = slot.retry_at {
            if at > now {
                let delay = at.saturating_duration_since(now);
                soonest = Some(soonest.map_or(delay, |current| current.min(delay)));
            } else {
                return Some(Duration::ZERO);
            }
        } else {
            return Some(Duration::ZERO);
        }
    }
    soonest
}

fn worker_loop(inner: Arc<Inner>) {
    let mut state = inner.state.lock().unwrap_or_else(|err| err.into_inner());
    loop {
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        let now = Instant::now();
        if let Some(job) = next_job(&state, now) {
            if let Some(slot) = state.slots.get_mut(&job.workspace) {
                slot.phase = Phase::Syncing;
            }
            let status = snapshot(&state, &job.workspace);
            drop(state);
            emit_inner(&inner, &status);

            let approval = job.approval.clone();
            let result = do_export(&inner, &job.workspace, approval.as_ref().map(|(entry, revision)| (entry.as_str(), *revision)), job.pending_approvals);

            state = inner.state.lock().unwrap_or_else(|err| err.into_inner());
            if inner.stop.load(Ordering::SeqCst) {
                break;
            }
            apply_result(&inner, &mut state, &job, result);
            let status = snapshot(&state, &job.workspace);
            inner.wake.notify_all();
            drop(state);
            emit_inner(&inner, &status);
            state = inner.state.lock().unwrap_or_else(|err| err.into_inner());
            continue;
        }
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        state = match next_delay(&state, Instant::now()) {
            Some(delay) if delay.is_zero() => state,
            Some(delay) => {
                let (guard, _) = inner.wake.wait_timeout(state, delay).unwrap_or_else(|err| err.into_inner());
                guard
            }
            None => inner.wake.wait(state).unwrap_or_else(|err| err.into_inner()),
        };
    }
}

fn emit_inner(inner: &Inner, status: &RepoSyncStatus) {
    let notify = inner.notify.lock().unwrap_or_else(|err| err.into_inner()).clone();
    if let Some(notify) = notify {
        notify(status);
    }
}

fn apply_result(inner: &Inner, state: &mut SyncState, job: &Job, result: Result<ExportResult, String>) {
    let Some(slot) = state.slots.get_mut(&job.workspace) else { return };
    slot.last_attempt_gen = job.generation;
    match result {
        Ok(exported) => {
            slot.commit = exported.commit;
            slot.path = Some(exported.path);
            slot.files = exported.files;
            slot.error = None;
            slot.attempts = 0;
            slot.retry_at = None;
            slot.last_ok = true;
            if slot.generation == job.generation {
                slot.synced = job.generation;
                slot.phase = Phase::Synced;
                slot.pending_approvals = 0;
            } else {
                slot.pending_approvals = slot.pending_approvals.saturating_sub(job.pending_approvals);
                slot.phase = Phase::Queued;
            }
        }
        Err(error) => {
            eprintln!("[memory] exportação do workspace {} falhou: {error}", job.workspace);
            slot.error = Some(error);
            slot.attempts = slot.attempts.saturating_add(1);
            slot.last_ok = false;
            if slot.generation != job.generation {
                // A newer approval landed during this attempt; publish it without waiting out the backoff.
                slot.retry_at = Some(Instant::now());
                slot.phase = Phase::Queued;
            } else {
                slot.retry_at = Some(Instant::now() + (inner.backoff)(slot.attempts));
                slot.phase = Phase::Failed;
            }
        }
    }
}

fn do_export(inner: &Inner, workspace: &str, approval: Option<(&str, i64)>, approval_count: u32) -> Result<ExportResult, String> {
    let (name, files) = {
        let conn = inner.db.lock().map_err(|_| "database unavailable".to_string())?;
        let name: String = conn
            .query_row("SELECT name FROM workspaces WHERE id=?1", [workspace], |row| row.get(0))
            .map_err(|_| "workspace not found".to_string())?;
        let files = repo::render(&conn, workspace, &[])?;
        (name, files)
    };
    // Database lock is gone before the repo gate and every git subprocess.
    repo::publish(&inner.root, &name, workspace, &files, approval, approval_count, &inner.git)
}

pub fn install(app: &tauri::App) {
    let db = app.state::<DbConnection>().inner().clone();
    let root = repo::default_root().expect("home unavailable");
    let sync = RepoSync::new(db, root);
    let handle = app.handle().clone();
    sync.set_notifier(Arc::new(move |status: &RepoSyncStatus| {
        let _ = handle.emit(SYNC_EVENT, status);
    }));
    sync.spawn();
    app.manage(sync);
}

#[tauri::command]
pub fn memory_repo_sync_status(workspace_id: String, sync: tauri::State<RepoSync>) -> RepoSyncStatus {
    sync.status(&workspace_id)
}

#[tauri::command]
pub fn memory_repo_sync_retry(workspace_id: String, sync: tauri::State<RepoSync>) -> RepoSyncStatus {
    sync.retry(&workspace_id)
}

/// Commits the decision, then queues the Markdown export. The git work happens after this returns.
pub fn decide_and_schedule(
    conn: &rusqlite::Connection,
    sync: &RepoSync,
    entry_id: &str,
    revision: i64,
    approve: bool,
) -> Result<(), String> {
    super::decide(conn, entry_id, revision, approve)?;
    if approve {
        let workspace: String = conn
            .query_row("SELECT workspace_id FROM memory_entries WHERE id=?1", [entry_id], |row| row.get(0))
            .map_err(|_| "could not resolve approved memory workspace".to_string())?;
        sync.enqueue(&workspace, Some((entry_id.to_string(), revision)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{ProposalActor, ProposalInput};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Barrier;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ade-memory-sync-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> DbConnection {
        let conn = crate::database::test_db();
        conn.execute_batch(
            "INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','Test workspace',0,0);
             INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m','w','Mission','objective','/test',0,0);",
        )
        .unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn propose(conn: &rusqlite::Connection, key: &str, body: &str) -> crate::memory::ProposalResult {
        crate::memory::propose(
            conn,
            "workspace",
            "w",
            None,
            &ProposalInput {
                scope: "workspace".into(),
                key: key.into(),
                kind: "note".into(),
                body: body.into(),
                priority: 0,
                operation: "create".into(),
                expected_revision: None,
                source_fact_id: None,
                reason: None,
            },
            ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None },
        )
        .unwrap()
    }

    struct Probe {
        db: DbConnection,
        commits: AtomicUsize,
        adds: AtomicUsize,
        saw_lock_free: AtomicBool,
        fail_commits: AtomicBool,
        block_commit: AtomicBool,
        entered: Arc<(Mutex<bool>, Condvar)>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Probe {
        fn new(db: DbConnection) -> Arc<Self> {
            Arc::new(Self {
                db,
                commits: AtomicUsize::new(0),
                adds: AtomicUsize::new(0),
                saw_lock_free: AtomicBool::new(false),
                fail_commits: AtomicBool::new(false),
                block_commit: AtomicBool::new(false),
                entered: Arc::new((Mutex::new(false), Condvar::new())),
                release: Arc::new((Mutex::new(false), Condvar::new())),
            })
        }

        fn runner(self: &Arc<Self>) -> GitRunner {
            let probe = Arc::clone(self);
            Arc::new(move |_path, args: &[String]| {
                if args.iter().any(|arg| arg == "add") {
                    probe.adds.fetch_add(1, Ordering::SeqCst);
                }
                if args.iter().any(|arg| arg == "commit") {
                    probe.commits.fetch_add(1, Ordering::SeqCst);
                    if probe.db.try_lock().is_ok() {
                        probe.saw_lock_free.store(true, Ordering::SeqCst);
                    }
                    if probe.fail_commits.load(Ordering::SeqCst) {
                        return Err("memory git failed: simulated outage".into());
                    }
                    if probe.block_commit.load(Ordering::SeqCst) {
                        {
                            let (lock, cv) = &*probe.entered;
                            *lock.lock().unwrap() = true;
                            cv.notify_all();
                        }
                        let (lock, cv) = &*probe.release;
                        let mut guard = lock.lock().unwrap();
                        let start = Instant::now();
                        while !*guard {
                            if start.elapsed() > Duration::from_secs(8) {
                                return Err("memory git failed: test gate timed out".into());
                            }
                            let (next, _) = cv.wait_timeout(guard, Duration::from_millis(50)).unwrap();
                            guard = next;
                        }
                    }
                }
                if args.iter().any(|arg| arg == "rev-parse") {
                    Ok(format!("commit-{}", probe.commits.load(Ordering::SeqCst)))
                } else {
                    Ok(String::new())
                }
            })
        }

        fn wait_entered(&self) {
            let (lock, cv) = &*self.entered;
            let mut guard = lock.lock().unwrap();
            let start = Instant::now();
            while !*guard {
                assert!(start.elapsed() < Duration::from_secs(3), "git commit was not reached");
                let (next, _) = cv.wait_timeout(guard, Duration::from_millis(50)).unwrap();
                guard = next;
            }
        }

        fn unblock(&self) {
            self.block_commit.store(false, Ordering::SeqCst);
            let (lock, cv) = &*self.release;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
    }

    fn hour() -> Arc<dyn Fn(u32) -> Duration + Send + Sync> {
        Arc::new(|_: u32| Duration::from_secs(3600))
    }

    fn notes(root: &std::path::Path) -> String {
        let path = root.join(repo::slug("Test workspace", "w")).join("notes.md");
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn approved_count(db: &DbConnection) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM memory_revisions WHERE status='approved'", [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn reject_does_not_schedule_export() {
        let db = fixture();
        let root = TempDir::new();
        let probe = Probe::new(db.clone());
        let sync = RepoSync::with_runner(db.clone(), root.path().to_path_buf(), probe.runner(), hour());
        let proposal = {
            let conn = db.lock().unwrap();
            let proposal = propose(&conn, "kept", "still pending");
            decide_and_schedule(&conn, &sync, &proposal.entry_id, proposal.revision, false).unwrap();
            proposal
        };
        assert_eq!(sync.status("w").phase, "idle");
        assert_eq!(probe.commits.load(Ordering::SeqCst), 0);
        let conn = db.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM memory_revisions WHERE entry_id=?1 AND revision=?2", rusqlite::params![proposal.entry_id, proposal.revision], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "rejected");
    }

    #[test]
    fn batch_approve_coalesces_into_one_export() {
        let db = fixture();
        let root = TempDir::new();
        let probe = Probe::new(db.clone());
        let sync = RepoSync::with_runner(db.clone(), root.path().to_path_buf(), probe.runner(), hour());
        {
            let conn = db.lock().unwrap();
            for index in 0..6 {
                let proposal = propose(&conn, &format!("k{index}"), &format!("approved body {index}"));
                decide_and_schedule(&conn, &sync, &proposal.entry_id, proposal.revision, true).unwrap();
            }
        }
        let started = Instant::now();
        sync.spawn();
        let status = sync.wait_until("w", |item| item.phase == "synced" && item.pending == 0, Duration::from_secs(5)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(probe.commits.load(Ordering::SeqCst), 1, "a batch must become one commit");
        assert_eq!(probe.adds.load(Ordering::SeqCst), 1, "a batch must become one git add");
        assert!(probe.saw_lock_free.load(Ordering::SeqCst));
        assert!(status.error.is_none());
        assert_eq!(approved_count(&db), 6);
        let page = notes(root.path());
        for index in 0..6 {
            assert!(page.contains(&format!("approved body {index}")), "{page}");
        }
    }

    #[test]
    fn slow_git_does_not_hold_the_database_and_approvals_stay_committed() {
        let db = fixture();
        let root = TempDir::new();
        let probe = Probe::new(db.clone());
        probe.block_commit.store(true, Ordering::SeqCst);
        let sync = RepoSync::with_runner(db.clone(), root.path().to_path_buf(), probe.runner(), hour());
        sync.spawn();
        {
            let conn = db.lock().unwrap();
            let proposal = propose(&conn, "first", "approved body 0");
            let started = Instant::now();
            decide_and_schedule(&conn, &sync, &proposal.entry_id, proposal.revision, true).unwrap();
            assert!(started.elapsed() < Duration::from_millis(500), "approval waited for git");
        }
        probe.wait_entered();
        assert!(db.try_lock().is_ok(), "database mutex held while git is running");
        assert_eq!(approved_count(&db), 1);
        let started = Instant::now();
        {
            let conn = db.lock().unwrap();
            for index in 1..6 {
                let proposal = propose(&conn, &format!("k{index}"), &format!("approved body {index}"));
                decide_and_schedule(&conn, &sync, &proposal.entry_id, proposal.revision, true).unwrap();
            }
        }
        assert!(started.elapsed() < Duration::from_millis(800), "batch approval blocked on slow git: {:?}", started.elapsed());
        assert_eq!(approved_count(&db), 6);
        assert_eq!(probe.commits.load(Ordering::SeqCst), 1);
        probe.unblock();
        let status = sync.wait_until("w", |item| item.phase == "synced" && item.pending == 0, Duration::from_secs(5)).unwrap();
        assert!(status.error.is_none(), "{:?}", status.error);
        let commits = probe.commits.load(Ordering::SeqCst);
        assert!((1..=2).contains(&commits), "expected a coalesced follow-up, got {commits} commits");
        assert_eq!(probe.adds.load(Ordering::SeqCst), commits);
        let page = notes(root.path());
        for index in 0..6 {
            assert!(page.contains(&format!("approved body {index}")), "{page}");
        }
    }

    #[test]
    fn failed_git_keeps_the_approval_visible_and_retry_succeeds() {
        let db = fixture();
        let root = TempDir::new();
        let probe = Probe::new(db.clone());
        probe.fail_commits.store(true, Ordering::SeqCst);
        let sync = RepoSync::with_runner(db.clone(), root.path().to_path_buf(), probe.runner(), hour());
        sync.spawn();
        let proposal = {
            let conn = db.lock().unwrap();
            let proposal = propose(&conn, "kept", "approved body kept");
            decide_and_schedule(&conn, &sync, &proposal.entry_id, proposal.revision, true).unwrap();
            proposal
        };
        let failed = sync.wait_until("w", |item| item.phase == "failed", Duration::from_secs(3)).unwrap();
        assert!(failed.error.as_deref().unwrap_or("").contains("simulated outage"), "{:?}", failed.error);
        assert!(probe.saw_lock_free.load(Ordering::SeqCst));
        {
            let conn = db.lock().unwrap();
            let status: String = conn
                .query_row(
                    "SELECT r.status FROM memory_revisions r WHERE r.entry_id=?1 AND r.revision=?2",
                    rusqlite::params![proposal.entry_id, proposal.revision],
                    |row| row.get(0),
                )
                .unwrap();
            let current: Option<i64> = conn
                .query_row("SELECT current_revision FROM memory_entries WHERE id=?1", [&proposal.entry_id], |row| row.get(0))
                .unwrap();
            assert_eq!(status, "approved");
            assert_eq!(current, Some(proposal.revision));
        }
        probe.fail_commits.store(false, Ordering::SeqCst);
        let queued = sync.retry("w");
        assert_eq!(queued.workspace_id, "w");
        let synced = sync.wait_until("w", |item| item.phase == "synced" && item.pending == 0, Duration::from_secs(3)).unwrap();
        assert!(synced.error.is_none(), "{:?}", synced.error);
        assert!(synced.commit.is_some());
        assert!(notes(root.path()).contains("approved body kept"));
        assert!(probe.commits.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn concurrent_approvals_serialize_git() {
        let db = fixture();
        let root = TempDir::new();
        let current = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let commits = Arc::new(AtomicUsize::new(0));
        let current_git = Arc::clone(&current);
        let peak_git = Arc::clone(&peak);
        let commits_git = Arc::clone(&commits);
        let runner: GitRunner = Arc::new(move |_path, args: &[String]| {
            let now = current_git.fetch_add(1, Ordering::SeqCst) + 1;
            peak_git.fetch_max(now, Ordering::SeqCst);
            if args.iter().any(|arg| arg == "commit") {
                commits_git.fetch_add(1, Ordering::SeqCst);
                // Sibling approvals may still hold the database lock. The worker
                // releasing it is covered by slow_git_does_not_hold_the_database.
                std::thread::sleep(Duration::from_millis(30));
            }
            let hash = if args.iter().any(|arg| arg == "rev-parse") {
                format!("c{}", commits_git.load(Ordering::SeqCst))
            } else {
                String::new()
            };
            current_git.fetch_sub(1, Ordering::SeqCst);
            Ok(hash)
        });
        let sync = RepoSync::with_runner(db.clone(), root.path().to_path_buf(), runner, hour());
        sync.spawn();
        std::thread::scope(|scope| {
            for index in 0..4 {
                let db = &db;
                let sync = &sync;
                scope.spawn(move || {
                    let conn = db.lock().unwrap();
                    let proposal = propose(&conn, &format!("c{index}"), &format!("concurrent body {index}"));
                    decide_and_schedule(&conn, sync, &proposal.entry_id, proposal.revision, true).unwrap();
                });
            }
        });
        let status = sync.wait_until("w", |item| item.phase == "synced" && item.pending == 0, Duration::from_secs(5)).unwrap();
        assert!(status.error.is_none(), "{:?}", status.error);
        assert_eq!(peak.load(Ordering::SeqCst), 1, "git commands from concurrent exports overlapped");
        assert!(commits.load(Ordering::SeqCst) >= 1);
        assert_eq!(approved_count(&db), 4);
        let page = notes(root.path());
        for index in 0..4 {
            assert!(page.contains(&format!("concurrent body {index}")), "{page}");
        }
    }

    #[test]
    fn publish_stages_managed_paths_with_one_git_add() {
        let root = TempDir::new();
        let log = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let recorded = Arc::clone(&log);
        let runner: GitRunner = Arc::new(move |_path, args: &[String]| {
            recorded.lock().unwrap().push(args.to_vec());
            if args.iter().any(|arg| arg == "rev-parse") { Ok("abc".into()) } else { Ok(String::new()) }
        });
        let mut files = BTreeMap::new();
        files.insert("MEMORY.md".into(), "# Memory\n".into());
        files.insert("notes.md".into(), "# Notes\n\n- one\n".into());
        files.insert("missions/demo.md".into(), "# Mission\n".into());
        repo::publish(root.path(), "Test workspace", "w", &files, Some(("entry", 1)), 1, &runner).unwrap();
        let adds: Vec<_> = log.lock().unwrap().iter().filter(|args| args.iter().any(|arg| arg == "add")).cloned().collect();
        assert_eq!(adds.len(), 1, "{adds:?}");
        assert!(adds[0].contains(&"--all".into()));
        assert!(adds[0].contains(&"MEMORY.md".into()));
        assert!(adds[0].contains(&"notes.md".into()));
        assert!(adds[0].contains(&"missions/demo.md".into()));
        assert!(std::fs::read_to_string(root.path().join(repo::slug("Test workspace", "w")).join("notes.md")).unwrap().contains("one"));
    }

    #[test]
    fn concurrent_publishes_do_not_overlap() {
        let root = TempDir::new();
        let current = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let current_git = Arc::clone(&current);
        let peak_git = Arc::clone(&peak);
        let runner: GitRunner = Arc::new(move |_path, args: &[String]| {
            let now = current_git.fetch_add(1, Ordering::SeqCst) + 1;
            peak_git.fetch_max(now, Ordering::SeqCst);
            if args.iter().any(|arg| arg == "commit") {
                std::thread::sleep(Duration::from_millis(60));
            }
            let answer = if args.iter().any(|arg| arg == "rev-parse") { "abc".into() } else { String::new() };
            current_git.fetch_sub(1, Ordering::SeqCst);
            Ok(answer)
        });
        let barrier = Arc::new(Barrier::new(2));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let root = root.path().to_path_buf();
            let runner = Arc::clone(&runner);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                let mut files = BTreeMap::new();
                files.insert("MEMORY.md".into(), "# Memory\n".into());
                files.insert("notes.md".into(), "# Notes\n".into());
                repo::publish(&root, "Test workspace", "w", &files, Some(("entry", 1)), 1, &runner).unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "git commands from two exports overlapped");
    }
}
