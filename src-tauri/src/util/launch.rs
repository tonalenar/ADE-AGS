//! Lanzar un programa externo sin que sus argumentos pasen por un shell.
//!
//! ## El problema
//!
//! En Windows, `npm i -g` no deja un ejecutable: deja un `codex.cmd`, un `opencode.cmd`. Un
//! `.cmd` no se ejecuta, lo interpreta `cmd.exe`, y `cmd.exe` relee cada argumento: `&`, `|`,
//! `<`, `>`, `%VAR%` y `!` tienen significado, y un salto de línea corta el comando. Desde
//! 1.77 (CVE-2024-24576) la biblioteca estándar de Rust escapa lo que se puede escapar y
//! **se niega** a pasar un argumento con `\r` o `\n` a un `.cmd`/`.bat`: no existe forma de
//! citarlo que `cmd.exe` respete. De ahí el `batch file arguments are invalid` con el que
//! fallaba Codex: el prompt de una tarea casi siempre tiene varias líneas.
//!
//! Armar `cmd /c "<programa> <args>"` a mano sería peor: el prompt es texto que no controla
//! nadie, y concatenarlo en una línea de `cmd.exe` es inyección de comandos.
//!
//! ## La solución
//!
//! Un shim de npm (el formato de `cmd-shim`) es una receta fija: "corré ESTE `.exe`" o
//! "corré `node` con ESTE script". Se lee la receta y se lanza directamente lo que el shim
//! lanzaría, con los argumentos por `CreateProcess` y el citado estándar, sin ningún shell
//! en el medio. Un `.cmd`/`.bat` que no tiene esa forma se deja en manos de la biblioteca
//! estándar, que escapa lo escapable y rechaza —con un error que lo explica— lo que no.
//!
//! En el resto de los sistemas no cambia nada: el programa se lanza tal cual.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use regex::Regex;

/// Lo que se ejecuta de verdad: el programa y lo que va antes de los argumentos de quien
/// lanza (el script, cuando el shim corre un intérprete).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
}

/// Un `Command` que lanza `program` con `args` sin que ningún shell los interprete.
///
/// `program` ya tiene que venir resuelto (ruta completa, ver `find_program`). Falla antes
/// de lanzar si es un `.cmd`/`.bat` desconocido y algún argumento no puede llegar intacto.
pub fn external_command<S: AsRef<OsStr>>(program: &Path, args: &[S]) -> std::io::Result<Command> {
    let resolved = if cfg!(windows) && is_batch(program) {
        let text = std::fs::read(program).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let newline = args.iter().any(|a| has_newline(a.as_ref()));
        resolve_batch(program, &text, newline, crate::util::find_program)?
    } else {
        Resolved { program: program.to_path_buf(), prefix: Vec::new() }
    };
    let mut command = Command::new(&resolved.program);
    command.args(&resolved.prefix).args(args);
    // Construção, sem spawn: quem for lançar herda a janela escondida.
    crate::util::spawn::apply_window(&mut command, crate::util::spawn::WindowMode::Hidden);
    Ok(command)
}

/// Si es un script de `cmd.exe`, por la extensión.
pub fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| e == "cmd" || e == "bat")
}

fn has_newline(arg: &OsStr) -> bool {
    arg.as_encoded_bytes().iter().any(|b| *b == b'\n' || *b == b'\r')
}

/// Qué lanzar en lugar de un `.cmd`/`.bat`, dado su contenido.
///
/// `find` busca un programa en el PATH (el intérprete de un shim que no trae el suyo).
pub fn resolve_batch(
    path: &Path,
    text: &str,
    has_newline: bool,
    find: impl Fn(&str) -> Option<PathBuf>,
) -> std::io::Result<Resolved> {
    let dir = path.parent().unwrap_or(Path::new(""));
    if let Some(resolved) = parse_npm_shim(text, dir, &find) {
        return Ok(resolved);
    }
    if has_newline {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "'{}' es un script de cmd.exe que no es un shim de npm reconocido, y cmd.exe no puede \
                 recibir un argumento con saltos de línea sin reinterpretarlo",
                path.display()
            ),
        ));
    }
    // La biblioteca estándar escapa `%`, `&`, `|` y compañía para `cmd.exe`.
    Ok(Resolved { program: path.to_path_buf(), prefix: Vec::new() })
}

/// Lee la receta de un shim de `cmd-shim`. `None` = no tiene esa forma, o lo que lanzaría
/// no existe en disco.
///
/// Las dos formas que genera npm:
///
/// ```text
/// "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
/// ... & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
/// ```
///
/// En la segunda, `_prog` es el `node.exe` al lado del shim si existe, o `node` del PATH.
/// Las versiones viejas escriben `%~dp0` y nombran `node` directamente; también se leen.
pub fn parse_npm_shim(text: &str, dir: &Path, find: &impl Fn(&str) -> Option<PathBuf>) -> Option<Resolved> {
    let text = text.replace("%~dp0", "%dp0%");
    let target = Regex::new(r#""%dp0%\\([^"]+)"\s+%\*"#).expect("regex fija");
    let local = |rel: &str| {
        let path = dir.join(rel.replace('\\', std::path::MAIN_SEPARATOR_STR));
        path.is_file().then_some(path)
    };
    let native = |path: PathBuf| is_exe(&path).then_some(path);

    for line in text.lines() {
        let Some(m) = target.captures(line) else { continue };
        let whole = m.get(0).expect("captura 0");
        let script = &m[1];
        let before = line[..whole.start()].trim().trim_start_matches('@').trim();

        let interpreter = if before.is_empty() {
            // Sin intérprete: el shim corre el objetivo directamente.
            if let Some(exe) = local(script).and_then(native) {
                return Some(Resolved { program: exe, prefix: Vec::new() });
            }
            continue;
        } else if before.ends_with("\"%_prog%\"") {
            prog_of(&text, &local, find)
        } else if let Some(rel) = quoted_local(before) {
            local(&rel)
        } else {
            before.split_whitespace().last().and_then(|name| find(name.trim_matches('"')))
        };
        let (Some(interpreter), Some(script)) = (interpreter.and_then(native), local(script)) else { continue };
        return Some(Resolved { program: interpreter, prefix: vec![script.into_os_string()] });
    }
    None
}

/// El `_prog` de un shim moderno: el que está al lado si existe, si no el del PATH.
fn prog_of(text: &str, local: &impl Fn(&str) -> Option<PathBuf>, find: &impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    let exists = Regex::new(r#"IF EXIST "%dp0%\\([^"]+)""#).expect("regex fija");
    let bare = Regex::new(r#"SET "_prog=([^"%\\]+)""#).expect("regex fija");
    exists
        .captures(text)
        .and_then(|c| local(&c[1]))
        .or_else(|| bare.captures(text).and_then(|c| find(&c[1])))
}

/// `"%dp0%\node.exe"` al final de lo que precede al script → `node.exe`.
fn quoted_local(before: &str) -> Option<String> {
    let re = Regex::new(r#""%dp0%\\([^"]+)"$"#).expect("regex fija");
    re.captures(before).map(|c| c[1].to_string())
}

/// Lo que se puede lanzar sin intérprete de comandos: un `.exe` o `.com` en Windows, un
/// archivo en el resto.
fn is_exe(path: &Path) -> bool {
    if !cfg!(windows) {
        return path.is_file();
    }
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| e == "exe" || e == "com")
}
