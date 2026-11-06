//! Foto e OCR dentro do processo, para o computer use não pagar um processo novo a cada passo.
//!
//! - iOS: os pixels saem da `IOSurface` que o iOS desenha (a mesma que o painel mostra), sem `simctl`. A revisão é
//!   o hash dos pixels crus, então conferir a tela antes de tocar não precisa de outra foto, só de outra leitura.
//! - PNG reduzido pelo CoreGraphics/ImageIO (no lugar do `sips`).
//! - OCR pelo Vision (`VNRecognizeTextRequest`), com o mesmo JSON do `ios_ocr.swift`.
//!
//! Tudo aqui pode falhar (outro formato de tela, aparelho girado, framework ausente): quem chama cai no caminho
//! antigo (`simctl`, `sips`, `swift -e`). Fora do macOS, cada função diz que não há.
use super::ios::Label;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

/// Uma foto nativa do simulador: o PNG reduzido e o que identifica o quadro.
pub(super) struct Shot {
    pub path: std::path::PathBuf,
    pub revision: String,
    /// O quadro que a foto pegou: (id da superfície, seed).
    pub frame: (u32, u32),
    /// A grade de brilho dos pixels crus, para medir o efeito de uma ação (`visual`).
    pub thumb: Option<super::visual::Thumb>,
}

/// O lado maior do PNG que vai ao decisor (o mesmo `sips -Z 1200` de antes).
pub(super) const MAX_SIDE: usize = 1200;

/// A revisão de pixels crus: dimensões e todas as linhas, BGRA. Prefixo `px:` para nunca casar com a revisão do
/// PNG do caminho antigo (uma foto de cada caminho é sempre "tela mudou", que é o lado seguro).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn pixel_revision(id: &str, width: usize, height: usize, data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update((width as u64).to_be_bytes());
    hash.update((height as u64).to_be_bytes());
    hash.update(data);
    format!("{id}:px:{:x}", hash.finalize())
}

/// O tamanho reduzido: o lado maior vira `max`, sem ampliar. Trunca como o `sips` (1170 × 2532 → 554 × 1200).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn scaled(width: usize, height: usize, max: usize) -> (usize, usize) {
    let big = width.max(height);
    if big <= max || big == 0 {
        return (width, height);
    }
    let f = max as f64 / big as f64;
    (((width as f64 * f) as usize).max(1), ((height as f64 * f) as usize).max(1))
}

