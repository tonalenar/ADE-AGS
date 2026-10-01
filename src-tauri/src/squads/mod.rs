pub(crate) mod store;
#[cfg(test)]
mod test;
mod types;

pub use types::{RunSquadMember, Squad, SquadInput};

use tauri::{AppHandle, Emitter, Runtime};

use crate::database::DbConnection;

pub const SQUAD_CHANGED: &str = "cc-squad-changed";

fn notify<R: Runtime>(app: &AppHandle<R>, squad_id: &str) {
    let _ = app.emit(SQUAD_CHANGED, serde_json::json!({ "squad_id": squad_id }));
}

#[tauri::command]
pub fn squad_create<R: Runtime>(
    app: AppHandle<R>,
    input: SquadInput,
    db: tauri::State<DbConnection>,
) -> Result<Squad, String> {
    let squad = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        let valid = store::validate(&conn, &input)?;
        store::create(&conn, &valid)?
    };
    notify(&app, &squad.id);
    Ok(squad)
}

#[tauri::command]
pub fn squad_update<R: Runtime>(
    app: AppHandle<R>,
    squad_id: String,
    input: SquadInput,
    db: tauri::State<DbConnection>,
) -> Result<Squad, String> {
    let squad = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        let valid = store::validate(&conn, &input)?;
        store::update(&conn, &squad_id, &valid)?
    };
    notify(&app, &squad.id);
    Ok(squad)
}

#[tauri::command]
pub fn squad_list(db: tauri::State<DbConnection>) -> Result<Vec<Squad>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    store::list(&conn)
}

#[tauri::command]
pub fn squad_get(squad_id: String, db: tauri::State<DbConnection>) -> Result<Squad, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    store::get(&conn, &squad_id)?.ok_or_else(|| format!("no squad '{squad_id}' exists"))
}

#[tauri::command]
pub fn squad_delete<R: Runtime>(
    app: AppHandle<R>,
    squad_id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    {
        let conn = db.lock().map_err(|error| error.to_string())?;
        store::delete(&conn, &squad_id)?;
    }
    notify(&app, &squad_id);
    Ok(())
}
