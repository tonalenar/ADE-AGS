//! Tests de cuentas: nombres de carpeta y lectura de la identidad desde el disco.

use std::path::Path;

use super::profiles::{ProfileSpec, default_dir, read_identity, spec_for, system_marker_root};
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

fn fake_keyring() {
    static KEYRING: std::sync::Once = std::sync::Once::new();
    KEYRING.call_once(|| {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder())
    });
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
    assert_eq!(
        read_identity(dir.path(), spec("claude-code")),
        (false, None),
        "carpeta vacía"
    );

    dir.write(".claude.json", r#"{"autoUpdates":true}"#);
    assert_eq!(
        read_identity(dir.path(), spec("claude-code")),
        (false, None),
        "archivo sin login"
    );

    dir.write(".claude.json", "{no es json");
    assert_eq!(
        read_identity(dir.path(), spec("claude-code")),
        (false, None),
        "JSON roto"
    );
}

#[test]
fn el_perfil_de_claude_reporta_el_mail_de_la_cuenta() {
    let dir = TempDir::new();
    dir.write(
        ".claude.json",
        r#"{"oauthAccount":{"emailAddress":"vos@ejemplo.com"}}"#,
    );
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
    home.write(
        ".claude.json",
        r#"{"oauthAccount":{"emailAddress":"yo@casa.com"}}"#,
    );
    let claude = spec("claude-code");
    let root = system_marker_root(claude, home.path(), &home.path().join(".claude"));
    assert_eq!(
        read_identity(&root, claude),
        (true, Some("yo@casa.com".into()))
    );

    // Las demás siguen buscando en su propio directorio.
    let codex_dir = home.path().join(".codex");
    assert_eq!(
        system_marker_root(spec("codex"), home.path(), &codex_dir),
        codex_dir
    );
}