/// "A tela parou?", a partir das leituras do seed: puro, para testar sem relógio de verdade.
///
/// Assenta quando passou `quiet` sem quadro novo **e** já passou `not_before` (o tempo mínimo depois de uma ação:
/// um app pode levar algumas centenas de ms para começar a reagir ao toque, e uma foto antes disso mostraria a tela
/// velha, que o Jev mandaria tocar de novo). Desiste em `cap` (animação contínua), mas nunca antes de `not_before`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) struct Quiet {
    start: std::time::Instant,
    since: std::time::Instant,
    seed: u32,
    quiet: std::time::Duration,
    cap: std::time::Duration,
    not_before: Option<std::time::Instant>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Quiet {
    pub fn new(now: std::time::Instant, seed: u32, quiet: std::time::Duration, cap: std::time::Duration, not_before: Option<std::time::Instant>) -> Self {
        Self { start: now, since: now, seed, quiet, cap, not_before }
    }

    /// `Some(true)`: assentou; `Some(false)`: bateu no teto; `None`: espere mais.
    pub fn step(&mut self, now: std::time::Instant, seed: u32) -> Option<bool> {
        if seed != self.seed {
            (self.seed, self.since) = (seed, now);
        }
        if self.not_before.is_some_and(|t| now < t) {
            return None;
        }
        if now.saturating_duration_since(self.since) >= self.quiet {
            return Some(true);
        }
        (now.saturating_duration_since(self.start) >= self.cap).then_some(false)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::simulator::native::objc::{call, class};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::sel;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub(in crate::computer_use) struct CGRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        static kCGColorSpaceSRGB: *const c_void;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, space: *mut c_void, info: u32) -> *mut c_void;
        fn CGBitmapContextCreateImage(ctx: *mut c_void) -> *mut c_void;
        fn CGContextSetInterpolationQuality(ctx: *mut c_void, quality: i32);
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
        fn CGContextRelease(ctx: *mut c_void);
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
    }
    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageDestinationCreateWithURL(url: *const c_void, kind: *const c_void, count: usize, options: *const c_void) -> *mut c_void;
        fn CGImageDestinationAddImage(dest: *mut c_void, image: *mut c_void, properties: *const c_void);
        fn CGImageDestinationFinalize(dest: *mut c_void) -> bool;
        fn CGImageSourceCreateWithURL(url: *const c_void, options: *const c_void) -> *mut c_void;
        fn CGImageSourceCreateImageAtIndex(source: *mut c_void, index: usize, options: *const c_void) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }

    /// `kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little`: o BGRA da tela, ignorando o alfa.
    const BGRX: u32 = 6 | (2 << 12);
    /// `kCGInterpolationHigh`.
    const HIGH: i32 = 3;

    /// `NSURL` de arquivo (ligado sem custo ao `CFURL`).
    fn file_url(path: &Path) -> Option<Retained<AnyObject>> {
        let text = crate::simulator::native::objc::ns_string(&path.to_string_lossy());
        // SAFETY: NSURL público; `fileURLWithPath:` devolve +0 (autorelease), retido aqui.
        unsafe {
            let url = call!(class(c"NSURL")?, sel!(fileURLWithPath:), Retained::as_ptr(&text) as *mut AnyObject => *mut AnyObject; -> *mut AnyObject);
            Retained::retain(url)
        }
    }

    /// Desenha `image` reduzida (lado maior `max`) e grava PNG em `out`.
    ///
    /// # Safety
    /// `image` é um CGImage vivo.
    unsafe fn write_scaled(image: *mut c_void, out: &Path, max: usize) -> Result<(), String> {
        unsafe {
            let (w, h) = scaled(CGImageGetWidth(image), CGImageGetHeight(image), max);
            let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            let ctx = CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, space, BGRX);
            CGColorSpaceRelease(space);
            if ctx.is_null() {
                return Err("Não consegui reduzir a foto.".into());
            }
            CGContextSetInterpolationQuality(ctx, HIGH);
            CGContextDrawImage(ctx, CGRect { x: 0., y: 0., w: w as f64, h: h as f64 }, image);
            let small = CGBitmapContextCreateImage(ctx);
            CGContextRelease(ctx);
            if small.is_null() {
                return Err("Não consegui reduzir a foto.".into());
            }
            let written = autoreleasepool(|_| {
                let url = file_url(out).ok_or("Caminho da foto inválido.")?;
                let kind = crate::simulator::native::objc::ns_string("public.png");
                let dest = CGImageDestinationCreateWithURL(
                    Retained::as_ptr(&url) as *const c_void,
                    Retained::as_ptr(&kind) as *const c_void,
                    1,
                    std::ptr::null(),
                );
                if dest.is_null() {
                    return Err::<(), String>("Não consegui gravar a foto.".into());
                }
                CGImageDestinationAddImage(dest, small, std::ptr::null());
                let ok = CGImageDestinationFinalize(dest);
                CFRelease(dest);
                if ok { Ok(()) } else { Err("Não consegui gravar a foto.".into()) }
            });
            CGImageRelease(small);
            written
        }
    }

    /// PNG reduzido a partir de pixels BGRA (linhas de `width * 4`).
    pub(in crate::computer_use) fn png_from_bgra(data: &mut [u8], width: usize, height: usize, out: &Path, max: usize) -> Result<(), String> {
        if data.len() < width * height * 4 {
            return Err("Pixels incompletos.".into());
        }
        // SAFETY: `data` vive até o fim; o contexto só a lê enquanto existe e o CGImage é uma cópia.
        unsafe {
            let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            let ctx = CGBitmapContextCreate(data.as_mut_ptr().cast(), width, height, 8, width * 4, space, BGRX);
            CGColorSpaceRelease(space);
            if ctx.is_null() {
                return Err("Não consegui montar a foto.".into());
            }
            let image = CGBitmapContextCreateImage(ctx);
            CGContextRelease(ctx);
            if image.is_null() {
                return Err("Não consegui montar a foto.".into());
            }
            let result = write_scaled(image, out, max);
            CGImageRelease(image);
            result
        }
    }

    /// Reduz um PNG em disco (no lugar do `sips -Z`).
    pub(in crate::computer_use) fn downscale(src: &Path, out: &Path, max: usize) -> Result<(), String> {
        autoreleasepool(|_| {
            let url = file_url(src).ok_or("Caminho da foto inválido.")?;
            // SAFETY: ImageIO público; fonte e imagem são liberadas aqui.
            unsafe {
                let source = CGImageSourceCreateWithURL(Retained::as_ptr(&url) as *const c_void, std::ptr::null());
                if source.is_null() {
                    return Err("Foto ilegível.".into());
                }
                let image = CGImageSourceCreateImageAtIndex(source, 0, std::ptr::null());
                CFRelease(source);
                if image.is_null() {
                    return Err("Foto ilegível.".into());
                }
                let result = write_scaled(image, out, max);
                CGImageRelease(image);
                result
            }
        })
    }

    /// OCR pelo Vision, igual ao `ios_ocr.swift`: nível preciso, sem correção de idioma, até 200 linhas, caixa em
    /// proporção com origem no topo. Só no arm64: lá o `objc_msgSend` devolve o `CGRect` do `boundingBox`; no
    /// Intel essa chamada exigiria a variante `_stret`, e o caminho do `swift -e` continua.
    /// 0 = frio, 1 = aquecendo, 2 = pronto, 3 = falhou.
    #[cfg(target_arch = "aarch64")]
    static WARM: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

    /// A primeira leitura do Vision num executável novo prepara o modelo de texto para ele e levou 44-70 s
    /// (medido: binário de teste novo; o mesmo binário de novo, 0,1-0,25 s). Num app recém-atualizado isso seria o
    /// primeiro `act` parado mais de um minuto. Então a primeira leitura é numa imagem fixa, numa thread à parte; até
    /// ela voltar, `ocr` recusa e quem chama usa o `swift -e` (cujo executável não muda e já está pronto).
    pub(in crate::computer_use) fn warm_ocr() {
        #[cfg(target_arch = "aarch64")]
        {
            use std::sync::atomic::Ordering;
            if WARM.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_err() {
                return;
            }
            let spawned = std::thread::Builder::new().name("ocr-warm".into()).spawn(|| {
                let path = std::env::temp_dir().join(format!("ade-ocr-warm-{}.png", std::process::id()));
                let ok = std::fs::write(&path, include_bytes!("fixtures/ocr-ajustes.png")).is_ok()
                    && read_text(&path).is_ok_and(|lines| !lines.is_empty());
                let _ = std::fs::remove_file(&path);
                WARM.store(if ok { 2 } else { 3 }, Ordering::Release);
            });
            if spawned.is_err() {
                WARM.store(3, Ordering::Release);
            }
        }
    }

    /// O OCR do `act`: o Vision em processo, se já aquecido.
    #[cfg(target_arch = "aarch64")]
    pub(in crate::computer_use) fn ocr(path: &Path) -> Result<Vec<Label>, String> {
        match WARM.load(std::sync::atomic::Ordering::Acquire) {
            2 => read_text(path),
            3 => Err("Vision não respondeu ao aquecer.".into()),
            _ => {
                warm_ocr();
                Err("Vision ainda aquecendo.".into())
            }
        }
    }

    #[cfg(target_arch = "aarch64")]
    pub(in crate::computer_use) fn read_text(path: &Path) -> Result<Vec<Label>, String> {
        static VISION: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let loaded = *VISION.get_or_init(|| {
            // SAFETY: framework do sistema, carregado uma vez e nunca fechado.
            !unsafe { libc::dlopen(c"/System/Library/Frameworks/Vision.framework/Vision".as_ptr(), libc::RTLD_NOW) }.is_null()
        });
        if !loaded {
            return Err("Vision indisponível.".into());
        }
        autoreleasepool(|_| {
            let url = file_url(path).ok_or("Caminho da foto inválido.")?;
            let handler_class = class(c"VNImageRequestHandler").ok_or("Vision indisponível.")?;
            let request_class = class(c"VNRecognizeTextRequest").ok_or("Vision indisponível.")?;
            // SAFETY: API pública do Vision com as assinaturas do SDK; `alloc`/`init` são +1 e voltam ao
            // `Retained`, o resto é +0 dentro do pool.
            unsafe {
                let options = call!(class(c"NSDictionary").ok_or("Foundation")?, sel!(dictionary); -> *mut AnyObject);
                let handler = call!(handler_class, sel!(alloc); -> *mut AnyObject);
                let handler = call!(handler, sel!(initWithURL:options:), Retained::as_ptr(&url) as *mut AnyObject => *mut AnyObject, options => *mut AnyObject; -> *mut AnyObject);
                let handler = Retained::from_raw(handler).ok_or("OCR local indisponível.")?;
                let request = call!(request_class, sel!(alloc); -> *mut AnyObject);
                let request = Retained::from_raw(call!(request, sel!(init); -> *mut AnyObject)).ok_or("OCR local indisponível.")?;
                let request_ptr = Retained::as_ptr(&request) as *mut AnyObject;
                // VNRequestTextRecognitionLevelAccurate = 0.
                call!(request_ptr, sel!(setRecognitionLevel:), 0isize => isize; -> ());
                call!(request_ptr, sel!(setUsesLanguageCorrection:), false => bool; -> ());
                let requests = call!(class(c"NSArray").ok_or("Foundation")?, sel!(arrayWithObject:), request_ptr => *mut AnyObject; -> *mut AnyObject);
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let ok = call!(Retained::as_ptr(&handler) as *mut AnyObject, sel!(performRequests:error:), requests => *mut AnyObject, &mut error as *mut *mut AnyObject => *mut *mut AnyObject; -> bool);
                if !ok {
                    return Err("OCR local falhou; não enviei a foto.".into());
                }
                let results = call!(request_ptr, sel!(results); -> *mut AnyObject);
                let count = if results.is_null() { 0 } else { call!(results, sel!(count); -> usize) };
                let mut lines = Vec::new();
                for i in 0..count.min(200) {
                    let observation = call!(results, sel!(objectAtIndex:), i => usize; -> *mut AnyObject);
                    let candidates = call!(observation, sel!(topCandidates:), 1usize => usize; -> *mut AnyObject);
                    let first = if candidates.is_null() { std::ptr::null_mut() } else { call!(candidates, sel!(firstObject); -> *mut AnyObject) };
                    if first.is_null() {
                        continue;
                    }
                    let text = crate::simulator::native::objc::string(call!(first, sel!(string); -> *mut AnyObject));
                    let r = call!(observation, sel!(boundingBox); -> CGRect);
                    lines.push(Label { text, left: r.x, right: r.x + r.w, top: 1. - (r.y + r.h), bottom: 1. - r.y });
                }
                Ok(lines)
            }
        })
    }
    #[cfg(not(target_arch = "aarch64"))]
    pub(in crate::computer_use) fn read_text(_: &Path) -> Result<Vec<Label>, String> {
        Err("OCR em processo só no Apple Silicon.".into())
    }
    #[cfg(not(target_arch = "aarch64"))]
    pub(in crate::computer_use) fn ocr(_: &Path) -> Result<Vec<Label>, String> {
        Err("OCR em processo só no Apple Silicon.".into())
    }

    /// A tela atual do aparelho, se der para ler por dentro: só em retrato (a superfície é sempre em retrato e o
    /// toque usa a tela em pé; girado, fica o `simctl`).
    fn surface(udid: &str) -> Result<crate::simulator::native::screen::Surface, String> {
        if crate::simulator::ops::orientation(udid) != 1 {
            return Err("Aparelho girado: foto pelo simctl.".into());
        }
        crate::simulator::native::screen(udid)?.surface().ok_or_else(|| "Tela sem superfície.".into())
    }

    pub(in crate::computer_use) fn ios_shot(udid: &str, out: &Path) -> Result<Shot, String> {
        let mut pixels = surface(udid)?.pixels()?;
        let revision = pixel_revision(udid, pixels.width, pixels.height, &pixels.data);
        let thumb = super::super::visual::thumb_from_bgra(&pixels.data, pixels.width, pixels.height);
        png_from_bgra(&mut pixels.data, pixels.width, pixels.height, out, MAX_SIDE)?;
        Ok(Shot { path: out.to_path_buf(), revision, frame: (pixels.surface, pixels.seed), thumb })
    }

    pub(in crate::computer_use) fn ios_revision(udid: &str) -> Result<String, String> {
        let pixels = surface(udid)?.pixels()?;
        Ok(pixel_revision(udid, pixels.width, pixels.height, &pixels.data))
    }

    /// O quadro atual (id da superfície, seed), sem copiar pixels. Só a bancada usa.
    #[cfg(test)]
    pub(in crate::computer_use) fn ios_frame(udid: &str) -> Result<(u32, u32), String> {
        let s = surface(udid)?;
        Ok((s.id(), s.seed()))
    }

    /// Espera a tela parar: nenhum quadro novo por `quiet`, no máximo até `cap` (animação contínua não trava o
    /// passo). Devolve se assentou. Lê só o seed da superfície (memória local, sem XPC) a cada `TICK`: o
    /// CoreSimulator avisa quadro novo só a quem registra callbacks de tela, e um registro a mais disputaria com o
    /// painel a fila de quadros que o serviço espera voltar.
    pub(in crate::computer_use) fn ios_quiet(udid: &str, quiet: Duration, cap: Duration, not_before: Option<Instant>) -> Result<bool, String> {
        const TICK: Duration = Duration::from_millis(20);
        let s = surface(udid)?;
        let mut tracker = Quiet::new(Instant::now(), s.seed(), quiet, cap, not_before);
        loop {
            if let Some(settled) = tracker.step(Instant::now(), s.seed()) {
                return Ok(settled);
            }
            std::thread::park_timeout(TICK);
        }
    }

    /// Espera um quadro novo depois de `since`, até `max`. Devolve se veio.
    pub(in crate::computer_use) fn ios_changed(udid: &str, since: (u32, u32), max: Duration) -> Result<bool, String> {
        const TICK: Duration = Duration::from_millis(20);
        let s = surface(udid)?;
        if s.id() != since.0 {
            return Ok(true);
        }
        let until = Instant::now() + max;
        while Instant::now() < until {
            if s.seed() != since.1 {
                return Ok(true);
            }
            std::thread::park_timeout(TICK);
        }
        Ok(s.seed() != since.1)
    }
}

