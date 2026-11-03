//! Dispositivos Android del canvas, para los agentes: `ags device list|create|start|tap|swipe|type|key|launch|close|shot|tree`.
//!
//! Un dispositivo es un portal del canvas de tipo `android` (ver `crate::canvas::Portal`): su
//! nodo muestra la pantalla de un emulador o un teléfono, y los agentes conectados con él lo
//! manejan por acá. Las conexiones y los permisos son los mismos que los de los portales
//! (`crate::surfaces::reach`, a mesma função da autorização do `sim act`): un agente maneja los dispositivos conectados con él; una
//! orquestadora, también los de su equipo.
//!
//! Todo va por `adb` (ver `crate::android`). El permiso se decide acá; lo que se ve en el
//! nodo lo dibuja el frontend.
//!
//! Além do canvas, o painel direito do modo chat mostra aparelhos fora dele e os compartilha com os agentes
//! (`devices_share`): qualquer aba os alcança, com id `chat:<udid|serial>`. Sem a chave "Permitir que agentes
//! controlem dispositivos" da pessoa, o agente só vê (`shot` e `tree`).

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::{caller, open_tabs};
use crate::android::{self, Device};
use crate::surfaces::{self, Reach as Reachable, SharedDevice, Source};
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt};

/// `open`, `button` e `say` só existem no simulador iOS (ver `simulators`).
pub(crate) const ACTIONS: &[&str] = &["tap", "swipe", "type", "key", "launch", "close", "shot", "tree", "start", "open", "button", "say"];

/// Cuánto se espera a que un emulador recién arrancado termine de iniciar.
const BOOT_WAIT: Duration = Duration::from_secs(120);

/// O painel do chat abriu/fechou um aparelho ou a pessoa mudou a chave: substitui o que estava compartilhado.
#[tauri::command]
pub fn devices_share(devices: Vec<SharedDevice>, control: bool) -> Result<(), String> {
    surfaces::share(devices, control)
}

/// Resuelve un dispositivo por id o nombre (sin mayúsculas), entre los que el agente alcanza.
fn resolve<'a>(list: &'a [Reachable], wanted: &str) -> Result<&'a Reachable, String> {
    if let Some(d) = list.iter().find(|d| d.id == wanted) {
        return Ok(d);
    }
    let needle = wanted.trim().to_lowercase();
    let matches: Vec<&Reachable> = list.iter().filter(|d| d.portal.name.to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] if list.is_empty() => Err(format!(
            "'{wanted}' não está conectado com você. Você não tem nenhum dispositivo Android: crie um com `ags device create` ou peça ao usuário para ligar um ao seu terminal."
        )),
        [] => Err(format!(
            "'{wanted}' não está conectado com você. Dispositivos conectados: {}",
            list.iter().map(|d| d.portal.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "Há {} dispositivos chamados '{wanted}'. Use o id: {}",
            many.len(),
            many.iter().map(|d| d.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn describe(d: &Reachable) -> Value {
    let mut out = if d.portal.kind.as_deref() == Some("ios") {
        json!({ "id": d.id, "name": d.portal.name, "kind": "ios", "udid": d.portal.udid })
    } else {
        json!({ "id": d.id, "name": d.portal.name, "kind": "android", "serial": d.portal.serial, "avd": d.portal.avd })
    };
    // De onde vem: o painel do chat diz se a pessoa liberou o controle (sem ela, só shot/tree).
    if d.source == Source::ChatPanel {
        out["source"] = json!("chat");
        out["control"] = json!(d.control);
    }
    out
}

/// Un número que puede llegar como número (flag) o como texto.
pub(crate) fn int(args: &Value, key: &str) -> Result<Option<u32>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().map(|n| Some(n as u32)).ok_or_else(|| format!("--{key} inválido")),
        Some(Value::String(s)) => s.trim().parse::<u32>().map(Some).map_err(|_| format!("--{key} tem que ser um número inteiro, veio '{s}'")),
        Some(_) => Err(format!("--{key} inválido")),
    }
}

fn need_int(args: &Value, key: &str, action: &str) -> Result<u32, String> {
    int(args, key)?.ok_or_else(|| format!("`ags device {action}` precisa de --{key}."))
}

/// Un deslizamiento por dirección: de un lado al otro de la pantalla, por el centro. `up`
/// es lo que hace el dedo (sube), que baja la lista.
pub(crate) fn swipe_by_direction(dir: &str, w: u32, h: u32) -> Result<(u32, u32, u32, u32), String> {
    let (cx, cy) = (w / 2, h / 2);
    let (dx, dy) = (w / 3, h / 3);
    match dir.trim().to_lowercase().as_str() {
        "up" => Ok((cx, cy + dy, cx, cy - dy)),
        "down" => Ok((cx, cy - dy, cx, cy + dy)),
        "left" => Ok((cx + dx, cy, cx - dx, cy)),
        "right" => Ok((cx - dx, cy, cx + dx, cy)),
        other => Err(format!("--dir tem que ser up, down, left ou right, veio '{other}'.")),
    }
}

/// Dónde se guardan las capturas que se le piden a un dispositivo.
fn shots_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?.join("screens");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Conserva solo las últimas capturas: se piden seguido y cada una pesa cientos de KB.
fn prune_shots(dir: &std::path::Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = read.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "png")).collect();
    files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let excess = files.len().saturating_sub(keep);
    for f in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(f.path());
    }
}

