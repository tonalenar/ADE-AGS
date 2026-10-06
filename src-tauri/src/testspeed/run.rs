//! Local test execution: cache only a clean, unchanged Git tree; never hold a DB lock
//! while a child process runs. Commands are argv vectors, never shell interpolation.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TestCommand {
    pub suite: String,
    pub program: String,
    pub args: Vec<String>,
    /// Directory relative to the repository root.
    pub cwd: String,
}

pub fn suite_commands(suite: &str) -> Result<Vec<TestCommand>, String> {
    let (program, args, cwd) = match suite {
        "frontend" => ("node", vec!["node_modules/vitest/vitest.mjs", "run"], "."),
        "rust" => ("cargo", vec!["test", "--lib", "--bin", "ags"], "src-tauri"),
        "tsc" => (
            "node",
            vec!["node_modules/typescript/bin/tsc", "--noEmit"],
            ".",
        ),
        "babel" => ("node", vec!["scripts/babel-parse-check.mjs", "src"], "."),
        _ => {
            return Err(format!(
                "Suite desconhecida '{suite}': frontend, rust, tsc, babel."
            ));
        }
    };
    Ok(vec![TestCommand {
        suite: suite.into(),
        program: program.into(),
        args: args.into_iter().map(str::to_owned).collect(),
        cwd: cwd.into(),
    }])
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repository TEXT NOT NULL,
        tree_hash TEXT, suite TEXT NOT NULL, command_key TEXT NOT NULL,
        commands TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        passed INTEGER NOT NULL CHECK(passed IN (0,1)), clean INTEGER NOT NULL CHECK(clean IN (0,1)),
        finished_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_test_results_cache
        ON test_results(repository, tree_hash, suite, command_key, id);")
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Committed changes since the merge base plus tracked and untracked local edits.
/// NUL delimiters preserve paths containing spaces/newlines; deleted paths remain
/// in the plan, so deleting a module cannot silently remove its validation.
pub fn changed_files(root: &Path) -> Result<Vec<String>, String> {
    let mut files = std::collections::BTreeSet::new();
    for args in [
        vec![
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "origin/master...HEAD",
        ],
        vec!["diff", "--name-only", "-z", "--no-renames", "HEAD"],
        vec!["ls-files", "--others", "--exclude-standard", "-z"],
    ] {
        let out = Command::new("git")
            .args(&args)
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "Não foi possível obter arquivos afetados (git {}): {}. Confira origin/master; nenhum teste foi pulado.",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        for path in out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            files
                .insert(String::from_utf8(path.to_vec()).map_err(
                    |_| "Nome de arquivo Git não é UTF-8; execute as suites completas.",
                )?);
        }
    }
    Ok(files.into_iter().collect())
}

pub fn unsafe_files(root: &Path, changed: &[String]) -> Result<Vec<String>, String> {
    let mut files = std::collections::BTreeSet::new();
    for revision in ["origin/master...HEAD", "HEAD"] {
        let diff = git(
            root,
            &[
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                revision,
            ],
        )?;
        files.extend(super::affected::files_adding_unsafe(&diff));
    }
    // Untracked files are absent from diff. Conservatively require the full Rust
    // suite for any changed Rust file containing unsafe, including existing code.
    // This also covers Git's quoted patch paths and removals of unsafe code.
    let token = regex::Regex::new(r"\bunsafe\b").expect("constant regex");
    for file in changed.iter().filter(|f| f.ends_with(".rs")) {
        match std::fs::read_to_string(root.join(file)) {
            Ok(source) if token.is_match(&source) => {
                files.insert(file.clone());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                files.insert(file.clone());
            }
            Err(error) => {
                return Err(format!(
                    "Não foi possível verificar risco em {file}: {error}"
                ));
            }
        }
    }
    Ok(files.into_iter().collect())
}

