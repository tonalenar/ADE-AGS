//! O HOME isolado de uma conta do Antigravity.
//!
//! ## Por que um HOME inteiro e um chaveiro próprio
//!
//! Medido com `agy 1.5.5` e `agy 1.5.14` no macOS, só com diretórios temporários:
//!
//! | Isolamento tentado | Resultado |
//! |---|---|
//! | `GEMINI_HOME` + `AGY_ACP_FORCE_FILE_STORAGE=1` | o `agy` continua usando o login do sistema |
//! | `GEMINI_API_KEY` / `GOOGLE_API_KEY` por variável | ignoradas: o `agy` pede login do Google |
//! | `HOME` vazio | pede login (isolado), mas sem chaveiro padrão |
//! | `HOME` com tudo do home real ligado por link, menos `.gemini` | **usa o login do sistema** |
//! | o mesmo, menos `.gemini` e `Library` | pede login (isolado), mas ao gravar no Keychain o macOS abre "Chaves Não Encontradas" para `"antigravity"` |
//! | o mesmo + `Library/Keychains/login.keychain-db` próprio | `SecKeychainUnlock` recusa senha própria com `-25293` (o `securityd` trata o nome `login.keychain-db` de forma especial) |
//! | o mesmo + `Library/Keychains/antigravity.keychain-db` próprio + `Library/Preferences/com.apple.security.plist` no `HOME` da conta | **isolado, sem diálogo do macOS, grava/lê via `security` e `SecItem*`, persiste entre `lock`/`unlock` e não altera o chaveiro nem as listas do usuário** (~43 ms na criação, ~9 ms no desbloqueio; verificado com caminhos contendo espaços e aspas) |
//!
//! O login do sistema vem do Keychain, que o macOS acha a partir do `HOME` (`~/Library/Keychains`
//! e `~/Library/Preferences/com.apple.security.plist`). A conta isolada é um `HOME` com o resto
//! do home real ligado por link (git, ssh, npm, bun… continuam funcionando para as ferramentas do
//! agente), **menos `.gemini` e `Library`**.
//!
//! No macOS, cada conta recebe uma pasta `Library` própria (nunca linkada à do usuário) com o
//! chaveiro `Library/Keychains/antigravity.keychain-db`. A senha aleatória de 256 bits desse
//! chaveiro fica só no keyring do SO e é enviada ao `/usr/bin/security -i` exclusivamente via
//! `stdin` (`util::spawn::run_with_secret_input`, nunca em `argv`, ambiente, arquivo ou log).
//!
//! ## O que NÃO foi verificado
//!
//! Um login real de ponta a ponta contra os servidores do Google (exige a conta Google do
//! usuário no navegador). Foi verificado com `agy 1.5.14`: o `agy models` fica isolado da conta
//! principal, o `agy` interativo em PTY chega ao fluxo Google OAuth sem diálogo do Keychain, e
//! gravação/leitura/persistência do serviço `"antigravity"` funcionam no chaveiro isolado sem
//! tocar no `login.keychain-db` nem no `default-keychain`/`list-keychains` do usuário.
//!
//! Os links criados aqui não removem nem sobrescrevem arquivos existentes do usuário.

use std::path::Path;

/// O que não entra no home da conta. `.gemini`: o login e o estado do `agy` são da conta.
/// `Library`: no macOS é onde fica o Keychain do usuário; ligá-la devolveria o login do sistema.
const NOT_LINKED: &[&str] = &[".gemini", "Library"];

/// Pastas de skills globais, relativas a `.gemini`, que a conta herda do usuário (como o T3 faz).
const SHARED_SKILLS: &[&str] = &["config/skills", "antigravity-cli/skills"];

#[cfg(target_os = "macos")]
const KEYCHAIN_FILENAME: &str = "antigravity.keychain-db";

#[cfg(target_os = "macos")]
const SECURITY_PLIST: &str = "com.apple.security.plist";

#[cfg(target_os = "macos")]
const SECURITY_BIN: &str = "/usr/bin/security";

#[cfg(target_os = "macos")]
const ANTIGRAVITY_KEYCHAIN_SERVICE: &str = "antigravity";

