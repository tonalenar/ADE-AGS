//! Checkpoints de un run: una foto del trabajo antes y después de cada tarea, y volver atrás.
//!
//! Un agente puede romper cosas, o llevar el plan por mal camino. Sin esto, lo único que hay
//! para deshacerlo es `git` a mano. Con esto:
//!
//! - **Antes de que arranque cada tarea** y **al terminar** se toma una foto del árbol de
//!   trabajo donde corre (su worktree, o la carpeta del proyecto si no está aislada).
//! - **"Volver a antes de esta tarea"** (rollback) restaura esa carpeta a como estaba, y deja la
//!   tarea —y lo que dependía de ella— en cola para correr de nuevo (replay).
//!
//! ## La foto
//!
//! Es un commit de git hecho "por fuera": se arma con un índice temporal (`GIT_INDEX_FILE`),
//! así que no toca el índice, ni la rama, ni el árbol de trabajo de nadie. Lleva todo lo
//! versionable (cambios sin commitear y archivos nuevos, sin lo ignorado) y como padre el
//! `HEAD` de ese momento. Cuelga de una ref propia (`refs/controlcode/checkpoints/<id>`) para
//! que `git gc` no la junte.
//!
//! ## Restaurar
//!
//! Lleva `HEAD` al del momento de la foto, el árbol de trabajo a su contenido y borra lo
//! que nació después (sin tocar lo ignorado). Los cambios quedan como sin commitear, como
//! estaban. **Antes de restaurar se toma otra foto del estado actual** (tipo `safety`): volver
//! atrás nunca pierde lo que había, se puede deshacer restaurando esa.
//!
//! ## Qué se rehace
//!
//! Volver a antes de una tarea arrastra a: las que dependen de ella (su resultado ya no vale),
//! y las que corrieron DESPUÉS en la misma carpeta (la restauración les saca el piso). Las que
//! trabajan en su propio worktree y no dependen de ella no se tocan. Las que están corriendo
//! frenan todo: primero se las para.
//!
//! No se borran los `facts` que escribieron las tareas rehechas (son append-only por diseño).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::Serialize;

use super::types::{status, Task};
use crate::util::{external_path, now_ts, output_with_timeout};

const GIT_FAST: Duration = Duration::from_secs(20);
const GIT_SLOW: Duration = Duration::from_secs(120);

/// Cuántas fotos de un mismo run se conservan como mucho (las más viejas se sueltan).
pub const MAX_PER_RUN: usize = 200;

pub mod kind {
    /// Antes de que arranque una tarea.
    pub const BEFORE: &str = "before";
    /// Al terminar una tarea.
    pub const AFTER: &str = "after";
    /// A pedido del usuario.
    pub const MANUAL: &str = "manual";
    /// El estado de antes de un rollback: para poder deshacerlo.
    pub const SAFETY: &str = "safety";
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub kind: String,
    /// La raíz del repo o worktree fotografiado.
    pub dir: String,
    pub commit_sha: String,
    /// El `HEAD` de ese momento.
    pub head_sha: Option<String>,
    pub label: String,
    pub created_at: i64,
}

// ── git ─────────────────────────────────────────────────────────────

fn git(dir: &Path, args: &[&str], envs: &[(&str, &str)], limit: Duration) -> Result<String, String> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.arg("-C").arg(external_path(dir)).args(args);
    // Identidad propia: un commit "por fuera" no puede fallar porque la máquina no tenga `user.name`.
    cmd.env("GIT_AUTHOR_NAME", "ADE AGS")
        .env("GIT_AUTHOR_EMAIL", "checkpoint@ags.local")
        .env("GIT_COMMITTER_NAME", "ADE AGS")
        .env("GIT_COMMITTER_EMAIL", "checkpoint@ags.local");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| format!("no se pudo correr git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} falló", args.join(" ")) } else { err })
    }
}

/// La raíz del repo (o worktree) que contiene `dir`.
pub fn root_of(dir: &Path) -> Result<PathBuf, String> {
    git(dir, &["rev-parse", "--show-toplevel"], &[], GIT_FAST).map(PathBuf::from)
}

#[derive(Debug)]
pub struct Snapshot {
    pub root: PathBuf,
    pub commit: String,
    pub head: String,
}