fn file_stem(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    s.trim_matches('-').to_string()
}

pub(super) fn device_list(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let mine = surfaces::devices(&from);
    let online: Vec<Device> = android::devices().unwrap_or_default();
    Ok(json!({
        "devices": mine.iter().map(describe).collect::<Vec<_>>(),
        // Lo que `adb` ve ahora (el de cada nodo se elige en el canvas) y los emuladores que se pueden arrancar.
        "online": online,
        "avds": android::avds(),
        // Os iPhones e iPads do Xcode (só no macOS), para `ags device create --ios <nome>`.
        "ios": crate::simulator::ops::devices().unwrap_or_default(),
    }))
}

/// Crea un dispositivo al lado de quien lo pide y conectado con él.
pub(super) fn device_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())?;
    // `--ios [aparelho]`: o simulador iOS (sem valor = o primeiro iPhone do Xcode).
    let ios = args.get("ios").filter(|v| !v.is_null() && *v != &json!(false));
    let mut req = json!({ "op": "create", "cwd": me.cwd, "near": me.id, "kind": if ios.is_some() { "ios" } else { "android" } });
    if let Some(wanted) = ios {
        let list = crate::simulator::ops::devices()?;
        let device = match wanted.as_str().filter(|w| !w.trim().is_empty() && *w != "true") {
            Some(w) => crate::simulator::model::pick(&list, w.trim())?,
            None => list.first().ok_or("O Xcode não tem nenhum iPhone ou iPad instalado.")?,
        };
        req["udid"] = json!(device.udid);
    }
    if let Some(name) = arg_str_opt(args, "name").filter(|n| !n.trim().is_empty()) {
        req["name"] = json!(name.trim());
    }
    if let Some(avd) = arg_str_opt(args, "avd").filter(|n| !n.trim().is_empty()) {
        req["avd"] = json!(avd.trim());
    }
    let raw = ask_frontend_within(app, "canvas.portal", &req, Some(&me.window), Duration::from_secs(30))?;
    Ok(json!({ "created": unwrap_frontend_result(raw)? }))
}

