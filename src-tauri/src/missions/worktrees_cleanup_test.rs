//! Fixtures de repositórios git temporários para limpeza de worktrees (Etapa 21, item 7b).
//!
//! Casos cobertos:
//! 1. `dry-run`: inspeciona sem remover diretórios ou ramos do git.
//! 2. `alterações não commitadas`: detecta modificações rastreadas e arquivos novos, impedindo perda de dados.
//! 3. `commits fora do master`: detecta commits exclusivos na branch e preserva o ramo.
//! 4. `junction node_modules`: remove o link/junction sem apagar o conteúdo da pasta compartilhada no repo principal.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct TempRepo {
    root: PathBuf,
}

impl TempRepo {
    fn new(prefix: &str) -> Self {
        let root = std::env::temp_dir().join(format!("ade-test-{prefix}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&root).expect("cria pasta temp");
        let r = Self { root };
        r.git(&["init", "-q", "-b", "master"]);
        fs::write(r.root.join("README.md"), "# Base\n").unwrap();
        fs::write(r.root.join(".gitignore"), "node_modules/\n").unwrap();
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "commit inicial master"]);
        r
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.root, args)
    }

    fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=ADE Test", "-c", "user.email=test@localhost"])
            .args(args)
            .output()
            .expect("executa git");
        assert!(out.status.success(), "git {:?} falhou: {}", args, String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug, PartialEq)]
enum CleanupAction {
    DeleteWorktreeAndBranch,
    DeleteWorktreeKeepBranch,
    SkipDirty(Vec<String>),
}

