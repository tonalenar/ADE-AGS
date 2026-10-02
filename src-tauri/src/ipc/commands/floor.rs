//! Pisos del canvas: `ccode floors | floor create`.
//!
//! Listar está abierto a cualquier agente. Crear es solo del orquestador: un piso hace un
//! checkout completo del repo en el disco del usuario, y es lo bastante pesado y duradero
//! como para que no lo abra cualquier agente. No hay comando para borrarlos (ver
//! `crate::floors`).

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, open_tabs, OpenTab};
use crate::floors::{self, Floor};
use crate::ipc::protocol::{arg_str, arg_str_opt};

fn describe(f: &Floor) -> Value {
    json!({ "id": f.id, "name": f.name, "branch": f.branch, "cwd": f.cwd })
}

/// La pestaña que pide: sin ella no se sabe de qué proyecto se habla.
fn me(app: &AppHandle, args: &Value) -> Result<OpenTab, String> {
    let from = caller(args)?;
    open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())
}

pub(super) fn floor_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let list = floors::list_for(&me.cwd);
    Ok(json!({
        "ground": list.ground,
        "here": floors::all().iter().find(|f| floors::norm(&f.cwd) == floors::norm(&me.cwd)).map(|f| f.name.clone()),
        "floors": list.floors.iter().map(describe).collect::<Vec<_>>(),
    }))
}

pub(super) fn floor_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    if !crate::canvas::is_orchestrator(&crate::canvas::load_boards(), &me.id) {
        return Err("Só um orquestrador cria andares. O usuário marca um agente como orquestrador no canvas (coroa no cabeçalho do nó).".into());
    }
    let floor = floors::create(&me.cwd, &arg_str(args, "name")?, arg_str_opt(args, "from").as_deref())?;
    // Avisa a la interfaz: el piso nuevo aparece en su selector sin que nadie lo pida.
    let _ = app.emit(floors::CHANGED_EVENT, &floor.id);
    Ok(json!({ "created": describe(&floor) }))
}

/// Dónde se recluta: la carpeta del piso pedido, o la planta baja. `None` = donde está quien
/// recluta.
pub(crate) fn recruit_cwd(me_cwd: &str, wanted: &str) -> Result<String, String> {
    let all = floors::all();
    let ground = floors::ground_for(&all, me_cwd);
    if is_ground_word(wanted) {
        return Ok(ground);
    }
    floors::find(&all, &ground, wanted).map(|f| f.cwd.clone())
}

/// Las formas de decir "la planta baja".
pub(crate) fn is_ground_word(wanted: &str) -> bool {
    matches!(wanted.trim().to_lowercase().as_str(), "ground" | "terreo" | "térreo" | "planta baja")
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn la_planta_baja_se_dice_de_varias_formas() {
        for word in ["ground", "Ground", " térreo ", "terreo", "planta baja"] {
            assert!(is_ground_word(word), "{word}");
        }
        assert!(!is_ground_word("refactor"));
    }
}
