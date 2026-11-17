pub(crate) mod attachments;
#[cfg(test)]
mod attachments_test;
pub(crate) mod containment;

#[tauri::command]
pub fn save_pasted_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let mime = request
        .headers()
        .get("x-mime")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "MIME da imagem ausente".to_string())?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => attachments::save_pasted_image(bytes, mime),
        _ => Err("Imagem deve ser enviada como bytes RAW".into()),
    }
}
mod pty_manager;
pub(crate) mod recorder;
#[cfg(test)]
pub(crate) mod replay;
mod session;
#[cfg(test)]
mod test;
#[cfg(windows)]
mod win_conpty;
pub(crate) use pty_manager::open_pty;
pub(crate) use pty_manager::scrub_app_child_env;
pub use pty_manager::*;
pub use session::SESSION_ENV;
#[cfg(test)]
pub(crate) use session::ancestry_required;
pub(crate) use session::authorize_actor;
pub(crate) use session::parent_pid;
pub(crate) use session::ProcessIdentity;
pub(crate) use session::descends_from_identity;
pub(crate) use session::discard_pending_conversation_token;
pub(crate) use session::process_start_time;
pub use session::{
    Caller, Principal, authorize_task, classify_caller, principal_of, register_task_process,
    release_task_process,
};
pub(crate) use session::{authorize, issue_conversation_token, register_conversation, release_token};
#[cfg(test)]
pub(crate) use session::publish_token;
