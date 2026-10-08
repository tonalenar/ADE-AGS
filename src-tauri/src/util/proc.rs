//! Ejecutar un programa externo sin quedar colgado si no termina.
//!
//! `Command::output()` espera para siempre. Eso es aceptable en un script, no acá: varios
//! de estos comandos (`opencode session list`, `npx skills …`) corren en caminos donde un
//! cuelgue no se nota como cuelgue — se nota como "la app dejó de responder", porque el
//! llamador puede estar sosteniendo el mutex de la base mientras espera.

use std::process::{Command, Output};
use std::time::Duration;

/// Como `Command::output()`, pero mata el proceso si pasa de `limit`.
///
/// En ese caso devuelve un error `TimedOut` en vez de una salida vacía: "tardó demasiado"
/// y "no encontró nada" son cosas distintas, y confundirlas haría que un binario colgado
/// se vea como una sesión inexistente.
pub fn output_with_timeout(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    // A implementação (flag, dreno dos pipes, kill do grupo, log) vive em `spawn`.
    super::spawn::output(cmd, limit)
}
