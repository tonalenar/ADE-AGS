//! A tela do aparelho dentro da janela do app: uma NSView nossa por cima do webview, cuja camada mostra a
//! `IOSurface` do simulador. É o que o Simulator faz: a GPU compõe a superfície direto, sem copiar quadro; a cada
//! quadro novo do iOS só se avisa a camada (`setContentsChanged`), e com a tela parada nada acontece.
//!
//! Quem diz onde a tela fica é o frontend (`simulator_place`): o retângulo da tela do aparelho no canvas, a
//! parte à vista e os buracos onde há algo do app por cima (menus, diálogos). Fora dela a tela não aparece nem
//! recebe toque. O toque e o teclado vão da própria view para o HID, sem passar pelo JavaScript.
//!
//! As views, a máscara e o toque rodam na thread da interface. Os quadros não: chegam numa fila própria de
//! prioridade alta (`frame_queue`), porque o serviço do simulador espera o callback voltar antes de mandar o
//! próximo, e com a interface ocupada os quadros atrasavam e chegavam juntos (o "engasgo").

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use block2::RcBlock;
use dispatch2::{DispatchQoS, DispatchQueue, DispatchQueueAttr, DispatchRetained, DispatchTime};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSEvent, NSResponder, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::hid::{Hid, Phase};
use super::kit::{CGPoint, CGSize};
use super::objc::{blocks, call, class, ns_string, retain, Shared};
use super::screen::Screen;
use crate::simulator::model::{self, Place, Rect};

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceGetSeed(buffer: *const c_void) -> u32;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPathCreateWithRect(rect: CGRect, transform: *const c_void) -> *mut c_void;
    fn CGPathCreateWithRoundedRect(rect: CGRect, corner_width: f64, corner_height: f64, transform: *const c_void) -> *mut c_void;
    fn CGPathCreateCopyByIntersectingPath(path: *const c_void, mask: *const c_void, even_odd: bool) -> *mut c_void;
    fn CGPathCreateCopyBySubtractingPath(path: *const c_void, mask: *const c_void, even_odd: bool) -> *mut c_void;
    fn CGPathRelease(path: *mut c_void);
}

fn cg_rect(x: f64, y: f64, width: f64, height: f64) -> CGRect {
    CGRect { origin: CGPoint { x, y }, size: CGSize { width, height } }
}

/// Uso HID do Shift esquerdo.
const SHIFT: u32 = 0xe1;

pub struct Ivars {
    hid: Arc<Hid>,
    /// Onde a tela recebe toque, em coordenadas da view (origem no topo). Vazio = nada à vista.
    region: RefCell<Vec<Rect>>,
    touching: Cell<bool>,
    /// O dedo de uma rolagem do trackpad (em coordenadas da view), enquanto ela dura.
    scrolling: Cell<Option<(f64, f64)>>,
}

define_class!(
    // SAFETY: NSView não tem requisitos para subclasse; `ScreenView` não implementa Drop.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AdeSimulatorScreenView"]
    #[ivars = Ivars]
    pub struct ScreenView;

    impl ScreenView {
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
            self.ivars().touching.set(true);
            self.touch(event, Phase::Down);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            if self.ivars().touching.get() {
                self.touch(event, Phase::Move);
            }
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            if self.ivars().touching.replace(false) {
                self.touch(event, Phase::Up);
            }
        }

        /// Trackpad: a rolagem vira um dedo arrastando (como no aparelho). A inércia do Mac fica de fora: o iOS
        /// aplica a dele pela velocidade do arrasto quando o dedo sobe.
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            self.scroll(event);
        }


        #[unsafe(method(cursorUpdate:))]
        fn cursor_update(&self, _event: &NSEvent) {
            // SAFETY: NSCursor público.
            unsafe {
                let arrow = call!(class(c"NSCursor").expect("AppKit"), sel!(arrowCursor); -> *mut AnyObject);
                call!(arrow, sel!(set); -> ());
            }
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            self.key(event, true);
        }

        #[unsafe(method(keyUp:))]
        fn key_up(&self, event: &NSEvent) {
            self.key(event, false);
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
            let bounds = self.bounds();
            let inside = local.x >= 0.0 && local.y >= 0.0 && local.x < bounds.size.width && local.y < bounds.size.height;
            let region = self.ivars().region.borrow();
            let allowed = region.iter().any(|r| r.contains(local.x, local.y));
            if inside && allowed { self as *const Self as *mut NSView } else { std::ptr::null_mut() }
        }
    }
);

