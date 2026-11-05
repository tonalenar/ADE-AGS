//! O terminal do painel do chat pelo `ags tab create`/`tab send`: quem chama de uma conversa recebe o
//! shell da conversa, e o que se digita num shell vai cru (sem as heurísticas de TUI nem a ficha do
//! ponto de restauração).

use serde_json::json;

use super::tabs::{chat_terminal_target, submit_style, ChatTerminal, SubmitStyle};

#[test]
fn conversa_do_chat_pedindo_um_shell_ganha_o_terminal_do_painel() {
    let args = json!({ "from": "thread:abc", "agent": "bash", "cwd": "/repo" });
    assert_eq!(chat_terminal_target(&args), Ok(Some(ChatTerminal::Thread("abc".into()))));
}

#[test]
fn conversa_pedindo_um_agente_abre_uma_aba_normal() {
    let args = json!({ "from": "thread:abc", "agent": "claude-code", "cwd": "/repo" });
    assert_eq!(chat_terminal_target(&args), Ok(None));
}

#[test]
fn new_tab_tira_o_shell_do_painel() {
    let args = json!({ "from": "thread:abc", "agent": "bash", "newTab": true });
    assert_eq!(chat_terminal_target(&args), Ok(None));
}

#[test]
fn aba_comum_pedindo_um_shell_segue_abrindo_uma_aba() {
    let args = json!({ "from": "tab-1", "agent": "bash", "cwd": "/repo" });
    assert_eq!(chat_terminal_target(&args), Ok(None));
    assert_eq!(chat_terminal_target(&json!({ "agent": "bash", "cwd": "/repo" })), Ok(None));
}

#[test]
fn in_chat_explicito_vale_de_uma_aba_e_dispensa_o_agente() {
    let args = json!({ "from": "tab-1", "inChat": true });
    assert_eq!(chat_terminal_target(&args), Ok(Some(ChatTerminal::Tab("tab-1".into()))));
    let args = json!({ "from": "thread:abc", "inChat": true });
    assert_eq!(chat_terminal_target(&args), Ok(Some(ChatTerminal::Thread("abc".into()))));
}

#[test]
fn in_chat_sem_quem_chama_ou_com_um_agente_e_erro() {
    assert!(chat_terminal_target(&json!({ "inChat": true })).unwrap_err().contains("ADE_TAB_ID"));
    assert!(chat_terminal_target(&json!({ "from": "", "inChat": true })).is_err());
    assert!(chat_terminal_target(&json!({ "from": "thread:", "inChat": true })).is_err());
    assert!(chat_terminal_target(&json!({ "from": "thread:abc", "inChat": true, "agent": "codex" }))
        .unwrap_err()
        .contains("--agent bash"));
    assert!(chat_terminal_target(&json!({ "from": "thread:abc", "inChat": true, "newTab": true })).is_err());
}

#[test]
fn shell_recebe_a_linha_crua_e_tui_o_envio_com_verificacao() {
    // Um prompt de senha ou de código não ecoa o que se digita: a verificação de TUI (o texto não
    // apareceu → escreve de novo) digitaria o código duas vezes.
    assert_eq!(submit_style(Some("bash")), SubmitStyle::Line);
    assert_eq!(submit_style(Some("claude-code")), SubmitStyle::Prompt);
    assert_eq!(submit_style(None), SubmitStyle::Prompt);
}
