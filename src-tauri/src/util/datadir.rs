//! Diretório de dados do usuário (`~/.ags`) e a variante isolada da instância de debug.
//!
//! `ADE_AGS_DATA_DIR` (caminho absoluto) troca a raiz de dados inteira: banco, abas, canvas,
//! configurações, handshake do IPC (onde o `ags` acha a instância), MCP, memória etc. Sem a
//! variável nada muda: o app instalado continua em `~/.ags`. Worktrees e o target do cargo
//! seguem compartilhados de propósito (são checkouts git, não estado do app).

use std::ffi::OsString;
use std::path::PathBuf;

pub const DATA_DIR_ENV: &str = "ADE_AGS_DATA_DIR";

/// Pura: só aceita caminho absoluto; relativo ou vazio é ignorado (cairia no cwd do processo).
pub fn resolve(env: Option<OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    let custom = env.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty() && p.is_absolute());
    custom.or_else(|| home.map(|h| h.join(".ags")))
}

/// Raiz de dados desta instância.
pub fn ags_home() -> Option<PathBuf> {
    resolve(std::env::var_os(DATA_DIR_ENV), dirs::home_dir())
}

/// A instância roda com dados isolados?
pub fn is_isolated() -> bool {
    resolve(std::env::var_os(DATA_DIR_ENV), None).is_some()
}

/// Substituto de `app.path().app_data_dir()`: isolado fica em `<ADE_AGS_DATA_DIR>/app-data`
/// (contas de agentes, estado do navegador, forge), nunca no `%APPDATA%` do app instalado.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    if let Some(root) = resolve(std::env::var_os(DATA_DIR_ENV), None) {
        return Ok(root.join("app-data"));
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs() -> PathBuf {
        std::env::temp_dir().join("ags-iso")
    }

    #[test]
    fn sem_variavel_usa_home_ags() {
        assert_eq!(resolve(None, Some(PathBuf::from("/h"))), Some(PathBuf::from("/h").join(".ags")));
    }

    #[test]
    fn variavel_absoluta_vence_o_home() {
        assert_eq!(resolve(Some(abs().into()), Some(PathBuf::from("/h"))), Some(abs()));
    }

    #[test]
    fn variavel_vazia_ou_relativa_e_ignorada() {
        let h = Some(PathBuf::from("/h"));
        assert_eq!(resolve(Some("".into()), h.clone()), h.clone().map(|p| p.join(".ags")));
        assert_eq!(resolve(Some("rel/dir".into()), h.clone()), h.map(|p| p.join(".ags")));
    }

    #[test]
    fn isolado_exige_caminho_valido() {
        assert_eq!(resolve(Some(abs().into()), None), Some(abs()));
        assert_eq!(resolve(Some("rel".into()), None), None);
    }
}
