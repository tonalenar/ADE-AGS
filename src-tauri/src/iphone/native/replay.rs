//! Reproduz uma gravação do stream (datagramas crus, `[u32 big-endian][bytes]`) pelo mesmo caminho do app: montagem,
//! espera do quadro-chave e VideoToolbox. Salva quadros em PNG para olhar. Separa "o vídeo decodificado está errado"
//! de "a exibição mostra errado". A gravação é a tela da pessoa: fica fora do repositório.
//!
//! `ADE_IPHONE_REPLAY=<arquivo> ADE_IPHONE_REPLAY_OUT=<pasta> cargo test --lib iphone::native::replay -- --ignored --nocapture`

use std::sync::{Arc, Mutex};

use super::decoder::{Decoder, FrameSink, OSStatus, PixelBuffer};
use crate::iphone::model::{self, Depacketizer, GateAction, KeyframeGate};

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceLock(buffer: *const std::ffi::c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceUnlock(buffer: *const std::ffi::c_void, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceGetBaseAddress(buffer: *const std::ffi::c_void) -> *const u8;
    fn IOSurfaceGetBytesPerRow(buffer: *const std::ffi::c_void) -> usize;
}

struct Saver {
    out: std::path::PathBuf,
    every: u64,
    count: Mutex<u64>,
    failed: Mutex<u64>,
}

impl FrameSink for Saver {
    fn frame(&self, buffer: PixelBuffer, _arrived: u64) {
        let n = {
            let mut c = self.count.lock().unwrap();
            *c += 1;
            *c
        };
        if n % self.every != 0 {
            return;
        }
        let (w, h) = buffer.size();
        let (cw, ch) = model::crop_size((w, h), Some((1290, 2796)));
        let surface = buffer.surface() as *const std::ffi::c_void;
        // SAFETY: buffer retido; leitura entre Lock e Unlock.
        let mut data = unsafe {
            let mut seed = 0;
            IOSurfaceLock(surface, 1, &mut seed);
            let base = IOSurfaceGetBaseAddress(surface);
            let row = IOSurfaceGetBytesPerRow(surface);
            let mut data = Vec::with_capacity(cw as usize * ch as usize * 4);
            for y in 0..ch as usize {
                data.extend_from_slice(std::slice::from_raw_parts(base.add(y * row), cw as usize * 4));
            }
            IOSurfaceUnlock(surface, 1, &mut seed);
            data
        };
        let path = self.out.join(format!("quadro-{n:04}.png"));
        crate::computer_use::png_from_bgra(&mut data, cw as usize, ch as usize, &path).unwrap();
    }

    fn failed(&self, _status: OSStatus) {
        *self.failed.lock().unwrap() += 1;
    }
}

#[test]
#[ignore = "precisa de uma gravação do stream (ADE_IPHONE_REPLAY) e do VideoToolbox"]
fn reproduz_gravacao() {
    let file = std::env::var("ADE_IPHONE_REPLAY").expect("ADE_IPHONE_REPLAY");
    let out = std::path::PathBuf::from(std::env::var("ADE_IPHONE_REPLAY_OUT").expect("ADE_IPHONE_REPLAY_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let bytes = std::fs::read(file).unwrap();
    let saver = Arc::new(Saver { out, every: 15, count: Mutex::new(0), failed: Mutex::new(0) });
    struct Shared(Arc<Saver>);
    impl FrameSink for Shared {
        fn frame(&self, b: PixelBuffer, a: u64) { self.0.frame(b, a) }
        fn failed(&self, s: OSStatus) { self.0.failed(s) }
    }
    let mut dep = Depacketizer::default();
    let mut gate = KeyframeGate::default();
    let mut decoder: Option<Decoder> = None;
    let (mut i, mut units, mut decoded, mut gaps) = (0usize, 0u64, 0u64, 0u64);
    while i + 4 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        let pkt = &bytes[i + 4..i + 4 + len];
        i += 4 + len;
        let before = dep.dropped;
        let pushed = dep.push(pkt);
        if pushed.gap || dep.dropped != before {
            gaps += 1;
            gate.on_gap(units);
        }
        let Some(unit) = pushed.unit else { continue };
        units += 1;
        if let Some(p) = &unit.params {
            if decoder.as_ref().is_none_or(|d| d.params() != p) {
                drop(decoder.take());
                decoder = Some(Decoder::new(p, Box::new(Shared(saver.clone()))).unwrap());
                gate.on_new_decoder(&unit, units);
            }
        }
        if gate.on_unit(&unit, units) == GateAction::Decode {
            if let Some(d) = decoder.as_mut() {
                d.decode(&unit, 0).unwrap();
                decoded += 1;
            }
        }
    }
    drop(decoder);
    eprintln!(
        "[replay] {units} quadros montados, {decoded} decodificados, {gaps} perdas/descartes, {} recusados pelo VideoToolbox, tipos {:?}",
        saver.failed.lock().unwrap(),
        dep.packet_kinds()
    );
}
