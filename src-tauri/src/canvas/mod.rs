//! El canvas de agentes: dónde está cada terminal y qué terminales están conectadas.
//!
//! El frontend es el dueño del canvas (lo dibuja y lo edita); acá solo se guarda y se
//! consulta. El backend lo necesita por UNA razón: las conexiones son permisos. Un agente
//! solo puede hablarle a los agentes conectados con él (ver `ipc::commands::peers`), y esa
//! regla no puede vivir en el frontend, porque quien pide es un proceso en una terminal.
//!
//! ## Por qué un archivo y no una tabla
//!
//! Es un documento chico que se reescribe entero cada vez que alguien mueve un nodo, sin
//! consultas por campo. Un JSON en `~/.controlcode/canvas.json` alcanza, y no le suma una
//! migración al schema de SQLite.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
mod test;

/// Una conexión entre dos terminales. No tiene sentido: los dos lados pueden hablarse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edge {
    pub id: String,
    /// Ids de tab.
    pub a: String,
    pub b: String,
}

/// Un canvas, uno por carpeta de proyecto. Lo que no sean las conexiones (posiciones,
/// tamaños, la vista) viaja como está: es del frontend y acá no se interpreta.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Board {
    #[serde(default)]
    pub nodes: Value,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub viewport: Value,
}

pub type Boards = HashMap<String, Board>;

#[derive(Serialize, Deserialize, Default)]
struct CanvasFile {
    #[serde(default)]
    boards: Boards,
}

lazy_static::lazy_static! {
    /// Lectura-modificación-escritura del archivo: dos ventanas guardando a la vez no
    /// pueden pisarse a medias.
    static ref LOCK: Mutex<()> = Mutex::new(());
}

fn file_path() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("No se encontró la carpeta del usuario")?.join(".controlcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("canvas.json"))
}

fn read_file() -> Boards {
    let Ok(path) = file_path() else { return Boards::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CanvasFile>(&raw).ok())
        .map(|f| f.boards)
        .unwrap_or_default()
}

/// Todos los canvas guardados.
pub fn load_boards() -> Boards {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_file()
}

/// Reemplaza un canvas. Se escribe a un temporal y se renombra: si la app se cae a la
/// mitad, queda el archivo viejo entero y no uno cortado.
pub fn save_board(key: &str, board: Board) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut boards = read_file();
    boards.insert(key.to_string(), board);
    let path = file_path()?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(&CanvasFile { boards }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Las tabs conectadas con `tab`, en cualquier canvas. Sin repetidos y sin ella misma.
pub fn peers_of(boards: &Boards, tab: &str) -> BTreeSet<String> {
    boards
        .values()
        .flat_map(|b| b.edges.iter())
        .filter_map(|e| {
            if e.a == tab && e.b != tab {
                Some(e.b.clone())
            } else if e.b == tab && e.a != tab {
                Some(e.a.clone())
            } else {
                None
            }
        })
        .collect()
}

// ── Comandos Tauri ───────────────────────────────────────────────────

#[tauri::command]
pub fn canvas_load() -> Boards {
    load_boards()
}

#[tauri::command]
pub fn canvas_save(key: String, board: Board) -> Result<(), String> {
    save_board(&key, board)
}
