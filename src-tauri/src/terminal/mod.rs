pub(crate) mod containment;
pub(crate) mod attachments;
#[cfg(test)]
mod attachments_test;

#[tauri::command]
pub fn save_pasted_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let mime = request.headers().get("x-mime")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "MIME da imagem ausente".to_string())?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => attachments::save_pasted_image(bytes, mime),
        _ => Err("Imagem deve ser enviada como bytes RAW".into()),
    }
}
#[cfg(test)]
mod test;
mod pty_manager;
pub use pty_manager::*;
