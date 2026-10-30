//! Os botões de fechar, minimizar e tela cheia nativos do macOS (os "semáforos" do AppKit) no lugar que o
//! frontend reserva para eles no cabeçalho.
//!
//! No macOS as janelas nascem com moldura e barra de título `Overlay` (o conteúdo vai até o topo, por baixo da
//! barra transparente) e o título escondido: sobram só os três botões. Por padrão o AppKit os põe a 9 pt do
//! topo e da esquerda; aqui eles vão para onde o front pede (`window_controls_place`).
//!
//! A conta é a do tao (`inset_traffic_lights`): o AppKit prende os botões na base da `NSTitlebarContainerView`
//! (9 pt no macOS 27), então para o topo do botão de fechar ficar em `y` a barra cresce até
//! `y + altura do botão + margem de baixo` e cada botão anda na horizontal, mantendo o espaço nativo entre eles. A margem, a altura e
//! o espaço são medidos uma vez por janela, antes de mexer: relidos depois, no meio de um layout do AppKit, a
//! barra crescia sem parar. O AppKit refaz o layout da barra ao redimensionar, sair da tela cheia, trocar o
//! título ou o foco: a posição fica guardada por janela e é reaplicada nesses avisos (e quando o quadro do botão
//! ou da barra muda).
//!
//! Nos outros sistemas as janelas não têm moldura e o front desenha os botões: o comando não faz nada.

/// Onde ficam a barra e os três botões para o topo-esquerdo do botão de fechar ir para `(x, y)`, em pontos do
/// conteúdo da janela (origem no topo). `button_height` e `button_bottom` são os do botão agora (14 e 9 no
/// macOS 27); `spacing` é a distância nativa de um botão ao próximo (23). Pura.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ControlsFrame {
    /// A altura da `NSTitlebarContainerView`, presa no topo da janela.
    pub bar_height: f64,
    /// O `x` de cada botão (fechar, minimizar, tela cheia), na barra (= no conteúdo).
    pub xs: [f64; 3],
}

pub fn controls_frame(x: f64, y: f64, button_height: f64, button_bottom: f64, spacing: f64) -> ControlsFrame {
    let (x, y) = (x.max(0.0), y.max(0.0));
    let bar_height = y + button_height + button_bottom.max(0.0);
    ControlsFrame { bar_height, xs: [x, x + spacing, x + 2.0 * spacing] }
}

