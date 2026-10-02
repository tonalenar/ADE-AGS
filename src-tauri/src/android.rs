//! Android para el canvas: un emulador (o un teléfono por USB) que se ve y se maneja desde un
//! nodo del canvas, y que los agentes conectados manejan con `ccode device …`.
//!
//! Todo va por `adb` (y `emulator` para arrancar un AVD): no hay dependencias nuevas. Este
//! módulo es solo la capa de `adb`: encontrarlo, listar dispositivos, tocar, escribir y leer la
//! pantalla. Es lo que usan la pantalla (comandos de Tauri, abajo) y la CLI
//! (`ipc::commands::devices`).
//!
//! Las partes que leen la salida de `adb` son funciones puras para probarlas sin dispositivo.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use crate::util::output_with_timeout;

const FAST: Duration = Duration::from_secs(8);
const SLOW: Duration = Duration::from_secs(25);

// ── Encontrar las herramientas ──────────────────────────────────────

fn sdk_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(v) = std::env::var_os(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Android").join("Sdk"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Android").join("Sdk"));
        roots.push(home.join("Library").join("Android").join("sdk"));
    }
    roots
}

fn find_tool(name: &str, sub: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    for root in sdk_roots() {
        let candidate = root.join(sub).join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // En el PATH.
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(&exe)).find(|p| p.is_file())
}

fn adb_path() -> Result<&'static PathBuf, String> {
    static ADB: OnceLock<Option<PathBuf>> = OnceLock::new();
    ADB.get_or_init(|| find_tool("adb", "platform-tools"))
        .as_ref()
        .ok_or_else(|| "Não encontrei o `adb`. Instale o Android SDK (platform-tools) ou defina ANDROID_HOME.".to_string())
}

fn emulator_path() -> Result<PathBuf, String> {
    find_tool("emulator", "emulator").ok_or_else(|| "Não encontrei o `emulator` do Android SDK.".to_string())
}

/// Corre `adb [-s serial] args…` y devuelve su salida cruda (binaria: sirve para `screencap`).
fn adb(serial: Option<&str>, args: &[&str], limit: Duration) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(adb_path()?);
    if let Some(s) = serial {
        cmd.args(["-s", s]);
    }
    cmd.args(args);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| format!("adb: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout).to_string() } else { err.to_string() };
        return Err(format!("adb {}: {}", args.first().copied().unwrap_or(""), msg.trim()));
    }
    Ok(out.stdout)
}

fn adb_text(serial: Option<&str>, args: &[&str], limit: Duration) -> Result<String, String> {
    adb(serial, args, limit).map(|b| String::from_utf8_lossy(&b).to_string())
}

// ── Dispositivos ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Device {
    pub serial: String,
    /// `device` = listo; `offline`, `unauthorized`… = todavía no.
    pub state: String,
    pub model: String,
}

/// `adb devices -l` → los dispositivos.
pub fn parse_devices(out: &str) -> Vec<Device> {
    out.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = parts
                .find_map(|p| p.strip_prefix("model:"))
                .map(|m| m.replace('_', " "))
                .unwrap_or_default();
            Some(Device { serial, state, model })
        })
        .collect()
}

pub fn devices() -> Result<Vec<Device>, String> {
    Ok(parse_devices(&adb_text(None, &["devices", "-l"], FAST)?))
}

/// Los AVD (emuladores) creados en esta máquina.
pub fn avds() -> Vec<String> {
    let Ok(emulator) = emulator_path() else { return Vec::new() };
    let mut cmd = Command::new(emulator);
    cmd.arg("-list-avds");
    output_with_timeout(&mut cmd, FAST)
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("INFO")).map(String::from).collect())
        .unwrap_or_default()
}

/// Arranca un AVD y no espera: el emulador tarda en aparecer en `adb devices` y la pantalla
/// lo va a ver cuando esté.
pub fn start_avd(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err("Nome de AVD inválido.".into());
    }
    if !avds().iter().any(|a| a == name) {
        return Err(format!("Não existe o AVD '{name}'. Disponíveis: {}.", avds().join(", ")));
    }
    let mut cmd = Command::new(emulator_path()?);
    cmd.args(["-avd", name, "-no-snapshot-save"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS: que no abra consola y sobreviva a la app.
        cmd.creation_flags(0x0800_0000 | 0x0000_0008);
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| format!("emulator: {e}"))
}