fn inspect_worktree(repo: &TempRepo, wt_path: &Path, master: &str) -> (CleanupAction, String) {
    let branch = repo.git_in(wt_path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let status = repo.git_in(wt_path, &["status", "--porcelain", "-z"]);
    let dirty_files: Vec<String> = status
        .split('\0')
        .filter(|s| s.len() > 3)
        .map(|s| s[3..].to_string())
        // O link node_modules do worktree (junction/symlink) não conta como alteração: o projeto o ignora.
        .filter(|file| file != "node_modules")
        .collect();

    if !dirty_files.is_empty() {
        return (CleanupAction::SkipDirty(dirty_files), branch);
    }

    let commits_ahead: usize = repo
        .git(&["rev-list", &format!("{master}..{branch}"), "--count"])
        .parse()
        .unwrap_or(0);

    if commits_ahead > 0 {
        (CleanupAction::DeleteWorktreeKeepBranch, branch)
    } else {
        (CleanupAction::DeleteWorktreeAndBranch, branch)
    }
}

#[test]
fn fixture_worktree_cleanup_dry_run_preserva_arquivos_e_ramos() {
    let repo = TempRepo::new("dry-run");
    let wt_clean = repo.root.parent().unwrap().join(format!("wt-clean-{}", uuid::Uuid::new_v4().simple()));
    repo.git(&["worktree", "add", "-b", "branch-clean", &wt_clean.to_string_lossy(), "master"]);

    // Dry-run: inspeciona sem alterar nada no disco
    let (action, branch) = inspect_worktree(&repo, &wt_clean, "master");
    assert_eq!(action, CleanupAction::DeleteWorktreeAndBranch);
    assert_eq!(branch, "branch-clean");

    // No dry-run, a pasta e a branch continuam existindo
    assert!(wt_clean.exists());
    assert!(repo.git(&["branch", "--list", "branch-clean"]).contains("branch-clean"));

    // Cleanup
    let _ = repo.git(&["worktree", "remove", "--force", &wt_clean.to_string_lossy()]);
    let _ = fs::remove_dir_all(&wt_clean);
}

#[test]
fn fixture_worktree_cleanup_alteracoes_nao_commitadas_bloqueiam_remocao() {
    let repo = TempRepo::new("dirty");
    let wt_dirty = repo.root.parent().unwrap().join(format!("wt-dirty-{}", uuid::Uuid::new_v4().simple()));
    repo.git(&["worktree", "add", "-b", "branch-dirty", &wt_dirty.to_string_lossy(), "master"]);

    // Modifica arquivo rastreado e adiciona arquivo não rastreado
    fs::write(wt_dirty.join("README.md"), "edição não commitada\n").unwrap();
    fs::write(wt_dirty.join("novo.txt"), "conteúdo sem commit\n").unwrap();

    let (action, _branch) = inspect_worktree(&repo, &wt_dirty, "master");
    match action {
        CleanupAction::SkipDirty(files) => {
            assert!(files.contains(&"README.md".to_string()));
            assert!(files.contains(&"novo.txt".to_string()));
        }
        other => panic!("esperava SkipDirty, obteve {other:?}"),
    }

    // Garante que os arquivos continuam intactos no worktree
    assert!(wt_dirty.join("README.md").exists());
    assert!(wt_dirty.join("novo.txt").exists());

    // Cleanup
    let _ = repo.git_in(&wt_dirty, &["checkout", "--", "."]);
    let _ = repo.git(&["worktree", "remove", "--force", &wt_dirty.to_string_lossy()]);
    let _ = fs::remove_dir_all(&wt_dirty);
}

#[test]
fn fixture_worktree_cleanup_commits_fora_do_master_preservam_branch() {
    let repo = TempRepo::new("unmerged");
    let wt_unmerged = repo.root.parent().unwrap().join(format!("wt-unmerged-{}", uuid::Uuid::new_v4().simple()));
    repo.git(&["worktree", "add", "-b", "branch-feature", &wt_unmerged.to_string_lossy(), "master"]);

    // Commita alteração própria na branch do worktree
    fs::write(wt_unmerged.join("feature.rs"), "pub fn nova() {}\n").unwrap();
    repo.git_in(&wt_unmerged, &["add", "feature.rs"]);
    repo.git_in(&wt_unmerged, &["commit", "-q", "-m", "commit da feature"]);

    let (action, branch) = inspect_worktree(&repo, &wt_unmerged, "master");
    assert_eq!(action, CleanupAction::DeleteWorktreeKeepBranch);
    assert_eq!(branch, "branch-feature");

    // Remove apenas o worktree, preservando a branch
    repo.git(&["worktree", "remove", "--force", &wt_unmerged.to_string_lossy()]);
    assert!(!wt_unmerged.exists());

    // A branch deve continuar registrada no repositório com seu commit
    assert!(repo.git(&["branch", "--list", "branch-feature"]).contains("branch-feature"));
    assert_eq!(repo.git(&["log", "-n", "1", "--format=%s", "branch-feature"]), "commit da feature");
}

#[test]
fn fixture_worktree_cleanup_junction_node_modules_preserva_conteudo_base() {
    let repo = TempRepo::new("junction");
    let shared_nm = repo.root.join("node_modules");
    fs::create_dir_all(shared_nm.join("@shared")).unwrap();
    fs::write(shared_nm.join("package.json"), "{\"name\": \"shared-deps\"}\n").unwrap();
    fs::write(shared_nm.join("@shared/core.js"), "console.log('intacto');\n").unwrap();

    let wt_path = repo.root.parent().unwrap().join(format!("wt-junc-{}", uuid::Uuid::new_v4().simple()));
    repo.git(&["worktree", "add", "-b", "branch-junc", &wt_path.to_string_lossy(), "master"]);

    let wt_nm = wt_path.join("node_modules");

    #[cfg(windows)]
    crate::skills::junction_dir(&shared_nm, &wt_nm).expect("cria junction no windows");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&shared_nm, &wt_nm).expect("cria symlink no unix");

    // Verifica que o junction existe e reflete os arquivos
    assert!(wt_nm.join("package.json").exists());
    assert!(wt_nm.join("@shared/core.js").exists());

    // Status deve ser limpo (node_modules ignorado pelo git)
    let (action, _branch) = inspect_worktree(&repo, &wt_path, "master");
    assert_eq!(action, CleanupAction::DeleteWorktreeAndBranch);

    // Remove o link seguro antes ou durante a exclusão do worktree
    #[cfg(windows)]
    let _ = fs::remove_dir(&wt_nm); // No windows, remove_dir em junction apaga APENAS o link

    #[cfg(unix)]
    let _ = fs::remove_file(&wt_nm); // No unix, remove_file em symlink apaga o link

    repo.git(&["worktree", "remove", "--force", &wt_path.to_string_lossy()]);
    let _ = fs::remove_dir_all(&wt_path);

    // CRÍTICO: o diretório original compartilhado e todos os arquivos internos continuam INTACTOS
    assert!(shared_nm.exists(), "shared node_modules deve existir");
    assert!(shared_nm.join("package.json").exists(), "package.json deve continuar intacto");
    assert!(shared_nm.join("@shared/core.js").exists(), "core.js deve continuar intacto");
    assert_eq!(fs::read_to_string(shared_nm.join("package.json")).unwrap(), "{\"name\": \"shared-deps\"}\n");
}
