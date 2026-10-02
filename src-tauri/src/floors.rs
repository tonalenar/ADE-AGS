//! Pisos: espacios de trabajo aislados dentro de un mismo proyecto.
//!
//! Un piso es una copia de trabajo del repo (un worktree de git, en su propia rama) con su
//! propio canvas. Lo que un equipo de agentes hace en un piso no lo ve el de otro hasta que
//! alguien lo junta: sirve para probar una refactorización arriesgada, o para correr dos
//! líneas de trabajo a la vez sin que se pisen archivos.
//!
//! El proyecto original es la **planta baja** (el "ground"): no es un piso, es de donde
//! nacen. Los pisos de un proyecto se encuentran por esa carpeta.
//!
//! ## Cómo encaja con el resto
//!
//! - El canvas ya es uno por carpeta (`canvas::boardKey`), así que un piso tiene el suyo
//!   sin más: sus agentes corren con `cwd` = la carpeta del piso.
//! - Los worktrees son los de las tareas (`runs::worktrees`): misma creación, misma rama
//!   `cc/…`, mismo lugar de nacimiento (`HEAD` o la rama que se pida).
//! - Las conexiones entre agentes valen entre pisos: un orquestador en la planta baja
//!   recluta en un piso y habla con él (ver `canvas::peers_of`, que mira todos los canvas).
//!
//! ## Lo que NO hace
//!
//! No borra pisos. Descartar un worktree con trabajo adentro no tiene vuelta atrás, y
//! decidirlo es de la persona: la carpeta y la rama quedan donde están (la ruta se ve al
//! listar) y se quitan con `git worktree remove`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Floor {
    pub id: String,
    pub name: String,
    /// La carpeta del proyecto de la que nació (la planta baja), como la dio quien lo creó.
    pub ground: String,
    /// Donde corren sus agentes: la misma subcarpeta del repo, dentro del worktree.
    pub cwd: String,
    /// La raíz del worktree.
    pub root: String,
    pub branch: String,
}

#[derive(Serialize, Deserialize, Default)]
struct FloorsFile {
    #[serde(default)]
    floors: Vec<Floor>,
}

lazy_static::lazy_static! {
    static ref LOCK: Mutex<()> = Mutex::new(());
}

const MAX_NAME: usize = 40;

fn data_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("No se encontró la carpeta del usuario")?.join(".controlcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn file_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("floors.json"))
}

fn read_file() -> Vec<Floor> {
    let Ok(path) = file_path() else { return Vec::new() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<FloorsFile>(&raw).ok())
        .map(|f| f.floors)
        .unwrap_or_default()
}

