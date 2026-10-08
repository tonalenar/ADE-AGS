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
//! ## Borrar un piso
//!
//! Solo lo pide la persona, desde la pantalla (no hay comando de CLI: ningún agente borra
//! pisos). Descartar un worktree con trabajo adentro no tiene vuelta atrás, así que se usa
//! el mismo descarte seguro de las tareas (`runs::worktrees::remove`): se niega si hay
//! cambios sin commitear y los lista, y la rama solo se borra si ya está mergeada; con
//! commits propios queda, y se avisa. La pantalla además se niega si hay agentes abiertos
//! en el piso.

use std::ffi::OsStr;
use std::io;
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

/// Override lido pelo processo da app. `per-worktree` separa o target de cada recruit;
/// qualquer outro valor é um caminho (absoluto ou relativo à raiz do clone principal).
pub(crate) const CARGO_TARGET_DIR_SETTING: &str = "ADE_AGS_CARGO_TARGET_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CargoTargetMode {
    Shared,
    PerWorktree,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CargoTarget {
    pub path: PathBuf,
    pub mode: CargoTargetMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeModulesLinkStatus {
    Created,
    AlreadyLinked,
    ExistingPreserved,
}

impl NodeModulesLinkStatus {
    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Created => "link compartilhado criado",
            Self::AlreadyLinked => "link compartilhado já existe",
            Self::ExistingPreserved => "node_modules já existia e foi preservado",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorktreeShell {
    PowerShell,
    Posix,
}

/// Dedicated agent cache, separate from the target used by `tauri dev`.
pub(crate) fn agents_cargo_target_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ags").join("cargo-target-agents")
}

/// Sem override, todos compartilham o cache exclusivo dos agentes.
/// `per-worktree` permanece disponível para evitar disputa de lock.
pub(crate) fn cargo_target_dir(
    repo_root: &Path,
    worktree_root: &Path,
    configured: Option<&OsStr>,
) -> CargoTarget {
    let Some(value) = configured
        .map(OsStr::to_string_lossy)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return CargoTarget {
            path: agents_cargo_target_dir(),
            mode: CargoTargetMode::Shared,
        };
    };

    if value.eq_ignore_ascii_case("shared") {
        return CargoTarget { path: agents_cargo_target_dir(), mode: CargoTargetMode::Shared };
    }
    if value.eq_ignore_ascii_case("per-worktree") {
        return CargoTarget {
            path: worktree_root.join("src-tauri").join("target"),
            mode: CargoTargetMode::PerWorktree,
        };
    }

    let path = PathBuf::from(value);
    CargoTarget {
        path: if path.is_absolute() { path } else { repo_root.join(path) },
        mode: CargoTargetMode::Custom,
    }
}

