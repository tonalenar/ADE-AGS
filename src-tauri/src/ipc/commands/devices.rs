//! Dispositivos Android del canvas, para los agentes: `ags device list|create|start|tap|swipe|type|key|launch|close|shot|tree`.
//!
//! Un dispositivo es un portal del canvas de tipo `android` (ver `crate::canvas::Portal`): su
//! nodo muestra la pantalla de un emulador o un teléfono, y los agentes conectados con él lo
//! manejan por acá. Las conexiones y los permisos son los mismos que los de los portales
//! (`crate::canvas::portals_for`): un agente maneja los dispositivos conectados con él; una
//! orquestadora, también los de su equipo.
//!
//! Todo va por `adb` (ver `crate::android`). El permiso se decide acá; lo que se ve en el
//! nodo lo dibuja el frontend.
//!
//! Além do canvas, o painel direito do modo chat mostra aparelhos fora dele e os compartilha com os agentes
//! (`devices_share`): qualquer aba os alcança, com id `chat:<udid|serial>`. Sem a chave "Permitir que agentes
//! controlem dispositivos" da pessoa, o agente só vê (`shot` e `tree`).

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::{caller, open_tabs};
use crate::android::{self, Device};
use crate::canvas::{self, Portal};
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt};

/// `open`, `button` e `say` só existem no simulador iOS (ver `simulators`).
pub(crate) const ACTIONS: &[&str] = &["tap", "swipe", "type", "key", "launch", "close", "shot", "tree", "start", "open", "button", "say"];

/// Cuánto se espera a que un emulador recién arrancado termine de iniciar.
const BOOT_WAIT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
struct Reachable {
    id: String,
    portal: Portal,
    /// `Some(control)` = veio do painel do chat (com a chave da pessoa); `None` = portal do canvas.
    chat: Option<bool>,
}

// ── Aparelhos compartilhados pelo painel do modo chat ──

/// O prefixo do id de um aparelho do painel do chat (não há nó do canvas com ele).
pub(crate) const CHAT_PREFIX: &str = "chat:";

/// Um aparelho aberto no painel direito do modo chat, como o frontend manda.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedDevice {
    /// `ios` ou `android`.
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub udid: Option<String>,
    #[serde(default)]
    pub serial: Option<String>,
}

#[derive(Debug, Default)]
struct ChatShare {
    devices: Vec<SharedDevice>,
    control: bool,
}

/// Só em memória: o painel manda de novo a cada mudança, e com o app fechado não há o que compartilhar.
fn chat_share() -> &'static Mutex<ChatShare> {
    static S: OnceLock<Mutex<ChatShare>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Confere a lista do painel: tipo conhecido, nome, e o UDID (iOS) ou o serial (Android).
fn check_shared(devices: &[SharedDevice]) -> Result<(), String> {
    for d in devices {
        let key = match d.kind.as_str() {
            "ios" => d.udid.as_deref(),
            "android" => d.serial.as_deref(),
            other => return Err(format!("Tipo de aparelho desconhecido: \"{other}\" (ios ou android).")),
        };
        if key.is_none_or(|k| k.trim().is_empty()) {
            return Err(format!("O aparelho \"{}\" veio sem {}.", d.name, if d.kind == "ios" { "udid" } else { "serial" }));
        }
    }
    Ok(())
}

/// O painel do chat abriu/fechou um aparelho ou a pessoa mudou a chave: substitui o que estava compartilhado.
#[tauri::command]
pub fn devices_share(devices: Vec<SharedDevice>, control: bool) -> Result<(), String> {
    check_shared(&devices)?;
    let mut share = chat_share().lock().map_err(|_| "O compartilhamento de aparelhos travou.".to_string())?;
    *share = ChatShare { devices, control };
    Ok(())
}

/// Os aparelhos do painel como dispositivos alcançáveis. Um que já é portal do canvas ligado ao agente fica
/// de fora: pelo canvas ele já o controla, e o mesmo nome duas vezes só confundiria a resolução.
fn chat_reachable(devices: &[SharedDevice], control: bool, canvas: &[Reachable]) -> Vec<Reachable> {
    devices
        .iter()
        .filter_map(|d| {
            let key = if d.kind == "ios" { d.udid.clone()? } else { d.serial.clone()? };
            let on_canvas = canvas.iter().any(|c| c.portal.kind.as_deref() == Some(d.kind.as_str())
                && (if d.kind == "ios" { c.portal.udid.as_deref() } else { c.portal.serial.as_deref() }) == Some(key.as_str()));
            (!on_canvas).then(|| Reachable {
                id: format!("{CHAT_PREFIX}{key}"),
                portal: Portal {
                    name: d.name.clone(),
                    kind: Some(d.kind.clone()),
                    udid: d.udid.clone().filter(|_| d.kind == "ios"),
                    serial: d.serial.clone().filter(|_| d.kind == "android"),
                    ..Default::default()
                },
                chat: Some(control),
            })
        })
        .collect()
}