fn write_file(floors: &[Floor]) -> Result<(), String> {
    let path = file_path()?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&FloorsFile { floors: floors.to_vec() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Una ruta en forma comparable: barras `/`, sin barra final y, en Windows, sin
/// distinguir mayúsculas (la unidad y las carpetas pueden venir escritas distinto).
pub fn norm(path: &str) -> String {
    let mut p = path.replace('\\', "/");
    // El prefijo `\\?\` de las rutas canónicas de Windows no es parte de la ruta.
    if let Some(rest) = p.strip_prefix("//?/") {
        p = rest.to_string();
    }
    let p = p.trim_end_matches('/').to_string();
    if cfg!(windows) { p.to_lowercase() } else { p }
}

/// La planta baja a la que pertenece `cwd`: si `cwd` es (o está dentro de) un piso, la
/// planta baja de ese piso; si no, la propia `cwd`. Así, un agente que ya está en un piso
/// crea pisos hermanos y no pisos de un piso.
pub fn ground_for(floors: &[Floor], cwd: &str) -> String {
    let here = norm(cwd);
    floors
        .iter()
        .find(|f| {
            let root = norm(&f.root);
            here == norm(&f.cwd) || here == root || here.starts_with(&format!("{root}/"))
        })
        .map(|f| f.ground.clone())
        .unwrap_or_else(|| cwd.to_string())
}

/// Los pisos de una planta baja.
pub fn floors_of(floors: &[Floor], ground: &str) -> Vec<Floor> {
    let g = norm(ground);
    floors.iter().filter(|f| norm(&f.ground) == g).cloned().collect()
}

/// Un nombre válido y libre en esa planta baja.
pub fn check_name(floors: &[Floor], ground: &str, name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("O andar precisa de um nome.".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("O nome do andar passa de {MAX_NAME} caracteres."));
    }
    if name.chars().any(char::is_control) {
        return Err("O nome do andar não pode ter caracteres de controle.".into());
    }
    let taken = floors_of(floors, ground).iter().any(|f| f.name.to_lowercase() == name.to_lowercase());
    if taken {
        return Err(format!("Já existe um andar chamado '{name}' neste projeto."));
    }
    Ok(name)
}

/// Resuelve un piso por nombre (sin mayúsculas) o por id, entre los de la planta baja de
/// `cwd`.
pub fn find<'a>(floors: &'a [Floor], ground: &str, wanted: &str) -> Result<&'a Floor, String> {
    let g = norm(ground);
    let needle = wanted.trim().to_lowercase();
    floors
        .iter()
        .filter(|f| norm(&f.ground) == g)
        .find(|f| f.id == wanted || f.name.to_lowercase() == needle)
        .ok_or_else(|| {
            let names: Vec<_> = floors_of(floors, ground).into_iter().map(|f| f.name).collect();
            if names.is_empty() {
                format!("Não existe o andar '{wanted}': este projeto ainda não tem andares. Crie um com `ccode floor create`.")
            } else {
                format!("Não existe o andar '{wanted}'. Andares: {}.", names.join(", "))
            }
        })
}

/// De dónde parte el piso. `start` llega de un agente y acaba en la línea de comandos de
/// git: una opción disfrazada (`--upload-pack=…`) no puede pasar por rama.
pub fn check_start(start: Option<&str>) -> Result<&str, String> {
    let start = start.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("HEAD");
    if start.starts_with('-') {
        return Err("A origem do andar não pode começar com '-'.".into());
    }
    Ok(start)
}

/// Todos los pisos guardados.
pub fn all() -> Vec<Floor> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_file()
}

/// Crea un piso: un worktree nuevo del proyecto de `cwd`, partiendo de `start` (`HEAD` si
/// no se dice) y lo guarda.
pub fn create(cwd: &str, name: &str, start: Option<&str>) -> Result<Floor, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut floors = read_file();
    let ground = ground_for(&floors, cwd);
    let name = check_name(&floors, &ground, name)?;

    let base = data_dir()?.join("floors");
    let start = check_start(start)?;
    let wt = crate::runs::worktrees::create_from(&base, Path::new(&ground), &name, start)?;

    let floor = Floor {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        name,
        ground,
        cwd: wt.task_cwd.to_string_lossy().to_string(),
        root: wt.root.to_string_lossy().to_string(),
        branch: wt.branch,
    };
    floors.push(floor.clone());
    write_file(&floors)?;
    Ok(floor)
}

/// Lo que ve el frontend de una planta baja: ella misma y sus pisos.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorList {
    pub ground: String,
    pub floors: Vec<Floor>,
}

pub fn list_for(cwd: &str) -> FloorList {
    let floors = all();
    let ground = ground_for(&floors, cwd);
    FloorList { floors: floors_of(&floors, &ground), ground }
}

/// El evento que avisa al frontend que cambió la lista de pisos (por ejemplo, porque un
/// agente creó uno con la CLI).
pub const CHANGED_EVENT: &str = "cc-floors-changed";

#[tauri::command]
pub fn floor_list(cwd: String) -> FloorList {
    list_for(&cwd)
}

