//! O git da comparação: criar os worktrees, medir o que cada agente mudou, mostrar o diff e
//! limpar. A limpeza segue as travas de `missions::cleanup`: caminho contido na pasta dos
//! worktrees, branch `cmp/` conferida, links do app (node_modules, skills) desfeitos antes, e
//! NADA de `--force`. Trabalho sem commit ou commits da branch só saem com `discard` (o usuário
//! confirmou vendo a lista), e mesmo assim ficam guardados numa ref de descarte recuperável.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::runs::worktrees::git;

use super::model::{trash_ref_for, truncate_utf8, CompareEntry, BRANCH_ROOT};

const FAST: Duration = Duration::from_secs(15);
const SLOW: Duration = Duration::from_secs(120);
/// O diff mostrado na tela; o resto o usuário vê no worktree.
pub const DIFF_LIMIT: usize = 512 * 1024;
/// Esperas para um `worktree remove` que esbarra num arquivo ainda preso pelo terminal recém-fechado.
const REMOVE_BACKOFF_MS: [u64; 4] = [300, 800, 1500, 3000];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryStatus {
    pub pick: String,
    /// Arquivos rastreados que mudaram em relação à base + arquivos novos.
    pub files: usize,
    pub insertions: u64,
    pub deletions: u64,
    pub untracked: usize,
    /// Commits que o agente fez na branch desde a base.
    pub commits: usize,
    /// Há mudanças sem commit.
    pub dirty: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffView {
    pub pick: String,
    pub branch: Option<String>,
    pub base: String,
    pub stat: String,
    pub patch: String,
    pub untracked: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveEntry {
    pub pick: String,
    pub removed: bool,
    /// O que impediu (ou, no ensaio, impediria) a remoção.
    pub blockers: Vec<String>,
    /// Arquivos sem commit no worktree.
    pub dirty: Vec<String>,
    /// Commits da branch que não estão na base (`<hash> <assunto>`).
    pub commits: Vec<String>,
    /// Onde o trabalho descartado ficou guardado (`refs/ags/descartes/<id>/<pick>`).
    pub saved_ref: Option<String>,
    /// A branch ficou (não foi possível apagá-la com segurança).
    pub branch_kept: bool,
    /// Só falta o usuário confirmar o descarte (`discard`); nenhuma trava dura.
    pub needs_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FinishReport {
    pub pick: String,
    pub branch: Option<String>,
    pub removed: bool,
    /// O trabalho sem commit foi commitado na branch antes de remover o worktree.
    pub committed: bool,
    pub blockers: Vec<String>,
    pub dirty: Vec<String>,
    /// Só falta o usuário confirmar o commit do que está sem commit (`commit_pending`).
    pub needs_commit: bool,
}

/// Uma ação de git que pode esbarrar num arquivo preso por um instante (Windows): repete.
fn with_retry(mut op: impl FnMut() -> Result<String, String>) -> Result<String, String> {
    let mut last = op();
    for wait in REMOVE_BACKOFF_MS {
        match &last {
            Err(e) if crate::missions::team::is_transient_git_error(e) => {
                std::thread::sleep(Duration::from_millis(wait));
                last = op();
            }
            _ => break,
        }
    }
    last
}

/// Os arquivos novos (não rastreados e não ignorados), sem os links que o app pôs.
fn untracked(root: &Path, managed: &[PathBuf]) -> Result<Vec<String>, String> {
    let out = git(root, &["ls-files", "--others", "--exclude-standard", "-z"], FAST)?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let abs = root.join(p.trim_end_matches('/'));
            !managed.iter().any(|link| abs == *link || abs.starts_with(link))
        })
        .map(str::to_string)
        .collect())
}