impl ScreenView {
    fn create(mtm: MainThreadMarker, hid: Arc<Hid>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { hid, region: RefCell::new(Vec::new()), touching: Cell::new(false), scrolling: Cell::new(None) });
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        // Camada nossa (layer-hosting): o AppKit não redesenha por cima do que a superfície mostra.
        // SAFETY: CALayer público.
        unsafe {
            let layer_class = class(c"CALayer").expect("QuartzCore");
            let layer = call!(layer_class, sel!(layer); -> *mut AnyObject);
            let gravity = ns_string("resize");
            call!(layer, sel!(setContentsGravity:), Retained::as_ptr(&gravity) as *mut AnyObject => *mut AnyObject; -> ());
            let black = call!(class(c"NSColor").expect("AppKit"), sel!(blackColor); -> *mut AnyObject);
            let cg = call!(black, sel!(CGColor); -> *mut c_void);
            call!(layer, sel!(setBackgroundColor:), cg => *mut c_void; -> ());
            call!(&*view as *const Self as *mut AnyObject, sel!(setLayer:), layer => *mut AnyObject; -> ());
        }
        view.setWantsLayer(true);
        // Cursor de seta sobre a tela (sem isto fica o do canvas, a mãozinha de arrastar). `InVisibleRect`
        // acompanha o tamanho da view sozinho.
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

    fn touch_at(&self, x: f64, y: f64, phase: Phase) {
        let bounds = self.bounds();
        if let Some(ratio) = model::touch_ratio(x, y, bounds.size.width, bounds.size.height) {
            let _ = self.ivars().hid.touch(ratio, phase);
        }
    }

    fn scroll(&self, event: &NSEvent) {
        // NSEventPhase: began 1, changed 4, ended 8, cancelled 16. Momento (`momentumPhase`) fica de fora.
        const BEGAN: usize = 0x1;
        const ENDED: usize = 0x8 | 0x10;
        let phase = event.phase().0;
        if event.momentumPhase().0 != 0 || self.ivars().touching.get() {
            return;
        }
        let (dx, dy) = (event.scrollingDeltaX(), event.scrollingDeltaY());
        let scale = if event.hasPreciseScrollingDeltas() { 1.0 } else { 12.0 };
        let bounds = self.bounds();
        let clamp = |x: f64, y: f64| (x.clamp(1.0, bounds.size.width - 1.0), y.clamp(1.0, bounds.size.height - 1.0));
        let scrolling = &self.ivars().scrolling;
        if phase == 0 {
            // Roda de mouse (sem fases): um arrasto curto por clique da roda.
            let start = self.convertPoint_fromView(event.locationInWindow(), None);
            let end = clamp(start.x + dx * scale, start.y + dy * scale);
            self.touch_at(start.x, start.y, Phase::Down);
            self.touch_at(end.0, end.1, Phase::Move);
            self.touch_at(end.0, end.1, Phase::Up);
            return;
        }
        if phase & BEGAN != 0 || scrolling.get().is_none() {
            let start = self.convertPoint_fromView(event.locationInWindow(), None);
            let start = clamp(start.x, start.y);
            scrolling.set(Some(start));
            self.touch_at(start.0, start.1, Phase::Down);
        }
        if let Some((x, y)) = scrolling.get() {
            let next = clamp(x + dx * scale, y + dy * scale);
            scrolling.set(Some(next));
            if phase & ENDED != 0 {
                scrolling.set(None);
                self.touch_at(next.0, next.1, Phase::Up);
            } else {
                self.touch_at(next.0, next.1, Phase::Move);
            }
        }
    }

    fn layer(&self) -> *mut AnyObject {
        // SAFETY: a view tem a camada que `create` pôs.
        unsafe { call!(self as *const Self as *mut AnyObject, sel!(layer); -> *mut AnyObject) }
    }

