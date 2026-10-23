use std::path::{Path, PathBuf};
use std::time::Duration;

use super::model::*;
use super::*;

fn git(dir: &Path, args: &[&str]) -> String {
    crate::runs::worktrees::git(dir, args, Duration::from_secs(60)).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

struct Fixture {
    dir: PathBuf,
    repo: PathBuf,
    base: PathBuf,
    registry: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ags-compare-{}", uuid::Uuid::new_v4().simple()));
        let repo = dir.join("repo");
        let base = dir.join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        git(&repo, &["init", "-b", "master"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(repo.join("app.txt"), "um\ndois\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "inicial"]);
        let registry = dir.join("comparisons.json");
        Self { dir, repo, base, registry }
    }

    fn picks(names: &[&str]) -> Vec<ComparePick> {
        names.iter().map(|n| ComparePick { pick: (*n).into(), label: format!("Agente {n}"), agent_id: "claude-code".into() }).collect()
    }

    fn prepare(&self, names: &[&str]) -> Comparison {
        prepare_in(&self.registry, &self.base, &self.repo, "Corrigir o login!", &Self::picks(names), true, "abc123").unwrap().comparison
    }

    fn branch_exists(&self, branch: &str) -> bool {
        crate::runs::worktrees::git(&self.repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], Duration::from_secs(15)).is_ok()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.base) {
            for e in entries.flatten() {
                let link = e.path().join("node_modules");
                if crate::skills::is_mount(&link) {
                    let _ = crate::skills::remove_mount(&link);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn os_nomes_de_branch_seguem_as_regras_de_ref() {
    assert!(valid_pick("claude-opus"));
    assert!(valid_pick("codex-gpt-5.1-high"));
    for bad in ["", "-x", "x-", ".x", "a..b", "a.lock", "Maiuscula", "com espaço", "a/b", &"a".repeat(49)] {
        assert!(!valid_pick(bad), "{bad:?} deveria ser recusado");
    }
    assert_eq!(branch_for("login", "abc123", "codex"), "cmp/login-abc123/codex");
    assert_eq!(trash_ref_for("abc123", "codex"), "refs/ags/descartes/abc123/codex");
    assert_eq!(title_slug("Corrigir o login!"), "corrigir-o-login");
    assert_eq!(title_slug("   "), "comparacao");
    assert!(title_slug(&"palavra ".repeat(20)).len() <= 24);
}

#[test]
fn as_escolhas_sao_de_dois_a_seis_e_unicas() {
    assert!(validate_picks(&Fixture::picks(&["a"])).is_err());
    assert!(validate_picks(&Fixture::picks(&["a", "b"])).is_ok());
    assert!(validate_picks(&Fixture::picks(&["a", "b", "c", "d", "e", "f", "g"])).is_err());
    assert!(validate_picks(&Fixture::picks(&["a", "a"])).is_err());
    let mut bad = Fixture::picks(&["a", "b"]);
    bad[0].agent_id = "rm -rf".into();
    assert!(validate_picks(&bad).is_err());
}

#[test]
fn numstat_conta_arquivos_e_linhas_e_binarios() {
    assert_eq!(parse_numstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n\n10\t0\tb.rs\n"), (3, 13, 1));
    assert_eq!(parse_numstat(""), (0, 0, 0));
    let (cut, truncated) = truncate_utf8("ação", 2);
    assert_eq!((cut, truncated), ("a", true));
    assert_eq!(truncate_utf8("abc", 10), ("abc", false));
}

#[test]
fn preparar_cria_um_worktree_e_uma_branch_por_modelo_a_partir_do_head() {
    let f = Fixture::new();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    let cmp = f.prepare(&["claude-opus", "codex"]);
    assert_eq!(cmp.base.as_deref(), Some(head.as_str()));
    assert_eq!(cmp.entries.len(), 2);
    for (entry, pick) in cmp.entries.iter().zip(["claude-opus", "codex"]) {
        let branch = format!("cmp/corrigir-o-login-abc123/{pick}");
        assert_eq!(entry.branch.as_deref(), Some(branch.as_str()));
        let root = PathBuf::from(entry.root.as_ref().unwrap());
        assert!(root.starts_with(crate::util::external_path(&f.base)) || root.starts_with(&f.base), "{root:?}");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&root, &["config", "--get", &format!("branch.{branch}.agsbase")]), head);
    }
    assert_eq!(read_registry(&f.registry), vec![cmp]);
}

#[test]
fn sem_repositorio_isolar_falha_e_sem_isolamento_todos_usam_a_pasta() {
    let dir = std::env::temp_dir().join(format!("ags-compare-plain-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let registry = dir.join("comparisons.json");
    let base = dir.join("worktrees");
    let picks = Fixture::picks(&["a", "b"]);
    assert!(prepare_in(&registry, &base, &dir, "pergunta", &picks, true, "id0001").is_err());
    assert!(read_registry(&registry).is_empty(), "uma falha não registra nada");
    let shared = prepare_in(&registry, &base, &dir, "pergunta", &picks, false, "id0002").unwrap();
    assert!(!shared.comparison.isolated);
    assert!(shared.comparison.entries.iter().all(|e| e.root.is_none() && e.cwd == dir.to_string_lossy()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn se_um_worktree_falha_os_outros_sao_desfeitos() {
    let f = Fixture::new();
    // A branch do segundo já existe: `worktree add -b` recusa.
    git(&f.repo, &["branch", "cmp/corrigir-o-login-abc123/b"]);
    let err = prepare_in(&f.registry, &f.base, &f.repo, "Corrigir o login!", &Fixture::picks(&["a", "b"]), true, "abc123");
    assert!(err.is_err());
    assert!(!f.branch_exists("cmp/corrigir-o-login-abc123/a"), "a branch criada foi desfeita");
    assert!(f.branch_exists("cmp/corrigir-o-login-abc123/b"), "a branch que já existia não é tocada");
    assert!(read_registry(&f.registry).is_empty());
    assert_eq!(std::fs::read_dir(&f.base).unwrap().count(), 0);
}

#[test]
fn o_status_conta_mudancas_arquivos_novos_e_commits() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b"]);
    let a = PathBuf::from(cmp.entries[0].root.clone().unwrap());
    std::fs::write(a.join("app.txt"), "um\ndois\ntres\n").unwrap();
    std::fs::write(a.join("novo.txt"), "x").unwrap();
    let b = PathBuf::from(cmp.entries[1].root.clone().unwrap());
    std::fs::write(b.join("outro.txt"), "y\n").unwrap();
    git(&b, &["add", "."]);
    git(&b, &["commit", "-m", "feito"]);
    let status = status_in(&f.registry, &cmp.id).unwrap();
    assert_eq!((status[0].files, status[0].insertions, status[0].untracked, status[0].commits, status[0].dirty), (2, 1, 1, 0, true));
    assert_eq!((status[1].files, status[1].insertions, status[1].commits, status[1].dirty), (1, 1, 1, false));
    let diff = diff_in(&f.registry, &cmp.id, "a").unwrap();
    assert!(diff.patch.contains("+tres"), "{}", diff.patch);
    assert_eq!(diff.untracked, vec!["novo.txt".to_string()]);
    assert!(!diff.truncated);
}

#[test]
fn remover_sem_confirmar_nunca_apaga_trabalho() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b", "c"]);
    let a = PathBuf::from(cmp.entries[0].root.clone().unwrap());
    std::fs::write(a.join("app.txt"), "mudou\n").unwrap();
    let b = PathBuf::from(cmp.entries[1].root.clone().unwrap());
    std::fs::write(b.join("x.txt"), "x").unwrap();
    git(&b, &["add", "."]);
    git(&b, &["commit", "-m", "commit do b"]);

    let picks: Vec<String> = ["a", "b", "c"].map(String::from).to_vec();
    let dry = remove_in(&f.registry, &f.base, &cmp.id, &picks, false, true).unwrap();
    assert_eq!(dry.entries[0].dirty, vec!["app.txt".to_string()]);
    assert_eq!(dry.entries[1].commits.len(), 1);
    assert!(dry.entries.iter().all(|e| !e.removed));
    assert!(dry.entries[0].needs_confirmation && dry.entries[1].needs_confirmation && !dry.entries[2].needs_confirmation);

    let report = remove_in(&f.registry, &f.base, &cmp.id, &picks, false, false).unwrap();
    assert!(!report.entries[0].removed && !report.entries[1].removed, "{report:?}");
    assert!(report.entries[2].removed, "o limpo sai: {report:?}");
    assert!(a.exists() && b.exists());
    assert!(!f.branch_exists("cmp/corrigir-o-login-abc123/c"));
    assert!(f.branch_exists("cmp/corrigir-o-login-abc123/b"));
    let left = read_registry(&f.registry);
    assert_eq!(left[0].entries.iter().map(|e| e.pick.as_str()).collect::<Vec<_>>(), ["a", "b"]);
}

#[test]
fn descartar_confirmado_guarda_o_trabalho_numa_ref_recuperavel() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b"]);
    let a = PathBuf::from(cmp.entries[0].root.clone().unwrap());
    std::fs::write(a.join("app.txt"), "mudou\n").unwrap();
    std::fs::write(a.join("novo.txt"), "novo").unwrap();
    // node_modules ligado à pasta compartilhada: a limpeza não pode atravessar o link.
    let deps = f.dir.join("deps");
    std::fs::create_dir_all(&deps).unwrap();
    std::fs::write(deps.join("keep"), "compartilhado").unwrap();
    crate::skills::mount_dir(&deps, &a.join("node_modules")).unwrap();

    let picks = vec!["a".to_string(), "b".to_string()];
    let report = remove_in(&f.registry, &f.base, &cmp.id, &picks, true, false).unwrap();
    assert!(report.entries.iter().all(|e| e.removed && e.blockers.is_empty()), "{report:?}");
    assert!(report.closed);
    assert!(!a.exists());
    assert!(deps.join("keep").exists(), "o alvo do link continua intacto");
    assert!(!f.branch_exists("cmp/corrigir-o-login-abc123/a"));
    let saved = report.entries[0].saved_ref.clone().unwrap();
    assert_eq!(saved, "refs/ags/descartes/abc123/a");
    assert_eq!(git(&f.repo, &["show", &format!("{saved}:app.txt")]), "mudou");
    assert_eq!(git(&f.repo, &["show", &format!("{saved}:novo.txt")]), "novo");
    assert!(report.entries[1].saved_ref.is_none(), "o limpo não precisa de ref");
    assert!(read_registry(&f.registry).is_empty());
}

#[test]
fn caminho_fora_da_pasta_de_worktrees_nunca_e_removido() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b"]);
    let other = f.dir.join("outra-base");
    std::fs::create_dir_all(&other).unwrap();
    let entry = &cmp.entries[0];
    let report = super::git::remove_entry(&f.repo, &other, &cmp.id, entry, cmp.base.as_deref().unwrap(), true, false);
    assert!(!report.removed);
    assert!(report.blockers.iter().any(|b| b.contains("fora da pasta")), "{report:?}");
    assert!(!report.needs_confirmation, "trava dura não se confirma");
    assert!(Path::new(entry.root.as_ref().unwrap()).exists());
}

#[test]
fn manter_um_e_encerrar_deixa_a_branch_com_o_trabalho() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b"]);
    keep_in(&f.registry, &cmp.id, "a").unwrap();
    assert!(remove_in(&f.registry, &f.base, &cmp.id, &["a".to_string()], true, false).is_err(), "o mantido não sai por remove");
    assert!(finish_in(&f.registry, &f.base, &cmp.id, false, false).is_err(), "os outros precisam sair antes");
    remove_in(&f.registry, &f.base, &cmp.id, &["b".to_string()], false, false).unwrap();

    let a = PathBuf::from(cmp.entries[0].root.clone().unwrap());
    std::fs::write(a.join("app.txt"), "resultado\n").unwrap();
    let blocked = finish_in(&f.registry, &f.base, &cmp.id, false, false).unwrap();
    assert!(!blocked.removed && blocked.needs_commit && blocked.dirty == vec!["app.txt".to_string()], "{blocked:?}");
    assert!(a.exists());

    let done = finish_in(&f.registry, &f.base, &cmp.id, true, false).unwrap();
    assert!(done.removed && done.committed, "{done:?}");
    assert!(!a.exists());
    let branch = "cmp/corrigir-o-login-abc123/a";
    assert!(f.branch_exists(branch));
    assert_eq!(git(&f.repo, &["show", &format!("{branch}:app.txt")]), "resultado");
    assert!(read_registry(&f.registry).is_empty());
}

#[test]
fn anexar_abas_grava_o_id_de_cada_uma() {
    let f = Fixture::new();
    let cmp = f.prepare(&["a", "b"]);
    let tabs = vec![TabLink { pick: "b".into(), tab_id: "tab-2".into() }];
    let updated = attach_in(&f.registry, &cmp.id, &tabs).unwrap();
    assert_eq!(updated.entries[1].tab_id.as_deref(), Some("tab-2"));
    assert_eq!(updated.entries[0].tab_id, None);
    assert!(attach_in(&f.registry, "nao-existe", &tabs).is_err());
}