/// Põe o botão de fechar com o canto superior esquerdo em `(x, y)` (pontos lógicos, origem no topo-esquerdo do
/// conteúdo, como o `getBoundingClientRect` do front), com os outros dois ao lado no espaço nativo.
/// `visible = false` esconde os três. Fora do macOS não faz nada.
#[tauri::command]
pub fn window_controls_place(window: tauri::Window, x: f64, y: f64, visible: bool) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Posição inválida para os botões da janela.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
        window
            .run_on_main_thread(move || macos::place(ns_window, macos::Placement { x, y, visible }))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, visible);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::{NSPoint, NSRect, NSString};

    use super::controls_frame;

    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Placement {
        pub x: f64,
        pub y: f64,
        pub visible: bool,
    }

    /// O desenho nativo dos botões numa janela, medido antes da primeira mudança.
    #[derive(Debug, Clone, Copy)]
    struct Native {
        /// `origin.y` do botão na barra (a margem de baixo).
        bottom: f64,
        height: f64,
        /// De um botão ao próximo.
        spacing: f64,
    }

    struct Entry {
        placement: Placement,
        native: Native,
        /// Os observadores do quadro do botão de fechar e da barra desta janela (saem quando ela fecha).
        tokens: Vec<Retained<AnyObject>>,
    }

    thread_local! {
        /// Por janela (o ponteiro da `NSWindow`), só na thread da interface.
        static WINDOWS: RefCell<HashMap<usize, Entry>> = RefCell::new(HashMap::new());
        /// Reaplicar mexe nos quadros, o que avisa os observadores de novo: enquanto isso, eles não fazem nada.
        static APPLYING: Cell<bool> = const { Cell::new(false) };
        static GLOBAL: Cell<bool> = const { Cell::new(false) };
        /// Janelas com uma reaplicação já marcada para depois do layout atual.
        static PENDING: RefCell<std::collections::HashSet<usize>> = RefCell::new(Default::default());
    }

    /// `NSWindowStyleMaskFullScreen`: em tela cheia a barra é outra (a que desce do topo) e fica com o AppKit.
    const FULL_SCREEN: usize = 1 << 14;

    /// Os avisos de janela em que o AppKit refaz a barra de título (`object: nil`: valem para todas, e só as que
    /// estão no mapa são reaplicadas).
    const WINDOW_EVENTS: &[&str] = &[
        "NSWindowDidResizeNotification",
        "NSWindowDidEndLiveResizeNotification",
        "NSWindowDidExitFullScreenNotification",
        "NSWindowDidBecomeKeyNotification",
        "NSWindowDidResignKeyNotification",
        "NSWindowDidBecomeMainNotification",
        "NSWindowDidResignMainNotification",
        "NSWindowDidDeminiaturizeNotification",
        "NSWindowDidChangeBackingPropertiesNotification",
        "NSWindowDidChangeScreenNotification",
    ];

    fn center() -> *mut AnyObject {
        let class = AnyClass::get(c"NSNotificationCenter").expect("Foundation");
        // SAFETY: `defaultCenter` é público e nunca nulo.
        unsafe { msg_send![class, defaultCenter] }
    }

    /// `-[NSNotificationCenter addObserverForName:object:queue:usingBlock:]` na fila principal; devolve o token.
    fn observe(name: &str, object: *mut AnyObject, handler: impl Fn(*mut AnyObject) + 'static) -> Option<Retained<AnyObject>> {
        let name = NSString::from_str(name);
        let block = RcBlock::new(move |note: *mut AnyObject| handler(note));
        let queue_class = AnyClass::get(c"NSOperationQueue").expect("Foundation");
        // SAFETY: APIs públicas; o centro copia o bloco; o token volta +0 (autorelease) e é retido aqui.
        unsafe {
            let queue: *mut AnyObject = msg_send![queue_class, mainQueue];
            let token: *mut AnyObject = msg_send![center(), addObserverForName: &*name, object: object, queue: queue, usingBlock: &*block];
            Retained::retain(token)
        }
    }

    /// O `object` de um aviso de janela.
    fn window_of(note: *mut AnyObject) -> usize {
        // SAFETY: `note` é um NSNotification vivo durante o bloco.
        let object: *mut AnyObject = unsafe { msg_send![note, object] };
        object as usize
    }

    fn install_global() {
        if GLOBAL.with(|g| g.replace(true)) {
            return;
        }
        for name in WINDOW_EVENTS {
            if let Some(token) = observe(name, std::ptr::null_mut(), |note| reapply_soon(window_of(note))) {
                // Vivem o processo inteiro (um por evento, para todas as janelas).
                std::mem::forget(token);
            }
        }
        if let Some(token) = observe("NSWindowWillCloseNotification", std::ptr::null_mut(), |note| forget(window_of(note))) {
            std::mem::forget(token);
        }
    }

    /// Os três botões e a barra da janela: (fechar, minimizar, tela cheia, barra).
    ///
    /// # Safety
    /// `window` é uma NSWindow viva, na thread da interface.
    unsafe fn buttons(window: *mut AnyObject) -> Option<[*mut AnyObject; 4]> {
        unsafe {
            let close: *mut AnyObject = msg_send![window, standardWindowButton: 0usize];
            let mini: *mut AnyObject = msg_send![window, standardWindowButton: 1usize];
            let zoom: *mut AnyObject = msg_send![window, standardWindowButton: 2usize];
            if close.is_null() || mini.is_null() || zoom.is_null() {
                return None;
            }
            let titlebar: *mut AnyObject = msg_send![close, superview];
            let bar: *mut AnyObject = if titlebar.is_null() { titlebar } else { msg_send![titlebar, superview] };
            (!bar.is_null()).then_some([close, mini, zoom, bar])
        }
    }

    /// Põe os botões no lugar guardado para a janela. Só mexe no que está diferente (os quadros novos avisam os
    /// observadores, e reaplicar o mesmo valor não pode virar um laço com o layout do AppKit).
    fn apply(window: usize, placement: Placement, native: Native) {
        if APPLYING.with(|a| a.replace(true)) {
            return;
        }
        let window = window as *mut AnyObject;
        // SAFETY: a janela está no mapa (viva até o aviso de fechar), na thread da interface; só APIs públicas da
        // NSWindow/NSView. Sem os botões (janela sem moldura) não há o que fazer.
        unsafe {
            if let Some([close, mini, zoom, bar]) = buttons(window) {
                for button in [close, mini, zoom] {
                    let hidden: bool = msg_send![button, isHidden];
                    if hidden == placement.visible {
                        let _: () = msg_send![button, setHidden: !placement.visible];
                    }
                }
                let style: usize = msg_send![window, styleMask];
                if placement.visible && style & FULL_SCREEN == 0 {
                    let frame = controls_frame(placement.x, placement.y, native.height, native.bottom, native.spacing);
                    let window_rect: NSRect = msg_send![window, frame];
                    let mut bar_rect: NSRect = msg_send![bar, frame];
                    let wanted_y = window_rect.size.height - frame.bar_height;
                    if (bar_rect.size.height - frame.bar_height).abs() > 0.25 || (bar_rect.origin.y - wanted_y).abs() > 0.25 {
                        bar_rect.size.height = frame.bar_height;
                        bar_rect.origin.y = wanted_y;
                        let _: () = msg_send![bar, setFrame: bar_rect];
                    }
                    // x e y explícitos nos três: o AppKit às vezes deixa um deles fora da linha ao refazer a barra.
                    for (button, x) in [close, mini, zoom].into_iter().zip(frame.xs) {
                        let rect: NSRect = msg_send![button, frame];
                        if (rect.origin.x - x).abs() > 0.25 || (rect.origin.y - native.bottom).abs() > 0.25 {
                            let _: () = msg_send![button, setFrameOrigin: NSPoint::new(x, native.bottom)];
                        }
                    }
                }
            }
        }
        APPLYING.with(|a| a.set(false));
    }

    /// Reaplica já e de novo logo depois do layout em andamento: no meio dele (troca de título, por exemplo) o
    /// AppKit ainda move os botões depois do aviso, e a segunda passada é a que vale. Avisos seguidos da mesma
    /// janela viram uma passada só; se tudo já está no lugar, ela não mexe em nada (sem laço).
    fn reapply_soon(window: usize) {
        reapply(window);
        if !PENDING.with(|p| p.borrow_mut().insert(window)) {
            return;
        }
        dispatch2::DispatchQueue::main().exec_async(move || {
            PENDING.with(|p| p.borrow_mut().remove(&window));
            reapply(window);
        });
    }

    fn reapply(window: usize) {
        if APPLYING.with(|a| a.get()) {
            return;
        }
        if let Some((placement, native)) = WINDOWS.with(|w| w.borrow().get(&window).map(|e| (e.placement, e.native))) {
            apply(window, placement, native);
        }
    }

    fn forget(window: usize) {
        let Some(entry) = WINDOWS.with(|w| w.borrow_mut().remove(&window)) else { return };
        for token in entry.tokens {
            // SAFETY: token devolvido por `addObserverForName:…`, removido uma vez.
            let _: () = unsafe { msg_send![center(), removeObserver: &*token] };
        }
    }

    /// Guarda a posição da janela e aplica. Na primeira vez, mede o desenho nativo e liga os observadores. Na
    /// thread da interface.
    pub fn place(window: usize, placement: Placement) {
        install_global();
        let known = WINDOWS.with(|w| {
            let mut map = w.borrow_mut();
            map.get_mut(&window).map(|entry| entry.placement = placement).is_some()
        });
        if !known {
            // SAFETY: janela viva na thread da interface.
            let Some(native) = (unsafe { measure(window as *mut AnyObject) }) else { return };
            WINDOWS.with(|w| w.borrow_mut().insert(window, Entry { placement, native, tokens: Vec::new() }));
            // O AppKit também refaz a barra sem aviso de janela (troca de título): o quadro do botão de fechar ou
            // da barra mudar é o sinal. O bloco só guarda o ponteiro como número e procura no mapa.
            // SAFETY: janela viva na thread da interface; `setPostsFrameChangedNotifications:` é público.
            let views = unsafe { buttons(window as *mut AnyObject) };
            let mut tokens = Vec::new();
            for view in views.map(|[close, _, _, bar]| [close, bar]).into_iter().flatten() {
                let _: () = unsafe { msg_send![view, setPostsFrameChangedNotifications: true] };
                if let Some(token) = observe("NSViewFrameDidChangeNotification", view, move |_| reapply_soon(window)) {
                    tokens.push(token);
                }
            }
            WINDOWS.with(|w| {
                if let Some(entry) = w.borrow_mut().get_mut(&window) {
                    entry.tokens = tokens;
                }
            });
        }
        if let Some(native) = WINDOWS.with(|w| w.borrow().get(&window).map(|e| e.native)) {
            apply(window, placement, native);
        }
    }

    /// O desenho nativo, antes de mexer. Valores fora do razoável (a barra no meio de um layout) caem no padrão
    /// do macOS 27.
    ///
    /// # Safety
    /// `window` é uma NSWindow viva, na thread da interface.
    unsafe fn measure(window: *mut AnyObject) -> Option<Native> {
        let [close, mini, _, _] = unsafe { buttons(window) }?;
        let (close_rect, mini_rect): (NSRect, NSRect) = unsafe { (msg_send![close, frame], msg_send![mini, frame]) };
        let pick = |value: f64, range: std::ops::RangeInclusive<f64>, default: f64| if range.contains(&value) { value } else { default };
        Some(Native {
            bottom: pick(close_rect.origin.y, 0.0..=40.0, 9.0),
            height: pick(close_rect.size.height, 8.0..=40.0, 14.0),
            spacing: pick(mini_rect.origin.x - close_rect.origin.x, 10.0..=60.0, 23.0),
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn o_botao_de_fechar_vai_para_o_ponto_pedido_com_o_espaco_nativo() {
        // macOS 27: botão de 14 pt, 9 pt da base da barra, 23 pt de um botão ao outro.
        let frame = controls_frame(20.0, 20.0, 14.0, 9.0, 23.0);
        assert_eq!(frame.xs, [20.0, 43.0, 66.0]);
        // Topo do botão = altura da barra − margem de baixo − altura do botão = 20.
        assert_eq!(frame.bar_height - 9.0 - 14.0, 20.0);
        assert_eq!(frame.bar_height, 43.0);
    }

    #[test]
    fn a_posicao_nao_sai_da_janela() {
        let frame = controls_frame(-5.0, -3.0, 14.0, 9.0, 23.0);
        assert_eq!(frame.xs[0], 0.0);
        assert_eq!(frame.bar_height, 23.0);
    }
}
