//! `ccode notify "mensagem"`: um agente avisando o usuário de algo.
//!
//! Para quando o usuário pediu que o avisem ("me avise quando terminar", "me chame se os
//! testes falharem"): o agente não tem outro jeito de chamar atenção que não seja
//! escrever num terminal que ninguém está olhando.
//!
//! O aviso o mostra o frontend (é onde está a janela): um aviso na tela e, se a janela não
//! tem o foco, o sistema pede atenção (a barra de tarefas pisca, o Dock salta). Não é uma
//! notificação do sistema operacional de verdade: isso depende do plugin de notificações,
//! que vive na pilha de PRs do runtime e se liga aqui quando as duas pilhas se juntarem.
//!
//! Sem permissão nem conexão: avisar o usuário não toca em nada nem alcança ninguém. Em
//! troca, a mensagem é curta e o aviso diz de QUEM é, para que um agente não possa se passar
//! por outro.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::{caller, open_tabs};
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::protocol::arg_str;

/// O que cabe num aviso. Mais que isso é um relatório: vai numa nota ou no terminal.
const MAX_MESSAGE: usize = 280;

/// Limpa a mensagem: sem caracteres de controle (um agente não pode pintar o aviso nem
/// quebrá-lo) e cortada no limite. Devolve `None` se não sobra nada para dizer.
pub(crate) fn clean(message: &str) -> Option<String> {
    let text: String = message
        .chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_MESSAGE {
        return Some(text);
    }
    let cut: String = text.chars().take(MAX_MESSAGE - 1).collect();
    Some(format!("{cut}…"))
}

pub(super) fn notify_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let message = clean(&arg_str(args, "message")?)
        .ok_or_else(|| "A mensagem está vazia: diga o que o usuário precisa saber.".to_string())?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())?;

    let raw = ask_frontend_within(
        app,
        "user.notify",
        &json!({ "from": me.name, "tabId": me.id, "message": message }),
        Some(&me.window),
        std::time::Duration::from_secs(10),
    )?;
    unwrap_frontend_result(raw)?;
    Ok(json!({ "notified": true, "message": message }))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn junta_las_lineas_y_quita_los_controles() {
        assert_eq!(clean("  pronto\n\nos testes\tpassaram \x1b[31m ").unwrap(), "pronto os testes passaram [31m");
    }

    #[test]
    fn una_mensaje_vacia_no_avisa() {
        assert!(clean("").is_none());
        assert!(clean(" \n\t ").is_none());
        assert!(clean("\x07\x1b").is_none());
    }

    #[test]
    fn corta_lo_largo_sin_partir_un_caracter() {
        let long = "ã".repeat(500);
        let out = clean(&long).unwrap();
        assert_eq!(out.chars().count(), MAX_MESSAGE);
        assert!(out.ends_with('…'));
        assert!(clean(&"a".repeat(MAX_MESSAGE)).unwrap().chars().all(|c| c == 'a'));
    }
}
