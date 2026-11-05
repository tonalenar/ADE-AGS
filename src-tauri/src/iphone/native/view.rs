//! A tela do iPhone físico dentro da janela: uma NSView nossa por cima do webview, como a do simulador
//! (`simulator::native::view`), cuja subcamada mostra a `IOSurface` do quadro decodificado. A máscara (cantos,
//! parte à vista e buracos onde há menus do app) é a mesma do simulador.
//!
//! Só ver: dentro da região à vista a view fica com o clique e o rolar (para o canvas não arrastar por baixo) e
//! não faz nada com eles. Nada vai para o aparelho.
//!
//! As views rodam na thread da interface; os quadros entram nas camadas pela fila do `Presenter`.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::{Arc, Mutex, OnceLock};

use dispatch2::{DispatchQoS, DispatchQueue, DispatchQueueAttr, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSEvent, NSResponder, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::decoder::{FrameSink, OSStatus, PixelBuffer};
use crate::iphone::model;
use crate::simulator::model::{Place, Rect};
use crate::simulator::native::objc::{call, class, ns_string, retain, Shared};
use crate::simulator::native::view::{apply_region, cg_rect, transaction, AppliedRegion, CGRect};

pub struct Ivars {
    /// A subcamada com o quadro (a camada da view guarda o fundo e a máscara).
    content: Retained<AnyObject>,
    /// Onde a view fica com o mouse, em coordenadas da view (origem no topo). Vazio = nada à vista.
    region: RefCell<Vec<Rect>>,
    applied: RefCell<Option<AppliedRegion>>,
}

define_class!(
    // SAFETY: NSView não tem requisitos para subclasse; `MirrorView` não implementa Drop.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AdeDeviceMirrorView"]
    #[ivars = Ivars]
    pub struct MirrorView;

    impl MirrorView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: *mut NSEvent) -> bool {
            true
        }

        // Só ver: o clique, o arrasto e o rolar param aqui e não vão a lugar nenhum.
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {}

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {}

        #[unsafe(method(cursorUpdate:))]
        fn cursor_update(&self, _event: &NSEvent) {
            // SAFETY: NSCursor público.
            unsafe {
                let arrow = call!(class(c"NSCursor").expect("AppKit"), sel!(arrowCursor); -> *mut AnyObject);
                call!(arrow, sel!(set); -> ());
            }
        }

        /// Fora da região (fora de vista ou embaixo de um menu do app) o clique é do webview.
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            if self.isHidden() {
                return std::ptr::null_mut();
            }
            // SAFETY: a superview é lida na thread da interface.
            let superview = unsafe { self.superview() };
            let local = self.convertPoint_fromView(point, superview.as_deref());
            let region = self.ivars().region.borrow();
            if region.iter().any(|r| r.contains(local.x, local.y)) { self as *const Self as *mut NSView } else { std::ptr::null_mut() }
        }
    }
);

impl MirrorView {
    fn create(mtm: MainThreadMarker) -> Retained<Self> {
        let gravity = ns_string("resize");
        // SAFETY: CALayer público; `layer` devolve +0 (autorelease) e a subcamada é retida nos ivars.
        let content = unsafe {
            let content = call!(class(c"CALayer").expect("QuartzCore"), sel!(layer); -> *mut AnyObject);
            call!(content, sel!(setContentsGravity:), Retained::as_ptr(&gravity) as *mut AnyObject => *mut AnyObject; -> ());
            retain(content).expect("CALayer")
        };
        let this = Self::alloc(mtm).set_ivars(Ivars { content, region: RefCell::new(Vec::new()), applied: RefCell::new(None) });
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        // SAFETY: CALayer público. Camada nossa (layer-hosting), transparente: até o primeiro quadro (e sem conexão)
        // aparece o estado que o frontend desenha por baixo.
        unsafe {
            let layer = call!(class(c"CALayer").expect("QuartzCore"), sel!(layer); -> *mut AnyObject);
            call!(layer, sel!(setOpaque:), false => bool; -> ());
            call!(layer, sel!(addSublayer:), Retained::as_ptr(&view.ivars().content) as *mut AnyObject => *mut AnyObject; -> ());
            call!(&*view as *const Self as *mut AnyObject, sel!(setLayer:), layer => *mut AnyObject; -> ());
        }
        view.setWantsLayer(true);
        // Cursor de seta sobre a tela (sem isto fica a mãozinha de arrastar do canvas).
        // SAFETY: NSTrackingArea público; `addTrackingArea:` retém a área.
        unsafe {
            const CURSOR_UPDATE: usize = 0x04;
            const ACTIVE_ALWAYS: usize = 0x80;
            const IN_VISIBLE_RECT: usize = 0x200;
            let area = call!(class(c"NSTrackingArea").expect("AppKit"), sel!(alloc); -> *mut AnyObject);
            let area = call!(area, sel!(initWithRect:options:owner:userInfo:),
                cg_rect(0.0, 0.0, 0.0, 0.0) => CGRect, CURSOR_UPDATE | ACTIVE_ALWAYS | IN_VISIBLE_RECT => usize,
                &*view as *const Self as *mut AnyObject => *mut AnyObject, std::ptr::null_mut::<AnyObject>() => *mut AnyObject; -> *mut AnyObject);
            call!(&*view as *const Self as *mut AnyObject, sel!(addTrackingArea:), area => *mut AnyObject; -> ());
            let _ = Retained::from_raw(area);
        }
        view
    }

