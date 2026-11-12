//! Chromium Embedded Framework no macOS. Este módulo é a única fronteira AppKit/CEF da ADE.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::{CString, OsStr},
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicI32, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use cef::{
    application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol},
    *,
};
use objc2::{
    define_class, extern_methods, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication, NSView};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize};
use serde_json::{json, Value as JsonValue};
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::{emit, on_binding};

const CEF_FRAMEWORK_BUNDLE: &str = "Chromium Embedded Framework.framework";
/// O helper base. O Chromium deriva os outros (`… (GPU)`, `… (Renderer)`, `… (Plugin)`, `… (Alerts)`)
/// trocando o sufixo deste caminho.
const HELPER_NAME: &str = "ADE AGS Helper";

/// O CEF deduziria `ade-ags Helper.app` pelo nome do executável; os helpers da ADE têm o nome do produto.
fn helper_executable(bundle: &Path) -> PathBuf {
    bundle.join("Contents/Frameworks").join(format!("{HELPER_NAME}.app")).join("Contents/MacOS").join(HELPER_NAME)
}
const CDP_TIMEOUT: Duration = Duration::from_secs(20);

static CEF_LOADED: OnceLock<Result<(), String>> = OnceLock::new();

/// Rastro de diagnóstico no stderr, só com `ADE_CEF_TRACE` definido.
macro_rules! cef_trace {
    ($($arg:tt)*) => {
        if std::env::var_os("ADE_CEF_TRACE").is_some() { eprintln!("[cef] {}", format!($($arg)*)); }
    };
}
static PUMP_GENERATION: AtomicU64 = AtomicU64::new(0);

fn is_helper_switch(argument: &OsStr) -> bool {
    let argument = argument.to_string_lossy();
    argument == "--type" || argument.starts_with("--type=")
}

fn bundled_framework_path(executable: &Path, helper: bool) -> Option<PathBuf> {
    let parent = executable.parent()?;
    Some(if helper {
        parent.join("../../../").join(CEF_FRAMEWORK_BUNDLE)
    } else {
        parent.join("../Frameworks").join(CEF_FRAMEWORK_BUNDLE)
    })
}

fn main_bundle_path(executable: &Path) -> Result<PathBuf, String> {
    let containing_bundle = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf);
    #[cfg(debug_assertions)]
    let bundle = containing_bundle.or_else(|| {
        executable.ancestors().find_map(|directory| {
            let candidate = directory.join("ADE AGS.app");
            candidate.is_dir().then_some(candidate)
        })
    });
    #[cfg(not(debug_assertions))]
    let bundle = containing_bundle;
    let bundle = bundle.ok_or("Não foi possível localizar o bundle principal da ADE AGS.")?;
    let bundle = bundle.canonicalize().map_err(|error| {
        format!("O bundle principal do CEF não existe em {}: {error}", bundle.display())
    })?;
    if !bundle.join("Contents/Info.plist").is_file() {
        return Err(format!("O bundle principal do CEF não contém Contents/Info.plist: {}.", bundle.display()));
    }
    Ok(bundle)
}

fn cef_framework_dir(executable: &Path, helper: bool) -> Result<PathBuf, String> {
    let bundled = if helper {
        bundled_framework_path(executable, true)
    } else {
        main_bundle_path(executable).ok().map(|bundle| bundle.join("Contents/Frameworks").join(CEF_FRAMEWORK_BUNDLE))
    }
    .filter(|path| path.is_dir());
    let fallback = cef::sys::get_cef_dir().map(|path| path.join(CEF_FRAMEWORK_BUNDLE));
    bundled.or(fallback).ok_or_else(|| "O pacote local do CEF não foi preparado.".to_string())
}

fn cef_resources_dir(executable: &Path, helper: bool) -> Result<PathBuf, String> {
    let framework = cef_framework_dir(executable, helper)?;
    let resources = if helper {
        framework.join("Resources").canonicalize().map_err(|error| {
            format!("Não foi possível localizar os recursos do CEF em {}: {error}", framework.display())
        })?
    } else {
        framework.join("Resources")
    };
    if !resources.join("icudtl.dat").is_file() {
        return Err(format!("O arquivo icudtl.dat não existe em {}.", resources.display()));
    }
    Ok(resources)
}

thread_local! {
    static CEF_INITIALIZED: Cell<bool> = const { Cell::new(false) };
    static PORTALS: RefCell<HashMap<String, Portal>> = RefCell::new(HashMap::new());
    /// Vistas hospedeiras de browsers fechando: saem da janela no `on_before_close`.
    static CLOSING: RefCell<HashMap<i32, Retained<ADEPortalHost>>> = RefCell::new(HashMap::new());
    static PROFILE_CONTEXTS: RefCell<HashMap<PathBuf, RequestContext>> = RefCell::new(HashMap::new());
}

type PendingCdp = Arc<Mutex<HashMap<i32, oneshot::Sender<Result<JsonValue, String>>>>>;

struct Portal {
    host_view: Retained<ADEPortalHost>,
    browser: Option<Browser>,
    _observer: Option<DevToolsMessageObserver>,
    _registration: Option<Registration>,
    pending: PendingCdp,
    /// Avisa `create` quando o CEF entrega o browser (a criação é assíncrona: o perfil do runtime
    /// Chrome só fica pronto depois).
    ready: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct CEFApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    /// A subclasse que o Chromium precisa antes de o Tauri criar o NSApplication.
    #[unsafe(super(NSApplication))]
    #[ivars = CEFApplicationIvars]
    struct ADECEFApplication;

    impl ADECEFApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &objc2_app_kit::NSEvent) {
            let was_sending = self.ivars().handling_send_event.get();
            if !was_sending.as_bool() {
                self.ivars().handling_send_event.set(Bool::YES);
            }
            // O mesmo ajuste do `TaoApp`, que esta classe substitui: o AppKit engole o keyUp de
            // Cmd+tecla; ele vai direto para a janela-chave.
            let command_key_up = event.r#type() == objc2_app_kit::NSEventType::KeyUp
                && event.modifierFlags().contains(objc2_app_kit::NSEventModifierFlags::Command);
            match self.keyWindow().filter(|_| command_key_up) {
                Some(window) => window.sendEvent(event),
                None => { let _: () = msg_send![super(self), sendEvent: event]; }
            }
            if !was_sending.as_bool() {
                self.ivars().handling_send_event.set(Bool::NO);
            }
        }
    }

    unsafe impl CrAppControlProtocol for ADECEFApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling_send_event(&self, value: Bool) {
            self.ivars().handling_send_event.set(value);
        }
    }

    unsafe impl CrAppProtocol for ADECEFApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for ADECEFApplication {}
);

