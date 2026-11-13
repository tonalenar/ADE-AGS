//! Motor nativo do navegador ADE, separado do runtime Tauri 2.
//!
//! No macOS, `cef_native` carrega CEF via `cef-rs` e cria uma `NSView` filha na janela Tauri.
//! No Windows, `native` hospeda WebView2 numa janela filha própria. Os dois usam CDP no objeto
//! interno do motor, sem porta DevTools exposta. Linux conserva o preview atual como fallback.
//!
//! A interface envia `real_browser_place` com retângulo, região visível e buracos da UI. O motor
//! move e redimensiona a mesma vista sem recriar a página; assim menus continuam clicáveis e o
//! mini preview preserva a sessão e a proporção. Partições ADE ficam sob os dados próprios do app,
//! por perfil e hash do projeto; na primeira abertura, uma cópia não destrutiva leva os dados da
//! partição antiga para o novo caminho, ignorando caches e locks.

#[cfg(windows)]
mod native;
#[cfg(target_os = "macos")]
#[path = "cef_native.rs"]
mod native;
#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    //! Linux mantém o caminho de preview já existente nesta fatia.
    use serde_json::Value;
    use tauri::AppHandle;
    const NO: &str = "O navegador nativo do Portal não está disponível nesta plataforma.";
    pub async fn create(_: &AppHandle, _: isize, _: &str, _: std::path::PathBuf, _: String, _: [i32; 4]) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn cdp(_: &AppHandle, _: &str, _: &str, _: Value) -> Result<Value, String> {
        Err(NO.into())
    }
    pub fn place(_: &AppHandle, _: &str, _: [i32; 4], _: f64, _: Vec<[i32; 4]>, _: f64, _: bool) {}
    pub async fn navigate(_: &AppHandle, _: &str, _: String) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn history(_: &AppHandle, _: &str, _: i32) -> Result<(), String> {
        Err(NO.into())
    }
    pub async fn focus(_: &AppHandle, _: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn close(_: &AppHandle, _: &str) {}
    pub async fn release_profile(_: &AppHandle, _: &std::path::Path) -> Result<(), String> { Ok(()) }
    pub async fn add_script(_: &AppHandle, _: &str, _: String) -> Result<(), String> {
        Err(NO.into())
    }
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub fn cef_initialize_probe() -> Result<(), String> {
    native::initialize_probe()
}

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Um retângulo em pixels CSS do app.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Onde o Portal está: `rect` relativo à janela; `visible` e `holes` relativos ao próprio Portal.
#[derive(Debug, Clone, Deserialize)]
pub struct Place {
    pub rect: Rect,
    /// O zoom da página (o do Portal vezes o do canvas).
    pub zoom: f64,
    /// A parte do Portal à vista (o resto está fora do canvas ou atrás de outra aba). `None` = nada à vista.
    pub visible: Option<Rect>,
    /// O que do app está por cima da página, dentro da parte à vista.
    #[serde(default)]
    pub holes: Vec<Rect>,
    /// Miniatura: hoje só informa o nativo; o clique continua indo para a página.
    #[serde(default)]
    pub click_to_expand: bool,
    /// Raio do cartão em pontos lógicos do macOS.
    #[serde(default)]
    pub corner_radius: f64,
}

/// Os Portais abertos.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PortalProfile {
    id: String,
    path: std::path::PathBuf,
}

fn portals() -> &'static Mutex<HashMap<String, PortalProfile>> {
    static P: OnceLock<Mutex<HashMap<String, PortalProfile>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// IDs viram nomes de pasta: só aceitam caracteres seguros e um tamanho limitado.
fn checked_profile_id(id: &str) -> Result<String, String> {
    if !id.is_empty() && id.len() <= 72 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(id.to_string())
    } else {
        Err("O id do perfil do navegador é inválido.".into())
    }
}

/// Só um perfil nomeado pela ADE pode ser removido; o sufixo nunca vira caminho arbitrário.
fn checked_managed_profile_id(id: &str) -> Result<String, String> {
    let id = checked_profile_id(id)?;
    let uuid = id.strip_prefix("profile-").ok_or_else(|| "Somente perfis criados na ADE podem ser removidos.".to_string())?;
    if uuid.len() != 36 || !uuid.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    }) {
        return Err("O id do perfil do navegador é inválido.".into());
    }
    Ok(id)
}

/// O último endereço pedido para um Portal que ainda está abrindo: a aba manda navegar logo ao montar, antes de o
/// navegador existir. Quem abre consome isto no lugar da URL inicial.
/// Pop-ups que o motor já criou e esperam a aba que vai adotá-los, com o perfil do opener.
fn adopted() -> &'static Mutex<HashMap<String, PortalProfile>> {
    static P: OnceLock<Mutex<HashMap<String, PortalProfile>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reserva `popup` com o perfil de `opener`: o pop-up precisa da mesma partição para manter o `opener`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn adopt_popup(opener: &str, popup: &str) -> Option<()> {
    let profile = lock(portals()).get(opener).cloned()?;
    lock(adopted()).insert(popup.to_string(), profile);
    Some(())
}

/// A página fechou a si mesma: o registro sai junto.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn forget_portal(id: &str) {
    lock(portals()).remove(id);
    lock(adopted()).remove(id);
}

fn pending() -> &'static Mutex<HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Um Portal abre de cada vez; o ambiente WebView2 é reaproveitado somente pelo mesmo perfil.
fn opening() -> &'static tokio::sync::Mutex<()> {
    static O: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    O.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// Só http(s) e `about:blank` abrem no Portal; um esquema de app (`mailto:`, `slack:`) não navega.
fn navigable(url: &str) -> Option<tauri::Url> {
    let parsed = tauri::Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed),
        "about" if url == "about:blank" => Some(parsed),
        _ => None,
    }
}

fn popup_allowed(url: &str) -> bool {
    navigable(url).is_some()
}

fn project_digest(project_path: &str) -> String {
    let digest = Sha256::digest(project_path.as_bytes());
    digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect::<String>()
}

/// Um diretório do WebView2 por perfil ADE e projeto, sem incorporar o caminho do projeto no disco.
#[cfg_attr(not(windows), allow(dead_code))]
fn project_profile_path(root: &std::path::Path, profile_id: &str, project_path: &str) -> std::path::PathBuf {
    root.join("profiles").join(profile_id).join("projects").join(format!("project-{}", project_digest(project_path)))
}

/// Pasta raiz do Chromium (CEF) da ADE, sob os dados do app: `root_cache_path` do CEF.
pub(crate) const CHROMIUM_ROOT: &str = "portal-chromium";

/// A partição Chromium de um perfil ADE num projeto. O runtime Chrome do CEF só cria perfis que sejam
/// filhos diretos do `root_cache_path`; um caminho aninhado cai num perfil anônimo, sem persistência.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chromium_partition_path(root: &std::path::Path, profile_id: &str, project_path: &str) -> std::path::PathBuf {
    root.join(format!("{profile_id}-{}", project_digest(project_path)))
}