    fn layer(&self) -> *mut AnyObject {
        // SAFETY: a view tem a camada que `create` pôs.
        unsafe { call!(self as *const Self as *mut AnyObject, sel!(layer); -> *mut AnyObject) }
    }

    /// A subcamada ocupa a view inteira; o quadro é esticado nela (o recorte tira as bordas do vídeo).
    fn fit(&self) {
        let bounds = self.bounds();
        let content = Retained::as_ptr(&self.ivars().content) as *mut AnyObject;
        // SAFETY: CALayer público, na thread da interface, sem animação.
        unsafe { transaction(|| call!(content, sel!(setFrame:), cg_rect(0.0, 0.0, bounds.size.width, bounds.size.height) => CGRect; -> ())) };
    }

    fn set_region(&self, visible: Rect, holes: &[Rect], radius: f64) {
        let bounds = self.bounds();
        // SAFETY: a camada da view, na thread da interface.
        unsafe { apply_region(self.layer(), bounds.size.width, bounds.size.height, visible, holes, radius, &self.ivars().applied) };
        *self.ivars().region.borrow_mut() = crate::simulator::model::subtract(visible, holes);
    }
}

// ── Os quadros: do VideoToolbox para as camadas ──

/// A fila dos quadros: serial e na prioridade da interface, mas fora dela.
fn frame_queue() -> &'static DispatchQueue {
    static QUEUE: OnceLock<DispatchRetained<DispatchQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let attr = DispatchQueueAttr::with_qos_class(DispatchQueueAttr::SERIAL, DispatchQoS::UserInteractive, 0);
        DispatchQueue::new("ade.iphone.frames", Some(&attr))
    })
}

/// Quantos quadros ficam retidos depois de mostrados: o pool do VideoToolbox não reusa a superfície que ainda está
/// na tela (sem isso, um quadro novo podia ser escrito por cima do que a GPU compõe).
const HELD: usize = 3;

/// O diagnóstico de `ADE_IPHONE_FPS=1`: a cada segundo, quadros mostrados, maior intervalo e atrasos.
#[derive(Default)]
struct Stats {
    start: Option<std::time::Instant>,
    last: Option<std::time::Instant>,
    frames: u32,
    max_gap_ms: f64,
    decode_ms: Vec<f64>,
    capture_ms: Vec<f64>,
    failures: u32,
}

/// As camadas que mostram um aparelho e o último quadro dele. Uma por aparelho, compartilhada pelas telas.
pub struct Presenter {
    layers: Mutex<Vec<(String, Shared)>>,
    display: Mutex<Option<(u32, u32)>>,
    held: Mutex<VecDeque<PixelBuffer>>,
    failures: std::sync::atomic::AtomicU32,
    stats: Mutex<Stats>,
    /// Atraso da captura no aparelho até a chegada no Mac, por quadro (estimativa pelo RTCP), para o diagnóstico.
    capture: Mutex<HashMap<u64, f64>>,
}

pub fn debug_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("ADE_IPHONE_FPS").is_some())
}

/// Um relógio monotônico em nanossegundos, comum à sessão e ao callback do decodificador.
pub fn now_ns() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_nanos() as u64
}

fn percentile(v: &mut [f64], q: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() as f64 * q) as usize).min(v.len() - 1)]
}