    fn touch(&self, event: &NSEvent, phase: Phase) {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        let bounds = self.bounds();
        if let Some(ratio) = model::touch_ratio(point.x, point.y, bounds.size.width, bounds.size.height) {
            let _ = self.ivars().hid.touch(ratio, phase);
        }
    }

    /// Teclas do Mac → teclado do iOS: as com nome pelo código da tecla, o resto pelo caractere.
    fn key(&self, event: &NSEvent, down: bool) {
        let hid = &self.ivars().hid;
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
        if let Some(usage) = named {
            let _ = hid.key(usage, down);
            return;
        }
        let Some(text) = event.characters() else { return };
        for c in text.to_string().chars() {
            if let Some((usage, shift)) = model::char_usage(c) {
                if shift && down {
                    let _ = hid.key(SHIFT, true);
                }
                let _ = hid.key(usage, down);
                if shift && !down {
                    let _ = hid.key(SHIFT, false);
                }
            }
        }
    }

    /// O que da tela aparece: o retângulo arredondado da tela, cortado na parte à vista e sem os buracos (menus,
    /// diálogos do app por cima). Vira a máscara da camada e a área de toque. O caminho sai das operações
    /// booleanas do CoreGraphics. A camada de uma view virada (`isFlipped`) já vem com a geometria virada pelo
    /// AppKit: as coordenadas são as da view, com a origem no topo, sem conversão.
    fn set_region(&self, visible: Rect, holes: &[Rect], radius: f64) {
        let bounds = self.bounds();
        let (w, h) = (bounds.size.width, bounds.size.height);
        let flip = |r: &Rect| cg_rect(r.x, r.y, r.width, r.height);
        let radius = radius.clamp(0.0, w.min(h) / 2.0);
        // SAFETY: CoreGraphics e CAShapeLayer públicos; cada caminho criado aqui é liberado aqui (a camada retém o seu).
        unsafe {
            let mut path = CGPathCreateWithRoundedRect(cg_rect(0.0, 0.0, w, h), radius, radius, std::ptr::null());
            let clip = CGPathCreateWithRect(flip(&visible), std::ptr::null());
            let cut = CGPathCreateCopyByIntersectingPath(path, clip, false);
            CGPathRelease(clip);
            CGPathRelease(path);
            path = cut;
            for hole in holes {
                let hole_path = CGPathCreateWithRect(flip(hole), std::ptr::null());
                let cut = CGPathCreateCopyBySubtractingPath(path, hole_path, false);
                CGPathRelease(hole_path);
                CGPathRelease(path);
                path = cut;
            }
            let mask = call!(class(c"CAShapeLayer").expect("QuartzCore"), sel!(layer); -> *mut AnyObject);
            call!(mask, sel!(setFrame:), cg_rect(0.0, 0.0, w, h) => CGRect; -> ());
            call!(mask, sel!(setPath:), path => *mut c_void; -> ());
            call!(self.layer(), sel!(setMask:), mask => *mut AnyObject; -> ());
            CGPathRelease(path);
        }
        // A área de toque (coordenadas da view): a parte visível sem os buracos. Os cantos arredondados ficam de
        // fora do toque só pela máscara; um clique ali ainda vira toque na borda da tela, como no Simulator.
        *self.ivars().region.borrow_mut() = model::subtract(visible, holes);
    }
}

/// A fila dos quadros: serial e na prioridade da interface, mas fora dela.
fn frame_queue() -> &'static DispatchQueue {
    static QUEUE: OnceLock<DispatchRetained<DispatchQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let attr = DispatchQueueAttr::with_qos_class(DispatchQueueAttr::SERIAL, DispatchQoS::UserInteractive, 0);
        DispatchQueue::new("ade.simulator.frames", Some(&attr))
    })
}

/// Depois de um aviso de quadro, quando conferir de novo se a superfície mudou: em ~13% dos avisos o seed da
/// `IOSurface` só muda 1–16 ms depois (medição do serve-sim, da Expo).
const RECHECK_MS: [u64; 6] = [1, 1, 2, 4, 8, 16];

