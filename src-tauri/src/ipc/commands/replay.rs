//! `ags replay start|stop|status`: grava a saída crua de uma aba como fixture dos testes por replay.
//! Só para desenvolvimento: recusa tudo se o app não foi aberto com `ADE_AGS_REPLAY_RECORD=1`.
//! Ver `terminal/recorder.rs` e `docs/ade-ags/REPLAY_TESTES.md`.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;
use super::tabs::pty_id_for_tab;
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_checked};
use crate::terminal::recorder::{self, Recording};

fn ensure_enabled() -> Result<(), String> {
    if recorder::enabled() {
        return Ok(());
    }
    Err(format!(
        "O gravador de replay é só para desenvolvimento e está desligado. Abra o app com {}=1 (de preferência a instância isolada do scripts/dev-local.ps1).",
        recorder::RECORD_ENV
    ))
}

pub(super) fn replay_start(app: &AppHandle, args: &Value) -> Result<Value, String> {
    ensure_enabled()?;
    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;
    let seconds = arg_u64_checked(args, "seconds")?.unwrap_or(recorder::DEFAULT_SECS).clamp(1, recorder::MAX_SECS);
    let prelude_bytes = arg_u64_checked(args, "prelude")?
        .map(|n| n as usize)
        .unwrap_or(recorder::DEFAULT_PRELUDE_BYTES)
        .min(recorder::MAX_PRELUDE_BYTES);
    let (cols, rows) = crate::terminal::pty_size(pty_id).unwrap_or((120, 30));
    let prelude = (prelude_bytes > 0).then(|| crate::terminal::tail_of(pty_id, prelude_bytes)).flatten();
    recorder::start(
        pty_id,
        Recording::new(&tab_id, cols, rows, std::time::Duration::from_secs(seconds), recorder::MAX_BYTES, prelude),
    )?;
    Ok(json!({ "tabId": tab_id, "recording": true, "seconds": seconds, "preludeBytes": prelude_bytes, "cols": cols, "rows": rows }))
}

pub(super) fn replay_stop(app: &AppHandle, args: &Value) -> Result<Value, String> {
    ensure_enabled()?;
    let tab_id = arg_str(args, "tab")?;
    let recording = recorder::stop_tab(&tab_id).ok_or_else(|| format!("A aba {tab_id} não está sendo gravada."))?;
    if recording.looks_secret() {
        return Err("A gravação parece conter um segredo (token, senha ou chave) e foi descartada inteira: nada foi devolvido nem salvo. Grave de novo sem o segredo na tela.".into());
    }
    let agent = agent_of(app, &tab_id).unwrap_or_default();
    let now = chrono::Local::now();
    Ok(recording.fixture(&agent, &now.to_rfc3339(), &now.format("%Y%m%d-%H%M%S").to_string()))
}

pub(super) fn replay_status() -> Result<Value, String> {
    let active: Vec<Value> = recorder::active()
        .into_iter()
        .map(|(tab, ms, bytes, truncated)| json!({ "tabId": tab, "elapsedMs": ms, "bytes": bytes, "truncated": truncated }))
        .collect();
    Ok(json!({ "enabled": recorder::enabled(), "recordings": active }))
}

/// O agente da aba (`codex`, `opencode`…), para o nome e o `agent` da fixture.
fn agent_of(app: &AppHandle, tab_id: &str) -> Option<String> {
    let db = db(app).ok()?;
    let conn = db.lock().ok()?;
    conn.query_row("SELECT agent_id FROM tabs WHERE id = ?1", [tab_id], |r| r.get::<_, String>(0)).ok()
}