impl Presenter {
    pub fn new() -> Arc<Presenter> {
        Arc::new(Presenter {
            layers: Mutex::new(Vec::new()),
            display: Mutex::new(None),
            held: Mutex::new(VecDeque::new()),
            failures: std::sync::atomic::AtomicU32::new(0),
            stats: Mutex::new(Stats::default()),
            capture: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_display(&self, display: Option<(u32, u32)>) {
        if let (Some(d), Ok(mut slot)) = (display, self.display.lock()) {
            *slot = Some(d);
        }
    }

    /// Quantos quadros o decodificador recusou até agora.
    pub fn failures(&self) -> u32 {
        self.failures.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Guarda a estimativa de captura→chegada do quadro que chegou em `arrived_ns`.
    pub fn note_capture(&self, arrived_ns: u64, ms: f64) {
        if let Ok(mut map) = self.capture.lock() {
            if map.len() > 256 {
                map.clear();
            }
            map.insert(arrived_ns, ms);
        }
    }

    fn add_layer(self: &Arc<Self>, id: &str, layer: Shared) {
        let this = self.clone();
        let id = id.to_string();
        frame_queue().exec_async(move || {
            // O último quadro já aparece na tela nova, sem esperar o próximo.
            if let Some(last) = this.held.lock().ok().and_then(|h| h.back().map(|b| (b.surface(), b.size()))) {
                let rect = model::contents_rect(last.1, this.display.lock().ok().and_then(|d| *d));
                // SAFETY: superfície viva (o buffer está retido em `held`), camada viva (retida em `layer`).
                unsafe { transaction(|| show(layer.ptr(), last.0, rect)) };
            }
            if let Ok(mut layers) = this.layers.lock() {
                layers.retain(|(other, _)| *other != id);
                layers.push((id, layer));
            }
        });
    }

    fn remove_layer(self: &Arc<Self>, id: &str) {
        let this = self.clone();
        let id = id.to_string();
        frame_queue().exec_async(move || {
            if let Ok(mut layers) = this.layers.lock() {
                layers.retain(|(other, _)| *other != id);
            }
        });
    }

    /// Tira o último quadro das telas (sem conexão ou pausado): aparece o estado que o frontend desenha por baixo.
    pub fn blank(self: &Arc<Self>) {
        let this = self.clone();
        frame_queue().exec_async(move || {
            if let Ok(layers) = this.layers.lock() {
                // SAFETY: camadas retidas; `nil` é conteúdo válido.
                unsafe {
                    transaction(|| {
                        for (_, layer) in layers.iter() {
                            call!(layer.ptr(), sel!(setContents:), std::ptr::null_mut::<AnyObject>() => *mut AnyObject; -> ());
                        }
                    })
                };
            }
            if let Ok(mut held) = this.held.lock() {
                held.clear();
            }
        });
    }

    /// Solta os quadros guardados (a sessão acabou).
    pub fn clear(self: &Arc<Self>) {
        let this = self.clone();
        frame_queue().exec_async(move || {
            if let Ok(mut held) = this.held.lock() {
                held.clear();
            }
        });
    }

    fn count(&self, arrived_ns: u64, failed: bool) {
        if !debug_on() {
            return;
        }
        let Ok(mut s) = self.stats.lock() else { return };
        let now = std::time::Instant::now();
        if failed {
            s.failures += 1;
        } else {
            if let Some(last) = s.last {
                s.max_gap_ms = s.max_gap_ms.max((now - last).as_secs_f64() * 1000.0);
            }
            s.last = Some(now);
            s.frames += 1;
            let decode = now_ns().saturating_sub(arrived_ns) as f64 / 1e6;
            s.decode_ms.push(decode);
            if let Some(capture) = self.capture.lock().ok().and_then(|mut m| m.remove(&arrived_ns)) {
                s.capture_ms.push(capture + decode);
            }
        }
        let start = *s.start.get_or_insert(now);
        let elapsed = (now - start).as_secs_f64();
        if elapsed >= 1.0 {
            let (frames, gap, failures) = (s.frames, s.max_gap_ms, s.failures);
            let decode50 = percentile(&mut s.decode_ms, 0.5);
            let decode_max = percentile(&mut s.decode_ms, 1.0);
            let capture50 = percentile(&mut s.capture_ms, 0.5);
            let capture90 = percentile(&mut s.capture_ms, 0.9);
            eprintln!(
                "[iphone] {:.0} quadros/s · maior intervalo {gap:.0} ms · chegada→quadro p50 {decode50:.1} ms (máx {decode_max:.1}) · captura→quadro p50 {capture50:.0} ms p90 {capture90:.0} ms (estimativa) · {failures} recusados",
                f64::from(frames) / elapsed
            );
            *s = Stats { start: Some(now), last: s.last, ..Stats::default() };
        }
    }
}

/// Põe a superfície na camada, com o recorte.
///
/// # Safety
/// `layer` e `surface` vivos; dentro de uma transação.
unsafe fn show(layer: *mut AnyObject, surface: *mut AnyObject, rect: (f64, f64, f64, f64)) {
    unsafe {
        call!(layer, sel!(setContents:), surface => *mut AnyObject; -> ());
        call!(layer, sel!(setContentsRect:), cg_rect(rect.0, rect.1, rect.2, rect.3) => CGRect; -> ());
    }
}

/// O `FrameSink` do decodificador: põe cada quadro nas camadas, pela fila dos quadros.
pub struct Sink(pub Arc<Presenter>);

impl FrameSink for Sink {
    fn frame(&self, buffer: PixelBuffer, arrived_ns: u64) {
        self.0.count(arrived_ns, false);
        let this = self.0.clone();
        frame_queue().exec_async(move || {
            let surface = buffer.surface();
            if surface.is_null() {
                return;
            }
            let rect = model::contents_rect(buffer.size(), this.display.lock().ok().and_then(|d| *d));
            if let Ok(layers) = this.layers.lock() {
                // SAFETY: superfície viva (o buffer fica retido em `held` logo abaixo), camadas retidas.
                unsafe {
                    transaction(|| {
                        for (_, layer) in layers.iter() {
                            show(layer.ptr(), surface, rect);
                        }
                    })
                };
            }
            if let Ok(mut held) = this.held.lock() {
                held.push_back(buffer);
                while held.len() > HELD {
                    held.pop_front();
                }
            }
        });
    }

    fn failed(&self, _status: OSStatus) {
        self.0.failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.0.count(0, true);
    }
}

// ── As telas abertas ──

struct Entry {
    view: Retained<MirrorView>,
    presenter: Arc<Presenter>,
}

thread_local! {
    /// Só na thread da interface (as views são dela).
    static SCREENS: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new());
}

/// Converte o retângulo do frontend (pixels CSS, origem no topo do webview) para a superview do webview.
fn frame_in_superview(webview: &NSView, rect: Rect) -> NSRect {
    let mut local = NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.width, rect.height));
    if !webview.isFlipped() {
        local.origin.y = webview.bounds().size.height - rect.y - rect.height;
    }
    // SAFETY: thread da interface.
    let superview = unsafe { webview.superview() };
    webview.convertRect_toView(local, superview.as_deref())
}

fn apply(entry: &Entry, webview: &NSView, place: &Place) {
    let view = &entry.view;
    let Some(visible) = place.visible.filter(|v| !v.is_empty() && !place.rect.is_empty()) else {
        view.setHidden(true);
        return;
    };
    view.setFrame(frame_in_superview(webview, place.rect));
    view.fit();
    view.set_region(visible, &place.holes, place.radius);
    view.setHidden(false);
}

/// Abre a tela `id` (um nó do canvas ou o painel do chat) por cima do webview, mostrando os quadros de `presenter`.
///
/// # Safety
/// Chame na thread da interface, com `webview` = o WKWebView da janela.
pub unsafe fn attach(webview: *mut c_void, id: &str, presenter: Arc<Presenter>, place: &Place) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("A tela do iPhone só abre na thread da interface.")?;
    let webview = unsafe { webview.cast::<NSView>().as_ref() }.ok_or("O app não tem webview.")?;
    detach(id);
    // SAFETY: thread da interface.
    let superview = unsafe { webview.superview() }.ok_or("O webview do app não está numa janela.")?;
    let view = MirrorView::create(mtm);
    // NSWindowAbove = 1: por cima do webview.
    // SAFETY: NSView público.
    unsafe {
        call!(Retained::as_ptr(&superview) as *mut AnyObject, sel!(addSubview:positioned:relativeTo:),
            Retained::as_ptr(&view) as *mut AnyObject => *mut AnyObject, 1isize => isize, webview as *const NSView as *mut AnyObject => *mut AnyObject; -> ());
    }
    // SAFETY: a subcamada está viva; `retain` a guarda para a fila de quadros.
    let layer = unsafe { retain(Retained::as_ptr(&view.ivars().content) as *mut AnyObject) }.ok_or("A tela do iPhone não tem camada.")?;
    presenter.add_layer(id, Shared(layer));
    let entry = Entry { view, presenter };
    apply(&entry, webview, place);
    SCREENS.with(|s| s.borrow_mut().insert(id.to_string(), entry));
    Ok(())
}

/// # Safety
/// Chame na thread da interface, com `webview` = o WKWebView da janela.
pub unsafe fn place(webview: *mut c_void, id: &str, place: &Place) {
    let Some(webview) = (unsafe { webview.cast::<NSView>().as_ref() }) else { return };
    SCREENS.with(|s| {
        if let Some(entry) = s.borrow().get(id) {
            apply(entry, webview, place);
        }
    });
}

/// Fecha a tela `id`. Chame na thread da interface.
pub fn detach(id: &str) {
    let entry = SCREENS.with(|s| s.borrow_mut().remove(id));
    if let Some(entry) = entry {
        entry.presenter.remove_layer(id);
        entry.view.removeFromSuperview();
    }
}
