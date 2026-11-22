use super::store::{DesignFrameStore, FramePolicy};

/// Registra um documento HTML montado no mapa efêmero em memória e devolve seu id SHA-256.
/// A CSP aplicada no protocolo é sempre derivada de `FramePolicy` no backend.
#[tauri::command]
pub fn design_frame_register(
    store: tauri::State<'_, DesignFrameStore>,
    html: String,
    policy: Option<FramePolicy>,
) -> Result<String, String> {
    store.register(html, policy.unwrap_or_default())
}
