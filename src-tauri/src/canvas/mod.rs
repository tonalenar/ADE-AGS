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
//! consultas por campo. Un JSON en `~/.ags/canvas.json` alcanza, y no le suma una
//! migración al schema de SQLite.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod assets;
pub mod roles;

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
    /// Tabs marcadas como orquestadoras: alcanzan a todo su equipo, no solo a sus vecinas.
    #[serde(default)]
    pub orchestrators: Vec<String>,
    /// Las notas del canvas, por id (`note-…`). Tienen que estar tipadas acá: si no, guardar
    /// el canvas las perdería al pasar por este struct.
    #[serde(default)]
    pub notes: BTreeMap<String, Note>,
    /// Los portales (navegadores del canvas), por id (`portal-…`). Tipados por lo mismo
    /// que las notas.
    #[serde(default)]
    pub portals: BTreeMap<String, Portal>,
    /// El papel con que se recrutó cada tab (id de tab → nombre del papel), para mostrarlo
    /// en su nodo. Es solo una etiqueta: no da ni quita permisos.
    #[serde(default)]
    pub roles: BTreeMap<String, String>,
    /// Rótulos, imágenes y trazos: decoración que dibuja y edita el frontend. El backend no
    /// los interpreta, pero tienen que sobrevivir al guardado.
    #[serde(default)]
    pub texts: Value,
    #[serde(default)]
    pub images: Value,
    /// Carpetas del disco puestas en el canvas (solo lectura, decoración).
    #[serde(default)]
    pub folders: Value,
    #[serde(default)]
    pub drawings: Value,
}

/// Un portal: un navegador dentro del canvas que los agentes conectados manejan con
/// `ags portal …` (ver `ipc::commands::portals`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Portal {
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, rename = "box")]
    pub r#box: Value,
    /// `android` = en vez de un navegador, la pantalla de un emulador o teléfono (ver
    /// `crate::android` y `ipc::commands::devices`). Ausente = un navegador.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// El dispositivo de `adb` que muestra (`emulator-5554`). Ausente = el único que haya.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// El emulador (AVD) que arranca este nodo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avd: Option<String>,
}

pub const PORTAL_PREFIX: &str = "portal-";

pub fn is_portal(id: &str) -> bool {
    id.starts_with(PORTAL_PREFIX)
}

/// Una nota del canvas. Los agentes conectados a ella la leen y la escriben
/// (`ags note …`, ver `ipc::commands::notes`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Note {
    pub name: String,
    #[serde(default)]
    pub content: String,
    /// Posición y tamaño: son del frontend, acá no se interpretan.
    #[serde(default, rename = "box")]
    pub r#box: Value,
    /// La pila de notas a la que pertenece (las de una pila comparten caja y se ve la del
    /// frente). Tiene que viajar acá: si no, guardar el canvas deshace las pilas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub front: Option<bool>,
}

/// Los ids de nota llevan este prefijo (el frontend los crea así): nunca chocan con un id
/// de tab, y se sabe qué punta de una conexión es una nota sin buscarla.
pub const NOTE_PREFIX: &str = "note-";