/// El dispositivo a usar: el pedido, o el único que está listo.
pub fn pick_serial(wanted: Option<&str>, list: &[Device]) -> Result<String, String> {
    let ready: Vec<&Device> = list.iter().filter(|d| d.state == "device").collect();
    if let Some(w) = wanted.filter(|w| !w.is_empty()) {
        return match list.iter().find(|d| d.serial == w) {
            Some(d) if d.state == "device" => Ok(d.serial.clone()),
            Some(d) => Err(format!("O dispositivo {w} está '{}', ainda não pronto.", d.state)),
            None => Err(format!("O dispositivo {w} não está conectado.")),
        };
    }
    match ready.as_slice() {
        [one] => Ok(one.serial.clone()),
        [] => Err("Nenhum dispositivo Android pronto. Inicie um emulador (ou conecte um celular com depuração USB).".into()),
        many => Err(format!(
            "Há {} dispositivos prontos ({}): escolha um no nó do canvas.",
            many.len(),
            many.iter().map(|d| d.serial.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

// ── Pantalla ────────────────────────────────────────────────────────

/// La pantalla como PNG.
pub fn screenshot(serial: &str) -> Result<Vec<u8>, String> {
    let png = adb(Some(serial), &["exec-out", "screencap", "-p"], SLOW)?;
    if !png.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("O dispositivo não devolveu uma imagem (tela bloqueada ou desligada?).".into());
    }
    Ok(png)
}

/// `Physical size: 1080x2400` → (1080, 2400).
pub fn parse_size(out: &str) -> Option<(u32, u32)> {
    // Si hay "Override size", ese manda (es lo que se ve).
    let line = out.lines().rev().find(|l| l.contains("size:"))?;
    let (w, h) = line.split("size:").nth(1)?.trim().split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

pub fn size(serial: &str) -> Result<(u32, u32), String> {
    parse_size(&adb_text(Some(serial), &["shell", "wm", "size"], FAST)?).ok_or_else(|| "Não consegui ler o tamanho da tela.".to_string())
}

// ── Entrada ─────────────────────────────────────────────────────────

pub fn tap(serial: &str, x: u32, y: u32) -> Result<(), String> {
    adb(Some(serial), &["shell", "input", "tap", &x.to_string(), &y.to_string()], FAST).map(|_| ())
}

pub fn swipe(serial: &str, x1: u32, y1: u32, x2: u32, y2: u32, ms: u32) -> Result<(), String> {
    let args = [x1, y1, x2, y2, ms.clamp(50, 5000)].map(|n| n.to_string());
    let mut full = vec!["shell", "input", "swipe"];
    full.extend(args.iter().map(String::as_str));
    adb(Some(serial), &full, FAST).map(|_| ())
}

/// El texto como lo espera `input text`: los espacios son `%s` y el resto va entre comillas
/// simples para que el shell del dispositivo no lo interprete. Solo ASCII imprimible: es lo
/// que `input text` admite.
pub fn escape_text(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err("O texto está vazio.".into());
    }
    if let Some(bad) = text.chars().find(|c| !c.is_ascii() || (c.is_control() && *c != '\n')) {
        return Err(format!("O Android só aceita digitar ASCII simples (achei {bad:?}). Para outros caracteres, cole pelo app."));
    }
    let body: String = text
        .chars()
        .map(|c| match c {
            ' ' => "%s".to_string(),
            '\n' => "%s".to_string(),
            '%' => "%%".to_string(),
            '\'' => "'\\''".to_string(),
            c => c.to_string(),
        })
        .collect();
    Ok(format!("'{body}'"))
}

pub fn type_text(serial: &str, text: &str) -> Result<(), String> {
    let escaped = escape_text(text)?;
    adb(Some(serial), &["shell", "input", "text", &escaped], FAST).map(|_| ())
}

/// Teclas con nombre → código de Android. También se aceptan los números y `KEYCODE_*`.
pub fn keycode(name: &str) -> Result<String, String> {
    let lower = name.trim().to_lowercase();
    let code = match lower.as_str() {
        "back" => "4",
        "home" => "3",
        "recents" | "app_switch" | "overview" => "187",
        "enter" | "return" => "66",
        "menu" => "82",
        "power" => "26",
        "delete" | "backspace" => "67",
        "tab" => "61",
        "volume_up" => "24",
        "volume_down" => "25",
        "up" => "19",
        "down" => "20",
        "left" => "21",
        "right" => "22",
        "search" => "84",
        other if other.chars().all(|c| c.is_ascii_digit()) && !other.is_empty() => other,
        other if other.starts_with("keycode_") && other.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            return Ok(other.to_uppercase());
        }
        _ => return Err(format!("Tecla desconhecida '{name}'. Use back, home, recents, enter, menu, power, delete, tab, volume_up, volume_down, up/down/left/right ou KEYCODE_*.")),
    };
    Ok(code.to_string())
}

pub fn key(serial: &str, name: &str) -> Result<(), String> {
    let code = keycode(name)?;
    adb(Some(serial), &["shell", "input", "keyevent", &code], FAST).map(|_| ())
}

/// ¿Terminó de iniciar el sistema? Un emulador aparece en `adb devices` antes de estar listo.
pub fn boot_completed(serial: &str) -> bool {
    adb_text(Some(serial), &["shell", "getprop", "sys.boot_completed"], FAST).is_ok_and(|v| v.trim() == "1")
}

/// Abre una app por su paquete (`com.android.settings`).
pub fn launch(serial: &str, package: &str) -> Result<(), String> {
    if package.is_empty() || !package.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_')) {
        return Err("Nome de pacote inválido (algo como com.android.settings).".into());
    }
    let out = adb_text(Some(serial), &["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"], SLOW)?;
    if out.contains("No activities found") || out.contains("monkey aborted") {
        return Err(format!("O pacote '{package}' não está instalado ou não tem tela inicial."));
    }
    Ok(())
}

// ── Árbol de accesibilidad ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UiNode {
    pub text: String,
    pub desc: String,
    pub id: String,
    pub class: String,
    pub clickable: bool,
    /// left, top, right, bottom
    pub bounds: [i32; 4],
}

impl UiNode {
    pub fn center(&self) -> (i32, i32) {
        ((self.bounds[0] + self.bounds[2]) / 2, (self.bounds[1] + self.bounds[3]) / 2)
    }

    /// Lo que lo nombra para quien lo lee: su texto, o su descripción, o su id.
    pub fn label(&self) -> &str {
        [&self.text, &self.desc, &self.id].into_iter().find(|s| !s.is_empty()).map(String::as_str).unwrap_or("")
    }
}

fn unescape(s: &str) -> String {
    s.replace("&#10;", "\n").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// El valor de un atributo XML (`text="…"`), buscándolo con un espacio delante para no
/// confundir `text` con `content-desc` ni `resource-id`.
fn attr(node: &str, name: &str) -> String {
    let needle = format!(" {name}=\"");
    node.find(&needle)
        .map(|i| {
            let rest = &node[i + needle.len()..];
            unescape(&rest[..rest.find('"').unwrap_or(rest.len())])
        })
        .unwrap_or_default()
}

/// `[0,66][1080,210]` → [0, 66, 1080, 210].
fn parse_bounds(raw: &str) -> Option<[i32; 4]> {
    let nums: Vec<i32> = raw.split(|c: char| !(c.is_ascii_digit() || c == '-')).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
    (nums.len() == 4).then(|| [nums[0], nums[1], nums[2], nums[3]])
}

/// El XML de `uiautomator dump` → los elementos que dicen algo o se pueden tocar.
pub fn parse_tree(xml: &str) -> Vec<UiNode> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<node ") {
        let after = &rest[start..];
        let end = after.find('>').unwrap_or(after.len());
        let tag = &after[..end];
        rest = &after[end..];
        let Some(bounds) = parse_bounds(&attr(tag, "bounds")) else { continue };
        let node = UiNode {
            text: attr(tag, "text"),
            desc: attr(tag, "content-desc"),
            id: attr(tag, "resource-id").rsplit('/').next().unwrap_or("").to_string(),
            class: attr(tag, "class").rsplit('.').next().unwrap_or("").to_string(),
            clickable: attr(tag, "clickable") == "true",
            bounds,
        };
        if (!node.label().is_empty() || node.clickable) && bounds[2] > bounds[0] && bounds[3] > bounds[1] {
            out.push(node);
        }
    }
    out
}

