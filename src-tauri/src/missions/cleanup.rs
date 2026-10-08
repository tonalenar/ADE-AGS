//! Explicit, conservative cleanup. No force removal, no recursive traversal of links.
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

static CLEANING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub mission_id: Option<String>,
    pub root: String,
    pub branch: String,
    pub size_bytes: u64,
    pub blockers: Vec<String>,
    pub removed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub dry_run: bool,
    pub entries: Vec<CleanupEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub entries: Vec<CleanupEntry>,
    pub reports: Vec<CleanupReport>,
    pub dry_run: bool,
}

pub fn prune(
    conn: &Connection,
    cwd: &Path,
    base: &Path,
    dry_run: bool,
) -> Result<PruneReport, String> {
    let entries = list(conn, cwd, base)?;
    let missions: std::collections::BTreeSet<String> = entries
        .iter()
        .filter(|e| e.blockers.is_empty())
        .filter_map(|e| e.mission_id.clone())
        .collect();
    let reports = missions
        .into_iter()
        .map(|id| cleanup(conn, &id, base, dry_run))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PruneReport {
        entries,
        reports,
        dry_run,
    })
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = crate::util::spawn::hidden_command("git");
    command
        .arg("-C")
        .arg(crate::util::external_path(repo))
        .args(args);
    let out = crate::util::output_with_timeout(&mut command, Duration::from_secs(120))
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

fn size(path: &Path) -> Result<u64, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if crate::skills::is_mount(path) || meta.file_type().is_symlink() {
        return Ok(0);
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut total = 0u64;
    for e in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        total = total.saturating_add(size(&e.map_err(|e| e.to_string())?.path())?);
    }
    Ok(total)
}

fn managed(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let node = root.join("node_modules");
    if crate::skills::is_mount(&node) {
        out.push(node)
    }
    if let Some(home) = dirs::home_dir() {
        let skills = home.join(".ags").join("skills");
        for folder in [".claude/skills", ".agents/skills"] {
            out.extend(crate::runs::worktrees::managed_links(
                &root.join(folder),
                &skills,
            ));
        }
    }
    out
}

pub fn inspect(
    repo: &Path,
    base: &Path,
    root: &Path,
    branch: &str,
    mission_id: Option<String>,
) -> CleanupEntry {
    let mut e = CleanupEntry {
        mission_id,
        root: root.to_string_lossy().into_owned(),
        branch: branch.into(),
        size_bytes: 0,
        blockers: Vec::new(),
        removed: false,
    };
    // Canonical containment prevents a stored path (or a junction root) escaping ~/.ags/worktrees.
    let contained = base
        .canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(b, r)| r.starts_with(&b) && r != b);
    if !contained || crate::skills::is_mount(root) {
        e.blockers
            .push("worktree fora da raiz permitida ou caminho indisponível".into());
        return e;
    }
    if !branch.starts_with("cc/") || branch.starts_with('-') {
        e.blockers.push("branch não gerenciada".into());
        return e;
    }
    match git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(actual) if actual == branch => {}
        _ => e
            .blockers
            .push("branch do worktree diverge do registro".into()),
    }
    match crate::runs::worktrees::dirty_files(root, &managed(root)) {
        Ok(files) if !files.is_empty() => e
            .blockers
            .push(format!("alterações não commitadas: {}", files.join(", "))),
        Err(error) => e.blockers.push(error),
        _ => {}
    }
    match git(
        repo,
        &["log", "--format=%h %s", &format!("origin/master..{branch}")],
    ) {
        Ok(commits) if !commits.is_empty() => e
            .blockers
            .push(format!("commits fora de origin/master: {commits}")),
        Err(error) => e.blockers.push(error),
        _ => {}
    }
    match size(root) {
        Ok(n) => e.size_bytes = n,
        Err(error) => e.blockers.push(format!("não foi possível medir: {error}")),
    }
    e
}

