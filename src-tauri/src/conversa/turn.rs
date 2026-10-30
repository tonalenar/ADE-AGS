//! O que os motores de protocolo mais novos (OpenCode, Antigravity) fazem do mesmo jeito: abrir e
//! fechar o turno no banco, gravar os itens e avisar a janela. O lock do banco só é pego para
//! gravar, nunca durante o I/O com o agente.

use serde_json::json;
use tauri::AppHandle;

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::claude_map::{self, TurnResult};
use super::events::emit;
use super::store;

/// Abre o turno `turn` no banco e avisa a janela que o agente está trabalhando.
pub fn begin(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str) {
    if let Ok(conn) = db.lock() {
        let _ = store::upsert_run(&conn, thread_id, turn, "inProgress", Some(crate::util::now_ts_ms()), None, None);
    }
    emit(app, thread_id, "phase", json!({ "phase": "working", "turnId": turn }));
}

/// Grava os itens (um novo vai para o fim; um que já existe fica no lugar) e manda à janela.
pub fn save_items(app: &AppHandle, db: &DbConnection, thread_id: &str, run_id: Option<&str>, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    if let Ok(conn) = db.lock() {
        for item in &items {
            let _ = store::upsert_item(&conn, thread_id, run_id, item);
        }
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
    }
    for item in items {
        emit(app, thread_id, "item", json!({ "item": item }));
    }
}

/// Fecha o turno: o status e a duração no banco, os pedidos pendentes expiram e o fim do turno
/// entra na timeline.
pub fn finish(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, result: &TurnResult) {
    let now = crate::util::now_ts_ms();
    let expired = db.lock().ok().map(|conn| {
        let _ = store::upsert_run(&conn, thread_id, turn, claude_map::run_status(result), None, Some(now), result.duration_ms);
        store::expire_requests(&conn, thread_id).unwrap_or_default()
    });
    for id in expired.unwrap_or_default() {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    save_items(app, db, thread_id, Some(turn), vec![claude_map::turn_end(turn, result, Some(now))]);
}

/// A mensagem da pessoa na timeline, gravada ao mandar.
pub fn save_user(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, text: &str) {
    use crate::canal::event::clip;
    use crate::canal::timeline::ItemKind;
    let item = Item { text: Some(clip(text, 20_000)), ..Item::new(ItemKind::User, format!("u:{}", uuid::Uuid::new_v4()), Some(crate::util::now_ts_ms())) };
    save_items(app, db, thread_id, Some(turn), vec![item]);
}

/// Grava o novo acesso da conversa (o agente mudou de modo sozinho) e avisa a janela.
pub fn set_access(app: &AppHandle, db: &DbConnection, thread_id: &str, access: &str) {
    let changed = db.lock().ok().and_then(|conn| {
        let row = store::thread(&conn, thread_id).ok().flatten()?;
        if row.access == access {
            return None;
        }
        let tuning = store::Tuning { model: row.model, effort: row.effort, access: access.to_string() };
        store::set_tuning(&conn, thread_id, &tuning, crate::util::now_ts_ms()).ok()
    });
    if changed.is_some() {
        emit(app, thread_id, "thread", json!({ "access": access }));
    }
}
