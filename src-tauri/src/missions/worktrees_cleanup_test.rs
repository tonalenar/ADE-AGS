//! Fixtures de repositórios git temporários para limpeza de worktrees (Etapa 21, item 7b).
//!
//! Casos cobertos testando o código de produção (`crate::missions::cleanup::inspect` e `cleanup`):
//! 1. `dry-run`: inspeciona sem remover diretórios ou ramos do git.
//! 2. `alterações não commitadas`: detecta modificações rastreadas e arquivos novos, impedindo perda de dados.
//! 3. `commits fora do master`: detecta commits exclusivos na branch e preserva o ramo.
//! 4. `junction node_modules`: remove o link/junction sem apagar o conteúdo da pasta compartilhada no repo principal.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use rusqlite::Connection;

struct TempRepo {
    dir: PathBuf,
    root: PathBuf,
    base: PathBuf,
}

impl TempRepo {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ade-test-{prefix}-{}", uuid::Uuid::new_v4().simple()));
        let root = dir.join("repo");
        let base = dir.join("worktrees");
        fs::create_dir_all(&root).expect("cria pasta repo");
        fs::create_dir_all(&base).expect("cria pasta base worktrees");
        let r = Self { dir, root, base };
        r.git(&["init", "-q", "-b", "master"]);
        r.git(&["config", "user.name", "ADE Test"]);
        r.git(&["config", "user.email", "test@localhost"]);
        fs::write(r.root.join("README.md"), "# Base\n").unwrap();
        fs::write(r.root.join(".gitignore"), "node_modules/\n").unwrap();
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "commit inicial master"]);
        r.git(&["update-ref", "refs/remotes/origin/master", "HEAD"]);
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

    fn db(&self, mission_id: &str, wt_path: &Path, branch: &str, status: &str) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE missions(id TEXT,cwd TEXT,status TEXT,integration_path TEXT,integration_branch TEXT);CREATE TABLE mission_team_workspaces(mission_id TEXT,root TEXT,branch TEXT);CREATE TABLE runs(id TEXT,mission_id TEXT);CREATE TABLE tasks(run_id TEXT,worktree_path TEXT,branch TEXT,worktree_removed INTEGER);CREATE TABLE tabs(cwd TEXT);").unwrap();
        c.execute(
            "INSERT INTO missions VALUES (?1,?2,?3,NULL,NULL)",
            rusqlite::params![mission_id, self.root.to_str().unwrap(), status],
        )
        .unwrap();
        c.execute(
            "INSERT INTO mission_team_workspaces VALUES (?1,?2,?3)",
            rusqlite::params![mission_id, wt_path.to_str().unwrap(), branch],
        )
        .unwrap();
        c
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.base) {
            for entry in entries.flatten() {
                let nm = entry.path().join("node_modules");
                if crate::skills::is_mount(&nm) {
                    let _ = crate::skills::remove_mount(&nm);
                }
            }
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn fixture_worktree_cleanup_dry_run_preserva_arquivos_e_ramos() {
    let repo = TempRepo::new("dry-run");
    let wt_clean = repo.base.join("wt-clean");
    repo.git(&["worktree", "add", "-b", "cc/branch-clean", &wt_clean.to_string_lossy(), "master"]);

    // Teste de produção 1: inspect direto do módulo de limpeza
    let inspected = crate::missions::cleanup::inspect(
        &repo.root,
        &repo.base,
        &wt_clean,
        "cc/branch-clean",
        Some("m-dry".into()),
    );
    assert!(inspected.blockers.is_empty(), "não deve haver bloqueios em worktree limpo: {:?}", inspected.blockers);
    assert!(!inspected.removed);
    assert_eq!(inspected.branch, "cc/branch-clean");
    assert!(inspected.size_bytes > 0);

    // Teste de produção 2: cleanup com dry_run = true
    let conn = repo.db("m-dry", &wt_clean, "cc/branch-clean", "done");
    let report = crate::missions::cleanup::cleanup(&conn, "m-dry", &repo.base, true).unwrap();
    assert!(report.dry_run);
    assert_eq!(report.entries.len(), 1);
    assert!(report.entries[0].blockers.is_empty());
    assert!(!report.entries[0].removed, "dry-run nunca deve marcar como removido");

    // No dry-run, a pasta e a branch continuam existindo fisicamente
    assert!(wt_clean.exists(), "worktree deve ser preservado fisicamente em dry-run");
    assert!(repo.git(&["branch", "--list", "cc/branch-clean"]).contains("cc/branch-clean"));

    // Cleanup manual do git worktree
    let _ = repo.git(&["worktree", "remove", "--force", &wt_clean.to_string_lossy()]);
}

#[test]
fn fixture_worktree_cleanup_alteracoes_nao_commitadas_bloqueiam_remocao() {
    let repo = TempRepo::new("dirty");
    let wt_dirty = repo.base.join("wt-dirty");
    repo.git(&["worktree", "add", "-b", "cc/branch-dirty", &wt_dirty.to_string_lossy(), "master"]);

    // Modifica arquivo rastreado e adiciona arquivo não rastreado
    fs::write(wt_dirty.join("README.md"), "edição não commitada\n").unwrap();
    fs::write(wt_dirty.join("novo.txt"), "conteúdo sem commit\n").unwrap();

    // Teste de produção 1: inspect detecta alterações não commitadas
    let inspected = crate::missions::cleanup::inspect(
        &repo.root,
        &repo.base,
        &wt_dirty,
        "cc/branch-dirty",
        Some("m-dirty".into()),
    );
    assert!(!inspected.blockers.is_empty(), "deve haver bloqueio por arquivos sujos");
    assert!(
        inspected.blockers.iter().any(|b| b.contains("alterações não commitadas")),
        "bloqueio deve indicar alterações não commitadas: {:?}",
        inspected.blockers
    );

    // Teste de produção 2: cleanup real (dry_run = false) RECUSA a remoção
    let conn = repo.db("m-dirty", &wt_dirty, "cc/branch-dirty", "done");
    let report = crate::missions::cleanup::cleanup(&conn, "m-dirty", &repo.base, false).unwrap();
    assert!(!report.entries[0].removed, "worktree sujo não deve ser removido");

    // Garante que os arquivos continuam intactos no worktree
    assert!(wt_dirty.join("README.md").exists());
    assert!(wt_dirty.join("novo.txt").exists());
    assert_eq!(fs::read_to_string(wt_dirty.join("novo.txt")).unwrap(), "conteúdo sem commit\n");

    // Cleanup manual
    let _ = repo.git_in(&wt_dirty, &["checkout", "--", "."]);
    let _ = repo.git(&["worktree", "remove", "--force", &wt_dirty.to_string_lossy()]);
}

#[test]
fn fixture_worktree_cleanup_commits_fora_do_master_preservam_branch() {
    let repo = TempRepo::new("unmerged");
    let wt_unmerged = repo.base.join("wt-unmerged");
    repo.git(&["worktree", "add", "-b", "cc/branch-feature", &wt_unmerged.to_string_lossy(), "master"]);

    // Commita alteração própria na branch do worktree
    fs::write(wt_unmerged.join("feature.rs"), "pub fn nova() {}\n").unwrap();
    repo.git_in(&wt_unmerged, &["add", "feature.rs"]);
    repo.git_in(&wt_unmerged, &["commit", "-q", "-m", "commit da feature"]);

    // Teste de produção 1: inspect detecta commits fora de origin/master
    let inspected = crate::missions::cleanup::inspect(
        &repo.root,
        &repo.base,
        &wt_unmerged,
        "cc/branch-feature",
        Some("m-unmerged".into()),
    );
    assert!(
        inspected.blockers.iter().any(|b| b.contains("commits fora de origin/master")),
        "deve bloquear devido a commits não integrados: {:?}",
        inspected.blockers
    );

    // Teste de produção 2: cleanup recusa mutação quando há bloqueio de commits
    let conn = repo.db("m-unmerged", &wt_unmerged, "cc/branch-feature", "done");
    let report = crate::missions::cleanup::cleanup(&conn, "m-unmerged", &repo.base, false).unwrap();
    assert!(!report.entries[0].removed, "não deve remover worktree com commits não integrados");
    assert!(wt_unmerged.exists());

    // A branch deve continuar registrada no repositório com seu commit
    assert!(repo.git(&["branch", "--list", "cc/branch-feature"]).contains("cc/branch-feature"));
    assert_eq!(repo.git(&["log", "-n", "1", "--format=%s", "cc/branch-feature"]), "commit da feature");

    // Cleanup manual
    let _ = repo.git(&["worktree", "remove", "--force", &wt_unmerged.to_string_lossy()]);
}

#[test]
fn fixture_worktree_cleanup_junction_node_modules_preserva_conteudo_base() {
    let repo = TempRepo::new("junction");
    let shared_nm = repo.root.join("node_modules");
    fs::create_dir_all(shared_nm.join("@shared")).unwrap();
    fs::write(shared_nm.join("package.json"), "{\"name\": \"shared-deps\"}\n").unwrap();
    fs::write(shared_nm.join("@shared/core.js"), "console.log('intacto');\n").unwrap();

    let wt_path = repo.base.join("wt-junc");
    repo.git(&["worktree", "add", "-b", "cc/branch-junc", &wt_path.to_string_lossy(), "master"]);

    let wt_nm = wt_path.join("node_modules");
    crate::skills::mount_dir(&shared_nm, &wt_nm).expect("cria junction/symlink seguro");

    // Verifica que o mount reflete os arquivos
    assert!(wt_nm.join("package.json").exists());
    assert!(wt_nm.join("@shared/core.js").exists());

    // Teste de produção 1: inspect não aponta blockers (o junction node_modules é ignorado como alteração)
    let inspected = crate::missions::cleanup::inspect(
        &repo.root,
        &repo.base,
        &wt_path,
        "cc/branch-junc",
        Some("m-junc".into()),
    );
    assert!(inspected.blockers.is_empty(), "junction node_modules gerenciada não deve gerar bloqueios: {:?}", inspected.blockers);

    // Teste de produção 2: cleanup real remove o worktree de forma segura
    let conn = repo.db("m-junc", &wt_path, "cc/branch-junc", "done");
    let report = crate::missions::cleanup::cleanup(&conn, "m-junc", &repo.base, false).unwrap();
    assert!(report.entries[0].removed, "worktree limpo com junction deve ser removido com sucesso");
    assert!(!wt_path.exists(), "pasta do worktree deve ter sido apagada");

    // CRÍTICO: o diretório original compartilhado e todos os arquivos internos continuam INTACTOS
    assert!(shared_nm.exists(), "shared node_modules deve existir");
    assert!(shared_nm.join("package.json").exists(), "package.json deve continuar intacto");
    assert!(shared_nm.join("@shared/core.js").exists(), "core.js deve continuar intacto");
    assert_eq!(fs::read_to_string(shared_nm.join("package.json")).unwrap(), "{\"name\": \"shared-deps\"}\n");
}
