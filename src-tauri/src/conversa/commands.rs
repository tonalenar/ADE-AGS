//! Os comandos Tauri das conversas por protocolo: a tela chama o mesmo núcleo (`api`) que a CLI
//! `ags chat` e o MCP. O processo do agente só sobe na primeira mensagem (`chat_thread_send`).

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::api::{self, NewThread, ThreadStatus};
use super::store::{MessageSearchHit, RequestRow, ThreadRow};

#[tauri::command]
pub fn chat_threads(db: State<'_, DbConnection>) -> Result<Vec<ThreadRow>, String> {
    api::threads(&db)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn chat_thread_create(
    db: State<'_, DbConnection>,
    agent_id: String,
    cwd: String,
    workspace_id: Option<String>,
    title: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    account_id: Option<String>,
    parent_ref: Option<String>,
) -> Result<ThreadRow, String> {
    api::create(&db, NewThread { agent_id, cwd, workspace_id, title, model, effort, access, account_id, parent_ref })
}

/// Faz a pergunta lateral nascer como cópia da conversa de origem (fork nativo) ou diz que cai no recorte, e por quê.
/// Chamada depois de criar a pergunta e antes da primeira mensagem. A origem não é alterada nem interrompida.
#[tauri::command]
pub async fn chat_side_chat_fork(app: AppHandle, db: State<'_, DbConnection>, thread_id: String) -> Result<super::fork::Outcome, String> {
    let db = db.inner().clone();
    super::fork::fork_side_chat(&app, &db, &thread_id).await
}

#[tauri::command]
pub async fn chat_side_chat_delete(db: State<'_, DbConnection>, thread_id: String) -> Result<(), String> {
    let db = db.inner().clone();
    api::delete_side_chat(&db, &thread_id).await
}

#[tauri::command]
pub async fn chat_thread_send(
    app: AppHandle,
    db: State<'_, DbConnection>,
    thread_id: String,
    text: String,
    images: Option<Vec<String>>,
    client_request_id: Option<String>,
    fast_mode: Option<bool>,
) -> Result<Option<super::send_receipt::SendReceipt>, String> {
    let db = db.inner().clone();
    let images = images.unwrap_or_default();
    // `None` (cliente antigo) herda o nível que a conversa já usa.
    // Sem o id, o caminho é o de sempre e a resposta continua vazia (`null`).
    match client_request_id {
        Some(request_id) => api::send_with_request_and_fast_mode(&app, &db, &thread_id, &text, &images, "ui", &request_id, fast_mode).await.map(Some),
        None => api::send_with_fast_mode(&app, &db, &thread_id, &text, &images, fast_mode).await.map(|()| None),
    }
}

#[tauri::command]
pub fn chat_thread_items(db: State<'_, DbConnection>, thread_id: String) -> Result<Vec<Item>, String> {
    api::items(&db, &thread_id)
}

#[tauri::command]
pub fn chat_thread_search(db: State<'_, DbConnection>, query: String, limit: Option<usize>) -> Result<Vec<MessageSearchHit>, String> {
    api::search_messages(&db, &query, limit.unwrap_or(30))
}

#[tauri::command]
pub fn chat_thread_requests(db: State<'_, DbConnection>, thread_id: String) -> Result<Vec<RequestRow>, String> {
    api::requests(&db, &thread_id)
}

#[tauri::command]
pub fn chat_thread_status(thread_id: String) -> ThreadStatus {
    api::status(&thread_id)
}

#[tauri::command]
pub fn chat_thread_provider_config(thread_id: String) -> Option<Value> {
    super::opencode::provider_config(&thread_id)
}

#[tauri::command]
pub fn chat_thread_goal_get(db: State<'_, DbConnection>, thread_id: String) -> Result<Option<super::store::ThreadGoal>, String> {
    api::thread_goal(&db, &thread_id)
}

#[tauri::command]
pub async fn chat_thread_goal_action(
    app: AppHandle,
    db: State<'_, DbConnection>,
    thread_id: String,
    action: String,
    objective: Option<String>,
) -> Result<Option<super::store::ThreadGoal>, String> {
    let db = db.inner().clone();
    api::thread_goal_action(&app, &db, &thread_id, &action, objective.as_deref()).await
}

#[tauri::command]
pub async fn chat_thread_compact_context(app: AppHandle, db: State<'_, DbConnection>, thread_id: String, instructions: Option<String>) -> Result<(), String> {
    let db = db.inner().clone();
    api::compact_context(&app, &db, &thread_id, instructions.as_deref()).await
}

#[tauri::command]
pub async fn chat_thread_auto_compact_on_return(
    app: AppHandle,
    db: State<'_, DbConnection>,
    thread_id: String,
) -> Result<bool, String> {
    let db = db.inner().clone();
    api::auto_compact_on_return(&app, &db, &thread_id).await
}

#[tauri::command]
pub async fn chat_thread_clear_context(
    app: AppHandle,
    db: State<'_, DbConnection>,
    thread_id: String,
) -> Result<(), String> {
    let db = db.inner().clone();
    api::clear_context(&app, &db, &thread_id).await
}

/// O Parar da tela. Sem `client_request_id`, o caminho é o de sempre e a resposta é `null`; com ele, devolve o recibo
/// (contrato §11.11): repetir o id não manda outra interrupção.
#[tauri::command]
pub async fn chat_thread_interrupt(app: AppHandle, db: State<'_, DbConnection>, thread_id: String, client_request_id: Option<String>) -> Result<Option<super::stop_receipt::StopReceipt>, String> {
    let db = db.inner().clone();
    match client_request_id {
        Some(request_id) => api::stop_with_request(&app, &db, &thread_id, "ui", &request_id).await.map(Some),
        None => api::stop(&app, &db, &thread_id).await.map(|()| None),
    }
}

/// Para uma tarefa em segundo plano (um shell ou um subagente do Claude Code), sem parar o turno.
#[tauri::command]
pub async fn chat_task_stop(db: State<'_, DbConnection>, thread_id: String, task_id: String) -> Result<(), String> {
    let db = db.inner().clone();
    api::stop_task(&db, &thread_id, &task_id).await
}

/// O fim da saída de um shell em segundo plano (`{output, total_bytes, truncated}`).
#[tauri::command]
pub async fn chat_task_output(db: State<'_, DbConnection>, thread_id: String, task_id: String) -> Result<serde_json::Value, String> {
    let db = db.inner().clone();
    api::task_output(&db, &thread_id, &task_id).await
}

#[tauri::command]
pub fn chat_request_answer(app: AppHandle, db: State<'_, DbConnection>, request_id: String, choice: String) -> Result<bool, String> {
    api::answer(&app, &db, &request_id, &choice)
}

/// Reaplica a política do time e as regras da pessoa aos pedidos que esperam, de TODAS as conversas ativas (a janela
/// chama ao montar, depois de um reload). Devolve quantos respondeu. Idempotente.
#[tauri::command]
pub fn chat_requests_sweep(app: AppHandle, db: State<'_, DbConnection>) -> usize {
    super::permission::sweep(&app, &db)
}

#[tauri::command]
pub fn chat_thread_retune(db: State<'_, DbConnection>, thread_id: String, model: Option<String>, effort: Option<String>, access: String) -> Result<ThreadRow, String> {
    api::retune(&db, &thread_id, model, effort, access)
}

#[tauri::command]
pub fn chat_thread_rename(db: State<'_, DbConnection>, thread_id: String, title: String) -> Result<(), String> {
    api::rename(&db, &thread_id, &title)
}

#[tauri::command]
pub fn chat_thread_settle(db: State<'_, DbConnection>, thread_id: String, settled: bool) -> Result<(), String> {
    api::settle(&db, &thread_id, settled)
}

/// O aviso do sistema de um pedido de permissão de um agente do chat (a caixa "Permissões"). O
/// mesmo mecanismo das missões (`notifier::show_custom`): só com o app sem foco e com os avisos
/// ligados (`notifications.enabled`). O texto vem da janela, já no idioma da pessoa. Devolve se o
/// aviso apareceu.
#[tauri::command]
pub fn chat_permission_notify(app: AppHandle, title: String, body: String) -> Result<bool, String> {
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(300).collect();
    Ok(crate::notifier::show_custom(&app, &title, &body))
}

/// O que espera a resposta da pessoa no pool de contas da conversa («Continuar na conta B?», «Voltar à A?»).
#[tauri::command]
pub fn chat_pool_pending(db: State<'_, DbConnection>, thread_id: String) -> Option<super::pool::Pending> {
    super::pool::pending(&db, &thread_id)
}

#[tauri::command]
pub fn chat_account_set(app: AppHandle, db: State<'_, DbConnection>, thread_id: String, account_id: Option<String>) -> Result<(), String> {
    super::pool::switch_manual(&app, &db, &thread_id, account_id)
}

#[tauri::command]
pub fn chat_pool_state(db: State<'_, DbConnection>, thread_id: String) -> super::pool::State {
    super::pool::state(&db, &thread_id)
}

#[tauri::command]
pub async fn chat_pool_accept(app: AppHandle, db: State<'_, DbConnection>, thread_id: String) -> Result<(), String> {
    let db = db.inner().clone();
    super::pool::accept(&app, &db, &thread_id).await
}

#[tauri::command]
pub fn chat_pool_dismiss(db: State<'_, DbConnection>, thread_id: String) {
    super::pool::dismiss(&db, &thread_id);
}
