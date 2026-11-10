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
    if node.starts_with(crate::surfaces::CHAT_PREFIX) {
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
        if id.starts_with(crate::surfaces::CHAT_PREFIX) {
            return Err("`ags device say` é a conversa do nó do simulador no canvas; este aparelho está no painel do chat: responda pelo seu terminal.".into());
        }
        let text = arg_str(args, "text")?;
        activity(app, id, &agent, "message", text.trim());
        return Ok(json!({ "device": who, "said": true, "note": "A pessoa vê na conversa do simulador." }));
    }
    let udid = udid_of(portal)?;
    if crate::iphone::model::is_physical(&udid) {
        return physical(app, from, id, &who, &agent, &udid, args, action, shots);
    }
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
        "clipboard" => match arg_str_opt(args, "text") {
            Some(text) => {
                ops::set_clipboard_text(&udid, &text)?;
                json!({ "device": who, "copied": text.chars().count() })
            }
            None => json!({ "device": who, "clipboard": ops::clipboard_text(&udid)? }),
        },
        "rotate" => {
            let dir = arg_str_opt(args, "dir").unwrap_or_else(|| "left".to_string());
            let orientation = crate::simulator::rotate_device(app, &udid, &dir)?;
            json!({ "device": who, "orientation": orientation })
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
        "open" => "open URL".to_string(),
        _ => format!("{action} {}", args.get("x").or(args.get("url")).or(args.get("key")).or(args.get("button")).or(args.get("package")).or(args.get("dir"))
            .map(|v| v.to_string()).unwrap_or_default()),
    };
    activity(app, id, &agent, "action", detail.trim());
    Ok(result)
}

