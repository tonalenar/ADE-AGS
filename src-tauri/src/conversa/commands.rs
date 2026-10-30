//! Os comandos Tauri das conversas por protocolo (ver `conversa`). O processo do agente só sobe na
//! primeira mensagem (`chat_thread_send`).

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::codex;
use super::store::{self, RequestRow, ThreadRow, Tuning};

/// Os agentes que falam por protocolo no chat.
pub fn structured_agent(agent_id: &str) -> bool {
    agent_id == "codex"
}

fn db_err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub fn chat_threads(db: State<'_, DbConnection>) -> Result<Vec<ThreadRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::threads(&conn).map_err(db_err)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn chat_thread_create(
    db: State<'_, DbConnection>,
    agent_id: String,
    cwd: String,
    title: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    account_id: Option<String>,
) -> Result<ThreadRow, String> {
    if !structured_agent(&agent_id) {
        return Err(format!("{agent_id} ainda não conversa por protocolo"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(db_err)?;
    store::insert_thread(&conn, &id, &agent_id, &cwd, &title, &Tuning { model, effort, access }, account_id.as_deref(), crate::util::now_ts_ms())
        .map_err(db_err)
}

/// Manda uma mensagem: começa um turno, ou entra no turno em andamento (`turn/steer`).
#[tauri::command]
pub async fn chat_thread_send(app: AppHandle, db: State<'_, DbConnection>, thread_id: String, text: String) -> Result<(), String> {
    let db = db.inner().clone();
    let session = codex::session(&app, &db, &thread_id).await?;
    let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
    let input = json!([{ "type": "text", "text": text, "text_elements": [] }]);
    if let Some(turn) = session.turn() {
        session.request("turn/steer", json!({ "threadId": remote, "input": input, "expectedTurnId": turn })).await?;
        return Ok(());
    }
    let row = {
        let conn = db.lock().map_err(db_err)?;
        let _ = store::touch(&conn, &thread_id, crate::util::now_ts_ms());
        store::thread(&conn, &thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?
    };
    let (approval, _) = super::codex_map::access_policy(&row.access);
    let mut params = json!({ "threadId": remote, "input": input, "approvalPolicy": approval });
    if let Some(model) = &row.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &row.effort {
        params["effort"] = json!(effort);
    }
    session.request("turn/start", params).await?;
    Ok(())
}

#[tauri::command]
pub fn chat_thread_items(db: State<'_, DbConnection>, thread_id: String) -> Result<Vec<Item>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::items(&conn, &thread_id).map_err(db_err)
}

#[tauri::command]
pub fn chat_thread_requests(db: State<'_, DbConnection>, thread_id: String) -> Result<Vec<RequestRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::pending_requests(&conn, &thread_id).map_err(db_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    /// O processo do agente está aberto.
    pub alive: bool,
    /// Há um turno em andamento.
    pub working: bool,
}

#[tauri::command]
pub fn chat_thread_status(thread_id: String) -> ThreadStatus {
    match codex::get(&thread_id) {
        Some(s) => ThreadStatus { alive: true, working: s.turn().is_some() },
        None => ThreadStatus { alive: false, working: false },
    }
}

/// Para o turno em andamento (o "parar" do composer).
#[tauri::command]
pub async fn chat_thread_interrupt(thread_id: String) -> Result<(), String> {
    let Some(session) = codex::get(&thread_id) else { return Ok(()) };
    let (Some(remote), Some(turn)) = (session.remote(), session.turn()) else { return Ok(()) };
    session.request("turn/interrupt", json!({ "threadId": remote, "turnId": turn })).await.map(|_| ())
}

/// Responde a um pedido do agente: `allow`, `allowSession` ou `deny` numa aprovação; o texto da
/// resposta numa pergunta. `false` se o pedido já não estava pendente.
#[tauri::command]
pub fn chat_request_answer(app: AppHandle, db: State<'_, DbConnection>, request_id: String, choice: String) -> Result<bool, String> {
    let row = {
        let conn = db.lock().map_err(db_err)?;
        store::request(&conn, &request_id).map_err(db_err)?.ok_or("Pedido não encontrado")?
    };
    if row.state != "pending" {
        return Ok(false);
    }
    let session = codex::get(&row.thread_id).ok_or("O agente desta conversa já fechou")?;
    let rpc_id: Value = serde_json::from_str(&row.rpc_id).map_err(db_err)?;
    session.respond(rpc_id, super::codex_map::answer_of(&row.kind, &choice, &row.options))?;
    let answered = {
        let conn = db.lock().map_err(db_err)?;
        store::answer_request(&conn, &request_id, &choice, crate::util::now_ts_ms()).map_err(db_err)?
    };
    use tauri::Emitter;
    let _ = app.emit(codex::EVENT, json!({ "threadId": row.thread_id, "type": "requestResolved", "id": request_id }));
    Ok(answered)
}

/// Troca modelo, esforço ou acesso. Modelo e esforço valem no próximo turno; o acesso muda o
/// sandbox, que é da sessão: com o agente parado, a sessão fecha e reabre (retomando a thread) na
/// próxima mensagem.
#[tauri::command]
pub fn chat_thread_retune(db: State<'_, DbConnection>, thread_id: String, model: Option<String>, effort: Option<String>, access: String) -> Result<ThreadRow, String> {
    let conn = db.lock().map_err(db_err)?;
    let before = store::thread(&conn, &thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    let working = codex::get(&thread_id).is_some_and(|s| s.turn().is_some());
    if working && before.access != access {
        return Err("Para trocar o acesso, espere o agente terminar o turno.".into());
    }
    store::set_tuning(&conn, &thread_id, &Tuning { model, effort, access: access.clone() }, crate::util::now_ts_ms()).map_err(db_err)?;
    let row = store::thread(&conn, &thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    drop(conn);
    if before.access != access {
        codex::close(&thread_id);
    }
    Ok(row)
}

#[tauri::command]
pub fn chat_thread_rename(db: State<'_, DbConnection>, thread_id: String, title: String) -> Result<(), String> {
    let conn = db.lock().map_err(db_err)?;
    store::set_title(&conn, &thread_id, title.trim()).map_err(db_err)
}

/// Conclui (fecha o processo do agente; dá para reabrir: a próxima mensagem retoma a thread) ou reabre.
#[tauri::command]
pub fn chat_thread_settle(db: State<'_, DbConnection>, thread_id: String, settled: bool) -> Result<(), String> {
    {
        let conn = db.lock().map_err(db_err)?;
        store::set_state(&conn, &thread_id, if settled { "settled" } else { "active" }, crate::util::now_ts_ms()).map_err(db_err)?;
    }
    if settled {
        codex::close(&thread_id);
    }
    Ok(())
}
