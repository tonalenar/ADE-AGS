//! Sessão de terminal emitida pelo app.
//!
//! Cada PTY de uma aba recebe um token (`ADE_SESSION`) que só o processo
//! daquele terminal herda. A CLI manda o token junto com `ADE_TAB_ID`. O
//! servidor aceita a aba somente se o token estiver vivo e, quando a aba
//! vier preenchida, for a mesma que o app amarrou ao token. Um `ADE_TAB_ID`
//! forjado é recusado.
//!
//! Terminais restaurados reanexam o PTY que já está vivo: o processo
//! conserva o ambiente e este registro conserva o token. Um PTY novo para a
//! mesma aba troca o token; o antigo deixa de valer. No Windows o token vai
//! no bloco de ambiente do `CreateProcess`, igual ao Unix. O sandbox do
//! Codex descarta variáveis que não conhece, então o lançamento também passa
//! o token em `shell_environment_policy.set`, como já acontece com `ADE_TAB_ID`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// Nome da variável que o app grava no PTY e a CLI lê. O agente não escolhe o valor.
pub const SESSION_ENV: &str = "ADE_SESSION";

const ERR_MISSING: &str = "Este comando só funciona dentro de um terminal do ADE AGS (sessão do terminal ausente).";
const ERR_UNKNOWN: &str = "A sessão deste terminal não é reconhecida. Reabra o terminal da aba.";
const ERR_FORGED: &str = "ADE_TAB_ID não corresponde a este terminal.";

struct Sessions {
    by_token: HashMap<String, String>,
    by_tab: HashMap<String, String>,
}

fn registry() -> MutexGuard<'static, Sessions> {
    static REGISTRY: LazyLock<Mutex<Sessions>> = LazyLock::new(|| {
        Mutex::new(Sessions {
            by_token: HashMap::new(),
            by_tab: HashMap::new(),
        })
    });
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Publica o token já gerado para o PTY desta aba. Substitui o token anterior
/// da mesma aba (o terminal foi recriado; o processo antigo não vale mais).
pub(crate) fn publish_token(tab_id: &str, token: &str) {
    let mut sessions = registry();
    if let Some(previous) = sessions.by_tab.insert(tab_id.to_string(), token.to_string()) {
        if previous != token {
            sessions.by_token.remove(&previous);
        }
    }
    sessions.by_token.insert(token.to_string(), tab_id.to_string());
}

/// O PTY saiu do registro (fechou, foi substituído ou a app encerrou a sessão).
pub(crate) fn release_token(token: &str) {
    let mut sessions = registry();
    if let Some(tab) = sessions.by_token.remove(token) {
        if sessions.by_tab.get(&tab).map(String::as_str) == Some(token) {
            sessions.by_tab.remove(&tab);
        }
    }
}

/// A aba que este terminal realmente é.
///
/// `claimed_tab` é o `ADE_TAB_ID` que a CLI enviou. Se vier vazio, vale a aba
/// amarrada ao token: o agente não escolhe outra. Se vier preenchido e for
/// diferente, a chamada é recusada.
pub fn verified_tab(session: Option<&str>, claimed_tab: Option<&str>) -> Result<String, String> {
    let Some(session) = session.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(ERR_MISSING.into());
    };
    let Some(bound) = registry().by_token.get(session).cloned() else {
        return Err(ERR_UNKNOWN.into());
    };
    if let Some(claimed) = claimed_tab.map(str::trim).filter(|value| !value.is_empty()) {
        if claimed != bound {
            return Err(ERR_FORGED.into());
        }
    }
    Ok(bound)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Issued {
        tab: String,
        token: String,
    }

    impl Issued {
        fn new(label: &str) -> Self {
            let tab = format!("{label}-{}", uuid::Uuid::new_v4());
            let token = uuid::Uuid::new_v4().to_string();
            publish_token(&tab, &token);
            Self { tab, token }
        }
    }

    impl Drop for Issued {
        fn drop(&mut self) {
            release_token(&self.token);
        }
    }

    #[test]
    fn forged_ade_tab_id_is_rejected() {
        let issued = Issued::new("forged");
        let err = verified_tab(Some(&issued.token), Some("other-tab")).unwrap_err();
        assert!(err.contains("ADE_TAB_ID"), "{err}");
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), None).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), Some("  ")).unwrap(), issued.tab);
    }

    #[test]
    fn missing_or_unknown_session_is_rejected() {
        let issued = Issued::new("unknown");
        assert!(verified_tab(None, Some(&issued.tab)).unwrap_err().contains("ausente"));
        assert!(verified_tab(Some(""), Some(&issued.tab)).unwrap_err().contains("ausente"));
        assert!(verified_tab(Some("not-a-session"), Some(&issued.tab)).unwrap_err().contains("não é reconhecida"));
    }

    #[test]
    fn reattached_terminal_keeps_its_token() {
        let issued = Issued::new("reattach");
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
    }

    #[test]
    fn replaced_terminal_invalidates_the_previous_token() {
        let tab = format!("replaced-{}", uuid::Uuid::new_v4());
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        publish_token(&tab, &first);
        publish_token(&tab, &second);
        assert!(verified_tab(Some(&first), Some(&tab)).is_err());
        assert_eq!(verified_tab(Some(&second), Some(&tab)).unwrap(), tab);
        release_token(&second);
        assert!(verified_tab(Some(&second), Some(&tab)).unwrap_err().contains("não é reconhecida"));
    }
}