impl ADECEFApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;
    }
}

#[derive(Default)]
struct PortalHostIvars {
    id: RefCell<String>,
    /// Partes à vista, `[esquerda, topo, direita, base]` em pontos com origem no topo do Portal.
    parts: RefCell<Vec<[f64; 4]>>,
    /// Miniatura: o clique reabre o painel em vez de ir para a página.
    mini: Cell<bool>,
}

define_class!(
    /// A vista que hospeda o browser. A máscara só recorta o desenho; o `hitTest` também respeita os
    /// buracos, para que menus e diálogos da ADE por cima da página continuem clicáveis.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PortalHostIvars]
    struct ADEPortalHost;

    impl ADEPortalHost {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let Some(superview) = (unsafe { self.superview() }) else { return ptr::null_mut() };
            let local = self.convertPoint_fromView(point, Some(&superview));
            let top = self.bounds().size.height - local.y;
            if !visible_at(&self.ivars().parts.borrow(), local.x, top) { return ptr::null_mut(); }
            if self.ivars().mini.get() { return self as *const Self as *mut NSView; }
            unsafe { msg_send![super(self), hitTest: point] }
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: *mut AnyObject) -> Bool { Bool::YES }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: *mut AnyObject) {
            if self.ivars().mini.get() {
                notify(&self.ivars().id.borrow(), "real-browser-mini-click", json!({}));
            } else {
                let _: () = unsafe { msg_send![super(self), mouseDown: event] };
            }
        }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: *mut AnyObject) {
            notify(&self.ivars().id.borrow(), "real-browser-mini-hover", json!({ "inside": true }));
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: *mut AnyObject) {
            notify(&self.ivars().id.borrow(), "real-browser-mini-hover", json!({ "inside": false }));
        }
    }
);

impl ADEPortalHost {
    fn new(mtm: MainThreadMarker, id: &str, frame: NSRect) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(PortalHostIvars { id: RefCell::new(id.to_string()), ..Default::default() });
        let this: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        this.setWantsLayer(true);
        // Entrada e saída do mouse para a pílula da miniatura; `InVisibleRect` acompanha o tamanho.
        const ENTERED_AND_EXITED: usize = 0x01;
        const ACTIVE_ALWAYS: usize = 0x80;
        const IN_VISIBLE_RECT: usize = 0x200;
        if let Some(class) = objc2::runtime::AnyClass::get(c"NSTrackingArea") {
            unsafe {
                let area: *mut AnyObject = msg_send![class, alloc];
                let area: *mut AnyObject = msg_send![area, initWithRect: NSRect::ZERO, options: ENTERED_AND_EXITED | ACTIVE_ALWAYS | IN_VISIBLE_RECT, owner: &*this, userInfo: ptr::null_mut::<AnyObject>()];
                let _: () = msg_send![&*this, addTrackingArea: area];
                let _: () = msg_send![area, release];
            }
        }
        this
    }
}

/// O ponto (origem no topo) cai numa parte à vista do Portal?
fn visible_at(parts: &[[f64; 4]], x: f64, top: f64) -> bool {
    parts.iter().any(|[left, upper, right, bottom]| x >= *left && x < *right && top >= *upper && top < *bottom)
}

/// Evento do Portal para a interface, a partir de uma vista AppKit (sem `AppHandle` à mão).
fn notify(id: &str, event: &str, mut payload: JsonValue) {
    let Some(app) = PORTAL_APPS.with(|apps| apps.borrow().get(id).cloned()) else { return };
    payload["id"] = JsonValue::String(id.to_string());
    emit(&app, event, payload);
}

fn load_cef(helper: bool) -> Result<(), String> {
    CEF_LOADED
        .get_or_init(|| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let framework = cef_framework_dir(&executable, helper)?;
            let path = framework.join("Chromium Embedded Framework");
            if helper || !cfg!(debug_assertions) {
                let loader = cef::library_loader::LibraryLoader::new(&executable, helper);
                if !loader.load() {
                    return Err(format!("Não foi possível carregar o CEF em {}.", path.display()));
                }
                // A biblioteca precisa permanecer carregada até CEF::shutdown.
                std::mem::forget(loader);
            } else {
                let path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|error| error.to_string())?;
                let loaded = unsafe { cef::sys::cef_load_library(path.as_ptr().cast()) };
                if loaded != 1 {
                    return Err(format!("Não foi possível carregar o framework CEF em {}.", path.to_string_lossy()));
                }
            }
            let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
            Ok(())
        })
        .clone()
}

/// Detecta e executa os helpers Chromium antes de iniciar Tauri. No processo principal, também
/// instala a classe AppKit exigida pelo CEF antes da primeira chamada a NSApplication.
pub fn cef_helper_entry() -> Option<i32> {
    // A API de linha de comando do CEF usa funções da biblioteca dinâmica; identifique o helper
    // pelos argumentos do Chromium antes de chamar qualquer wrapper que dependa dela.
    let is_helper = std::env::args_os().skip(1).any(|argument| is_helper_switch(&argument));
    let args = cef::args::Args::new();
    let sandbox = if is_helper {
        // No macOS, o CEF exige que o sandbox seja inicializado antes de carregar o framework.
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        Some(sandbox)
    } else {
        None
    };
    if let Err(error) = load_cef(is_helper) {
        eprintln!("[ade-ags] {error}");
        return if is_helper { Some(1) } else { None };
    }
    if is_helper {
        let result = cef::execute_process(Some(args.as_main_args()), None, ptr::null_mut());
        drop(sandbox);
        Some(result.max(0))
    } else {
        let _ = ADECEFApplication::shared_application();
        None
    }
}

/// O maior intervalo entre duas chamadas a `CefDoMessageLoopWork`, como o `cefclient` (30 Hz).
const MAX_PUMP_DELAY_MS: i64 = 1000 / 30;

