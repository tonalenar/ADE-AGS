//! Revisar lo que entregó una misión y llevarlo al proyecto.
//!
//! Cada tarea aislada trabaja en su propio worktree y rama (`runs::worktrees`). Al terminar,
//! esas ramas quedaban sueltas: juntarlas era trabajo manual con git. Acá:
//!
//! 1. **Ver** cada entrega: sus commits, qué archivos tocó (+/−), el diff, y si dejó cambios
//!    sin commitear (que no se pueden integrar: no están en la rama).
//! 2. **Aceptar** la junta en el worktree de INTEGRACIÓN de la misión: uno por misión, que
//!    nace del HEAD del proyecto con la primera tarea aceptada. La copia de trabajo del
//!    usuario no se toca. **Rechazar** solo la marca.
//! 3. **Aplicar** la misión: un merge de la rama de integración en el proyecto.
//!
//! Los merges de entregas y del proyecto abortan los conflictos. Al actualizar la rama
//! de integración con origin/master, el merge queda abierto para resolverlo en la app
//! (`conflicts.rs`) o abortarlo explícitamente, sin tocar el checkout del usuario.
//!
//! No usa `git merge-tree --write-tree` (2.38+): se prueba el merge de verdad en la
//! integración, que es descartable, y funciona con cualquier git.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

use crate::util::{external_path, output_with_timeout};

const GIT_FAST: Duration = Duration::from_secs(20);
const GIT_SLOW: Duration = Duration::from_secs(180);
/// Más que esto no se lee en una pantalla; se avisa que se cortó.
const MAX_DIFF_BYTES: usize = 400 * 1024;

fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(external_path(dir)).args(args);
    // Sin terminal que conteste: un editor o un prompt colgarían el comando.
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_MERGE_AUTOEDIT", "no");
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| format!("no se pudo correr git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if !err.is_empty() { err } else if !out.is_empty() { out } else { format!("git {} falló", args.join(" ")) })
    }
}

/// Un archivo de la entrega, con sus líneas agregadas y quitadas (`None` = binario).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

/// `git diff --numstat -z`: "agregadas\tquitadas\truta\0", o con renombres
/// "a\tq\t\0origen\0destino\0". Los binarios traen "-" en vez de números.
pub fn parse_numstat(raw: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut parts = raw.split('\0').peekable();
    while let Some(head) = parts.next() {
        if head.is_empty() {
            continue;
        }
        let mut cols = head.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else { continue };
        let path = if path.is_empty() {
            // Renombre: vienen origen y destino como entradas aparte; se muestra el destino.
            let _from = parts.next();
            parts.next().unwrap_or_default().to_string()
        } else {
            path.to_string()
        };
        out.push(FileChange { path, added: a.parse().ok(), removed: r.parse().ok() });
    }
    out
}