/// Copia a sessão já guardada pela ADE para a primeira partição do projeto, sem apagar a origem.
fn migrate_legacy_partition(root: &std::path::Path, profile_id: &str, target: &std::path::Path) -> std::io::Result<bool> {
    let source = if profile_id == "default" { root.to_path_buf() } else { root.join("profiles").join(profile_id) };
    if !source.is_dir() { return Ok(false); }
    let marker = target.join(".ade-legacy-copy-complete");
    // Uma interrupção no processo pode deixar um marcador vazio; só um marcador completo encerra a migração.
    if std::fs::read(&marker).is_ok_and(|contents| contents == b"1") { return Ok(false); }
    copy_legacy_tree(&source, target, true)?;
    std::fs::create_dir_all(target)?;
    std::fs::write(marker, b"1")?;
    Ok(true)
}

fn copy_legacy_tree(source: &std::path::Path, target: &std::path::Path, root: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Ignora caches e locks ativos. `profiles` e `projects` pertencem ao novo particionamento e
        // não devem ser aninhados numa segunda partição durante a cópia de compatibilidade.
        if matches!(name.as_ref(), "Cache" | "Code Cache" | "GPUCache" | "ShaderCache" | "DawnCache" | "GrShaderCache" | "Crashpad" | "SingletonLock" | "SingletonSocket" | "SingletonCookie" | "lockfile")
            || (root && name == "profiles")
            || (!root && name == "projects")
        {
            continue;
        }
        let source_path = entry.path();
        let destination = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() { continue; }
        if kind.is_dir() {
            copy_legacy_tree(&source_path, &destination, false)?;
        } else if kind.is_file() && !destination.exists() {
            std::fs::copy(source_path, destination)?;
        }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn incognito_partition_path(id: &str) -> std::path::PathBuf {
    std::env::temp_dir().join("ade-ags-browser-incognito").join(std::process::id().to_string()).join(id)
}

async fn import_saved_cookies(app: &AppHandle, id: &str, profile_id: &str, partition: &std::path::Path, url: &str) -> Result<(), String> {
    if profile_id == "incognito" || partition.as_os_str().is_empty() { return Ok(()); }
    let Some(parsed) = navigable(url) else { return Ok(()) };
    if parsed.scheme() != "http" && parsed.scheme() != "https" { return Ok(()); }
    let origin = parsed.origin().ascii_serialization();
    let profile = profile_id.to_string();
    let cookie_origin = origin.clone();
    let (cookies, version) = tokio::task::spawn_blocking(move || crate::preview::chromium_cookie_snapshot(&cookie_origin, &profile))
        .await.map_err(|error| error.to_string())?;
    if cookies.is_empty() { return Ok(()); }

    let origin_hash: String = Sha256::digest(origin.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    let marker = partition.join("imported-sites").join(origin_hash);
    let previous = std::fs::read_to_string(&marker).ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
    if previous >= version { return Ok(()); }
    // Mantém as importações já feitas em Settings → Navegador acessíveis no motor novo.
    // Os valores nunca passam pelo frontend; o CDP continua interno ao Chromium.
    if native::cdp(app, id, "Network.setCookies", json!({ "cookies": cookies })).await.is_err() { return Ok(()); }
    let marker_copy = marker.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(parent) = marker_copy.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(marker_copy, version.to_string())
    }).await;
    Ok(())
}

/// `r` (px CSS) em px físicos: `[x, y, largura, altura]`, cobrindo o retângulo inteiro.
#[cfg_attr(not(windows), allow(dead_code))]
fn physical(r: Rect, scale: f64) -> [i32; 4] {
    let (x, y) = ((r.x * scale).floor() as i32, (r.y * scale).floor() as i32);
    [x, y, ((r.x + r.width) * scale).ceil() as i32 - x, ((r.y + r.height) * scale).ceil() as i32 - y]
}

/// Abre o navegador do Portal `id` em cima dele, já com o piloto dos agentes, e carrega `url`. Aberto, só
/// reposiciona: navegar é com `real_browser_navigate`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn real_browser_open(
    app: AppHandle,
    window: tauri::Window,
    id: String,
    url: String,
    place: Place,
    script: Option<String>,
    profile_id: String,
    project_path: String,
) -> Result<(), String> {
    let _one_at_a_time = opening().lock().await;
    let profile_id = checked_profile_id(&profile_id)?;
    let app_data = crate::util::datadir::app_data_dir(&app)?;
    let profile_root = app_data.join("portal-webview");
    // O anônimo não grava sessão em disco nem herda cookies importados.
    let profile = if profile_id == "incognito" {
        #[cfg(target_os = "macos")]
        { std::path::PathBuf::new() }
        #[cfg(windows)]
        { incognito_partition_path(&id) }
        #[cfg(not(any(target_os = "macos", windows)))]
        { std::path::PathBuf::new() }
    } else if cfg!(target_os = "macos") {
        chromium_partition_path(&app_data.join(CHROMIUM_ROOT), &profile_id, &project_path)
    } else { project_profile_path(&profile_root, &profile_id, &project_path) };
    let requested_profile = PortalProfile { id: profile_id.clone(), path: profile.clone() };
    // Um pop-up criado pelo motor: a aba nova só o adota (mesma partição do opener) e injeta o piloto.
    let adopted_profile = lock(adopted()).remove(&id);
    if let Some(adopted_profile) = adopted_profile {
        lock(portals()).insert(id.clone(), adopted_profile);
        #[cfg(target_os = "macos")]
        native::wait_ready(&app, &id).await?;
        if let Some(script) = script {
            native::cdp(&app, &id, "Runtime.addBinding", json!({ "name": BINDING })).await?;
            native::cdp(&app, &id, "Runtime.enable", json!({})).await?;
            native::add_script(&app, &id, page_script(&script)).await?;
        }
        return real_browser_place(app, window, id, place);
    }
    let existing_profile = lock(portals()).get(&id).cloned();
    if existing_profile.as_ref() != Some(&requested_profile) {
        let previous = { lock(portals()).remove(&id) };
        if let Some(previous) = previous {
            native::close(&app, &id);
            if previous.id == "incognito" && !previous.path.as_os_str().is_empty() {
                native::release_profile(&app, &previous.path).await?;
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(previous.path)).await;
            }
        }
        let parent = window_handle(&window)?;
        // Os dados antigos ficam intactos; as novas sessões ficam isoladas por perfil e projeto.
        if !profile.as_os_str().is_empty() {
            // A cópia de compatibilidade só faz sentido entre WebView2 e WebView2; o WKWebView antigo do
            // macOS guardava outro formato, que fica intacto em `portal-webview`.
            if profile_id != "incognito" && cfg!(windows) {
                let migration_root = profile_root.clone();
                let migration_target = profile.clone();
                let migration_profile = profile_id.clone();
                tokio::task::spawn_blocking(move || migrate_legacy_partition(&migration_root, &migration_profile, &migration_target))
                    .await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
            }
            std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        }
        // As mesmas flags do WebView do app (`tauri.conf.json`): também mantêm a página desenhando encoberta ou
        // recortada (`CalculateNativeWinOcclusion` desligado).
        let args = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()).unwrap_or_default();
        let scale = window.scale_factor().unwrap_or(1.0);
        native::create(&app, parent, &id, profile.clone(), args, native_rect(place.rect, scale)).await?;
        lock(portals()).insert(id.clone(), requested_profile);
        // O piloto antes da primeira página: o canal (binding) e o script em todo documento novo.
        if let Some(script) = script {
            native::cdp(&app, &id, "Runtime.addBinding", json!({ "name": BINDING })).await?;
            native::cdp(&app, &id, "Runtime.enable", json!({})).await?;
            native::add_script(&app, &id, page_script(&script)).await?;
        }
        let white = json!({ "color": { "r": 255, "g": 255, "b": 255, "a": 1 } });
        let _ = native::cdp(&app, &id, "Emulation.setDefaultBackgroundColorOverride", white).await;
        let url = lock(pending()).remove(&id).unwrap_or(url);
        if navigable(&url).is_some() {
            import_saved_cookies(&app, &id, &profile_id, &profile, &url).await?;
            native::navigate(&app, &id, url).await?;
        }
    }
    real_browser_place(app, window, id, place)
}

