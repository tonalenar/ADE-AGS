//! Juntar un piso de vuelta en su planta baja, y lo que se ve antes de hacerlo.
//!
//! Todo va por git con argumentos separados (sin shell). Nada se junta sobre trabajo sin
//! commitear, ni en el piso ni en la planta baja: el merge no puede llevarse cambios que
//! nadie guardó. Un conflicto se deshace (`merge --abort`) y la planta baja queda como
//! estaba; el piso se conserva para resolverlo ahí.
//!
//! El descarte del piso al juntar pasa por `floors::remove_with`, con las mismas
//! salvaguardas de siempre. La rama solo se borra si la creó la app y se pidió.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::floors::{self, Floor};
use crate::runs::worktrees;

const GIT_FAST: Duration = Duration::from_secs(15);
/// Un merge o un `merge-tree` puede tocar miles de archivos en un repo grande.
const GIT_SLOW: Duration = Duration::from_secs(120);

/// Una rama local del repo, con lo que importa para elegir destino o andar.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    /// Es la rama que está hoy en la carpeta desde la que se pregunta.
    pub current: bool,
    /// Ya está abierta en otro worktree: git no la deja abrir en un segundo.
    pub in_use: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLine {
    pub sha: String,
    pub subject: String,
}

/// Lo que traería juntar el piso, sin juntarlo.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandPreview {
    pub branch: String,
    pub target: String,
    /// Commits del piso que no están en el destino.
    pub ahead: u32,
    /// Commits del destino que el piso no tiene (el piso va atrasado).
    pub behind: u32,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// Hay cambios sin commitear en el piso: al juntar se niega.
    pub dirty: bool,
    /// Archivos que chocarían en el merge.
    pub conflicts: Vec<String>,
    /// `false` si esta versión de git no sabe calcular conflictos sin tocar el worktree.
    pub conflicts_checked: bool,
    /// Hasta 30 commits, del más nuevo al más viejo.
    pub commits: Vec<CommitLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    pub merged: bool,
    pub commits: u32,
    pub branch_deleted: bool,
    pub floor_removed: bool,
}

// ----------------------------------------------------------------- git

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    worktrees::git(dir, args, GIT_FAST)
}

/// Como `worktrees::git`, pero con el plazo largo y la salida aunque el código no sea 0:
/// `merge-tree` usa el 1 para "hay conflictos", no para un fallo.
fn git_raw(dir: &Path, args: &[&str]) -> Result<Output, String> {
    let dir = crate::util::external_path(dir);
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.arg("-C").arg(&dir).args(args);
    crate::util::output_with_timeout(&mut cmd, GIT_SLOW).map_err(|e| format!("não foi possível rodar o git: {e}"))
}

fn git_merge(ground: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_raw(ground, args)?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() { format!("git {} falló", args.join(" ")) } else { err })
}

/// Un nombre de rama que puede ir como argumento de git: sin vacío y sin `-` al inicio.
fn check_branch_arg(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err("O nome da branch não pode começar com '-'.".into());
    }
    Ok(name)
}

fn require_branch(repo: &Path, name: &str) -> Result<String, String> {
    let name = check_branch_arg(name)?;
    if git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_err() {
        return Err(format!("Não existe a branch '{name}' neste projeto."));
    }
    Ok(name.to_string())
}

/// La rama de `dir`, o `None` si está en un commit suelto.
fn current_branch(dir: &Path) -> Option<String> {
    git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|s| !s.is_empty())
}

fn count(repo: &Path, range: &str) -> Result<u32, String> {
    git(repo, &["rev-list", "--count", range])?
        .trim()
        .parse()
        .map_err(|_| "resposta inesperada do git ao contar commits".to_string())
}

/// Los archivos con cambios sin commitear. Un worktree que todavía no existe no tiene nada.
fn dirty_list(root: &Path, managed: &[PathBuf]) -> Result<Vec<String>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    worktrees::dirty_files(root, managed)
}

