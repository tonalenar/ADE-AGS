//! A tela principal do aparelho: a porta de IO que é um `SimScreen` do tipo LCD. Dela saem a `IOSurface` que o
//! iOS desenha (a mesma memória da GPU, sem cópia) e os avisos de quadro novo, só quando algo muda na tela.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::objc::{call, responds, retain, Shared};
use super::kit::CGSize;

/// O tipo da tela principal nas propriedades (`screenType`): as outras são TV-out, AirPlay e a redimensionável.
const LCD: i64 = 0;

pub struct Screen {
    pub obj: Shared,
    /// Tamanho em pixels (`pixelSize`).
    pub pixels: (f64, f64),
    /// Pixels por ponto do iOS (`mainScreenScale` do tipo de aparelho: 2 ou 3).
    pub scale: f64,
}

/// # Safety
/// `device` é um SimDevice vivo.
unsafe fn find_lcd(device: *mut AnyObject) -> Option<Screen> {
    unsafe {
        let io = call!(device, sel!(io); -> *mut AnyObject);
        if io.is_null() {
            return None;
        }
        let ports = call!(io, sel!(ioPorts); -> *mut AnyObject);
        let count = if ports.is_null() { 0 } else { call!(ports, sel!(count); -> usize) };
        for i in 0..count {
            let port = call!(ports, sel!(objectAtIndex:), i => usize; -> *mut AnyObject);
            let descriptor = call!(port, sel!(descriptor); -> *mut AnyObject);
            if descriptor.is_null()
                || !responds(descriptor, sel!(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:))
            {
                continue;
            }
            let props = call!(descriptor, sel!(screenProperties); -> *mut AnyObject);
            if props.is_null() || call!(props, sel!(screenType); -> i64) != LCD {
                continue;
            }
            let size = call!(props, sel!(pixelSize); -> CGSize);
            let kind = call!(device, sel!(deviceType); -> *mut AnyObject);
            let scale = if kind.is_null() { 0.0 } else { f64::from(call!(kind, sel!(mainScreenScale); -> f32)) };
            let scale = if scale >= 1.0 { scale } else { 3.0 };
            return retain(descriptor).map(|obj| Screen { obj: Shared(obj), pixels: (size.width, size.height), scale });
        }
        None
    }
}

/// A tela LCD de um aparelho ligado. Logo depois do boot as portas ainda estão aparecendo: espera até `wait`.
pub fn lcd(device: &Shared, wait: Duration) -> Result<Screen, String> {
    let until = Instant::now() + wait;
    loop {
        // SAFETY: `device` é um SimDevice retido.
        if let Some(screen) = autoreleasepool(|_| unsafe { find_lcd(device.ptr()) }) {
            return Ok(screen);
        }
        if Instant::now() >= until {
            return Err("A tela do aparelho não apareceu. Ele terminou de ligar?".into());
        }
        // Não é polling de estado do app: é a porta de IO do CoreSimulator, que não avisa quando surge.
        std::thread::park_timeout(Duration::from_millis(150));
    }
}

impl Screen {
    /// A superfície atual: a sem máscara (retangular); os cantos arredondados são da camada.
    pub fn surface(&self) -> *mut c_void {
        // SAFETY: `framebufferSurface` é do protocolo SimDisplayIOSurfaceRenderable, que a tela implementa.
        unsafe {
            let s = call!(self.obj.ptr(), sel!(framebufferSurface); -> *mut AnyObject);
            if s.is_null() { call!(self.obj.ptr(), sel!(maskedFramebufferSurface); -> *mut AnyObject) as *mut c_void } else { s as *mut c_void }
        }
    }

    /// O tamanho em pontos do iOS (o que os agentes usam).
    pub fn points(&self) -> (f64, f64) {
        (self.pixels.0 / self.scale, self.pixels.1 / self.scale)
    }
}