thread_local! {
    static PUMPING: Cell<bool> = const { Cell::new(false) };
}

/// Agenda a bomba do CEF na fila principal do GCD. Ela roda nos *common modes* do run loop, então
/// continua andando em menus, redimensionamento e janelas modais, onde a fila de eventos do tao para.
/// Um pedido novo invalida os anteriores pela geração.
fn schedule_pump(delay_ms: i64) {
    let generation = PUMP_GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let delay = delay_ms.clamp(0, MAX_PUMP_DELAY_MS);
    let work = move || {
        if PUMP_GENERATION.load(Ordering::SeqCst) == generation { pump(); }
    };
    let main = dispatch2::DispatchQueue::main();
    if delay == 0 {
        main.exec_async(work);
    } else {
        let _ = main.after(dispatch2::DispatchTime::NOW.time(delay * 1_000_000), work);
    }
}

fn pump() {
    if !CEF_INITIALIZED.with(Cell::get) || PUMPING.with(|pumping| pumping.replace(true)) { return; }
    cef::do_message_loop_work();
    PUMPING.with(|pumping| pumping.set(false));
    // Sem pedido novo durante o trabalho, garante a próxima volta no teto de espera.
    let generation = PUMP_GENERATION.load(Ordering::SeqCst);
    let _ = dispatch2::DispatchQueue::main().after(dispatch2::DispatchTime::NOW.time(MAX_PUMP_DELAY_MS * 1_000_000), move || {
        if PUMP_GENERATION.load(Ordering::SeqCst) == generation { pump(); }
    });
}

wrap_browser_process_handler! {
    struct ADEBrowserProcessHandler;
    impl BrowserProcessHandler {
        // Chamado de qualquer thread do CEF.
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            schedule_pump(delay_ms);
        }
    }
}

wrap_app! {
    struct ADEBrowserApp;
    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            // Só o processo principal: os helpers herdam as chaves dele.
            if process_type.is_some_and(|kind| !kind.to_string().is_empty()) { return; }
            let Some(command_line) = command_line else { return };
            for switch in browser_switches() {
                command_line.append_switch(Some(&CefString::from(switch)));
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(ADEBrowserProcessHandler::new())
        }
    }
}

/// Chaves do Chromium da ADE. Em debug, cada build muda a assinatura ad-hoc e o macOS pediria acesso
/// ao Keychain a cada execução; ali a chave dos cookies fica num Keychain simulado. O build assinado
/// guarda a chave no Keychain do sistema, como o Chrome.
fn browser_switches() -> Vec<&'static str> {
    let mut switches = vec!["disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"];
    if cfg!(debug_assertions) { switches.push("use-mock-keychain"); }
    switches
}

struct CefPaths {
    bundle: PathBuf,
    framework: PathBuf,
    resources: PathBuf,
    helper: PathBuf,
    root_cache: PathBuf,
    log_file: Option<PathBuf>,
}

/// As configurações do CEF da ADE. Sem `remote_debugging_port`: o CDP só passa pelo objeto do
/// motor, chamado pelo IPC local do app (socket com token); nenhuma porta DevTools é aberta.
fn cef_settings(paths: &CefPaths) -> Settings {
    let text = |path: &Path| CefString::from(path.to_string_lossy().as_ref());
    Settings {
        browser_subprocess_path: text(&paths.helper),
        framework_dir_path: text(&paths.framework),
        main_bundle_path: text(&paths.bundle),
        root_cache_path: text(&paths.root_cache),
        resources_dir_path: text(&paths.resources),
        log_severity: if paths.log_file.is_some() { LogSeverity::VERBOSE } else { LogSeverity::DEFAULT },
        log_file: paths.log_file.as_deref().map(text).unwrap_or_default(),
        external_message_pump: 1,
        remote_debugging_port: 0,
        no_sandbox: 0,
        persist_session_cookies: 1,
        ..Default::default()
    }
}

fn initialize_cef(app: Option<AppHandle>) -> Result<(), String> {
    CEF_INITIALIZED.with(|initialized| {
        if initialized.get() {
            return Ok(());
        }
        let args = cef::args::Args::new();
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let bundle = main_bundle_path(&executable)?;
        let framework = cef_framework_dir(&executable, false)?;
        let resources = cef_resources_dir(&executable, false)?;
        let app_data = match app.as_ref() {
            Some(app) => crate::util::datadir::app_data_dir(app)?,
            None => crate::util::datadir::ags_home().ok_or("Não foi possível localizar a pasta de dados da ADE.")?.join("app-data"),
        };
        let root_cache = app_data.join(super::CHROMIUM_ROOT);
        std::fs::create_dir_all(&root_cache).map_err(|error| error.to_string())?;
        let mut cef_app = ADEBrowserApp::new();
        let log_file = std::env::var_os("ADE_CEF_LOG_FILE").map(PathBuf::from);
        let helper = helper_executable(&bundle);
        if !helper.is_file() {
            return Err(format!("O helper do Chromium não existe em {}.", helper.display()));
        }
        let settings = cef_settings(&CefPaths { bundle, framework, resources, helper, root_cache, log_file });
        if cef::initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), ptr::null_mut()) != 1 {
            return Err("O CEF não conseguiu iniciar no processo principal.".into());
        }
        initialized.set(true);
        schedule_pump(0);
        Ok(())
    })
}

/// Inicializa e encerra o CEF sem criar janela, para sondar o bundle macOS durante o desenvolvimento.
#[cfg(debug_assertions)]
pub fn initialize_probe() -> Result<(), String> {
    let _ = ADECEFApplication::shared_application();
    load_cef(false)?;
    initialize_cef(None)?;
    shutdown();
    Ok(())
}

wrap_dev_tools_message_observer! {
    struct ADEDevToolsObserver { id: String, app: AppHandle, pending: PendingCdp }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: i32, success: i32, result: Option<&[u8]>) {
            if let Some(sender) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&message_id) {
                let response = if success != 0 {
                    result.and_then(|bytes| serde_json::from_slice::<JsonValue>(bytes).ok()).ok_or_else(|| "A resposta CDP do CEF não era JSON válido.".to_string())
                } else {
                    Err("O CEF recusou o comando CDP.".into())
                };
                let _ = sender.send(response);
            }
        }

        fn on_dev_tools_event(&self, _browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            if method.map(ToString::to_string).as_deref() != Some("Runtime.bindingCalled") { return; }
            let Some(params) = params.and_then(|bytes| serde_json::from_slice::<JsonValue>(bytes).ok()) else { return; };
            if params["name"].as_str() == Some("__agsCdpBridge") && let Some(payload) = params["payload"].as_str() {
                cef_trace!("binding {} {}", self.id, payload.chars().take(80).collect::<String>());
                on_binding(&self.app, &self.id, payload);
            }
        }
    }
}

