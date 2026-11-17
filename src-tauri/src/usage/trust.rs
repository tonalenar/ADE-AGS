//! Dónde se abre el sondeo del cupo, y por qué esa carpeta no pregunta nada.
//!
//! Claude Code pregunta "¿confiás en esta carpeta?" la primera vez que se abre en una.
//! Dentro de una PTY que nadie está mirando, ese diálogo es el sondeo colgado hasta que
//! vence el tiempo.
//!
//! Antes se esquivaba buscando entre las carpetas que la cuenta YA había aceptado y
//! abriendo el sondeo en una de ellas. Eso dependía de que hubiera alguna —una cuenta
//! recién creada no confía en ninguna— y encima leía la lista del lugar equivocado para la
//! cuenta principal (ver [`config_file`]), así que el panel se quedaba en "todavía no
//! confía en ninguna carpeta" sin nada que el usuario pudiera hacer al respecto.
//!
//! Ahora el sondeo tiene carpeta propia —una, vacía, de la app— y se la pre-aprueba en el
//! `.claude.json` de la cuenta antes de abrir. Es exactamente lo que habría quedado
//! escrito si el usuario aceptara el diálogo, sobre una carpeta que no tiene nada adentro:
//! no se le están dando permisos sobre ningún proyecto suyo. De paso el sondeo arranca más
//! rápido y más parejo, porque en una carpeta vacía no hay CLAUDE.md que leer ni MCP que
//! levantar.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

static TRUST_LOCK: Mutex<()> = Mutex::new(());

/// La carpeta donde se abre el sondeo: vacía, de la app, la misma para todas las cuentas.
///
/// Vive junto al resto de lo que la app guarda (`~/.ags`) y no en un temporal
/// porque tiene que ser ESTABLE: la ruta queda escrita como aceptada en la config de cada
/// cuenta, y una carpeta distinta en cada arranque iría dejando entradas muertas ahí.
pub(super) fn probe_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("No se pudo resolver la carpeta del usuario")?;
    let dir = home.join(".ags").join("usage-probe");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;

    // Resuelta a la ruta física: la TUI apunta sus proyectos por el `cwd` que le informa el
    // sistema, que ya viene sin symlinks. Si el home del usuario pasa por uno, la ruta que
    // dejamos aceptada y la que la TUI va a buscar serían dos strings distintos y el
    // diálogo volvería a aparecer.
    #[cfg(unix)]
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);

    Ok(dir)
}

/// El `.claude.json` de una cuenta.
///
/// No está donde la simetría haría pensar: con `CLAUDE_CONFIG_DIR` apuntado a un perfil el
/// archivo vive ADENTRO de ese directorio, pero la cuenta principal lo tiene en el home
/// (`~/.claude.json`), al lado de `~/.claude/` y no adentro. Buscarlo en
/// `~/.claude/.claude.json` era leer un archivo que no existe: por eso la cuenta principal
/// figuraba como que no confiaba en ninguna carpeta teniendo decenas aceptadas.
pub(super) fn config_file(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir {
        Some(dir) => Some(Path::new(dir).join(".claude.json")),
        None => dirs::home_dir().map(|home| home.join(".claude.json")),
    }
}

/// Cómo anota Claude Code una carpeta en `projects`: en Windows con barras NORMALES
/// (`C:/Users/ana/proyecto`), no con las del sistema. Si se escribe la forma con barras
/// invertidas, la TUI no encuentra la entrada, vuelve a preguntar "¿confiás en esta
/// carpeta?" y el sondeo se cuelga hasta vencer el tiempo — que es lo que dejó de funcionar
/// el panel de consumo en Windows.
pub(super) fn project_key(dir: &str) -> String {
    let windows_drive = dir.as_bytes().get(1) == Some(&b':');
    if windows_drive || dir.starts_with("\\\\") {
        dir.replace('\\', "/")
    } else {
        dir.to_string()
    }
}

/// La config con `dir` marcada como aceptada, o `None` si ya lo estaba.
///
/// Devolver `None` no es un detalle: es lo que hace que la app escriba el archivo una sola
/// vez por cuenta en vez de en cada sondeo. Esa config la escribe también la propia TUI
/// mientras corre, y cada escritura nuestra es una chance de pisarle algo.
pub(super) fn with_trusted(config: &Value, dir: &str) -> Option<Value> {
    let dir = project_key(dir);
    let dir = dir.as_str();
    let accepted = config
        .get("projects")
        .and_then(|p| p.get(dir))
        .and_then(|entry| entry.get("hasTrustDialogAccepted"))
        .and_then(Value::as_bool);
    if accepted == Some(true) {
        return None;
    }

    let mut next = if config.is_object() { config.clone() } else { json!({}) };
    {
        let root = next.as_object_mut()?;
        let projects = root.entry("projects").or_insert_with(|| json!({}));
        if !projects.is_object() {
            *projects = json!({});
        }
        let entry = projects
            .as_object_mut()?
            .entry(dir.to_string())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        let entry = entry.as_object_mut()?;
        entry.insert("hasTrustDialogAccepted".into(), json!(true));
        // El paseo de bienvenida de una carpeta nueva es otro diálogo que nadie puede
        // contestar desde la PTY del sondeo.
        entry.insert("projectOnboardingSeenCount".into(), json!(1));
    }
    Some(next)
}

/// Deja `dir` pre-aprobada para esa cuenta. No hace nada si ya lo estaba.
pub(super) fn trust_dir(config_path: &Path, dir: &str) -> Result<(), String> {
    let _guard = TRUST_LOCK.lock().map_err(|e| format!("Não foi possível bloquear a configuração do Claude: {e}"))?;
    // Só a ausência é normal; os demais erros protegem o login e os projetos do usuário.
    let config: Value = crate::util::user_json::read_user_json(config_path)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| json!({}));

    let Some(next) = with_trusted(&config, dir) else {
        return Ok(());
    };

    crate::util::user_json::write_user_json(config_path, &next)
}

/// Pré-aprova a pasta dos worktrees das missões na conta principal do Claude Code.
///
/// Os terminais de uma missão abrem o Claude num worktree novo a cada vez; sem isto a TUI
/// para em "Is this a project you trust?" (com "No, exit" marcado) e o time inteiro fica
/// parado. A TUI herda a confiança das pastas pai, então basta a raiz. Melhor esforço:
/// uma falha aqui não impede a missão, só deixa o diálogo aparecer.
pub(crate) fn trust_worktrees_root(base: &Path, account_dirs: &[String]) {
    let _ = std::fs::create_dir_all(base);
    let base = base.to_string_lossy();
    // Cada conta do Claude Code tem o seu `.claude.json` (CLAUDE_CONFIG_DIR): sem isto, um
    // membro do Squad que usa uma conta própria continuava parado no diálogo.
    let configs = std::iter::once(config_file(None))
        .chain(account_dirs.iter().map(|dir| config_file(Some(dir))));
    for config in configs.flatten() {
        let _ = trust_dir(&config, &base);
    }
}