fn window_handle(window: &tauri::Window) -> Result<isize, String> {
    #[cfg(windows)]
    return window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string());
    #[cfg(target_os = "macos")]
    return window.ns_view().map(|view| view as isize).map_err(|e| e.to_string());
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = window;
        Ok(0)
    }
}

/// A parte da página que aparece, em retângulos relativos ao Portal: a parte à vista menos os buracos.
/// Vazia = nada aparece (a página continua desenhando).
pub fn region(place: &Place) -> Vec<Rect> {
    let Some(visible) = place.visible else { return Vec::new() };
    let mut parts = vec![visible];
    for hole in &place.holes {
        parts = parts.into_iter().flat_map(|part| subtract(part, *hole)).collect();
    }
    parts.retain(|r| r.width > 0.0 && r.height > 0.0);
    parts
}

/// `a` menos `b`: até quatro faixas (em cima, embaixo, à esquerda, à direita do pedaço de `b` dentro de `a`).
fn subtract(a: Rect, b: Rect) -> Vec<Rect> {
    let (ax2, ay2, bx2, by2) = (a.x + a.width, a.y + a.height, b.x + b.width, b.y + b.height);
    let (ix, iy, ix2, iy2) = (a.x.max(b.x), a.y.max(b.y), ax2.min(bx2), ay2.min(by2));
    if ix >= ix2 || iy >= iy2 {
        return vec![a];
    }
    let mut out = Vec::new();
    if iy > a.y {
        out.push(Rect { x: a.x, y: a.y, width: a.width, height: iy - a.y });
    }
    if iy2 < ay2 {
        out.push(Rect { x: a.x, y: iy2, width: a.width, height: ay2 - iy2 });
    }
    if ix > a.x {
        out.push(Rect { x: a.x, y: iy, width: ix - a.x, height: iy2 - iy });
    }
    if ix2 < ax2 {
        out.push(Rect { x: ix2, y: iy, width: ax2 - ix2, height: iy2 - iy });
    }
    out
}

/// O Portal mudou de lugar, de tamanho, de zoom, saiu de vista ou ganhou algo por cima.
#[tauri::command]
pub fn real_browser_place(app: AppHandle, window: tauri::Window, id: String, place: Place) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let parts: Vec<[i32; 4]> = region(&place).into_iter().map(|r| native_rect(r, scale)).map(|[x, y, w, h]| [x, y, x + w, y + h]).collect();
    let radius = if cfg!(windows) { place.corner_radius * scale } else { place.corner_radius };
    let rect = native_rect(place.rect, scale);
    let zoom = emulated_place(&app, &id, &place, (rect, parts.clone(), radius, place.click_to_expand));
    native::place(&app, &id, rect, zoom, parts, radius, place.click_to_expand);
    Ok(())
}

/// Aparelho emulado por vista: a densidade (`deviceScaleFactor`) e o último tamanho mandado ao CDP.
#[derive(Default)]
struct Emulated {
    density: Option<f64>,
    /// Largura e altura da tela em px CSS da página, e a escala até a tela, em milésimos.
    sent: Option<(i64, i64, i64)>,
    /// O último lugar visto (vale também antes da emulação ligar).
    last: Option<(f64, f64, f64)>,
    /// O último `native::place`, para reaplicar o zoom certo quando a emulação liga ou desliga.
    native: Option<NativePlace>,
}

type NativePlace = ([i32; 4], Vec<[i32; 4]>, f64, bool);

fn emulated() -> &'static Mutex<HashMap<String, Emulated>> {
    static E: OnceLock<Mutex<HashMap<String, Emulated>>> = OnceLock::new();
    E.get_or_init(Default::default)
}

/// As medidas do aparelho para `Emulation.setDeviceMetricsOverride`: com o zoom do CEF, a página móvel calcula
/// `device-width` sobre a vista já encolhida e o layout fica maior que a tela (o site saía cortado). Por isso, no
/// modo aparelho a vista fica sem zoom e a página é desenhada no tamanho do aparelho, escalada por `scale`. Pura.
fn device_metrics(width: f64, height: f64, zoom: f64, density: f64) -> (Value, (i64, i64, i64)) {
    let zoom = if zoom > 0.0 { zoom } else { 1.0 };
    let w = (width / zoom).round().max(1.0) as i64;
    let h = (height / zoom).round().max(1.0) as i64;
    let key = (w, h, (zoom * 1000.0).round() as i64);
    (json!({ "width": w, "height": h, "deviceScaleFactor": density, "mobile": true, "scale": zoom }), key)
}

/// Guarda o lugar de `id`; com aparelho emulado, reenvia as medidas se mudaram e devolve o zoom que a vista nativa
/// deve usar (1: a escala vem do CDP). Sem emulação, o zoom pedido.
fn emulated_place(app: &AppHandle, id: &str, place: &Place, native: NativePlace) -> f64 {
    let Ok(mut map) = emulated().lock() else { return place.zoom };
    let entry = map.entry(id.to_string()).or_default();
    entry.last = Some((place.rect.width, place.rect.height, place.zoom));
    entry.native = Some(native);
    let Some(density) = entry.density else { return place.zoom };
    if place.rect.width <= 0.0 || place.rect.height <= 0.0 { return 1.0; }
    let (metrics, key) = device_metrics(place.rect.width, place.rect.height, place.zoom, density);
    if entry.sent != Some(key) {
        entry.sent = Some(key);
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move {
            let _ = native::cdp(&app, &id, "Emulation.setDeviceMetricsOverride", metrics).await;
        });
    }
    1.0
}

/// O WebView2 recebe pixels físicos; o AppKit recebe pontos lógicos da janela.
fn native_rect(rect: Rect, scale: f64) -> [i32; 4] {
    #[cfg(windows)]
    { physical(rect, scale) }
    #[cfg(not(windows))]
    {
        let _ = scale;
        [rect.x.floor() as i32, rect.y.floor() as i32, rect.width.ceil() as i32, rect.height.ceil() as i32]
    }
}

