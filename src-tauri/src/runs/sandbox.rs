//! Aislamiento de los agentes headless a nivel del sistema operacional.
//!
//! El broker y las reglas de permisos deciden qué PIDE un agente; esto limita lo que puede
//! HACER aunque decida no pedir (Kimi aprueba todo solo, un `npm install` corre scripts de
//! terceros, un modelo con shell puede escribir donde quiera). La idea es la misma en todas
//! las plataformas: el agente lee todo, pero escribe solo en su carpeta de trabajo, en el
//! directorio de su cuenta y en los temporales.
//!
//! | Plataforma | Mecanismo | Escritura limitada |
//! |---|---|---|
//! | Linux | `bwrap` (bubblewrap): `/` de solo lectura y binds de escritura | sí |
//! | macOS | `sandbox-exec` con un perfil que niega `file-write*` salvo las rutas | sí |
//! | Windows | Job Object (ya lo pone `terminal::containment`) | no |
//!
//! En Windows no hay un equivalente sin AppContainer, que exige reempaquetar los agentes.
//! Ahí el sandbox se limita a lo común: contención del árbol de procesos y entorno sin
//! credenciales ajenas. El estado lo dice ([`Status::fs_isolation`]) para no prometer de más.
//!
//! La red queda abierta: los agentes hablan con su API. Codex, además, se encierra solo
//! (`--sandbox workspace-write`), así que ahí esto es una segunda capa.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// La configuración que elige el modo.
pub const SETTING: &str = "runs.sandbox";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Como antes: el agente corre con el entorno y los permisos de la app.
    Off,
    /// Aísla donde se puede; donde no (Windows, Linux sin `bwrap`) corre igual.
    Auto,
    /// Sin aislamiento de escritura, la tarea no arranca.
    Strict,
}

impl Mode {
    /// Sin configurar es `Auto`: aislar donde se puede no le cambia nada a quien no lo nota.
    pub fn parse(value: Option<&str>) -> Mode {
        match value.map(str::trim) {
            Some("off") => Mode::Off,
            Some("strict") => Mode::Strict,
            _ => Mode::Auto,
        }
    }

    pub fn from_db(db: &crate::database::DbConnection) -> Mode {
        Mode::parse(crate::database::get_setting(db, SETTING).ok().flatten().as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    None,
    Bubblewrap,
    Seatbelt,
    JobObject,
}

/// Lo que el sandbox puede garantizar en esta máquina.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub mode: Mode,
    pub backend: Backend,
    /// Si la escritura queda limitada a las rutas de la tarea.
    pub fs_isolation: bool,
    /// Por qué no hay aislamiento de escritura, cuando no lo hay: `disabled`,
    /// `missing-bwrap`, `missing-sandbox-exec` o `windows`. La UI lo traduce.
    pub reason: Option<&'static str>,
}

/// Variables que el agente no tiene por qué heredar de la app: credenciales de otros
/// servicios. Las de los providers (ANTHROPIC_*, OPENAI_* …) se quedan, porque la cuenta del
/// sistema las usa; las de la cuenta de la tarea se aplican después y les ganan.
pub const SCRUBBED_ENV: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITLAB_TOKEN",
    "GL_TOKEN",
    "BITBUCKET_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "CARGO_REGISTRY_TOKEN",
    "PYPI_TOKEN",
    "TWINE_PASSWORD",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "DOCKER_PASSWORD",
    "DOCKER_AUTH_CONFIG",
    "VERCEL_TOKEN",
    "NETLIFY_AUTH_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "DIGITALOCEAN_TOKEN",
    "HEROKU_API_KEY",
    "SLACK_TOKEN",
    "SLACK_BOT_TOKEN",
    "STRIPE_SECRET_KEY",
    "SSH_AUTH_SOCK",
];

/// Qué puede escribir una tarea.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub writable: Vec<PathBuf>,
}

impl Policy {
    /// La carpeta de trabajo (salvo un lead, que no edita), el repo git común de un
    /// worktree (sin él no puede hacer commit), los directorios de la cuenta y de los
    /// agentes, y los temporales.
    pub fn for_task(cwd: &Path, read_only: bool, account_env: &HashMap<String, String>, home: Option<&Path>) -> Policy {
        let mut writable = Vec::new();
        if !read_only {
            writable.push(cwd.to_path_buf());
            if let Some(common) = git_common_dir(cwd) {
                writable.push(common);
            }
        }
        for var in ACCOUNT_DIR_VARS {
            if let Some(dir) = account_env.get(*var) {
                writable.push(PathBuf::from(dir));
            }
        }
        if let Some(home) = home {
            writable.extend(AGENT_HOME_PATHS.iter().map(|p| home.join(p)));
        }
        writable.push(std::env::temp_dir());
        if cfg!(unix) {
            writable.push(PathBuf::from("/tmp"));
        }
        let mut policy = Policy { writable };
        policy.normalize();
        policy
    }