/// Toma la foto de `dir` (ver el módulo). No cambia nada del repo salvo agregar objetos y la ref.
pub fn snapshot(dir: &Path, id: &str, label: &str) -> Result<Snapshot, String> {
    let root = root_of(dir)?;
    let head = git(&root, &["rev-parse", "--verify", "HEAD"], &[], GIT_FAST)
        .map_err(|_| "el repositorio todavía no tiene ningún commit: no hay de dónde tomar una foto".to_string())?;
    let git_dir = git(&root, &["rev-parse", "--absolute-git-dir"], &[], GIT_FAST)?;
    let index = Path::new(&git_dir).join(format!("cc-checkpoint-{id}.index"));
    let index_s = index.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", index_s.as_str())];

    let result = (|| -> Result<String, String> {
        git(&root, &["read-tree", "HEAD"], &env, GIT_FAST)?;
        // `-A`: lo modificado, lo nuevo y lo borrado; respeta `.gitignore`.
        git(&root, &["add", "-A", "--", "."], &env, GIT_SLOW)?;
        let tree = git(&root, &["write-tree"], &env, GIT_FAST)?;
        let commit = git(&root, &["commit-tree", &tree, "-p", &head, "-m", label], &[], GIT_FAST)?;
        git(&root, &["update-ref", &format!("refs/controlcode/checkpoints/{id}"), &commit], &[], GIT_FAST)?;
        Ok(commit)
    })();
    let _ = std::fs::remove_file(&index);
    Ok(Snapshot { root, commit: result?, head })
}

/// Deja `root` como estaba en la foto (ver el módulo). El que llama ya tomó una foto de seguridad.
pub fn restore(root: &Path, commit: &str, head: &str) -> Result<(), String> {
    // El árbol de la foto tiene que existir: si alguien corrió un `gc` agresivo, se dice acá y no a medias.
    git(root, &["cat-file", "-e", &format!("{commit}^{{tree}}")], &[], GIT_FAST)
        .map_err(|_| "la foto ya no está en el repositorio (¿se limpió con git gc?)".to_string())?;
    git(root, &["cat-file", "-e", &format!("{head}^{{commit}}")], &[], GIT_FAST)
        .map_err(|_| "el commit de ese momento ya no está en el repositorio".to_string())?;
    git(root, &["reset", "-q", "--hard", head], &[], GIT_SLOW)?;
    git(root, &["read-tree", "--reset", "-u", &format!("{commit}^{{tree}}")], &[], GIT_SLOW)?;
    // Lo que nació después de la foto (no versionado, no ignorado) no está en el índice ahora.
    git(root, &["clean", "-fdq"], &[], GIT_SLOW)?;
    // Los cambios quedan sin commitear y sin preparar, como estaban.
    git(root, &["reset", "-q"], &[], GIT_SLOW)?;
    Ok(())
}

// ── Guardado ────────────────────────────────────────────────────────

fn row(r: &rusqlite::Row) -> rusqlite::Result<Checkpoint> {
    Ok(Checkpoint {
        id: r.get(0)?,
        run_id: r.get(1)?,
        task_id: r.get(2)?,
        kind: r.get(3)?,
        dir: r.get(4)?,
        commit_sha: r.get(5)?,
        head_sha: r.get(6)?,
        label: r.get(7)?,
        created_at: r.get(8)?,
    })
}

const COLS: &str = "id, run_id, task_id, kind, dir, commit_sha, head_sha, label, created_at";