/// Cria o link de dependências no worktree sem substituir nada que já esteja lá.
pub(crate) fn prepare_node_modules_link(
    repo_root: &Path,
    worktree_root: &Path,
) -> io::Result<NodeModulesLinkStatus> {
    let target = repo_root.join("node_modules");
    let link = worktree_root.join("node_modules");
    match std::fs::symlink_metadata(&link) {
        Ok(_) => {
            let linked_to_target = match (std::fs::canonicalize(&link), std::fs::canonicalize(&target)) {
                (Ok(link), Ok(target)) => link == target,
                _ => false,
            };
            return Ok(if linked_to_target {
                NodeModulesLinkStatus::AlreadyLinked
            } else {
                NodeModulesLinkStatus::ExistingPreserved
            });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if !target.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("a pasta compartilhada não existe: {}", target.display()),
        ));
    }

    match create_node_modules_link(&target, &link) {
        Ok(()) => Ok(NodeModulesLinkStatus::Created),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let linked_to_target = match (std::fs::canonicalize(&link), std::fs::canonicalize(&target)) {
                (Ok(link), Ok(target)) => link == target,
                _ => false,
            };
            Ok(if linked_to_target {
                NodeModulesLinkStatus::AlreadyLinked
            } else {
                NodeModulesLinkStatus::ExistingPreserved
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn create_node_modules_link(target: &Path, link: &Path) -> io::Result<()> {
    crate::skills::junction_dir(target, link)
}

#[cfg(unix)]
fn create_node_modules_link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(any(windows, unix)))]
fn create_node_modules_link(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "links de diretório não suportados nesta plataforma"))
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Gera o briefing do ambiente sem consultar o processo, para que as duas plataformas e
/// diferentes formas de escrever caminhos possam ser verificadas por teste.
pub(crate) fn worktree_environment_block(
    worktree_root: &str,
    cargo_target_dir: &str,
    shell_label: &str,
    shell: WorktreeShell,
    node_modules: &str,
    cargo_mode: CargoTargetMode,
) -> String {
    let (root_command, code_fence) = match shell {
        WorktreeShell::PowerShell => (
            format!("Set-Location {}", shell_quote_powershell(worktree_root)),
            "powershell",
        ),
        WorktreeShell::Posix => (
            format!("cd {}", shell_quote_posix(worktree_root)),
            "bash",
        ),
    };
    let cargo_note = match cargo_mode {
        CargoTargetMode::Shared => "O target Cargo é compartilhado exclusivamente pelos agentes, separado do tauri dev; compilações simultâneas podem disputar o lock. Aqueça-o uma vez com cargo test --lib --no-run. ADE_AGS_CARGO_TARGET_DIR=per-worktree mantém isolamento opcional.",
        CargoTargetMode::PerWorktree => "O target Cargo é isolado por worktree, evitando disputa pelo lock; as dependências serão recompiladas uma vez neste worktree.",
        CargoTargetMode::Custom => "O target Cargo usa o caminho configurado. Se vários agentes o compartilharem, podem disputar o lock; ADE_AGS_CARGO_TARGET_DIR=per-worktree seleciona um target próprio por worktree, com recompilação única das dependências.",
    };
    format!(
        "AMBIENTE DO WORKTREE\nShell: {shell_label}\nRaiz: {worktree_root}\nnode_modules: {node_modules}\nCARGO_TARGET_DIR: {cargo_target_dir}\n{cargo_note}\n\nValidação de cada entrega:\n```{code_fence}\n{root_command}\nags test affected --dry-run\nags test affected\n```\nNão repita a suite completa localmente: ao abrir PR, espere o CI com gh pr checks <n> --watch. Suite completa local obrigatória em migrações de banco, schema, código unsafe ou COM, e também na última rodada de correção. Use ags test run <frontend|rust|tsc|babel> nessas exceções; --force ignora cache. QA roda ags test affected no mesmo commit; se responder `já verde neste hash`, não reexecuta a suíte. Só reexecuta quando o cache não acerta. Essa reutilização não vale na última rodada de correção nem na validação única da integração. Correções da mesma entrega têm teto (padrão 2; chave fix_rounds.max ou ADE_AGS_MAX_FIX_ROUNDS). A última rodada exige a suíte completa. Ao atingir o teto a entrega escala, em vez de repetir o loop. A integração tem uma validação completa final (ou CI)."
    )
}

/// Comando de prelaunch que exporta a variável no shell pai da TUI recrutada.
pub(crate) fn cargo_target_prelaunch(target: &Path) -> String {
    let target = target.to_string_lossy();
    #[cfg(windows)]
    {
        format!("set \"CARGO_TARGET_DIR={target}\"")
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_default();
        if Path::new(&shell).file_name().is_some_and(|name| name == "fish") {
            format!("set -gx CARGO_TARGET_DIR {}", shell_quote_posix(&target))
        } else {
            format!("export CARGO_TARGET_DIR={}", shell_quote_posix(&target))
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        format!("CARGO_TARGET_DIR={target}")
    }
}

pub(crate) fn worktree_shell() -> (WorktreeShell, String) {
    #[cfg(windows)]
    {
        (WorktreeShell::PowerShell, "PowerShell".into())
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let label = Path::new(&shell).file_name().and_then(OsStr::to_str).unwrap_or("bash");
        (WorktreeShell::Posix, label.to_string())
    }
    #[cfg(not(any(windows, unix)))]
    {
        (WorktreeShell::Posix, "shell padrão".into())
    }
}

fn data_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("No se encontró la carpeta del usuario")?.join(".ags");
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
                format!("Não existe o andar '{wanted}': este projeto ainda não tem andares. Crie um com `ags floor create`.")
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

    // `node_modules` é ignorado pelo Git e não vem no checkout do worktree. O link é
    // derivado: se não puder ser criado, o piso continua válido e o motivo fica avisado.
    match crate::runs::worktrees::repo_root(Path::new(&ground)) {
        Ok(repo_root) => match prepare_node_modules_link(&repo_root, &wt.root) {
            Ok(NodeModulesLinkStatus::ExistingPreserved) => eprintln!(
                "[ags] aviso: {} já existe em {}; não foi substituído pelo link para {}",
                wt.root.join("node_modules").display(),
                wt.root.display(),
                repo_root.join("node_modules").display(),
            ),
            Ok(_) => {}
            Err(error) => eprintln!(
                "[ags] aviso: não foi possível ligar node_modules em {}: {error}",
                wt.root.display(),
            ),
        },
        Err(error) => eprintln!("[ags] aviso: não foi possível localizar o clone principal para node_modules: {error}"),
    }

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

/// Saca un piso de la lista por id.
pub fn take(floors: &mut Vec<Floor>, id: &str) -> Result<Floor, String> {
    let at = floors.iter().position(|f| f.id == id).ok_or("Esse andar já não existe.")?;
    Ok(floors.remove(at))
}

/// Lo que pasó al borrar un piso.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub name: String,
    pub branch: String,
    /// La rama quedó porque tiene commits que no están en ningún otro lado.
    pub branch_kept: bool,
}

