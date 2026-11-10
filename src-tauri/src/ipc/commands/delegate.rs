//! `harness.delegate`: `delegate_agent` com `target = connected_session` (Fase 4, contrato §12).
//!
//! Entrega o trabalho a uma sessão que já está aberta e ligada ao time do orquestrador, pelo mesmo
//! caminho do `peer tell`/`peer ask`. Aqui só há a cola com o app: o que a sessão é agora
//! (`team::delegation_snapshot`) e o envio. A decisão, o recibo e a idempotência estão em
//! `harness::delegate`, provados sem o app.
//!
//! Nada é escrito na sessão antes de a revalidação passar, e a resposta dela é dado não confiável.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{peers, team};
use crate::database::DbConnection;
use crate::harness::delegate::{self, DelegateError, Mode, SendResult, SessionRequest};

/// `harness.delegate`: o erro volta como `<código>: <mensagem>`.
pub(super) fn delegate_session(app: &AppHandle, args: &Value) -> Result<Value, String> {
    run(app, args).map_err(|error| error.render())
}

fn run(app: &AppHandle, args: &Value) -> Result<Value, DelegateError> {
    let from = peers::caller(args).map_err(|error| DelegateError::new(delegate::code::CALLER_NOT_OPEN, error))?;
    let request = SessionRequest::from_args(args)?;
    let db: DbConnection = super::shared::db(app)
        .map_err(|error| DelegateError::new(delegate::code::SNAPSHOT_FAILED, error))?
        .inner()
        .clone();
    // O recibo é de quem chamou de verdade (a aba), nunca de um campo que o modelo escolheu.
    let identity = request.identity(&format!("tab:{from}"));
    delegate::dispatch(
        &db,
        &identity,
        &crate::util::now_ts_ms,
        || revalidate(app, &db, &from, &request),
        |target| send(app, &from, target, &request),
    )
}

/// A revalidação do instante do envio: lê as sessões de novo e confere tudo antes de escrever. Uma aba
/// que o registro de PTYs do backend ainda não conhece é perguntada à janela (`deep_for`).
fn revalidate(app: &AppHandle, db: &DbConnection, from: &str, request: &SessionRequest) -> Result<String, DelegateError> {
    let (caller, sessions) = team::delegation_snapshot(app, db, from, Some(&request.to))?;
    let session = delegate::resolve_session(&request.to, &sessions)?;
    delegate::check_session(&caller, session, &request.options())?;
    Ok(session.id.clone())
}

fn send(app: &AppHandle, from: &str, target: &str, request: &SessionRequest) -> SendResult {
    let mut args = json!({
        "from": from,
        "to": target,
        "task": request.prompt,
        // O mesmo id do pedido: a fila do `peer` também não digita duas vezes.
        "id": format!("delegate:{}", request.request_id),
    });
    if let Some(constraints) = &request.constraints {
        args["constraints"] = json!(constraints);
    }
    if let Some(expecting) = &request.expecting {
        args["expecting"] = json!(expecting);
    }
    let reply = match request.mode {
        Mode::Async => peers::peer_tell(app, &args),
        Mode::Wait => {
            args["timeout"] = json!(request.timeout_s);
            peers::peer_ask(app, &args)
        }
    };
    match reply {
        Ok(value) => delegate::classify_peer_reply(&value),
        // Um erro depois de a mensagem entrar na fila não prova que nada saiu: nunca repetir às cegas.
        Err(error) => SendResult::Unknown(error),
    }
}
