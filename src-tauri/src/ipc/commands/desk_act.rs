//! `ags desk act`: computer use do Mac (a tela do usuário), com a mesma identidade do `sim act`:
//! terminal de aba (token + PID) ou conversa por protocolo (`thread:<id>` + PID do motor).
use crate::{
    computer_use,
    ipc::protocol::arg_str_opt,
};
use serde_json::{Value, json};
use tauri::AppHandle;

pub(super) fn act(app: &AppHandle, args: &Value) -> Result<Value, String> {
    // Parser e identidade vêm antes de qualquer captura, consulta paga ou pergunta à pessoa.
    let (request, timeout) = super::sim_act::parse(args)?;
    // A tela do Mac ainda não guarda a grade de pixels: uma expectativa visual nunca se cumpriria.
    if !request.visual.is_empty() {
        return Err("--expect visual: só vale no simulador iOS por enquanto; no Mac use text:.".into());
    }
    let session = arg_str_opt(args, "session").filter(|s| !s.trim().is_empty());
    let client_pid = crate::ipc::current_client_pid();
    let from = crate::terminal::authorize_actor(
        session.as_deref(),
        args.get("from").and_then(Value::as_str),
        client_pid,
    )?;
    let db = super::shared::db(app)?.inner().clone();
    let report = computer_use::desktop::act(
        app,
        db,
        computer_use::desktop::Caller { tab: from, session, client_pid },
        &request,
        timeout,
    )?;
    let text = format!(
        "{}\nAções tentadas: {}. Observações: {}. Chamadas ao decisor: {}.",
        report.reason,
        report.actions.len(),
        report.observations,
        report.queries
    );
    Ok(json!({"text": text, "report": report}))
}
