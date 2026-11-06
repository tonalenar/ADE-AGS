//! A tela do iPhone físico dentro da janela: uma NSView nossa por cima do webview, como a do simulador
//! (`simulator::native::view`), cuja subcamada mostra a `IOSurface` do quadro decodificado. A máscara (cantos,
//! parte à vista e buracos onde há menus do app) é a mesma do simulador.
//!
//! O clique e o arrasto viram toque no aparelho (em proporção da tela, que a view mostra já recortada); com a view
//! em foco, o teclado do Mac digita nele. É a pessoa mexendo: não pede confirmação. Fora da região à vista, o clique
//! é do webview.
//!
//! As views rodam na thread da interface; os quadros entram nas camadas pela fila do `Presenter`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::{Arc, Mutex, OnceLock};

use dispatch2::{DispatchQoS, DispatchQueue, DispatchQueueAttr, DispatchRetained, DispatchTime};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSEvent, NSResponder, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::decoder::{FrameSink, OSStatus, PixelBuffer};
use crate::iphone::model::{self, Edge, Pinch, ScrollDrag, ScrollPhase, TouchPhase};
use crate::iphone::session::InputTx;
use crate::simulator::model::{Place, Rect};
use crate::simulator::native::objc::{call, class, ns_string, retain, Shared};
use crate::simulator::native::view::{apply_region, cg_rect, transaction, AppliedRegion, CGRect};

