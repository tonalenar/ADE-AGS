//! Comandos Tauri do descritor de capabilities.

use super::capability::ProviderMatrix;

/// Expõe ao frontend a mesma matriz usada pelo backend; não mantém um catálogo paralelo.
#[tauri::command]
pub fn harness_capability_matrix() -> Vec<ProviderMatrix> {
    super::matrix::matrix().to_vec()
}