/// Los archivos en conflicto de un merge a medias (antes de abortarlo).
fn conflicted(dir: &Path) -> Vec<String> {
    git(dir, &["diff", "--name-only", "--diff-filter=U", "-z"], GIT_FAST)
        .map(|raw| raw.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Lo que sale de intentar un merge.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum MergeOutcome {
    Merged { commit: String },
    /// Conflictos: quedan abiertos solo al actualizar la integración con origin/master.
    Conflict { files: Vec<String> },
}

/// `-c user.*` solo si el repo no tiene identidad: sin ella git se niega a crear el commit
/// de merge, y el usuario no tiene por qué haberla configurado para usar la app.
pub(crate) fn identity_args(dir: &Path) -> Vec<String> {
    let has = |key: &str| git(dir, &["config", "--get", key], GIT_FAST).is_ok_and(|v| !v.is_empty());
    let mut args = Vec::new();
    if !has("user.name") {
        args.extend(["-c".to_string(), "user.name=ADE AGS".to_string()]);
    }
    if !has("user.email") {
        args.extend(["-c".to_string(), "user.email=ade@localhost".to_string()]);
    }
    args
}

/// `git merge --no-ff` de `branch` en `dir`. Si choca, lo aborta y devuelve los conflictos.
pub fn merge(dir: &Path, branch: &str, message: &str) -> Result<MergeOutcome, String> {
    merge_with_policy(dir,branch,message,false)
}

#[cfg(test)]
mod integration_conflict_test {
    use super::*;
    #[test]
    fn master_conflict_stays_only_in_integration_until_resolved_or_aborted() {
        let dir=std::env::temp_dir().join(format!("ags-integration-conflict-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir,&["init","-b","master"],GIT_FAST).unwrap();
        git(&dir,&["config","user.name","Test"],GIT_FAST).unwrap();git(&dir,&["config","user.email","test@example.invalid"],GIT_FAST).unwrap();
        std::fs::write(dir.join("roadmap.md"),"base\n").unwrap();git(&dir,&["add","."],GIT_FAST).unwrap();git(&dir,&["commit","-m","base"],GIT_FAST).unwrap();
        git(&dir,&["checkout","-b","cc/integration"],GIT_FAST).unwrap();std::fs::write(dir.join("roadmap.md"),"mission\n").unwrap();git(&dir,&["commit","-am","mission"],GIT_FAST).unwrap();
        git(&dir,&["checkout","master"],GIT_FAST).unwrap();std::fs::write(dir.join("roadmap.md"),"master\n").unwrap();git(&dir,&["commit","-am","master"],GIT_FAST).unwrap();git(&dir,&["update-ref","refs/remotes/origin/master","HEAD"],GIT_FAST).unwrap();
        git(&dir,&["checkout","cc/integration"],GIT_FAST).unwrap();
        assert!(matches!(merge_with_policy(&dir,"origin/master","sync",true).unwrap(),MergeOutcome::Conflict {..}));
        assert!(git(&dir,&["rev-parse","--verify","MERGE_HEAD"],GIT_FAST).is_ok());
        assert_eq!(conflicted(&dir),vec!["roadmap.md"]);
        git(&dir,&["merge","--abort"],GIT_FAST).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("roadmap.md")).unwrap().replace("\r\n","\n"),"mission\n");
        assert!(matches!(merge(&dir,"origin/master","sync").unwrap(),MergeOutcome::Conflict {..}));
        assert!(git(&dir,&["rev-parse","--verify","MERGE_HEAD"],GIT_FAST).is_err());
        merge_with_policy(&dir,"origin/master","sync",true).unwrap();
        std::fs::write(dir.join("roadmap.md"),"mission\nmaster\n").unwrap();git(&dir,&["add","roadmap.md"],GIT_FAST).unwrap();git(&dir,&["commit","--no-edit"],GIT_FAST).unwrap();
        assert!(conflicted(&dir).is_empty());assert!(git(&dir,&["rev-parse","--verify","MERGE_HEAD"],GIT_FAST).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

fn merge_with_policy(dir: &Path, branch: &str, message: &str, keep_conflicts:bool) -> Result<MergeOutcome, String> {
    if branch.starts_with('-') {
        return Err(format!("rama inválida: {branch}"));
    }
    let mut args = identity_args(dir);
    args.extend(["merge", "--no-ff", "--no-edit", "-m", message, branch].map(str::to_string));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match git(dir, &refs, GIT_SLOW) {
        Ok(_) => Ok(MergeOutcome::Merged { commit: git(dir, &["rev-parse", "--short", "HEAD"], GIT_FAST)? }),
        Err(error) => {
            let files = conflicted(dir);
            // Si no llegó a empezar (rama inexistente, árbol sucio) no hay nada que abortar.
            if !keep_conflicts || files.is_empty() {let _ = git(dir, &["merge", "--abort"], GIT_FAST);}
            if files.is_empty() { Err(error) } else { Ok(MergeOutcome::Conflict { files }) }
        }
    }
}

/// Los cambios sin commitear de un repo o worktree (sin contar los symlinks de skills, que
/// git ve como archivos nuevos y son de la app).
fn dirty(dir: &Path, managed: &[PathBuf]) -> Result<Vec<String>, String> {
    crate::runs::worktrees::dirty_files(dir, managed)
}

// ── Lo que se muestra ────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub task_id: String,
    pub title: String,
    pub functional_role: Option<String>,
    pub status: String,
    pub branch: String,
    pub worktree_removed: bool,
    /// Asuntos de los commits de la rama que el proyecto no tiene, del más nuevo al más viejo.
    pub commits: Vec<String>,
    pub files: Vec<FileChange>,
    /// Cambios que el agente dejó sin commitear: no están en la rama, no se integran.
    pub uncommitted: Vec<String>,
    /// `accepted`, `rejected`, `conflict` o `None` (sin revisar).
    pub review: Option<String>,
    pub review_note: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissionReview {
    pub mission_id: String,
    pub integration_branch: Option<String>,
    /// Commits de la integración que el proyecto todavía no tiene.
    pub pending_commits: usize,
    pub applied_at: Option<i64>,
    pub deliveries: Vec<Delivery>,
}

/// Las tareas con rama del run activo de la misión, con lo que entregó cada una.
pub fn review(conn: &Connection, mission_id: &str) -> Result<MissionReview, String> {
    let mission = super::store::get(conn, mission_id)?.ok_or("la misión ya no existe")?;
    let (integration_branch, applied_at) = integration_of(conn, mission_id)?;
    let project = Path::new(&mission.cwd);
    let mut deliveries = Vec::new();
    if let Some(run_id) = &mission.active_run_id {
        for task in crate::runs::store::tasks_of_run(conn, run_id)? {
            let Some(branch) = task.branch.clone() else { continue };
            let range = format!("HEAD...{branch}");
            let files = git(project, &["diff", "--numstat", "-z", &range], GIT_FAST)
                .map(|raw| parse_numstat(&raw))
                .unwrap_or_default();
            let commits = git(project, &["log", "--format=%s", "-n", "30", &format!("HEAD..{branch}")], GIT_FAST)
                .map(|raw| raw.lines().map(str::to_string).collect())
                .unwrap_or_default();
            let uncommitted = match (&task.worktree_path, task.worktree_removed) {
                (Some(root), false) => dirty(Path::new(root), &managed_links(conn, &task)).unwrap_or_default(),
                _ => Vec::new(),
            };
            let (review, review_note) = review_of(conn, &task.id);
            deliveries.push(Delivery {
                task_id: task.id.clone(),
                title: task.title.clone(),
                functional_role: task.functional_role.clone(),
                status: task.status.clone(),
                branch,
                worktree_removed: task.worktree_removed,
                commits,
                files,
                uncommitted,
                review,
                review_note,
            });
        }
    }
    let pending_commits = integration_branch
        .as_deref()
        .and_then(|b| git(project, &["rev-list", "--count", &format!("HEAD..{b}")], GIT_FAST).ok())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    Ok(MissionReview { mission_id: mission.id, integration_branch, pending_commits, applied_at, deliveries })
}

/// Los symlinks de skills que la app montó en el worktree de la tarea.
fn managed_links(conn: &Connection, task: &crate::runs::Task) -> Vec<PathBuf> {
    let (Ok(skills_dir), Some(cwd)) = (crate::skills::skills_dir_from_conn(conn), task.worktree_path.as_deref()) else {
        return Vec::new();
    };
    crate::skills::links_dir_for(cwd, &task.agent_id)
        .map(|links| crate::runs::worktrees::managed_links(&links, &skills_dir))
        .unwrap_or_default()
}

/// El diff completo de una entrega contra el proyecto (desde donde se separó).
pub fn task_diff(conn: &Connection, task_id: &str) -> Result<String, String> {
    let task = crate::runs::store::task_by_id(conn, task_id)?.ok_or("la tarea ya no existe")?;
    let branch = task.branch.ok_or("esta tarea no corrió aislada: no tiene rama propia")?;
    let project = mission_cwd_of_run(conn, &task.run_id)?.unwrap_or(task.cwd);
    let mut diff = git(Path::new(&project), &["diff", &format!("HEAD...{branch}")], GIT_SLOW)?;
    if diff.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
        diff.push_str("\n\n… (diff cortado: abrí la rama en el explorador para verlo entero)\n");
    }
    Ok(diff)
}

fn mission_cwd_of_run(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    let Some(mission_id) = super::store::mission_of_run(conn, run_id)? else { return Ok(None) };
    Ok(super::store::get(conn, &mission_id)?.map(|m| m.cwd))
}

// ── Estado de la revisión ────────────────────────────────────────

fn review_of(conn: &Connection, task_id: &str) -> (Option<String>, Option<String>) {
    conn.query_row("SELECT review, review_note FROM tasks WHERE id = ?1", [task_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((None, None))
}

pub fn set_review(conn: &Connection, task_id: &str, review: Option<&str>, note: Option<&str>) -> Result<(), String> {
    conn.execute("UPDATE tasks SET review = ?1, review_note = ?2 WHERE id = ?3", rusqlite::params![review, note, task_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// La rama de integración de la misión (y su carpeta), y cuándo se aplicó.
fn integration_of(conn: &Connection, mission_id: &str) -> Result<(Option<String>, Option<i64>), String> {
    conn.query_row(
        "SELECT integration_branch, applied_at FROM missions WHERE id = ?1",
        [mission_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

pub fn integration_path(conn: &Connection, mission_id: &str) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT integration_branch, integration_path FROM missions WHERE id = ?1",
        [mission_id],
        |r| Ok(r.get::<_, Option<String>>(0)?.zip(r.get::<_, Option<String>>(1)?)),
    )
    .map_err(|e| e.to_string())
}

pub fn set_integration(conn: &Connection, mission_id: &str, branch: &str, path: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE missions SET integration_branch = ?1, integration_path = ?2 WHERE id = ?3",
        rusqlite::params![branch, path, mission_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_applied(conn: &Connection, mission_id: &str, at: i64) -> Result<(), String> {
    conn.execute("UPDATE missions SET applied_at = ?1 WHERE id = ?2", rusqlite::params![at, mission_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Las acciones ─────────────────────────────────────────────────

/// Acepta la entrega: la junta en la integración de la misión (que crea si no existe).
///
/// Se niega con la tarea viva o con cambios sin commitear en su worktree: no están en la
/// rama, y aceptarla así sería aceptar algo distinto de lo que se revisó.
pub fn accept(
    db: &crate::database::DbConnection,
    worktrees_base: &Path,
    mission_id: &str,
    task_id: &str,
) -> Result<MergeOutcome, String> {
    let (mission, task, existing) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mission = super::store::get(&conn, mission_id)?.ok_or("la misión ya no existe")?;
        let task = crate::runs::store::task_by_id(&conn, task_id)?.ok_or("la tarea ya no existe")?;
        if mission.active_run_id.as_deref() != Some(task.run_id.as_str()) {
            return Err("la tarea no es del run actual de la misión".into());
        }
        if matches!(task.status.as_str(), "pending" | "ready" | "running") {
            return Err("la tarea todavía no terminó".into());
        }
        if let (Some(root), false) = (&task.worktree_path, task.worktree_removed) {
            let pending = dirty(Path::new(root), &managed_links(&conn, &task))?;
            if !pending.is_empty() {
                return Err(format!(
                    "la tarea dejó cambios sin commitear ({}): no están en su rama. Pedile que los commitee o descartalos antes de aceptarla",
                    pending.join(", ")
                ));
            }
        }
        let existing = integration_path(&conn, mission_id)?;
        (mission, task, existing)
    };
    let branch = task.branch.clone().ok_or("esta tarea no corrió aislada: no tiene rama propia")?;

    let integration_dir = match existing.filter(|(_, path)| Path::new(path).is_dir()) {
        Some((_, path)) => PathBuf::from(path),
        None => {
            // Nace del HEAD del proyecto: es contra lo que se revisaron los diffs.
            let wt = crate::runs::worktrees::create_from(
                worktrees_base,
                Path::new(&mission.cwd),
                &format!("mision {}", mission.title),
                "HEAD",
            )?;
            let conn = db.lock().map_err(|e| e.to_string())?;
            set_integration(&conn, mission_id, &wt.branch, &wt.root.to_string_lossy())?;
            wt.root
        }
    };

    let outcome = merge(&integration_dir, &branch, &format!("ADE: {}", task.title))?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    match &outcome {
        MergeOutcome::Merged { .. } => set_review(&conn, task_id, Some("accepted"), None)?,
        MergeOutcome::Conflict { files } => set_review(&conn, task_id, Some("conflict"), Some(&files.join("\n")))?,
    }
    Ok(outcome)
}

/// Lleva al proyecto lo aceptado: un merge de la rama de integración en la rama actual.
/// Se niega con el árbol del proyecto sucio o con HEAD desprendido.
pub fn apply(db: &crate::database::DbConnection, mission_id: &str) -> Result<MergeOutcome, String> {
    let (mission, integration) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mission = super::store::get(&conn, mission_id)?.ok_or("la misión ya no existe")?;
        let integration = integration_path(&conn, mission_id)?.ok_or("todavía no se aceptó ninguna entrega")?;
        (mission, integration)
    };
    let project = Path::new(&mission.cwd);
    let root = crate::runs::worktrees::repo_root(project)?;
    if git(&root, &["symbolic-ref", "-q", "HEAD"], GIT_FAST).is_err() {
        return Err("el proyecto está en un HEAD desprendido: cambiá a una rama antes de aplicar".into());
    }
    // Solo lo rastreado: un archivo nuevo que el usuario no agregó (o los symlinks de skills
    // de la app) no impide un merge, y negarse por eso no tendría sentido.
    let status = git(&root, &["status", "--porcelain", "-z", "--untracked-files=no"], GIT_FAST)?;
    let pending: Vec<String> = status
        .split('\0')
        .filter(|e| e.len() > 3)
        .map(|e| e[3..].to_string())
        .collect();
    if !pending.is_empty() {
        return Err(format!(
            "el proyecto tiene cambios sin commitear ({}): commitealos o guardalos antes de aplicar la misión",
            pending.join(", ")
        ));
    }
    // Resolve master conflicts in the isolated integration worktree first.
    let integration_dir=Path::new(&integration.1);
    if git(integration_dir,&["rev-parse","--verify","MERGE_HEAD"],GIT_FAST).is_ok() {
        return Ok(MergeOutcome::Conflict {files:conflicted(integration_dir)});
    }
    if git(integration_dir,&["rev-parse","--verify","refs/remotes/origin/master"],GIT_FAST).is_ok() {
        let refresh=merge_with_policy(integration_dir,"origin/master","ADE: atualizar integração com origin/master",true)?;
        if matches!(refresh,MergeOutcome::Conflict {..}) {return Ok(refresh)}
    }
    let outcome = merge(&root, &integration.0, &format!("ADE: misión {}", mission.title))?;
    if matches!(outcome, MergeOutcome::Merged { .. }) {
        let conn = db.lock().map_err(|e| e.to_string())?;
        mark_applied(&conn, mission_id, crate::util::now_ts())?;
    }
    Ok(outcome)
}