/// El directorio de la cuenta del sistema sale del perfil declarado.
///
/// Antes, `default_dir` hacía `match` sobre el nombre de la variable y cualquier nombre
/// que no fuera `CODEX_HOME` o `XDG_DATA_HOME` caía en `~/.claude`. Una TUI nueva habría
/// leído y escrito el login de Claude sin que el compilador se quejara.
#[test]
fn el_home_por_defecto_no_cae_en_claude() {
    use crate::agents::{AGENTS, DefaultHome, SystemMarkerRoot, agent_def};

    let home = dirs::home_dir().expect("home");

    let claude = agent_def("claude-code").unwrap().profile.unwrap();
    assert_eq!(claude.default_home, DefaultHome::HomeDot(".claude"));
    assert_eq!(claude.system_marker, SystemMarkerRoot::UserHome);
    assert_eq!(
        default_dir(spec("claude-code")).unwrap(),
        home.join(".claude")
    );

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

// ── Cuentas por API key ──────────────────────────────────────────

#[test]
fn una_api_key_se_valida_antes_de_guardarla() {
    use super::secrets::{hint, validate_base_url, validate_key};
    assert!(validate_key("sk-ant-api03-abcdefgh").is_ok());
    assert!(validate_key("corta").is_err());
    // Un salto de línea pegado de más rompería el header que arma la CLI.
    assert!(validate_key("sk-ant-api03-abcdefgh\n").is_err());
    assert!(validate_key("sk-ant api03-abcdefgh").is_err());
    assert_eq!(hint("sk-ant-api03-abcdWXYZ"), "…WXYZ");

    assert_eq!(
        validate_base_url("https://openrouter.ai/api/").unwrap(),
        "https://openrouter.ai/api"
    );
    assert!(validate_base_url("http://localhost:4000").is_ok());
    // En HTTP hacia otra máquina la key viajaría en claro.
    assert!(validate_base_url("http://gateway.example.com").is_err());
    assert!(validate_base_url("https://user:pass@gateway.example.com").is_err());
    assert!(validate_base_url("no es una url").is_err());
}

#[test]
fn una_cuenta_de_claude_por_key_no_expone_la_clave_en_el_entorno() {
    use super::store::claude_api_env;
    let directa = claude_api_env(None);
    assert!(
        !directa.contains_key("ANTHROPIC_API_KEY"),
        "a chave de API não pode entrar no ambiente do agente"
    );
    assert!(!directa.contains_key("ANTHROPIC_BASE_URL"));

    // A URL do gateway continua pública; o token segue pelo broker.
    let gateway = claude_api_env(Some("https://openrouter.ai/api"));
    assert!(
        !gateway.contains_key("ANTHROPIC_AUTH_TOKEN"),
        "a chave do gateway não pode entrar no ambiente do agente"
    );
    assert_eq!(
        gateway.get("ANTHROPIC_BASE_URL").map(String::as_str),
        Some("https://openrouter.ai/api")
    );
    assert!(!gateway.contains_key("ANTHROPIC_API_KEY"));
}

#[test]
fn ambiente_do_agente_sem_chave() {
    fake_keyring();
    let dir = TempDir::new();
    let account_id = format!("test-{}", uuid::Uuid::new_v4());
    let key = "sk-teste-nao-real-1234";
    super::secrets::save(&account_id, key).unwrap();
    let env = super::store::account_env_from_row(
        &account_id,
        "claude-code",
        &dir.path().to_string_lossy(),
        "api_key",
        Some("https://gateway.example/v1"),
    )
    .unwrap()
    .unwrap();
    let config_dir = dir.path().to_string_lossy().into_owned();
    assert_eq!(env.get("CLAUDE_CONFIG_DIR"), Some(&config_dir));
    assert_eq!(
        env.get("ANTHROPIC_BASE_URL").map(String::as_str),
        Some("https://gateway.example/v1")
    );
    assert!(!env.contains_key("ANTHROPIC_API_KEY"));
    assert!(!env.contains_key("ANTHROPIC_AUTH_TOKEN"));
    assert!(env.values().all(|value| value != key));
    let settings = super::broker::write_claude_settings(
        dir.path(),
        Path::new("/tmp/ags"),
        &account_id,
    )
    .unwrap();
    let settings_json = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
    assert!(settings.contains("credential claude"));
    assert!(!settings_json.contains(key));
    super::secrets::delete(&account_id);
}

#[test]
fn settings_claude_preserva_preferencias_e_grava_so_o_comando_helper() {
    let dir = TempDir::new();
    dir.write(
        "settings.json",
        r#"{"theme":"dark","permissions":{"allow":["Bash(git status)"]}}"#,
    );
    let first_command = super::broker::write_claude_settings(
        dir.path(),
        Path::new("/tmp/ags"),
        "conta-123",
    )
    .unwrap();
    let second_command = super::broker::write_claude_settings(
        dir.path(),
        Path::new("/tmp/ags"),
        "conta-123",
    )
    .unwrap();
    assert_eq!(first_command, second_command, "sessões da conta compartilham helper estável");
    let body = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
    let settings: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["permissions"]["allow"][0], "Bash(git status)");
    assert_eq!(
        settings["apiKeyHelper"].as_str().unwrap(),
        "'/tmp/ags' credential claude --account conta-123"
    );
    assert!(!body.contains("sk-teste-nao-real"));
}

#[test]
fn settings_claude_preserva_helper_de_terceiros() {
    let dir = TempDir::new();
    let original = r#"{"apiKeyHelper":"/usr/local/bin/custom-auth","theme":"dark"}"#;
    dir.write("settings.json", original);
    let result = super::broker::write_claude_settings(
        dir.path(),
        Path::new("/tmp/ags"),
        "conta-123",
    );
    assert!(
        result.is_err(),
        "o broker não deve substituir helper alheio"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        original
    );
}

#[test]
fn helper_autoriza_sessoes_vivas_renova_e_revoga_no_fechamento() {
    let broker = super::broker::Broker::default();
    let conta = format!("conta-{}", uuid::Uuid::new_v4());
    let grant_a = broker.issue_grant(&conta);
    let grant_b = broker.issue_grant(&conta);
    broker.bind_grant(&grant_a, 42).unwrap();
    broker.bind_grant(&grant_b, 52).unwrap();
    let parent = |pid| match pid {
        43 => Some(42),
        53 => Some(52),
        _ => None,
    };
    let load = |id: &str| (id == conta).then(|| "sk-teste-nao-real".to_string());

    let recusado = broker.redeem_with_account(&conta, 99, parent, load);
    assert!(matches!(
        recusado,
        Err(super::broker::BrokerError::Forbidden)
    ));
    for _ in 0..2 {
        assert_eq!(
            broker
                .redeem_with_account(&conta, 43, parent, load)
                .unwrap(),
            "sk-teste-nao-real",
            "o helper pode renovar enquanto a sessão autorizada vive"
        );
    }
    broker.revoke_grant(&grant_b);
    assert!(broker.has_account_grant(&conta), "a sessão B não revoga A");
    assert_eq!(
        broker
            .redeem_with_account(&conta, 43, parent, load)
            .unwrap(),
        "sk-teste-nao-real"
    );
    assert!(broker
        .redeem_with_account(&conta, 53, parent, load)
        .is_err());

    broker.revoke_grant(&grant_a);
    assert!(!broker.has_account_grant(&conta));
    assert!(broker
        .redeem_with_account(&conta, 43, parent, load)
        .is_err(), "uma sessão encerrada perde o acesso");
}