/// Borra un piso: descarta su worktree (con las salvaguardas de `worktrees::remove`) y
/// recién entonces lo saca de la lista. Si el descarte falla, el piso sigue donde estaba.
pub fn remove(id: &str, skills_dir: &Path) -> Result<Dropped, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut floors = read_file();
    let floor = floors.iter().find(|f| f.id == id).cloned().ok_or("Esse andar já não existe.")?;

    // Las skills que la app montó en el piso (una carpeta por agente) estorban a git: son
    // derivadas y se recrean solas.
    for adapter in crate::agents::adapters() {
        if let Some(dir) = crate::skills::links_dir_for(&floor.cwd, adapter.def().id) {
            for link in crate::runs::worktrees::managed_links(&dir, skills_dir) {
                let _ = crate::skills::remove_mount(&link);
            }
        }
    }

    let wt = crate::runs::worktrees::Worktree {
        root: PathBuf::from(&floor.root),
        task_cwd: PathBuf::from(&floor.cwd),
        branch: floor.branch.clone(),
    };
    let removed = crate::runs::worktrees::remove(Path::new(&floor.ground), &wt, Path::new(""), skills_dir)?;

    take(&mut floors, id)?;
    write_file(&floors)?;
    Ok(Dropped { name: floor.name, branch: floor.branch, branch_kept: removed.branch_kept })
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

