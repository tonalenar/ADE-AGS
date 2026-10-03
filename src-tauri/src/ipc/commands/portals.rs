//! Los portales del canvas, para los agentes: `ags portal list|create|<acción> <portal> …`.
//!
//! Un portal es un navegador dibujado como nodo del canvas. Un agente conectado a él lo
//! maneja con las mismas acciones de las tools de navegador (`snapshot`, `click`, `type`…),
//! pero apuntando a ESE navegador por nombre, no al de la carpeta.
//!
//! **Permiso:** las mismas conexiones que entre agentes y notas (ver
//! `crate::canvas::portals_for`): un agente maneja los portales conectados con él; una
//! orquestadora, también los de su equipo.
//!
//! **Alcance:** una lista corta de acciones (ver `ACTIONS`). Nada que ejecute código en la
//! página, suba archivos o lea cookies: un portal puede estar en cualquier sitio y quien lo
//! maneja es un agente conectado, no el usuario.
//!
//! Quien actúa es el frontend (es el dueño del canvas y de la página); acá se decide el
//! permiso y se traduce la línea de comandos a un pedido de navegador.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::{caller, open_tabs};
use crate::canvas::{self, Boards, Portal};
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt};

/// Cuánto puede tardar una acción en la página (cargar, esperar un texto…).
const ACTION_TIMEOUT_S: u64 = 90;

/// Qué acciones admite un portal y cómo se arma su pedido. Es la lista del frontend
/// (`PORTAL_OPS`); está acá también para fallar con un mensaje útil antes de molestarlo.
pub(crate) const ACTIONS: &[&str] = &[
    "navigate", "history", "snapshot", "click", "hover", "type", "press", "select", "scroll", "wait",
    "screenshot", "console", "layout",
];

#[derive(Debug, Clone)]
pub(crate) struct Reachable {
    pub key: String,
    pub id: String,
    pub portal: Portal,
}

fn reachable(boards: &Boards, from: &str) -> Vec<Reachable> {
    canvas::portals_for(boards, from)
        .into_iter()
        .filter_map(|(key, id)| {
            let portal = boards.get(&key)?.portals.get(&id)?.clone();
            Some(Reachable { key, id, portal })
        })
        .collect()
}

/// Resuelve un portal por id o por nombre (sin mayúsculas). Un nombre ambiguo es un error.
pub(crate) fn resolve_portal<'a>(portals: &'a [Reachable], wanted: &str) -> Result<&'a Reachable, String> {
    if let Some(p) = portals.iter().find(|p| p.id == wanted) {
        return Ok(p);
    }
    let needle = wanted.trim().to_lowercase();
    let matches: Vec<&Reachable> = portals.iter().filter(|p| p.portal.name.to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] if portals.is_empty() => Err(format!(
            "'{wanted}' não está conectado com você. Você não tem nenhum portal: crie um com `ags portal create` ou peça ao usuário para ligar um portal ao seu terminal."
        )),
        [] => Err(format!(
            "'{wanted}' não está conectado com você. Portais conectados: {}",
            portals.iter().map(|p| p.portal.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "Há {} portais chamados '{wanted}'. Use o id: {}",
            many.len(),
            many.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn describe(p: &Reachable) -> Value {
    json!({ "id": p.id, "name": p.portal.name, "url": p.portal.url })
}

/// La ventana que tiene ese canvas: la clave es `ventana|carpeta`.
fn window_of(key: &str) -> &str {
    key.split('|').next().unwrap_or("main")
}

/// Un número que puede llegar como número (flag) o como texto (valor suelto).
fn num(args: &Value, key: &str) -> Result<Option<f64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(Value::String(s)) => s.trim().parse::<f64>().map(Some).map_err(|_| format!("--{key} tem que ser um número, veio '{s}'")),
        Some(_) => Err(format!("--{key} inválido")),
    }
}

fn flag(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        // `--clear` sin valor llega como "true"; también se acepta `--clear true`.
        Some(Value::String(s)) => matches!(s.as_str(), "" | "true" | "1" | "yes"),
        _ => false,
    }
}