    /// Rutas reales (macOS resuelve `/var` → `/private/var` antes de mirar el perfil),
    /// solo las que existen (un bind a una ruta inexistente hace fallar a `bwrap`) y sin
    /// repetidas.
    fn normalize(&mut self) {
        let mut out: Vec<PathBuf> = Vec::new();
        for path in self.writable.drain(..) {
            let Ok(real) = std::fs::canonicalize(&path) else { continue };
            let real = crate::util::external_path(&real);
            if !out.contains(&real) {
                out.push(real);
            }
        }
        self.writable = out;
    }
}

/// Las variables con las que una cuenta apunta a su directorio (ver `agents::registry`).
const ACCOUNT_DIR_VARS: &[&str] = &["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "GEMINI_CLI_HOME"];

/// Lo que los agentes escriben en el home con la cuenta del sistema: sesiones, caché,
/// credenciales renovadas. Sin esto, una tarea con la cuenta del sistema no arranca.
const AGENT_HOME_PATHS: &[&str] = &[
    ".claude",
    ".claude.json",
    ".codex",
    ".gemini",
    ".kimi",
    ".config/opencode",
    ".local/share/opencode",
    ".local/state/opencode",
    ".cache",
    ".npm",
    ".antigravity",
];

/// El directorio git común de un worktree (`<repo>/.git`): un commit escribe ahí objetos y
/// refs, no en la carpeta del worktree.
fn git_common_dir(cwd: &Path) -> Option<PathBuf> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).current_dir(cwd);
    let out = crate::util::output_with_timeout(&mut cmd, std::time::Duration::from_secs(5)).ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// El mecanismo de esta plataforma y si está instalado.
pub fn status(mode: Mode) -> Status {
    let (backend, fs_isolation, reason) = if mode == Mode::Off {
        (Backend::None, false, Some("disabled"))
    } else if cfg!(target_os = "linux") {
        match crate::util::find_program("bwrap") {
            Some(_) => (Backend::Bubblewrap, true, None),
            None => (Backend::None, false, Some("missing-bwrap")),
        }
    } else if cfg!(target_os = "macos") {
        match Path::new(SANDBOX_EXEC).exists() {
            true => (Backend::Seatbelt, true, None),
            false => (Backend::None, false, Some("missing-sandbox-exec")),
        }
    } else if cfg!(windows) {
        (Backend::JobObject, false, Some("windows"))
    } else {
        (Backend::None, false, None)
    };
    Status { mode, backend, fs_isolation, reason }
}

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Lo que hay que lanzar en lugar del agente.
pub struct Wrapped {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    #[cfg_attr(not(test), expect(dead_code, reason = "backend metadata is asserted by wrapper tests"))]
    pub backend: Backend,
}

/// Envuelve el lanzamiento según el modo. `Err` solo en `Strict` sin aislamiento.
pub fn wrap(mode: Mode, program: &Path, args: &[String], policy: &Policy) -> Result<Wrapped, String> {
    let plain = || Wrapped {
        program: program.to_path_buf(),
        args: args.iter().map(OsString::from).collect(),
        backend: Backend::None,
    };
    if mode == Mode::Off {
        return Ok(plain());
    }
    let status = status(mode);
    if !status.fs_isolation {
        if mode == Mode::Strict {
            return Err(format!(
                "sandbox estricto: esta máquina no puede limitar la escritura del agente ({})",
                status.reason.unwrap_or("sin mecanismo")
            ));
        }
        return Ok(Wrapped { backend: status.backend, ..plain() });
    }
    match status.backend {
        Backend::Bubblewrap => Ok(Wrapped {
            program: crate::util::find_program("bwrap").unwrap_or_else(|| PathBuf::from("bwrap")),
            args: bwrap_args(program, args, policy),
            backend: Backend::Bubblewrap,
        }),
        Backend::Seatbelt => {
            let mut out: Vec<OsString> = vec!["-p".into(), seatbelt_profile(policy).into(), program.into()];
            out.extend(args.iter().map(OsString::from));
            Ok(Wrapped { program: PathBuf::from(SANDBOX_EXEC), args: out, backend: Backend::Seatbelt })
        }
        _ => Ok(plain()),
    }
}

/// `/` entero de solo lectura y encima, de escritura, solo las rutas de la política.
/// `--die-with-parent`: si la app muere, el agente también.
pub(crate) fn bwrap_args(program: &Path, args: &[String], policy: &Policy) -> Vec<OsString> {
    let mut out: Vec<OsString> = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"]
        .into_iter()
        .map(OsString::from)
        .collect();
    for path in &policy.writable {
        out.extend([OsString::from("--bind"), path.into(), path.into()]);
    }
    out.push("--".into());
    out.push(program.into());
    out.extend(args.iter().map(OsString::from));
    out
}