/// O que a fila de quadros mexe: a camada da view e a superfície que ela mostra. Só a fila de quadros chama
/// os métodos daqui; a camada é retida, então um aviso atrasado depois de fechar a tela não pega nada solto.
struct Presenter {
    layer: Shared,
    screen: Shared,
    surface: Mutex<Option<Shared>>,
    seed: AtomicU32,
    /// Já há uma reconferência marcada: avisos que chegam no meio ficam por conta dela.
    pending: AtomicBool,
}

/// Uma transação explícita do Core Animation: fora da thread da interface não há runloop para fechar a
/// implícita. Sem animação (`setDisableActions`).
///
/// # Safety
/// `work` só mexe em camadas.
unsafe fn transaction(work: impl FnOnce()) {
    unsafe {
        let ca = class(c"CATransaction").expect("QuartzCore");
        call!(ca, sel!(begin); -> ());
        call!(ca, sel!(setDisableActions:), true => bool; -> ());
        work();
        call!(ca, sel!(commit); -> ());
    }
}

impl Presenter {
    fn seed_now(&self) -> Option<u32> {
        let surface = self.surface.lock().ok()?;
        // SAFETY: a superfície guardada é uma IOSurface retida.
        surface.as_ref().map(|s| unsafe { IOSurfaceGetSeed(s.ptr() as *const c_void) })
    }

    fn present(&self) {
        // SAFETY: CALayer público, numa transação explícita.
        unsafe { transaction(|| call!(self.layer.ptr(), sel!(setContentsChanged); -> ())) };
        count_frame();
    }

    /// A superfície nova (o iOS troca ao girar ou mudar de modo); `None` = ler a atual da tela (ida e volta
    /// XPC: por isso fica guardada e só se lê de novo quando o serviço avisa que mudou).
    fn set_surface(&self, surface: Option<*mut AnyObject>) {
        let ptr = surface.unwrap_or_else(|| {
            // SAFETY: `framebufferSurface` é do protocolo SimDisplayIOSurfaceRenderable, que a tela implementa.
            unsafe {
                let s = call!(self.screen.ptr(), sel!(framebufferSurface); -> *mut AnyObject);
                if s.is_null() { call!(self.screen.ptr(), sel!(maskedFramebufferSurface); -> *mut AnyObject) } else { s }
            }
        });
        // SAFETY: nulo ou uma IOSurface viva (o callback a entrega +0).
        let Some(surface) = (unsafe { retain(ptr) }) else { return };
        let surface = Shared(surface);
        // SAFETY: uma IOSurface é conteúdo válido de CALayer.
        unsafe { transaction(|| call!(self.layer.ptr(), sel!(setContents:), surface.ptr() => *mut AnyObject; -> ())) };
        // SAFETY: idem `seed_now`.
        self.seed.store(unsafe { IOSurfaceGetSeed(surface.ptr() as *const c_void) }, Ordering::Relaxed);
        if let Ok(mut current) = self.surface.lock() {
            *current = Some(surface);
        }
        count_frame();
    }

    /// Quadro novo: mostra se a superfície já mudou; senão reconfere logo depois.
    fn frame(self: &Arc<Self>) {
        if self.pending.load(Ordering::Relaxed) {
            return;
        }
        if !self.advance() {
            self.pending.store(true, Ordering::Relaxed);
            self.recheck(0);
        }
    }

    /// Mostra o quadro se o seed andou. Devolve se andou.
    fn advance(&self) -> bool {
        match self.seed_now() {
            Some(seed) if seed != self.seed.load(Ordering::Relaxed) => {
                self.seed.store(seed, Ordering::Relaxed);
                self.present();
                true
            }
            _ => false,
        }
    }

    fn recheck(self: &Arc<Self>, attempt: usize) {
        let Some(ms) = RECHECK_MS.get(attempt) else {
            self.pending.store(false, Ordering::Relaxed);
            return;
        };
        let this = self.clone();
        let when = DispatchTime::NOW.time((*ms * 1_000_000) as i64);
        let _ = frame_queue().after(when, move || {
            if this.advance() {
                this.pending.store(false, Ordering::Relaxed);
            } else {
                this.recheck(attempt + 1);
            }
        });
    }
}

