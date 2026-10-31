//! O simulador iOS solto no canvas (nó `ios`), para os agentes: as mesmas ações de `ags device` do Android, pelo
//! CoreSimulator (ver `crate::simulator`), mais `open` (uma URL no Safari do aparelho), `button` e `say` (falar
//! na conversa do simulador). E a conversa no sentido contrário: o que a pessoa escreve no painel do nó vai para
//! todos os agentes conectados a ele (`simulator_tell`).
//!
//! O permissão é a do canvas: um agente pilota o simulador ligado a ele (uma orquestradora, os da equipe).

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peer_queue;
use super::peers::open_tabs;
use crate::canvas::{self, Portal};
use crate::ipc::protocol::{arg_str, arg_str_opt};
use crate::peer_queue::store::NewMessage;
use crate::simulator::{model, ops};

/// O que o nó mostra na conversa: quem fez o quê. Um aparelho do painel do modo chat (`chat:…`) não tem nó
/// no canvas nem conversa própria: não se emite nada para ele (o painel mostra a tela ao vivo e o agente
/// responde no próprio terminal), em vez de mandar um evento para um nó que não existe.
fn activity(app: &AppHandle, node: &str, agent: &str, kind: &str, text: &str) {
    if node.starts_with(super::devices::CHAT_PREFIX) {
        return;
    }
    let _ = app.emit("simulator-activity", json!({ "node": node, "agent": agent, "kind": kind, "text": text, "at": crate::util::now_ts_ms() }));
}

fn agent_name(app: &AppHandle, tab: &str) -> String {
    open_tabs(app).ok().and_then(|tabs| tabs.into_iter().find(|t| t.id == tab).map(|t| t.name)).unwrap_or_else(|| tab.to_string())
}

fn udid_of(portal: &Portal) -> Result<String, String> {
    portal.udid.clone().filter(|u| !u.is_empty()).ok_or_else(|| "Esse simulador ainda não tem aparelho escolhido: a pessoa escolhe na barra dele.".into())
}

/// O tamanho da tela em pontos, como se vê (em paisagem, deitada: é o que o `shot` mostra), para `swipe --dir`
/// e para o agente saber as coordenadas.
fn screen_points(udid: &str) -> Result<(f64, f64), String> {
    let list = ops::devices()?;
    let device = model::pick(&list, udid)?;
    Ok(model::oriented_size((device.width, device.height), ops::orientation(udid)))
}

fn num(args: &Value, key: &str) -> Result<Option<f64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(Value::String(s)) => s.trim().parse::<f64>().map(Some).map_err(|_| format!("--{key} tem que ser um número, veio '{s}'")),
        Some(_) => Err(format!("--{key} inválido")),
    }
}

fn need(args: &Value, key: &str, action: &str) -> Result<f64, String> {
    num(args, key)?.ok_or_else(|| format!("`ags device {action}` precisa de --{key} (em pontos do iOS; veja o tamanho com `ags device shot`)."))
}

