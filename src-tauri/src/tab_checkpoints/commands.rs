//! A ponte com a tela e com os caminhos que escrevem nas abas.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::service::{self, Capture, DiffView, Request, Restore};
use super::store::{kind, TabCheckpoint};
use crate::database::DbConnection;

/// `settings`: `"0"` desliga os pontos automáticos (o "Marcar ponto" continua).
pub const AUTO_SETTING: &str = "tab_checkpoints_auto";

/// O evento que a tela escuta para recarregar a lista de uma aba.
pub const CHANGED_EVENT: &str = "cc-tab-checkpoints-changed";

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Guarda o `AppHandle` para `on_submit`, que é chamado de dentro do envio sem um.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn db_of(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app.try_state::<DbConnection>().ok_or("o banco de dados não está disponível")?.inner().clone())
}

fn auto_enabled(db: &DbConnection) -> bool {
    !matches!(crate::database::get_setting(db, AUTO_SETTING).ok().flatten().as_deref(), Some("0") | Some("false"))
}

fn notify(app: &AppHandle, tab_id: &str) {
    let _ = app.emit(CHANGED_EVENT, json!({ "tabId": tab_id }));
}

/// As abas com uma foto automática em andamento: um segundo Enter (ou o reenvio do Enter) enquanto
/// a primeira roda não enfileira outra.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

/// Foto automática em segundo plano: nunca atrasa nem quebra o envio da mensagem.
fn spawn_auto(app: AppHandle, tab_id: String, cwd: String, message: String, author: String) {
    if !in_flight().lock().unwrap_or_else(|e| e.into_inner()).insert(tab_id.clone()) {
        return;
    }
    std::thread::spawn(move || {
        let result = db_of(&app).and_then(|db| {
            if !auto_enabled(&db) {
                return Ok(None);
            }
            let req = Request { tab_id: &tab_id, cwd: Path::new(&cwd), kind: kind::MESSAGE, author: &author, message: &message, force: false };
            service::capture(&db, &req).map(Some)
        });
        in_flight().lock().unwrap_or_else(|e| e.into_inner()).remove(&tab_id);
        match result {
            Ok(Some(Capture::Created { .. })) => notify(&app, &tab_id),
            Ok(_) => {}
            Err(e) => eprintln!("[tab-checkpoints] foto da aba {tab_id}: {e}"),
        }
    });
}

/// Chamado antes de cada mensagem que o app escreve numa aba (`submit_prompt_seen`: peers, fila de
/// mensagens, `ags tab send`, chat, rotinas, missões). Sem app instalado (testes) ou num PTY que não é
/// de uma aba, não faz nada.
pub fn on_submit(pty_id: u32, text: &str, author: &str) {
    let Some(app) = APP.get() else { return };
    let Some((tab_id, cwd)) = crate::terminal::tab_and_cwd_of(pty_id) else { return };
    spawn_auto(app.clone(), tab_id, cwd, text.to_string(), author.to_string());
}

/// O Enter na aba, visto pelo terminal da tela (a pessoa, ou um colado do próprio app).
#[tauri::command]
pub fn tab_checkpoint_auto(app: AppHandle, tab_id: String, cwd: String, message: String, author: String) {
    spawn_auto(app, tab_id, cwd, message, author);
}

/// "Marcar ponto": cria mesmo com os pontos automáticos desligados; sem mudanças, devolve o último.
#[tauri::command(async)]
pub fn tab_checkpoint_create(app: AppHandle, tab_id: String, cwd: String, label: Option<String>) -> Result<Capture, String> {
    let db = db_of(&app)?;
    let label = label.unwrap_or_default();
    let label = label.trim();
    let req = Request {
        tab_id: &tab_id,
        cwd: Path::new(&cwd),
        kind: kind::MANUAL,
        author: "pessoa",
        message: if label.is_empty() { "ponto manual" } else { label },
        force: false,
    };
    let out = service::capture(&db, &req)?;
    if matches!(out, Capture::Created { .. }) {
        notify(&app, &tab_id);
    }
    Ok(out)
}

#[tauri::command]
pub fn tab_checkpoints_list(app: AppHandle, tab_id: String) -> Result<Vec<TabCheckpoint>, String> {
    service::list(&db_of(&app)?, &tab_id)
}

#[tauri::command(async)]
pub fn tab_checkpoint_diff(app: AppHandle, id: String) -> Result<DiffView, String> {
    service::diff_since(&db_of(&app)?, &id)
}

/// As tarefas da frota rodando agora e a pasta de cada uma.
fn running_tasks(db: &DbConnection) -> Vec<(String, String)> {
    let Ok(conn) = db.lock() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT id, cwd FROM tasks WHERE status IN ('running','ready')") else { return Vec::new() };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// "Voltar até aqui". Com outra aba ou tarefa na mesma pasta e sem `force`, só devolve quem é.
#[tauri::command(async)]
pub fn tab_checkpoint_restore(app: AppHandle, id: String, force: bool) -> Result<Restore, String> {
    let db = db_of(&app)?;
    let tasks = running_tasks(&db);
    let out = service::restore(&db, &id, force, &crate::terminal::live_tab_dirs(), &tasks)?;
    if let Some(safety) = &out.safety {
        notify(&app, &safety.tab_id);
    }
    Ok(out)
}

/// Apaga todos os pontos de uma aba.
#[tauri::command(async)]
pub fn tab_checkpoints_delete(app: AppHandle, tab_id: String) -> Result<usize, String> {
    let n = service::remove_tab(&db_of(&app)?, &tab_id)?;
    notify(&app, &tab_id);
    Ok(n)
}

/// Limpa os pontos das abas fechadas de vez.
#[tauri::command(async)]
pub fn tab_checkpoints_prune(app: AppHandle) -> Result<usize, String> {
    let alive: Vec<String> = crate::terminal::live_tab_dirs().into_iter().map(|(tab, _)| tab).collect();
    service::prune(&db_of(&app)?, &alive, crate::util::now_ts_ms())
}