pub fn tree(serial: &str) -> Result<Vec<UiNode>, String> {
    let xml = adb_text(Some(serial), &["exec-out", "uiautomator", "dump", "/dev/tty"], SLOW)?;
    if !xml.contains("<hierarchy") {
        return Err("Não consegui ler a tela (o app pode estar animando; tente de novo).".into());
    }
    Ok(parse_tree(&xml))
}

/// El árbol como lo lee un agente: una línea por elemento, con su número, lo que dice y dónde
/// tocarlo.
pub fn render_tree(nodes: &[UiNode]) -> String {
    nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let (x, y) = n.center();
            format!("[{i}] {}{} \"{}\" @({x},{y}){}", n.class, if n.clickable { " *" } else { "" }, n.label(), if n.id.is_empty() { String::new() } else { format!(" #{}", n.id) })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// El elemento cuyo texto o descripción es (o, si no hay exacto, contiene) `wanted`.
pub fn find_node<'a>(nodes: &'a [UiNode], wanted: &str) -> Option<&'a UiNode> {
    let needle = wanted.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    nodes
        .iter()
        .find(|n| n.text.to_lowercase() == needle || n.desc.to_lowercase() == needle || n.id.to_lowercase() == needle)
        .or_else(|| nodes.iter().find(|n| n.label().to_lowercase().contains(&needle)))
}

