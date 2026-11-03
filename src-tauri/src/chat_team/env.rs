//! O ambiente do processo de uma conversa por protocolo (`codex app-server`, `claude -p`) para ela
//! poder usar o `ags` como integrante ou orquestrador de um time: quem ela é (`ADE_TAB_ID`, o id do
//! cartão `thread:<id>`) e onde está o `ags` (a pasta do app no PATH, como nos terminais).
//!
//! `ADE_TAB_ID` não é segurança (ver `ipc/commands/peers.rs`): é o alcance de trabalho. `ADE_SESSION`
//! também vai (decisão do usuário, P7): é o token de sessão que o app emite por processo, como nos
//! terminais, e dá à conversa a memória e o quadro da missão. Ele só existe na memória do app e no
//! ambiente do processo do motor: nunca em banco, arquivo, log ou URL. Não é segredo do keyring.
//! As ações do Jev e do computer use reconhecem a conversa pelo PID do motor (`register_process`), com
//! ou sem o token.

use std::ffi::OsString;

use super::model::THREAD_PREFIX;

/// As variáveis a pôr no processo da conversa `thread_id`.
pub fn thread_env(thread_id: &str) -> Vec<(String, OsString)> {
    let mut out = vec![("ADE_TAB_ID".to_string(), OsString::from(format!("{THREAD_PREFIX}{thread_id}")))];
    if let Some(token) = crate::terminal::issue_conversation_token(&format!("{THREAD_PREFIX}{thread_id}")) {
        out.push((crate::terminal::SESSION_ENV.to_string(), OsString::from(token)));
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    if let Some(path) = with_app_dir(&current) {
        out.push(("PATH".to_string(), path));
    }
    out
}

/// Registra o processo do motor da conversa: é com o PID dele que o app reconhece, sem token, quem chama
/// `sim act` e o computer use por esta conversa (`terminal::authorize_actor`).
pub fn register_process(thread_id: &str, pid: Option<u32>) {
    if let Some(pid) = pid {
        crate::terminal::register_conversation(&format!("{THREAD_PREFIX}{thread_id}"), pid);
    }
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

#[cfg(test)]
mod test {
    use super::*;

    fn value(env: &[(String, OsString)], key: &str) -> Option<String> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.to_string_lossy().into_owned())
    }

    #[test]
    fn a_conversa_recebe_tab_id_e_ade_session_que_valem_depois_do_registro_do_pid() {
        let id = format!("env-{}", uuid::Uuid::new_v4());
        let thread = format!("{THREAD_PREFIX}{id}");
        let env = thread_env(&id);
        assert_eq!(value(&env, "ADE_TAB_ID").as_deref(), Some(thread.as_str()));
        let token = value(&env, crate::terminal::SESSION_ENV).expect("a conversa recebe ADE_SESSION");
        // Antes de o motor ter PID, o token ainda não vale.
        assert!(crate::terminal::authorize(Some(&token), Some(&thread), Some(std::process::id())).is_err());
        register_process(&id, Some(std::process::id()));
        if crate::terminal::ancestry_required() {
            assert_eq!(crate::terminal::authorize(Some(&token), Some(&thread), Some(std::process::id())).unwrap(), thread);
            // Sem token, a conversa continua reconhecida pelo PID (sim act / desk act).
            assert_eq!(crate::terminal::authorize_actor(None, Some(&thread), Some(std::process::id())).unwrap(), thread);
            // O token de uma conversa não vale para outra.
            assert!(crate::terminal::authorize(Some(&token), Some(&format!("{THREAD_PREFIX}outra")), Some(std::process::id())).is_err());
        }
    }

    #[test]
    fn reiniciar_o_motor_troca_o_token_e_o_antigo_deixa_de_valer() {
        let id = format!("env-{}", uuid::Uuid::new_v4());
        let thread = format!("{THREAD_PREFIX}{id}");
        let first = value(&thread_env(&id), crate::terminal::SESSION_ENV).unwrap();
        register_process(&id, Some(std::process::id()));
        let second = value(&thread_env(&id), crate::terminal::SESSION_ENV).unwrap();
        assert_ne!(first, second);
        register_process(&id, Some(std::process::id()));
        assert!(crate::terminal::authorize(Some(&first), Some(&thread), None).unwrap_err().contains("não é reconhecida"));
        assert!(crate::terminal::authorize(Some(&second), Some(&thread), Some(std::process::id())).is_ok());
    }

    #[test]
    fn sem_pid_o_registro_nao_publica_o_token_nem_o_processo() {
        let id = format!("env-{}", uuid::Uuid::new_v4());
        let thread = format!("{THREAD_PREFIX}{id}");
        let token = value(&thread_env(&id), crate::terminal::SESSION_ENV).unwrap();
        register_process(&id, None);
        assert!(crate::terminal::authorize(Some(&token), Some(&thread), Some(std::process::id())).is_err());
    }
}