#[cfg(target_os = "macos")]
pub(super) use mac::{downscale, ios_changed, ios_quiet, ios_revision, ios_shot, ocr, warm_ocr};
#[cfg(all(test, target_os = "macos"))]
pub(super) use mac::read_text;
#[cfg(all(test, target_os = "macos"))]
use mac::ios_frame;
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub(super) use mac::png_from_bgra;

#[cfg(not(target_os = "macos"))]
mod none {
    use super::*;
    use std::time::Duration;
    const NO: &str = "Captura em processo só no macOS.";
    pub(in crate::computer_use) fn downscale(_: &Path, _: &Path, _: usize) -> Result<(), String> { Err(NO.into()) }
    pub(in crate::computer_use) fn ocr(_: &Path) -> Result<Vec<Label>, String> { Err(NO.into()) }
    pub(in crate::computer_use) fn warm_ocr() {}
    pub(in crate::computer_use) fn ios_shot(_: &str, _: &Path) -> Result<Shot, String> { Err(NO.into()) }
    pub(in crate::computer_use) fn ios_revision(_: &str) -> Result<String, String> { Err(NO.into()) }
    pub(in crate::computer_use) fn ios_frame(_: &str) -> Result<(u32, u32), String> { Err(NO.into()) }
    pub(in crate::computer_use) fn ios_quiet(_: &str, _: Duration, _: Duration, _: Option<std::time::Instant>) -> Result<bool, String> { Err(NO.into()) }
    pub(in crate::computer_use) fn ios_changed(_: &str, _: (u32, u32), _: Duration) -> Result<bool, String> { Err(NO.into()) }
}
#[cfg(not(target_os = "macos"))]
pub(super) use none::*;

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn tela_assenta_sem_quadro_novo_pelo_tempo_quieto_e_desiste_no_teto() {
        let t0 = std::time::Instant::now();
        let ms = |n: u64| t0 + std::time::Duration::from_millis(n);
        let d = std::time::Duration::from_millis;
        // Parada desde o início: assenta aos 300 ms, não antes.
        let mut q = Quiet::new(t0, 7, d(300), d(2500), None);
        assert_eq!(q.step(ms(280), 7), None);
        assert_eq!(q.step(ms(300), 7), Some(true));
        // Um quadro aos 200 ms recomeça a contagem: só assenta aos 500.
        let mut q = Quiet::new(t0, 7, d(300), d(2500), None);
        assert_eq!(q.step(ms(200), 8), None);
        assert_eq!(q.step(ms(480), 8), None);
        assert_eq!(q.step(ms(500), 8), Some(true));
        // Animação contínua: desiste no teto, sem travar o passo.
        let mut q = Quiet::new(t0, 0, d(300), d(2500), None);
        let mut seed = 0;
        let mut out = None;
        for n in (20..=3000).step_by(20) {
            seed += 1;
            out = q.step(ms(n), seed);
            if out.is_some() {
                assert_eq!(n, 2500);
                break;
            }
        }
        assert_eq!(out, Some(false));
    }

    #[test]
    fn depois_de_uma_acao_nunca_fotografa_antes_do_minimo_mesmo_com_a_tela_parada() {
        let t0 = std::time::Instant::now();
        let ms = |n: u64| t0 + std::time::Duration::from_millis(n);
        let d = std::time::Duration::from_millis;
        // O app ainda não reagiu ao toque (nenhum quadro): esperar o mínimo, senão a foto é a tela velha.
        let mut q = Quiet::new(t0, 1, d(300), d(2500), Some(ms(600)));
        assert_eq!(q.step(ms(400), 1), None);
        assert_eq!(q.step(ms(599), 1), None);
        assert_eq!(q.step(ms(600), 1), Some(true));
        // Nem o teto fura o mínimo.
        let mut q = Quiet::new(t0, 1, d(300), d(100), Some(ms(600)));
        assert_eq!(q.step(ms(300), 2), None);
        assert_eq!(q.step(ms(600), 3), Some(false));
    }

    #[test]
    fn reduz_o_lado_maior_a_1200_sem_ampliar() {
        assert_eq!(scaled(1170, 2532, MAX_SIDE), (554, 1200));
        assert_eq!(scaled(2940, 1912, MAX_SIDE), (1200, 780));
        assert_eq!(scaled(800, 600, MAX_SIDE), (800, 600));
    }

    #[test]
    fn revisao_de_pixels_muda_com_um_pixel_e_nunca_casa_com_a_do_png() {
        let mut data = vec![0u8; 4 * 4 * 4];
        let a = pixel_revision("u", 4, 4, &data);
        assert_eq!(a, pixel_revision("u", 4, 4, &data));
        data[17] = 1;
        assert_ne!(a, pixel_revision("u", 4, 4, &data));
        // Mesmos bytes noutra forma é outra tela; outro aparelho também.
        assert_ne!(pixel_revision("u", 4, 4, &data), pixel_revision("u", 8, 2, &data));
        assert_ne!(pixel_revision("u", 4, 4, &data), pixel_revision("v", 4, 4, &data));
        assert!(a.starts_with("u:px:"), "o prefixo separa da revisão do PNG (`u:<hash>`)");
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn fixture() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/computer_use/fixtures/ocr-ajustes.png")
    }

    /// A imagem fixa tem seis linhas desenhadas em posições conhecidas (Helvetica, fundo branco).
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn ocr_do_vision_em_processo_le_a_imagem_fixa_com_caixas_em_proporcao_e_origem_no_topo() {
        let lines = read_text(&fixture()).unwrap();
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["Ajustes", "Geral", "Privacidade e Segurança", "Safari", "Tempo de Uso", "Bateria 82%"]);
        for l in &lines {
            assert!(0. <= l.left && l.left < l.right && l.right <= 1., "{}", l.text);
            assert!(0. <= l.top && l.top < l.bottom && l.bottom <= 1., "{}", l.text);
        }
        // «Ajustes» está no alto da imagem: origem no topo, como no `ios_ocr.swift`.
        assert!(lines[0].top < 0.1 && lines[5].top > 0.5);
    }

    /// Os dois caminhos de OCR dão o mesmo resultado na mesma imagem. Roda o `swift -e` (~0,5 s, exige o Xcode).
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "precisa do swift do Xcode; rode à mão ao mexer no OCR"]
    fn ocr_em_processo_e_o_do_swift_dao_o_mesmo_json() {
        let deadline = Instant::now() + Duration::from_secs(60);
        let native = read_text(&fixture()).unwrap();
        let swift = super::super::ios::swift_ocr(&fixture(), deadline).unwrap();
        assert_eq!(native.len(), swift.len());
        for (a, b) in native.iter().zip(&swift) {
            assert_eq!(a.text, b.text);
            for (x, y) in [(a.left, b.left), (a.right, b.right), (a.top, b.top), (a.bottom, b.bottom)] {
                assert!((x - y).abs() < 1e-6, "{}: {x} × {y}", a.text);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reducao_em_processo_grava_png_do_tamanho_do_sips() {
        let dir = std::env::temp_dir().join(format!("ade-capture-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let (big, small) = (dir.join("big.png"), dir.join("small.png"));
        let mut pixels = vec![255u8; 1170 * 2532 * 4];
        png_from_bgra(&mut pixels, 1170, 2532, &big, usize::MAX).unwrap();
        downscale(&big, &small, MAX_SIDE).unwrap();
        let png = std::fs::read(&small).unwrap();
        assert_eq!(crate::decisions::vision::png_size(&png), Some((554, 1200)));
        assert!(super::super::ios::image_revision(&png).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Bancada: foto, revisão, espera e OCR no simulador ligado, só lendo (não toca nem abre nada). Imprime os
    /// tempos de cada etapa, do caminho novo e do antigo. Rode com o app em release para números de produção:
    /// `BENCH_UDID=<udid> cargo test --release --lib computer_use::capture::test::bancada -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "precisa de um simulador ligado (BENCH_UDID); só lê a tela"]
    fn bancada_no_simulador_ligado() {
        let udid = std::env::var("BENCH_UDID").expect("BENCH_UDID");
        let dir = std::env::temp_dir().join(format!("ade-bench-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.;
        let deadline = Instant::now() + Duration::from_secs(600);
        let mut rows: Vec<(&str, Vec<f64>)> = vec![];
        let mut push = |name: &'static str, v: f64| match rows.iter_mut().find(|r| r.0 == name) {
            Some(r) => r.1.push(v),
            None => rows.push((name, vec![v])),
        };
        for i in 0..8 {
            let t = Instant::now();
            let s = crate::simulator::native::screen(&udid).unwrap();
            push("tela (XPC)", ms(t));
            let t = Instant::now();
            let surface = s.surface().unwrap();
            push("superfície (XPC)", ms(t));
            let t = Instant::now();
            let px = surface.pixels().unwrap();
            push("cópia dos pixels", ms(t));
            let t = Instant::now();
            let _ = pixel_revision(&udid, px.width, px.height, &px.data);
            push("hash dos pixels", ms(t));
            let t = Instant::now();
            let shot = ios_shot(&udid, &dir.join(format!("n{i}.png"))).unwrap();
            push("foto nativa (tudo)", ms(t));
            let t = Instant::now();
            let rev = ios_revision(&udid).unwrap();
            push("revisão nativa (execute)", ms(t));
            if rev != shot.revision {
                eprintln!("  (a tela mudou entre a foto e a revisão)");
            }
            let t = Instant::now();
            let _ = ios_frame(&udid).unwrap();
            push("quadro (seed)", ms(t));
            let t = Instant::now();
            let quiet = ios_quiet(&udid, Duration::from_millis(300), Duration::from_millis(2500), None).unwrap();
            push(if quiet { "espera assentar (assentou)" } else { "espera assentar (teto)" }, ms(t));
            let t = Instant::now();
            let lines = read_text(&shot.path).unwrap_or_default();
            push("OCR Vision em processo", ms(t));
            let t = Instant::now();
            let swift = super::super::ios::swift_ocr(&shot.path, deadline).unwrap();
            push("OCR swift -e (antigo)", ms(t));
            if i == 0 {
                eprintln!("  rótulos: em processo {} · swift {}", lines.len(), swift.len());
            }
            let t = Instant::now();
            let old = crate::simulator::ops::screenshot(&udid).unwrap();
            push("foto simctl (antiga)", ms(t));
            let t = Instant::now();
            let mut cmd = crate::util::spawn::hidden_command("/usr/bin/sips");
            cmd.args(["-Z", "1200"]).arg(&old).arg("--out").arg(dir.join(format!("s{i}.png")));
            crate::util::spawn::output(&mut cmd, Duration::from_secs(15)).unwrap();
            push("sips (antigo)", ms(t));
            let t = Instant::now();
            downscale(std::path::Path::new(&old), &dir.join(format!("d{i}.png")), MAX_SIDE).unwrap();
            push("redução ImageIO", ms(t));
            let _ = std::fs::remove_file(old);
            // O passo inteiro sem o Jev e sem tocar, pelos dois caminhos: espera, foto, OCR e a conferência antes do HID.
            let t = Instant::now();
            let _ = ios_quiet(&udid, Duration::from_millis(100), Duration::from_millis(2500), None).unwrap();
            let shot = ios_shot(&udid, &dir.join(format!("p{i}.png"))).unwrap();
            let _ = read_text(&shot.path).unwrap();
            let _ = ios_revision(&udid).unwrap();
            push("passo novo, 1ª foto (sem Jev)", ms(t));
            let t = Instant::now();
            for _ in 0..2 {
                let old = crate::simulator::ops::screenshot(&udid).unwrap();
                let mut cmd = crate::util::spawn::hidden_command("/usr/bin/sips");
                cmd.args(["-Z", "1200"]).arg(&old).arg("--out").arg(dir.join(format!("q{i}.png")));
                crate::util::spawn::output(&mut cmd, Duration::from_secs(15)).unwrap();
                let _ = std::fs::remove_file(old);
            }
            let _ = super::super::ios::swift_ocr(&dir.join(format!("q{i}.png")), deadline).unwrap();
            push("passo antigo (sem Jev)", ms(t));
        }
        for (name, mut v) in rows {
            v.sort_by(f64::total_cmp);
            eprintln!("{name:28} mediana {:7.1} ms · min {:7.1} · max {:7.1} (n={})", v[v.len() / 2], v[0], v[v.len() - 1], v.len());
        }
        if std::env::var_os("BENCH_KEEP").is_some() {
            eprintln!("fotos em {}", dir.display());
        } else {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