#[test]
fn se_lee_lo_que_dicen_las_clis_sobre_el_login() {
    use super::health::{
        HealthStatus, http_health, parse_claude_status, parse_codex_status, parse_opencode_list,
    };

    // Salidas reales de `claude auth status --json` (2.1.x).
    let ok = parse_claude_status(
        r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "vos@empresa.com", "subscriptionType": "max"}"#,
    );
    assert_eq!(ok.status, HealthStatus::Ok);
    assert_eq!(ok.email.as_deref(), Some("vos@empresa.com"));
    assert_eq!(ok.plan.as_deref(), Some("max"));
    let sin_login = parse_claude_status(r#"{"loggedIn": false, "authMethod": "none"}"#);
    assert_eq!(sin_login.status, HealthStatus::NotLoggedIn);
    let por_key = parse_claude_status(
        r#"{"loggedIn": true, "authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"}"#,
    );
    assert_eq!(por_key.detail, "api_key (ANTHROPIC_API_KEY)");
    assert_eq!(
        parse_claude_status("no es json").status,
        HealthStatus::Unknown
    );

    // `codex login status` (0.159).
    assert_eq!(
        parse_codex_status(true, "Logged in using ChatGPT\n").status,
        HealthStatus::Ok
    );
    let codex_sin = parse_codex_status(false, "WARNING: proceeding, even though…\nNot logged in\n");
    assert_eq!(
        (codex_sin.status, codex_sin.detail.as_str()),
        (HealthStatus::NotLoggedIn, "Not logged in")
    );
    // 0.164 cambió la línea de la API key: ya no empieza con "Logged in".
    assert_eq!(
        parse_codex_status(true, "API key configured - sk-prueb***-1234\n").status,
        HealthStatus::Ok
    );
    assert_eq!(
        parse_codex_status(false, "API key configured - sk-prueb***-1234\n").status,
        HealthStatus::NotLoggedIn
    );

    // `opencode auth list` (1.18), con sus colores.
    let con = parse_opencode_list(
        "\u{1b}[34m●\u{1b}[39m  OpenCode Go \u{1b}[90mapi\n\u{1b}[90m└\u{1b}[39m  5 credentials\n",
    );
    assert_eq!(
        (con.status, con.detail.as_str()),
        (HealthStatus::Ok, "5 credentials")
    );
    assert_eq!(
        parse_opencode_list("\u{1b}[90m└\u{1b}[39m  0 credentials\n").status,
        HealthStatus::NotLoggedIn
    );

    // La key contra `/v1/models`.
    assert_eq!(http_health(200, false).status, HealthStatus::Ok);
    assert_eq!(http_health(401, false).status, HealthStatus::Invalid);
    assert_eq!(http_health(403, true).status, HealthStatus::Invalid);
    assert_eq!(http_health(529, false).status, HealthStatus::Unknown);
}

/// Conta Codex por API key não cria `auth.json`: a chave fica no keyring falso usado no teste.
#[test]
fn conta_codex_api_key_fica_no_keyring_sem_auth_json() {
    fake_keyring();
    let dir = TempDir::new();
    let account_id = format!("test-{}", uuid::Uuid::new_v4());
    let key = "sk-teste-nao-real-1234";
    super::secrets::save(&account_id, key).unwrap();
    let env = super::store::account_env_from_row(
        &account_id,
        "codex",
        &dir.path().to_string_lossy(),
        "api_key",
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        env.get("CODEX_HOME").map(String::as_str),
        Some(dir.path().to_string_lossy().as_ref())
    );
    assert!(!env.contains_key("CODEX_API_KEY"));
    assert!(!env.contains_key("OPENAI_API_KEY"));
    assert!(env.values().all(|value| value != key));
    assert!(!dir.path().join("auth.json").exists());
    super::secrets::delete(&account_id);
}