pub fn insert(conn: &Connection, c: &Checkpoint) -> Result<(), String> {
    conn.execute(
        "INSERT INTO run_checkpoints (id, run_id, task_id, kind, dir, commit_sha, head_sha, label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![c.id, c.run_id, c.task_id, c.kind, c.dir, c.commit_sha, c.head_sha, c.label, c.created_at],
    )
    .map_err(|e| e.to_string())?;
    // Las más viejas del run se sueltan (la ref queda: el objeto es chico y `gc` lo junta cuando se la borre).
    conn.execute(
        "DELETE FROM run_checkpoints WHERE run_id = ?1 AND id NOT IN
           (SELECT id FROM run_checkpoints WHERE run_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![c.run_id, MAX_PER_RUN as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(conn: &Connection, run_id: &str) -> Result<Vec<Checkpoint>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM run_checkpoints WHERE run_id = ?1 ORDER BY created_at, rowid"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([run_id], row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Checkpoint>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(&format!("SELECT {COLS} FROM run_checkpoints WHERE id = ?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())
}

/// Toma y guarda una foto para `task`/`run`. El `Err` es para quien quiera decirlo; las
/// llamadas automáticas lo ignoran: una foto que falla nunca puede romper una tarea.
pub fn take(
    db: &crate::database::DbConnection,
    run_id: &str,
    task_id: Option<&str>,
    dir: &Path,
    kind: &str,
    label: &str,
) -> Result<Checkpoint, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let snap = snapshot(dir, &id, label)?;
    let cp = Checkpoint {
        id,
        run_id: run_id.to_string(),
        task_id: task_id.map(String::from),
        kind: kind.to_string(),
        dir: snap.root.to_string_lossy().to_string(),
        commit_sha: snap.commit,
        head_sha: Some(snap.head),
        label: label.to_string(),
        created_at: now_ts(),
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    insert(&conn, &cp)?;
    Ok(cp)
}

// ── Qué se rehace ───────────────────────────────────────────────────

/// Lo que hace falta de una tarea para planear el rollback.
#[derive(Debug, Clone)]
pub struct Item {
    pub id: String,
    pub status: String,
    pub depends_on: Vec<String>,
    /// La carpeta donde corre (la raíz de su repo/worktree), si se sabe.
    pub dir: Option<String>,
    /// Su foto "antes" más reciente: (id, momento).
    pub before: Option<(String, i64)>,
    /// El líder solo planifica (no toca archivos): no se rehace.
    pub lead: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Las tareas que vuelven a la cola, la pedida primero.
    pub tasks: Vec<String>,
    /// Qué foto se restaura en cada carpeta: la más vieja de las tareas afectadas de ahí.
    pub restores: Vec<(String, String)>,
    /// Tareas afectadas que no tienen foto: vuelven a la cola pero su carpeta no se toca.
    pub without_checkpoint: Vec<String>,
}

/// Planea volver a antes de `root_task`. Pura. `Err` si no se puede (la tarea no existe, no
/// tiene foto, o algo del plan está corriendo).
pub fn plan(items: &[Item], root_task: &str) -> Result<Plan, String> {
    let by_id: HashMap<&str, &Item> = items.iter().map(|i| (i.id.as_str(), i)).collect();
    let root = by_id.get(root_task).ok_or("A tarefa não existe.")?;
    if root.lead {
        return Err("O líder só planeja e não mexe em arquivos: volte atrás numa tarefa de trabalho (rodá-lo de novo duplicaria o plano).".into());
    }
    if root.before.is_none() {
        return Err("Esta tarefa não tem foto de antes (rodou antes dos checkpoints existirem, ou a foto falhou): não há a que voltar.".into());
    }
    if let Some(live) = items.iter().find(|i| matches!(i.status.as_str(), status::RUNNING | status::READY)) {
        return Err(format!("A tarefa '{}' está rodando: pare-a antes de voltar atrás.", live.id));
    }

    let mut affected: HashSet<&str> = HashSet::from([root_task]);
    let root_dir = root.dir.as_deref();
    let root_at = root.before.as_ref().map(|b| b.1).unwrap_or(0);
    loop {
        let before = affected.len();
        for item in items {
            if affected.contains(item.id.as_str()) || item.lead {
                continue;
            }
            // Depende de una afectada: su resultado ya no vale.
            let dependent = item.depends_on.iter().any(|d| affected.contains(d.as_str()));
            // Corrió después en la misma carpeta: la restauración le saca el piso.
            let same_dir_later = item.dir.is_some()
                && item.dir.as_deref() == root_dir
                && item.before.as_ref().is_some_and(|b| b.1 >= root_at);
            if dependent || same_dir_later {
                affected.insert(item.id.as_str());
            }
        }
        if affected.len() == before {
            break;
        }
    }

    // La pedida primero, después el resto en el orden del plan.
    let mut tasks = vec![root_task.to_string()];
    tasks.extend(items.iter().filter(|i| i.id != root_task && affected.contains(i.id.as_str())).map(|i| i.id.clone()));

    let mut per_dir: Vec<(String, (String, i64))> = Vec::new();
    let mut without = Vec::new();
    for id in &tasks {
        let item = by_id[id.as_str()];
        match (&item.dir, &item.before) {
            (Some(dir), Some(before)) => match per_dir.iter_mut().find(|(d, _)| d == dir) {
                Some((_, best)) if before.1 < best.1 => *best = before.clone(),
                Some(_) => {}
                None => per_dir.push((dir.clone(), before.clone())),
            },
            _ if item.status == status::PENDING => {}
            _ => without.push(id.clone()),
        }
    }
    Ok(Plan {
        tasks,
        restores: per_dir.into_iter().map(|(dir, (cp, _))| (dir, cp)).collect(),
        without_checkpoint: without,
    })
}

/// Las tareas de un run como las necesita `plan`, con su foto "antes" más reciente.
pub fn items_of(conn: &Connection, run_id: &str, tasks: &[Task]) -> Result<Vec<Item>, String> {
    let cps = list(conn, run_id)?;
    Ok(tasks
        .iter()
        .map(|t| {
            let before = cps
                .iter()
                .filter(|c| c.kind == kind::BEFORE && c.task_id.as_deref() == Some(t.id.as_str()))
                .max_by_key(|c| c.created_at)
                .map(|c| (c.id.clone(), c.created_at));
            let dir = cps
                .iter()
                .filter(|c| c.task_id.as_deref() == Some(t.id.as_str()) && c.kind == kind::BEFORE)
                .max_by_key(|c| c.created_at)
                .map(|c| c.dir.clone());
            Item {
                id: t.id.clone(),
                status: t.status.clone(),
                depends_on: t.depends_on.clone(),
                dir,
                before,
                lead: t.role.as_deref() == Some(super::types::role::LEAD),
            }
        })
        .collect())
}

/// Ejecuta un rollback ya planeado: foto de seguridad por carpeta, restaurar y poner las tareas
/// en cola. Devuelve las fotos de seguridad.
pub fn rollback(db: &crate::database::DbConnection, run_id: &str, plan: &Plan) -> Result<Vec<Checkpoint>, String> {
    let mut safeties = Vec::new();
    // Todo se valida y se fotografía ANTES de tocar nada: si algo no se puede, no queda a medias.
    let mut to_restore = Vec::new();
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        for (dir, cp_id) in &plan.restores {
            let cp = get(&conn, cp_id)?.ok_or("Uma foto do plano já não existe.")?;
            if !Path::new(dir).exists() {
                return Err(format!("A pasta {dir} já não existe (worktree descartado?): não dá para restaurá-la."));
            }
            to_restore.push((dir.clone(), cp));
        }
    }
    for (dir, _) in &to_restore {
        safeties.push(take(db, run_id, None, Path::new(dir), kind::SAFETY, "antes de voltar atrás")?);
    }
    for (dir, cp) in &to_restore {
        let head = cp.head_sha.as_deref().ok_or("A foto não guardou o HEAD.")?;
        restore(Path::new(dir), &cp.commit_sha, head)?;
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    for id in &plan.tasks {
        conn.execute(
            "UPDATE tasks SET status = ?1, error = NULL, result = NULL, structured_handoff = NULL,
                              started_at = NULL, ended_at = NULL, session_id = NULL, last_error = NULL
             WHERE id = ?2 AND status NOT IN (?3, ?4)",
            params![status::PENDING, id, status::RUNNING, status::READY],
        )
        .map_err(|e| e.to_string())?;
    }
    super::store::refresh_run_status(&conn, run_id)?;
    Ok(safeties)
}

// ── Para la pantalla ────────────────────────────────────────────────

fn db_of(app: &tauri::AppHandle) -> Result<crate::database::DbConnection, String> {
    use tauri::Manager;
    Ok(app.try_state::<crate::database::DbConnection>().ok_or("la base no está disponible")?.inner().clone())
}

#[tauri::command]
pub fn run_checkpoints(app: tauri::AppHandle, run_id: String) -> Result<Vec<Checkpoint>, String> {
    let db = db_of(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    list(&conn, &run_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTask {
    pub id: String,
    pub title: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPreview {
    /// Las tareas que vuelven a la cola, con la pedida primero.
    pub tasks: Vec<PlannedTask>,
    /// Las carpetas que se restauran.
    pub dirs: Vec<String>,
    /// Las que vuelven a la cola pero no tienen foto: su carpeta no se toca.
    pub without_checkpoint: Vec<String>,
}

/// Lo que haría volver a antes de `task_id`, sin tocar nada: la pantalla lo muestra antes de confirmar.
fn planned(db: &crate::database::DbConnection, task_id: &str) -> Result<(String, Plan, Vec<Task>), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let task = super::store::task_by_id(&conn, task_id)?.ok_or("A tarefa não existe mais.")?;
    let tasks = super::store::tasks_of_run(&conn, &task.run_id)?;
    let items = items_of(&conn, &task.run_id, &tasks)?;
    Ok((task.run_id.clone(), plan(&items, task_id)?, tasks))
}

#[tauri::command(async)]
pub fn run_rollback_preview(app: tauri::AppHandle, task_id: String) -> Result<RollbackPreview, String> {
    let (_, plan, tasks) = planned(&db_of(&app)?, &task_id)?;
    let shown = |id: &String| tasks.iter().find(|t| &t.id == id).map(|t| PlannedTask { id: t.id.clone(), title: t.title.clone(), status: t.status.clone() });
    Ok(RollbackPreview {
        tasks: plan.tasks.iter().filter_map(shown).collect(),
        dirs: plan.restores.iter().map(|(d, _)| d.clone()).collect(),
        without_checkpoint: plan.without_checkpoint.clone(),
    })
}

/// Vuelve a antes de `task_id`. El plan se calcula de nuevo acá (no se confía en el de la pantalla).
#[tauri::command(async)]
pub fn run_rollback(app: tauri::AppHandle, task_id: String) -> Result<Vec<String>, String> {
    let db = db_of(&app)?;
    let (run_id, plan, _) = planned(&db, &task_id)?;
    rollback(&db, &run_id, &plan)?;
    for id in &plan.tasks {
        super::supervisor::notify_changed(&app, id);
    }
    // Las que quedaron en cola arrancan solas cuando les toca.
    super::scheduler::tick(&app, &run_id);
    Ok(plan.tasks)
}

/// Una foto a pedido de la carpeta del run.
#[tauri::command(async)]
pub fn run_checkpoint_create(app: tauri::AppHandle, run_id: String, label: String) -> Result<Checkpoint, String> {
    let db = db_of(&app)?;
    let cwd = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        super::store::run_by_id(&conn, &run_id)?.ok_or("O run não existe mais.")?.cwd
    };
    let label = label.trim();
    take(&db, &run_id, None, Path::new(&cwd), kind::MANUAL, if label.is_empty() { "ponto manual" } else { label })
}

/// Restaura la carpeta de una foto (la de seguridad que dejó un rollback, o una manual) sin
/// tocar las tareas. Antes toma otra foto de seguridad.
#[tauri::command(async)]
pub fn run_restore_checkpoint(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db = db_of(&app)?;
    let (cp, live) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let cp = get(&conn, &id)?.ok_or("A foto não existe mais.")?;
        let live: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE run_id = ?1 AND status IN ('running','ready')", [&cp.run_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        (cp, live)
    };
    if live > 0 {
        return Err("Há tarefas rodando neste run: pare-as antes de restaurar uma foto.".into());
    }
    if !Path::new(&cp.dir).exists() {
        return Err(format!("A pasta {} já não existe.", cp.dir));
    }
    let head = cp.head_sha.as_deref().ok_or("A foto não guardou o HEAD.")?;
    take(&db, &cp.run_id, None, Path::new(&cp.dir), kind::SAFETY, "antes de restaurar uma foto")?;
    restore(Path::new(&cp.dir), &cp.commit_sha, head)
}

/// Foto automática antes o después de una tarea: nunca rompe nada si falla.
pub fn auto(db: &crate::database::DbConnection, task: &Task, kind: &str) {
    let label = format!("{} — {}", if kind == self::kind::BEFORE { "antes" } else { "depois" }, task.title);
    if let Err(e) = take(db, &task.run_id, Some(&task.id), Path::new(&task.cwd), kind, &label) {
        // Sin repo, sin commits o sin git: la tarea corre igual, sin foto.
        eprintln!("checkpoint ({kind}) de '{}': {e}", task.title);
    }
}

#[cfg(test)]
mod test;