// ── Para la pantalla (comandos de Tauri) ────────────────────────────

#[derive(Serialize)]
pub struct AndroidList {
    pub devices: Vec<Device>,
    pub avds: Vec<String>,
    /// Hay `adb`: si no, la pantalla explica qué instalar en vez de una lista vacía.
    pub adb: bool,
}

#[tauri::command(async)]
pub fn android_list() -> AndroidList {
    AndroidList { adb: adb_path().is_ok(), devices: devices().unwrap_or_default(), avds: avds() }
}

#[tauri::command(async)]
pub fn android_start_avd(name: String) -> Result<(), String> {
    start_avd(&name)
}

#[derive(Serialize)]
pub struct Frame {
    /// PNG en base64, listo para un `data:` URL.
    pub png: String,
    pub width: u32,
    pub height: u32,
}

/// Un cuadro de la pantalla del dispositivo, con su tamaño real (para convertir los clics).
#[tauri::command(async)]
pub fn android_frame(serial: String) -> Result<Frame, String> {
    use base64::Engine;
    let png = screenshot(&serial)?;
    // El ancho y el alto salen del propio PNG (IHDR: bytes 16..24).
    let dim = |i: usize| u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]);
    let (width, height) = if png.len() > 24 { (dim(16), dim(20)) } else { (0, 0) };
    Ok(Frame { png: base64::engine::general_purpose::STANDARD.encode(&png), width, height })
}

#[tauri::command(async)]
pub fn android_tap(serial: String, x: u32, y: u32) -> Result<(), String> {
    tap(&serial, x, y)
}

#[tauri::command(async)]
pub fn android_swipe(serial: String, x1: u32, y1: u32, x2: u32, y2: u32) -> Result<(), String> {
    swipe(&serial, x1, y1, x2, y2, 250)
}

#[tauri::command(async)]
pub fn android_key(serial: String, key_name: String) -> Result<(), String> {
    key(&serial, &key_name)
}

#[tauri::command(async)]
pub fn android_text(serial: String, text: String) -> Result<(), String> {
    type_text(&serial, &text)
}

#[cfg(test)]
mod test;
