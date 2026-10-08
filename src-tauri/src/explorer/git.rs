//! Qué repo es esta carpeta, en qué rama está, y qué cambió.
//!
//! Todo sale de invocar `git`. Se podría linkear una librería, pero `git` ya está
//! instalado en cualquier máquina donde esta app tenga sentido, y así el resultado es
//! exactamente el que ve el usuario en su terminal — incluido lo que diga su
//! `.gitignore` y su configuración.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::util::output_with_timeout;

/// Un repo grande con el índice frío puede tardar; más de esto y el panel prefiere
/// mostrarse sin marcas antes que congelarse.
const GIT_TIMEOUT: Duration = Duration::from_secs(4);

/// El estado de una ruta en el árbol de trabajo, resumido a una letra para el panel.
/// `git status` da dos (índice y árbol); acá gana la más "fuerte" porque el panel tiene
/// una sola columna.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileMark {
    /// Conflicto de merge. Va primero: es lo único que bloquea trabajar.
    Conflict,
    Added,
    Modified,
    Deleted,
    Untracked,
}

impl FileMark {
    /// La letra que se dibuja. Coincide con la de `git status` para que no haya que
    /// aprender un alfabeto nuevo.
    pub fn letter(self) -> &'static str {
        match self {
            FileMark::Conflict => "U",
            FileMark::Added => "A",
            FileMark::Modified => "M",
            FileMark::Deleted => "D",
            FileMark::Untracked => "?",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// `None` = la carpeta no está en ningún repo. El panel sigue funcionando, sin marcas.
    pub root: Option<String>,
    pub branch: Option<String>,
    /// Un worktree enlazado, no el checkout principal. Es lo que distingue un workspace
    /// "PRIMARY" de uno derivado.
    pub is_worktree: bool,
    /// Ruta relativa al root → letra. Se manda plano en vez de anidado porque el panel
    /// resuelve por prefijo para marcar también las carpetas que contienen cambios.
    pub changes: HashMap<String, String>,
    /// Cuántas rutas cambiaron. Se manda aparte para no obligar al panel a contar un
    /// mapa que puede tener miles de entradas.
    pub changed_count: usize,
}

impl RepoInfo {
    fn none() -> Self {
        RepoInfo { root: None, branch: None, is_worktree: false, changes: HashMap::new(), changed_count: 0 }
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.arg("-C").arg(cwd).args(args);
    let out = output_with_timeout(&mut cmd, GIT_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
}

/// Traduce las dos columnas de `git status --porcelain` a una sola marca.
pub(crate) fn mark_from_xy(xy: &str) -> Option<FileMark> {
    let mut chars = xy.chars();
    let x = chars.next()?;
    let y = chars.next()?;

    // Conflicto: cualquiera de las combinaciones con `U`, más `AA` y `DD`.
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return Some(FileMark::Conflict);
    }
    if x == '?' {
        return Some(FileMark::Untracked);
    }
    // El índice manda sobre el árbol: un archivo agregado y luego editado se lee mejor
    // como "agregado" que como "modificado".
    match (x, y) {
        ('A', _) => Some(FileMark::Added),
        ('D', _) | (_, 'D') => Some(FileMark::Deleted),
        ('R', _) | ('C', _) => Some(FileMark::Added),
        ('M', _) | (_, 'M') => Some(FileMark::Modified),
        (' ', ' ') => None,
        _ => Some(FileMark::Modified),
    }
}

/// Parsea la salida `-z` de `git status --porcelain` (v1).
///
/// El formato es `XY<espacio>ruta\0`, y en un rename vienen DOS rutas: primero la nueva,
/// después la vieja, cada una con su `\0`. Sin consumir esa segunda, la ruta original se
/// leería como si fuera otra entrada y se perdería la sincronización de todo el resto.
/// El panel ahora lee porcelain v2; este parser queda para los tests del formato viejo.
#[cfg(test)]
pub(crate) fn parse_status_z(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut parts = raw.split('\0').filter(|s| !s.is_empty()).peekable();

    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let (xy, rest) = record.split_at(2);
        let path = rest.trim_start_matches(' ');
        let renamed = xy.starts_with('R') || xy.starts_with('C');
        if renamed {
            // La ruta de origen; se descarta, pero hay que sacarla del iterador.
            parts.next();
        }
        if let Some(mark) = mark_from_xy(xy) {
            out.insert(path.to_string(), mark.letter().to_string());
        }
    }
    out
}

/// Une las dos salidas de git en lo que ve el panel.
///
/// `rev` es `rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`
/// (una línea por dato). `None` significa que no hay repo. `status` es
/// `git status --porcelain=v2 -b -z`: trae la rama y los cambios en el mismo proceso.
pub(crate) fn repo_info_from_probes(rev: Option<&str>, status: Option<&str>) -> RepoInfo {
    let Some(rev) = rev else {
        return RepoInfo::none();
    };
    let Some((root, is_worktree)) = parse_rev_parse_locations(rev) else {
        return RepoInfo::none();
    };
    let (branch, changes) = status
        .map(parse_porcelain_v2)
        .unwrap_or_else(|| (None, HashMap::new()));
    RepoInfo {
        root: Some(root),
        branch,
        is_worktree,
        changed_count: changes.len(),
        changes,
    }
}

/// Tres rutas, en el orden en que se pidieron. La segunda y la tercera difieren en un
/// worktree enlazado; mirar si `.git` es archivo o carpeta falla con submódulos.
///
/// En Windows git puede devolver el mismo directorio con `\` o `/`, barra final y la
/// letra del disco en otro caso (`C:\repo\.git` y `c:/repo/.git`). Eso no es un worktree.
pub(crate) fn parse_rev_parse_locations(raw: &str) -> Option<(String, bool)> {
    let lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() < 3 {
        return None;
    }
    Some((lines[0].to_string(), !same_git_dir(lines[1], lines[2])))
}

/// El mismo directorio de git, aunque el texto no coincida.
///
/// `\` pasa a `/`, se quita la barra final y la letra de unidad se compara en minúscula.
/// El resto del camino se deja como vino: en Windows el disco es lo que git cambia de caso.
fn same_git_dir(a: &str, b: &str) -> bool {
    normalize_git_dir(a) == normalize_git_dir(b)
}

fn normalize_git_dir(raw: &str) -> String {
    let slashed = raw.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    let mut chars = trimmed.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => {
            format!("{}:{}", drive.to_ascii_lowercase(), chars.as_str())
        }
        _ => trimmed.to_string(),
    }
}

