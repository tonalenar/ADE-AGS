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

pub(super) fn git_raw(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    git_raw_with_index(root, args, None)
}

/// `index`: um `GIT_INDEX_FILE` próprio (temporário). O índice do worktree, que é de um
/// agente trabalhando nele, nunca é tocado.
fn git_raw_with_index(root: &Path, args: &[&str], index: Option<&Path>) -> Result<std::process::Output, String> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
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
        ON test_results(repository, tree_hash, suite, command_key, id);
    CREATE TABLE IF NOT EXISTS test_inflight (
        repository TEXT NOT NULL, tree_hash TEXT NOT NULL, suite TEXT NOT NULL, command_key TEXT NOT NULL,
        owner TEXT NOT NULL, started_at INTEGER NOT NULL,
        PRIMARY KEY (repository, tree_hash, suite, command_key)
    );")
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
///
/// Árvore suja: em vez de "sem cache", a identidade é a árvore do DIRETÓRIO DE TRABALHO,
/// escrita num índice temporário (`working_tree`). Antes, quem testava antes de commitar
/// rodava a suíte inteira sempre e o verde nunca ficava para o QA; era a maior causa de
/// repetição (só ~11% de acerto de cache nas missões).
pub fn clean_tree(root: &Path) -> Result<Option<String>, String> {
    if relevant_dirty(&porcelain_entries(root)?) {
        // Um erro aqui (git antigo, disco cheio) volta ao comportamento seguro: sem cache.
        return Ok(working_tree(root).ok());
    }
    let tree = git(root, &["rev-parse", "HEAD^{tree}"])?;
    if relevant_dirty(&porcelain_entries(root)?) || git(root, &["rev-parse", "HEAD^{tree}"])? != tree {
        return Ok(None);
    }
    Ok(Some(tree))
}