/// Piso que contém `cwd`, quando a pasta já é ou está dentro de um worktree gerido.
pub(crate) fn floor_for_path(cwd: &str) -> Option<Floor> {
    let here = norm(cwd);
    all().into_iter().find(|floor| {
        let root = norm(&floor.root);
        here == root || here.starts_with(&format!("{root}/"))
    })
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

/// `async`: `git worktree remove` borra una carpeta entera.
#[tauri::command(async)]
pub fn floor_delete(app: tauri::AppHandle, id: String) -> Result<Dropped, String> {
    use tauri::{Emitter, Manager};
    let db = app.try_state::<crate::database::DbConnection>().ok_or("la base no está disponible")?.inner().clone();
    let skills_dir = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        crate::skills::skills_dir_from_conn(&conn)?
    };
    let dropped = remove(&id, &skills_dir)?;
    let _ = app.emit(CHANGED_EVENT, &id);
    Ok(dropped)
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
    fn se_saca_un_piso_por_id_y_uno_inexistente_se_dice() {
        let mut floors = vec![floor("A", "/p"), floor("B", "/p")];
        assert_eq!(take(&mut floors, "id-A").unwrap().name, "A");
        assert_eq!(floors.len(), 1);
        assert!(take(&mut floors, "id-A").unwrap_err().contains("já não existe"));
        assert_eq!(floors[0].name, "B", "el otro no se toca");
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

    #[test]
    fn cargo_target_compartilhado_e_configuravel_por_worktree() {
        let repo = std::env::temp_dir().join("ags-repo");
        let worktree = repo.join(".ags").join("floor");

        let shared = cargo_target_dir(&repo, &worktree, None);
        assert_eq!(shared.mode, CargoTargetMode::Shared);
        assert_eq!(shared.path, agents_cargo_target_dir());
        assert_ne!(shared.path, repo.join("src-tauri").join("target"));
        assert_eq!(cargo_target_dir(&repo, &worktree, Some(OsStr::new("shared"))), shared);

        let isolated = cargo_target_dir(&repo, &worktree, Some(OsStr::new("per-worktree")));
        assert_eq!(isolated.mode, CargoTargetMode::PerWorktree);
        assert_eq!(isolated.path, worktree.join("src-tauri").join("target"));

        let custom = cargo_target_dir(&repo, &worktree, Some(OsStr::new("cache/cargo")));
        assert_eq!(custom.mode, CargoTargetMode::Custom);
        assert_eq!(custom.path, repo.join("cache").join("cargo"));
    }

    #[test]
    fn briefing_powershell_preserva_caminhos_windows_com_as_duas_barras() {
        for root in [r"C:\repo\worktree", "C:/repo/worktree"] {
            let block = worktree_environment_block(
                root,
                r"C:\repo\src-tauri\target",
                "PowerShell",
                WorktreeShell::PowerShell,
                "junction compartilhada criada",
                CargoTargetMode::Shared,
            );
            assert!(block.contains("AMBIENTE DO WORKTREE"), "{block}");
            assert!(block.contains("Shell: PowerShell"), "{block}");
            assert!(block.contains(&format!("Raiz: {root}")), "{block}");
            assert!(block.contains("ags test affected --dry-run"), "{block}");
            assert!(block.contains("gh pr checks <n> --watch"), "{block}");
            assert!(block.contains("migrações de banco, schema, código unsafe ou COM"), "{block}");
            assert!(block.contains("já verde neste hash"), "{block}");
            assert!(block.contains("fix_rounds.max"), "{block}");
            assert!(block.contains("última rodada"), "{block}");
            assert!(block.contains("disputar o lock"), "{block}");
        }
    }

    #[test]
    fn briefing_posix_preserva_caminhos_com_as_duas_barras_e_explica_target_isolado() {
        for root in ["/repo/worktree", r"\repo\worktree"] {
            let block = worktree_environment_block(
                root,
                "/repo/worktree/src-tauri/target",
                "bash",
                WorktreeShell::Posix,
                "symlink compartilhado criado",
                CargoTargetMode::PerWorktree,
            );
            assert!(block.contains("Shell: bash"), "{block}");
            assert!(block.contains(&format!("Raiz: {root}")), "{block}");
            assert!(block.contains("cd '"), "{block}");
            assert!(block.contains("ags test affected"), "{block}");
            assert!(block.contains("isolado por worktree"), "{block}");
        }
    }

    #[test]
    fn node_modules_existente_nunca_e_substituido() {
        let root = std::env::temp_dir().join(format!("ags-node-modules-existing-{}", uuid::Uuid::new_v4().simple()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        let target = repo.join("node_modules");
        let existing = worktree.join("node_modules");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("keep.txt"), "preservar").unwrap();

        assert_eq!(prepare_node_modules_link(&repo, &worktree).unwrap(), NodeModulesLinkStatus::ExistingPreserved);
        assert_eq!(std::fs::read_to_string(existing.join("keep.txt")).unwrap(), "preservar");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn worktree_real_recebe_link_de_node_modules_da_raiz() {
        use std::process::Command;

        let scratch = std::env::temp_dir().join(format!("ags-floor-link-{}", uuid::Uuid::new_v4().simple()));
        let repo = scratch.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.name", "ADE AGS tests"]);
        git(&["config", "user.email", "tests@ags.local"]);
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(repo.join("README.md"), "fixture\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules")).unwrap();
        std::fs::write(repo.join("node_modules").join("marker.txt"), "shared\n").unwrap();
        git(&["add", ".gitignore", "README.md"]);
        git(&["commit", "--quiet", "-m", "fixture"]);

        let wt = crate::runs::worktrees::create_from(&scratch.join("worktrees"), &repo, "junction fixture", "HEAD").unwrap();
        let status = prepare_node_modules_link(&repo, &wt.root).unwrap();
        assert_eq!(status, NodeModulesLinkStatus::Created);
        let link = wt.root.join("node_modules");
        assert_eq!(std::fs::read_to_string(link.join("marker.txt")).unwrap(), "shared\n");
        #[cfg(windows)]
        assert!(crate::skills::is_mount(&link), "Windows deve criar um junction de diretório válido");
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());

        crate::skills::remove_mount(&link).unwrap();
        crate::runs::worktrees::remove(&repo, &wt, Path::new(""), Path::new("")).unwrap();
        let _ = std::fs::remove_dir_all(scratch);
    }
}