/// `git status --porcelain=v2 -b -z`: la rama en `# branch.head` y los cambios.
///
/// En v2 el punto ocupa el lugar del espacio de v1 (`M.` es "modificado en el índice").
/// Un rename (`2`) trae la ruta nueva y, en el registro siguiente, la vieja: hay que
/// consumirla o el resto del parseo se corre.
pub(crate) fn parse_porcelain_v2(raw: &str) -> (Option<String>, HashMap<String, String>) {
    let mut branch = None;
    let mut changes = HashMap::new();
    let mut parts = raw.split('\0').filter(|part| !part.is_empty());

    while let Some(record) = parts.next() {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            // `(detached)` no es un nombre de rama. Lo mismo que se descartaba `HEAD`.
            if head != "(detached)" && head != "HEAD" && !head.is_empty() {
                branch = Some(head.to_string());
            }
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            changes.insert(path.to_string(), FileMark::Untracked.letter().to_string());
            continue;
        }
        let (path_at, renamed) = match record.as_bytes().first() {
            Some(b'1') => (8, false),
            Some(b'2') => (9, true),
            Some(b'u') => (10, false),
            _ => continue,
        };
        let Some((xy, path)) = field_and_rest(record, path_at) else {
            continue;
        };
        if renamed {
            parts.next();
        }
        let xy_v1: String = xy
            .chars()
            .map(|ch| if ch == '.' { ' ' } else { ch })
            .collect();
        if let Some(mark) = mark_from_xy(&xy_v1) {
            changes.insert(path.to_string(), mark.letter().to_string());
        }
    }
    (branch, changes)
}

/// `path_at` campos separados por espacio, y el resto es la ruta (puede tener espacios).
/// Devuelve el segundo campo (XY) y esa ruta.
fn field_and_rest(record: &str, path_at: usize) -> Option<(&str, &str)> {
    let mut rest = record;
    let mut xy = "";
    for index in 0..path_at {
        let (field, tail) = rest.split_once(' ')?;
        if index == 1 {
            xy = field;
        }
        rest = tail;
    }
    if xy.len() < 2 {
        return None;
    }
    Some((xy, rest))
}

/// Todo lo que el panel necesita saber de la carpeta: repo, rama y cambios.
///
/// `async` y en un hilo de bloqueo: son a lo sumo dos procesos de git (un `rev-parse`
/// con varias preguntas y un `status` v2). Como comando síncrono Tauri los corría en
/// el hilo principal, congelando la ventana en un repo grande. El frontend además
/// espera al primer cuadro antes de pedir esto.
#[tauri::command]
pub async fn explorer_repo_info(path: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || repo_info_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn repo_info_sync(path: &str) -> Result<RepoInfo, String> {
    // Un solo `rev-parse` responde toplevel y los dos directorios de git, los dos en
    // absoluto (`--path-format` aplica a `--git-dir` y a `--git-common-dir`). Si falla,
    // no es un repo (o no hay `git`): no se lanza el `status`.
    let rev = git(
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ],
    );
    let status = if rev.is_some() {
        git(
            path,
            &[
                "status",
                "--porcelain=v2",
                "-b",
                "-z",
                "--untracked-files=normal",
            ],
        )
    } else {
        None
    };
    Ok(repo_info_from_probes(rev.as_deref(), status.as_deref()))
}