fn need(args: &Value, key: &str, action: &str) -> Result<String, String> {
    arg_str_opt(args, key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("`ags portal {action}` precisa de --{key}."))
}

/// Traduce la acción de la línea de comandos al pedido de navegador que entiende el
/// frontend (`agentBridge.execute`). Falla con un mensaje claro si falta algo.
pub(crate) fn request_for(action: &str, args: &Value) -> Result<Value, String> {
    if !ACTIONS.contains(&action) {
        return Err(format!("Um portal não admite '{action}'. Admite: {}.", ACTIONS.join(", ")));
    }
    let mut req = json!({ "op": action });
    let set = |req: &mut Value, k: &str, v: Value| req[k] = v;
    match action {
        "navigate" => set(&mut req, "url", json!(need(args, "url", action)?)),
        "history" => set(&mut req, "action", json!(need(args, "action", action)?)),
        "snapshot" => set(&mut req, "full", json!(flag(args, "full"))),
        "click" | "hover" => set(&mut req, "target", json!(need(args, "target", action)?)),
        "type" => {
            set(&mut req, "target", json!(need(args, "target", action)?));
            set(&mut req, "text", json!(arg_str_opt(args, "text").unwrap_or_default()));
            set(&mut req, "clear", json!(flag(args, "clear")));
            set(&mut req, "submit", json!(flag(args, "submit")));
        }
        "press" => {
            set(&mut req, "key", json!(need(args, "key", action)?));
            if let Some(t) = arg_str_opt(args, "target") {
                set(&mut req, "target", json!(t));
            }
        }
        "select" => {
            set(&mut req, "target", json!(need(args, "target", action)?));
            set(&mut req, "value", json!(need(args, "value", action)?));
        }
        "scroll" => {
            if let Some(t) = arg_str_opt(args, "target") {
                set(&mut req, "target", json!(t));
            }
            if let Some(to) = arg_str_opt(args, "to") {
                set(&mut req, "to", json!(to));
            }
            if let Some(dy) = num(args, "dy")? {
                set(&mut req, "dy", json!(dy));
            }
        }
        "wait" => {
            if let Some(t) = arg_str_opt(args, "text") {
                set(&mut req, "text", json!(t));
            }
            if let Some(s) = arg_str_opt(args, "selector") {
                set(&mut req, "selector", json!(s));
            }
            set(&mut req, "gone", json!(flag(args, "gone")));
            set(&mut req, "idle", json!(flag(args, "idle")));
            if let Some(ms) = num(args, "timeoutMs")? {
                set(&mut req, "timeout_ms", json!(ms));
            }
        }
        "console" => {
            if let Some(l) = arg_str_opt(args, "level") {
                set(&mut req, "level", json!(l));
            }
            if let Some(n) = num(args, "since")? {
                set(&mut req, "since", json!(n));
            }
        }
        _ => {}
    }
    Ok(req)
}

pub(super) fn portal_list(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let portals = reachable(&canvas::load_boards(), &from);
    Ok(json!({ "portals": portals.iter().map(describe).collect::<Vec<_>>() }))
}

/// Crea un portal al lado de quien lo pide y conectado con él.
pub(super) fn portal_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())?;
    let mut req = json!({ "op": "create", "cwd": me.cwd, "near": me.id });
    if let Some(name) = arg_str_opt(args, "name").filter(|n| !n.trim().is_empty()) {
        req["name"] = json!(name.trim());
    }
    if let Some(url) = arg_str_opt(args, "url").filter(|u| !u.trim().is_empty()) {
        req["url"] = json!(url.trim());
    }
    let raw = ask_frontend_within(
        app,
        "canvas.portal",
        &req,
        Some(&me.window),
        std::time::Duration::from_secs(30),
    )?;
    let created = unwrap_frontend_result(raw)?;
    Ok(json!({ "created": created }))
}