pub(super) fn device_action(_app: &AppHandle, args: &Value, action: &str) -> Result<Value, String> {
    if !ACTIONS.contains(&action) {
        return Err(format!("Um dispositivo não admite '{action}'. Admite: {}.", ACTIONS.join(", ")));
    }
    let from = caller(args)?;
    let mine = surfaces::devices(&from);
    let target = resolve(&mine, &arg_str(args, "name")?)?;
    target.allows(action)?;

    if target.portal.kind.as_deref() == Some("ios") {
        return super::simulators::action(_app, &from, &target.id, &target.portal, args, action, shots_dir()?);
    }
    if matches!(action, "open" | "button" | "say") {
        return Err(format!("`ags device {action}` é só do simulador iOS; no Android use `key`/`launch`."));
    }
    if action == "start" {
        return start(target, args);
    }
    let serial = android::pick_serial(target.portal.serial.as_deref(), &android::devices()?)?;
    let who = describe(target);

    match action {
        "tap" => {
            if let Some(text) = arg_str_opt(args, "text").filter(|t| !t.trim().is_empty()) {
                let nodes = android::tree(&serial)?;
                let node = android::find_node(&nodes, &text)
                    .ok_or_else(|| format!("Não achei '{text}' na tela. Veja os elementos com `ags device tree`."))?;
                let (x, y) = node.center();
                android::tap(&serial, x.max(0) as u32, y.max(0) as u32)?;
                return Ok(json!({ "device": who, "tapped": node.label(), "at": [x, y] }));
            }
            let (x, y) = (need_int(args, "x", action)?, need_int(args, "y", action)?);
            android::tap(&serial, x, y)?;
            Ok(json!({ "device": who, "tapped": [x, y] }))
        }
        "swipe" => {
            let (x1, y1, x2, y2) = match arg_str_opt(args, "dir") {
                Some(dir) => {
                    let (w, h) = android::size(&serial)?;
                    swipe_by_direction(&dir, w, h)?
                }
                None => (need_int(args, "x1", action)?, need_int(args, "y1", action)?, need_int(args, "x2", action)?, need_int(args, "y2", action)?),
            };
            android::swipe(&serial, x1, y1, x2, y2, int(args, "ms")?.unwrap_or(300))?;
            Ok(json!({ "device": who, "swiped": [x1, y1, x2, y2] }))
        }
        "type" => {
            let text = arg_str(args, "text")?;
            android::type_text(&serial, &text)?;
            Ok(json!({ "device": who, "typed": text.chars().count() }))
        }
        "key" => {
            let key = arg_str(args, "key")?;
            android::key(&serial, &key)?;
            Ok(json!({ "device": who, "key": key }))
        }
        "launch" => {
            let package = arg_str(args, "package")?;
            android::launch(&serial, &package)?;
            Ok(json!({ "device": who, "launched": package }))
        }
        "close" => {
            let package = arg_str(args, "package")?;
            android::close(&serial, &package)?;
            Ok(json!({ "device": who, "closed": package }))
        }
        "shot" => {
            let png = android::screenshot(&serial)?;
            let dir = shots_dir()?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
            let path = dir.join(format!("{}-{stamp}.png", file_stem(&target.portal.name)));
            std::fs::write(&path, &png).map_err(|e| e.to_string())?;
            prune_shots(&dir, 30);
            let (w, h) = android::size(&serial).unwrap_or((0, 0));
            Ok(json!({ "device": who, "path": path.to_string_lossy(), "width": w, "height": h }))
        }
        "tree" => {
            let nodes = android::tree(&serial)?;
            Ok(json!({ "device": who, "elements": nodes.len(), "text": android::render_tree(&nodes) }))
        }
        _ => unreachable!(),
    }
}