wrap_life_span_handler! {
    struct ADELifeSpanHandler { id: String }
    impl LifeSpanHandler {
        /// Pop-ups (OAuth, `window.open`, `target=_blank`) viram uma aba nova da ADE. O CEF cria o
        /// browser como vista filha de um host oculto; a aba adota esse id e o `opener` continua vivo.
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            window_info: Option<&mut WindowInfo>,
            client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            let Some(url) = target_url.map(ToString::to_string) else { return 1 };
            cef_trace!("on_before_popup {} -> {url}", self.id);
            match prepare_popup(&self.id, &url) {
                Some((popup, host, app)) => {
                    if let Some(window_info) = window_info {
                        let bounds = host.bounds();
                        *window_info = window_info.clone().set_as_child(
                            Retained::as_ptr(&host) as *mut AnyObject as *mut std::ffi::c_void,
                            &Rect { x: 0, y: 0, width: bounds.size.width.max(1.0) as i32, height: bounds.size.height.max(1.0) as i32 },
                        );
                    }
                    if let Some(client) = client { *client = Some(ADEClient::new(popup.clone(), app.clone())); }
                    emit(&app, "real-browser-popup", json!({ "id": self.id, "popup": popup, "url": url }));
                    0
                }
                None => 1,
            }
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            cef_trace!("on_after_created {}", self.id);
            OPEN_BROWSERS.fetch_add(1, Ordering::SeqCst);
            let Some(browser) = browser else { return };
            PORTALS.with(|portals| {
                if let Some(portal) = portals.borrow_mut().get_mut(&self.id) {
                    portal.browser = Some(browser.clone());
                    if let Some(ready) = portal.ready.take() { let _ = ready.send(()); }
                    if let Some(host) = browser.host() {
                        let mut observer = ADEDevToolsObserver::new(self.id.clone(), app_handle_for_portal(&self.id), portal.pending.clone());
                        let registration = host.add_dev_tools_message_observer(Some(&mut observer));
                        portal._observer = Some(observer);
                        portal._registration = registration;
                    }
                }
            });
        }

        /// Nunca deixa o CEF mandar `performClose:` à janela de topo: para uma vista filha, ela é a
        /// janela da ADE. A ADE desmonta a vista do browser e o CEF conclui o fechamento.
        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            let Some(browser) = browser else { return 1 };
            cef_trace!("do_close {}", self.id);
            if let Some(host) = browser.host() {
                let view = host.window_handle() as *mut AnyObject;
                if !view.is_null() {
                    let view: &NSView = unsafe { &*view.cast() };
                    view.removeFromSuperview();
                }
            }
            1
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            cef_trace!("on_before_close {}", self.id);
            let _ = OPEN_BROWSERS.try_update(Ordering::SeqCst, Ordering::SeqCst, |open| open.checked_sub(1));
            let Some(browser) = browser else { return };
            let identifier = browser.identifier();
            if let Some(view) = CLOSING.with(|closing| closing.borrow_mut().remove(&identifier)) {
                view.removeFromSuperview();
            }
            // Um Portal reaberto com o mesmo id já tem outro browser: só sai o que fechou. Ainda
            // registrado = a própria página fechou (`window.close()` no fim de um OAuth): a aba fecha.
            let closed_by_page = PORTALS.with(|portals| {
                let mut portals = portals.borrow_mut();
                if portals.get(&self.id).and_then(|portal| portal.browser.as_ref()).is_some_and(|open| open.identifier() == identifier) {
                    portals.remove(&self.id).map(|portal| portal.host_view.removeFromSuperview()).is_some()
                } else {
                    false
                }
            });
            if closed_by_page {
                notify(&self.id, "real-browser-closed", json!({}));
                PORTAL_APPS.with(|apps| { apps.borrow_mut().remove(&self.id); });
                super::forget_portal(&self.id);
            }
        }
    }
}

/// Prepara o host oculto e o registro de um pop-up aberto por `opener`. `None` recusa o pop-up.
fn prepare_popup(opener: &str, url: &str) -> Option<(String, Retained<ADEPortalHost>, AppHandle)> {
    let mtm = MainThreadMarker::new()?;
    if !super::popup_allowed(url) { return None; }
    let app = PORTAL_APPS.with(|apps| apps.borrow().get(opener).cloned())?;
    let (parent, frame) = PORTALS.with(|portals| {
        let portals = portals.borrow();
        let host = &portals.get(opener)?.host_view;
        Some((unsafe { host.superview() }?, host.frame()))
    })?;
    let popup = uuid::Uuid::new_v4().to_string();
    super::adopt_popup(opener, &popup)?;
    let host = ADEPortalHost::new(mtm, &popup, frame);
    // Escondido até a aba nova mandar o primeiro `place`.
    host.setHidden(true);
    parent.addSubview(&host);
    PORTAL_APPS.with(|apps| { apps.borrow_mut().insert(popup.clone(), app.clone()); });
    PORTALS.with(|portals| {
        portals.borrow_mut().insert(popup.clone(), Portal {
            host_view: host.clone(), browser: None, _observer: None, _registration: None,
            pending: Arc::new(Mutex::new(HashMap::new())), ready: None,
        });
    });
    Some((popup, host, app))
}

fn ask_permission(origin: &str, resources: &str) -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Informational);
    alert.setMessageText(ns_string!("Permitir acesso nesta página?"));
    let details = format!("{origin} solicita acesso a {resources}.");
    let details = objc2_foundation::NSString::from_str(&details);
    alert.setInformativeText(&details);
    alert.addButtonWithTitle(ns_string!("Permitir"));
    alert.addButtonWithTitle(ns_string!("Não permitir"));
    alert.runModal() == NSAlertFirstButtonReturn
}