pub struct Ivars {
    /// A subcamada com o quadro (a camada da view guarda o fundo e a máscara).
    content: Retained<AnyObject>,
    /// Por onde o toque e o teclado vão ao aparelho.
    input: InputTx,
    /// O dedo que está na tela: a borda de onde saiu (fica a mesma até soltar) e o último envio de arrasto.
    touch: Cell<Option<(Edge, std::time::Instant)>>,
    /// O dedo da rolagem com dois dedos e os dois da pinça.
    scroll: RefCell<ScrollDrag>,
    pinch: RefCell<Pinch>,
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

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            if let Some(window) = self.window() {
                window.makeFirstResponder(Some(self));
            }
            self.touch(event, TouchPhase::Start);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.touch(event, TouchPhase::Move);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.touch(event, TouchPhase::End);
        }

        // O botão direito não tem equivalente no aparelho: para aqui (o canvas não arrasta por baixo).
        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {}

        /// Rolagem com dois dedos (e a roda do mouse) → um dedo arrastando no aparelho.
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            self.scroll(event);
        }

        /// Pinça do trackpad → dois dedos em volta do cursor.
        #[unsafe(method(magnifyWithEvent:))]
        fn magnify_with_event(&self, event: &NSEvent) {
            self.pinch(event);
        }

        /// Atalhos com ⌘ no espelho em foco: ⌘↑/⌘↓ volume, ⌘L lateral, ⌘⇧H início. Só quando a tela é a primeira a
        /// responder: fora dela, o atalho é do app.
        #[unsafe(method(performKeyEquivalent:))]
        fn perform_key_equivalent(&self, event: &NSEvent) -> bool {
            let focused = self.window().and_then(|w| w.firstResponder()).is_some_and(|r| std::ptr::eq(Retained::as_ptr(&r).cast::<u8>(), (self as *const Self).cast::<u8>()));
            focused && self.shortcut(event)
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.key(event, true);
        }

        #[unsafe(method(keyUp:))]
        fn key_up(&self, event: &NSEvent) {
            self.key(event, false);
        }

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
    fn create(mtm: MainThreadMarker, input: InputTx) -> Retained<Self> {
        let gravity = ns_string("resize");
        // SAFETY: CALayer público; `layer` devolve +0 (autorelease) e a subcamada é retida nos ivars.
        let content = unsafe {
            let content = call!(class(c"CALayer").expect("QuartzCore"), sel!(layer); -> *mut AnyObject);
            call!(content, sel!(setContentsGravity:), Retained::as_ptr(&gravity) as *mut AnyObject => *mut AnyObject; -> ());
            retain(content).expect("CALayer")
        };
        let this = Self::alloc(mtm).set_ivars(Ivars {
            content, input, touch: Cell::new(None), scroll: RefCell::new(ScrollDrag::default()), pinch: RefCell::new(Pinch::default()),
            region: RefCell::new(Vec::new()), applied: RefCell::new(None),
        });
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

    /// Clique → toque. O arrasto vai no máximo a cada 8 ms (o iOS lê a velocidade pelo intervalo; mais que isso só
    /// enche a fila). A borda é a de onde o dedo saiu.
    fn touch(&self, event: &NSEvent, phase: TouchPhase) {
        const MOVE_EVERY: std::time::Duration = std::time::Duration::from_millis(8);
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        let bounds = self.bounds();
        let Some((ratio, edge)) = model::view_touch(point.x, point.y, bounds.size.width, bounds.size.height) else { return };
        let now = std::time::Instant::now();
        let state = &self.ivars().touch;
        let edge = match (phase, state.get()) {
            (TouchPhase::Start, _) => edge,
            (_, Some((held, _))) => held,
            (_, None) => return,
        };
        if phase == TouchPhase::Move && state.get().is_some_and(|(_, last)| now.duration_since(last) < MOVE_EVERY) {
            return;
        }
        state.set(if phase == TouchPhase::End { None } else { Some((edge, now)) });
        self.ivars().input.send(vec![model::touch_line(phase, ratio, None, edge)]);
    }

    fn phase_of(event: &NSEvent) -> Option<ScrollPhase> {
        // NSEventPhase: began 1, stationary 2, changed 4, ended 8, cancelled 16, mayBegin 32.
        let phase = event.phase().0;
        Some(match phase {
            0 => ScrollPhase::None,
            p if p & 0x1 != 0 => ScrollPhase::Began,
            p if p & 0x4 != 0 => ScrollPhase::Changed,
            p if p & (0x8 | 0x10) != 0 => ScrollPhase::Ended,
            _ => return None,
        })
    }

    fn send_points(&self, phase: TouchPhase, a: (f64, f64), b: Option<(f64, f64)>) {
        let bounds = self.bounds();
        let (w, h) = (bounds.size.width, bounds.size.height);
        let ratio = |p: (f64, f64)| crate::simulator::model::touch_ratio(p.0, p.1, w, h);
        let Some(ra) = ratio(a) else { return };
        let rb = b.and_then(ratio);
        self.ivars().input.send(vec![model::touch_line(phase, ra, rb, Edge::None)]);
    }

    fn scroll(&self, event: &NSEvent) {
        // Com o dedo do mouse na tela, a rolagem espera (não dá para ter dois gestos de um dedo ao mesmo tempo).
        if self.ivars().touch.get().is_some() {
            return;
        }
        let Some(phase) = Self::phase_of(event) else { return };
        let cursor = self.convertPoint_fromView(event.locationInWindow(), None);
        let bounds = self.bounds();
        let momentum = event.momentumPhase().0 != 0;
        let steps = self.ivars().scroll.borrow_mut().event(
            phase, momentum, (cursor.x, cursor.y), (event.scrollingDeltaX(), event.scrollingDeltaY()),
            event.hasPreciseScrollingDeltas(), (bounds.size.width, bounds.size.height),
        );
        for (touch, point) in steps {
            self.send_points(touch, point, None);
        }
    }

    fn pinch(&self, event: &NSEvent) {
        let Some(phase) = Self::phase_of(event) else { return };
        let cursor = self.convertPoint_fromView(event.locationInWindow(), None);
        let bounds = self.bounds();
        if let Some((touch, a, b)) = self.ivars().pinch.borrow_mut().event(phase, (cursor.x, cursor.y), event.magnification(), (bounds.size.width, bounds.size.height)) {
            self.send_points(touch, a, Some(b));
        }
    }

    fn shortcut(&self, event: &NSEvent) -> bool {
        const COMMAND: usize = 1 << 20;
        const SHIFT: usize = 1 << 17;
        let flags = event.modifierFlags().0;
        let Some(action) = model::shortcut(event.keyCode(), flags & COMMAND != 0, flags & SHIFT != 0) else { return false };
        let input = self.ivars().input.clone();
        // O botão fica apertado um instante (o iOS não vê um aperto de 0 ms), fora da thread da interface.
        let _ = std::thread::Builder::new().name("ade-iphone-atalho".into()).spawn(move || match action {
            model::Shortcut::Button(name) => {
                if let (Ok(down), Ok(up)) = (model::button_state_line(name, true), model::button_state_line(name, false)) {
                    input.send(vec![down]);
                    std::thread::park_timeout(std::time::Duration::from_millis(90));
                    input.send(vec![up]);
                }
            }
            model::Shortcut::Home => {
                if let Some(g) = model::gesture("home") {
                    crate::iphone::ops::drag(&input, g.from, g.to, g.ms, g.edge, g.hold_ms);
                }
            }
        });
        true
    }

    /// Teclas do Mac → teclado do aparelho: as com nome pelo código da tecla, o resto pelo caractere (teclado US).
    fn key(&self, event: &NSEvent, down: bool) {
        const SHIFT: u32 = 0xE1;
        let state = if down { "down" } else { "up" };
        let named = match event.keyCode() {
            36 | 76 => Some(0x28),
            53 => Some(0x29),
            51 => Some(0x2a),
            48 => Some(0x2b),
            123 => Some(0x50),
            124 => Some(0x4f),
            125 => Some(0x51),
            126 => Some(0x52),
            _ => None,
        };
        let mut lines = Vec::new();
        if let Some(usage) = named {
            lines.push(format!("key {usage} {state}"));
        } else if let Some(text) = event.characters() {
            for c in text.to_string().chars() {
                if let Some((usage, shift)) = crate::simulator::model::char_usage(c) {
                    if shift && down {
                        lines.push(format!("key {SHIFT} down"));
                    }
                    lines.push(format!("key {usage} {state}"));
                    if shift && !down {
                        lines.push(format!("key {SHIFT} up"));
                    }
                }
            }
        }
        self.ivars().input.send(lines);
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

/// No máximo quantos quadros mostrados ficam retidos esperando a tela largar a superfície (`model::release_plan`).
const HELD_CAP: usize = 16;

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
    /// Quadros que a regra antiga (3 retidos) teria devolvido ao pool com a tela ainda usando; e os soltos à força.
    unsafe_before: usize,
    forced: usize,
    held_max: usize,
}

/// As camadas que mostram um aparelho e o último quadro dele. Uma por aparelho, compartilhada pelas telas.
pub struct Presenter {
    layers: Mutex<Vec<(String, Shared)>>,
    display: Mutex<Option<(u32, u32)>>,
    held: Mutex<VecDeque<(PixelBuffer, u64)>>,
    capture_fence: model::CaptureFence,
    failures: std::sync::atomic::AtomicU32,
    presented: std::sync::atomic::AtomicU64,
    pacing: Mutex<Pacing>,
    generation: std::sync::atomic::AtomicU64,
    last_shown: std::sync::atomic::AtomicU64,
    stats: Mutex<Stats>,
    /// Atraso da captura no aparelho até a chegada no Mac, por quadro (estimativa pelo RTCP), para o diagnóstico.
    capture: Mutex<HashMap<u64, f64>>,
}

#[derive(Default)]
struct Pacing {
    timestamps: HashMap<u64, u32>,
    last: Option<(u32, u64, u64)>,
}

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceLock(buffer: *const c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceUnlock(buffer: *const c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceGetBaseAddress(buffer: *const c_void) -> *const u8;
    fn IOSurfaceGetBytesPerRow(buffer: *const c_void) -> usize;
    fn IOSurfaceGetWidth(buffer: *const c_void) -> usize;
    fn IOSurfaceGetHeight(buffer: *const c_void) -> usize;
    fn IOSurfaceIsInUse(buffer: *const c_void) -> bool;
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
            capture_fence: model::CaptureFence::default(),
            failures: std::sync::atomic::AtomicU32::new(0),
            presented: std::sync::atomic::AtomicU64::new(0),
            pacing: Mutex::new(Pacing::default()),
            generation: std::sync::atomic::AtomicU64::new(0),
            last_shown: std::sync::atomic::AtomicU64::new(0),
            stats: Mutex::new(Stats::default()),
            capture: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_display(&self, display: Option<(u32, u32)>) {
        if let (Some(d), Ok(mut slot)) = (display, self.display.lock()) {
            *slot = Some(d);
        }
    }

    /// Reorienta a medida inicial da tela conforme o tamanho dos quadros que chegam do aparelho.
    pub fn observe_frame_size(&self, coded: (u32, u32)) {
        if let Ok(mut slot) = self.display.lock() {
            if let Some(display) = *slot {
                *slot = Some(model::display_for_frame(display, coded));
            }
        }
    }

    pub fn display(&self) -> Option<(u32, u32)> {
        self.display.lock().ok().and_then(|display| *display)
    }

    pub fn note_rtp(&self, arrived: u64, timestamp: u32) {
        if let Ok(mut pace) = self.pacing.lock() {
            if pace.timestamps.len() >= 256 {
                pace.timestamps.clear();
            }
            pace.timestamps.insert(arrived, timestamp);
        }
    }

    fn delay(&self, arrived: u64, now: u64) -> std::time::Duration {
        const FRAME_NS: u64 = 16_666_667;
        // Recupera 50 µs por quadro para reduzir o atraso sem perder o ritmo RTP.
        const RECOVERY_PER_FRAME_NS: u64 = 50_000;
        let Ok(mut pace) = self.pacing.lock() else { return std::time::Duration::ZERO };
        let Some(timestamp) = pace.timestamps.remove(&arrived) else { return std::time::Duration::ZERO };
        let target = match pace.last {
            Some((previous, old_arrival, deadline)) if arrived > old_arrival => {
                let ticks = timestamp.wrapping_sub(previous);
                if ticks > 0 && ticks < 24_000 {
                    let next = deadline + u64::from(ticks) * 1_000_000_000 / 24_000;
                    next.saturating_sub(RECOVERY_PER_FRAME_NS).clamp(now, now + FRAME_NS)
                } else {
                    now
                }
            }
            _ => now,
        };
        pace.last = Some((timestamp, arrived, target));
        std::time::Duration::from_nanos(target - now)
    }

    pub fn presented(&self) -> u64 {
        self.presented.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Quantos quadros o decodificador recusou até agora.
    pub fn failures(&self) -> u32 {
        self.failures.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Uma perda, falha de decodificação ou troca de decodificador torna a foto insegura até outro quadro-chave.
    pub fn invalidate_capture(&self) {
        self.capture_fence.invalidate();
    }

    /// Marca o quadro-chave que recuperou as referências do vídeo. Quadros anteriores não passam pelo fence.
    pub fn capture_after_keyframe(&self, arrived_ns: u64) {
        self.capture_fence.on_keyframe(arrived_ns);
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
            if let Some(last) = this.held.lock().ok().and_then(|h| h.back().map(|(b, _)| (b.surface(), b.size()))) {
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

    /// Os pixels do último quadro mostrado (BGRA, linhas de `largura * 4`), já sem as bordas de alinhamento do vídeo:
    /// a foto dos agentes. `None` = ainda não há quadro.
    pub fn snapshot(&self) -> Option<(Vec<u8>, usize, usize)> {
        const READ_ONLY: u32 = 1;
        let held = self.held.lock().ok()?;
        let (buffer, arrived_ns) = held.back()?;
        if !self.capture_fence.trusts(*arrived_ns) {
            return None;
        }
        let surface = buffer.surface() as *const c_void;
        if surface.is_null() {
            return None;
        }
        let display = self.display.lock().ok().and_then(|d| *d);
        // SAFETY: a superfície vive enquanto o buffer está retido em `held` (a trava fica até o fim); a memória só é
        // lida entre Lock e Unlock e dentro de `altura * bytes_por_linha`.
        unsafe {
            let (w, h, row) = (IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface), IOSurfaceGetBytesPerRow(surface));
            let (cw, ch) = model::crop_size((w as u32, h as u32), display);
            let (cw, ch) = (cw as usize, ch as usize);
            if cw == 0 || ch == 0 || row < w * 4 {
                return None;
            }
            let mut seed = 0u32;
            if IOSurfaceLock(surface, READ_ONLY, &mut seed) != 0 {
                return None;
            }
            let base = IOSurfaceGetBaseAddress(surface);
            let mut data = Vec::with_capacity(cw * ch * 4);
            if !base.is_null() {
                for y in 0..ch {
                    data.extend_from_slice(std::slice::from_raw_parts(base.add(y * row), cw * 4));
                }
            }
            IOSurfaceUnlock(surface, READ_ONLY, &mut seed);
            (!base.is_null()).then_some((data, cw, ch))
        }
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
            this.capture_fence.invalidate();
        });
    }

    /// Solta os quadros guardados (a sessão acabou).
    pub fn clear(self: &Arc<Self>) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut pace) = self.pacing.lock() {
            *pace = Pacing::default();
        }
        self.capture_fence.invalidate();
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
                "[iphone] {:.0} quadros/s · maior intervalo {gap:.0} ms · chegada→quadro p50 {decode50:.1} ms (máx {decode_max:.1}) · captura→quadro p50 {capture50:.0} ms p90 {capture90:.0} ms (estimativa) · {failures} recusados · superfícies: {} ainda na tela pela regra antiga, {} soltas à força, até {} retidas",
                f64::from(frames) / elapsed, s.unsafe_before, s.forced, s.held_max
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
        self.0.observe_frame_size(buffer.size());
        use std::sync::atomic::Ordering::Relaxed;
        let delay = self.0.delay(arrived_ns, now_ns());
        let this = self.0.clone();
        let generation = this.generation.load(Relaxed);
        let present = move || {
            if generation != this.generation.load(Relaxed)
                || arrived_ns <= this.last_shown.load(Relaxed) {
                return;
            }
            this.last_shown.store(arrived_ns, Relaxed);
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
                if !layers.is_empty() {
                    this.presented.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
            if let Ok(mut held) = this.held.lock() {
                held.push_back((buffer, arrived_ns));
                // Só devolve ao pool a superfície que a tela não usa mais (senão o próximo quadro é escrito por cima
                // do que a GPU ainda compõe: blocos de dois quadros misturados na rolagem).
                // SAFETY: superfícies vivas (os buffers estão retidos aqui).
                let in_use: Vec<bool> = held.iter().map(|(b, _)| unsafe { IOSurfaceIsInUse(b.surface() as *const c_void) }).collect();
                let plan = model::release_plan(&in_use, HELD_CAP);
                for i in plan.release.iter().rev() {
                    held.remove(*i);
                }
                if debug_on() {
                    if let Ok(mut s) = this.stats.lock() {
                        s.unsafe_before += plan.unsafe_before.min(1);
                        s.forced += plan.forced;
                        s.held_max = s.held_max.max(held.len());
                    }
                }
            }
        };
        if delay.is_zero() {
            frame_queue().exec_async(present);
        } else if let Ok(when) = DispatchTime::try_from(delay) {
            let _ = frame_queue().after(when, present);
        }
    }

    fn failed(&self, _status: OSStatus) {
        self.0.failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.0.invalidate_capture();
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
pub unsafe fn attach(webview: *mut c_void, id: &str, presenter: Arc<Presenter>, input: InputTx, place: &Place) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("A tela do iPhone só abre na thread da interface.")?;
    let webview = unsafe { webview.cast::<NSView>().as_ref() }.ok_or("O app não tem webview.")?;
    detach(id);
    // SAFETY: thread da interface.
    let superview = unsafe { webview.superview() }.ok_or("O webview do app não está numa janela.")?;
    let view = MirrorView::create(mtm, input);
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
