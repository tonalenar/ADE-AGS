use super::*;
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ade-marker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("checkout/sub/leaf")).unwrap();
        std::fs::write(root.join("checkout/.git"), "gitdir: fixture").unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn marker(&self, dir: &str, text: &str) {
        std::fs::write(self.0.join(dir).join(".ai-memory.toml"), text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
const PAIR: &str = "workspace = \"default\"\nproject = \"ADE-AGS\"\n";
#[test]
fn raiz_e_ancestral_resolvem_independente_do_basename_do_worktree() {
    let f = Fixture::new();
    f.marker("checkout", PAIR);
    for cwd in ["checkout", "checkout/sub/leaf"] {
        assert_eq!(
            scope(&f.0.join(cwd), Some(&f.0)),
            Some(("default".into(), "ADE-AGS".into()))
        );
    }
    f.marker("checkout/sub", "workspace='team'\nproject='closer'\n");
    assert_eq!(
        scope(&f.0.join("checkout/sub/leaf"), Some(&f.0)).unwrap().1,
        "closer"
    );
}
#[test]
fn invalido_e_capture_only_sao_transparentes() {
    let f = Fixture::new();
    f.marker("checkout", PAIR);
    for text in [
        "workspace = [",
        "workspace=1\nproject=2",
        "[capture]\nignore_paths = ['secret/**']\n",
    ] {
        f.marker("checkout/sub", text);
        assert_eq!(
            scope(&f.0.join("checkout/sub/leaf"), Some(&f.0)).unwrap().1,
            "ADE-AGS"
        );
    }
}
#[test]
fn home_e_checkout_externo_limitam_a_busca() {
    let f = Fixture::new();
    f.marker("", PAIR);
    // Dentro do home, o próprio home é consultado.
    assert!(scope(&f.0.join("checkout/sub"), Some(&f.0)).is_some());
    // Um home mais próximo não permite alcançar o marcador externo.
    assert!(
        scope(
            &f.0.join("checkout/sub/leaf"),
            Some(&f.0.join("checkout/sub"))
        )
        .is_none()
    );
    // Fora do home, .git arquivo também limita a busca à raiz do worktree.
    assert!(
        scope(
            &f.0.join("checkout/sub"),
            Some(Path::new("/").join("nonexistent-home").as_path())
        )
        .is_none()
    );
    std::fs::create_dir(f.0.join("other-home")).unwrap();
    assert!(scope(&f.0.join("checkout/sub"), Some(&f.0.join("other-home"))).is_none());
    f.marker("checkout", PAIR);
    assert!(scope(&f.0.join("checkout/sub"), Some(&f.0.join("other-home"))).is_some());
}
#[test]
fn externo_sem_git_so_consulta_cwd_e_marcador_parcial_nao_mescla_ancestral() {
    let f = Fixture::new();
    f.marker("", PAIR);
    std::fs::create_dir_all(f.0.join("plain/sub")).unwrap();
    std::fs::create_dir(f.0.join("home")).unwrap();
    assert!(scope(&f.0.join("plain/sub"), Some(&f.0.join("home"))).is_none());
    f.marker("checkout", PAIR);
    f.marker("checkout/sub", "workspace='partial'\n");
    assert!(scope(&f.0.join("checkout/sub/leaf"), Some(&f.0)).is_none());
}

#[test]
fn marcador_invalido_na_fronteira_nao_permite_ler_o_pai() {
    let f = Fixture::new();
    f.marker("", PAIR);
    f.marker("checkout", "workspace=1\nproject=2\n");
    std::fs::create_dir(f.0.join("other-home")).unwrap();
    assert!(scope(&f.0.join("checkout/sub"), Some(&f.0.join("other-home"))).is_none());
}