/// Entry point dos helpers Chromium no mesmo binário. Só a configuração macOS tem CEF.
#[cfg(target_os = "macos")]
pub fn cef_helper_entry() -> Option<i32> {
    native::cef_helper_entry()
}

#[cfg(target_os = "macos")]
pub fn cef_shutdown() {
    native::shutdown();
}

/// A barra de endereço (ou um agente) mandou ir para `url`. A mesma URL de novo é recarregar, como no T3.
#[tauri::command]
pub async fn real_browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    navigable(&url).ok_or("Endereço que o navegador não abre.")?;
    let profile = lock(portals()).get(&id).cloned();
    if profile.is_none() {
        // Ainda abrindo: vai direto para cá quando abrir.
        lock(pending()).insert(id, url);
        return Ok(());
    }
    let profile = profile.expect("profile checked above");
    import_saved_cookies(&app, &id, &profile.id, &profile.path, &url).await?;
    native::navigate(&app, &id, url).await
}

/// Voltar (-1), avançar (+1) ou recarregar (0).
#[tauri::command]
pub async fn real_browser_history(app: AppHandle, id: String, delta: i32) -> Result<(), String> {
    native::history(&app, &id, delta).await
}

/// Recarrega a página; com `ignore_cache`, sem o cache (⇧⌘R / "Recarregar sem cache").
#[tauri::command]
pub async fn real_browser_reload(app: AppHandle, id: String, ignore_cache: bool) -> Result<(), String> {
    native::cdp(&app, &id, "Page.reload", json!({ "ignoreCache": ignore_cache })).await.map(|_| ())
}

/// A ponte e o piloto, só no documento principal e em frames da MESMA origem. Num frame de outra origem (o login
/// da Apple em `idmsa.apple.com` dentro do App Store Connect, por exemplo) os shims de cookie e storage do piloto
/// quebravam o formulário; lá a página fica intocada. O bloco `if` mantém o script como estava no topo.
fn page_script(script: &str) -> String {
    format!("if (window.top === window || (() => {{ try {{ return window.top.location.origin === location.origin; }} catch (_) {{ return false; }} }})()) {{\n{BRIDGE}\n;{script}\n}}")
}

/// Fecha o navegador do Portal.
#[tauri::command]
pub async fn real_browser_close(app: AppHandle, id: String) -> Result<(), String> {
    lock(pending()).remove(&id);
    lock(emulated()).remove(&id);
    let profile = { lock(portals()).remove(&id) };
    if let Some(profile) = profile {
        native::close(&app, &id);
        if profile.id == "incognito" && !profile.path.as_os_str().is_empty() {
            native::release_profile(&app, &profile.path).await?;
            tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(profile.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }).await.map_err(|error| error.to_string())??;
        }
    }
    Ok(())
}

/// Remove os dados de um perfil criado pela ADE depois de confirmar que nenhum Portal o está usando.
#[tauri::command]
pub async fn real_browser_delete_profile(app: AppHandle, profile_id: String) -> Result<(), String> {
    let profile_id = checked_managed_profile_id(&profile_id)?;
    let _one_at_a_time = opening().lock().await;
    if lock(portals()).values().any(|opened| opened.id == profile_id) {
        return Err("browser_profile_in_use".into());
    }

    let app_data = crate::util::datadir::app_data_dir(&app)?;
    let profile_path = app_data.join("portal-webview").join("profiles").join(&profile_id);
    // O ambiente WebView2 é cacheado na thread da interface; soltá-lo antes de tentar apagar a pasta.
    native::release_profile(&app, &profile_path).await?;
    // No macOS, as partições Chromium do perfil (uma por projeto) também saem.
    let partitions = chromium_partitions_of(&app_data.join(CHROMIUM_ROOT), &profile_id);
    for partition in &partitions {
        native::release_profile(&app, partition).await?;
    }
    tokio::task::spawn_blocking(move || {
        for path in std::iter::once(profile_path).chain(partitions) {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("browser_profile_delete_failed:{error}")),
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Não foi possível concluir a remoção do perfil: {error}"))?
}

/// As partições Chromium de um perfil: `<perfil>-<32 hex>`, nunca as de um perfil com prefixo igual.
fn chromium_partitions_of(root: &std::path::Path, profile_id: &str) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let prefix = format!("{profile_id}-");
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.strip_prefix(&prefix).is_some_and(|hash| hash.len() == 32 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        })
        .map(|entry| entry.path())
        .collect()
}

/// O foco do teclado vai para a página.
#[tauri::command]
pub async fn real_browser_focus(app: AppHandle, id: String) -> Result<(), String> {
    native::focus(&app, &id).await
}

/// Uma mensagem do app para o piloto da página (`page:run`, `connect`, `pick:on`…). Só as do app (`source: ade-ags`).
#[tauri::command]
pub async fn real_browser_post(app: AppHandle, id: String, message: Value) -> Result<(), String> {
    if message["source"] != "ade-ags" {
        return Err("Mensagem que não é do app.".into());
    }
    post_to_page(&app, &id, &message).await
}

/// A foto da página como está agora (PNG em base64) e o tamanho dela em px CSS: as fotos do piloto.
#[tauri::command]
pub async fn real_browser_screenshot(app: AppHandle, id: String) -> Result<Value, String> {
    let layout = native::cdp(&app, &id, "Page.getLayoutMetrics", json!({})).await?;
    let viewport = &layout["cssLayoutViewport"];
    let shot = native::cdp(&app, &id, "Page.captureScreenshot", json!({ "format": "png" })).await?;
    Ok(json!({ "data": shot["data"], "width": viewport["clientWidth"], "height": viewport["clientHeight"] }))
}

/// Identidade de aparelho para testes de web mobile: user agent, densidade, `mobile` e toque.
/// `platform` `None` volta ao navegador de mesa. O tamanho da página continua sendo o da vista
/// (o quadro que a interface desenha); aqui só muda quem a página acha que é.
fn emulation_profile(platform: Option<&str>) -> Option<(Value, f64)> {
    match platform {
        Some("ios") => Some((json!({
            "userAgent": IOS_UA,
            "platform": "iPhone",
            "acceptLanguage": "",
        }), 3.0)),
        Some("android") => Some((json!({
            "userAgent": ANDROID_UA,
            "platform": "Linux armv81",
            "userAgentMetadata": {
                "brands": [{ "brand": "Chromium", "version": "156" }, { "brand": "Google Chrome", "version": "156" }],
                "fullVersion": "156.0.0.0",
                "platform": "Android",
                "platformVersion": "15.0.0",
                "architecture": "",
                "model": "Pixel 9",
                "mobile": true,
            },
        }), 2.625)),
        _ => None,
    }
}

const IOS_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA: &str = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";

