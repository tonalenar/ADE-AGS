//! Provas e escopos que o servidor consegue verificar, aplicados antes dos handlers (HOST_REMOTO.md, F-02 e F-09).
//!
//! O que o servidor **não** consegue provar fica de fora: `ADE_TAB_ID`, `from` e `taskId` são declarados pelo
//! chamador. O que ele prova é o PID do outro lado do canal de credencial (token de sessão + descendência do PTY,
//! da conversa ou da tarefa). Os predicados daqui são puros: recebem o quadro do canvas e o chamador já classificado.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::canvas::Boards;
use crate::terminal::Caller;

/// F-02: um `taskId` no pedido só vale se o PID do outro lado do canal é o processo do agente dessa tarefa (ou
/// descendente dele). Antes só se declarava: quem tinha o token agia como qualquer tarefa.
pub(crate) fn task_proof_error(args: &Value, client_pid: Option<u32>) -> Option<String> {
    let task_id = args.get("taskId").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty())?;
    crate::terminal::authorize_task(task_id, client_pid).err()
}

/// F-09: quem escreve numa aba. A pessoa no terminal dela (fora de todo processo do ADE) segue livre; um agente do ADE
/// só escreve em si, nas abas do canvas que o alcançam (`canvas::reachable`) e nas que ele mesmo abriu.
pub(crate) fn tab_send_error(boards: &Boards, caller: &Caller, target: &str, opened_by: Option<&str>) -> Option<String> {
    let Caller::Tab(me) = caller else { return None };
    if me == target || opened_by == Some(me.as_str()) || crate::canvas::reachable(boards, me).contains(target) {
        return None;
    }
    Some(format!(
        "A aba {target} não é sua nem do seu time: um agente só escreve em si, nas abas conectadas a ele no canvas e nas que ele mesmo abriu \
(`ags tab create`). Para falar com um agente conectado use `ags peer tell`; para outra aba, peça à pessoa que a conecte no canvas."
    ))
}

const FIX_DECIDE_SCREEN: &str = "Decidir depois do teto de rodadas de correção é do orquestrador da missão (a coroa no canvas, provada pelo terminal dele) \
ou da pessoa, pela tela da ADE AGS. Este chamador não prova nenhum dos dois: use a tela.";

/// Decidir o que fazer depois do teto de rodadas de correção é do orquestrador **daquela missão** (a coroa no canvas,
/// provada por token e PID) ou da pessoa, pela tela. `run:<id>` (Frota) só pela tela.
pub(crate) fn fix_decide_error(boards: &Boards, caller: &Caller, scope: &str) -> Option<String> {
    let Caller::Tab(me) = caller else { return Some(FIX_DECIDE_SCREEN.into()) };
    let Some(mission) = scope.strip_prefix("mission:") else { return Some(FIX_DECIDE_SCREEN.into()) };
    if !crate::canvas::is_orchestrator(boards, me) {
        return Some("Só o orquestrador da missão (a coroa no canvas) decide depois do teto de rodadas de correção; um integrante leva a dúvida a ele. A pessoa decide pela tela.".into());
    }
    if crate::canvas::mission_of_tab(boards, me).as_deref() != Some(mission) {
        return Some(format!("Você não é o orquestrador da missão {mission}: só o orquestrador dela decide, ou a pessoa pela tela."));
    }
    None
}

/// Quem abriu cada aba, por id. Em memória (some com o processo, como os PTYs) e com teto.
static OPENED: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const OPENED_MAX: usize = 4096;

/// Registra quem abriu a aba (só quando provado).
pub(crate) fn record_opened_tab(opener: &str, tab: &str) {
    let mut opened = OPENED.lock().unwrap_or_else(|e| e.into_inner());
    if opened.len() >= OPENED_MAX && !opened.contains_key(tab) {
        opened.clear();
    }
    opened.insert(tab.to_string(), opener.to_string());
}

pub(crate) fn opened_by(tab: &str) -> Option<String> {
    OPENED.lock().unwrap_or_else(|e| e.into_inner()).get(tab).cloned()
}