wrap_permission_handler! {
    struct ADEPermissionHandler;
    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let camera = MediaAccessPermissionTypes::DEVICE_VIDEO_CAPTURE.get_raw();
            let microphone = MediaAccessPermissionTypes::DEVICE_AUDIO_CAPTURE.get_raw();
            let has_camera = requested_permissions & camera != 0;
            let has_microphone = requested_permissions & microphone != 0;
            if !has_camera && !has_microphone { return 0; }
            let resources = match (has_camera, has_microphone) {
                (true, true) => "a câmera e o microfone",
                (true, false) => "a câmera",
                (false, true) => "o microfone",
                (false, false) => unreachable!(),
            };
            let origin = requesting_origin.map(ToString::to_string).unwrap_or_else(|| "esta página".into());
            let allowed = if ask_permission(&origin, resources) { requested_permissions } else { MediaAccessPermissionTypes::NONE.get_raw() };
            if let Some(callback) = callback { callback.cont(allowed); }
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            let geo = PermissionRequestTypes::GEOLOCATION.get_raw();
            if requested_permissions & geo == 0 { return 0; }
            let origin = requesting_origin.map(ToString::to_string).unwrap_or_else(|| "esta página".into());
            let result = if ask_permission(&origin, "sua localização") { PermissionRequestResult::ACCEPT } else { PermissionRequestResult::DENY };
            if let Some(callback) = callback { callback.cont(result); }
            1
        }
    }
}

wrap_download_handler! {
    struct ADEDownloadHandler;
    impl DownloadHandler {
        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            _suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            if let Some(callback) = callback { callback.cont(None, 1); }
            1
        }
    }
}

thread_local! {
    static PORTAL_APPS: RefCell<HashMap<String, AppHandle>> = RefCell::new(HashMap::new());
}

fn app_handle_for_portal(id: &str) -> AppHandle {
    PORTAL_APPS.with(|apps| apps.borrow().get(id).cloned()).expect("o Portal deve guardar o AppHandle antes de criar o browser")
}

wrap_display_handler! {
    struct ADEDisplayHandler { id: String, app: AppHandle }
    impl DisplayHandler {
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main() != 0) && let Some(url) = url {
                emit(&self.app, "real-browser-url", json!({ "id": self.id, "url": url.to_string() }));
            }
        }
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(title) = title { emit(&self.app, "real-browser-title", json!({ "id": self.id, "title": title.to_string() })); }
        }
    }
}

wrap_load_handler! {
    struct ADELoadHandler { id: String, app: AppHandle }
    impl LoadHandler {
        fn on_loading_state_change(&self, browser: Option<&mut Browser>, loading: i32, back: i32, forward: i32) {
            emit(&self.app, "real-browser-load", json!({ "id": self.id, "loading": loading != 0 }));
            emit(&self.app, "real-browser-history", json!({ "id": self.id, "back": back != 0, "forward": forward != 0 }));
            let _ = browser;
        }
    }
}

wrap_client! {
    struct ADEClient { id: String, app: AppHandle }
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(ADELifeSpanHandler::new(self.id.clone())) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(ADEDisplayHandler::new(self.id.clone(), self.app.clone())) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(ADELoadHandler::new(self.id.clone(), self.app.clone())) }
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(ADEPermissionHandler::new()) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(ADEDownloadHandler::new()) }
    }
}

fn request_context(profile: &PathBuf) -> Result<RequestContext, String> {
    PROFILE_CONTEXTS.with(|contexts| {
        if let Some(context) = contexts.borrow().get(profile) { return Ok(context.clone()); }
        let mut settings = RequestContextSettings { persist_session_cookies: 1, ..Default::default() };
        if !profile.as_os_str().is_empty() {
            std::fs::create_dir_all(profile).map_err(|error| error.to_string())?;
            settings.cache_path = CefString::from(profile.to_string_lossy().as_ref());
        }
        let context = request_context_create_context(Some(&settings), None).ok_or("Não foi possível criar a partição persistente do Chromium.")?;
        if !profile.as_os_str().is_empty() {
            contexts.borrow_mut().insert(profile.clone(), context.clone());
        }
        Ok(context)
    })
}

fn view_frame(rect: [i32; 4]) -> NSRect {
    NSRect::new(NSPoint::new(rect[0] as f64, rect[1] as f64), NSSize::new(rect[2].max(1) as f64, rect[3].max(1) as f64))
}

/// A DOM usa origem no topo; o frame AppKit respeita a orientação da vista que contém o Portal.
fn frame_in_parent(parent: &NSView, rect: [i32; 4]) -> NSRect {
    let bounds = parent.bounds();
    let y = if parent.isFlipped() {
        bounds.origin.y + rect[1] as f64
    } else {
        bounds.origin.y + bounds.size.height - rect[1] as f64 - rect[3] as f64
    };
    NSRect::new(
        NSPoint::new(bounds.origin.x + rect[0] as f64, y),
        NSSize::new(rect[2].max(1) as f64, rect[3].max(1) as f64),
    )
}

pub async fn create(app: &AppHandle, parent: isize, id: &str, profile: PathBuf, _args: String, rect: [i32; 4]) -> Result<(), String> {
    let app = app.clone();
    let main_thread_app = app.clone();
    let id = id.to_string();
    let (ready, created) = oneshot::channel();
    on_main(&app, move || create_on_main(&main_thread_app, parent as *mut AnyObject, &id, profile, rect, ready)).await?;
    tokio::time::timeout(BROWSER_READY_TIMEOUT, created)
        .await
        .map_err(|_| "O Chromium não abriu a página a tempo.".to_string())?
        .map_err(|_| "O Chromium fechou a página antes de abri-la.".to_string())
}

const BROWSER_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Espera o browser de um Portal já registrado (um pop-up adotado) ficar pronto.
pub async fn wait_ready(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = id.to_string();
    let created = on_main(app, move || {
        let (ready, created) = oneshot::channel();
        PORTALS.with(|portals| {
            let mut portals = portals.borrow_mut();
            let portal = portals.get_mut(&id).ok_or("O pop-up já foi fechado.")?;
            if portal.browser.is_some() { let _ = ready.send(()); } else { portal.ready = Some(ready); }
            Ok::<_, String>(())
        })?;
        Ok(created)
    }).await?;
    tokio::time::timeout(BROWSER_READY_TIMEOUT, created)
        .await
        .map_err(|_| "O Chromium não abriu o pop-up a tempo.".to_string())?
        .map_err(|_| "O pop-up fechou antes de abrir.".to_string())
}