/// Faz a página do navegador `id` se comportar como um iPhone (`"ios"`), um Android (`"android"`) ou o
/// navegador de mesa (`None`), e recarrega para o servidor também ver o aparelho novo.
#[tauri::command]
pub async fn real_browser_emulate(app: AppHandle, id: String, platform: Option<String>, chrome: Option<Value>) -> Result<(), String> {
    let profile = emulation_profile(platform.as_deref());
    let mobile = profile.is_some();
    match &profile {
        Some((ua, scale)) => {
            native::cdp(&app, &id, "Emulation.setUserAgentOverride", ua.clone()).await?;
            let (last, placed) = emulated().lock().ok().map(|mut map| {
                let entry = map.entry(id.clone()).or_default();
                entry.density = Some(*scale);
                entry.sent = None;
                let last = entry.last;
                if let Some((w, h, z)) = last { entry.sent = Some(device_metrics(w, h, z, *scale).1); }
                (last, entry.native.clone())
            }).unwrap_or((None, None));
            let metrics = match last {
                Some((w, h, z)) if w > 0.0 && h > 0.0 => device_metrics(w, h, z, *scale).0,
                _ => json!({ "width": 0, "height": 0, "deviceScaleFactor": scale, "mobile": true }),
            };
            native::cdp(&app, &id, "Emulation.setDeviceMetricsOverride", metrics).await?;
            // A vista sai do zoom: a escala agora vem do CDP.
            if let Some((rect, parts, radius, click)) = placed { native::place(&app, &id, rect, 1.0, parts, radius, click); }
        }
        None => {
            let restore = emulated().lock().ok().and_then(|mut map| {
                let entry = map.get_mut(&id)?;
                entry.density = None;
                entry.sent = None;
                Some((entry.native.clone()?, entry.last?.2))
            });
            if let Some(((rect, parts, radius, click), zoom)) = restore { native::place(&app, &id, rect, zoom, parts, radius, click); }
            native::cdp(&app, &id, "Emulation.setUserAgentOverride", json!({ "userAgent": "" })).await?;
            native::cdp(&app, &id, "Emulation.clearDeviceMetricsOverride", json!({})).await?;
        }
    }
    // A moldura dentro da página só no mockup; no modo Completo a página fica limpa.
    set_device_chrome(&app, &id, platform.as_deref().filter(|_| mobile && chrome.is_some()), chrome.as_ref()).await;
    native::cdp(&app, &id, "Emulation.setTouchEmulationEnabled", json!({ "enabled": mobile, "maxTouchPoints": if mobile { 5 } else { 1 } })).await?;
    native::cdp(&app, &id, "Emulation.setEmitTouchEventsForMouse", json!({ "enabled": mobile, "configuration": "mobile" })).await?;
    native::cdp(&app, &id, "Page.reload", json!({ "ignoreCache": false })).await?;
    Ok(())
}

/// A moldura do aparelho desenhada dentro da página (barra de status e navegador do sistema). Ver `device_chrome.js`.
const DEVICE_CHROME: &str = include_str!("device_chrome.js");

/// O script da moldura com a plataforma e os rótulos (já na língua do app). Só textos curtos entram; o resto vira "".
fn device_chrome_source(platform: &str, labels: Option<&Value>) -> String {
    let keys = ["back", "reload", "menu", "tabs", "address", "share", "desktop"];
    let mut clean = serde_json::Map::new();
    for key in keys {
        let text = labels.and_then(|l| l[key].as_str()).unwrap_or("");
        let text: String = text.chars().filter(|c| !matches!(c, '<' | '>' | '"' | '&' | '`' | '$' | '\\')).take(60).collect();
        clean.insert(key.to_string(), Value::String(text));
    }
    let platform = if platform == "ios" { "ios" } else { "android" };
    DEVICE_CHROME.replace("__AGS_PLATFORM__", platform).replace("__AGS_LABELS__", &Value::Object(clean).to_string())
}

/// A área que a moldura ocupa, para `env(safe-area-inset-*)` da página (retrato).
fn device_safe_area(platform: &str) -> Value {
    if platform == "ios" {
        // A barra de status fica fora da página (PhoneChrome.tsx); só a barra de início e o vidro ficam dentro.
        json!({ "top": 0, "topMax": 0, "bottom": 34, "bottomMax": 34, "left": 0, "leftMax": 0, "right": 0, "rightMax": 0 })
    } else {
        json!({ "top": 0, "topMax": 0, "bottom": 0, "bottomMax": 0, "left": 0, "leftMax": 0, "right": 0, "rightMax": 0 })
    }
}

/// Liga a moldura de `platform` em todo documento novo da vista `id` e desliga a anterior; `None` só desliga.
/// Erros são ignorados: sem moldura a página continua funcionando.
async fn set_device_chrome(app: &AppHandle, id: &str, platform: Option<&str>, labels: Option<&Value>) {
    static SCRIPTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let scripts = SCRIPTS.get_or_init(Default::default);
    let previous = scripts.lock().ok().and_then(|mut m| m.remove(id));
    if let Some(identifier) = previous {
        let _ = native::cdp(app, id, "Page.removeScriptToEvaluateOnNewDocument", json!({ "identifier": identifier })).await;
    }
    let Some(platform) = platform else {
        let _ = native::cdp(app, id, "Emulation.setSafeAreaInsetsOverride", json!({ "insets": {} })).await;
        return;
    };
    let _ = native::cdp(app, id, "Emulation.setSafeAreaInsetsOverride", json!({ "insets": device_safe_area(platform) })).await;
    let _ = native::cdp(app, id, "Page.enable", json!({})).await;
    let source = device_chrome_source(platform, labels);
    if let Ok(reply) = native::cdp(app, id, "Page.addScriptToEvaluateOnNewDocument", json!({ "source": source })).await {
        if let (Some(identifier), Ok(mut m)) = (reply["identifier"].as_str(), scripts.lock()) {
            m.insert(id.to_string(), identifier.to_string());
        }
    }
}

/// O nome do canal da página para o app (`Runtime.addBinding`).
// Não pode ser `__agsPage`: é a marca de "piloto já instalado" do `runtime.ts`.
const BINDING: &str = "__agsCdpBridge";

/// Roda antes do piloto em cada documento. A página é a janela principal: o piloto manda para `window.parent`, que
/// é ela mesma, e a ponte repassa ao app pelo binding. A função do binding é guardada e tirada do `window` antes de
/// qualquer script da página rodar. `__ags_trusted_input` liga os toques e teclas pelo CDP.
const BRIDGE: &str = r#"(() => {
  if (window.__ags_bridge) return;
  Object.defineProperty(window, "__ags_bridge", { value: true });
  const send = window.__agsCdpBridge;
  try { delete window.__agsCdpBridge; } catch (_) {}
  self.__ags_trusted_input = typeof send === "function";
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source === window && d && d.source === "ags-preview" && typeof send === "function") {
      try { send(JSON.stringify(d)); } catch (_) {}
    }
  });
})();"#;

/// Uma mensagem que o piloto mandou pelo binding: `input:request` é com o Rust (toque ou tecla de verdade), o resto
/// vai para o Portal.
#[cfg_attr(not(windows), allow(dead_code))]
fn on_binding(app: &AppHandle, id: &str, payload: &str) {
    let Ok(message) = serde_json::from_str::<Value>(payload) else { return };
    if message["type"] == "input:request" {
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move { native_input(&app, &id, message["payload"].clone()).await });
    } else {
        emit(app, "real-browser-page", json!({ "id": id, "message": message }));
    }
}

