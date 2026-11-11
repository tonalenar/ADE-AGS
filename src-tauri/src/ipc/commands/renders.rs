//! `ags render …`: as páginas HTML que a aba publica (ver `renders/`). A aba publica e lista só as próprias. Apagar é
//! só pela tela (método `pessoa` em `authz.rs`). Mostrar a página na superfície é pedido à interface, que decide se a
//! conversa desta aba está à vista.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, open_tabs};
use crate::ipc::bridge::ask_frontend_within;
use crate::ipc::protocol::{arg_str, arg_str_opt};
use crate::renders;
use crate::util::now_ts_ms;

/// Evento que a superfície ouve para recarregar a lista (o nome segue o padrão `cc-…`).
pub(crate) const RENDERS_CHANGED_EVENT: &str = "cc-render-changed";

/// `render.publish`: guarda a página da aba que pediu e pede à interface que a mostre (salvo `show: false`).
pub(super) fn render_publish(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|tab| tab.id == from)
        .ok_or("A sua aba não está aberta em nenhuma janela.")?;
    let html = arg_str(args, "html")?;
    let title = arg_str_opt(args, "title").unwrap_or_default();
    let page = renders::publish_in(&renders::dir()?, &from, &me.cwd, &title, &html, now_ts_ms())?;
    let _ = app.emit(RENDERS_CHANGED_EVENT, ());
    if args.get("show").and_then(Value::as_bool) != Some(false) {
        // A interface só mostra se a conversa desta aba está à vista. Sem resposta, a página fica na lista mesmo assim.
        let _ = ask_frontend_within(
            app,
            "render.show",
            &json!({ "near": from, "id": page.id, "title": page.title }),
            Some(&me.window),
            Duration::from_secs(10),
        );
    }
    Ok(json!({ "page": page }))
}

/// `render.list`: as páginas que a própria aba publicou, da mais nova para a mais antiga.
pub(super) fn render_list(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let pages = renders::list_in(&renders::dir()?, Some(&from))?;
    Ok(json!({ "pages": pages }))
}