fn remove(repo: &Path, base: &Path, entry: &mut CleanupEntry) -> Result<(), String> {
    let root = Path::new(&entry.root);
    let expected = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", entry.branch),
        ],
    )?;
    // Revalidate immediately before mutation, including uncommitted files and ancestry.
    let checked = inspect(repo, base, root, &entry.branch, entry.mission_id.clone());
    if !checked.blockers.is_empty() {
        return Err(checked.blockers.join("; "));
    }
    for link in managed(root) {
        crate::skills::remove_mount(&link).map_err(|e| e.to_string())?;
    }
    git(repo, &["worktree", "remove", &entry.root])?;
    entry.removed = true;
    // Delete only the exact integrated ref inspected above. CAS protects against a
    // concurrent commit; HEAD/upstream need not themselves contain origin/master.
    if let Err(error) = git(
        repo,
        &[
            "update-ref",
            "-d",
            &format!("refs/heads/{}", entry.branch),
            &expected,
        ],
    ) {
        entry
            .blockers
            .push(format!("worktree removido; branch preservada: {error}"));
    }
    Ok(())
}

pub fn cleanup(
    conn: &Connection,
    mission: &str,
    base: &Path,
    dry_run: bool,
) -> Result<CleanupReport, String> {
    let _guard = CLEANING.lock().map_err(|e| e.to_string())?;
    let (cwd, status, integration_path, integration_branch) = conn
        .query_row(
            "SELECT cwd,status,integration_path,integration_branch FROM missions WHERE id=?1",
            [mission],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let repo = crate::runs::worktrees::repo_root(Path::new(&cwd))?;
    let mut stmt=conn.prepare("SELECT root,branch FROM mission_team_workspaces WHERE mission_id=?1 UNION SELECT t.worktree_path,t.branch FROM tasks t JOIN runs r ON r.id=t.run_id WHERE r.mission_id=?1 AND t.worktree_path IS NOT NULL AND t.branch IS NOT NULL AND t.worktree_removed=0").map_err(|e|e.to_string())?;
    let mut paths = stmt
        .query_map([mission], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if let Some(pair) = integration_path.zip(integration_branch) {
        if !paths.contains(&pair) {
            paths.push(pair)
        }
    }
    let mut entries = Vec::new();
    for (root, branch) in paths {
        let mut e = inspect(&repo, base, Path::new(&root), &branch, Some(mission.into()));
        if !matches!(status.as_str(), "done" | "cancelled" | "failed") {
            e.blockers.push(format!("missão em andamento: {status}"))
        }
        let mut tabs = conn
            .prepare("SELECT cwd FROM tabs")
            .map_err(|e| e.to_string())?;
        let root_key = root.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let active = tabs
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|cwd| {
                let cwd = cwd.replace('\\', "/").trim_end_matches('/').to_lowercase();
                cwd == root_key || cwd.starts_with(&format!("{root_key}/"))
            })
            .count();
        if active > 0 {
            e.blockers
                .push("terminal ainda aberto neste worktree".into())
        }
        entries.push(e);
    }
    // Atomic preflight: a blocker anywhere prevents all mutations in this mission.
    if !dry_run && entries.iter().all(|e| e.blockers.is_empty()) {
        for e in &mut entries {
            if let Err(error) = remove(&repo, base, e) {
                e.blockers.push(error);
                break;
            }
            conn.execute(
                "DELETE FROM mission_team_workspaces WHERE mission_id=?1 AND root=?2",
                rusqlite::params![mission, e.root],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE tasks SET worktree_removed=1 WHERE worktree_path=?1",
                [&e.root],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE missions SET integration_path=NULL WHERE id=?1 AND integration_path=?2",
                rusqlite::params![mission, e.root],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(CleanupReport { dry_run, entries })
}

#[tauri::command]
pub async fn mission_cleanup(
    mission_id: String,
    dry_run: Option<bool>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<CleanupReport, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = dirs::home_dir()
            .ok_or("Home indisponível")?
            .join(".ags/worktrees");
        let c = db.lock().map_err(|e| e.to_string())?;
        cleanup(&c, &mission_id, &base, dry_run.unwrap_or(true))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mesmo worktree? Compara a identidade real, não o texto: o banco guarda o caminho como foi
/// criado (pode ser nome 8.3 tipo `RUNNER~1`, junção ou symlink) e o `git worktree list`
/// devolve o caminho resolvido. `canonicalize` leva os dois à mesma forma.
fn same_worktree(a: &str, b: &str) -> bool {
    let key = |p: &str| {
        let path = Path::new(p);
        let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        crate::usage::path_key(&crate::util::external_path(&real).to_string_lossy())
    };
    key(a) == key(b)
}

pub fn list(conn: &Connection, cwd: &Path, base: &Path) -> Result<Vec<CleanupEntry>, String> {
    let repo = crate::runs::worktrees::repo_root(cwd)?;
    let listing = git(&repo, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    for block in listing.split("\n\n") {
        let Some(root) = block.lines().find_map(|l| l.strip_prefix("worktree ")) else {
            continue;
        };
        let Some(branch) = block
            .lines()
            .find_map(|l| l.strip_prefix("branch refs/heads/cc/"))
            .map(|b| format!("cc/{b}"))
        else {
            continue;
        };
        let mut owned=conn.prepare("SELECT m.id,m.status,w.root FROM missions m JOIN mission_team_workspaces w ON w.mission_id=m.id UNION SELECT m.id,m.status,t.worktree_path FROM missions m JOIN runs r ON r.mission_id=m.id JOIN tasks t ON t.run_id=r.id WHERE t.worktree_path IS NOT NULL UNION SELECT id,status,integration_path FROM missions WHERE integration_path IS NOT NULL").map_err(|e|e.to_string())?;
        let owners = owned
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let mut matches = owners
            .into_iter()
            .filter(|(_, _, path)| same_worktree(path, root));
        let ownership = matches.next().map(|(id, status, _)| (id, status));
        let ambiguous =
            matches.any(|(id, _, _)| ownership.as_ref().is_some_and(|(owner, _)| owner != &id));
        let mut e = inspect(
            &repo,
            base,
            Path::new(root),
            &branch,
            ownership.as_ref().map(|p| p.0.clone()),
        );
        if ambiguous {
            e.blockers.push("propriedade de worktree ambígua".into());
        }
        if let Some((_, s)) = ownership {
            if !matches!(s.as_str(), "done" | "cancelled" | "failed") {
                e.blockers.push(format!("missão em andamento: {s}"))
            }
        }
        // Orphans are listed for review, never silently removed.
        if e.mission_id.is_none() {
            e.blockers
                .push("worktree órfão: revisão explícita necessária".into())
        }
        entries.push(e);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Repo {
        dir: PathBuf,
        repo: PathBuf,
        base: PathBuf,
        wt: PathBuf,
    }
    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ags-cleanup-{}", uuid::Uuid::new_v4()));
            let repo = dir.join("repo");
            let base = dir.join("worktrees");
            let wt = base.join("member");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::create_dir_all(&base).unwrap();
            git(&repo, &["init", "-b", "master"]).unwrap();
            git(&repo, &["config", "user.name", "Test"]).unwrap();
            git(&repo, &["config", "user.email", "test@example.invalid"]).unwrap();
            std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
            std::fs::write(repo.join("file"), "base").unwrap();
            git(&repo, &["add", "."]).unwrap();
            git(&repo, &["commit", "-m", "initial"]).unwrap();
            git(&repo, &["update-ref", "refs/remotes/origin/master", "HEAD"]).unwrap();
            git(
                &repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    "cc/mission-test",
                    wt.to_str().unwrap(),
                    "HEAD",
                ],
            )
            .unwrap();
            Self {
                dir,
                repo,
                base,
                wt,
            }
        }
        fn db(&self, status: &str) -> Connection {
            let c = Connection::open_in_memory().unwrap();
            c.execute_batch("CREATE TABLE missions(id TEXT,cwd TEXT,status TEXT,integration_path TEXT,integration_branch TEXT);CREATE TABLE mission_team_workspaces(mission_id TEXT,root TEXT,branch TEXT);CREATE TABLE runs(id TEXT,mission_id TEXT);CREATE TABLE tasks(run_id TEXT,worktree_path TEXT,branch TEXT,worktree_removed INTEGER);CREATE TABLE tabs(cwd TEXT);").unwrap();
            c.execute(
                "INSERT INTO missions VALUES ('m',?1,?2,NULL,NULL)",
                rusqlite::params![self.repo.to_str().unwrap(), status],
            )
            .unwrap();
            c.execute(
                "INSERT INTO mission_team_workspaces VALUES ('m',?1,'cc/mission-test')",
                [self.wt.to_str().unwrap()],
            )
            .unwrap();
            c
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let link = self.wt.join("node_modules");
            if crate::skills::is_mount(&link) {
                let _ = crate::skills::remove_mount(&link);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    fn dry_run_precedes_safe_removal_and_preserves_link_target() {
        let r = Repo::new();
        let c = r.db("done");
        let deps = r.dir.join("deps");
        std::fs::create_dir(&deps).unwrap();
        std::fs::write(deps.join("keep"), "shared").unwrap();
        crate::skills::mount_dir(&deps, &r.wt.join("node_modules")).unwrap();
        let dry = cleanup(&c, "m", &r.base, true).unwrap();
        assert!(dry.entries[0].blockers.is_empty(), "{:?}", dry.entries);
        assert!(!dry.entries[0].removed);
        assert!(r.wt.exists());
        let result = cleanup(&c, "m", &r.base, false).unwrap();
        assert!(result.entries[0].removed);
        assert!(!r.wt.exists());
        assert_eq!(
            std::fs::read_to_string(deps.join("keep")).unwrap(),
            "shared"
        );
    }
    #[test]
    fn refuses_dirty_and_unmerged_commits() {
        let r = Repo::new();
        let c = r.db("done");
        std::fs::write(r.wt.join("file"), "changed").unwrap();
        assert!(cleanup(&c, "m", &r.base, true).unwrap().entries[0]
            .blockers
            .iter()
            .any(|b| b.contains("não commitadas")));
        assert!(!cleanup(&c, "m", &r.base, false).unwrap().entries[0].removed);
        assert!(r.wt.exists());
        git(&r.wt, &["add", "file"]).unwrap();
        git(&r.wt, &["commit", "-m", "unique work"]).unwrap();
        assert!(cleanup(&c, "m", &r.base, true).unwrap().entries[0]
            .blockers
            .iter()
            .any(|b| b.contains("commits fora")));
        assert!(!cleanup(&c, "m", &r.base, false).unwrap().entries[0].removed);
    }
    #[test]
    fn active_mission_and_live_terminal_never_removed() {
        let r = Repo::new();
        let c = r.db("running");
        let report = cleanup(&c, "m", &r.base, false).unwrap();
        assert!(report.entries[0]
            .blockers
            .iter()
            .any(|b| b.contains("andamento")));
        assert!(r.wt.exists());
        c.execute("UPDATE missions SET status='done'", []).unwrap();
        c.execute("INSERT INTO tabs VALUES(?1)", [r.wt.to_str().unwrap()])
            .unwrap();
        assert!(!cleanup(&c, "m", &r.base, false).unwrap().entries[0].removed);
        assert!(r.wt.exists());
    }
    #[test]
    fn rejects_escape_and_branch_mismatch() {
        let r = Repo::new();
        assert!(!inspect(&r.repo, &r.base, &r.repo, "master", None)
            .blockers
            .is_empty());
        assert!(!inspect(&r.repo, &r.base, &r.wt, "cc/other", None)
            .blockers
            .is_empty());
    }
    #[test]
    fn listing_and_prune_preserve_orphans_and_active_then_clean_closed() {
        let r = Repo::new();
        let c = r.db("running");
        let listing = list(&c, &r.repo, &r.base).unwrap();
        assert_eq!(listing.len(), 1);
        assert!(listing[0].size_bytes > 0);
        assert!(listing[0].blockers.iter().any(|b| b.contains("andamento")));
        assert!(prune(&c, &r.repo, &r.base, false)
            .unwrap()
            .reports
            .is_empty());
        assert!(r.wt.exists());
        c.execute("DELETE FROM mission_team_workspaces", [])
            .unwrap();
        assert!(list(&c, &r.repo, &r.base).unwrap()[0]
            .blockers
            .iter()
            .any(|b| b.contains("órfão")));
        assert!(prune(&c, &r.repo, &r.base, false)
            .unwrap()
            .reports
            .is_empty());
        assert!(r.wt.exists());
        c.execute(
            "INSERT INTO mission_team_workspaces VALUES ('m',?1,'cc/mission-test')",
            [r.wt.to_str().unwrap()],
        )
        .unwrap();
        c.execute("UPDATE missions SET status='done'", []).unwrap();
        let dry = prune(&c, &r.repo, &r.base, true).unwrap();
        assert_eq!(dry.reports.len(), 1);
        assert!(!dry.reports[0].entries[0].removed);
        assert!(r.wt.exists());
        let result = prune(&c, &r.repo, &r.base, false).unwrap();
        assert!(result.reports[0].entries[0].removed);
        assert!(!r.wt.exists());
        assert!(git(
            &r.repo,
            &["rev-parse", "--verify", "refs/heads/cc/mission-test"]
        )
        .is_err());
    }
}