/// Entrega uma mensagem do app ao piloto da página (como o `postMessage` do iframe faz no outro navegador).
async fn post_to_page(app: &AppHandle, id: &str, message: &Value) -> Result<(), String> {
    let expression = format!("window.postMessage({message}, \"*\")");
    native::cdp(app, id, "Runtime.evaluate", json!({ "expression": expression })).await.map(|_| ())
}

/// Um toque ou uma tecla de verdade que o piloto pediu (`input:request`), e a resposta `input:done`.
async fn native_input(app: &AppHandle, id: &str, request: Value) {
    let ok = run_native_input(app, id, &request).await.is_ok();
    let _ = post_to_page(app, id, &json!({ "source": "ade-ags", "type": "input:done", "id": request["id"], "ok": ok })).await;
}

async fn run_native_input(app: &AppHandle, id: &str, r: &Value) -> Result<(), String> {
    match r["kind"].as_str() {
        Some("click") => {
            let (x, y) = (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0));
            native::cdp(app, id, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" })).await?;
            for kind in ["mousePressed", "mouseReleased"] {
                let buttons = if kind == "mousePressed" { 1 } else { 0 };
                native::cdp(app, id, "Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": buttons, "clickCount": 1 })).await?;
            }
        }
        Some("key") => {
            let mut down = json!({
                "type": if r["text"].is_string() { "keyDown" } else { "rawKeyDown" },
                "key": r["key"], "code": r["code"], "windowsVirtualKeyCode": r["keyCode"], "modifiers": r["modifiers"],
            });
            if r["text"].is_string() {
                down["text"] = r["text"].clone();
                down["unmodifiedText"] = r["text"].clone();
            }
            if r["commands"].is_array() {
                down["commands"] = r["commands"].clone();
            }
            native::cdp(app, id, "Input.dispatchKeyEvent", down).await?;
            native::cdp(app, id, "Input.dispatchKeyEvent", json!({
                "type": "keyUp", "key": r["key"], "code": r["code"], "windowsVirtualKeyCode": r["keyCode"], "modifiers": r["modifiers"],
            }))
            .await?;
        }
        Some("text") => {
            native::cdp(app, id, "Input.insertText", json!({ "text": r["text"] })).await?;
        }
        _ => return Err("pedido de input desconhecido".into()),
    }
    Ok(())
}

/// Autoteste de desenvolvimento (só debug, só macOS): com `ADE_CEF_SELFTEST=<url>[,<url>…]`, cria o
/// Chromium na janela principal sem passar pela interface, abre cada URL e grava um PNG por CDP em
/// `ADE_CEF_SELFTEST_OUT`. Serve para provar o motor com a tela bloqueada ou a interface pausada.
#[cfg(all(target_os = "macos", debug_assertions))]
pub fn spawn_selftest(app: &AppHandle) {
    use base64::Engine;
    use tauri::{Listener, Manager};
    let Ok(urls) = std::env::var("ADE_CEF_SELFTEST") else { return };
    let out = std::path::PathBuf::from(std::env::var("ADE_CEF_SELFTEST_OUT").unwrap_or_else(|_| ".".into()));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let report = |line: String| eprintln!("[cef-selftest] {line}");
        let Some(window) = app.get_webview_window("main").map(|w| w.as_ref().window()) else {
            return report("janela principal ausente".into());
        };
        let parent = match window_handle(&window) { Ok(parent) => parent, Err(error) => return report(error) };
        let root = match crate::util::datadir::app_data_dir(&app) { Ok(dir) => dir.join(CHROMIUM_ROOT), Err(error) => return report(error) };
        let profile = chromium_partition_path(&root, "default", "/selftest");
        let _ = std::fs::create_dir_all(&profile);
        let (loads, mut loaded) = tokio::sync::mpsc::unbounded_channel::<bool>();
        app.listen_any("real-browser-load", move |event| {
            let loading = serde_json::from_str::<Value>(event.payload()).ok().and_then(|v| v["loading"].as_bool()).unwrap_or(true);
            let _ = loads.send(loading);
        });
        lock(portals()).insert("selftest".into(), PortalProfile { id: "default".into(), path: profile.clone() });
        if let Err(error) = native::create(&app, parent, "selftest", profile, String::new(), [40, 60, 1100, 760]).await {
            report(format!("create falhou: {error}"));
            return finish_selftest(&app, 1);
        }
        report("vista Chromium criada".into());
        for (index, url) in urls.split(',').enumerate() {
            while loaded.try_recv().is_ok() {}
            if let Err(error) = native::navigate(&app, "selftest", url.to_string()).await { report(format!("{url}: {error}")); continue; }
            let wait = async { while let Some(loading) = loaded.recv().await { if !loading { break; } } };
            if tokio::time::timeout(std::time::Duration::from_secs(45), wait).await.is_err() { report(format!("{url}: sem fim de carga em 45 s")); }
            let probe = json!({ "expression": "JSON.stringify({href: location.href, title: document.title, ua: navigator.userAgent, webdriver: navigator.webdriver})", "returnByValue": true });
            match native::cdp(&app, "selftest", "Runtime.evaluate", probe).await {
                Ok(value) => report(format!("{url} -> {}", value["result"]["value"].as_str().unwrap_or("?"))),
                Err(error) => report(format!("{url}: evaluate falhou: {error}")),
            }
            match native::cdp(&app, "selftest", "Page.captureScreenshot", json!({ "format": "png" })).await {
                Ok(value) => {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(value["data"].as_str().unwrap_or_default()).unwrap_or_default();
                    let file = out.join(format!("cef-selftest-{index}.png"));
                    let _ = std::fs::write(&file, &bytes);
                    report(format!("{url}: captura {} bytes em {}", bytes.len(), file.display()));
                }
                Err(error) => report(format!("{url}: captura falhou: {error}")),
            }
        }
        // Pop-up com gesto do usuário, como um OAuth: vira aba nova com o `opener` vivo.
        let (popups, mut popped) = tokio::sync::mpsc::unbounded_channel::<String>();
        app.listen_any("real-browser-popup", move |event| {
            if let Some(popup) = serde_json::from_str::<Value>(event.payload()).ok().and_then(|v| v["popup"].as_str().map(String::from)) {
                let _ = popups.send(popup);
            }
        });
        let (closes, mut closed) = tokio::sync::mpsc::unbounded_channel::<String>();
        app.listen_any("real-browser-closed", move |event| {
            if let Some(id) = serde_json::from_str::<Value>(event.payload()).ok().and_then(|v| v["id"].as_str().map(String::from)) {
                let _ = closes.send(id);
            }
        });
        let button = json!({ "expression": "(() => { const b = document.createElement('button'); b.textContent = 'oauth'; b.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:60px;z-index:99999'; b.onclick = () => { window.__popup = window.open('https://example.com/?popup=1', 'oauth', 'width=480,height=640') ? 'aberto' : 'bloqueado'; }; document.body.append(b); return 'ok'; })()", "returnByValue": true });
        let _ = native::cdp(&app, "selftest", "Runtime.evaluate", button).await;
        for kind in ["mousePressed", "mouseReleased"] {
            let click = json!({ "type": kind, "x": 30, "y": 30, "button": "left", "clickCount": 1 });
            if let Err(error) = native::cdp(&app, "selftest", "Input.dispatchMouseEvent", click).await { report(format!("clique falhou: {error}")); }
        }
        let state = json!({ "expression": "String(window.__popup)", "returnByValue": true });
        match native::cdp(&app, "selftest", "Runtime.evaluate", state).await {
            Ok(value) => report(format!("window.open -> {}", value["result"]["value"])),
            Err(error) => report(format!("window.open falhou: {error}")),
        }
        match tokio::time::timeout(std::time::Duration::from_secs(10), popped.recv()).await {
            Ok(Some(popup)) => {
                report(format!("pop-up anunciado: {popup}"));
                match native::wait_ready(&app, &popup).await {
                    Ok(()) => {
                        let check = json!({ "expression": "new Promise(r => { const go = () => r(JSON.stringify({href: location.href, opener: !!window.opener})); document.readyState === 'complete' ? go() : addEventListener('load', go); })", "awaitPromise": true, "returnByValue": true });
                        match native::cdp(&app, &popup, "Runtime.evaluate", check).await {
                            Ok(value) => report(format!("pop-up -> {}", value["result"]["value"].as_str().unwrap_or("?"))),
                            Err(error) => report(format!("pop-up evaluate falhou: {error}")),
                        }
                        let _ = native::cdp(&app, &popup, "Runtime.evaluate", json!({ "expression": "setTimeout(() => window.close(), 50); 1" })).await;
                        match tokio::time::timeout(std::time::Duration::from_secs(10), closed.recv()).await {
                            Ok(Some(id)) => report(format!("pop-up fechou pela página: {}", id == popup)),
                            _ => report("pop-up não avisou o fechamento".into()),
                        }
                    }
                    Err(error) => report(format!("pop-up não ficou pronto: {error}")),
                }
            }
            _ => report("nenhum pop-up anunciado".into()),
        }
        report("fim".into());
        finish_selftest(&app, 0);
    });
}

