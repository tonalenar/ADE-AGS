//! Local test execution: cache only a clean, unchanged Git tree; never hold a DB lock
//! while a child process runs. Commands are argv vectors, never shell interpolation.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const GIT_LIMIT: Duration = Duration::from_secs(20);

fn git_raw(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    // O git global desta máquina (e o de quem assina commits) não pode travar o
    // `ags test`: sem GPG/SSH, sem fsmonitor e sem editor. Os `-c` valem só
    // para este processo.
    cmd.args(["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.fsmonitor="])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_EDITOR", "true");
    crate::util::spawn::output(&mut cmd, GIT_LIMIT).map_err(|e| e.to_string())
}

/// `AGS_TEST_TIMEOUT_MIN` (minutos). Sem a variável, 30. No estouro o grupo morre.
fn test_timeout() -> Duration {
    let minutes = std::env::var("AGS_TEST_TIMEOUT_MIN")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|minutes| *minutes > 0)
        .unwrap_or(30);
    Duration::from_secs(minutes.saturating_mul(60))
}

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
    let out = git_raw(root, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Committed changes since the merge base plus tracked and untracked local edits.
/// NUL delimiters preserve paths containing spaces/newlines; deleted paths remain
/// in the plan, so deleting a module cannot silently remove its validation.
///
/// The base stays `origin/master`, not the last green tree. A sliding base can
/// skip a file that was verified only in another worktree, or that changed again
/// after that green result. Reuse in this wave is the same `HEAD^{tree}` and the
/// same normalized command, from any worktree of the repository.
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
        let out = git_raw(root, &args)?;
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
    Ok(files.into_iter().filter(|path| !super::affected::is_agent_metadata(path)).collect())
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
    // Tracked files are judged only by added diff lines. Untracked files have no
    // hunk, so every line is new. A file we cannot read stays risky: the full
    // suite still runs.
    for file in changed.iter().filter(|file| file.ends_with(".rs") && !super::affected::is_agent_metadata(file)) {
        if files.contains(file) || tracked(root, file)? {
            continue;
        }
        match std::fs::read_to_string(root.join(file)) {
            Ok(source) if source.lines().any(super::affected::line_adds_unsafe) => {
                files.insert(file.clone());
            }
            Ok(_) => {}
            Err(_) => {
                files.insert(file.clone());
            }
        }
    }
    files.retain(|file| !super::affected::is_agent_metadata(file));
    Ok(files.into_iter().collect())
}

fn tracked(root: &Path, file: &str) -> Result<bool, String> {
    let out = git_raw(root, &["ls-files", "--error-unmatch", "--", file])?;
    Ok(out.status.success())
}

/// Product changes count as dirty. Untracked skill mounts do not: they are not
/// in `HEAD^{tree}` and must not force every worktree to miss the cache.
/// No index writes, so another agent's staging area is never changed.
pub fn clean_tree(root: &Path) -> Result<Option<String>, String> {
    if relevant_dirty(&porcelain_entries(root)?) {
        return Ok(None);
    }
    let tree = git(root, &["rev-parse", "HEAD^{tree}"])?;
    if relevant_dirty(&porcelain_entries(root)?) || git(root, &["rev-parse", "HEAD^{tree}"])? != tree {
        return Ok(None);
    }
    Ok(Some(tree))
}

fn porcelain_entries(root: &Path) -> Result<Vec<(String, String)>, String> {
    let out = git_raw(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let mut parts = out.stdout.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let mut entries = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            entries.push(("XX".into(), String::new()));
            continue;
        }
        let xy = String::from_utf8_lossy(&entry[..2]).into_owned();
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        if xy.starts_with('R') || xy.starts_with('C') {
            parts.next();
        }
        entries.push((xy, path));
    }
    Ok(entries)
}

fn relevant_dirty(entries: &[(String, String)]) -> bool {
    entries.iter().any(|(xy, path)| !(xy == "??" && super::affected::is_agent_metadata(path)))
}