fn commits_ahead(dir: &Path, base: &str, rev: &str) -> Result<Vec<String>, String> {
    let out = git(dir, &["log", "--format=%h %s", "-n", "50", &format!("{base}..{rev}")], FAST)?;
    Ok(out.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// O que um agente mudou desde a base: diff do worktree (commits + sem commit) e arquivos novos.
pub fn entry_status(entry: &CompareEntry, base: &str) -> EntryStatus {
    let mut status = EntryStatus { pick: entry.pick.clone(), files: 0, insertions: 0, deletions: 0, untracked: 0, commits: 0, dirty: false, error: None };
    let Some(root) = entry.root.as_deref().map(Path::new) else {
        status.error = Some("sem isolamento: os agentes dividem a mesma pasta".into());
        return status;
    };
    if !root.is_dir() {
        status.error = Some("o worktree não existe mais".into());
        return status;
    }
    let managed = crate::missions::cleanup::managed(root);
    let result = (|| -> Result<(), String> {
        let numstat = git(root, &["diff", "--numstat", "--no-renames", base], FAST)?;
        let (files, add, del) = super::model::parse_numstat(&numstat);
        let new = untracked(root, &managed)?;
        status.files = files + new.len();
        status.insertions = add;
        status.deletions = del;
        status.untracked = new.len();
        status.commits = git(root, &["rev-list", "--count", &format!("{base}..HEAD")], FAST)?.trim().parse().unwrap_or(0);
        status.dirty = !crate::runs::worktrees::dirty_files(root, &managed)?.is_empty();
        Ok(())
    })();
    if let Err(e) = result {
        status.error = Some(e);
    }
    status
}

/// O diff de um agente contra a base, cortado em `DIFF_LIMIT`.
pub fn entry_diff(entry: &CompareEntry, base: &str) -> Result<DiffView, String> {
    let root = entry.root.as_deref().map(Path::new).ok_or("Sem isolamento: não há diff por agente.")?;
    if !root.is_dir() {
        return Err("O worktree não existe mais.".into());
    }
    let managed = crate::missions::cleanup::managed(root);
    let stat = git(root, &["diff", "--stat", "--no-color", base], FAST)?;
    let patch = git(root, &["diff", "--no-color", "--no-ext-diff", base], SLOW)?;
    let (shown, truncated) = truncate_utf8(&patch, DIFF_LIMIT);
    Ok(DiffView {
        pick: entry.pick.clone(),
        branch: entry.branch.clone(),
        base: base.to_string(),
        stat,
        patch: shown.to_string(),
        untracked: untracked(root, &managed)?,
        truncated,
    })
}

/// Travas que NUNCA se contornam: caminho fora da pasta dos worktrees, branch que não é de
/// comparação ou worktree numa branch diferente da registrada.
fn hard_blockers(base_dir: &Path, root: &Path, branch: &str) -> Vec<String> {
    let mut out = Vec::new();
    let contained = base_dir
        .canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(b, r)| r.starts_with(&b) && r != b);
    if !contained || crate::skills::is_mount(root) {
        out.push("worktree fora da pasta de worktrees do app".into());
        return out;
    }
    if !branch.starts_with(BRANCH_ROOT) || branch.starts_with('-') {
        out.push("branch não é de comparação".into());
        return out;
    }
    match git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], FAST) {
        Ok(actual) if actual == branch => {}
        _ => out.push("o worktree está em outra branch".into()),
    }
    out
}

