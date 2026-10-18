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
use crate::ipc::bridge::{ask_frontend_within, take_act_progress, unwrap_frontend_result, with_partial_progress};
use crate::ipc::protocol::{arg_str, arg_str_opt};

/// Cuánto puede tardar una acción en la página (cargar, esperar un texto…).
const ACTION_TIMEOUT_S: u64 = 90;
/// `act` encadeia vários passos (cada um é um snapshot, uma pergunta ao Jev e uma ação).
const ACT_TIMEOUT_S: u64 = 115;

/// Qué acciones admite un portal y cómo se arma su pedido. Es la lista del frontend
/// (`PORTAL_OPS`); está acá también para fallar con un mensaje útil antes de molestarlo.
pub(crate) const ACTIONS: &[&str] = &[
    "navigate", "history", "snapshot", "click", "hover", "type", "press", "select", "scroll", "wait",
    "screenshot", "console", "layout", "act", "reset",
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

/// El origen (`https://www.amazon.com.br`) de la URL de un portal, para consultar al proxy.
fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

/// La nota de «verificação anti-robô em andamento» si el sitio del portal respondió un desafío hace poco (plan v2, I4).
fn challenge_note(url: &str) -> Option<String> {
    let action = crate::preview::challenge_in_progress(&origin_of(url)?)?;
    Some(format!(
        "verificação anti-robô em andamento ({action}): o site entregou um desafio em vez da página. Espere uns segundos (`ags portal wait <portal> --idle`) e leia de novo; não é uma página parada nem um erro do portal."
    ))
}

/// El estado de cada portal para `ags portals`: lo que el frontend sabe de la carga, y la verificación anti-robot del proxy.
/// Sin respuesta del frontend (ventana trabada o cerrándose) el estado es «sem resposta» con la causa, no un error del listado.
fn with_states(app: &AppHandle, portals: &[Reachable]) -> Vec<Value> {
    let mut by_window: std::collections::BTreeMap<&str, Vec<&Reachable>> = std::collections::BTreeMap::new();
    for p in portals {
        by_window.entry(window_of(&p.key)).or_default().push(p);
    }
    let mut states: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for (window, group) in by_window {
        let ids: Vec<&str> = group.iter().map(|p| p.id.as_str()).collect();
        let asked = ask_frontend_within(
            app,
            "canvas.portal",
            &json!({ "op": "states", "ids": ids }),
            Some(window),
            std::time::Duration::from_secs(4),
        )
        .and_then(unwrap_frontend_result);
        match asked {
            Ok(v) => {
                if let Some(map) = v.get("states").and_then(Value::as_object) {
                    states.extend(map.iter().map(|(k, v)| (k.clone(), v.clone())));
                }
            }
            Err(why) => {
                for p in group {
                    states.insert(p.id.clone(), json!({ "state": "sem resposta", "hint": why }));
                }
            }
        }
    }
    portals
        .iter()
        .map(|p| {
            let mut row = describe(p);
            let info = states.remove(&p.id).unwrap_or_else(|| json!({ "state": "oculto", "hint": "o nó do portal não está desenhado" }));
            row["state"] = info.get("state").cloned().unwrap_or(Value::Null);
            row["hint"] = info.get("hint").cloned().unwrap_or(Value::Null);
            if let Some(note) = challenge_note(&p.portal.url) {
                row["state"] = json!("verificação anti-robô");
                row["hint"] = json!(note);
            }
            row
        })
        .collect()
}

/// Anexa o progresso parcial do `act` ao erro (se o puente venceu no meio) e limpa o que sobrou.
fn act_error(portal_id: &str, error: String) -> String {
    with_partial_progress(error, take_act_progress(portal_id))
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
        // O Jev pilota: o agente dá o objetivo (e os valores a digitar) e a app navega passo a passo.
        "act" => {
            set(&mut req, "goal", json!(need(args, "goal", action)?));
            let fills: Vec<Value> = match args.get("fill") {
                Some(Value::Array(list)) => list.clone(),
                Some(Value::String(one)) if !one.is_empty() => vec![json!(one)],
                _ => Vec::new(),
            };
            if fills.iter().any(|f| !f.as_str().is_some_and(|s| s.contains('='))) {
                return Err("--fill precisa de `campo=valor` (repita a flag para vários).".into());
            }
            set(&mut req, "fills", Value::Array(fills));
            // `--expect text:|url:|count:|absent:` (repetível): o piloto confere por código, sem o Jev (plano v2, 5.1).
            let expects: Vec<Value> = match args.get("expect") {
                Some(Value::Array(list)) => list.clone(),
                Some(Value::String(one)) if !one.is_empty() => vec![json!(one)],
                _ => Vec::new(),
            };
            if expects.iter().any(|e| !e.as_str().is_some_and(|s| s.contains(':'))) {
                return Err("--expect precisa de `tipo:valor` (text:, url:, count: ou absent:); repita a flag para vários.".into());
            }
            set(&mut req, "expects", Value::Array(expects));
            if let Some(n) = num(args, "steps")? {
                set(&mut req, "steps", json!(n));
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

pub(super) fn portal_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let portals = reachable(&canvas::load_boards(), &from);
    Ok(json!({ "portals": with_states(app, &portals), "window": crate::ipc::bridge::window_report() }))
}

/// `ags portal close <portal>`: el agente limpia lo que creó. Mismo permiso que el resto: un portal conectado con él.
pub(super) fn portal_close(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let portals = reachable(&canvas::load_boards(), &from);
    let target = resolve_portal(&portals, &arg_str(args, "name")?)?;
    let raw = ask_frontend_within(
        app,
        "canvas.portal",
        &json!({ "op": "close", "key": target.key, "id": target.id }),
        Some(window_of(&target.key)),
        std::time::Duration::from_secs(15),
    )?;
    unwrap_frontend_result(raw)?;
    Ok(json!({ "closed": describe(target) }))
}

/// Quantos navegadores um agente pode ter ao mesmo tempo (os conectados a ele). Cada um é uma página viva no canvas: agentes que
/// criavam um por teste e nunca fechavam enchiam o canvas de navegadores iguais.
pub(crate) const MAX_PORTALS_PER_AGENT: usize = 4;

/// O portal que já tem esse nome (sem maiúsculas): `create` com um nome que já existe reaproveita em vez de criar outro. Pura.
pub(crate) fn reusable<'a>(portals: &'a [Reachable], name: &str) -> Option<&'a Reachable> {
    let needle = name.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    portals.iter().find(|p| p.portal.name.trim().to_lowercase() == needle)
}

/// Qual navegador já conectado um `create` reaproveita: o de mesmo nome; senão o que já está na origem pedida; senão o
/// primeiro. A tela de um Android só pelo nome. `None` = nenhum conectado. Pura.
pub(crate) fn reuse_choice<'a>(portals: &'a [Reachable], name: Option<&str>, url: Option<&str>) -> Option<&'a Reachable> {
    if let Some(found) = name.and_then(|n| reusable(portals, n)) {
        return Some(found);
    }
    let browsers: Vec<&Reachable> = portals.iter().filter(|p| p.portal.kind.is_none()).collect();
    if let Some(url) = url {
        if let Some(found) = browsers.iter().find(|p| same_origin(&p.portal.url, url)) {
            return Some(found);
        }
    }
    browsers.first().copied()
}

