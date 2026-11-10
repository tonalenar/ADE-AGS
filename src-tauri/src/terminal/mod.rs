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
#[cfg(test)]
pub(crate) mod replay;
pub(crate) mod recorder;
mod pty_manager;
mod session;
#[cfg(windows)]
mod win_conpty;
pub use pty_manager::*;
pub(crate) use pty_manager::open_pty;
pub(crate) use pty_manager::scrub_app_child_env;
pub use session::SESSION_ENV;
pub(crate) use session::{authorize, issue_conversation_token, publish_token, register_conversation, release_token};
pub(crate) use session::authorize_actor;
pub use session::{authorize_task, classify_caller, principal_of, register_task_process, release_task_process, Caller, Principal};
#[cfg(test)]
pub(crate) use session::ancestry_required;