fn create_on_main(app: &AppHandle, parent: *mut AnyObject, id: &str, profile: PathBuf, rect: [i32; 4], ready: oneshot::Sender<()>) -> Result<(), String> {
    let _mtm = MainThreadMarker::new().ok_or("A vista CEF precisa ser criada na thread principal do macOS.")?;
    load_cef(false)?;
    initialize_cef(Some(app.clone()))?;
    if PORTALS.with(|portals| portals.borrow().contains_key(id)) {
        let _ = ready.send(());
        return Ok(());
    }
    let context = request_context(&profile)?;
    let root: &NSView = unsafe { &*parent.cast() };
    let host = ADEPortalHost::new(_mtm, id, frame_in_parent(root, rect));
    root.addSubview(&host);
    let pending = Arc::new(Mutex::new(HashMap::new()));
    PORTAL_APPS.with(|apps| { apps.borrow_mut().insert(id.to_string(), app.clone()); });
    PORTALS.with(|portals| {
        portals.borrow_mut().insert(id.to_string(), Portal { host_view: host.clone(), browser: None, _observer: None, _registration: None, pending: pending.clone(), ready: Some(ready) });
    });

    let mut client = ADEClient::new(id.to_string(), app.clone());
    let child = WindowInfo::default().set_as_child(
        Retained::as_ptr(&host) as *mut AnyObject as *mut std::ffi::c_void,
        &Rect { x: 0, y: 0, width: rect[2].max(1), height: rect[3].max(1) },
    );
    let url = CefString::from("about:blank");
    let settings = BrowserSettings::default();
    let mut context = context;
    // Assíncrono: o `create_browser_sync` falha enquanto o perfil persistente ainda inicializa.
    let created = browser_host_create_browser(Some(&child), Some(&mut client), Some(&url), Some(&settings), None, Some(&mut context));
    cef_trace!("create_browser {id} -> {created}");
    if created != 1 {
        PORTALS.with(|portals| { portals.borrow_mut().remove(id); });
        host.removeFromSuperview();
        return Err("O CEF não criou uma vista filha para o navegador.".into());
    }
    Ok(())
}

async fn on_main<T: Send + 'static>(app: &AppHandle, task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (done, wait) = oneshot::channel();
    app.run_on_main_thread(move || { let _ = done.send(task()); }).map_err(|error| error.to_string())?;
    wait.await.map_err(|error| error.to_string())?
}

pub async fn cdp(app: &AppHandle, id: &str, method: &str, params: JsonValue) -> Result<JsonValue, String> {
    let (sender, receiver) = oneshot::channel();
    let app = app.clone();
    let id = id.to_string();
    let method = method.to_string();
    on_main(&app, move || {
        let (browser, mailbox) = PORTALS.with(|portals| {
            let portals = portals.borrow();
            let portal = portals.get(&id).ok_or("O navegador ainda não abriu.")?;
            Ok::<_, String>((portal.browser.clone().ok_or("O Chromium ainda está preparando a página.")?, portal.pending.clone()))
        })?;
        let host = browser.host().ok_or("A página Chromium já foi fechada.")?;
        let message_id = NEXT_CDP_ID.fetch_add(1, Ordering::Relaxed).max(1);
        mailbox.lock().unwrap_or_else(|e| e.into_inner()).insert(message_id, sender);
        let serialized = serde_json::to_vec(&params).map_err(|error| error.to_string())?;
        let mut cdp_params = parse_json_buffer(Some(&serialized), JsonParserOptions::RFC)
            .and_then(|value| value.dictionary())
            .ok_or("Os parâmetros CDP precisam ser um objeto JSON.")?;
        let cdp_method = CefString::from(method.as_str());
        if host.execute_dev_tools_method(message_id, Some(&cdp_method), Some(&mut cdp_params)) == 0 {
            mailbox.lock().unwrap_or_else(|e| e.into_inner()).remove(&message_id);
            return Err("O CEF não aceitou o comando CDP.".into());
        }
        Ok(())
    }).await?;
    tokio::time::timeout(CDP_TIMEOUT, receiver).await.map_err(|_| "O CEF não respondeu ao comando CDP a tempo.".to_string())?
        .map_err(|error| error.to_string())?
}

static NEXT_CDP_ID: AtomicI32 = AtomicI32::new(1);

pub fn place(app: &AppHandle, id: &str, rect: [i32; 4], zoom: f64, parts: Vec<[i32; 4]>, corner_radius: f64, click_to_expand: bool) {
    let app = app.clone();
    let id = id.to_string();
    let _ = app.run_on_main_thread(move || {
        let _ = MainThreadMarker::new();
        PORTALS.with(|portals| {
            if let Some(portal) = portals.borrow_mut().get_mut(&id) {
                let parent = unsafe { portal.host_view.superview() };
                portal.host_view.setFrame(parent.as_deref().map(|parent| frame_in_parent(parent, rect)).unwrap_or_else(|| view_frame(rect)));
                apply_rect_mask(&portal.host_view, rect[2], rect[3], &parts);
                *portal.host_view.ivars().parts.borrow_mut() = parts.iter().map(|[l, t, r, b]| [*l as f64, *t as f64, *r as f64, *b as f64]).collect();
                portal.host_view.ivars().mini.set(click_to_expand);
                let layer: *mut AnyObject = unsafe { msg_send![&*portal.host_view, layer] };
                unsafe {
                    let _: () = msg_send![layer, setCornerRadius: corner_radius.max(0.0)];
                    let _: () = msg_send![layer, setMasksToBounds: Bool::YES];
                }
                if let Some(host) = portal.browser.as_ref().and_then(Browser::host) {
                    host.set_zoom_level(if zoom > 0.0 { zoom.ln() / 1.2_f64.ln() } else { 0.0 });
                    host.was_resized();
                }
            }
        });
    });
}

