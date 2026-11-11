//! O HOME isolado de uma conta do Antigravity.
//!
//! ## Por que um HOME inteiro
//!
//! Medido com o `agy 1.5.5` no macOS, só com diretórios temporários:
//!
//! | Isolamento tentado | Resultado |
//! |---|---|
//! | `GEMINI_HOME` + `AGY_ACP_FORCE_FILE_STORAGE=1` | o `agy` continua usando o login do sistema |
//! | `GEMINI_API_KEY` / `GOOGLE_API_KEY` por variável | ignoradas: o `agy` pede login do Google |
//! | `HOME` vazio | pede login (isolado) |
//! | `HOME` com tudo do home real ligado por link, menos `.gemini` | **usa o login do sistema** |
//! | o mesmo, menos `.gemini` e `Library` | pede login (isolado) |
//!
//! O login do sistema vem do Keychain, que o macOS acha a partir do HOME (`~/Library/Keychains`).
//! Então a conta isolada é um HOME com o resto do home real ligado por link (git, ssh, npm,
//! bun… continuam funcionando para as ferramentas do agente), **menos `.gemini` e `Library`**.
//!
//! ## O que NÃO foi verificado
//!
//! Que um login feito dentro desse HOME **persista**: sem `Library/Keychains` não há chaveiro
//! padrão para gravar, e fazer um login de verdade exige a conta Google do usuário. A tela
//! trata a conta como experimental e a verificação (`agy models` no ambiente da conta) mostra
//! se o login ficou ou não.
//!
//! Só existem links criados aqui; nada é removido nem sobrescrito.

use std::path::Path;

/// O que não entra no home da conta. `.gemini`: o login e o estado do `agy` são da conta.
/// `Library`: no macOS é onde fica o Keychain do usuário; ligá-la devolveria o login do sistema.
const NOT_LINKED: &[&str] = &[".gemini", "Library"];

/// Pastas de skills globais, relativas a `.gemini`, que a conta herda do usuário (como o T3 faz).
const SHARED_SKILLS: &[&str] = &["config/skills", "antigravity-cli/skills"];

/// Prepara `account_dir` como HOME da conta: cria `.gemini` e liga as entradas do `real_home`.
/// Idempotente. Recusa quando a conta seria o próprio home (nunca é o caso de uma conta criada).
pub(super) fn prepare(real_home: &Path, account_dir: &Path) -> std::io::Result<()> {
    if real_home == account_dir {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "a conta não pode ser o próprio home"));
    }
    std::fs::create_dir_all(account_dir.join(".gemini"))?;
    for entry in std::fs::read_dir(real_home)? {
        let name = entry?.file_name();
        if NOT_LINKED.iter().any(|skip| name == std::ffi::OsStr::new(skip)) {
            continue;
        }
        link(&real_home.join(&name), &account_dir.join(&name));
    }
    for sub in SHARED_SKILLS {
        let target = real_home.join(".gemini").join(sub);
        if target.exists() {
            let link_path = account_dir.join(".gemini").join(sub);
            if let Some(parent) = link_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            link(&target, &link_path);
        }
    }
    Ok(())
}

/// Cria `link_path -> target` se `link_path` ainda não existe (nem como link quebrado).
#[cfg(unix)]
fn link(target: &Path, link_path: &Path) {
    if std::fs::symlink_metadata(link_path).is_err() {
        let _ = std::os::unix::fs::symlink(target, link_path);
    }
}

#[cfg(not(unix))]
fn link(_target: &Path, _link_path: &Path) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Um diretório temporário próprio por teste, que se apaga sozinho.
    struct Root(std::path::PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dirs() -> (Root, std::path::PathBuf, std::path::PathBuf) {
        let root = Root(std::env::temp_dir().join(format!("ade-agy-home-{}", uuid::Uuid::new_v4())));
        let home = root.0.join("home");
        let account = root.0.join("accounts/antigravity/trabalho");
        std::fs::create_dir_all(home.join(".gemini/config/skills")).unwrap();
        std::fs::create_dir_all(home.join(".gemini/antigravity-acp")).unwrap();
        std::fs::write(home.join(".gemini/antigravity-acp/acp_token.json"), "segredo").unwrap();
        std::fs::create_dir_all(home.join("Library/Keychains")).unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".gitconfig"), "[user]").unwrap();
        (root, home, account)
    }

    #[test]
    fn a_conta_nao_enxerga_o_login_nem_o_keychain_do_sistema() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        // `.gemini` é da conta (um diretório próprio, vazio de credenciais) e `Library` não existe nela.
        assert!(account.join(".gemini").is_dir());
        assert!(std::fs::symlink_metadata(account.join(".gemini")).unwrap().file_type().is_dir());
        assert!(!account.join(".gemini/antigravity-acp/acp_token.json").exists());
        assert!(std::fs::symlink_metadata(account.join("Library")).is_err());
    }

    #[test]
    fn o_resto_do_home_continua_acessivel_para_as_ferramentas() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        assert_eq!(std::fs::read_to_string(account.join(".gitconfig")).unwrap(), "[user]");
        assert!(account.join(".ssh").is_dir());
        assert!(std::fs::symlink_metadata(account.join(".ssh")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn as_skills_globais_sao_herdadas_sem_trazer_o_resto_do_gemini() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        assert!(account.join(".gemini/config/skills").exists());
        assert!(std::fs::symlink_metadata(account.join(".gemini/config/skills")).unwrap().file_type().is_symlink());
        // `.gemini/config` é um diretório real da conta: só `skills` é link.
        assert!(std::fs::symlink_metadata(account.join(".gemini/config")).unwrap().file_type().is_dir());
    }

    #[test]
    fn preparar_de_novo_nao_apaga_nem_troca_nada() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        std::fs::write(account.join(".gemini/login-da-conta"), "x").unwrap();
        prepare(&home, &account).unwrap();
        assert_eq!(std::fs::read_to_string(account.join(".gemini/login-da-conta")).unwrap(), "x");
    }

    #[test]
    fn recusa_usar_o_proprio_home_como_conta() {
        let (_root, home, _account) = dirs();
        assert!(prepare(&home, &home).is_err());
        assert!(home.join(".gemini/antigravity-acp/acp_token.json").exists());
    }
}
