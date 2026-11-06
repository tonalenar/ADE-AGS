//! A tela principal do aparelho: a porta de IO que é um `SimScreen` do tipo LCD. Dela saem a `IOSurface` que o
//! iOS desenha (a mesma memória da GPU, sem cópia) e os avisos de quadro novo, só quando algo muda na tela.

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
    /// O tamanho em pontos do iOS (o que os agentes usam).
    pub fn points(&self) -> (f64, f64) {
        (self.pixels.0 / self.scale, self.pixels.1 / self.scale)
    }
}

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceLock(buffer: *const std::ffi::c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceUnlock(buffer: *const std::ffi::c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceGetBaseAddress(buffer: *const std::ffi::c_void) -> *const u8;
    fn IOSurfaceGetBytesPerRow(buffer: *const std::ffi::c_void) -> usize;
    fn IOSurfaceGetWidth(buffer: *const std::ffi::c_void) -> usize;
    fn IOSurfaceGetHeight(buffer: *const std::ffi::c_void) -> usize;
    fn IOSurfaceGetPixelFormat(buffer: *const std::ffi::c_void) -> u32;
    fn IOSurfaceGetSeed(buffer: *const std::ffi::c_void) -> u32;
    fn IOSurfaceGetID(buffer: *const std::ffi::c_void) -> u32;
}

/// `kIOSurfaceLockReadOnly`: ler sem marcar a superfície como escrita (o seed não anda por nossa causa).
const LOCK_READ_ONLY: u32 = 1;
/// `'BGRA'`: 8 bits por canal, azul primeiro na memória. O único formato que `Pixels` entende.
pub const BGRA: u32 = 0x4247_5241;

/// A superfície que o iOS desenha agora, retida. O seed dela anda a cada quadro que o iOS escreve.
pub struct Surface(Shared);

/// Uma cópia coerente dos pixels: o seed foi o mesmo antes e depois da cópia, então não pegou meio quadro.
pub struct Pixels {
    pub width: usize,
    pub height: usize,
    /// Linhas de `width * 4` bytes, BGRA, sem o enchimento do fim de linha da superfície.
    pub data: Vec<u8>,
    pub seed: u32,
    /// O id da `IOSurface` no sistema: outro id é outra superfície (o iOS troca ao girar ou mudar de modo).
    pub surface: u32,
}

impl Screen {
    /// A superfície atual da tela (ida e volta XPC ao serviço do CoreSimulator, ~ms). Nunca guarde por muito
    /// tempo: ao girar, o iOS passa a desenhar em outra e a antiga para de mudar.
    pub fn surface(&self) -> Option<Surface> {
        // SAFETY: `framebufferSurface` é do protocolo SimDisplayIOSurfaceRenderable, que a tela implementa (o
        // mesmo que `view.rs` usa); o retorno é +0 e é retido aqui.
        unsafe {
            let s = call!(self.obj.ptr(), sel!(framebufferSurface); -> *mut AnyObject);
            let s = if s.is_null() { call!(self.obj.ptr(), sel!(maskedFramebufferSurface); -> *mut AnyObject) } else { s };
            retain(s).map(|s| Surface(Shared(s)))
        }
    }
}

impl Surface {
    fn raw(&self) -> *const std::ffi::c_void {
        self.0.ptr() as *const std::ffi::c_void
    }

    /// Anda a cada quadro escrito. Leitura local, sem XPC.
    pub fn seed(&self) -> u32 {
        // SAFETY: IOSurface retida.
        unsafe { IOSurfaceGetSeed(self.raw()) }
    }

    pub fn id(&self) -> u32 {
        // SAFETY: idem.
        unsafe { IOSurfaceGetID(self.raw()) }
    }

    /// Copia os pixels. Se o iOS escreveu durante a cópia (o seed mudou), tenta de novo; depois de 4 vezes
    /// desiste, para nunca devolver uma mistura de dois quadros.
    pub fn pixels(&self) -> Result<Pixels, String> {
        let raw = self.raw();
        // SAFETY: IOSurface retida; a memória só é lida entre Lock e Unlock, dentro de `height * bytes_per_row`.
        unsafe {
            let format = IOSurfaceGetPixelFormat(raw);
            if format != BGRA {
                return Err(format!("Formato de tela {format:#x} não suportado."));
            }
            let (width, height, row) = (IOSurfaceGetWidth(raw), IOSurfaceGetHeight(raw), IOSurfaceGetBytesPerRow(raw));
            if width == 0 || height == 0 || row < width * 4 {
                return Err("Tela sem pixels.".into());
            }
            for _ in 0..4 {
                let mut before = 0u32;
                if IOSurfaceLock(raw, LOCK_READ_ONLY, &mut before) != 0 {
                    return Err("Não consegui ler a tela.".into());
                }
                let base = IOSurfaceGetBaseAddress(raw);
                let mut data = Vec::with_capacity(width * height * 4);
                if !base.is_null() {
                    for y in 0..height {
                        data.extend_from_slice(std::slice::from_raw_parts(base.add(y * row), width * 4));
                    }
                }
                let mut after = 0u32;
                IOSurfaceUnlock(raw, LOCK_READ_ONLY, &mut after);
                if base.is_null() {
                    return Err("A tela não está na memória.".into());
                }
                if before == after && IOSurfaceGetSeed(raw) == before {
                    return Ok(Pixels { width, height, data, seed: before, surface: IOSurfaceGetID(raw) });
                }
            }
            Err("A tela não parou de mudar durante a leitura.".into())
        }
    }
}
