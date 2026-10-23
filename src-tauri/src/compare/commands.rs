//! Os comandos da comparação de modelos. Cada um tem um núcleo que recebe as pastas (registro e
//! worktrees) por parâmetro, para os testes rodarem em repositórios temporários sem tocar `~/.ags`.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::git::{entry_diff, entry_status, finish_entry, remove_entry, DiffView, EntryStatus, FinishReport, RemoveEntry};
use super::model::{branch_for, read_registry, title_slug, validate_picks, write_registry, CompareEntry, ComparePick, Comparison};

/// Serializa quem lê e grava o registro (e cria ou remove worktrees de comparação).
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn home() -> Result<PathBuf, String> {
    crate::util::datadir::ags_home().ok_or_else(|| "Pasta de dados indisponível.".to_string())
}

fn registry_path() -> Result<PathBuf, String> {
    Ok(home()?.join("comparisons.json"))
}

/// A mesma pasta dos worktrees das missões (`~/.ags/worktrees`, ou a de `ADE_AGS_DATA_DIR`).
fn worktrees_base() -> Result<PathBuf, String> {
    Ok(home()?.join("worktrees"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheck {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// Mudanças sem commit na pasta: não entram nos worktrees.
    pub dirty: usize,
    pub error: Option<String>,
}

pub fn check_repo(cwd: &Path) -> RepoCheck {
    match crate::runs::worktrees::repo_root(cwd) {
        Ok(repo) => {
            let g = |args: &[&str]| crate::runs::worktrees::git(&repo, args, std::time::Duration::from_secs(15)).ok();
            RepoCheck {
                branch: g(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                head: g(&["rev-parse", "--short", "HEAD"]),
                dirty: g(&["status", "--porcelain"]).map(|o| o.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0),
                repo: Some(repo.to_string_lossy().into_owned()),
                error: None,
            }
        }
        Err(e) => RepoCheck { repo: None, branch: None, head: None, dirty: 0, error: Some(e) },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub pick: String,
    /// O comando que fixa o `CARGO_TARGET_DIR` antes do agente (só com isolamento).
    pub prelaunch: Option<String>,
    pub environment: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub comparison: Comparison,
    pub setups: Vec<Setup>,
}

/// Node_modules, target de cargo e o bloco de ambiente do worktree, como nas missões.
fn setup_for(repo: &Path, root: &Path, pick: &str) -> Setup {
    let node_modules = crate::floors::prepare_node_modules_link(repo, root)
        .map(|s| s.description().to_string())
        .unwrap_or_else(|e| format!("indisponível: {e}"));
    let configured = std::env::var_os(crate::floors::CARGO_TARGET_DIR_SETTING);
    let target = crate::floors::cargo_target_dir(repo, root, configured.as_deref());
    let cargo = target.path.to_string_lossy().into_owned();
    let (shell, label) = crate::floors::worktree_shell();
    let root_s = root.to_string_lossy().into_owned();
    let environment = crate::floors::worktree_environment_block(&root_s, &cargo, &label, shell, &node_modules, target.mode)
        + &crate::testspeed::project::environment_note(&crate::testspeed::project::detect(root));
    Setup { pick: pick.into(), prelaunch: Some(crate::floors::cargo_target_prelaunch(&target.path)), environment }
}

/// Cria a comparação: um worktree e uma branch `cmp/<slug>-<id>/<pick>` por escolha, todos a
/// partir do commit atual da pasta. Se um falha, os já criados (ainda limpos) são removidos.
pub fn prepare_in(registry: &Path, base: &Path, cwd: &Path, title: &str, picks: &[ComparePick], isolate: bool, id: &str) -> Result<Prepared, String> {
    validate_picks(picks)?;
    if !cwd.is_dir() {
        return Err(format!("A pasta não existe: {}", cwd.display()));
    }
    let title = title.trim();
    if title.chars().count() > 120 {
        return Err("O título deve ter até 120 caracteres.".into());
    }
    let slug = title_slug(title);
    let cwd_s = cwd.to_string_lossy().into_owned();
    let repo = crate::runs::worktrees::repo_root(cwd);
    let mut comparison = Comparison {
        id: id.into(),
        title: if title.is_empty() { slug.clone() } else { title.into() },
        slug: slug.clone(),
        cwd: cwd_s.clone(),
        repo: repo.as_ref().ok().map(|r| r.to_string_lossy().into_owned()),
        base: repo.as_ref().ok().and_then(|r| crate::runs::worktrees::head_commit(r)),
        isolated: isolate,
        created_at: crate::util::now_ts(),
        kept: None,
        entries: Vec::new(),
    };
    let setups;
    if isolate {
        let repo = repo?;
        let start = comparison.base.clone().ok_or("O repositório ainda não tem nenhum commit.")?;
        let results: Vec<Result<CompareEntry, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = picks
                .iter()
                .map(|p| {
                    let (start, slug) = (start.as_str(), slug.as_str());
                    scope.spawn(move || {
                        let branch = branch_for(slug, id, &p.pick);
                        let mut last = crate::runs::worktrees::create_named(base, cwd, &branch, start);
                        for wait in [150u64, 400, 900, 1800] {
                            match &last {
                                Err(e) if crate::missions::team::is_transient_git_error(e) => {
                                    std::thread::sleep(std::time::Duration::from_millis(wait));
                                    last = crate::runs::worktrees::create_named(base, cwd, &branch, start);
                                }
                                _ => break,
                            }
                        }
                        last.map(|wt| {
                            crate::runs::worktrees::record_base(&wt.root, &wt.branch, start);
                            CompareEntry {
                                pick: p.pick.clone(),
                                label: p.label.trim().into(),
                                agent_id: p.agent_id.clone(),
                                cwd: wt.task_cwd.to_string_lossy().into_owned(),
                                root: Some(wt.root.to_string_lossy().into_owned()),
                                branch: Some(wt.branch),
                                tab_id: None,
                            }
                        })
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("Falha ao criar o worktree.".into()))).collect()
        });
        let failure = results.iter().find_map(|r| r.as_ref().err().cloned());
        let created: Vec<CompareEntry> = results.into_iter().filter_map(Result::ok).collect();
        if let Some(error) = failure {
            for entry in &created {
                let _ = remove_entry(&repo, base, id, entry, &start, false, false);
            }
            return Err(error);
        }
        setups = created.iter().map(|e| setup_for(&repo, Path::new(e.root.as_deref().unwrap_or_default()), &e.pick)).collect();
        comparison.entries = created;
    } else {
        comparison.entries = picks
            .iter()
            .map(|p| CompareEntry { pick: p.pick.clone(), label: p.label.trim().into(), agent_id: p.agent_id.clone(), cwd: cwd_s.clone(), root: None, branch: None, tab_id: None })
            .collect();
        setups = picks.iter().map(|p| Setup { pick: p.pick.clone(), prelaunch: None, environment: String::new() }).collect();
    }
    let mut all = read_registry(registry);
    all.push(comparison.clone());
    write_registry(registry, &all)?;
    Ok(Prepared { comparison, setups })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabLink {
    pub pick: String,
    pub tab_id: String,
}

fn update<T>(registry: &Path, id: &str, f: impl FnOnce(&mut Comparison) -> Result<T, String>) -> Result<T, String> {
    let mut all = read_registry(registry);
    let cmp = all.iter_mut().find(|c| c.id == id).ok_or("Essa comparação já não existe.")?;
    let out = f(cmp)?;
    write_registry(registry, &all)?;
    Ok(out)
}

pub fn attach_in(registry: &Path, id: &str, tabs: &[TabLink]) -> Result<Comparison, String> {
    update(registry, id, |cmp| {
        for link in tabs {
            if let Some(entry) = cmp.entries.iter_mut().find(|e| e.pick == link.pick) {
                entry.tab_id = Some(link.tab_id.clone());
            }
        }
        Ok(cmp.clone())
    })
}

pub fn keep_in(registry: &Path, id: &str, pick: &str) -> Result<Comparison, String> {
    update(registry, id, |cmp| {
        if !cmp.isolated {
            return Err("Sem isolamento não há branch para manter.".into());
        }
        if !cmp.entries.iter().any(|e| e.pick == pick) {
            return Err("Esse modelo não está na comparação.".into());
        }
        cmp.kept = Some(pick.into());
        Ok(cmp.clone())
    })
}

fn find(registry: &Path, id: &str) -> Result<Comparison, String> {
    read_registry(registry).into_iter().find(|c| c.id == id).ok_or_else(|| "Essa comparação já não existe.".into())
}

pub fn status_in(registry: &Path, id: &str) -> Result<Vec<EntryStatus>, String> {
    let cmp = find(registry, id)?;
    let base = cmp.base.clone().unwrap_or_else(|| "HEAD".into());
    Ok(cmp.entries.iter().map(|e| entry_status(e, &base)).collect())
}

pub fn diff_in(registry: &Path, id: &str, pick: &str) -> Result<DiffView, String> {
    let cmp = find(registry, id)?;
    let entry = cmp.entries.iter().find(|e| e.pick == pick).ok_or("Esse modelo não está na comparação.")?;
    entry_diff(entry, cmp.base.as_deref().unwrap_or("HEAD"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReport {
    pub dry_run: bool,
    pub entries: Vec<RemoveEntry>,
    /// A comparação acabou (não sobrou nenhum agente) e saiu do registro.
    pub closed: bool,
}

/// Remove os agentes `picks` da comparação (worktree e branch). Nunca o que o usuário manteve.
pub fn remove_in(registry: &Path, base: &Path, id: &str, picks: &[String], discard: bool, dry_run: bool) -> Result<RemoveReport, String> {
    let cmp = find(registry, id)?;
    if cmp.kept.as_deref().is_some_and(|k| picks.iter().any(|p| p == k)) {
        return Err("O modelo mantido não é removido por aqui: use Encerrar.".into());
    }
    let repo = cmp.repo.as_deref().map(PathBuf::from);
    let start = cmp.base.clone().unwrap_or_else(|| "HEAD".into());
    let mut entries = Vec::new();
    for pick in picks {
        let entry = cmp.entries.iter().find(|e| &e.pick == pick).ok_or("Esse modelo não está na comparação.")?;
        let report = match (&repo, cmp.isolated) {
            (Some(repo), true) => remove_entry(repo, base, &cmp.id, entry, &start, discard, dry_run),
            (None, true) => RemoveEntry { pick: pick.clone(), blockers: vec!["repositório da comparação indisponível".into()], ..Default::default() },
            (_, false) => RemoveEntry { pick: pick.clone(), removed: !dry_run, ..Default::default() },
        };
        entries.push(report);
    }
    let mut closed = false;
    if !dry_run {
        let removed: Vec<&str> = entries.iter().filter(|e| e.removed).map(|e| e.pick.as_str()).collect();
        let mut all = read_registry(registry);
        if let Some(c) = all.iter_mut().find(|c| c.id == id) {
            c.entries.retain(|e| !removed.contains(&e.pick.as_str()));
            closed = c.entries.is_empty();
        }
        all.retain(|c| !c.entries.is_empty());
        write_registry(registry, &all)?;
    }
    Ok(RemoveReport { dry_run, entries, closed })
}

/// Encerra a comparação a partir do modelo mantido: o worktree dele sai, a branch fica. Os
/// outros já precisam ter sido removidos. Sem isolamento, só esquece a comparação.
pub fn finish_in(registry: &Path, base: &Path, id: &str, commit_pending: bool, dry_run: bool) -> Result<FinishReport, String> {
    let cmp = find(registry, id)?;
    let report = if cmp.isolated {
        let kept = cmp.kept.clone().ok_or("Escolha antes qual modelo manter.")?;
        if cmp.entries.iter().any(|e| e.pick != kept) {
            return Err("Remova antes os outros modelos da comparação.".into());
        }
        let entry = cmp.entries.iter().find(|e| e.pick == kept).ok_or("O modelo mantido não está mais na comparação.")?;
        let repo = cmp.repo.as_deref().map(PathBuf::from).ok_or("Repositório da comparação indisponível.")?;
        finish_entry(base, &repo, entry, commit_pending, dry_run)
    } else {
        FinishReport { pick: String::new(), removed: !dry_run, ..Default::default() }
    };
    if !dry_run && report.removed {
        let mut all = read_registry(registry);
        all.retain(|c| c.id != id);
        write_registry(registry, &all)?;
    }
    Ok(report)
}

// ── Comandos Tauri ──────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn compare_check(cwd: String) -> Result<RepoCheck, String> {
    blocking(move || Ok(check_repo(Path::new(&cwd)))).await
}

#[tauri::command]
pub async fn compare_prepare(
    db: tauri::State<'_, crate::database::DbConnection>,
    cwd: String,
    title: String,
    picks: Vec<ComparePick>,
    isolate: bool,
) -> Result<Prepared, String> {
    let db = db.inner().clone();
    blocking(move || {
        let _guard = lock();
        let base = worktrees_base()?;
        if isolate {
            // O diálogo "confia nesta pasta?" do Claude Code travaria cada terminal da comparação.
            crate::missions::team::trust_claude_worktrees(&db, &base);
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        prepare_in(&registry_path()?, &base, Path::new(&cwd), &title, &picks, isolate, &id)
    })
    .await
}

// Nada aqui roda na thread principal: uma preparação segura o `LOCK` por segundos (checkout de
// vários worktrees) e um comando síncrono esperando por ele congelaria a janela.

#[tauri::command]
pub async fn compare_attach(id: String, tabs: Vec<TabLink>) -> Result<Comparison, String> {
    blocking(move || {
        let _guard = lock();
        attach_in(&registry_path()?, &id, &tabs)
    })
    .await
}

/// Sem o `LOCK`: o registro é gravado por troca atômica (`rename`), então a leitura nunca vê meio arquivo.
#[tauri::command]
pub async fn compare_list() -> Result<Vec<Comparison>, String> {
    blocking(move || Ok(read_registry(&registry_path()?))).await
}

#[tauri::command]
pub async fn compare_status(id: String) -> Result<Vec<EntryStatus>, String> {
    blocking(move || {
        let registry = registry_path()?;
        status_in(&registry, &id)
    })
    .await
}

#[tauri::command]
pub async fn compare_diff(id: String, pick: String) -> Result<DiffView, String> {
    blocking(move || diff_in(&registry_path()?, &id, &pick)).await
}

#[tauri::command]
pub async fn compare_keep(id: String, pick: String) -> Result<Comparison, String> {
    blocking(move || {
        let _guard = lock();
        keep_in(&registry_path()?, &id, &pick)
    })
    .await
}

#[tauri::command]
pub async fn compare_remove(id: String, picks: Vec<String>, discard: bool, dry_run: bool) -> Result<RemoveReport, String> {
    blocking(move || {
        let _guard = lock();
        remove_in(&registry_path()?, &worktrees_base()?, &id, &picks, discard, dry_run)
    })
    .await
}

#[tauri::command]
pub async fn compare_finish(id: String, commit_pending: bool, dry_run: bool) -> Result<FinishReport, String> {
    blocking(move || {
        let _guard = lock();
        finish_in(&registry_path()?, &worktrees_base()?, &id, commit_pending, dry_run)
    })
    .await
}