/// Perfil de Seatbelt: todo permitido salvo escribir, y escribir solo en las rutas de la
/// política y en los dispositivos que cualquier proceso usa.
pub(crate) fn seatbelt_profile(policy: &Policy) -> String {
    let mut profile = String::from(
        "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n  (literal \"/dev/null\")\n  (literal \"/dev/zero\")\n  (literal \"/dev/dtracehelper\")\n  (regex #\"^/dev/tty\")\n  (regex #\"^/dev/fd/\")",
    );
    for path in &policy.writable {
        profile.push_str(&format!("\n  (subpath \"{}\")", seatbelt_escape(&path.to_string_lossy())));
    }
    profile.push_str(")\n");
    profile
}

/// Un string de Seatbelt (sintaxis de Scheme): comillas y barras escapadas. Un salto de
/// línea en una ruta no se puede expresar sin romper el perfil, así que se descarta.
fn seatbelt_escape(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .flat_map(|c| match c {
            '"' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect()
}

/// Saca del entorno heredado las credenciales de otros servicios.
pub fn scrub_env(command: &mut std::process::Command) {
    for var in SCRUBBED_ENV {
        command.env_remove(var);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_auto() {
        assert_eq!(Mode::parse(None), Mode::Auto);
        assert_eq!(Mode::parse(Some("garbage")), Mode::Auto);
        assert_eq!(Mode::parse(Some(" off ")), Mode::Off);
        assert_eq!(Mode::parse(Some("strict")), Mode::Strict);
    }

    #[test]
    fn off_launches_unchanged() {
        let w = wrap(Mode::Off, Path::new("claude"), &["-p".into(), "hi".into()], &Policy::default()).unwrap();
        assert_eq!(w.program, PathBuf::from("claude"));
        assert_eq!(w.args, vec![OsString::from("-p"), OsString::from("hi")]);
        assert_eq!(w.backend, Backend::None);
    }

    #[test]
    fn policy_keeps_workspace_unless_read_only() {
        let dir = std::env::temp_dir().join(format!("ade-sandbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = crate::util::external_path(&std::fs::canonicalize(&dir).unwrap());
        let env = HashMap::from([("CODEX_HOME".to_string(), dir.to_string_lossy().into_owned())]);

        let worker = Policy::for_task(&dir, false, &HashMap::new(), None);
        assert!(worker.writable.contains(&real));
        let lead = Policy::for_task(&dir, true, &HashMap::new(), None);
        assert!(!lead.writable.contains(&real));
        // El directorio de la cuenta sí, aunque sea un lead: ahí guarda su sesión.
        let lead_with_account = Policy::for_task(&dir, true, &env, None);
        assert!(lead_with_account.writable.contains(&real));
        // Sin repetidas, y nada que no exista.
        let both = Policy::for_task(&dir, false, &env, Some(Path::new("/definitely/not/here")));
        assert_eq!(both.writable.iter().filter(|p| **p == real).count(), 1);
        assert!(both.writable.iter().all(|p| p.exists()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bwrap_binds_only_policy_paths() {
        let policy = Policy { writable: vec![PathBuf::from("/work/repo")] };
        let args = bwrap_args(Path::new("/usr/bin/claude"), &["--".into(), "-rm".into()], &policy);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(&args[..3], ["--ro-bind", "/", "/"]);
        let bind = args.iter().position(|a| a == "--bind").unwrap();
        assert_eq!(&args[bind..bind + 3], ["--bind", "/work/repo", "/work/repo"]);
        assert_eq!(args.iter().filter(|a| *a == "--bind").count(), 1);
        // El pedido del agente queda después del programa, intacto.
        let sep = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[sep + 1..], ["/usr/bin/claude", "--", "-rm"]);
    }

    #[test]
    fn seatbelt_denies_writes_and_escapes_paths() {
        let policy = Policy { writable: vec![PathBuf::from(r#"/Users/a "b"\c"#), PathBuf::from("/x\n(allow file-write*)")] };
        let profile = seatbelt_profile(&policy);
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains(r#"(subpath "/Users/a \"b\"\\c")"#));
        // Un salto de línea no abre una regla nueva.
        assert!(profile.contains(r#"(subpath "/x(allow file-write*)")"#));
        assert_eq!(profile.lines().filter(|l| l.starts_with("(allow file-write*")).count(), 1);
    }

    #[test]
    fn scrub_removes_foreign_credentials() {
        let mut cmd = std::process::Command::new("x");
        cmd.env("GH_TOKEN", "secret");
        scrub_env(&mut cmd);
        let gh = cmd.get_envs().find(|(k, _)| *k == "GH_TOKEN").map(|(_, v)| v);
        assert_eq!(gh, Some(None), "GH_TOKEN debe quedar removido");
        assert!(!SCRUBBED_ENV.iter().any(|v| v.starts_with("ANTHROPIC") || v.starts_with("OPENAI")));
    }

    #[cfg(windows)]
    #[test]
    fn strict_refuses_on_windows() {
        let err = wrap(Mode::Strict, Path::new("claude"), &[], &Policy::default()).err().unwrap();
        assert!(err.contains("windows"));
        assert!(wrap(Mode::Auto, Path::new("claude"), &[], &Policy::default()).is_ok());
    }
}