/// Uma tela aberta: a view, a tela do simulador e os registros de callback (vivos enquanto à vista).
struct Entry {
    view: Retained<ScreenView>,
    screen: Screen,
    presenter: Arc<Presenter>,
    uuid: Retained<AnyObject>,
    listening: Cell<bool>,
}

thread_local! {
    /// Só na thread da interface (as views são dela).
    static SCREENS: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new());
    /// O pedido ao macOS de latência baixa (sem App Nap nem timers agrupados), enquanto alguma tela está à vista.
    static ACTIVITY: RefCell<(usize, Option<Retained<AnyObject>>)> = const { RefCell::new((0, None)) };
}

/// `NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical`: o Mac ainda dorme sozinho.
const ACTIVITY_OPTIONS: u64 = 0x00EF_FFFF | 0xFF_0000_0000;

/// Uma tela entrou (`true`) ou saiu de vista: a primeira pede a atividade ao macOS, a última a devolve.
fn activity(visible: bool) {
    ACTIVITY.with(|a| {
        let mut a = a.borrow_mut();
        a.0 = if visible { a.0 + 1 } else { a.0.saturating_sub(1) };
        // SAFETY: NSProcessInfo público; o token devolvido vem +0 (autorelease) e é retido para devolver depois.
        unsafe {
            let info = call!(class(c"NSProcessInfo").expect("Foundation"), sel!(processInfo); -> *mut AnyObject);
            if a.0 > 0 && a.1.is_none() {
                let reason = ns_string("Simulador iOS à vista");
                let token = call!(info, sel!(beginActivityWithOptions:reason:), ACTIVITY_OPTIONS => u64,
                    Retained::as_ptr(&reason) as *mut AnyObject => *mut AnyObject; -> *mut AnyObject);
                a.1 = retain(token);
                debug("pediu latência baixa ao macOS");
            } else if a.0 == 0 {
                if let Some(token) = a.1.take() {
                    call!(info, sel!(endActivity:), Retained::as_ptr(&token) as *mut AnyObject => *mut AnyObject; -> ());
                    debug("devolveu a latência baixa");
                }
            }
        }
    });
}

/// `ADE_SIMULATOR_FPS=1`: escreve no log quantos quadros por segundo chegam à camada (para separar engasgo do
/// iOS de engasgo da exibição). Desligado, custa uma leitura de `OnceLock`.
fn debug_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("ADE_SIMULATOR_FPS").is_some())
}

fn debug(what: &str) {
    if debug_on() {
        eprintln!("[simulator] {what}");
    }
}

fn count_frame() {
    use std::time::Instant;
    if !debug_on() {
        return;
    }
    // A fila de quadros é serial, mas pode rodar em threads diferentes: a contagem não é por thread.
    static WINDOW: Mutex<(u32, Option<Instant>)> = Mutex::new((0, None));
    let Ok(mut w) = WINDOW.lock() else { return };
    let (count, start) = *w;
    let start = start.unwrap_or_else(Instant::now);
    let elapsed = start.elapsed().as_secs_f64();
    if elapsed >= 1.0 {
        eprintln!("[simulator] {:.0} atualizações/s", f64::from(count + 1) / elapsed);
        *w = (0, Some(Instant::now()));
    } else {
        *w = (count + 1, Some(start));
    }
}

fn new_uuid() -> Retained<AnyObject> {
    // SAFETY: NSUUID público; `new` devolve +1.
    unsafe {
        let ptr = call!(class(c"NSUUID").expect("Foundation"), sel!(new); -> *mut AnyObject);
        Retained::from_raw(ptr).expect("NSUUID")
    }
}