/// A árvore do diretório de trabalho, como `git write-tree` a veria se tudo fosse adicionado.
/// Usa uma cópia do índice num arquivo temporário: o índice real nunca muda. Os montes de
/// skills dos agentes (`.claude/`, `.codex/`…) ficam de fora, como em `relevant_dirty`, para
/// que dois worktrees com o mesmo código tenham a mesma chave. `docs/` e `*.md` também ficam de
/// fora: relatórios que os agentes escrevem não mudam o que um teste vê, e mudavam a chave a cada rodada.
fn working_tree(root: &Path) -> Result<String, String> {
    let index = git(root, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
    // Pid + contador: dois passos em paralelo (cargo numa thread) nunca dividem o arquivo.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!("ags-test-index-{}-{}-{seq}", std::process::id(), now_ms()));
    if Path::new(&index).is_file() {
        std::fs::copy(&index, &temp).map_err(|e| e.to_string())?;
    }
    let result = (|| {
        const AGENT_ROOTS: &[&str] = &[".agents", ".claude", ".gemini", ".codex", ".kimi", ".opencode", ".cursor/skills", "docs", "*.md"];
        let excludes: Vec<String> = AGENT_ROOTS.iter().map(|root| format!(":(exclude){root}")).collect();
        let mut args: Vec<&str> = vec!["add", "-A", "--", "."];
        args.extend(excludes.iter().map(String::as_str));
        let added = git_raw_with_index(root, &args, Some(&temp))?;
        if !added.status.success() {
            return Err(String::from_utf8_lossy(&added.stderr).trim().to_string());
        }
        let written = git_raw_with_index(root, &["write-tree"], Some(&temp))?;
        if !written.status.success() {
            return Err(String::from_utf8_lossy(&written.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&written.stdout).trim().to_string())
    })();
    let _ = std::fs::remove_file(&temp);
    result
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

/// Uma vez de rodar uma suíte neste hash: ou já há um verde para ele, ou a vez é nossa.
enum Turn<'a> {
    /// Verde já registrado; `shared` = um integrante acabou de rodá-lo enquanto esperávamos.
    Cached { at: i64, shared: bool },
    /// Nossa vez. `Some` enquanto a execução dura (solta ao terminar); `None` se a espera estourou.
    Mine(Option<Claim<'a>>),
}

/// Quem está rodando esta suíte neste hash agora. Enquanto o dono roda, os outros esperam o
/// resultado em vez de rodar de novo: é a mesma suíte, no mesmo código, disputando CPU e o lock
/// do cargo. Vale entre processos (cada `ags` é um), por isso a posse fica no banco.
struct Claim<'a> {
    conn: &'a Connection,
    ids: [String; 4],
    owner: String,
}

/// Depois disto um dono sem resposta é considerado morto (um processo que caiu não trava a fila).
const OWNER_STALE: Duration = Duration::from_secs(20 * 60);
/// De quanto em quanto a espera confere se o verde já apareceu ou o dono terminou.
const WAIT_STEP: Duration = Duration::from_secs(1);

impl<'a> Claim<'a> {
    /// A vez é nossa se ninguém mais tem a mesma (repositório, hash, suíte, comando). `None` se tem dono.
    fn try_new(conn: &'a Connection, ids: [String; 4], owner: String, now: i64) -> Result<Option<Self>, String> {
        let stale_before = now - OWNER_STALE.as_millis() as i64;
        conn.execute(
            "DELETE FROM test_inflight WHERE repository=?1 AND tree_hash=?2 AND suite=?3 AND command_key=?4 AND started_at<?5",
            params![ids[0], ids[1], ids[2], ids[3], stale_before],
        )
        .map_err(|e| e.to_string())?;
        let taken = conn
            .execute(
                "INSERT OR IGNORE INTO test_inflight(repository,tree_hash,suite,command_key,owner,started_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![ids[0], ids[1], ids[2], ids[3], owner, now],
            )
            .map_err(|e| e.to_string())?;
        Ok((taken == 1).then_some(Claim { conn, ids, owner }))
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        // Só solta a própria linha: se a nossa foi considerada morta e outro a pegou, ela fica.
        let _ = self.conn.execute(
            "DELETE FROM test_inflight WHERE repository=?1 AND tree_hash=?2 AND suite=?3 AND command_key=?4 AND owner=?5",
            params![self.ids[0], self.ids[1], self.ids[2], self.ids[3], self.owner],
        );
    }
}

/// Pede a vez de rodar: devolve o verde se algum integrante já o registrou; senão, a vez (com a
/// posse) ou, depois de `test_timeout`, roda sem posse para não travar a missão.
fn take_turn<'a>(conn: &'a Connection, repo: &str, tree: &str, suite: &str, key: &str) -> Result<Turn<'a>, String> {
    let deadline = Instant::now() + test_timeout();
    let mut waited = false;
    loop {
        if let Some(at) = cached_green(conn, repo, Some(tree), suite, key)? {
            return Ok(Turn::Cached { at, shared: waited });
        }
        let ids = [repo.to_string(), tree.to_string(), suite.to_string(), key.to_string()];
        if let Some(claim) = Claim::try_new(conn, ids, uuid::Uuid::new_v4().to_string(), now_ms())? {
            return Ok(Turn::Mine(Some(claim)));
        }
        if Instant::now() >= deadline {
            return Ok(Turn::Mine(None));
        }
        waited = true;
        std::thread::sleep(WAIT_STEP);
    }
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
    // A chave de cache é a da SUÍTE: só os arquivos que ela lê (ver `scope`). Uma mudança só no
    // frontend não refaz os ~160 s do Rust.
    let scope = tree.as_deref().map(|t| super::scope::scoped_identity(root, t, suite));
    // Quem já tem o verde deste hash, ou um integrante rodando a mesma suíte nele, não repete:
    // espera o resultado (ver `take_turn`). Sem árvore identificável não há o que compartilhar.
    let mut _claim = None;
    if !force {
        let turn = match scope.as_deref() {
            Some(scope_id) => take_turn(conn, &repo, scope_id, suite, &key)?,
            None => Turn::Mine(None),
        };
        match turn {
            Turn::Cached { at, shared } => {
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
                let message = if shared {
                    format!("reaproveitado: outro integrante rodou esta suíte neste mesmo hash (há {} min)", (now - at).max(0) / 60_000)
                } else {
                    format!("já verde neste hash (há {} min)", (now - at).max(0) / 60_000)
                };
                return Ok(RunResult {
                    suite: suite.into(),
                    passed: true,
                    cache_hit: true,
                    duration_ms: 0,
                    tree_hash: tree,
                    message,
                });
            }
            Turn::Mine(claim) => _claim = claim,
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
        params![repo, scope, suite, key, serde_json::to_string(commands).map_err(|e| e.to_string())?, duration_ms, passed, clean, now_ms()]).map_err(|e| e.to_string())?;
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
    fn a_frontend_only_change_keeps_the_rust_green_and_vice_versa() {
        let root = repository();
        std::fs::create_dir_all(root.join("src-tauri").join("src")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src-tauri").join("src").join("lib.rs"), "v1").unwrap();
        std::fs::write(root.join("src").join("App.tsx"), "v1").unwrap();
        git(&root, &["add", "-A"]).unwrap();
        git(&root, &["commit", "-m", "app"]).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let commands = |suite: &str| {
            vec![TestCommand { suite: suite.into(), program: "git".into(), args: vec!["--version".into()], cwd: ".".into() }]
        };
        let hit = |suite: &str| run(&conn, &root, suite, &commands(suite), false, None, "").unwrap().cache_hit;
        assert!(!hit("rust"));
        assert!(!hit("frontend"));
        // Muda só uma tela (já commitada): o Rust segue verde, o frontend refaz.
        std::fs::write(root.join("src").join("App.tsx"), "v2").unwrap();
        git(&root, &["commit", "-am", "tela"]).unwrap();
        assert!(hit("rust"), "mudança só no frontend não pode refazer o Rust");
        assert!(!hit("frontend"));
        // Muda só o Rust (sem commitar): o frontend segue verde, o Rust refaz.
        std::fs::write(root.join("src-tauri").join("src").join("lib.rs"), "v2").unwrap();
        assert!(hit("frontend"), "mudança só no Rust não pode refazer o frontend");
        assert!(!hit("rust"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn docs_and_markdown_do_not_change_the_test_identity() {
        let root = repository();
        let initial = clean_tree(&root).unwrap().unwrap();
        // Relatórios de agente escritos no worktree não mudam o que os testes veem.
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs").join("relatorio.md"), "achados").unwrap();
        std::fs::write(root.join("NOTAS.md"), "nota").unwrap();
        assert_eq!(clean_tree(&root).unwrap().unwrap(), initial);
        // Código de verdade continua contando.
        std::fs::write(root.join("tracked"), "two").unwrap();
        assert_ne!(clean_tree(&root).unwrap().unwrap(), initial);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_member_waits_for_the_run_already_in_progress_instead_of_repeating_it() {
        let root = repository();
        let db = std::env::temp_dir().join(format!("ags-test-inflight-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = Connection::open(&db).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        migrate(&conn).unwrap();
        let commands = vec![TestCommand {
            suite: "probe".into(),
            program: "git".into(),
            args: vec!["--version".into()],
            cwd: ".".into(),
        }];
        let repo = repository_key(&root).unwrap();
        let tree = clean_tree(&root).unwrap().unwrap();
        let key = command_key(&commands);
        // Outro integrante (outra conexão, como outro processo `ags`) roda "probe" neste hash e,
        // depois de um tempo, registra o verde e solta a posse.
        // A execução usa a chave da suíte (ver `scope`), não a árvore inteira.
        let scope = crate::testspeed::scope::scoped_identity(&root, &tree, "probe");
        let ids = [repo.clone(), scope, "probe".to_string(), key.clone()];
        let worker_db = db.clone();
        let worker_ids = ids.clone();
        // O outro integrante avisa quando já tem a posse: dormir um tempo fixo não garante isso com a máquina carregada.
        let (claimed, claimed_signal) = std::sync::mpsc::channel::<()>();
        let other = std::thread::spawn(move || {
            let other = Connection::open(&worker_db).unwrap();
            other.busy_timeout(Duration::from_secs(5)).unwrap();
            let claim = Claim::try_new(&other, worker_ids.clone(), "outro".into(), now_ms()).unwrap().unwrap();
            claimed.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            other
                .execute(
                    "INSERT INTO test_results(repository,tree_hash,suite,command_key,commands,duration_ms,passed,clean,finished_at) VALUES(?1,?2,'probe',?3,'[]',1,1,1,?4)",
                    params![worker_ids[0], worker_ids[1], worker_ids[3], now_ms()],
                )
                .unwrap();
            drop(claim);
        });
        claimed_signal.recv().unwrap();
        let result = run(&conn, &root, "probe", &commands, false, None, "").unwrap();
        other.join().unwrap();
        assert!(result.cache_hit && result.passed, "{}", result.message);
        assert!(result.message.contains("outro integrante"), "{}", result.message);
        std::fs::remove_file(&db).ok();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_tree_follows_the_working_tree_content_staged_or_not() {
        let root = repository();
        let initial = clean_tree(&root).unwrap().unwrap();
        // Um arquivo novo muda a identidade; apagá-lo volta à do commit.
        std::fs::write(root.join("untracked"), "two").unwrap();
        let with_untracked = clean_tree(&root).unwrap().unwrap();
        assert_ne!(with_untracked, initial);
        std::fs::remove_file(root.join("untracked")).unwrap();
        assert_eq!(clean_tree(&root).unwrap().unwrap(), initial);
        // Editado: o mesmo conteúdo dá a mesma identidade, staged ou não, e o índice real não muda.
        std::fs::write(root.join("tracked"), "two").unwrap();
        let unstaged = clean_tree(&root).unwrap().unwrap();
        assert_ne!(unstaged, initial);
        assert!(git(&root, &["diff", "--cached", "--name-only"]).unwrap().is_empty(), "o índice do agente não pode ser tocado");
        git(&root, &["add", "tracked"]).unwrap();
        assert_eq!(clean_tree(&root).unwrap().unwrap(), unstaged);
        // Commitar o que foi testado mantém a identidade: o verde vale para o commit.
        git(&root, &["commit", "-m", "changed"]).unwrap();
        assert_eq!(clean_tree(&root).unwrap().unwrap(), unstaged);
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
    fn execution_reuses_green_force_bypasses_and_dirty_reuses_same_content() {
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
        // Árvore suja: o primeiro roda, o segundo (mesmo conteúdo) reaproveita; mudar roda de novo.
        std::fs::write(root.join("dirty"), "dirty").unwrap();
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
        std::fs::write(root.join("dirty"), "changed").unwrap();
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
        // Mudança de produto muda a identidade; os montes de skills seguem fora dela.
        let dirty = clean_tree(&root).unwrap().unwrap();
        assert_ne!(dirty, clean);
        std::fs::remove_dir_all(root.join(".agents")).unwrap();
        std::fs::remove_dir_all(root.join(".claude")).unwrap();
        assert_eq!(clean_tree(&root).unwrap().unwrap(), dirty);
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