/// Desfaz os links do app (node_modules, skills) antes de qualquer `add -A` ou `worktree remove`:
/// assim o git nunca atravessa uma junção para a pasta compartilhada.
fn unmount(root: &Path) -> Result<(), String> {
    for link in crate::missions::cleanup::managed(root) {
        crate::skills::remove_mount(&link).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Commita o que está sem commit no worktree. Sem a identidade do usuário configurada, usa a do app.
fn commit_all(root: &Path, message: &str) -> Result<(), String> {
    git(root, &["add", "-A"], SLOW)?;
    if git(root, &["commit", "--no-verify", "--quiet", "-m", message], SLOW).is_ok() {
        return Ok(());
    }
    git(root, &["-c", "user.name=ADE AGS", "-c", "user.email=ade-ags@localhost", "commit", "--no-verify", "--quiet", "-m", message], SLOW)
        .map(|_| ())
}

fn rev(dir: &Path, name: &str) -> Option<String> {
    git(dir, &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")], FAST).ok().filter(|s| !s.is_empty())
}

/// Remove o worktree e a branch de um agente da comparação.
///
/// - Sem `discard`: só remove se não há mudança sem commit nem commit fora da base.
/// - Com `discard` (o usuário confirmou vendo a lista): o que não tem commit é commitado na
///   branch, a ponta da branch é guardada em `refs/ags/descartes/<id>/<pick>` e só então
///   worktree e branch saem. Recuperar: `git branch <nome> refs/ags/descartes/<id>/<pick>`.
/// - `dry_run` só diz o que aconteceria.
pub fn remove_entry(repo: &Path, base_dir: &Path, cmp_id: &str, entry: &CompareEntry, base: &str, discard: bool, dry_run: bool) -> RemoveEntry {
    let mut report = RemoveEntry { pick: entry.pick.clone(), ..Default::default() };
    let (Some(root), Some(branch)) = (entry.root.as_deref().map(Path::new), entry.branch.as_deref()) else {
        // Sem isolamento: não há nada no disco para remover.
        report.removed = !dry_run;
        return report;
    };
    let exists = root.exists();
    if exists {
        report.blockers = hard_blockers(base_dir, root, branch);
        if !report.blockers.is_empty() {
            return report;
        }
        match crate::runs::worktrees::dirty_files(root, &crate::missions::cleanup::managed(root)) {
            Ok(files) => report.dirty = files,
            Err(e) => {
                report.blockers.push(e);
                return report;
            }
        }
    } else if !branch.starts_with(BRANCH_ROOT) {
        report.blockers.push("branch não é de comparação".into());
        return report;
    }
    let tip = rev(repo, &format!("refs/heads/{branch}"));
    if tip.is_some() {
        match commits_ahead(repo, base, &format!("refs/heads/{branch}")) {
            Ok(list) => report.commits = list,
            Err(e) => {
                report.blockers.push(e);
                return report;
            }
        }
    }
    let has_work = !report.dirty.is_empty() || !report.commits.is_empty();
    if has_work && !discard {
        report.blockers.push("há trabalho que seria perdido: confirme o descarte".into());
        report.needs_confirmation = true;
        return report;
    }
    if dry_run {
        return report;
    }

    let outcome = (|| -> Result<(), String> {
        if exists {
            unmount(root)?;
            if !report.dirty.is_empty() {
                commit_all(root, &format!("ags: trabalho descartado da comparação ({})", entry.pick))?;
            }
        }
        // A ponta da branch (com o commit acima, se houve) fica guardada antes de qualquer remoção.
        let tip = rev(repo, &format!("refs/heads/{branch}"));
        if has_work {
            if let Some(sha) = &tip {
                let saved = trash_ref_for(cmp_id, &entry.pick);
                git(repo, &["update-ref", &saved, sha], FAST)?;
                report.saved_ref = Some(saved);
            }
        }
        if exists {
            let root_arg = crate::util::external_path(root).to_string_lossy().into_owned();
            with_retry(|| git(repo, &["worktree", "remove", &root_arg], SLOW))?;
        } else {
            let _ = git(repo, &["worktree", "prune"], FAST);
        }
        report.removed = true;
        if let Some(sha) = tip {
            // CAS: apaga só a ponta que foi inspecionada e guardada.
            if let Err(e) = git(repo, &["update-ref", "-d", &format!("refs/heads/{branch}"), &sha], FAST) {
                report.branch_kept = true;
                report.blockers.push(format!("worktree removido; branch preservada: {e}"));
            }
        }
        Ok(())
    })();
    if let Err(e) = outcome {
        report.blockers.push(e);
    }
    report
}

/// Encerra o agente escolhido: o worktree sai e a BRANCH FICA, com o trabalho. Com mudanças sem
/// commit, só segue com `commit_pending` (o usuário pediu para commitá-las na branch).
pub fn finish_entry(base_dir: &Path, repo: &Path, entry: &CompareEntry, commit_pending: bool, dry_run: bool) -> FinishReport {
    let mut report = FinishReport { pick: entry.pick.clone(), branch: entry.branch.clone(), ..Default::default() };
    let (Some(root), Some(branch)) = (entry.root.as_deref().map(Path::new), entry.branch.as_deref()) else {
        report.removed = !dry_run;
        return report;
    };
    if !root.exists() {
        if !dry_run {
            let _ = git(repo, &["worktree", "prune"], FAST);
            report.removed = true;
        }
        return report;
    }
    report.blockers = hard_blockers(base_dir, root, branch);
    if !report.blockers.is_empty() {
        return report;
    }
    match crate::runs::worktrees::dirty_files(root, &crate::missions::cleanup::managed(root)) {
        Ok(files) => report.dirty = files,
        Err(e) => {
            report.blockers.push(e);
            return report;
        }
    }
    if !report.dirty.is_empty() && !commit_pending {
        report.blockers.push("há mudanças sem commit: confirme o commit na branch".into());
        report.needs_commit = true;
        return report;
    }
    if dry_run {
        return report;
    }
    let outcome = (|| -> Result<(), String> {
        unmount(root)?;
        if !report.dirty.is_empty() {
            commit_all(root, &format!("ags: resultado da comparação ({})", entry.pick))?;
            report.committed = true;
        }
        let root_arg = crate::util::external_path(root).to_string_lossy().into_owned();
        with_retry(|| git(repo, &["worktree", "remove", &root_arg], SLOW))?;
        report.removed = true;
        Ok(())
    })();
    if let Err(e) = outcome {
        report.blockers.push(e);
    }
    report
}
