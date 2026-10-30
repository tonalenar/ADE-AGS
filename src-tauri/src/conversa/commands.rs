//! Os comandos Tauri das conversas por protocolo: a tela chama o mesmo núcleo (`api`) que a CLI
//! `ags chat` e o MCP. O processo do agente só sobe na primeira mensagem (`chat_thread_send`).

use tauri::{AppHandle, State};

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::api::{self, NewThread, ThreadStatus};
use super::store::{RequestRow, ThreadRow};

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
    title: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    account_id: Option<String>,
) -> Result<ThreadRow, String> {
    api::create(&db, NewThread { agent_id, cwd, title, model, effort, access, account_id })
}

#[tauri::command]
pub async fn chat_thread_send(app: AppHandle, db: State<'_, DbConnection>, thread_id: String, text: String) -> Result<(), String> {
    let db = db.inner().clone();
    api::send(&app, &db, &thread_id, &text).await
}

#[tauri::command]
pub fn chat_thread_items(db: State<'_, DbConnection>, thread_id: String) -> Result<Vec<Item>, String> {
    api::items(&db, &thread_id)
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
pub async fn chat_thread_interrupt(thread_id: String) -> Result<(), String> {
    api::interrupt(&thread_id).await
}

#[tauri::command]
pub fn chat_request_answer(app: AppHandle, db: State<'_, DbConnection>, request_id: String, choice: String) -> Result<bool, String> {
    api::answer(&app, &db, &request_id, &choice)
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