/// Untracked and staged changes count as dirty. No index writes, so another agent's
/// staging area is never changed by a test command.
pub fn clean_tree(root: &Path) -> Result<Option<String>, String> {
    if !git(
        root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    let tree = git(root, &["rev-parse", "HEAD^{tree}"])?;
    if !git(
        root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?
    .is_empty()
        || git(root, &["rev-parse", "HEAD^{tree}"])? != tree
    {
        return Ok(None);
    }
    Ok(Some(tree))
}

pub fn command_key(commands: &[TestCommand]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(commands).expect("serializable commands"))
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub fn cached_green(
    conn: &Connection,
    repo: &str,
    tree: Option<&str>,
    suite: &str,
    key: &str,
) -> Result<Option<i64>, String> {
    let Some(tree) = tree else {
        return Ok(None);
    };
    // Latest result wins: a forced failing rerun invalidates a previous green.
    let latest: Option<(bool, i64)> = conn.query_row(
        "SELECT passed,finished_at FROM test_results WHERE repository=?1 AND tree_hash=?2 AND suite=?3 AND command_key=?4 AND clean=1 ORDER BY id DESC LIMIT 1",
        params![repo, tree, suite, key], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())?;
    Ok(latest.and_then(|(passed, at)| passed.then_some(at)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub suite: String,
    pub passed: bool,
    pub cache_hit: bool,
    pub duration_ms: i64,
    pub tree_hash: Option<String>,
    pub message: String,
}

pub fn record_span(
    conn: &Connection,
    mission: Option<&str>,
    actor: &str,
    suite: &str,
    command: &str,
    started: i64,
    ended: i64,
    cache_hit: bool,
    skipped_affected: usize,
) -> Result<(), String> {
    if let Some(mission) = mission {
        let command: String = command.chars().take(1_000).collect();
        crate::missions::timings::add(conn, mission, &crate::missions::timings::NewSpan {
            kind: "test".into(), actor: actor.into(), target: suite.into(), started_ms: started, ended_ms: ended,
            detail: serde_json::json!({"cacheHit":cache_hit,"skippedAffected":skipped_affected,"command":command}).to_string(),
        })?;
    }
    Ok(())
}

pub fn run(
    conn: &Connection,
    root: &Path,
    suite: &str,
    commands: &[TestCommand],
    force: bool,
    mission: Option<&str>,
    actor: &str,
) -> Result<RunResult, String> {
    if commands.is_empty() {
        return Err("Plano de testes vazio; nenhum resultado verde foi registrado.".into());
    }
    let repo = git(root, &["rev-parse", "--git-common-dir"])?;
    let repo = dunce::canonicalize(root.join(repo))
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let tree = clean_tree(root)?;
    let key = command_key(commands);
    if !force {
        if let Some(at) = cached_green(conn, &repo, tree.as_deref(), suite, &key)? {
            let now = now_ms();
            for command in commands {
                record_span(
                    conn,
                    mission,
                    actor,
                    &command.suite,
                    &serde_json::to_string(command).map_err(|e| e.to_string())?,
                    now,
                    now,
                    true,
                    0,
                )?;
            }
            return Ok(RunResult {
                suite: suite.into(),
                passed: true,
                cache_hit: true,
                duration_ms: 0,
                tree_hash: tree,
                message: format!(
                    "já verde neste hash (há {} min)",
                    (now - at).max(0) / 60_000
                ),
            });
        }
    }
    let timer = Instant::now();
    let mut passed = true;
    for command in commands {
        let started = now_ms();
        eprintln!(
            "{} {:?} (em {})",
            command.program, command.args, command.cwd
        );
        let mut child = Command::new(&command.program);
        child
            .args(&command.args)
            .current_dir(root.join(&command.cwd));
        if command.program == "cargo" {
            // Explicit per-worktree/custom overrides remain available. Default never
            // borrows tauri dev's target or the briefing's obsolete inherited value.
            let configured = std::env::var_os(crate::floors::CARGO_TARGET_DIR_SETTING);
            let target = crate::floors::cargo_target_dir(root, root, configured.as_deref());
            child.env("CARGO_TARGET_DIR", target.path);
        }
        // Keep the CLI's JSON stdout usable by tools. Stream test output to stderr
        // without buffering an entire suite in memory.
        let outcome = child.stdout(Stdio::piped()).spawn().and_then(|mut child| {
            let copied = if let Some(mut out) = child.stdout.take() {
                std::io::copy(&mut out, &mut std::io::stderr()).map(|_| ())
            } else {
                Ok(())
            };
            let status = child.wait();
            copied.and(status)
        });
        record_span(
            conn,
            mission,
            actor,
            &command.suite,
            &serde_json::to_string(command).map_err(|e| e.to_string())?,
            started,
            now_ms(),
            false,
            0,
        )?;
        match outcome {
            Ok(status) => passed &= status.success(),
            Err(error) => {
                eprintln!("Não foi possível executar {}: {error}", command.program);
                passed = false;
            }
        }
        if !passed {
            break;
        }
    }
    let duration_ms = timer.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let after = clean_tree(root)?;
    let clean = tree.is_some() && tree == after;
    conn.execute("INSERT INTO test_results(repository,tree_hash,suite,command_key,commands,duration_ms,passed,clean,finished_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![repo, tree, suite, key, serde_json::to_string(commands).map_err(|e| e.to_string())?, duration_ms, passed, clean, now_ms()]).map_err(|e| e.to_string())?;
    Ok(RunResult {
        suite: suite.into(),
        passed,
        cache_hit: false,
        duration_ms,
        tree_hash: tree,
        message: if clean {
            "resultado registrado"
        } else {
            "árvore suja ou alterada durante o teste: sem reutilização de cache"
        }
        .into(),
    })
}

pub fn status(conn: &Connection, root: &Path) -> Result<serde_json::Value, String> {
    let repo = git(root, &["rev-parse", "--git-common-dir"])?;
    let repo = dunce::canonicalize(root.join(repo))
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let mut stmt = conn.prepare("SELECT tree_hash,suite,commands,duration_ms,passed,clean,finished_at FROM test_results WHERE repository=?1 ORDER BY id DESC LIMIT 50").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([repo], |r| Ok(serde_json::json!({"treeHash":r.get::<_,Option<String>>(0)?,"suite":r.get::<_,String>(1)?,"commands":r.get::<_,String>(2)?,"durationMs":r.get::<_,i64>(3)?,"passed":r.get::<_,bool>(4)?,"clean":r.get::<_,bool>(5)?,"finishedAt":r.get::<_,i64>(6)?}))).map_err(|e| e.to_string())?;
    Ok(serde_json::json!(
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repository() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("ags-test-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]).unwrap();
        git(&root, &["config", "user.name", "Test"]).unwrap();
        git(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(root.join("tracked"), "one").unwrap();
        git(&root, &["add", "tracked"]).unwrap();
        git(&root, &["commit", "-m", "initial"]).unwrap();
        root
    }
    #[test]
    fn git_tree_rejects_untracked_staged_and_unstaged_changes() {
        let root = repository();
        let initial = clean_tree(&root).unwrap().unwrap();
        std::fs::write(root.join("untracked"), "two").unwrap();
        assert_eq!(clean_tree(&root).unwrap(), None);
        std::fs::remove_file(root.join("untracked")).unwrap();
        std::fs::write(root.join("tracked"), "two").unwrap();
        assert_eq!(clean_tree(&root).unwrap(), None);
        git(&root, &["add", "tracked"]).unwrap();
        assert_eq!(clean_tree(&root).unwrap(), None);
        git(&root, &["commit", "-m", "changed"]).unwrap();
        assert_ne!(clean_tree(&root).unwrap().unwrap(), initial);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn affected_files_include_branch_staged_unstaged_deleted_and_untracked() {
        let root = repository();
        git(&root, &["update-ref", "refs/remotes/origin/master", "HEAD"]).unwrap();
        std::fs::write(root.join("committed file"), "new").unwrap();
        git(&root, &["add", "committed file"]).unwrap();
        git(&root, &["commit", "-m", "branch change"]).unwrap();
        std::fs::remove_file(root.join("tracked")).unwrap();
        std::fs::write(root.join("staged"), "staged").unwrap();
        git(&root, &["add", "staged"]).unwrap();
        std::fs::write(root.join("untracked"), "untracked").unwrap();
        assert_eq!(
            changed_files(&root).unwrap(),
            vec!["committed file", "staged", "tracked", "untracked"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn execution_reuses_green_force_bypasses_and_dirty_always_runs() {
        let root = repository();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let commands = vec![TestCommand {
            suite: "probe".into(),
            program: "git".into(),
            args: vec!["--version".into()],
            cwd: ".".into(),
        }];
        assert!(
            !run(&conn, &root, "probe", &commands, false, None, "")
                .unwrap()
                .cache_hit
        );
        assert!(
            run(&conn, &root, "probe", &commands, false, None, "")
                .unwrap()
                .cache_hit
        );
        assert!(
            !run(&conn, &root, "probe", &commands, true, None, "")
                .unwrap()
                .cache_hit
        );
        std::fs::write(root.join("dirty"), "dirty").unwrap();
        assert!(
            !run(&conn, &root, "probe", &commands, false, None, "")
                .unwrap()
                .cache_hit
        );
        assert!(
            !run(&conn, &root, "probe", &commands, false, None, "")
                .unwrap()
                .cache_hit
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn key_covers_commands_and_suite() {
        let a = suite_commands("rust").unwrap();
        let mut b = a.clone();
        b[0].args.push("floors::test".into());
        assert_ne!(command_key(&a), command_key(&b));
        b = a.clone();
        b[0].suite = "another".into();
        assert_ne!(command_key(&a), command_key(&b));
    }
    #[test]
    fn dirty_tree_never_hits_and_latest_failure_invalidates() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        conn.execute("INSERT INTO test_results(repository,tree_hash,suite,command_key,commands,duration_ms,passed,clean,finished_at) VALUES('r','t','rust','k','[]',1,1,1,100)", []).unwrap();
        assert_eq!(
            cached_green(&conn, "r", Some("t"), "rust", "k").unwrap(),
            Some(100)
        );
        for (repo, tree, suite, key) in [
            ("r", None, "rust", "k"),
            ("r", Some("changed"), "rust", "k"),
            ("r", Some("t"), "tsc", "k"),
            ("r", Some("t"), "rust", "changed"),
            ("other", Some("t"), "rust", "k"),
        ] {
            assert_eq!(cached_green(&conn, repo, tree, suite, key).unwrap(), None);
        }
        conn.execute("INSERT INTO test_results(repository,tree_hash,suite,command_key,commands,duration_ms,passed,clean,finished_at) VALUES('r','t','rust','k','[]',1,0,1,101)", []).unwrap();
        assert_eq!(
            cached_green(&conn, "r", Some("t"), "rust", "k").unwrap(),
            None
        );
    }
}