/// Leva o navegador reaproveitado ao endereço pedido (se houver) e monta a resposta do `create`.
fn reuse_reply(app: &AppHandle, args: &Value, portal: Value, url: Option<&str>, note: Option<String>) -> Result<Value, String> {
    let mut out = json!({ "created": portal, "reused": true });
    if let Some(note) = note {
        out["note"] = json!(note);
    }
    if let (Some(url), Some(id)) = (url, out["created"]["id"].as_str().map(str::to_string)) {
        let mut nav = args.clone();
        nav["name"] = json!(id);
        nav["url"] = json!(url);
        let done = portal_action(app, &nav, "navigate")?;
        out["navigated"] = done.get("portal").cloned().unwrap_or(Value::Null);
    }
    Ok(out)
}

/// Crea un portal al lado de quien lo pide y conectado con él. Antes, reaproveita: o navegador já conectado (o de mesmo nome,
/// o da mesma origem, o primeiro) ou o que ficou no canvas sem dono; só `--new` abre outro de propósito. Recusa passar do teto.
pub(super) fn portal_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())?;
    let mine = reachable(&canvas::load_boards(), &from);
    let fresh = args.get("new").and_then(Value::as_bool).unwrap_or(false);
    let name = arg_str_opt(args, "name").filter(|n| !n.trim().is_empty());
    let url = arg_str_opt(args, "url").map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    // Cada agente que navegava abria um navegador novo (um nome por teste): agora o que já está aberto serve, e o nome
    // diferente só abre outro com `--new`.
    let choice = if fresh { name.as_deref().and_then(|n| reusable(&mine, n)) } else { reuse_choice(&mine, name.as_deref(), url.as_deref()) };
    if let Some(existing) = choice {
        let renamed = name.as_deref().is_some_and(|n| n.trim().to_lowercase() != existing.portal.name.trim().to_lowercase());
        let note = renamed.then(|| format!("Reaproveitei o navegador «{}», que já estava aberto com você (passe --new para abrir outro).", existing.portal.name));
        return reuse_reply(app, args, describe(existing), url.as_deref(), note);
    }
    if mine.is_empty() && !fresh {
        let mut req = json!({ "op": "adopt", "cwd": me.cwd, "near": me.id });
        if let Some(url) = &url {
            req["url"] = json!(url);
        }
        let raw = ask_frontend_within(app, "canvas.portal", &req, Some(&me.window), std::time::Duration::from_secs(30))?;
        let adopted = unwrap_frontend_result(raw)?;
        if adopted.get("id").and_then(Value::as_str).is_some() {
            let label = adopted.get("name").and_then(Value::as_str).unwrap_or("navegador").to_string();
            let note = format!("Reaproveitei o navegador «{label}», que tinha ficado no canvas sem dono (passe --new para abrir outro).");
            let mut out = reuse_reply(app, args, adopted, url.as_deref(), Some(note))?;
            out["adopted"] = json!(true);
            return Ok(out);
        }
    }
    if mine.len() >= MAX_PORTALS_PER_AGENT {
        return Err(format!(
            "Você já tem {} navegadores ({}). Reutilize um: `ags portal navigate \"<nome>\" <url>` abre outra página no mesmo, e `ags portal close \"<nome>\"` fecha os que não precisa mais.",
            mine.len(),
            mine.iter().map(|p| p.portal.name.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
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

/// Un endereço do próprio computador: o app que o agente está construindo (`localhost:5173`), não um site.
fn is_local(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        None => false,
    }
}

/// Mesma origem (esquema, host e porta): um servidor de desenvolvimento que reinicia abre o mesmo endereço de novo.
fn same_origin(a: &str, b: &str) -> bool {
    match (url::Url::parse(a.trim()), url::Url::parse(b.trim())) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// `ags open <url>` (e `ags http://…`, que é como as ferramentas que respeitam `$BROWSER` chamam o navegador).
/// Um endereço local abre no canvas — reaproveitando o navegador conectado que já está nessa origem — e qualquer outro vai
/// para o navegador do sistema: um login (`gh auth login`, `vercel login`) precisa das sessões da pessoa, que o
/// navegador do canvas não tem. `--canvas` força o canvas.
pub(super) fn portal_open(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let raw = need(args, "url", "open")?;
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| format!("'{raw}' não é um endereço http(s)."))?;
    if !is_local(&parsed) && !flag(args, "canvas") {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())?;
        return Ok(json!({ "opened": "system", "url": parsed.as_str() }));
    }
    let from = caller(args)?;
    let portals = reachable(&canvas::load_boards(), &from);
    if let Some(existing) = portals.iter().find(|p| same_origin(&p.portal.url, parsed.as_str())) {
        let mut nav = args.clone();
        nav["name"] = json!(existing.id);
        let done = portal_action(app, &nav, "navigate")?;
        return Ok(json!({ "opened": "canvas", "reused": describe(existing), "navigated": done.get("portal").cloned().unwrap_or(Value::Null) }));
    }
    let mut create = args.clone();
    create["url"] = json!(parsed.as_str());
    let made = portal_create(app, &create)?;
    Ok(json!({ "opened": "canvas", "created": made.get("created").cloned().unwrap_or(Value::Null) }))
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
    // Un `act` anterior que no terminó no debe pasar su progreso a este.
    if action == "act" {
        take_act_progress(&target.id);
    }
    let asked = ask_frontend_within(
        app,
        "canvas.portal",
        &json!({ "op": "run", "cwd": cwd, "id": target.id, "request": request, "owner": owner }),
        Some(window_of(&target.key)),
        std::time::Duration::from_secs(if action == "act" { ACT_TIMEOUT_S } else { ACTION_TIMEOUT_S }),
    )
    .and_then(unwrap_frontend_result);
    let out = match asked {
        Ok(out) => out,
        Err(e) if action == "act" => return Err(act_error(&target.id, e)),
        Err(e) => return Err(e),
    };
    if action == "act" {
        take_act_progress(&target.id);
    }
    let mut text = out.get("text").cloned().unwrap_or(Value::Null);
    // Un desafío anti-robot en curso explica una página «parada»: se lo dice al agente junto al resultado.
    if let (Some(note), Some(body)) = (challenge_note(&target.portal.url), text.as_str()) {
        text = json!(format!("[{note}]\n{body}"));
    }
    Ok(json!({ "portal": describe(target), "text": text }))
}

#[cfg(test)]
mod test {
    use super::*;

    fn portal(id: &str, name: &str) -> Reachable {
        Reachable { key: "main|/p".into(), id: id.into(), portal: Portal { name: name.into(), ..Default::default() } }
    }

    #[test]
    fn create_com_um_nome_que_ja_existe_reaproveita_o_portal() {
        let portals = vec![portal("p1", "Teste"), portal("p2", "Outro")];
        assert_eq!(reusable(&portals, " teste ").map(|p| p.id.as_str()), Some("p1"));
        assert_eq!(reusable(&portals, "OUTRO").map(|p| p.id.as_str()), Some("p2"));
        assert!(reusable(&portals, "novo").is_none());
        assert!(reusable(&portals, "  ").is_none());
        assert!(MAX_PORTALS_PER_AGENT >= 2);
    }

    #[test]
    fn create_reaproveita_o_navegador_ja_aberto_mesmo_com_outro_nome() {
        let mut lojinha = portal("p1", "loja");
        lojinha.portal.url = "http://localhost:8765/gen/loja.html".into();
        let mut wiki = portal("p2", "wiki");
        wiki.portal.url = "https://pt.wikipedia.org/wiki/X".into();
        let mut celular = portal("p3", "celular");
        celular.portal.kind = Some("android".into());
        let portals = vec![celular, lojinha, wiki];
        // o de mesmo nome
        assert_eq!(reuse_choice(&portals, Some("WIKI"), None).map(|p| p.id.as_str()), Some("p2"));
        // outro nome: o que já está na origem pedida
        assert_eq!(reuse_choice(&portals, Some("bench-jev-xyz"), Some("https://pt.wikipedia.org/wiki/Y")).map(|p| p.id.as_str()), Some("p2"));
        // sem nome nem origem conhecida: o primeiro navegador (nunca a tela do Android)
        assert_eq!(reuse_choice(&portals, None, Some("https://example.com")).map(|p| p.id.as_str()), Some("p1"));
        assert_eq!(reuse_choice(&portals, None, None).map(|p| p.id.as_str()), Some("p1"));
        // o Android só pelo nome
        assert_eq!(reuse_choice(&portals, Some("celular"), None).map(|p| p.id.as_str()), Some("p3"));
        assert!(reuse_choice(&[], Some("x"), None).is_none());
    }

    #[test]
    fn o_origem_do_portal_vem_da_url() {
        assert_eq!(origin_of("https://www.amazon.com.br/s?k=x").as_deref(), Some("https://www.amazon.com.br"));
        assert_eq!(origin_of(" http://localhost:5173/a ").as_deref(), Some("http://localhost:5173"));
        assert_eq!(origin_of("about:blank"), None);
        assert_eq!(origin_of(""), None);
    }

    #[test]
    fn um_act_que_cai_leva_o_progresso_no_erro() {
        crate::ipc::bridge::portal_act_progress("portal-teste-progresso".into(), "Ações já feitas (1):\n1. clicou @e3".into());
        let msg = act_error("portal-teste-progresso", "A interface parou".into());
        assert!(msg.contains("A interface parou") && msg.contains("1. clicou @e3"), "{msg}");
        // Já foi consumido: o próximo erro não repete.
        assert_eq!(act_error("portal-teste-progresso", "outro".into()), "outro");
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
    fn act_leva_o_objetivo_os_valores_e_o_limite_de_passos() {
        let req = request_for("act", &json!({ "goal": "entrar", "fill": ["email=a@b.c", "senha=x=y"], "steps": "5" })).unwrap();
        assert_eq!(req["op"], "act");
        assert_eq!(req["goal"], "entrar");
        assert_eq!(req["fills"], json!(["email=a@b.c", "senha=x=y"]));
        assert_eq!(req["steps"], 5.0);
        let one = request_for("act", &json!({ "goal": "x", "fill": "a=1" })).unwrap();
        assert_eq!(one["fills"], json!(["a=1"]));
        assert!(request_for("act", &json!({})).unwrap_err().contains("--goal"));
        assert!(request_for("act", &json!({ "goal": "x", "fill": ["sem-igual"] })).unwrap_err().contains("campo=valor"));

        let expects = request_for("act", &json!({ "goal": "x", "expect": ["text:Seu carrinho está vazio", "url:/cart"] })).unwrap();
        assert_eq!(expects["expects"], json!(["text:Seu carrinho está vazio", "url:/cart"]));
        assert_eq!(request_for("act", &json!({ "goal": "x", "expect": "count:1" })).unwrap()["expects"], json!(["count:1"]));
        assert_eq!(request_for("act", &json!({ "goal": "x" })).unwrap()["expects"], json!([]));
        assert!(request_for("act", &json!({ "goal": "x", "expect": ["sem-dois-pontos"] })).unwrap_err().contains("tipo:valor"));
    }

    #[test]
    fn so_o_proprio_computador_abre_no_canvas() {
        let local = |s: &str| is_local(&url::Url::parse(s).unwrap());
        for yes in ["http://localhost:5173", "http://127.0.0.1:3000/x", "http://[::1]:8080", "http://app.localhost:3000", "http://0.0.0.0:4000"] {
            assert!(local(yes), "{yes}");
        }
        for no in ["https://github.com/login/device", "http://192.168.0.5:3000", "https://localhost.evil.com"] {
            assert!(!local(no), "{no}");
        }
    }

    #[test]
    fn a_mesma_origem_reaproveita_o_navegador() {
        assert!(same_origin("http://localhost:5173/", "http://localhost:5173/login"));
        assert!(!same_origin("http://localhost:5173", "http://localhost:3000"));
        assert!(!same_origin("", "http://localhost:3000"));
    }

    #[test]
    fn un_numero_mal_escrito_se_rechaza_con_el_nombre_del_flag() {
        assert!(request_for("scroll", &json!({ "dy": "mucho" })).unwrap_err().contains("--dy"));
    }
}