#[cfg(target_os = "macos")]
const KEYCHAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "macos")]
const KEYCHAIN_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(target_os = "macos")]
lazy_static::lazy_static! {
    /// Serializa a criação/desbloqueio do chaveiro isolado para evitar corrida quando duas
    /// abas ou verificações de saúde preparam a mesma conta simultaneamente.
    static ref KEYCHAIN_PREPARE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

/// Prepara `account_dir` como HOME da conta: cria `.gemini`, liga as entradas do `real_home`
/// e, no macOS, cria/desbloqueia o chaveiro isolado da conta.
/// Idempotente. Recusa quando a conta seria o próprio home (nunca é o caso de uma conta criada).
pub(super) fn prepare(real_home: &Path, account_dir: &Path) -> std::io::Result<()> {
    if real_home == account_dir {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a conta não pode ser o próprio home",
        ));
    }
    let canonical_real = std::fs::canonicalize(real_home).unwrap_or_else(|_| real_home.to_path_buf());
    std::fs::create_dir_all(account_dir.join(".gemini"))?;
    let canonical_account =
        std::fs::canonicalize(account_dir).unwrap_or_else(|_| account_dir.to_path_buf());
    if canonical_real == canonical_account {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a conta não pode ser o próprio home",
        ));
    }
    for entry in std::fs::read_dir(real_home)? {
        let name = entry?.file_name();
        if NOT_LINKED
            .iter()
            .any(|skip| name == std::ffi::OsStr::new(skip))
        {
            continue;
        }
        let source = real_home.join(&name);
        let canonical_source = std::fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        // A pasta de dados pode conter a própria conta; linká-la de volta criaria
        // um ciclo em qualquer consumidor futuro que siga symlinks.
        if account_dir == source
            || account_dir.starts_with(&source)
            || canonical_account == canonical_source
            || canonical_account.starts_with(&canonical_source)
        {
            continue;
        }
        link(&source, &account_dir.join(&name));
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
    #[cfg(target_os = "macos")]
    prepare_isolated_keychain(&canonical_real, &canonical_account)?;
    Ok(())
}

/// Remove do keyring do SO a senha do chaveiro isolado desta conta.
/// Só deve ser chamado quando os arquivos da conta também estão sendo apagados.
#[cfg(target_os = "macos")]
pub(super) fn cleanup_keychain_secret(account_dir: &Path) {
    let resolved = std::fs::canonicalize(account_dir).unwrap_or_else(|_| account_dir.to_path_buf());
    super::secrets::delete_raw(&keychain_secret_key(&resolved));
}

#[cfg(not(target_os = "macos"))]
pub(super) fn cleanup_keychain_secret(_account_dir: &Path) {}