/// O mesmo encerramento do `RunEvent::Exit`, sem esperar a interface salvar (ela pode estar pausada).
#[cfg(all(target_os = "macos", debug_assertions))]
fn finish_selftest(app: &AppHandle, code: i32) {
    let _ = app.run_on_main_thread(move || {
        native::shutdown();
        eprintln!("[cef-selftest] encerrado ({code})");
        std::process::exit(code);
    });
}

#[cfg(test)]
mod test {
    use super::{adopt_popup, adopted, device_metrics, emulation_profile, chromium_partition_path, chromium_partitions_of, forget_portal, incognito_partition_path, lock, migrate_legacy_partition, navigable, physical, popup_allowed, portals, project_profile_path, region, subtract, Place, PortalProfile, Rect};
    use serde_json::json;

    #[test]
    fn aparelho_escalado_mede_o_tamanho_do_aparelho_e_nao_o_da_vista() {
        // 430×932 mostrado a 68%: a vista tem 292×634, mas a página tem de medir 430×932.
        let (metrics, key) = device_metrics(292.4, 633.76, 0.68, 3.0);
        assert_eq!(metrics["width"], 430);
        assert_eq!(metrics["height"], 932);
        assert_eq!(metrics["scale"], 0.68);
        assert_eq!(metrics["mobile"], true);
        assert_eq!(key, (430, 932, 680));
    }

    #[test]
    fn emulacao_mobile_tem_identidade_de_cada_aparelho() {
        let (ios, ios_scale) = emulation_profile(Some("ios")).unwrap();
        assert!(ios["userAgent"].as_str().unwrap().contains("iPhone"));
        assert_eq!(ios_scale, 3.0);
        let (android, _) = emulation_profile(Some("android")).unwrap();
        assert!(android["userAgent"].as_str().unwrap().contains("Android"));
        assert_eq!(android["userAgentMetadata"]["mobile"], true);
        assert!(emulation_profile(None).is_none());
        assert!(emulation_profile(Some("palm")).is_none());
    }