/// Uma ação de `ags device` num nó iOS.
pub(super) fn action(app: &AppHandle, from: &str, id: &str, portal: &Portal, args: &Value, action: &str, shots: std::path::PathBuf) -> Result<Value, String> {
    let who = json!({ "id": id, "name": portal.name, "kind": "ios", "udid": portal.udid });
    let agent = agent_name(app, from);
    if action == "say" {
        if id.starts_with(super::devices::CHAT_PREFIX) {
            return Err("`ags device say` é a conversa do nó do simulador no canvas; este aparelho está no painel do chat: responda pelo seu terminal.".into());
        }
        let text = arg_str(args, "text")?;
        activity(app, id, &agent, "message", text.trim());
        return Ok(json!({ "device": who, "said": true, "note": "A pessoa vê na conversa do simulador." }));
    }
    let udid = udid_of(portal)?;
    if action == "start" {
        ops::boot(&udid, true)?;
        crate::simulator::lifecycle::booted(app, &udid);
        activity(app, id, &agent, "action", "start");
        return Ok(json!({ "device": who, "started": true }));
    }
    crate::simulator::lifecycle::used(&udid);
    if !ops::booted(&udid)? {
        return Err(format!("O simulador '{}' está desligado. Ligue com `ags device start \"{}\"`.", portal.name, portal.name));
    }
    let result = match action {
        "tap" => {
            if arg_str_opt(args, "text").is_some_and(|t| !t.trim().is_empty()) {
                return Err("No iOS o `tap --text` ainda não existe: tire uma foto (`ags device shot`) e toque por --x/--y em pontos.".into());
            }
            let (x, y) = (need(args, "x", action)?, need(args, "y", action)?);
            ops::tap(&udid, x, y)?;
            json!({ "device": who, "tapped": [x, y] })
        }
        "swipe" => {
            let (from_pt, to_pt) = match arg_str_opt(args, "dir") {
                Some(dir) => {
                    let (w, h) = screen_points(&udid)?;
                    let (x1, y1, x2, y2) = super::devices::swipe_by_direction(&dir, w as u32, h as u32)?;
                    ((f64::from(x1), f64::from(y1)), (f64::from(x2), f64::from(y2)))
                }
                None => ((need(args, "x1", action)?, need(args, "y1", action)?), (need(args, "x2", action)?, need(args, "y2", action)?)),
            };
            let ms = num(args, "ms")?.unwrap_or(300.0).max(50.0) as u64;
            ops::swipe(&udid, from_pt, to_pt, ms)?;
            json!({ "device": who, "swiped": [from_pt.0, from_pt.1, to_pt.0, to_pt.1] })
        }
        "type" => {
            let text = arg_str(args, "text")?;
            ops::type_text(&udid, &text)?;
            json!({ "device": who, "typed": text.chars().count() })
        }
        "key" => {
            let key = arg_str(args, "key")?;
            ops::key(&udid, &key)?;
            json!({ "device": who, "key": key })
        }
        "button" => {
            let button = arg_str(args, "button")?;
            ops::button(&udid, &button)?;
            json!({ "device": who, "button": button })
        }
        "launch" => {
            let bundle = arg_str(args, "package")?;
            ops::launch(&udid, &bundle)?;
            json!({ "device": who, "launched": bundle })
        }
        "close" => {
            let bundle = arg_str(args, "package")?;
            ops::close(&udid, &bundle)?;
            json!({ "device": who, "closed": bundle })
        }
        "open" => {
            let url = arg_str(args, "url")?;
            ops::open_url(&udid, &url)?;
            json!({ "device": who, "opened": model::normalize_url(&url)? })
        }
        "shot" => {
            let tmp = ops::screenshot(&udid)?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
            let path = shots.join(format!("ios-{stamp}.png"));
            std::fs::rename(&tmp, &path).or_else(|_| std::fs::copy(&tmp, &path).map(|_| ())).map_err(|e| e.to_string())?;
            let (w, h) = screen_points(&udid).unwrap_or((0.0, 0.0));
            json!({ "device": who, "path": path.to_string_lossy(), "width": w, "height": h, "units": "pontos do iOS (use estes em --x/--y)" })
        }
        "tree" => return Err("No iOS o `tree` ainda não existe: use `ags device shot` e toque por --x/--y em pontos.".into()),
        other => return Err(format!("O simulador iOS não admite '{other}'.")),
    };
    let detail = match action {
        "type" => "type".to_string(),
        "shot" => "shot".to_string(),
        _ => format!("{action} {}", args.get("x").or(args.get("url")).or(args.get("key")).or(args.get("button")).or(args.get("package")).or(args.get("dir"))
            .map(|v| v.to_string()).unwrap_or_default()),
    };
    activity(app, id, &agent, "action", detail.trim());
    Ok(result)
}

/// Os agentes (abas) ligados ao nó `node` no canvas `key`.
fn agents_of(key: &str, node: &str) -> Vec<String> {
    let boards = canvas::load_boards();
    let Some(board) = boards.get(key) else { return Vec::new() };
    board
        .edges
        .iter()
        .filter_map(|e| if e.a == node { Some(e.b.clone()) } else if e.b == node { Some(e.a.clone()) } else { None })
        .filter(|other| !canvas::is_portal(other))
        .collect()
}

/// A pessoa escreveu na conversa do simulador: vai para cada agente conectado ao nó, pela fila de cada um
/// (entra quando o terminal estiver quieto). `shot` = a foto da tela anexada.
#[tauri::command(async)]
pub fn simulator_tell(app: AppHandle, key: String, node: String, name: String, text: String, shot: Option<String>) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("A mensagem está vazia.".into());
    }
    let tabs = open_tabs(&app)?;
    let targets: Vec<_> = agents_of(&key, &node).into_iter().filter_map(|id| tabs.iter().find(|t| t.id == id).cloned()).collect();
    if targets.is_empty() {
        return Err("Nenhum agente está conectado a este simulador. Ligue um terminal a ele com a corda.".into());
    }
    let attached = shot.as_deref().map(|p| format!("\nTela atual: {p}")).unwrap_or_default();
    let message = format!(
        "[Simulador \"{name}\" · conversa da pessoa com os agentes conectados]\n{text}{attached}\n\
         Pilote com `ags device tap|swipe|type|key|button|open|shot \"{name}\" …` (pontos do iOS) e responda na conversa com `ags device say \"{name}\" \"…\"`."
    );
    let mut sent = Vec::new();
    for tab in &targets {
        let new = NewMessage {
            client_id: None, kind: "notice", from_tab_id: &tab.id, from_name: "Simulador", to_tab_id: &tab.id,
            to_name: &tab.name, text: &message, raw: true, reply: false, ..Default::default()
        };
        match peer_queue::enqueue(&app, &new) {
            Ok(_) => sent.push(tab.name.clone()),
            Err(e) => eprintln!("[simulator] não entregou a {}: {e}", tab.name),
        }
    }
    activity(&app, &node, "", "user", text);
    Ok(json!({ "sent": sent }))
}

/// Resumo do piloto na mesma conversa que já mostra toque/teclado, sem objetivo nem valores.
pub(super) fn act_activity(app:&AppHandle,node:&str,from:&str,report:&crate::computer_use::Report){
    let agent=agent_name(app,from);
    activity(app,node,&agent,"action",&format!("act {:?}: {} tentativa(s). {}",report.status,report.actions.len(),report.reason));
}
