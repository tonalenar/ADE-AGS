//! O ambiente do processo de uma conversa por protocolo (`codex app-server`, `claude -p`) para ela
//! poder usar o `ags` como integrante ou orquestrador de um time: quem ela é (`ADE_TAB_ID`, o id do
//! cartão `thread:<id>`) e onde está o `ags` (a pasta do app no PATH, como nos terminais).
//!
//! `ADE_TAB_ID` não é segurança (ver `ipc/commands/peers.rs`): é o alcance de trabalho. `ADE_SESSION`
//! não vai: a memória e o quadro da missão continuam só dos terminais.

use std::ffi::OsString;

use super::model::THREAD_PREFIX;

/// As variáveis a pôr no processo da conversa `thread_id`.
pub fn thread_env(thread_id: &str) -> Vec<(String, OsString)> {
    let mut out = vec![("ADE_TAB_ID".to_string(), OsString::from(format!("{THREAD_PREFIX}{thread_id}")))];
    let current = std::env::var_os("PATH").unwrap_or_default();
    if let Some(path) = with_app_dir(&current) {
        out.push(("PATH".to_string(), path));
    }
    out
}

/// O PATH com a pasta do executável do app no fim, se o `ags` estiver lá e ela ainda não estiver no
/// PATH (a mesma regra de `terminal::pty_manager::path_with_app_dir`). `None` = nada a mudar.
fn with_app_dir(current: &std::ffi::OsStr) -> Option<OsString> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    if !dir.join(if cfg!(windows) { "ags.exe" } else { "ags" }).is_file() {
        return None;
    }
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(current).collect();
    if dirs.contains(&dir) {
        return None;
    }
    dirs.push(dir);
    std::env::join_paths(dirs).ok()
}
