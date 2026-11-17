//! El árbol de archivos del workspace, su estado en git, el buscador y la lectura de
//! archivos para las tabs.
//!
//! Es lo que alimenta al panel derecho: qué hay en la carpeta y qué cambió. No cachea
//! nada — el frontend pide un nivel a la vez y vuelve a preguntar cuando hace falta.

mod files;
mod git;
mod ops;
mod quick_open;
mod search;
mod tree;
#[cfg(test)]
mod test;

pub use files::*;
pub use git::*;
pub use ops::*;
pub use quick_open::*;
pub use search::*;
pub use tree::*;

pub(crate) async fn off_ui<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
}