fn apply_rect_mask(view: &NSView, width: i32, height: i32, parts: &[[i32; 4]]) {
    if parts.is_empty() {
        view.setHidden(true);
        return;
    }
    view.setHidden(false);
    let path = unsafe { CGPathCreateMutable() };
    if path.is_null() { return; }
    for [left, top, right, bottom] in parts {
        unsafe { CGPathAddRect(path, ptr::null(), cg_rect(*left as f64, *top as f64, (right-left).max(0) as f64, (bottom-top).max(0) as f64)); }
    }
    let class = objc2::runtime::AnyClass::get(c"CAShapeLayer").expect("CAShapeLayer disponível no macOS");
    let mask: *mut AnyObject = unsafe { msg_send![class, layer] };
    let layer: *mut AnyObject = unsafe { msg_send![view, layer] };
    unsafe {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width.max(1) as f64, height.max(1) as f64));
        let _: () = msg_send![mask, setFrame: frame];
        let _: () = msg_send![mask, setGeometryFlipped: Bool::YES];
        let _: () = msg_send![mask, setPath: path];
        let _: () = msg_send![layer, setMask: mask];
        CGPathRelease(path);
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect { origin: CGPoint, size: CGSize }
#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint { x: f64, y: f64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize { width: f64, height: f64 }
fn cg_rect(x: f64, y: f64, width: f64, height: f64) -> CGRect { CGRect { origin: CGPoint { x, y }, size: CGSize { width, height } } }

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPathCreateMutable() -> *mut std::ffi::c_void;
    fn CGPathAddRect(path: *mut std::ffi::c_void, transform: *const std::ffi::c_void, rect: CGRect);
    fn CGPathRelease(path: *mut std::ffi::c_void);
}

pub async fn navigate(app: &AppHandle, id: &str, url: String) -> Result<(), String> {
    let id = id.to_string();
    on_main(app, move || {
        let frame = PORTALS.with(|portals| portals.borrow().get(&id).and_then(|portal| portal.browser.as_ref()).and_then(Browser::main_frame))
            .ok_or("A página principal do Chromium não está pronta.")?;
        let url = CefString::from(url.as_str());
        frame.load_url(Some(&url));
        Ok(())
    }).await
}

pub async fn history(app: &AppHandle, id: &str, delta: i32) -> Result<(), String> {
    let id = id.to_string();
    on_main(app, move || {
        let browser = PORTALS.with(|portals| portals.borrow().get(&id).and_then(|portal| portal.browser.clone()))
            .ok_or("O navegador ainda não abriu.")?;
        match delta { -1 if browser.can_go_back() != 0 => browser.go_back(), 1 if browser.can_go_forward() != 0 => browser.go_forward(), 0 => browser.reload(), _ => {} }
        Ok(())
    }).await
}

pub async fn focus(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = id.to_string();
    on_main(app, move || {
        let browser = PORTALS.with(|portals| portals.borrow().get(&id).and_then(|portal| portal.browser.clone()))
            .ok_or("O navegador ainda não abriu.")?;
        browser.host().ok_or("A página Chromium já foi fechada.")?.set_focus(1);
        Ok(())
    }).await
}

pub fn close(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    let _ = app.run_on_main_thread(move || {
        let portal = PORTALS.with(|portals| portals.borrow_mut().remove(&id));
        if let Some(portal) = portal { begin_close(portal); }
        PORTAL_APPS.with(|apps| { apps.borrow_mut().remove(&id); });
    });
}

/// Esconde a vista e pede o fechamento; a vista sai da janela quando o CEF confirma.
fn begin_close(portal: Portal) {
    portal.host_view.setHidden(true);
    match portal.browser.as_ref().and_then(|browser| browser.host().map(|host| (browser.identifier(), host))) {
        Some((identifier, host)) => {
            CLOSING.with(|closing| { closing.borrow_mut().insert(identifier, portal.host_view.clone()); });
            host.close_browser(1);
        }
        None => portal.host_view.removeFromSuperview(),
    }
}

pub async fn release_profile(app: &AppHandle, profile: &std::path::Path) -> Result<(), String> {
    let profile = profile.to_path_buf();
    on_main(app, move || {
        let context = PROFILE_CONTEXTS.with(|contexts| contexts.borrow_mut().remove(&profile));
        if let Some(context) = context {
            context.close_all_connections(None);
        }
        Ok(())
    }).await
}

/// O piloto em todo documento novo. Sem `Page.enable` o Chromium aceita o script e nunca o roda: o
/// agente de Page só instrumenta a criação de documentos depois de ligado.
pub async fn add_script(app: &AppHandle, id: &str, script: String) -> Result<(), String> {
    cdp(app, id, "Page.enable", json!({})).await?;
    cdp(app, id, "Page.addScriptToEvaluateOnNewDocument", json!({ "source": script })).await.map(|_| ())
}

/// Fecha os browsers, deixa o CEF terminar o fechamento (cookies gravados) e só então chama
/// `CefShutdown`. Com bomba externa, o fechamento só anda com `CefDoMessageLoopWork`.
pub fn shutdown() {
    if !CEF_INITIALIZED.with(Cell::get) { return; }
    let portals = PORTALS.with(|portals| std::mem::take(&mut *portals.borrow_mut()));
    // Os autoreleases do fechamento seguram a vista do CEF; o pool próprio deixa o `dealloc` acontecer
    // (é ele que destrói o browser filho) sem voltar ao run loop.
    objc2::rc::autoreleasepool(|_| for (_, portal) in portals { begin_close(portal); });
    for round in 0..SHUTDOWN_PUMP_ROUNDS {
        if OPEN_BROWSERS.load(Ordering::SeqCst) == 0 { cef_trace!("shutdown: fechados em {round} voltas"); break; }
        // A vista do browser só é liberada quando o pool de autorelease esvazia.
        objc2::rc::autoreleasepool(|_| cef::do_message_loop_work());
        std::thread::sleep(Duration::from_millis(10));
    }
    for (_, view) in CLOSING.with(|closing| std::mem::take(&mut *closing.borrow_mut())) {
        view.removeFromSuperview();
    }
    PORTAL_APPS.with(|apps| apps.borrow_mut().clear());
    cef_trace!("shutdown: browsers abertos {}", OPEN_BROWSERS.load(Ordering::SeqCst));
    PROFILE_CONTEXTS.with(|contexts| contexts.borrow_mut().clear());
    PUMP_GENERATION.fetch_add(1, Ordering::SeqCst);
    CEF_INITIALIZED.with(|initialized| initialized.set(false));
    cef::shutdown();
    cef_trace!("shutdown: CEF encerrado");
}