/// Hasta cinco nombres, y cuántos quedan.
fn listed(files: &[String]) -> String {
    let shown: Vec<&str> = files.iter().take(5).map(String::as_str).collect();
    let more = if files.len() > 5 { format!(" e mais {}", files.len() - 5) } else { String::new() };
    format!("{}{more}", shown.join(", "))
}

// ----------------------------------------------------------- parsing

/// `git diff --numstat`: `<ins>\t<del>\t<ruta>` por archivo. Un binario trae `-` en vez de
/// números: cuenta como archivo, sin líneas.
pub(crate) fn parse_numstat(out: &str) -> (u32, u32, u32) {
    let (mut files, mut ins, mut del) = (0u32, 0u32, 0u32);
    for line in out.lines() {
        let mut cols = line.splitn(3, '\t');
        let (Some(added), Some(removed), Some(_path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        files += 1;
        ins = ins.saturating_add(added.parse().unwrap_or(0));
        del = del.saturating_add(removed.parse().unwrap_or(0));
    }
    (files, ins, del)
}

/// La salida de `merge-tree --write-tree --name-only`: primero el OID del árbol, después un
/// archivo por línea.
pub(crate) fn parse_conflicted_names(out: &str) -> Vec<String> {
    out.lines().skip(1).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

// --------------------------------------------------------------- core

/// Las ramas locales de `cwd`, marcando la actual y las que ya están abiertas en otro worktree.
pub(crate) fn branches_in(cwd: &Path) -> Result<Vec<BranchInfo>, String> {
    let repo = worktrees::repo_root(cwd)?;
    let names = git(&repo, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"])?;
    let current = current_branch(&repo);
    let here = floors::norm(&repo.to_string_lossy());
    let elsewhere: Vec<String> = worktrees::list_worktrees(&repo)?
        .into_iter()
        .filter(|(path, _)| floors::norm(&path.to_string_lossy()) != here)
        .filter_map(|(_, branch)| branch)
        .collect();
    Ok(names
        .lines()
        .filter(|l| !l.is_empty())
        .map(|name| BranchInfo {
            name: name.to_string(),
            current: current.as_deref() == Some(name),
            in_use: elsewhere.iter().any(|b| b == name),
        })
        .collect())
}

/// Los archivos que chocarían si se junta `branch` en `target`, sin tocar ningún worktree.
/// `None` si esta versión de git no tiene `merge-tree --write-tree` (git 2.38 o más nuevo).
fn conflicts_of(repo: &Path, target: &str, branch: &str) -> Option<Vec<String>> {
    let out = git_raw(repo, &["merge-tree", "--write-tree", "--name-only", "--no-messages", target, branch]).ok()?;
    match out.status.code() {
        Some(0) => Some(Vec::new()),
        Some(1) => Some(parse_conflicted_names(&String::from_utf8_lossy(&out.stdout))),
        _ => None,
    }
}

/// Lo que traería juntar el piso en `target`. `managed` son los symlinks de skills del piso,
/// que git ve como archivos sin trackear y no son cambios.
pub(crate) fn preview_of(floor: &Floor, ground: &Path, target: &str, managed: &[PathBuf]) -> Result<LandPreview, String> {
    let target = require_branch(ground, target)?;
    let branch = require_branch(ground, &floor.branch)?;

    let ahead = count(ground, &format!("{target}..{branch}"))?;
    let behind = count(ground, &format!("{branch}..{target}"))?;
    let stat = git(ground, &["diff", "--numstat", &format!("{target}...{branch}")])?;
    let (files_changed, insertions, deletions) = parse_numstat(&stat);
    let dirty = !dirty_list(Path::new(&floor.root), managed)?.is_empty();
    let (conflicts, conflicts_checked) = match conflicts_of(ground, &target, &branch) {
        Some(found) => (found, true),
        None => (Vec::new(), false),
    };
    let commits = git(
        ground,
        &["log", "--abbrev=7", "--pretty=%h%x09%s", "-n", "30", &format!("{target}..{branch}")],
    )?
    .lines()
    .filter_map(|line| line.split_once('\t'))
    .map(|(sha, subject)| CommitLine { sha: sha.to_string(), subject: subject.to_string() })
    .collect();

    Ok(LandPreview {
        branch,
        target,
        ahead,
        behind,
        files_changed,
        insertions,
        deletions,
        dirty,
        conflicts,
        conflicts_checked,
        commits,
    })
}

/// Lo que impide juntar. Devuelve cuántos commits traería el piso.
pub(crate) fn check_land(
    floor: &Floor,
    ground: &Path,
    target: &str,
    managed_floor: &[PathBuf],
    managed_ground: &[PathBuf],
) -> Result<u32, String> {
    let target = require_branch(ground, target)?;
    let branch = require_branch(ground, &floor.branch)?;
    if target == branch {
        return Err("O destino não pode ser a própria branch do andar.".into());
    }

    let floor_dirty = dirty_list(Path::new(&floor.root), managed_floor)?;
    if !floor_dirty.is_empty() {
        return Err(format!(
            "O andar '{}' tem mudanças sem commit ({}); faça o commit antes de juntar.",
            floor.name,
            listed(&floor_dirty)
        ));
    }
    let ground_dirty = dirty_list(ground, managed_ground)?;
    if !ground_dirty.is_empty() {
        return Err(format!(
            "A planta baixa tem mudanças sem commit ({}); faça o commit ou guarde antes de juntar.",
            listed(&ground_dirty)
        ));
    }
    match current_branch(ground) {
        Some(current) if current == target => {}
        Some(current) => {
            return Err(format!(
                "A planta baixa está em '{current}', não em '{target}'. Rode `git checkout {target}` em {} e tente de novo.",
                ground.display()
            ))
        }
        None => {
            return Err(format!(
                "A planta baixa está em HEAD solto. Rode `git checkout {target}` em {} e tente de novo.",
                ground.display()
            ))
        }
    }
    count(ground, &format!("{target}..{branch}"))
}

/// Junta `branch` en `ground`, que ya está en `target`. Con conflicto, deshace el merge y
/// dice qué archivos chocaron.
pub(crate) fn merge_into(ground: &Path, branch: &str, target: &str) -> Result<(), String> {
    let branch = check_branch_arg(branch)?;
    match git_merge(ground, &["merge", "--no-ff", "--no-edit", branch]) {
        Ok(_) => Ok(()),
        Err(error) => {
            let conflicted: Vec<String> = git(ground, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            let merging = git(ground, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
            if merging || !conflicted.is_empty() {
                let _ = git_merge(ground, &["merge", "--abort"]);
            }
            if conflicted.is_empty() {
                return Err(format!("Não foi possível juntar: {error}"));
            }
            Err(format!(
                "Conflito ao juntar: {}. Nada foi juntado. Para resolver, rode `git merge {target}` no andar, resolva e commite.",
                listed(&conflicted)
            ))
        }
    }
}

// ------------------------------------------------------------ commands

fn find_floor(id: &str) -> Result<Floor, String> {
    floors::all().into_iter().find(|f| f.id == id).ok_or_else(|| "Esse andar já não existe.".to_string())
}

fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let db = app.try_state::<crate::database::DbConnection>().ok_or("la base no está disponible")?.inner().clone();
    let conn = db.lock().map_err(|e| e.to_string())?;
    crate::skills::skills_dir_from_conn(&conn)
}

/// Los symlinks de skills que la app puso en las carpetas de todos los agentes de `cwd`.
fn managed_mounts(cwd: &str, skills_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for adapter in crate::agents::adapters() {
        if let Some(dir) = crate::skills::links_dir_for(cwd, adapter.def().id) {
            found.extend(worktrees::managed_links(&dir, skills_dir));
        }
    }
    found
}

/// Las ramas locales del repo de `cwd`.
#[tauri::command(async)]
pub fn floor_branches(cwd: String) -> Result<Vec<BranchInfo>, String> {
    branches_in(Path::new(&cwd))
}

/// Lo que traería juntar el piso `id` en `target` (por defecto, la rama actual de la planta
/// baja). No cambia nada.
#[tauri::command(async)]
pub fn floor_land_preview(app: AppHandle, id: String, target: Option<String>) -> Result<LandPreview, String> {
    let floor = find_floor(&id)?;
    let ground = PathBuf::from(&floor.ground);
    let target = match target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(target) => target,
        None => current_branch(&ground)
            .ok_or("A planta baixa está em HEAD solto; escolha a branch de destino.")?,
    };
    let managed = managed_mounts(&floor.cwd, &skills_dir(&app)?);
    preview_of(&floor, &ground, &target, &managed)
}

/// Junta el piso `id` en `target` con un `merge --no-ff`. Con `discard_floor` descarta el
/// piso después de juntarlo; la rama solo se borra con `delete_branch` y si la creó la app.
#[tauri::command(async)]
pub fn floor_land(
    app: AppHandle,
    id: String,
    target: String,
    delete_branch: bool,
    discard_floor: bool,
) -> Result<LandResult, String> {
    let floor = find_floor(&id)?;
    let ground = PathBuf::from(&floor.ground);
    let skills = skills_dir(&app)?;
    let managed_floor = managed_mounts(&floor.cwd, &skills);
    let managed_ground = managed_mounts(&floor.ground, &skills);

    let commits = check_land(&floor, &ground, &target, &managed_floor, &managed_ground)?;
    merge_into(&ground, &floor.branch, &target)?;
    let mut result = LandResult { merged: true, commits, branch_deleted: false, floor_removed: false };

    if discard_floor {
        // Ya está juntado: el descarte no vuelve a mirar el merge, solo el worktree.
        let dropped = floors::remove_with(&id, &skills, !delete_branch).map_err(|e| {
            format!("Juntado em {target}, mas não foi possível descartar o andar: {e}")
        })?;
        result.floor_removed = true;
        result.branch_deleted = delete_branch && !dropped.branch_kept;
        let _ = app.emit(floors::CHANGED_EVENT, &id);
    }
    Ok(result)
}

#[cfg(test)]
mod test {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    /// Un repo temporal con un commit en su rama inicial, que se borra al salir.
    struct Fixture {
        scratch: PathBuf,
        repo: PathBuf,
        base: String,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let scratch = std::env::temp_dir().join(format!("ags-land-{tag}-{}", Uuid::new_v4().simple()));
            let repo = scratch.join("repo");
            fs::create_dir_all(&repo).unwrap();
            git_t(&repo, &["init", "--quiet"]);
            git_t(&repo, &["config", "user.name", "ADE AGS tests"]);
            git_t(&repo, &["config", "user.email", "tests@ags.local"]);
            fs::write(repo.join("README.md"), "linha 1\n").unwrap();
            git_t(&repo, &["add", "README.md"]);
            git_t(&repo, &["commit", "--quiet", "-m", "base"]);
            let base = git_t(&repo, &["symbolic-ref", "--short", "HEAD"]);
            Self { scratch, repo, base }
        }

        /// Un worktree en `<scratch>/<name>`, sobre una rama nueva partiendo de HEAD.
        fn floor(&self, name: &str, branch: &str) -> Floor {
            let root = self.scratch.join(name);
            git_t(&self.repo, &["worktree", "add", "-b", branch, &root.to_string_lossy(), "HEAD"]);
            Floor {
                id: format!("id-{name}"),
                name: name.into(),
                ground: self.repo.to_string_lossy().into(),
                cwd: root.to_string_lossy().into(),
                root: root.to_string_lossy().into(),
                branch: branch.into(),
                excluded: Vec::new(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.scratch);
        }
    }

    fn git_t(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// Lee un archivo con fines de línea `\n`: con autocrlf en Windows git lo deja en `\r\n`.
    fn read_lf(path: &Path) -> String {
        fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn commit_file(dir: &Path, file: &str, body: &str, msg: &str) {
        fs::write(dir.join(file), body).unwrap();
        git_t(dir, &["add", file]);
        git_t(dir, &["commit", "--quiet", "-m", msg]);
    }

    #[test]
    fn el_numstat_cuenta_archivos_lineas_y_binarios() {
        assert_eq!(parse_numstat("3\t0\ta.txt\n-\t-\timg.png\n10\t4\tsrc/b.rs\n"), (3, 13, 4));
        assert_eq!(parse_numstat(""), (0, 0, 0));
    }

    #[test]
    fn los_conflictos_salen_de_la_salida_de_merge_tree_sin_la_primera_linea() {
        assert_eq!(parse_conflicted_names("0123abcd\nREADME.md\nsrc/a b.rs\n"), vec!["README.md", "src/a b.rs"]);
        assert!(parse_conflicted_names("0123abcd\n").is_empty());
    }

    #[test]
    fn el_porcelain_de_worktrees_da_ruta_y_rama_y_los_sueltos_no_tienen_rama() {
        let out = "worktree C:/repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree C:/wt/a\nHEAD 2222\nbranch refs/heads/cc/a\n\nworktree C:/wt/suelto\nHEAD 3333\ndetached\n";
        let found = worktrees::parse_worktree_porcelain(out);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0], (PathBuf::from("C:/repo"), Some("main".to_string())));
        assert_eq!(found[1].1.as_deref(), Some("cc/a"));
        assert_eq!(found[2], (PathBuf::from("C:/wt/suelto"), None));
    }

    #[test]
    fn un_nombre_de_rama_con_guion_se_rechaza() {
        assert!(check_branch_arg("--upload-pack=evil").is_err());
        assert!(check_branch_arg("   ").is_err());
        assert_eq!(check_branch_arg(" cc/a ").unwrap(), "cc/a");
    }

    #[test]
    fn la_lista_de_ramas_marca_la_actual_y_las_abiertas_en_otro_worktree() {
        let fx = Fixture::new("branches");
        git_t(&fx.repo, &["branch", "libre"]);
        git_t(&fx.repo, &["branch", "ocupada"]);
        let wt = fx.scratch.join("wt");
        git_t(&fx.repo, &["worktree", "add", &wt.to_string_lossy(), "ocupada"]);

        let list = branches_in(&fx.repo).unwrap();
        let find = |n: &str| list.iter().find(|b| b.name == n).unwrap().clone();
        assert!(find(fx.base.as_str()).current);
        assert!(!find(fx.base.as_str()).in_use);
        assert!(!find("libre").current && !find("libre").in_use);
        assert!(find("ocupada").in_use, "{list:?}");
    }

    #[test]
    fn la_vista_previa_cuenta_commits_archivos_y_lineas() {
        let fx = Fixture::new("preview");
        let floor = fx.floor("piso", "cc/piso");
        let wt = PathBuf::from(&floor.root);
        commit_file(&wt, "a.txt", "1\n2\n3\n", "agrega a");
        commit_file(&wt, "b.txt", "x\n", "agrega b");

        let preview = preview_of(&floor, &fx.repo, &fx.base, &[]).unwrap();
        assert_eq!(preview.ahead, 2);
        assert_eq!(preview.behind, 0);
        assert_eq!((preview.files_changed, preview.insertions, preview.deletions), (2, 4, 0));
        assert!(!preview.dirty);
        assert!(preview.conflicts_checked, "git de esta máquina tiene merge-tree");
        assert!(preview.conflicts.is_empty());
        assert_eq!(preview.commits.len(), 2);
        assert_eq!(preview.commits[0].subject, "agrega b", "el más nuevo primero");
        assert_eq!(preview.commits[0].sha.len(), 7);
    }

    #[test]
    fn la_vista_previa_marca_sucio_al_piso_con_cambios_sin_commit() {
        let fx = Fixture::new("dirty-preview");
        let floor = fx.floor("piso", "cc/sucio");
        fs::write(Path::new(&floor.root).join("nuevo.txt"), "sin commit\n").unwrap();
        assert!(preview_of(&floor, &fx.repo, &fx.base, &[]).unwrap().dirty);
    }

    #[test]
    fn juntar_limpio_trae_el_trabajo_del_piso_a_la_planta_baja() {
        let fx = Fixture::new("land");
        let floor = fx.floor("piso", "cc/limpio");
        commit_file(Path::new(&floor.root), "a.txt", "a\n", "agrega a");

        let commits = check_land(&floor, &fx.repo, &fx.base, &[], &[]).unwrap();
        assert_eq!(commits, 1);
        merge_into(&fx.repo, &floor.branch, &fx.base).unwrap();
        assert_eq!(read_lf(&fx.repo.join("a.txt")), "a\n");
        assert!(git_t(&fx.repo, &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn no_se_junta_con_cambios_sin_commit_en_el_piso() {
        let fx = Fixture::new("dirty-floor");
        let floor = fx.floor("piso", "cc/sucio2");
        fs::write(Path::new(&floor.root).join("a.txt"), "sin commit\n").unwrap();
        let err = check_land(&floor, &fx.repo, &fx.base, &[], &[]).unwrap_err();
        assert!(err.contains("a.txt") && err.contains("sem commit"), "{err}");
    }

    #[test]
    fn no_se_junta_con_cambios_sin_commit_en_la_planta_baja() {
        let fx = Fixture::new("dirty-ground");
        let floor = fx.floor("piso", "cc/limpio2");
        fs::write(fx.repo.join("local.txt"), "sin commit\n").unwrap();
        let err = check_land(&floor, &fx.repo, &fx.base, &[], &[]).unwrap_err();
        assert!(err.contains("planta baixa") && err.contains("local.txt"), "{err}");
    }

    #[test]
    fn si_la_planta_baja_esta_en_otra_rama_dice_que_checkout_hacer() {
        let fx = Fixture::new("other-branch");
        let floor = fx.floor("piso", "cc/otra");
        git_t(&fx.repo, &["checkout", "-q", "-b", "trabajo"]);
        let err = check_land(&floor, &fx.repo, &fx.base, &[], &[]).unwrap_err();
        assert!(err.contains("'trabajo'") && err.contains(&format!("git checkout {}", fx.base)), "{err}");
    }

    #[test]
    fn un_conflicto_se_aborta_y_la_planta_baja_queda_limpia() {
        let fx = Fixture::new("conflict");
        let floor = fx.floor("piso", "cc/choque");
        commit_file(Path::new(&floor.root), "README.md", "linha 1\ndo piso\n", "piso");
        commit_file(&fx.repo, "README.md", "linha 1\nda planta\n", "planta");

        let preview = preview_of(&floor, &fx.repo, &fx.base, &[]).unwrap();
        assert_eq!(preview.conflicts, vec!["README.md".to_string()]);

        check_land(&floor, &fx.repo, &fx.base, &[], &[]).unwrap();
        let err = merge_into(&fx.repo, &floor.branch, &fx.base).unwrap_err();
        assert!(err.contains("README.md") && err.contains("Nada foi juntado"), "{err}");
        assert!(git_t(&fx.repo, &["status", "--porcelain"]).is_empty(), "sin restos del merge");
        assert!(git(&fx.repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err());
        assert_eq!(read_lf(&fx.repo.join("README.md")), "linha 1\nda planta\n");
    }

    #[test]
    fn un_worktree_sobre_una_rama_existente_se_niega_si_ya_esta_abierta() {
        let fx = Fixture::new("existing");
        git_t(&fx.repo, &["branch", "existente"]);
        let base_dir = fx.scratch.join("worktrees");

        let wt = worktrees::create_on_branch(&base_dir, &fx.repo, "existente").unwrap();
        assert_eq!(wt.branch, "existente");
        let err = worktrees::create_on_branch(&base_dir, &fx.repo, "existente").unwrap_err();
        assert!(err.contains("já está aberta"), "{err}");

        let err = worktrees::create_on_branch(&base_dir, &fx.repo, "no-existe").unwrap_err();
        assert!(err.contains("Não existe a branch"), "{err}");

        // Quitarlo no borra una rama que era del usuario.
        worktrees::remove_with_branch(&fx.repo, &wt, Path::new(""), Path::new(""), false).unwrap();
        assert!(git(&fx.repo, &["rev-parse", "--verify", "--quiet", "refs/heads/existente"]).is_ok());
    }
}
