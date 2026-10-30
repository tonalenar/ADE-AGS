//! O núcleo das conversas por protocolo: o que a tela (comandos Tauri, `commands`), a CLI `ags chat`
//! e o MCP fazem, pelo mesmo caminho. Recebe o app e o banco; nunca segura o lock do banco durante
//! o I/O com o agente.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::store::{self, RequestRow, ThreadRow, Tuning};
use super::{claude, codex, codex_map};

/// Quem fala com o agente de uma conversa por protocolo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// `codex app-server` (`codex.rs`).
    Codex,
    /// `claude -p` em stream-json (`claude.rs`).
    Claude,
}

impl Engine {
    pub fn of(agent_id: &str) -> Option<Engine> {
        match agent_id {
            "codex" => Some(Engine::Codex),
            "claude-code" => Some(Engine::Claude),
            _ => None,
        }
    }

    /// Os acessos que o agente aceita. O Plano é um modo de permissão só do Claude.
    pub fn accepts(self, access: &str) -> bool {
        matches!(access, "ask" | "edits" | "safe" | "full") || (self == Engine::Claude && access == "plan")
    }
}

/// Os agentes que falam por protocolo no chat.
pub fn structured_agent(agent_id: &str) -> bool {
    Engine::of(agent_id).is_some()
}

fn engine_for(agent_id: &str) -> Result<Engine, String> {
    Engine::of(agent_id).ok_or_else(|| format!("{agent_id} não conversa por protocolo"))
}

fn engine_of(row: &ThreadRow) -> Result<Engine, String> {
    engine_for(&row.agent_id)
}

/// O turno em andamento de uma conversa, em qualquer um dos agentes. `None` = sem processo aberto.
fn live_turn(thread_id: &str) -> Option<Option<String>> {
    codex::get(thread_id).map(|s| s.turn()).or_else(|| claude::get(thread_id).map(|s| s.turn()))
}

/// Fecha o processo do agente da conversa, qualquer que seja.
fn close(thread_id: &str) {
    codex::close(thread_id);
    claude::close(thread_id);
}

fn db_err(e: impl ToString) -> String {
    e.to_string()
}

pub fn threads(db: &DbConnection) -> Result<Vec<ThreadRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::threads(&conn).map_err(db_err)
}

pub fn thread(db: &DbConnection, thread_id: &str) -> Result<ThreadRow, String> {
    let conn = db.lock().map_err(db_err)?;
    store::thread(&conn, thread_id).map_err(db_err)?.ok_or_else(|| format!("Conversa {thread_id} não encontrada"))
}

/// O que se escolhe ao abrir uma conversa.
#[derive(Clone, Debug)]
pub struct NewThread {
    pub agent_id: String,
    pub cwd: String,
    pub title: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: String,
    pub account_id: Option<String>,
}

pub fn create(db: &DbConnection, input: NewThread) -> Result<ThreadRow, String> {
    if !structured_agent(&input.agent_id) {
        return Err(format!("{} ainda não conversa por protocolo", input.agent_id));
    }
    let engine = engine_for(&input.agent_id)?;
    if !engine.accepts(&input.access) {
        return Err(access_error(engine, &input.access));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().map_err(db_err)?;
    let tuning = Tuning { model: input.model, effort: input.effort, access: input.access };
    store::insert_thread(&conn, &id, &input.agent_id, &input.cwd, &input.title, &tuning, input.account_id.as_deref(), crate::util::now_ts_ms())
        .map_err(db_err)
}

fn access_error(engine: Engine, access: &str) -> String {
    match engine {
        Engine::Claude => format!("Acesso inválido: {access} (ask, edits, safe, full ou plan)"),
        Engine::Codex => format!("Acesso inválido: {access} (ask, edits, safe ou full)"),
    }
}

/// Avisa a tela que a lista mudou (uma conversa criada fora dela, pela CLI).
pub fn announce(app: &AppHandle, row: &ThreadRow) {
    let _ = app.emit(codex::EVENT, json!({ "threadId": row.id, "type": "created", "thread": row }));
}

/// Manda uma mensagem: começa um turno, ou entra no turno em andamento (`turn/steer`).
pub async fn send(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str) -> Result<(), String> {
    let row = thread(db, thread_id)?;
    if engine_of(&row)? == Engine::Claude {
        let session = claude::session(app, db, thread_id).await?;
        return claude::send_user(app, db, &session, text);
    }
    let session = codex::session(app, db, thread_id).await?;
    let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
    let input = json!([{ "type": "text", "text": text, "text_elements": [] }]);
    if let Some(turn) = session.turn() {
        session.request("turn/steer", json!({ "threadId": remote, "input": input, "expectedTurnId": turn })).await?;
        return Ok(());
    }
    let row = {
        let conn = db.lock().map_err(db_err)?;
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
        store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?
    };
    let (approval, _) = codex_map::access_policy(&row.access);
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

pub fn items(db: &DbConnection, thread_id: &str) -> Result<Vec<Item>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::items(&conn, thread_id).map_err(db_err)
}

pub fn requests(db: &DbConnection, thread_id: &str) -> Result<Vec<RequestRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::pending_requests(&conn, thread_id).map_err(db_err)
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    /// O processo do agente está aberto.
    pub alive: bool,
    /// Há um turno em andamento.
    pub working: bool,
}