    fn r(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    fn area(parts: &[Rect]) -> f64 {
        parts.iter().map(|p| p.width * p.height).sum()
    }

    #[test]
    fn buraco_no_meio_deixa_quatro_faixas() {
        let parts = subtract(r(0.0, 0.0, 100.0, 100.0), r(40.0, 40.0, 20.0, 20.0));
        assert_eq!(parts.len(), 4);
        assert_eq!(area(&parts), 100.0 * 100.0 - 20.0 * 20.0);
    }

    #[test]
    fn buraco_fora_nao_muda_nada_e_buraco_maior_apaga_tudo() {
        assert_eq!(subtract(r(0.0, 0.0, 10.0, 10.0), r(20.0, 20.0, 5.0, 5.0)), vec![r(0.0, 0.0, 10.0, 10.0)]);
        assert!(subtract(r(10.0, 10.0, 10.0, 10.0), r(0.0, 0.0, 50.0, 50.0)).is_empty());
    }


    #[test]
    fn regiao_e_a_parte_a_vista_menos_o_que_esta_por_cima() {
        let place = |visible, holes| Place { rect: r(0.0, 0.0, 800.0, 600.0), zoom: 1.0, visible, holes, click_to_expand: false, corner_radius: 0.0 };
        assert!(region(&place(None, vec![])).is_empty(), "fora de vista não aparece nada");
        assert_eq!(region(&place(Some(r(0.0, 0.0, 800.0, 300.0)), vec![])), vec![r(0.0, 0.0, 800.0, 300.0)]);
        // Um menu de 200×100 no canto de cima à direita.
        let parts = region(&place(Some(r(0.0, 0.0, 800.0, 600.0)), vec![r(600.0, 0.0, 200.0, 100.0)]));
        assert_eq!(area(&parts), 800.0 * 600.0 - 200.0 * 100.0);
    }

    #[test]
    fn so_http_https_e_about_blank_navegam() {
        assert!(navigable("https://accounts.google.com/").is_some());
        assert!(navigable("http://localhost:5173/").is_some());
        assert!(navigable("about:blank").is_some());
        for bad in ["javascript:alert(1)", "file:///C:/Windows/win.ini", "mailto:a@b.c", "about:config", "nada"] {
            assert!(navigable(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn popup_handler_permite_oauth_web_e_bloqueia_esquemas_externos() {
        assert!(popup_allowed("https://accounts.google.com/o/oauth2/"));
        assert!(popup_allowed("http://localhost:3000/callback"));
        assert!(popup_allowed("about:blank"));
        assert!(!popup_allowed("file:///Users/alguem/.ssh/id_rsa"));
        assert!(!popup_allowed("javascript:alert(1)"));
        assert!(!popup_allowed("mailto:login@example.com"));
    }

    #[test]
    fn piloto_so_no_topo_e_em_frames_da_mesma_origem() {
        let s = super::page_script("PILOTO()");
        assert!(s.starts_with("if (window.top === window ||"));
        assert!(s.contains("window.top.location.origin === location.origin"));
        assert!(s.contains("__agsCdpBridge") && s.contains("PILOTO()"));
        assert!(s.trim_end().ends_with('}'));
    }

    #[test]
    fn moldura_recebe_plataforma_e_rotulos_limpos() {
        let source = super::device_chrome_source("ios", Some(&json!({ "back": "Voltar", "share": "<img onerror=x>\"" })));
        assert!(source.contains("const platform = \"ios\""));
        assert!(source.contains("\"back\":\"Voltar\""));
        assert!(source.contains("\"share\":\"img onerror=x\""));
        assert!(!source.contains("__AGS_LABELS__"));
        assert!(super::device_chrome_source("../x", None).contains("const platform = \"android\""));
    }

    #[test]
    fn clique_na_miniatura_fica_na_pagina_e_nao_reabre_o_painel() {
        // Voltar ao painel é só pelo botão de expandir; a ponte não escuta cliques da página.
        assert!(!super::BRIDGE.contains("mini:open"));
        assert!(!super::BRIDGE.contains("mousedown"));
    }

    #[test]
    fn particao_persistente_separa_projetos_e_fica_sob_os_dados_da_ade() {
        let root = std::path::Path::new("/dados-isolados/portal-webview");
        let one = project_profile_path(root, "default", "/projetos/um");
        let same = project_profile_path(root, "default", "/projetos/um");
        let other = project_profile_path(root, "default", "/projetos/dois");
        assert_eq!(one, same);
        assert_ne!(one, other);
        assert!(one.starts_with(root.join("profiles/default/projects")));
        assert!(!one.to_string_lossy().contains("/projetos/um"));
        assert!(!one.to_string_lossy().contains("Google"));
    }

    #[test]
    fn migra_a_sessao_antiga_sem_apagar_a_origem_nem_caches() {
        let root = std::env::temp_dir().join(format!("ade-ags-browser-migration-{}-{}", std::process::id(), std::thread::current().name().unwrap_or("teste")));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("portal-webview");
        let target = super::project_profile_path(&old, "default", "/projeto-de-teste");
        std::fs::create_dir_all(old.join("Default")).unwrap();
        std::fs::create_dir_all(old.join("Cache")).unwrap();
        std::fs::write(old.join("Default/Cookies"), b"fixture-cookie-db").unwrap();
        std::fs::write(old.join("Cache/cache.bin"), b"cache").unwrap();
        assert!(migrate_legacy_partition(&old, "default", &target).unwrap());
        assert_eq!(std::fs::read(target.join("Default/Cookies")).unwrap(), b"fixture-cookie-db");
        assert!(!target.join("Cache").exists());
        assert_eq!(std::fs::read(old.join("Default/Cookies")).unwrap(), b"fixture-cookie-db");
        assert!(!migrate_legacy_partition(&old, "default", &target).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn perfil_anonimo_vai_para_pasta_temporaria_da_instancia() {
        let path = incognito_partition_path("view-123");
        assert!(path.starts_with(std::env::temp_dir().join("ade-ags-browser-incognito")));
        assert!(!path.starts_with(std::path::Path::new("/Applications")));
        assert!(path.ends_with("view-123"));
    }

    #[test]
    fn cdp_nao_publica_porta_nem_endereco_de_rede() {
        // O canal executa BrowserHost::execute_dev_tools_method dentro do processo CEF.
        // Não existe listener TCP nem DevTools remoto a partir desta interface.
        let source = include_str!("cef_native.rs");
        assert!(source.contains("execute_dev_tools_method"));
        assert!(!source.contains("TcpListener"));
        // A porta zerada nas `Settings` é provada no teste do módulo nativo.
        assert!(!source.contains("--remote-debugging-port"));
    }

    #[test]
    fn particao_chromium_e_filha_direta_da_raiz_por_perfil_e_projeto() {
        // O runtime Chrome do CEF só cria perfis filhos diretos do `root_cache_path`.
        let root = std::path::Path::new("/dados-isolados/app-data/portal-chromium");
        let one = chromium_partition_path(root, "default", "/projetos/um");
        let other_project = chromium_partition_path(root, "default", "/projetos/dois");
        let other_profile = chromium_partition_path(root, "trabalho", "/projetos/um");
        assert_eq!(one.parent(), Some(root));
        assert_eq!(one, chromium_partition_path(root, "default", "/projetos/um"));
        assert_ne!(one, other_project);
        assert_ne!(one, other_profile);
        assert!(one.file_name().unwrap().to_string_lossy().starts_with("default-"));
        let text = one.to_string_lossy();
        assert!(!text.contains("projetos"), "o caminho do projeto não vai para o disco: {text}");
        for real in ["Google/Chrome", "Chromium", "BraveSoftware", "Microsoft Edge", "Safari", "Firefox"] {
            assert!(!text.contains(real), "partição dentro de um perfil real: {text}");
        }
    }

    #[test]
    fn excluir_perfil_so_leva_as_particoes_dele() {
        let root = std::env::temp_dir().join(format!("ade-ags-chromium-partitions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mine = chromium_partition_path(&root, "work", "/projetos/um");
        let mine_too = chromium_partition_path(&root, "work", "/projetos/dois");
        let neighbor = chromium_partition_path(&root, "work-2", "/projetos/um");
        for dir in [&mine, &mine_too, &neighbor, &root.join("Default"), &root.join("work-notas")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let mut found = chromium_partitions_of(&root, "work");
        found.sort();
        let mut expected = vec![mine, mine_too];
        expected.sort();
        assert_eq!(found, expected);
        assert!(chromium_partitions_of(&root.join("nao-existe"), "work").is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn popup_adotado_herda_o_perfil_do_opener_e_sai_ao_fechar() {
        let profile = PortalProfile { id: "default".into(), path: "/dados/portal-chromium/default-abc".into() };
        lock(portals()).insert("opener-teste-popup".into(), profile.clone());
        assert!(adopt_popup("opener-teste-popup", "popup-teste").is_some());
        assert_eq!(lock(adopted()).get("popup-teste"), Some(&profile));
        assert!(adopt_popup("opener-que-nao-existe", "popup-orfao").is_none());
        assert!(!lock(adopted()).contains_key("popup-orfao"));
        forget_portal("popup-teste");
        forget_portal("opener-teste-popup");
        assert!(!lock(adopted()).contains_key("popup-teste"));
        assert!(!lock(portals()).contains_key("opener-teste-popup"));
    }

    #[test]
    fn px_fisicos_cobrem_o_retangulo_inteiro() {
        assert_eq!(physical(r(10.0, 20.0, 100.0, 50.0), 1.0), [10, 20, 100, 50]);
        // Em 125% um retângulo de 10,4 px não pode perder a última coluna.
        assert_eq!(physical(r(0.5, 0.5, 10.4, 10.4), 1.25), [0, 0, 14, 14]);
    }
}
