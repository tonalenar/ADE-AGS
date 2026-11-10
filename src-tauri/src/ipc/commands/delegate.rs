//! `team.delegate` (`ags team delegate`): `delegate_agent` com `target = connected_session` (Fase 4, contrato §12).
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
use crate::harness::child_delivery;
use crate::harness::delegate::{self, DelegateError, Mode, SendResult, SessionRequest};

/// `team.delegate`: o erro volta como `<código>: <mensagem>`.
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
    let response = delegate::dispatch(
        &db,
        &identity,
        &crate::util::now_ts_ms,
        || revalidate(app, &db, &from, &request),
        |target| send(app, &from, target, &request),
    )?;
    watch_result(&db, &from, &request, &response);
    Ok(response)
}

/// `mode = async`: o resultado da sessão chega ao pai quando ela terminar (contrato §12.9). Só depois de a mensagem
/// ter sido aceita; a repetição do mesmo pedido (recibo `accepted`) também registra, o que cura uma queda entre
/// enviar e registrar. Falhar aqui nunca desfaz a delegação: a resposta da sessão segue pelo canal de sempre.
fn watch_result(db: &DbConnection, from: &str, request: &SessionRequest, response: &Value) {
    if request.mode != Mode::Async || response.get("deliveryState").and_then(Value::as_str) != Some("accepted") {
        return;
    }
    let Some(session) = response.get("to").and_then(Value::as_str) else { return };
    let Ok(conn) = db.lock() else { return };
    let parent_ref = child_delivery::parent_ref_of_caller(from);
    let child_ref = format!("{session}#{}", request.request_id);
    let title = request.to.clone();
    let agent = child_delivery::session_agent(&conn, session);
    let turn = child_delivery::current_turn(&conn, &parent_ref).ok().flatten();
    let spec = child_delivery::WatchSpec {
        kind: delegate::Target::ConnectedSession,
        child_ref: &child_ref,
        parent_ref: &parent_ref,
        title: &title,
        agent_id: &agent,
        parent_turn_id: turn.as_deref(),
        session_id: Some(session),
        message_id: response.get("messageId").and_then(Value::as_i64),
    };
    if let Err(error) = child_delivery::register(&conn, &spec, crate::util::now_ts_ms()) {
        eprintln!("[harness] não foi possível acompanhar a sessão delegada: {error}");
    }
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