/// Identity of the repository, shared by linked worktrees. The path is canonical
/// and uses `/`, so two worktrees do not miss the cache over spelling.
pub fn repository_key(root: &Path) -> Result<String, String> {
    let absolute = git_raw(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let raw = match absolute {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => git(root, &["rev-parse", "--git-common-dir"])?,
    };
    let path = Path::new(&raw);
    let joined = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let canon = dunce::canonicalize(&joined).map_err(|e| e.to_string())?;
    Ok(canon.to_string_lossy().replace('\\', "/"))
}

fn normalize_rel(path: &str) -> String {
    let mut path = path.trim().replace('\\', "/");
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    while path.ends_with('/') {
        path.pop();
    }
    if path.is_empty() { ".".into() } else { path }
}

/// Same argv, same key: slash spelling, `cwd` spelling, and the order of cargo
/// filters or vitest `related` files do not change what runs.
pub fn normalize_command(command: &TestCommand) -> TestCommand {
    let mut args: Vec<String> = command
        .args
        .iter()
        .map(|arg| {
            let slash = arg.trim().replace('\\', "/");
            if slash.starts_with('-') { slash } else { normalize_rel(&slash) }
        })
        .collect();
    if command.program.trim() == "cargo"
        && let Some(split) = args.iter().position(|arg| arg == "--")
    {
        let mut filters = args.split_off(split + 1);
        filters.sort();
        args.append(&mut filters);
    }
    if args.iter().any(|arg| arg == "related")
        && let Some(split) = args.iter().position(|arg| arg == "--run")
    {
        let mut files = args.split_off(split + 1);
        files.sort();
        args.append(&mut files);
    }
    TestCommand {
        suite: command.suite.trim().to_string(),
        program: command.program.trim().to_string(),
        args,
        cwd: normalize_rel(&command.cwd),
    }
}

pub fn command_key(commands: &[TestCommand]) -> String {
    let normalized: Vec<TestCommand> = commands.iter().map(normalize_command).collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&normalized).expect("serializable commands"))
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
    let repo = repository_key(root)?;
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
        let mut child = crate::util::spawn::hidden_command(&command.program);
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
        // without buffering an entire suite in memory. O grupo morre se passar do prazo.
        let outcome = crate::util::spawn::wait_copying_stdout(&mut child, test_timeout());
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
    let repo = repository_key(root)?;
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
        git(&root, &["config", "core.autocrlf", "false"]).unwrap();
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
    #[test]
    fn normalized_command_key_ignores_spelling_and_filter_order() {
        let rust_a = TestCommand {
            suite: "rust".into(),
            program: "cargo".into(),
            args: vec!["test".into(), "--lib".into(), "--".into(), "missions::".into(), "floors::".into()],
            cwd: "src-tauri/".into(),
        };
        let rust_b = TestCommand {
            suite: "rust".into(),
            program: " cargo ".into(),
            args: vec!["test".into(), "--lib".into(), "--".into(), "floors::".into(), "missions::".into()],
            cwd: "./src-tauri".into(),
        };
        assert_eq!(command_key(std::slice::from_ref(&rust_a)), command_key(std::slice::from_ref(&rust_b)));
        let front_a = TestCommand {
            suite: "frontend".into(),
            program: "node".into(),
            args: vec!["node_modules/vitest/vitest.mjs".into(), "related".into(), "--run".into(), r"src\b.ts".into(), "src/a.ts".into()],
            cwd: "./".into(),
        };
        let front_b = TestCommand {
            suite: "frontend".into(),
            program: "node".into(),
            args: vec!["node_modules/vitest/vitest.mjs".into(), "related".into(), "--run".into(), "src/a.ts".into(), "src/b.ts".into()],
            cwd: ".".into(),
        };
        assert_eq!(command_key(std::slice::from_ref(&front_a)), command_key(std::slice::from_ref(&front_b)));
        let mut different = rust_a.clone();
        different.args.push("other::".into());
        assert_ne!(command_key(std::slice::from_ref(&rust_a)), command_key(std::slice::from_ref(&different)));
    }
    #[test]
    fn agent_metadata_does_not_dirty_the_tree_or_enter_the_plan() {
        let root = repository();
        git(&root, &["update-ref", "refs/remotes/origin/master", "HEAD"]).unwrap();
        let clean = clean_tree(&root).unwrap().unwrap();
        std::fs::create_dir_all(root.join(".agents/skills/demo")).unwrap();
        std::fs::write(root.join(".agents/skills/demo/SKILL.md"), "# skill\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/demo")).unwrap();
        std::fs::write(root.join(".claude/skills/demo/SKILL.md"), "# skill\n").unwrap();
        assert_eq!(clean_tree(&root).unwrap().as_deref(), Some(clean.as_str()));
        assert!(changed_files(&root).unwrap().is_empty());
        std::fs::write(root.join("product.ts"), "export {}\n").unwrap();
        let changed = changed_files(&root).unwrap();
        assert_eq!(changed, vec!["product.ts"]);
        assert!(clean_tree(&root).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn existing_unsafe_outside_the_diff_does_not_force_the_full_suite() {
        let root = repository();
        std::fs::create_dir_all(root.join("src-tauri/src")).unwrap();
        std::fs::write(root.join("src-tauri/src/floors.rs"), "fn a() {}\nunsafe { 1 }\n").unwrap();
        git(&root, &["add", "src-tauri/src/floors.rs"]).unwrap();
        git(&root, &["commit", "-m", "base"]).unwrap();
        git(&root, &["update-ref", "refs/remotes/origin/master", "HEAD"]).unwrap();
        std::fs::write(root.join("src-tauri/src/floors.rs"), "fn a() { let _ = 1; }\nunsafe { 1 }\n").unwrap();
        let changed = changed_files(&root).unwrap();
        assert!(unsafe_files(&root, &changed).unwrap().is_empty(), "unsafe já presente não é linha nova");
        std::fs::write(root.join("src-tauri/src/floors.rs"), "fn a() { let _ = 1; }\nunsafe { 1 }\nunsafe { 2 }\n").unwrap();
        let flagged = unsafe_files(&root, &changed_files(&root).unwrap()).unwrap();
        assert!(flagged.iter().any(|file| file.ends_with("floors.rs")), "{flagged:?}");
        std::fs::write(root.join("src-tauri/src/plain.rs"), "fn ok() {}\n").unwrap();
        std::fs::write(root.join("src-tauri/src/fresh.rs"), "unsafe { 3 }\n").unwrap();
        let flagged = unsafe_files(&root, &changed_files(&root).unwrap()).unwrap();
        assert!(flagged.iter().any(|file| file.ends_with("fresh.rs")), "{flagged:?}");
        assert!(!flagged.iter().any(|file| file.ends_with("plain.rs")), "{flagged:?}");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn same_tree_hits_across_worktrees_when_only_skills_differ() {
        let root = repository();
        let wt = std::env::temp_dir().join(format!("ags-test-wt-{}", uuid::Uuid::new_v4()));
        let wt_arg = wt.to_string_lossy().into_owned();
        git(&root, &["worktree", "add", "--detach", &wt_arg, "HEAD"]).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let commands = vec![TestCommand {
            suite: "probe".into(),
            program: "git".into(),
            args: vec!["--version".into()],
            cwd: ".".into(),
        }];
        assert_eq!(repository_key(&root).unwrap(), repository_key(&wt).unwrap());
        assert!(!run(&conn, &root, "probe", &commands, false, None, "").unwrap().cache_hit);
        std::fs::create_dir_all(wt.join(".agents/skills/demo")).unwrap();
        std::fs::write(wt.join(".agents/skills/demo/SKILL.md"), "# skill\n").unwrap();
        let again = run(&conn, &wt, "probe", &commands, false, None, "").unwrap();
        assert!(again.cache_hit, "{}", again.message);
        assert!(again.message.contains("já verde neste hash"));
        let _ = git(&root, &["worktree", "remove", "--force", &wt_arg]);
        let _ = std::fs::remove_dir_all(&wt);
        std::fs::remove_dir_all(root).unwrap();
    }
}
