//! Toque, botões e teclado do simulador. Primeiro pelo `dtuhidd` (o HID novo do Xcode 27, ver `dtu.rs`); sem
//! ele, pelo `SimDeviceLegacyHIDClient` com as mensagens do Indigo. `ADE_SIMULATOR_HID=legacy` força o
//! legado (para comparar). Um cliente por aparelho, guardado para a tela e para os agentes.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained, DispatchTime};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::dtu::{self, Dtu, Touch};
use super::kit::{self, CGPoint, CGSize};
use super::objc::{blocks, call, class, Shared};

/// O alvo do toque na tela e o dos botões físicos (os mesmos do SimulatorKit).
const TARGET_SCREEN: u32 = 0x32;
const TARGET_HARDWARE: i32 = 0x33;
const DOWN: i32 = 1;
const UP: i32 = 2;

/// As fases do toque, como os tipos de NSEvent que o Indigo espera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Down = 1,
    Up = 2,
    Move = 6,
}

/// Quanto esperar para mandar de novo um arrasto que o Indigo recusou.
const RETRY_MS: i64 = 4;

pub struct Hid {
    dtu: Option<Arc<Dtu>>,
    /// O cliente legado: só sem o `dtuhidd`.
    client: Option<Shared>,
    queue: DispatchRetained<DispatchQueue>,
    /// O último arrasto que o Indigo recusou (ele descarta acima de 60 por segundo). Vai assim que der, para o
    /// dedo não ficar para trás; um toque que desce ou sobe o descarta. A trava também põe em fila os envios
    /// de toque, para um arrasto atrasado nunca sair depois do dedo subir.
    pending: Mutex<Option<(f64, f64)>>,
    retrying: AtomicBool,
}

// SAFETY: o cliente de HID manda por uma porta mach e é chamado de qualquer fila pelo próprio SimulatorKit.
unsafe impl Send for Hid {}
unsafe impl Sync for Hid {}

impl Hid {
    fn new(device: &Shared) -> Result<Hid, String> {
        let legacy_only = std::env::var("ADE_SIMULATOR_HID").is_ok_and(|v| v == "legacy");
        let dtu = if legacy_only {
            None
        } else {
            match Dtu::open(device) {
                Ok(dtu) => Some(Arc::new(dtu)),
                Err(e) => {
                    eprintln!("[simulator] sem o HID novo, usando o legado: {e}");
                    None
                }
            }
        };
        let client = if dtu.is_some() { None } else { Some(Self::legacy(device)?) };
        Ok(Hid { dtu, client, queue: DispatchQueue::new("ade.simulator.hid", None), pending: Mutex::new(None), retrying: AtomicBool::new(false) })
    }

    fn legacy(device: &Shared) -> Result<Shared, String> {
        kit::kit()?;
        let cls = class(c"_TtC12SimulatorKit24SimDeviceLegacyHIDClient").ok_or("Esta versão do Xcode não tem o cliente de HID.")?;
        let mut error: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: `initWithDevice:error:` é o inicializador exposto ao Objective-C; devolve +1.
        let client = unsafe {
            let obj = call!(cls, sel!(alloc); -> *mut AnyObject);
            let obj = call!(obj, sel!(initWithDevice:error:), device.ptr() => *mut AnyObject, &mut error => *mut *mut AnyObject; -> *mut AnyObject);
            Retained::from_raw(obj)
        }
        .ok_or("O HID do aparelho não respondeu. Ele está ligado?")?;
        Ok(Shared(client))
    }

    /// Manda uma mensagem do Indigo; o cliente a libera (`freeWhenDone`). Mensagem nula (arrasto acima de 60/s,
    /// que o próprio Indigo descarta) não vai.
    fn send(&self, message: *mut c_void) {
        let Some(client) = self.client.as_ref() else { return };
        if message.is_null() {
            return;
        }
        let done = RcBlock::with_encoding::<_, _, _, blocks::Done>(|_error: *mut AnyObject| {});
        let queue = &*self.queue as *const DispatchQueue as *mut AnyObject;
        // SAFETY: assinatura de `sendWithMessage:freeWhenDone:completionQueue:completion:` conferida no binário.
        unsafe {
            call!(client.ptr(), sel!(sendWithMessage:freeWhenDone:completionQueue:completion:),
                message => *mut c_void, true => bool, queue => *mut AnyObject, &*done as *const _ as *mut c_void => *mut c_void; -> ());
        }
    }

    /// Um toque em `ratio` (0..1 da tela). Arrasto em excesso não se perde: o último fica guardado e vai logo
    /// depois.
    pub fn touch(self: &Arc<Self>, ratio: (f64, f64), phase: Phase) -> Result<(), String> {
        if let Some(dtu) = &self.dtu {
            dtu.touch(ratio, match phase {
                Phase::Down => Touch::Start,
                Phase::Move => Touch::Position,
                Phase::Up => Touch::End,
            });
            return Ok(());
        }
        let kit = kit::kit()?;
        let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
        let point = CGPoint { x: ratio.0, y: ratio.1 };
        // SAFETY: ver `kit::MouseFn`.
        let message = unsafe { (kit.mouse)(&point, std::ptr::null(), TARGET_SCREEN, phase as u64, CGSize { width: 1.0, height: 1.0 }, 0) };
        if message.is_null() && phase == Phase::Move {
            *pending = Some(ratio);
            drop(pending);
            self.retry();
            return Ok(());
        }
        *pending = None;
        self.send(message);
        Ok(())
    }

    fn retry(self: &Arc<Self>) {
        if self.retrying.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        let _ = self.queue.after(DispatchTime::NOW.time(RETRY_MS * 1_000_000), move || {
            this.retrying.store(false, Ordering::Release);
            let next = this.pending.lock().ok().and_then(|mut p| p.take());
            if let Some(ratio) = next {
                let _ = this.touch(ratio, Phase::Move);
            }
        });
    }

    pub fn button(&self, source: i32, down: bool) -> Result<(), String> {
        if let Some(dtu) = &self.dtu {
            dtu.button(dtu::button_usage(source).ok_or("Esse botão não existe no HID novo.")?, down);
            return Ok(());
        }
        let kit = kit::kit()?;
        // SAFETY: ver `kit::ButtonFn`.
        self.send(unsafe { (kit.button)(source, if down { DOWN } else { UP }, TARGET_HARDWARE) });
        Ok(())
    }

    pub fn key(&self, usage: u32, down: bool) -> Result<(), String> {
        if let Some(dtu) = &self.dtu {
            dtu.key(usage, down);
            return Ok(());
        }
        let kit = kit::kit()?;
        // SAFETY: ver `kit::KeyFn`.
        self.send(unsafe { (kit.key)(usage, if down { DOWN as u32 } else { UP as u32 }) });
        Ok(())
    }
}

fn clients() -> &'static Mutex<HashMap<String, Arc<Hid>>> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, Arc<Hid>>>> = OnceLock::new();
    CLIENTS.get_or_init(Default::default)
}

/// O cliente de HID do aparelho (criado na primeira vez).
pub fn for_device(udid: &str, device: &Shared) -> Result<Arc<Hid>, String> {
    let mut map = clients().lock().map_err(|e| e.to_string())?;
    if let Some(hid) = map.get(udid) {
        return Ok(hid.clone());
    }
    let hid = Arc::new(Hid::new(device)?);
    map.insert(udid.to_string(), hid.clone());
    Ok(hid)
}

/// Esquece o cliente (o aparelho desligou: o próximo boot precisa de outro).
pub fn forget(udid: &str) {
    if let Ok(mut map) = clients().lock() {
        map.remove(udid);
    }
}