/// `async`: `git worktree add` hace un checkout completo y en un repo grande tarda; en la
/// hebra principal congelaría la ventana.
#[tauri::command(async)]
pub fn floor_create(app: tauri::AppHandle, cwd: String, name: String, from: Option<String>) -> Result<Floor, String> {
    use tauri::Emitter;
    let floor = create(&cwd, &name, from.as_deref())?;
    let _ = app.emit(CHANGED_EVENT, &floor.id);
    Ok(floor)
}

#[cfg(test)]
mod test {
    use super::*;

    fn floor(name: &str, ground: &str) -> Floor {
        Floor {
            id: format!("id-{name}"),
            name: name.into(),
            ground: ground.into(),
            cwd: format!("/wt/{name}/app"),
            root: format!("/wt/{name}"),
            branch: format!("cc/{name}"),
        }
    }

    #[test]
    fn las_rutas_se_comparan_sin_importar_las_barras() {
        assert_eq!(norm("C:\\Users\\a\\proj\\"), norm("C:/Users/a/proj"));
        assert_eq!(norm("\\\\?\\C:\\x"), norm("C:/x"));
    }

    #[test]
    fn un_agente_dentro_de_un_piso_crea_pisos_hermanos() {
        let floors = vec![floor("Refactor", "/proj")];
        assert_eq!(ground_for(&floors, "/proj"), "/proj");
        assert_eq!(ground_for(&floors, "/wt/Refactor/app"), "/proj");
        assert_eq!(ground_for(&floors, "/wt/Refactor/app/src"), "/proj", "una subcarpeta del piso");
        assert_eq!(ground_for(&floors, "/wt/Refactor"), "/proj");
        assert_eq!(ground_for(&floors, "/otro"), "/otro");
    }

    #[test]
    fn un_prefijo_parecido_no_es_el_mismo_piso() {
        let floors = vec![floor("Refactor", "/proj")];
        assert_eq!(ground_for(&floors, "/wt/Refactor2"), "/wt/Refactor2");
    }

    #[test]
    fn cada_proyecto_ve_solo_sus_pisos() {
        let floors = vec![floor("A", "/p1"), floor("B", "/p2"), floor("C", "/p1")];
        let names: Vec<_> = floors_of(&floors, "/p1").into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["A", "C"]);
    }

    #[test]
    fn el_nombre_se_limpia_y_no_se_repite_en_el_proyecto() {
        let floors = vec![floor("Refactor", "/p1")];
        assert_eq!(check_name(&floors, "/p1", "  Nova   ideia ").unwrap(), "Nova ideia");
        assert!(check_name(&floors, "/p1", "refactor").unwrap_err().contains("Já existe"));
        assert!(check_name(&floors, "/p2", "Refactor").is_ok(), "otro proyecto, otro espacio de nombres");
        assert!(check_name(&floors, "/p1", "   ").is_err());
        assert!(check_name(&floors, "/p1", &"a".repeat(MAX_NAME + 1)).is_err());
        assert!(check_name(&floors, "/p1", "a\u{1b}b").is_err());
    }

    #[test]
    fn se_encuentra_por_nombre_o_id_y_el_error_lista_los_que_hay() {
        let floors = vec![floor("Refactor", "/p1"), floor("Docs", "/p1")];
        assert_eq!(find(&floors, "/p1", "docs").unwrap().name, "Docs");
        assert_eq!(find(&floors, "/p1", "id-Refactor").unwrap().name, "Refactor");
        let err = find(&floors, "/p1", "nada").unwrap_err();
        assert!(err.contains("Refactor") && err.contains("Docs"), "{err}");
        assert!(find(&floors, "/p2", "Docs").unwrap_err().contains("ainda não tem"));
    }

    #[test]
    fn un_origen_con_guion_se_rechaza_antes_de_llegar_a_git() {
        assert!(check_start(Some("--upload-pack=evil")).unwrap_err().contains("não pode começar com '-'"));
        assert_eq!(check_start(None).unwrap(), "HEAD");
        assert_eq!(check_start(Some("  main ")).unwrap(), "main");
        assert_eq!(check_start(Some("")).unwrap(), "HEAD");
    }
}