/// Confere pelos metadados do chaveiro isolado se o `agy` gravou uma credencial `"antigravity"`.
/// Nunca passa `-w` e nunca lê nem expõe o segredo; funciona mesmo com o chaveiro travado.
#[cfg(target_os = "macos")]
pub(super) fn has_keychain_credential(account_dir: &Path) -> bool {
    let kc_path = account_dir
        .join("Library")
        .join("Keychains")
        .join(KEYCHAIN_FILENAME);
    let Ok(meta) = std::fs::symlink_metadata(&kc_path) else {
        return false;
    };
    if !meta.file_type().is_file() {
        return false;
    }
    let resolved_home =
        std::fs::canonicalize(account_dir).unwrap_or_else(|_| account_dir.to_path_buf());
    let resolved_kc = std::fs::canonicalize(&kc_path).unwrap_or(kc_path);
    let mut cmd = crate::util::spawn::hidden_command(SECURITY_BIN);
    cmd.args(["find-generic-password", "-s", ANTIGRAVITY_KEYCHAIN_SERVICE])
        .arg(&resolved_kc)
        .env("HOME", &resolved_home);
    crate::util::spawn::output(&mut cmd, KEYCHAIN_PROBE_TIMEOUT)
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn has_keychain_credential(_account_dir: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn prepare_isolated_keychain(real_home: &Path, account_dir: &Path) -> std::io::Result<()> {
    if real_home == account_dir {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "o chaveiro isolado não pode usar o home real do usuário",
        ));
    }
    let _guard = KEYCHAIN_PREPARE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let lib_dir = account_dir.join("Library");
    let keychains_dir = lib_dir.join("Keychains");
    let prefs_dir = lib_dir.join("Preferences");

    // Recusa symlinks para garantir por construção que nunca mexemos em `~/Library` real.
    ensure_real_dir(&lib_dir, true)?;
    ensure_real_dir(&keychains_dir, true)?;
    ensure_real_dir(&prefs_dir, false)?;

    let kc_path = keychains_dir.join(KEYCHAIN_FILENAME);
    let kc_exists = match std::fs::symlink_metadata(&kc_path) {
        Ok(meta) if meta.file_type().is_file() => true,
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "o caminho do chaveiro isolado da conta não é um arquivo regular",
            ));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(err),
    };

    let secret_key = keychain_secret_key(account_dir);
    if kc_exists {
        let password = super::secrets::load_raw(&secret_key)
            .map_err(io_other)?
            .ok_or_else(|| {
                io_other(
                    "A senha do chaveiro isolado desta conta Antigravity não foi encontrada no cofre do sistema; os arquivos da conta foram preservados.",
                )
            })?;
        if !prefs_dir.join(SECURITY_PLIST).is_file() {
            configure_isolated_keychain(account_dir, &kc_path)?;
        }
        unlock_isolated_keychain(account_dir, &keychains_dir, &password)?;
        return Ok(());
    }

    let password = generate_keychain_password()?;
    super::secrets::save_raw(&secret_key, password.as_str()).map_err(io_other)?;
    if let Err(err) = create_isolated_keychain(account_dir, &keychains_dir, &password) {
        super::secrets::delete_raw(&secret_key);
        let _ = std::fs::remove_file(&kc_path);
        return Err(err);
    }
    configure_isolated_keychain(account_dir, &kc_path)?;
    unlock_isolated_keychain(account_dir, &keychains_dir, &password)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_real_dir(path: &Path, private: bool) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "{} precisa ser um diretório real da conta, não um link simbólico",
                    path.display()
                ),
            ));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)?;
        }
        Err(err) => return Err(err),
    }
    if private {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_secret_key(canonical_account_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical_account_dir.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("antigravity-keychain:{hex}")
}

#[cfg(target_os = "macos")]
fn generate_keychain_password() -> std::io::Result<super::secrets::WipeString> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut raw = [0u8; 32];
    SystemRandom::new()
        .fill(&mut raw)
        .map_err(|_| io_other("Não foi possível gerar uma senha aleatória para o chaveiro isolado."))?;
    let mut hex = String::with_capacity(raw.len() * 2);
    for byte in raw {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    raw.fill(0);
    Ok(super::secrets::WipeString(hex))
}

#[cfg(target_os = "macos")]
fn create_isolated_keychain(
    account_dir: &Path,
    keychains_dir: &Path,
    password: &super::secrets::WipeString,
) -> std::io::Result<()> {
    run_security_interactive(
        account_dir,
        keychains_dir,
        "create-keychain",
        password,
        "Não foi possível criar o chaveiro isolado da conta Antigravity",
    )
}

#[cfg(target_os = "macos")]
fn unlock_isolated_keychain(
    account_dir: &Path,
    keychains_dir: &Path,
    password: &super::secrets::WipeString,
) -> std::io::Result<()> {
    run_security_interactive(
        account_dir,
        keychains_dir,
        "unlock-keychain",
        password,
        "Não foi possível desbloquear o chaveiro isolado da conta Antigravity",
    )
}

/// Executa `create-keychain` ou `unlock-keychain` via `/usr/bin/security -i`, passando a senha
/// apenas pelo `stdin` e operando sobre `./antigravity.keychain-db` em `keychains_dir` para
/// não expor a senha em `argv`/`env`/log nem interpolar caminhos no parser do `security -i`.
#[cfg(target_os = "macos")]
fn run_security_interactive(
    account_dir: &Path,
    keychains_dir: &Path,
    subcommand: &str,
    password: &super::secrets::WipeString,
    error_context: &str,
) -> std::io::Result<()> {
    let mut cmd = crate::util::spawn::hidden_command(SECURITY_BIN);
    cmd.arg("-i")
        .current_dir(keychains_dir)
        .env("HOME", account_dir);
    let input = format!("{subcommand} -p {} ./{KEYCHAIN_FILENAME}\n", password.as_str()).into_bytes();
    let (status, _) = crate::util::spawn::run_with_secret_input(&mut cmd, input, KEYCHAIN_TIMEOUT)?;
    if status.success() {
        Ok(())
    } else {
        Err(io_other(format!(
            "{error_context} (código {})",
            status.code().unwrap_or(-1)
        )))
    }
}

/// Configura o chaveiro isolado sem expiração e o define como padrão/único chaveiro de usuário
/// no `HOME` da conta (`<account_dir>/Library/Preferences/com.apple.security.plist`).
#[cfg(target_os = "macos")]
fn configure_isolated_keychain(account_dir: &Path, kc_path: &Path) -> std::io::Result<()> {
    run_security_with_path(
        account_dir,
        &["set-keychain-settings"],
        kc_path,
        "Não foi possível configurar o chaveiro isolado da conta Antigravity",
    )?;
    run_security_with_path(
        account_dir,
        &["default-keychain", "-d", "user", "-s"],
        kc_path,
        "Não foi possível definir o chaveiro padrão da conta Antigravity",
    )?;
    run_security_with_path(
        account_dir,
        &["list-keychains", "-d", "user", "-s"],
        kc_path,
        "Não foi possível configurar a lista de chaveiros da conta Antigravity",
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_security_with_path(
    account_dir: &Path,
    args: &[&str],
    kc_path: &Path,
    error_context: &str,
) -> std::io::Result<()> {
    let mut cmd = crate::util::spawn::hidden_command(SECURITY_BIN);
    cmd.args(args).arg(kc_path).env("HOME", account_dir);
    let out = crate::util::spawn::output(&mut cmd, KEYCHAIN_TIMEOUT)?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            Err(io_other(format!(
                "{error_context} (código {})",
                out.status.code().unwrap_or(-1)
            )))
        } else {
            Err(io_other(format!("{error_context}: {detail}")))
        }
    }
}

#[cfg(target_os = "macos")]
fn io_other(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::other(msg.into())
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
        super::super::secrets::use_mock_keyring();
        let root =
            Root(std::env::temp_dir().join(format!("ade-agy-home-{}", uuid::Uuid::new_v4())));
        let home = root.0.join("home");
        let account = root.0.join("accounts/antigravity/trabalho");
        std::fs::create_dir_all(home.join(".gemini/config/skills")).unwrap();
        std::fs::create_dir_all(home.join(".gemini/antigravity-acp")).unwrap();
        std::fs::write(
            home.join(".gemini/antigravity-acp/acp_token.json"),
            "segredo",
        )
        .unwrap();
        std::fs::create_dir_all(home.join("Library/Keychains")).unwrap();
        std::fs::write(home.join("Library/Keychains/login.keychain-db"), "real").unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".gitconfig"), "[user]").unwrap();
        (root, home, account)
    }

    #[test]
    fn a_conta_nao_enxerga_o_login_nem_o_keychain_do_sistema() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        // `.gemini` é da conta (um diretório próprio, vazio de credenciais).
        assert!(account.join(".gemini").is_dir());
        assert!(
            std::fs::symlink_metadata(account.join(".gemini"))
                .unwrap()
                .file_type()
                .is_dir()
        );
        assert!(
            !account
                .join(".gemini/antigravity-acp/acp_token.json")
                .exists()
        );
        if cfg!(target_os = "macos") {
            // No macOS, `Library` é um diretório próprio da conta com chaveiro isolado — nunca symlink.
            assert!(
                std::fs::symlink_metadata(account.join("Library"))
                    .unwrap()
                    .file_type()
                    .is_dir()
            );
            assert!(!account.join("Library/Keychains/login.keychain-db").exists());
            assert!(
                account
                    .join("Library/Keychains/antigravity.keychain-db")
                    .is_file()
            );
        } else {
            assert!(std::fs::symlink_metadata(account.join("Library")).is_err());
        }
    }

    #[test]
    fn o_resto_do_home_continua_acessivel_para_as_ferramentas() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        assert_eq!(
            std::fs::read_to_string(account.join(".gitconfig")).unwrap(),
            "[user]"
        );
        assert!(account.join(".ssh").is_dir());
        assert!(
            std::fs::symlink_metadata(account.join(".ssh"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn as_skills_globais_sao_herdadas_sem_trazer_o_resto_do_gemini() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        assert!(account.join(".gemini/config/skills").exists());
        assert!(
            std::fs::symlink_metadata(account.join(".gemini/config/skills"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // `.gemini/config` é um diretório real da conta: só `skills` é link.
        assert!(
            std::fs::symlink_metadata(account.join(".gemini/config"))
                .unwrap()
                .file_type()
                .is_dir()
        );
    }

    #[test]
    fn a_pasta_de_dados_que_contem_a_conta_nao_e_linkada_de_volta() {
        let (_root, home, _unused_account) = dirs();
        let account = home.join(".ags/accounts/antigravity/trabalho");
        std::fs::create_dir_all(&account).unwrap();
        prepare(&home, &account).unwrap();
        assert!(std::fs::symlink_metadata(account.join(".ags")).is_err());
    }

    #[test]
    fn preparar_de_novo_nao_apaga_nem_troca_nada() {
        let (_root, home, account) = dirs();
        prepare(&home, &account).unwrap();
        std::fs::write(account.join(".gemini/login-da-conta"), "x").unwrap();
        prepare(&home, &account).unwrap();
        assert_eq!(
            std::fs::read_to_string(account.join(".gemini/login-da-conta")).unwrap(),
            "x"
        );
    }

    #[test]
    fn recusa_usar_o_proprio_home_como_conta() {
        let (_root, home, _account) = dirs();
        assert!(prepare(&home, &home).is_err());
        assert!(home.join(".gemini/antigravity-acp/acp_token.json").exists());
    }
}