pub fn is_note(id: &str) -> bool {
    id.starts_with(NOTE_PREFIX)
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
    let dir = dirs::home_dir().ok_or("No se encontró la carpeta del usuario")?.join(".ags");
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
///
/// Las notas no cuentan: una nota no es alguien a quien hablarle, y dos agentes conectados
/// a la misma nota comparten esa nota, no un canal entre ellos.
pub fn peers_of(boards: &Boards, tab: &str) -> BTreeSet<String> {
    linked(boards, tab).into_iter().filter(|id| !is_note(id) && !is_portal(id)).collect()
}

/// Las notas que `tab` puede leer y escribir: las conectadas con ella y, si es
/// orquestadora, también las de cualquiera de su equipo. Como `(clave del canvas, id)`.
pub fn notes_for(boards: &Boards, tab: &str) -> Vec<(String, String)> {
    let mut owners = BTreeSet::from([tab.to_string()]);
    if is_orchestrator(boards, tab) {
        owners.extend(team_of(boards, tab));
    }
    let mut out = BTreeSet::new();
    for (key, board) in boards {
        for owner in &owners {
            for e in &board.edges {
                let other = if &e.a == owner { &e.b } else if &e.b == owner { &e.a } else { continue };
                if is_note(other) && board.notes.contains_key(other) {
                    out.insert((key.clone(), other.clone()));
                }
            }
        }
    }
    out.into_iter().collect()
}

/// Los portales que `tab` puede manejar: los conectados con ella y, si es orquestadora,
/// los de su equipo. Como `(clave del canvas, id)`.
pub fn portals_for(boards: &Boards, tab: &str) -> Vec<(String, String)> {
    let mut owners = BTreeSet::from([tab.to_string()]);
    if is_orchestrator(boards, tab) {
        owners.extend(team_of(boards, tab));
    }
    let mut out = BTreeSet::new();
    for (key, board) in boards {
        for owner in &owners {
            for e in &board.edges {
                let other = if &e.a == owner { &e.b } else if &e.b == owner { &e.a } else { continue };
                if is_portal(other) && board.portals.contains_key(other) {
                    out.insert((key.clone(), other.clone()));
                }
            }
        }
    }
    out.into_iter().collect()
}

/// Todo lo conectado con `tab` (tabs, notas y portales), en cualquier canvas.
fn linked(boards: &Boards, tab: &str) -> BTreeSet<String> {
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

/// Lo que separa la carpeta de la misión en la clave de un canvas de misión (ver
/// `missionBoardKey` en el frontend).
const MISSION_SEP: &str = "#m:";

/// La misión en terminales a la que pertenece `tab`: la del canvas de misión que la tiene como
/// nodo u orquestadora. `None` si solo está en el canvas de su carpeta.
pub fn mission_of_tab(boards: &Boards, tab: &str) -> Option<String> {
    boards.iter().find_map(|(key, board)| {
        let member = board.orchestrators.iter().any(|o| o == tab)
            || board.nodes.as_object().is_some_and(|nodes| nodes.contains_key(tab));
        let (_, mission) = key.rsplit_once(MISSION_SEP)?;
        (member && !mission.is_empty()).then(|| mission.to_string())
    })
}

/// ¿Está `tab` marcada como orquestadora en algún canvas?
pub fn is_orchestrator(boards: &Boards, tab: &str) -> bool {
    boards.values().any(|b| b.orchestrators.iter().any(|o| o == tab))
}

/// El equipo de `tab`: todas las tabs a las que se llega desde ella siguiendo conexiones,
/// en cualquier cantidad de pasos. Sin ella misma.
pub fn team_of(boards: &Boards, tab: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::from([tab.to_string()]);
    let mut pending = vec![tab.to_string()];
    while let Some(current) = pending.pop() {
        for next in peers_of(boards, &current) {
            if seen.insert(next.clone()) {
                pending.push(next);
            }
        }
    }
    seen.remove(tab);
    seen
}

/// A quién puede hablarle `tab`. Una orquestadora, a todo su equipo; cualquier otra, a las
/// conectadas directamente con ella y, si una de ellas es orquestadora, también al resto del
/// equipo de esa orquestadora. Así los integrantes de una misión (topología en estrella) se
/// hablan entre sí sin que el lead tenga que retransmitir cada pregunta.
pub fn reachable(boards: &Boards, tab: &str) -> BTreeSet<String> {
    if is_orchestrator(boards, tab) {
        return team_of(boards, tab);
    }
    let direct = peers_of(boards, tab);
    let mut out = direct.clone();
    for lead in direct.iter().filter(|peer| is_orchestrator(boards, peer)) {
        out.extend(peers_of(boards, lead));
    }
    out.remove(tab);
    out
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