/// Liga os avisos de quadro: só enquanto a tela está à vista (fora dela, nada de trabalho por quadro).
fn listen(entry: &Entry) {
    if entry.listening.replace(true) {
        return;
    }
    let screen = entry.screen.obj.ptr();
    let on_frame = entry.presenter.clone();
    let on_surface = entry.presenter.clone();
    debug("ouvindo os quadros");
    activity(true);
    // Um aviso por quadro que o iOS apresenta (60/s com animação). O de retângulos de dano não entra: chega várias
    // vezes por quadro, e registrado com o mesmo UUID substituía este (o quadro nunca chegava).
    let frame = RcBlock::with_encoding::<_, _, _, blocks::Frame>(move || on_frame.frame());
    let surfaces = RcBlock::with_encoding::<_, _, _, blocks::Surfaces>(move |unmasked: *mut AnyObject, masked: *mut AnyObject| {
        on_surface.set_surface(Some(if unmasked.is_null() { masked } else { unmasked }));
    });
    let properties = RcBlock::with_encoding::<_, _, _, blocks::Properties>(|_properties: *mut AnyObject| {});
    let queue = frame_queue() as *const DispatchQueue as *mut AnyObject;
    let uuid = Retained::as_ptr(&entry.uuid) as *mut AnyObject;
    // SAFETY: assinaturas dos protocolos SimScreen e SimDisplayRenderable conferidas no binário; o proxy copia os
    // blocos. Os callbacks rodam na fila de quadros e só mexem na camada, em transação explícita.
    unsafe {
        call!(screen, sel!(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:),
            uuid => *mut AnyObject, queue => *mut AnyObject, &*frame as *const _ as *mut c_void => *mut c_void,
            &*surfaces as *const _ as *mut c_void => *mut c_void, &*properties as *const _ as *mut c_void => *mut c_void; -> ());
    }
    // O quadro atual: o callback de superfície só vem quando ela muda.
    let presenter = entry.presenter.clone();
    frame_queue().exec_async(move || presenter.set_surface(None));
}

fn stop(entry: &Entry) {
    if !entry.listening.replace(false) {
        return;
    }
    debug("parou de ouvir os quadros");
    activity(false);
    let screen = entry.screen.obj.ptr();
    let uuid = Retained::as_ptr(&entry.uuid) as *mut AnyObject;
    // SAFETY: os mesmos protocolos de `listen`.
    unsafe {
        call!(screen, sel!(unregisterScreenCallbacksWithUUID:), uuid => *mut AnyObject; -> ());
    }
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
        stop(entry);
        return;
    };
    view.setFrame(frame_in_superview(webview, place.rect));
    view.set_region(visible, &place.holes, place.radius);
    view.setHidden(false);
    listen(entry);
}

/// Abre a tela `id` (um nó do canvas ou uma aba) por cima do webview.
///
/// # Safety
/// Chame na thread da interface, com `webview` = o WKWebView da janela.
pub unsafe fn attach(webview: *mut c_void, id: &str, screen: Screen, hid: Arc<Hid>, place: &Place) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("A tela do simulador só abre na thread da interface.")?;
    let webview = unsafe { webview.cast::<NSView>().as_ref() }.ok_or("O app não tem webview.")?;
    detach(id);
    // SAFETY: thread da interface.
    let superview = unsafe { webview.superview() }.ok_or("O webview do app não está numa janela.")?;
    let view = ScreenView::create(mtm, hid);
    // NSWindowAbove = 1: por cima do webview, que é onde o app desenha o canvas.
    // SAFETY: NSView público.
    unsafe {
        call!(Retained::as_ptr(&superview) as *mut AnyObject, sel!(addSubview:positioned:relativeTo:),
            Retained::as_ptr(&view) as *mut AnyObject => *mut AnyObject, 1isize => isize, webview as *const NSView as *mut AnyObject => *mut AnyObject; -> ());
    }
    // SAFETY: a camada e a tela estão vivas; `retain` as guarda para a fila de quadros.
    let (layer, screen_obj) = unsafe { (retain(view.layer()), retain(screen.obj.ptr())) };
    let (Some(layer), Some(screen_obj)) = (layer, screen_obj) else { return Err("A tela do simulador não tem camada.".into()) };
    let presenter = Arc::new(Presenter {
        layer: Shared(layer), screen: Shared(screen_obj), surface: Mutex::new(None), seed: AtomicU32::new(0), pending: AtomicBool::new(false),
    });
    let entry = Entry { view, screen, presenter, uuid: new_uuid(), listening: Cell::new(false) };
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

/// Fecha a tela `id` (some do app; o aparelho continua ligado).
pub fn detach(id: &str) {
    let entry = SCREENS.with(|s| s.borrow_mut().remove(id));
    if let Some(entry) = entry {
        stop(&entry);
        entry.view.removeFromSuperview();
    }
}