#[test]
fn migracao_codex_api_key_remove_o_segredo_do_auth_json_e_preserva_o_perfil() {
    fake_keyring();
    let dir = TempDir::new();
    let account_id = format!("test-{}", uuid::Uuid::new_v4());
    let auth = dir.path().join("auth.json");
    let secret = "sk-codex-falso-sem-uso-real";
    super::secrets::save(&account_id, "sk-keyring-antigo-nao-real").unwrap();
    std::fs::write(
        &auth,
        format!(r#"{{"auth_mode":"apikey","OPENAI_API_KEY":"{secret}","id_token":"preservar"}}"#),
    )
    .unwrap();

    let env = super::store::account_env_from_row(
        &account_id,
        "codex",
        &dir.path().to_string_lossy(),
        "api_key",
        None,
    )
    .unwrap()
    .unwrap();

    let body = std::fs::read_to_string(auth).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(saved["auth_mode"], "apikey");
    assert_eq!(saved["id_token"], "preservar");
    assert!(saved.get("OPENAI_API_KEY").is_none());
    assert!(!body.contains(secret));
    assert_eq!(super::secrets::load(&account_id).as_deref(), Some(secret));
    assert!(!env.contains_key("OPENAI_API_KEY"));
    super::secrets::delete(&account_id);
}

#[test]
fn erro_ao_preparar_home_antigravity_impede_lancamento_completo() {
    let dir = TempDir::new();
    dir.write("nao-e-pasta", "arquivo");
    let result = super::store::account_env_from_row(
        "antigravity-account",
        "antigravity",
        &dir.path().join("nao-e-pasta").to_string_lossy(),
        "login",
        None,
    );
    assert!(
        result.is_err(),
        "não pode lançar com HOME parcial depois de falha na preparação"
    );
}

// ── Antigravity: conta por HOME isolado ──────────────────────────

/// O marcador do Antigravity é a própria credencial: só se confere que existe, não se abre.
#[cfg(target_os = "macos")]
#[test]
fn antigravity_reconhece_o_login_pela_presenca_do_arquivo() {
    let tmp = TempDir::new();
    let spec = spec("antigravity");
    assert_eq!(spec.env_var, "HOME");
    assert_eq!(read_identity(tmp.path(), spec), (false, None));
    tmp.write(".gemini/antigravity-acp/antigravity-oauth-token", "");
    assert_eq!(
        read_identity(tmp.path(), spec),
        (false, None),
        "vazio não prova login"
    );
    tmp.write(".gemini/antigravity-acp/acp_token.json", "{\"x\":1}");
    // Sem rótulo: o e-mail só existiria abrindo a credencial.
    assert_eq!(read_identity(tmp.path(), spec), (true, None));
}

#[cfg(target_os = "macos")]
#[test]
fn a_conta_do_sistema_do_antigravity_e_o_proprio_home() {
    let spec = spec("antigravity");
    assert_eq!(default_dir(spec), dirs::home_dir());
}

#[test]
fn saude_do_antigravity_le_a_resposta_do_agy_models() {
    use super::health::{HealthStatus, parse_antigravity_models};
    let ok = parse_antigravity_models(
        true,
        "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n",
    );
    assert_eq!(ok.status, HealthStatus::Ok);
    assert_eq!(ok.detail, "2 models");
    let off = parse_antigravity_models(
        true,
        "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
    );
    assert_eq!(off.status, HealthStatus::NotLoggedIn);
    let unknown = parse_antigravity_models(false, "dial tcp: lookup failed\n");
    assert_eq!(unknown.status, HealthStatus::Unknown);
}

/// A Frota roda o `agy` num home temporário e não aplica o da conta: não pode oferecer contas.
#[test]
fn a_frota_nao_oferece_contas_do_antigravity() {
    let caps = crate::agents::adapter_for("antigravity")
        .unwrap()
        .capabilities();
    assert!(!caps.accounts);
    assert!(caps.headless);
}
