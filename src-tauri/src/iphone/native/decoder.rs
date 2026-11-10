//! O HEVC do aparelho → `CVPixelBuffer` com `IOSurface`, pelo VideoToolbox (público). O decodificador de verdade
//! roda no serviço de vídeo do macOS (hardware); um quadro ruim volta como erro, não derruba o app.
//!
//! Cada quadro decodificado vai para o `sink`, que o põe nas camadas das telas abertas.

use std::ffi::c_void;
use std::ptr;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString};

use crate::iphone::model::{AccessUnit, ParamSets};

pub type OSStatus = i32;
type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMVideoDimensions {
    width: i32,
    height: i32,
}

type OutputCallback = unsafe extern "C" fn(
    refcon: *mut c_void,
    source_frame: *mut c_void,
    status: OSStatus,
    info_flags: u32,
    image: *mut c_void,
    pts: CMTime,
    duration: CMTime,
);

#[repr(C)]
struct OutputCallbackRecord {
    callback: OutputCallback,
    refcon: *mut c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
    fn CMVideoFormatDescriptionGetDimensions(description: *const c_void) -> CMVideoDimensions;
    fn CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        allocator: CFTypeRef,
        count: usize,
        pointers: *const *const u8,
        sizes: *const usize,
        nal_header_length: i32,
        extensions: CFTypeRef,
        out: *mut *mut c_void,
    ) -> OSStatus;
    fn CMBlockBufferCreateWithMemoryBlock(
        allocator: CFTypeRef,
        memory: *mut c_void,
        length: usize,
        block_allocator: CFTypeRef,
        custom_source: *const c_void,
        offset: usize,
        data_length: usize,
        flags: u32,
        out: *mut *mut c_void,
    ) -> OSStatus;
    fn CMBlockBufferReplaceDataBytes(source: *const c_void, dest: *mut c_void, offset: usize, length: usize) -> OSStatus;
    fn CMSampleBufferCreateReady(
        allocator: CFTypeRef,
        data: *mut c_void,
        format: *mut c_void,
        samples: isize,
        timing_count: isize,
        timing: *const c_void,
        size_count: isize,
        sizes: *const usize,
        out: *mut *mut c_void,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    fn VTDecompressionSessionCreate(
        allocator: CFTypeRef,
        format: *mut c_void,
        decoder_spec: CFTypeRef,
        image_attributes: CFTypeRef,
        callback: *const OutputCallbackRecord,
        out: *mut *mut c_void,
    ) -> OSStatus;
    fn VTDecompressionSessionDecodeFrame(session: *mut c_void, sample: *mut c_void, flags: u32, source_frame: *mut c_void, info_out: *mut u32) -> OSStatus;
    fn VTDecompressionSessionWaitForAsynchronousFrames(session: *mut c_void) -> OSStatus;
    fn VTDecompressionSessionInvalidate(session: *mut c_void);
    fn VTSessionSetProperty(session: *mut c_void, key: CFTypeRef, value: CFTypeRef) -> OSStatus;
    static kVTDecompressionPropertyKey_RealTime: CFTypeRef;
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferGetWidth(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetIOSurface(buffer: *mut c_void) -> *mut c_void;
    static kCVPixelBufferPixelFormatTypeKey: CFTypeRef;
    static kCVPixelBufferIOSurfacePropertiesKey: CFTypeRef;
}

/// `kCVPixelFormatType_32BGRA`: o formato que uma `CALayer` mostra direto (e o que a foto do simulador lê).
const BGRA: u32 = u32::from_be_bytes(*b"BGRA");
/// `kVTDecodeFrame_EnableAsynchronousDecompression`.
const ASYNC: u32 = 1;

/// Um `CVPixelBuffer` retido. Solto, o pool pode reusar a superfície.
pub struct PixelBuffer(*mut c_void);
// SAFETY: CVPixelBuffer é um objeto CF imutável depois de decodificado; reter e soltar valem de qualquer thread.
unsafe impl Send for PixelBuffer {}
unsafe impl Sync for PixelBuffer {}

impl PixelBuffer {
    /// O tamanho decodificado (com as bordas de alinhamento).
    pub fn size(&self) -> (u32, u32) {
        // SAFETY: buffer vivo.
        unsafe { (CVPixelBufferGetWidth(self.0) as u32, CVPixelBufferGetHeight(self.0) as u32) }
    }

    /// A `IOSurface` por baixo (+0: vive enquanto o buffer).
    pub fn surface(&self) -> *mut AnyObject {
        // SAFETY: buffer vivo; pedido com `kCVPixelBufferIOSurfacePropertiesKey`.
        unsafe { CVPixelBufferGetIOSurface(self.0) as *mut AnyObject }
    }
}

impl Drop for PixelBuffer {
    fn drop(&mut self) {
        // SAFETY: retido em `on_output`.
        unsafe { CFRelease(self.0) };
    }
}

/// Quem recebe os quadros decodificados (na thread do VideoToolbox).
pub trait FrameSink: Send + Sync {
    fn frame(&self, buffer: PixelBuffer, arrived_ns: u64);
    fn failed(&self, status: OSStatus);
}

struct Ctx {
    sink: Box<dyn FrameSink>,
}

unsafe extern "C" fn on_output(refcon: *mut c_void, source: *mut c_void, status: OSStatus, _flags: u32, image: *mut c_void, _pts: CMTime, _dur: CMTime) {
    // SAFETY: `refcon` é o `Ctx` que vive até o `invalidate` (que espera os quadros pendentes).
    let ctx = unsafe { &*(refcon as *const Ctx) };
    if status != 0 || image.is_null() {
        ctx.sink.failed(status);
        return;
    }
    // SAFETY: o VideoToolbox entrega o buffer +0; retém para guardar.
    unsafe { CFRetain(image) };
    ctx.sink.frame(PixelBuffer(image), source as u64);
}

pub struct Decoder {
    session: *mut c_void,
    format: *mut c_void,
    params: ParamSets,
    ctx: *mut Ctx,
}

// SAFETY: uma sessão do VideoToolbox aceita chamadas de qualquer thread (uma por vez: o `Decoder` é usado por uma só).
unsafe impl Send for Decoder {}

impl Decoder {
    /// Um decodificador para estes conjuntos de parâmetros (VPS, SPS, PPS).
    pub fn new(params: &ParamSets, sink: Box<dyn FrameSink>) -> Result<Decoder, String> {
        let sets = [&params.vps, &params.sps, &params.pps];
        let pointers: Vec<*const u8> = sets.iter().map(|s| s.as_ptr()).collect();
        let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
        let mut format = ptr::null_mut();
        // SAFETY: os ponteiros e tamanhos são dos vetores vivos aqui; o CoreMedia copia o que precisa.
        let status = unsafe {
            CMVideoFormatDescriptionCreateFromHEVCParameterSets(ptr::null(), 3, pointers.as_ptr(), sizes.as_ptr(), 4, ptr::null(), &mut format)
        };
        if status != 0 || format.is_null() {
            return Err(format!("O vídeo do aparelho veio com parâmetros que o macOS não aceitou ({status})."));
        }
        // Saída em BGRA, numa IOSurface (a camada mostra direto, sem copiar).
        // SAFETY: as chaves são `CFString` constantes do CoreVideo (toll-free com `NSString`).
        let attributes: Retained<NSDictionary<NSString, AnyObject>> = unsafe {
            let format_key = &*(kCVPixelBufferPixelFormatTypeKey as *const NSString);
            let surface_key = &*(kCVPixelBufferIOSurfacePropertiesKey as *const NSString);
            let empty: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
            let bgra = NSNumber::new_u32(BGRA);
            NSDictionary::from_retained_objects(&[format_key, surface_key], &[Retained::into_super(Retained::into_super(bgra)).into(), Retained::into_super(empty).into()])
        };
        let ctx = Box::into_raw(Box::new(Ctx { sink }));
        let record = OutputCallbackRecord { callback: on_output, refcon: ctx as *mut c_void };
        let mut session = ptr::null_mut();
        // SAFETY: formato e atributos vivos; o registro é copiado pela sessão.
        let status = unsafe {
            VTDecompressionSessionCreate(ptr::null(), format, ptr::null(), Retained::as_ptr(&attributes) as CFTypeRef, &record, &mut session)
        };
        if status != 0 || session.is_null() {
            // SAFETY: criados acima.
            unsafe {
                CFRelease(format);
                drop(Box::from_raw(ctx));
            }
            return Err(format!("O macOS não abriu o decodificador de HEVC ({status})."));
        }
        // Tempo real: o quadro mais novo importa mais que a fila.
        // SAFETY: chave e valor constantes.
        unsafe { VTSessionSetProperty(session, kVTDecompressionPropertyKey_RealTime, kCFBooleanTrue) };
        Ok(Decoder { session, format, params: params.clone(), ctx })
    }

    /// Dimensões do fluxo HEVC negociado, usadas para acompanhar a rotação física sem esperar uma nova conexão.
    pub fn coded_dimensions(&self) -> (u32, u32) {
        // SAFETY: `format` é o CMVideoFormatDescription criado e retido por este decodificador.
        let dimensions = unsafe { CMVideoFormatDescriptionGetDimensions(self.format) };
        (
            dimensions.width.max(0) as u32,
            dimensions.height.max(0) as u32,
        )
    }

    /// Os parâmetros com que nasceu: se o aparelho mandar outros (girou, mudou a resolução), refaça.
    pub fn params(&self) -> &ParamSets {
        &self.params
    }

    /// Manda o quadro (assíncrono: o resultado vai ao `sink`). `arrived_ns` volta junto, para medir o atraso.
    pub fn decode(&mut self, unit: &AccessUnit, arrived_ns: u64) -> Result<(), String> {
        let data = unit.avcc();
        let len = data.len();
        let mut block = ptr::null_mut();
        // SAFETY: bloco novo do tamanho certo; os bytes são copiados para dentro dele.
        unsafe {
            let status = CMBlockBufferCreateWithMemoryBlock(ptr::null(), ptr::null_mut(), len, ptr::null(), ptr::null(), 0, len, 0, &mut block);
            if status != 0 || block.is_null() {
                return Err(format!("CMBlockBuffer ({status})"));
            }
            let status = CMBlockBufferReplaceDataBytes(data.as_ptr() as *const c_void, block, 0, len);
            if status != 0 {
                CFRelease(block);
                return Err(format!("CMBlockBuffer ({status})"));
            }
            let mut sample = ptr::null_mut();
            let status = CMSampleBufferCreateReady(ptr::null(), block, self.format, 1, 0, ptr::null(), 1, &len, &mut sample);
            CFRelease(block);
            if status != 0 || sample.is_null() {
                return Err(format!("CMSampleBuffer ({status})"));
            }
            let mut info = 0u32;
            let status = VTDecompressionSessionDecodeFrame(self.session, sample, ASYNC, arrived_ns as *mut c_void, &mut info);
            CFRelease(sample);
            if status != 0 {
                return Err(format!("O decodificador recusou o quadro ({status})."));
            }
        }
        Ok(())
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: a sessão espera os quadros em voo antes de soltar o `Ctx` que o callback usa.
        unsafe {
            VTDecompressionSessionWaitForAsynchronousFrames(self.session);
            VTDecompressionSessionInvalidate(self.session);
            CFRelease(self.session);
            CFRelease(self.format);
            drop(Box::from_raw(self.ctx));
        }
    }
}
