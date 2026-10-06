//! Isolated terminal workspaces prepared before agents receive their briefing.
use std::path::Path;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::AppHandle;

static PREPARING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorkspace {
    pub name: String,
    pub cwd: String,
    pub root: String,
    pub branch: String,
    pub cargo_target_dir: String,
    /// One inline prelaunch command; UI wraps this as { command: prelaunch }.
    pub prelaunch: String,
    pub environment: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTeam {
    pub workspaces: Vec<TeamWorkspace>,
    pub precheck: String,
    pub memory: String,
}

/// Esperas entre reintentos de un git que falló por un acceso momentáneo.
const RETRY_BACKOFF_MS: [u64; 4] = [150, 400, 900, 1800];

/// ¿El error de git es momentáneo? En Windows, otro proceso git (los agentes de otra misión, un
/// antivirus, otro worktree creándose a la vez) puede tener un archivo tomado un instante y git
/// lo informa como "Permission denied" / "unable to access .git/config" / "unknown error occurred
/// while reading the configuration files", además de los "lock" de siempre. Pura.
pub(crate) fn is_transient_git_error(error: &str) -> bool {
    let e = error.to_lowercase();
    ["lock", "permission denied", "unable to access", "reading the configuration", "another git process", "resource temporarily unavailable"]
        .iter()
        .any(|needle| e.contains(needle))
}

fn validate_members(members: &[String]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    if members.is_empty() || members.len() > 32 {
        return Err("A equipe deve ter de 1 a 32 integrantes.".into());
    }
    for name in members {
        if name.trim().is_empty() || name.trim() != name || name.chars().count() > 100 || !seen.insert(name) {
            return Err("Os nomes da equipe devem ser únicos, não vazios e ter até 100 caracteres.".into());
        }
    }
    Ok(())
}

fn prepare_one(db: &crate::database::DbConnection, mission: &super::Mission, name: &str, base: &Path) -> Result<TeamWorkspace, String> {
    let existing: Option<(String, String, String)> = db.lock().map_err(|e| e.to_string())?.query_row(
        "SELECT cwd, root, branch FROM mission_team_workspaces WHERE mission_id=?1 AND name=?2",
        params![mission.id, name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|e| e.to_string())?;
    let (cwd, root, branch) = match existing {
        Some(row) => {
            // Never silently replace an owned workspace or discard its uncommitted work.
            if !Path::new(&row.0).is_dir() || !Path::new(&row.1).join(".git").is_file() {
                return Err(format!("O worktree de {name} não está disponível: {}", row.1));
            }
            row
        }
        None => {
            let wt = crate::runs::worktrees::create_from(base, Path::new(&mission.cwd), &format!("mission-{}-{name}", mission.id), "origin/master")?;
            let row = (wt.task_cwd.to_string_lossy().into_owned(), wt.root.to_string_lossy().into_owned(), wt.branch);
            // Persist ownership before optional dependency setup, so retry reuses it.
            db.lock().map_err(|e| e.to_string())?.execute("INSERT INTO mission_team_workspaces (mission_id,name,cwd,root,branch) VALUES (?1,?2,?3,?4,?5)",
                params![mission.id, name, row.0, row.1, row.2]).map_err(|e| e.to_string())?;
            row
        }
    };
    let repo = crate::runs::worktrees::repo_root(Path::new(&mission.cwd))?;
    let node_modules = crate::floors::prepare_node_modules_link(&repo, Path::new(&root))
        .map(|s| s.description().to_string()).unwrap_or_else(|e| format!("indisponível: {e}"));
    let target = crate::floors::cargo_target_dir(&repo, Path::new(&root), Some(std::ffi::OsStr::new("per-worktree")));
    let cargo_target_dir = target.path.to_string_lossy().into_owned();
    let (shell, label) = crate::floors::worktree_shell();
    let environment = crate::floors::worktree_environment_block(&root, &cargo_target_dir, &label, shell, &node_modules, target.mode);
    Ok(TeamWorkspace { name: name.into(), cwd, root, branch, cargo_target_dir,
        prelaunch: crate::floors::cargo_target_prelaunch(&target.path), environment })
}

/// Recruits inherit the same isolation as the initial team, not the lead's cwd.
pub(crate) fn prepare_recruit(db: &crate::database::DbConnection, mission_id: &str, name: &str) -> Result<TeamWorkspace, String> {
    validate_members(&[name.to_string()])?;
    let _preparing = PREPARING.lock().map_err(|e| e.to_string())?;
    let mission = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        super::store::get(&conn, mission_id)?.ok_or("Missão não encontrada.")?
    };
    let base = dirs::home_dir().ok_or("Home indisponível.")?.join(".ags").join("worktrees");
    prepare_one(db, &mission, name, &base)
}

#[tauri::command]
pub async fn mission_prepare_team(app: AppHandle, mission_id: String, members: Vec<String>) -> Result<PreparedTeam, String> {
    validate_members(&members)?;
    let db = super::db_of(&app)?;
    tokio::task::spawn_blocking(move || {
        // Serialized preparation makes retries idempotent even under concurrent UI calls.
        let _preparing = PREPARING.lock().map_err(|e| e.to_string())?;
        super::check_launch_now(&db, &mission_id, true)?;
        let mission = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            super::store::get(&conn, &mission_id)?.ok_or("Missão não encontrada.")?
        };
        let base = dirs::home_dir().ok_or("Home indisponível.")?.join(".ags").join("worktrees");
        // Los worktrees se crean en paralelo (cada `git worktree add` hace un checkout completo y en
        // serie eran ~1 s por integrante antes de que se abriera el canvas). Si git no logra un lock
        // compartido, se reintenta ese integrante.
        let workspaces = std::thread::scope(|scope| {
            let handles: Vec<_> = members.iter().map(|name| {
                let (db, mission, base) = (&db, &mission, &base);
                scope.spawn(move || {
                    let mut last = Err(String::new());
                    for attempt in 0..RETRY_BACKOFF_MS.len() + 1 {
                        last = prepare_one(db, mission, name, base);
                        match &last {
                            Err(e) if is_transient_git_error(e) && attempt < RETRY_BACKOFF_MS.len() => {
                                std::thread::sleep(std::time::Duration::from_millis(RETRY_BACKOFF_MS[attempt]));
                            }
                            _ => break,
                        }
                    }
                    last
                })
            }).collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("Falha ao preparar o worktree.".into()))).collect::<Result<Vec<_>, _>>()
        })?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        Ok(PreparedTeam { workspaces, precheck: super::precheck_text(&conn, &mission_id)?, memory: super::memory_context_text(&conn, &mission_id)? })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod test;