/// Arranca el emulador del nodo (su `avd`, o el `--avd` pedido) y espera a que termine de iniciar.
fn start(target: &Reachable, args: &Value) -> Result<Value, String> {
    let avd = arg_str_opt(args, "avd")
        .filter(|a| !a.trim().is_empty())
        .or_else(|| target.portal.avd.clone())
        .ok_or("Esse dispositivo não tem um emulador escolhido: use `--avd <nome>` (veja `ags devices`).")?;
    let before: Vec<String> = android::devices()?.into_iter().filter(|d| d.state == "device").map(|d| d.serial).collect();
    android::start_avd(&avd)?;

    let deadline = Instant::now() + BOOT_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        if let Some(fresh) = android::devices()?.into_iter().find(|d| d.state == "device" && !before.contains(&d.serial)) {
            if android::boot_completed(&fresh.serial) {
                return Ok(json!({ "device": describe(target), "started": avd, "serial": fresh.serial }));
            }
        }
    }
    Ok(json!({
        "device": describe(target),
        "started": avd,
        "ready": false,
        "note": "O emulador foi iniciado mas ainda não terminou de ligar; tente `ags devices` de novo em instantes."
    }))
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::canvas::Portal;

    fn dev(id: &str, name: &str) -> Reachable {
        Reachable { board: Some("b".into()), id: id.into(), portal: Portal { name: name.into(), kind: Some("android".into()), ..Default::default() }, source: Source::Canvas, control: true }
    }

    #[test]
    fn resuelve_por_nombre_sin_mayusculas_y_por_id() {
        let list = vec![dev("portal-1", "Pixel 8"), dev("portal-2", "Pixel 6a")];
        assert_eq!(resolve(&list, "pixel 8").unwrap().id, "portal-1");
        assert_eq!(resolve(&list, "portal-2").unwrap().id, "portal-2");
    }

    #[test]
    fn uno_que_no_esta_conectado_lista_los_que_si_y_sin_ninguno_explica_como_crear() {
        let err = resolve(&[dev("portal-1", "Pixel 8")], "Otro").unwrap_err();
        assert!(err.contains("Pixel 8"), "{err}");
        assert!(resolve(&[], "x").unwrap_err().contains("ags device create"));
    }

    #[test]
    fn dos_con_el_mismo_nombre_piden_el_id() {
        let list = vec![dev("portal-1", "Pixel"), dev("portal-2", "pixel")];
        let err = resolve(&list, "PIXEL").unwrap_err();
        assert!(err.contains("portal-1") && err.contains("portal-2"), "{err}");
    }

    #[test]
    fn los_numeros_llegan_como_numero_o_texto() {
        assert_eq!(int(&json!({ "x": 10 }), "x").unwrap(), Some(10));
        assert_eq!(int(&json!({ "x": "10" }), "x").unwrap(), Some(10));
        assert_eq!(int(&json!({}), "x").unwrap(), None);
        assert!(int(&json!({ "x": "a" }), "x").is_err());
        assert!(int(&json!({ "x": -3 }), "x").is_err());
        assert!(need_int(&json!({}), "y", "tap").unwrap_err().contains("--y"));
    }

    #[test]
    fn deslizar_por_direccion_cruza_el_centro_y_up_sube_el_dedo() {
        let (x1, y1, x2, y2) = swipe_by_direction("up", 1000, 2000).unwrap();
        assert_eq!((x1, x2), (500, 500));
        assert!(y1 > y2, "el dedo sube: empieza abajo");
        let (x1, _, x2, _) = swipe_by_direction("left", 1000, 2000).unwrap();
        assert!(x1 > x2);
        assert!(swipe_by_direction("diagonal", 1, 1).is_err());
    }

    #[test]
    fn el_nombre_de_archivo_de_la_captura_es_seguro() {
        assert_eq!(file_stem("Pixel 8 / test"), "Pixel-8---test");
        assert_eq!(file_stem("../x"), "x");
    }
}

/// Resolve só nós iOS alcançáveis pelo chamador; não aceita UDID solto como autorização. O `sim act` muda o
/// aparelho a cada passo: um aparelho do painel do chat sem a chave ligada é recusado já aqui, com o motivo.
pub(super) fn ios_target(from: &str, name: &str) -> Result<(String, String), String> {
    let list = surfaces::devices(from);
    let target = resolve(&list, name)?;
    if target.kind() != Some("ios") { return Err("Use sim act somente em um nó iOS conectado ao seu terminal.".into()); }
    target.allows("act")?;
    let udid = target.portal.udid.clone().filter(|u| !u.is_empty()).ok_or("Escolha o aparelho no nó iOS antes de iniciar.")?;
    Ok((target.id.clone(), udid))
}