/// Sem a chave do painel, um aparelho do chat só deixa olhar.
fn chat_allows(action: &str, control: bool) -> Result<(), String> {
    if control || matches!(action, "shot" | "tree") {
        return Ok(());
    }
    Err(format!(
        "A pessoa não liberou o controle deste aparelho no painel do chat (a chave \"Permitir que agentes controlem dispositivos\" está desligada): `{action}` não é permitido. Você pode olhar com `ags device shot` e `ags device tree`."
    ))
}

fn reachable(from: &str) -> Vec<Reachable> {
    let boards = canvas::load_boards();
    let mut list: Vec<Reachable> = canvas::portals_for(&boards, from)
        .into_iter()
        .filter_map(|(key, id)| {
            let portal = boards.get(&key)?.portals.get(&id)?.clone();
            matches!(portal.kind.as_deref(), Some("android") | Some("ios")).then_some(Reachable { id, portal, chat: None })
        })
        .collect();
    if let Ok(share) = chat_share().lock() {
        let extra = chat_reachable(&share.devices, share.control, &list);
        list.extend(extra);
    }
    list
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
    if let Some(control) = d.chat {
        out["source"] = json!("chat");
        out["control"] = json!(control);
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
    let mine = reachable(&from);
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
    let mine = reachable(&from);
    let target = resolve(&mine, &arg_str(args, "name")?)?;
    if let Some(control) = target.chat {
        chat_allows(action, control)?;
    }

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

    fn dev(id: &str, name: &str) -> Reachable {
        Reachable { id: id.into(), portal: Portal { name: name.into(), kind: Some("android".into()), ..Default::default() }, chat: None }
    }

    fn shared(kind: &str, name: &str, key: &str) -> SharedDevice {
        let ios = kind == "ios";
        SharedDevice { kind: kind.into(), name: name.into(), udid: ios.then(|| key.into()), serial: (!ios).then(|| key.into()) }
    }

    #[test]
    fn um_aparelho_do_painel_do_chat_resolve_por_id_e_por_nome() {
        let list = chat_reachable(&[shared("ios", "iPhone 17", "AAA-1"), shared("android", "Pixel 9", "emulator-5554")], false, &[]);
        let ios = resolve(&list, "chat:AAA-1").unwrap();
        assert_eq!((ios.portal.kind.as_deref(), ios.portal.udid.as_deref(), ios.chat), (Some("ios"), Some("AAA-1"), Some(false)));
        let android = resolve(&list, "pixel 9").unwrap();
        assert_eq!((android.id.as_str(), android.portal.serial.as_deref()), ("chat:emulator-5554", Some("emulator-5554")));
        assert_eq!(android.portal.udid, None);
        let shown = describe(android);
        assert_eq!((shown["source"].as_str(), shown["control"].as_bool()), (Some("chat"), Some(false)));
        assert!(describe(&dev("portal-1", "x")).get("source").is_none(), "o do canvas não diz source");
    }

    #[test]
    fn o_que_ja_e_portal_do_canvas_nao_aparece_de_novo_pelo_chat() {
        let mut canvas = dev("portal-1", "Pixel");
        canvas.portal.serial = Some("emulator-5554".into());
        let list = chat_reachable(&[shared("android", "Pixel", "emulator-5554"), shared("android", "Outro", "R58")], true, &[canvas]);
        assert_eq!(list.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["chat:R58"]);
    }

    #[test]
    fn sem_a_chave_da_pessoa_o_agente_so_ve() {
        assert!(chat_allows("shot", false).is_ok());
        assert!(chat_allows("tree", false).is_ok());
        for action in ["tap", "swipe", "type", "key", "launch", "close", "start", "open", "button", "say"] {
            let err = chat_allows(action, false).unwrap_err();
            assert!(err.contains("painel do chat") && err.contains("shot"), "{action}: {err}");
            assert!(chat_allows(action, true).is_ok(), "{action} com controle");
        }
    }

    #[test]
    fn o_painel_so_compartilha_aparelho_com_identificador() {
        assert!(check_shared(&[shared("ios", "iPhone", "AAA")]).is_ok());
        assert!(check_shared(&[SharedDevice { kind: "ios".into(), name: "iPhone".into(), udid: None, serial: Some("x".into()) }]).is_err());
        assert!(check_shared(&[shared("android", "Pixel", " ")]).is_err());
        assert!(check_shared(&[shared("watch", "Relógio", "x")]).is_err());
        let parsed: Vec<SharedDevice> = serde_json::from_value(json!([{ "kind": "android", "name": "Pixel", "serial": "emulator-5554" }])).unwrap();
        assert_eq!(parsed[0], shared("android", "Pixel", "emulator-5554"));
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

/// Resolve só nós iOS alcançáveis pelo chamador; não aceita UDID solto como autorização.
pub(super) fn ios_target(from: &str, name: &str) -> Result<(String, String), String> {
    let list = reachable(from);
    let target = resolve(&list, name)?;
    if target.portal.kind.as_deref() != Some("ios") { return Err("Use sim act somente em um nó iOS conectado ao seu terminal.".into()); }
    let udid = target.portal.udid.clone().filter(|u| !u.is_empty()).ok_or("Escolha o aparelho no nó iOS antes de iniciar.")?;
    Ok((target.id.clone(), udid))
}
