//! Tests de cuentas: nombres de carpeta y lectura de la identidad desde el disco.

use std::path::Path;

use super::profiles::{default_dir, read_identity, spec_for, system_marker_root, ProfileSpec};
use super::store::validate_name;

/// Un directorio propio por test, que se borra solo.
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("cc-accounts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn write(&self, rel: &str, body: &str) {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spec(agent: &str) -> &'static ProfileSpec {
    spec_for(agent).unwrap()
}

/// El nombre ES el nombre de la carpeta: tiene que rechazar todo lo que escaparía del
/// almacén, lo que Windows no deja crear, y lo que no da una carpeta usable.
#[test]
fn rechaza_los_nombres_que_no_pueden_ser_una_carpeta() {
    for malo in ["..", "../otra", "con/con", ".oculta", "NUL", "com1", "   "] {
        assert!(validate_name(malo).is_err(), "debería rechazar {malo:?}");
    }
    assert!(validate_name(&"a".repeat(41)).is_err(), "demasiado largo");
}

#[test]
fn acepta_los_nombres_corrientes() {
    for bueno in ["trabajo", "cuenta-2", "luis_personal", "v1.0"] {
        assert!(validate_name(bueno).is_ok(), "debería aceptar {bueno:?}");
    }
}

/// El caso real, verificado: `.claude.json` se crea en el primer arranque, mucho antes de
/// que haya login. Contar eso —o un JSON roto, o una carpeta vacía— como cuenta activa
/// mostraría cuentas fantasma.
#[test]
fn sin_login_de_verdad_la_cuenta_no_figura_como_activa() {
    let dir = TempDir::new();
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "carpeta vacía");

    dir.write(".claude.json", r#"{"autoUpdates":true}"#);
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "archivo sin login");

    dir.write(".claude.json", "{no es json");
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "JSON roto");
}

#[test]
fn el_perfil_de_claude_reporta_el_mail_de_la_cuenta() {
    let dir = TempDir::new();
    dir.write(".claude.json", r#"{"oauthAccount":{"emailAddress":"vos@ejemplo.com"}}"#);
    assert_eq!(
        read_identity(dir.path(), spec("claude-code")),
        (true, Some("vos@ejemplo.com".to_string()))
    );
}

/// Sin campo conocido solo se puede decir SI hay login: un `{}` es el archivo que deja la
/// TUI al arrancar sin loguearse, así que no cuenta.
#[test]
fn el_perfil_de_opencode_distingue_un_auth_vacio_de_uno_con_credenciales() {
    let dir = TempDir::new();
    dir.write("opencode/auth.json", "{}");
    assert_eq!(read_identity(dir.path(), spec("opencode")), (false, None));

    dir.write("opencode/auth.json", r#"{"anthropic":{"type":"oauth"}}"#);
    assert_eq!(read_identity(dir.path(), spec("opencode")), (true, None));
}

/// La cuenta principal de Claude Code tiene su `.claude.json` en el home, no en `~/.claude/`.
/// Con el marcador buscado adentro figuraba sin sesión aunque estuviera logueada.
#[test]
fn la_cuenta_principal_de_claude_se_lee_desde_el_home() {
    let home = TempDir::new();
    home.write(".claude.json", r#"{"oauthAccount":{"emailAddress":"yo@casa.com"}}"#);
    let claude = spec("claude-code");
    let root = system_marker_root(claude, home.path(), &home.path().join(".claude"));
    assert_eq!(read_identity(&root, claude), (true, Some("yo@casa.com".into())));

    // Las demás siguen buscando en su propio directorio.
    let codex_dir = home.path().join(".codex");
    assert_eq!(system_marker_root(spec("codex"), home.path(), &codex_dir), codex_dir);
}

/// El directorio de la cuenta del sistema sale del perfil declarado.
///
/// Antes, `default_dir` hacía `match` sobre el nombre de la variable y cualquier nombre
/// que no fuera `CODEX_HOME` o `XDG_DATA_HOME` caía en `~/.claude`. Una TUI nueva habría
/// leído y escrito el login de Claude sin que el compilador se quejara.
#[test]
fn el_home_por_defecto_no_cae_en_claude() {
    use crate::agents::{agent_def, DefaultHome, SystemMarkerRoot, AGENTS};

    let home = dirs::home_dir().expect("home");

    let claude = agent_def("claude-code").unwrap().profile.unwrap();
    assert_eq!(claude.default_home, DefaultHome::HomeDot(".claude"));
    assert_eq!(claude.system_marker, SystemMarkerRoot::UserHome);
    assert_eq!(default_dir(spec("claude-code")).unwrap(), home.join(".claude"));

    let codex = agent_def("codex").unwrap().profile.unwrap();
    assert_eq!(codex.default_home, DefaultHome::HomeDot(".codex"));
    assert_eq!(codex.system_marker, SystemMarkerRoot::DefaultDir);
    assert_eq!(default_dir(spec("codex")).unwrap(), home.join(".codex"));

    let opencode = agent_def("opencode").unwrap().profile.unwrap();
    assert_eq!(opencode.default_home, DefaultHome::XdgDataHome);
    assert_eq!(opencode.system_marker, SystemMarkerRoot::DefaultDir);
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    assert_eq!(default_dir(spec("opencode")).unwrap(), xdg);

    for def in AGENTS {
        let Some(profile) = def.profile else { continue };
        if def.id == "claude-code" {
            continue;
        }
        assert_ne!(
            profile.default_home,
            DefaultHome::HomeDot(".claude"),
            "{} no puede heredar el directorio de Claude",
            def.id
        );
    }

    // Gemini y Kimi siguen sin perfil: no hay variable verificada que mueva su login.
    assert!(agent_def("gemini-cli").unwrap().profile.is_none());
    assert!(agent_def("kimi-code").unwrap().profile.is_none());
}
