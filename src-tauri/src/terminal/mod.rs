pub(crate) mod containment;
pub(crate) mod attachments;
#[cfg(test)]
mod attachments_test;

#[tauri::command]
pub fn save_pasted_image(bytes: Vec<u8>, mime: String) -> Result<String, String> {
    attachments::save_pasted_image(&bytes, &mime)
}
#[cfg(test)]
mod test;
mod pty_manager;
pub use pty_manager::*;