pub fn status(thread_id: &str) -> ThreadStatus {
    match live_turn(thread_id) {
        Some(turn) => ThreadStatus { alive: true, working: turn.is_some() },
        None => ThreadStatus { alive: false, working: false },
    }
}

/// Para o turno em andamento.
pub async fn interrupt(thread_id: &str) -> Result<(), String> {
    if let Some(session) = claude::get(thread_id) {
        return claude::interrupt(&session).await;
    }
    let Some(session) = codex::get(thread_id) else { return Ok(()) };
    let (Some(remote), Some(turn)) = (session.remote(), session.turn()) else { return Ok(()) };
    session.request("turn/interrupt", json!({ "threadId": remote, "turnId": turn })).await.map(|_| ())
}

/// Responde a um pedido do agente: `allow`, `allowSession` ou `deny` numa aprovação; o texto da
/// resposta numa pergunta. `false` se o pedido já não estava pendente.
pub fn answer(app: &AppHandle, db: &DbConnection, request_id: &str, choice: &str) -> Result<bool, String> {
    let row = {
        let conn = db.lock().map_err(db_err)?;
        store::request(&conn, request_id).map_err(db_err)?.ok_or("Pedido não encontrado")?
    };
    if row.state != "pending" {
        return Ok(false);
    }
    let rpc_id: Value = serde_json::from_str(&row.rpc_id).map_err(db_err)?;
    if let Some(session) = claude::get(&row.thread_id) {
        claude::answer(app, db, &session, &rpc_id, row.item_id.as_deref(), choice)?;
    } else {
        let session = codex::get(&row.thread_id).ok_or("O agente desta conversa já fechou")?;
        session.respond(rpc_id, codex_map::answer_of(&row.kind, choice, &row.options))?;
    }
    let answered = {
        let conn = db.lock().map_err(db_err)?;
        store::answer_request(&conn, request_id, choice, crate::util::now_ts_ms()).map_err(db_err)?
    };
    let _ = app.emit(codex::EVENT, json!({ "threadId": row.thread_id, "type": "requestResolved", "id": request_id }));
    Ok(answered)
}

/// Troca modelo, esforço ou acesso (no Claude, o Plano também é um acesso).
/// - Codex: modelo e esforço valem no próximo turno; o acesso muda o sandbox, que é da sessão: com
///   o agente parado, a sessão fecha e reabre (retomando a thread) na próxima mensagem.
/// - Claude: tudo é flag do processo, então qualquer troca fecha a sessão (no fim do turno, se há
///   um) e a próxima mensagem a retoma (`--resume`) com as flags novas.
pub fn retune(db: &DbConnection, thread_id: &str, model: Option<String>, effort: Option<String>, access: String) -> Result<ThreadRow, String> {
    let conn = db.lock().map_err(db_err)?;
    let before = store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    let engine = engine_of(&before)?;
    if !engine.accepts(&access) {
        return Err(access_error(engine, &access));
    }
    let working = live_turn(thread_id).is_some_and(|turn| turn.is_some());
    if working && before.access != access {
        return Err("Para trocar o acesso, espere o agente terminar o turno.".into());
    }
    let changed = before.model != model || before.effort != effort || before.access != access;
    store::set_tuning(&conn, thread_id, &Tuning { model, effort, access: access.clone() }, crate::util::now_ts_ms()).map_err(db_err)?;
    let row = store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    drop(conn);
    match engine {
        Engine::Codex if before.access != access => codex::close(thread_id),
        Engine::Claude if changed => {
            if let Some(session) = claude::get(thread_id) {
                session.retire();
            }
        }
        _ => {}
    }
    Ok(row)
}

pub fn rename(db: &DbConnection, thread_id: &str, title: &str) -> Result<(), String> {
    let conn = db.lock().map_err(db_err)?;
    store::set_title(&conn, thread_id, title.trim()).map_err(db_err)
}

/// Conclui (fecha o processo do agente; dá para reabrir: a próxima mensagem retoma a thread) ou reabre.
pub fn settle(db: &DbConnection, thread_id: &str, settled: bool) -> Result<(), String> {
    {
        let conn = db.lock().map_err(db_err)?;
        store::set_state(&conn, thread_id, if settled { "settled" } else { "active" }, crate::util::now_ts_ms()).map_err(db_err)?;
    }
    if settled {
        close(thread_id);
    }
    Ok(())
}
