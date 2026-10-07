//! Real independent SQLite connections and subprocesses, never the user's database.
use super::*;
use std::path::{Path, PathBuf};
use std::time::Duration;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ade-memory-sqlite-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let f = Self(root);
        let c = open(&f.path());
        crate::database::migrate_for_tests(&c).unwrap();
        c.execute(
            "INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','isolated',0,0)",
            [],
        )
        .unwrap();
        f
    }
    fn path(&self) -> PathBuf {
        self.0.join("test.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn open(path: &Path) -> Connection {
    assert_eq!(path.file_name().unwrap(), "test.sqlite");
    assert!(path
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ade-memory-sqlite-"));
    let c = Connection::open(path).unwrap();
    c.busy_timeout(Duration::from_secs(10)).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;")
        .unwrap();
    c
}
fn write(c: &Connection, key: String) {
    let input = ProposalInput {
        scope: "workspace".into(),
        key,
        kind: "note".into(),
        body: "parallel knowledge".into(),
        priority: 0,
        operation: "create".into(),
        expected_revision: None,
        source_fact_id: None,
        reason: None,
    };
    let result = propose(
        c,
        "workspace",
        "w",
        None,
        &input,
        ProposalActor {
            kind: "user",
            run_id: None,
            task_id: None,
            fact_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.status, "proposed");
}

#[test]
fn separate_threads_serialize_proposals_without_busy_snapshot_or_data_loss() {
    let fixture = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads = (0..8)
        .map(|n| {
            let path = fixture.path();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let c = open(&path);
                barrier.wait();
                for i in 0..3 {
                    write(&c, format!("thread-{n}-{i}"));
                }
            })
        })
        .collect::<Vec<_>>();
    for t in threads {
        t.join().unwrap();
    }
    let c = open(&fixture.path());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM memory_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        24
    );
}

#[test]
fn subprocess_writer() {
    let Some(path) = std::env::var_os("ADE_MEMORY_CONCURRENCY_TEST_PATH") else {
        return;
    };
    let worker = std::env::var("ADE_MEMORY_CONCURRENCY_TEST_WORKER").unwrap();
    let c = open(Path::new(&path));
    for n in 0..12 {
        write(&c, format!("process-{worker}-{n}"));
    }
}

#[test]
fn two_processes_write_the_same_sqlite_file_without_losing_proposals() {
    let fixture = Fixture::new();
    let exe = std::env::current_exe().unwrap();
    let mut children = (0..2)
        .map(|n| {
            let mut cmd = crate::util::program(exe.to_str().unwrap());
            cmd.args([
                "--exact",
                "memory::concurrency::subprocess_writer",
                "--nocapture",
            ])
            .env("ADE_MEMORY_CONCURRENCY_TEST_PATH", fixture.path())
            .env("ADE_MEMORY_CONCURRENCY_TEST_WORKER", n.to_string());
            cmd.spawn().unwrap()
        })
        .collect::<Vec<_>>();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let c = open(&fixture.path());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM memory_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        24
    );
}