/// Uma ação de `ags device` num iPhone ou iPad físico (`device:<id>`). O alcance já foi conferido (corda no canvas, ou
/// a chave do painel do chat); por ser o aparelho de verdade, ações que mudam o estado perguntam à pessoa até ela
/// dizer "sempre neste aparelho", e digitar texto pergunta sempre (`computer_use::ios::confirm_physical`).
#[allow(clippy::too_many_arguments)]
fn physical(app: &AppHandle, from: &str, id: &str, who: &Value, agent: &str, device: &str, args: &Value, action: &str, shots: std::path::PathBuf) -> Result<Value, String> {
    use crate::iphone::{model as phone, ops as po};
    #[cfg(target_os = "macos")]
    if crate::iphone::commands::mac::is_disconnected(device) {
        return Err("A sessão deste iPhone foi desconectada no painel da ADE. Reconecte o aparelho antes de pedir outra ação.".into());
    }
    if phone::agent_unsupported(action) {
        return Err(format!("No iPhone físico `ags device {action}` ainda não existe: use apps, launch, close, open, tap, swipe, type, key, button e shot."));
    }
    if action == "apps" {
        let apps = po::apps(device)?;
        activity(app, id, agent, "action", "apps");
        return Ok(json!({ "device": who, "apps": apps }));
    }
    let db = super::shared::db(app)?.inner().clone();
    // Pergunta à pessoa, com a foto da tela e o ponto (em proporção) quando há um.
    let ask = |what: &str, point: Option<(f64, f64)>| -> Result<(), String> {
        let photo = po::screenshot(app, device).ok();
        let ok = crate::computer_use::ios::confirm_physical(app, &db, from, device, action, what, photo.as_deref().map(std::path::Path::new), point)?;
        if let Some(p) = photo {
            let _ = std::fs::remove_file(p);
        }
        if ok { Ok(()) } else { Err("A pessoa não autorizou esta ação no iPhone físico.".into()) }
    };
    let asks = |trusted: bool| phone::agent_asks(action, trusted);
    let trusted = crate::computer_use::ios::trusted_device(&db, device)?;
    let result = match action {
        "tap" => {
            if arg_str_opt(args, "text").is_some_and(|t| !t.trim().is_empty()) {
                return Err("No iPhone físico o `tap --text` ainda não existe: tire uma foto (`ags device shot`) e toque por --x/--y em pontos.".into());
            }
            let (x, y) = (need(args, "x", action)?, need(args, "y", action)?);
            let ratio = phone::point_ratio(x, y, po::points(app, device)?)?;
            if asks(trusted) {
                ask(&format!("Tocar em ({x:.0}, {y:.0}) pontos"), Some(ratio))?;
            }
            po::tap(app, device, x, y)?;
            json!({ "device": who, "tapped": [x, y] })
        }
        "swipe" => {
            let size = po::points(app, device)?;
            let (from_pt, to_pt) = match arg_str_opt(args, "dir") {
                Some(dir) => {
                    let (x1, y1, x2, y2) = super::devices::swipe_by_direction(&dir, size.0 as u32, size.1 as u32)?;
                    ((f64::from(x1), f64::from(y1)), (f64::from(x2), f64::from(y2)))
                }
                None => ((need(args, "x1", action)?, need(args, "y1", action)?), (need(args, "x2", action)?, need(args, "y2", action)?)),
            };
            let ms = num(args, "ms")?.unwrap_or(300.0).max(50.0) as u64;
            if asks(trusted) {
                let start = phone::point_ratio(from_pt.0, from_pt.1, size)?;
                ask(&format!("Deslizar de ({:.0}, {:.0}) a ({:.0}, {:.0}) pontos", from_pt.0, from_pt.1, to_pt.0, to_pt.1), Some(start))?;
            }
            po::swipe(app, device, from_pt, to_pt, ms)?;
            json!({ "device": who, "swiped": [from_pt.0, from_pt.1, to_pt.0, to_pt.1] })
        }
        "type" => {
            let text = arg_str(args, "text")?;
            phone::text_lines(&text)?;
            ask(&format!("Digitar {} caracteres no campo que estiver em foco", text.chars().count()), None)?;
            po::type_text(app, device, &text)?;
            json!({ "device": who, "typed": text.chars().count() })
        }
        "launch" => {
            let bundle = arg_str(args, "package")?;
            if asks(trusted) {
                ask(&format!("Abrir o app {bundle}"), None)?;
            }
            po::launch(device, &bundle)?;
            json!({ "device": who, "launched": bundle })
        }
        "close" => {
            let bundle = arg_str(args, "package")?;
            if asks(trusted) {
                ask(&format!("Fechar o app {bundle}"), None)?;
            }
            let processes = po::close(device, &bundle)?;
            json!({ "device": who, "closed": bundle, "terminatedProcesses": processes })
        }
        "open" => {
            let raw_url = arg_str(args, "url")?;
            let url = if raw_url.contains("://") || ["mailto:", "tel:", "sms:", "facetime:"].iter().any(|scheme| raw_url.starts_with(scheme)) {
                raw_url
            } else {
                crate::simulator::model::normalize_url(&raw_url)?
            };
            if asks(trusted) {
                let destination = url::Url::parse(&url).ok().and_then(|parsed| parsed.host_str().map(str::to_string));
                ask(&destination.map(|host| format!("Abrir uma URL no domínio {host}")).unwrap_or_else(|| "Abrir uma URL no iPhone".into()), None)?;
            }
            po::open_url(device, &url)?;
            json!({ "device": who, "opened": true })
        }
        "key" => {
            let key = arg_str(args, "key")?;
            phone::key_lines(&key)?;
            if asks(trusted) {
                ask(&format!("Apertar a tecla «{key}»"), None)?;
            }
            po::key(app, device, &key)?;
            json!({ "device": who, "key": key })
        }
        "button" => {
            let button = arg_str(args, "button")?;
            let gesture = phone::gesture(&button).is_some() && phone::button_usage(&button).is_none();
            if !gesture && phone::button_usage(&button).is_none() {
                return Err(format!("Botão desconhecido: \"{button}\". Use home, lock, volumeUp, volumeDown, mute, siri, controlCenter, notificationCenter ou spotlight."));
            }
            if asks(trusted) {
                ask(&format!("Apertar «{button}»"), None)?;
            }
            if gesture { po::gesture(app, device, &button)? } else { po::button(app, device, &button)? }
            json!({ "device": who, "button": button })
        }
        "shot" => {
            let tmp = po::screenshot(app, device)?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
            let path = shots.join(format!("iphone-{stamp}.png"));
            std::fs::rename(&tmp, &path).or_else(|_| std::fs::copy(&tmp, &path).map(|_| ())).map_err(|e| e.to_string())?;
            let (w, h) = po::points(app, device).unwrap_or((0.0, 0.0));
            json!({ "device": who, "path": path.to_string_lossy(), "width": w, "height": h, "units": "pontos do iOS (use estes em --x/--y)" })
        }
        other => return Err(format!("O iPhone físico não admite '{other}'.")),
    };
    let detail = match action {
        "type" | "shot" => action.to_string(),
        _ => format!("{action} {}", args.get("x").or(args.get("key")).or(args.get("button")).or(args.get("dir")).map(|v| v.to_string()).unwrap_or_default()),
    };
    activity(app, id, agent, "action", detail.trim());
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
