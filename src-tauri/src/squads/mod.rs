pub(crate) mod recruit;
pub(crate) mod store;
#[cfg(test)]
mod test;
mod types;

pub use types::{RunSquadMember, Squad, SquadInput, SubagentDefault};

use tauri::{AppHandle, Emitter, Runtime};

use crate::database::DbConnection;

pub const SQUAD_CHANGED: &str = "cc-squad-changed";

fn notify<R: Runtime>(app: &AppHandle<R>, squad_id: &str) {
    let _ = app.emit(SQUAD_CHANGED, serde_json::json!({ "squad_id": squad_id }));
}

#[tauri::command]
pub async fn squad_create(
    app: AppHandle,
    input: SquadInput,
    db: tauri::State<'_, DbConnection>,
) -> Result<Squad, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let squad = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            let valid = store::validate(&conn, &input)?;
            store::create(&conn, &valid)?
        };
        notify(&app, &squad.id);
        Ok(squad)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn squad_update(
    app: AppHandle,
    squad_id: String,
    input: SquadInput,
    db: tauri::State<'_, DbConnection>,
) -> Result<Squad, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let squad = {
            let conn = db.lock().map_err(|error| error.to_string())?;
            let valid = store::validate(&conn, &input)?;
            store::update(&conn, &squad_id, &valid)?
        };
        notify(&app, &squad.id);
        Ok(squad)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn squad_list(db: tauri::State<'_, DbConnection>) -> Result<Vec<Squad>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|error| error.to_string())?;
        store::list(&conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn squad_get(squad_id: String, db: tauri::State<'_, DbConnection>) -> Result<Squad, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|error| error.to_string())?;
        store::get(&conn, &squad_id)?.ok_or_else(|| format!("no squad '{squad_id}' exists"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn squad_delete(
    app: AppHandle,
    squad_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<(), String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let conn = db.lock().map_err(|error| error.to_string())?;
            store::delete(&conn, &squad_id)?;
        }
        notify(&app, &squad_id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