/// `ags portal <acción> <portal> …`: lo que el agente le pide a ese navegador.
pub(super) fn portal_action(app: &AppHandle, args: &Value, action: &str) -> Result<Value, String> {
    let from = caller(args)?;
    let boards = canvas::load_boards();
    let portals = reachable(&boards, &from);
    let target = resolve_portal(&portals, &arg_str(args, "name")?)?;
    let request = request_for(action, args)?;

    // El proyecto del agente: es el límite de lo que el navegador puede tocar.
    let cwd = open_tabs(app)?.into_iter().find(|t| t.id == from).map(|t| t.cwd).unwrap_or_default();
    let owner = json!({ "kind": "tab", "id": from });
    let raw = ask_frontend_within(
        app,
        "canvas.portal",
        &json!({ "op": "run", "cwd": cwd, "id": target.id, "request": request, "owner": owner }),
        Some(window_of(&target.key)),
        std::time::Duration::from_secs(ACTION_TIMEOUT_S),
    )?;
    let out = unwrap_frontend_result(raw)?;
    Ok(json!({ "portal": describe(target), "text": out.get("text").cloned().unwrap_or(Value::Null) }))
}

#[cfg(test)]
mod test {
    use super::*;

    fn portal(id: &str, name: &str) -> Reachable {
        Reachable { key: "main|/p".into(), id: id.into(), portal: Portal { name: name.into(), ..Default::default() } }
    }

    #[test]
    fn resuelve_por_nombre_sin_mayusculas_y_por_id() {
        let ps = vec![portal("portal-1", "Docs"), portal("portal-2", "App")];
        assert_eq!(resolve_portal(&ps, "docs").unwrap().id, "portal-1");
        assert_eq!(resolve_portal(&ps, "portal-2").unwrap().id, "portal-2");
    }

    #[test]
    fn un_portal_no_conectado_lista_los_que_si() {
        let err = resolve_portal(&[portal("portal-1", "Docs")], "App").unwrap_err();
        assert!(err.contains("Docs"), "{err}");
        assert!(resolve_portal(&[], "App").unwrap_err().contains("ags portal create"));
    }

    #[test]
    fn el_pedido_de_cada_accion_lleva_lo_que_el_frontend_espera() {
        let nav = request_for("navigate", &json!({ "url": "http://localhost:3000" })).unwrap();
        assert_eq!(nav, json!({ "op": "navigate", "url": "http://localhost:3000" }));

        let ty = request_for("type", &json!({ "target": "@e2", "text": "hola", "submit": "true" })).unwrap();
        assert_eq!(ty["target"], "@e2");
        assert_eq!(ty["submit"], true);
        assert_eq!(ty["clear"], false);

        let scroll = request_for("scroll", &json!({ "dy": "300" })).unwrap();
        assert_eq!(scroll["dy"], 300.0);

        let wait = request_for("wait", &json!({ "text": "Listo", "timeoutMs": 4000 })).unwrap();
        assert_eq!(wait["timeout_ms"], 4000.0);
    }

    #[test]
    fn falta_un_argumento_obligatorio_lo_nombra() {
        let err = request_for("click", &json!({})).unwrap_err();
        assert!(err.contains("--target") && err.contains("click"), "{err}");
        assert!(request_for("navigate", &json!({})).unwrap_err().contains("--url"));
    }

    #[test]
    fn lo_peligroso_no_esta_en_la_lista() {
        for banned in ["eval", "upload", "cookies", "storage", "mock", "drag"] {
            let err = request_for(banned, &json!({})).unwrap_err();
            assert!(err.contains("não admite"), "{banned}: {err}");
        }
    }

    #[test]
    fn un_numero_mal_escrito_se_rechaza_con_el_nombre_del_flag() {
        assert!(request_for("scroll", &json!({ "dy": "mucho" })).unwrap_err().contains("--dy"));
    }
}