/// Até ~3 s para os browsers fecharem ao sair do app.
const SHUTDOWN_PUMP_ROUNDS: usize = 300;
static OPEN_BROWSERS: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
mod tests {
    use super::{browser_switches, cef_resources_dir, cef_settings, helper_executable, is_helper_switch, main_bundle_path, visible_at, CefPaths, CEF_FRAMEWORK_BUNDLE};
    use std::{ffi::OsStr, fs, path::{Path, PathBuf}};

    #[test]
    fn configuracao_sem_porta_devtools_com_sandbox_e_helper_da_ade() {
        // `CefString` usa funções da libcef: o framework precisa estar carregado.
        super::load_cef(false).expect("framework CEF do pacote do Cargo");
        let bundle = PathBuf::from("/Applications/ADE AGS.app");
        let settings = cef_settings(&CefPaths {
            helper: helper_executable(&bundle),
            framework: bundle.join("Contents/Frameworks").join(CEF_FRAMEWORK_BUNDLE),
            resources: bundle.join("Contents/Frameworks").join(CEF_FRAMEWORK_BUNDLE).join("Resources"),
            root_cache: PathBuf::from("/dados/app-data/portal-chromium"),
            bundle,
            log_file: None,
        });
        // CDP só pelo objeto do motor: nenhuma porta DevTools, nem em 127.0.0.1.
        assert_eq!(settings.remote_debugging_port, 0);
        assert_eq!(settings.no_sandbox, 0);
        assert_eq!(settings.external_message_pump, 1);
        assert_eq!(settings.persist_session_cookies, 1);
        assert_eq!(
            settings.browser_subprocess_path.to_string(),
            "/Applications/ADE AGS.app/Contents/Frameworks/ADE AGS Helper.app/Contents/MacOS/ADE AGS Helper"
        );
        assert_eq!(settings.root_cache_path.to_string(), "/dados/app-data/portal-chromium");
        assert!(settings.log_file.to_string().is_empty());
    }

    #[test]
    fn chaves_do_chromium_nao_marcam_automacao_e_debug_nao_toca_o_keychain() {
        let switches = browser_switches();
        assert!(switches.contains(&"disable-backgrounding-occluded-windows"));
        // Nada que mude o UA ou denuncie automação (`navigator.webdriver`).
        assert!(!switches.iter().any(|switch| switch.contains("user-agent") || switch.contains("automation") || switch.contains("remote-debugging")));
        // Os testes rodam em debug: lá a chave dos cookies fica num Keychain simulado.
        assert!(switches.contains(&"use-mock-keychain"));
    }

    #[test]
    fn buracos_da_interface_nao_recebem_clique_da_pagina() {
        // A página mostra duas faixas; o meio é um menu da ADE por cima.
        let parts = [[0.0, 0.0, 300.0, 100.0], [0.0, 160.0, 300.0, 400.0]];
        assert!(visible_at(&parts, 10.0, 10.0));
        assert!(visible_at(&parts, 299.0, 399.0));
        assert!(!visible_at(&parts, 150.0, 130.0), "o clique no menu vai para a interface");
        assert!(!visible_at(&parts, 300.0, 10.0), "a borda direita é exclusiva");
        assert!(!visible_at(&[], 10.0, 10.0), "sem parte à vista nada é da página");
    }

    fn isolated_root() -> PathBuf {
        std::env::temp_dir().join(format!("ade-cef-path-test-{}", uuid::Uuid::new_v4()))
    }

    fn add_framework(root: &Path, relative: &str) -> PathBuf {
        let resources = root.join(relative).join("Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(resources.join("icudtl.dat"), b"test").unwrap();
        resources
    }

    #[test]
    fn identifica_processos_auxiliares_chromium_sem_chamar_o_cef() {
        assert!(is_helper_switch(OsStr::new("--type=renderer")));
        assert!(is_helper_switch(OsStr::new("--type")));
        assert!(!is_helper_switch(OsStr::new("--user-data-dir=/tmp/profile")));
        assert!(!is_helper_switch(OsStr::new("type=renderer")));
    }

    #[test]
    fn localiza_recursos_no_bundle_principal_e_nos_helpers() {
        let root = isolated_root();
        let main_executable = root.join("ADE AGS.app/Contents/MacOS/ade-ags");
        fs::create_dir_all(main_executable.parent().unwrap()).unwrap();
        fs::write(root.join("ADE AGS.app/Contents/Info.plist"), b"bundle").unwrap();
        let main_resources = add_framework(&root, "ADE AGS.app/Contents/Frameworks/Chromium Embedded Framework.framework");
        assert_eq!(
            cef_resources_dir(&main_executable, false).unwrap(),
            main_resources.canonicalize().unwrap()
        );

        let helper_executable = root.join("ADE AGS.app/Contents/Frameworks/ADE AGS Helper.app/Contents/MacOS/ADE AGS Helper");
        fs::create_dir_all(helper_executable.parent().unwrap()).unwrap();
        let helper_resources = cef_resources_dir(&helper_executable, true).unwrap();
        assert_eq!(helper_resources, main_resources.canonicalize().unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn desenvolvimento_usa_recursos_do_pacote_cef_do_cargo() {
        let root = isolated_root();
        let executable = root.join("target/debug/ade-ags");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        let cef_dir = cef::sys::get_cef_dir().unwrap();
        let resources = cef_dir.join(CEF_FRAMEWORK_BUNDLE).join("Resources").canonicalize().unwrap();
        assert_eq!(
            cef_resources_dir(&executable, false).unwrap(),
            resources
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn usa_bundle_debug_preparado_ao_lado_do_executavel() {
        let root = isolated_root();
        let executable = root.join("target/debug/ade-ags");
        let bundle = root.join("target/debug/ADE AGS.app");
        fs::create_dir_all(bundle.join("Contents")).unwrap();
        fs::write(bundle.join("Contents/Info.plist"), b"bundle").unwrap();
        assert_eq!(main_bundle_path(&executable).unwrap(), bundle.canonicalize().unwrap());
        let _ = fs::remove_dir_all(root);
    }
}
