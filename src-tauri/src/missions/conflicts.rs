//! Resolve only files in a mission's isolated integration worktree and active merge.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub content: String,
    pub binary: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConflicts {
    pub mission_id: String,
    pub branch: String,
    pub against: String,
    pub files: Vec<ConflictFile>,
}
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut c = crate::util::spawn::hidden_command("git");
    c.arg("-C").arg(crate::util::external_path(root)).args(args);
    let o = crate::util::output_with_timeout(&mut c, std::time::Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&o.stdout)
        .trim_end_matches(['\r', '\n'])
        .into())
}
fn integration(c: &rusqlite::Connection, mission: &str) -> Result<(String, PathBuf), String> {
    let (branch, path) =
        super::review::integration_path(c, mission)?.ok_or("missions.conflicts.noIntegration")?;
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let base = dirs::home_dir()
        .ok_or("Home indisponível")?
        .join(".ags/worktrees")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.starts_with(&base)
        || root == base
        || !branch.starts_with("cc/")
        || git(&root, &["symbolic-ref", "--short", "HEAD"])? != branch
    {
        return Err("integration ownership mismatch".into());
    }
    Ok((branch, root))
}
fn paths(root: &Path) -> Result<Vec<String>, String> {
    Ok(
        git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
    )
}
fn safe_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || Path::new(path).is_absolute()
        || path.split('/').any(|p| p == ".." || p == ".git")
    {
        return Err("unsafe conflict path".into());
    }
    let target = root.join(path);
    let existing = if target.exists() {
        target.as_path()
    } else {
        target.parent().ok_or("unsafe conflict path")?
    };
    let canonical = existing.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) || crate::skills::is_mount(&target) {
        return Err("unsafe conflict path".into());
    }
    Ok(target)
}
pub fn has_markers(content: &str) -> bool {
    content
        .lines()
        .any(|l| l.starts_with("<<<<<<<") || l.starts_with("=======") || l.starts_with(">>>>>>>"))
}
fn read(root: &Path, branch: String, mission: &str) -> Result<IntegrationConflicts, String> {
    let mut files = vec![];
    for path in paths(root)? {
        let file = safe_path(root, &path)?;
        let bytes = match std::fs::read(&file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(e.to_string()),
        };
        let binary = bytes.contains(&0)
            || bytes.len() > 2 * 1024 * 1024
            || std::str::from_utf8(&bytes).is_err();
        files.push(ConflictFile {
            path,
            content: if binary {
                String::new()
            } else {
                String::from_utf8(bytes).map_err(|e| e.to_string())?
            },
            binary,
        });
    }
    Ok(IntegrationConflicts {
        mission_id: mission.into(),
        branch,
        against: "origin/master".into(),
        files,
    })
}
#[tauri::command]
pub async fn mission_conflicts(
    app: tauri::AppHandle,
    mission_id: String,
) -> Result<IntegrationConflicts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::database::DbConnection>();
        let c = db.lock().map_err(|e| e.to_string())?;
        let (branch, root) = integration(&c, &mission_id)?;
        read(&root, branch, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mission_resolve_conflict(
    app: tauri::AppHandle,
    mission_id: String,
    path: String,
    content: String,
) -> Result<IntegrationConflicts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if has_markers(&content) || content.len() > 2 * 1024 * 1024 {
            return Err("missions.conflicts.markersRemain".into());
        }
        let db = app.state::<crate::database::DbConnection>();
        let c = db.lock().map_err(|e| e.to_string())?;
        let (branch, root) = integration(&c, &mission_id)?;
        git(&root, &["rev-parse", "--verify", "MERGE_HEAD"])?;
        if !paths(&root)?.contains(&path) {
            return Err("file is not an unresolved conflict".into());
        }
        let target = safe_path(&root, &path)?;
        if std::fs::read(&target).is_ok_and(|b| b.contains(&0)) {
            return Err("binary conflict requires manual resolution".into());
        }
        std::fs::write(target, content).map_err(|e| e.to_string())?;
        git(&root, &["add", "--", &path])?;
        read(&root, branch, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mission_conclude_merge(
    app: tauri::AppHandle,
    mission_id: String,
    abort: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::database::DbConnection>();
        let c = db.lock().map_err(|e| e.to_string())?;
        let (_, root) = integration(&c, &mission_id)?;
        git(&root, &["rev-parse", "--verify", "MERGE_HEAD"])?;
        if abort.unwrap_or(false) {
            git(&root, &["merge", "--abort"])?;
        } else {
            if !paths(&root)?.is_empty() {
                return Err("missions.conflicts.unresolved".into());
            }
            let mut args = super::review::identity_args(&root);
            args.extend(["commit".into(), "--no-edit".into()]);
            git(&root, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
        }
        super::notify(&app, &mission_id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_validation_and_path_traversal() {
        assert!(has_markers("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> master"));
        assert!(!has_markers("a\nb\n"));
        for p in ["../a", "C:/a", "/a", "a/../../b", ".git/config", "a\\b"] {
            assert!(safe_path(Path::new("/repo"), p).is_err());
        }
    }
}
