//! O HID novo do simulador (Xcode 27, CoreSimulator ≥ 1155.4): o `dtuhidd`, que o CoreSimulator põe dentro do
//! iOS, por XPC. Nessas versões o iOS descarta botão e teclado do Indigo legado e o toque por ele fica
//! intermitente (observação do idb, da Meta, que usa este caminho sem volta).
//!
//! A conexão: `-[SimDevice lookup:error:]` devolve a porta mach do serviço do digitizer dentro do aparelho;
//! `xpc_endpoint_create_mach_port_4sim` a embrulha e `xpc_connection_enable_sim2host_4sim` (antes do resume)
//! deixa o payload atravessar do Mac para o simulador. Cada evento é um dicionário XPC:
//! `{messageType, isBarrier, featureIdentifier, payload}`. Toque, botões e teclado vão pela mesma conexão.
//! Nomes conferidos no `CoreDeviceUtilities.framework` injetado; o envelope vem do idb e do Siniulator.
//!
//! O `dtuhidd` sobe sob demanda e pode sair sozinho (`EnablePressuredExit`): com a conexão morta, o próximo
//! evento abre outra. Tudo roda na fila serial do HID, nunca na thread da interface.

use std::ffi::{c_char, c_void, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::objc::{call, ns_string, Shared};

type Xpc = *mut c_void;

#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
    fn xpc_endpoint_create_mach_port_4sim(port: u32) -> Xpc;
    fn xpc_connection_create_from_endpoint(endpoint: Xpc) -> Xpc;
    fn xpc_connection_enable_sim2host_4sim(connection: Xpc);
    fn xpc_connection_set_target_queue(connection: Xpc, queue: *mut c_void);
    fn xpc_connection_set_event_handler(connection: Xpc, handler: *mut c_void);
    fn xpc_connection_resume(connection: Xpc);
    fn xpc_connection_cancel(connection: Xpc);
    fn xpc_connection_send_message(connection: Xpc, message: Xpc);
    fn xpc_connection_send_message_with_reply(connection: Xpc, message: Xpc, queue: *mut c_void, handler: *mut c_void);
    fn xpc_dictionary_create(keys: *const *const c_char, values: *const Xpc, count: usize) -> Xpc;
    fn xpc_dictionary_set_string(dict: Xpc, key: *const c_char, value: *const c_char);
    fn xpc_dictionary_set_bool(dict: Xpc, key: *const c_char, value: bool);
    fn xpc_dictionary_set_uint64(dict: Xpc, key: *const c_char, value: u64);
    fn xpc_dictionary_set_double(dict: Xpc, key: *const c_char, value: f64);
    fn xpc_dictionary_set_value(dict: Xpc, key: *const c_char, value: Xpc);
    fn xpc_get_type(object: Xpc) -> *const c_void;
    fn xpc_release(object: Xpc);
    static _xpc_type_error: u8;
}

const DIGITIZER: &str = "com.apple.coredevice.feature.remote.hid.digitizer";
/// Quanto esperar o `dtuhidd` responder ao abrir (ele pode estar subindo, logo depois do boot).
const LIVENESS_WAIT: Duration = Duration::from_secs(4);
const LIVENESS_TRIES: usize = 3;

/// Fases do digitizer: começa, move, termina.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Touch {
    Start = 0,
    Position = 1,
    End = 2,
}

/// Um dicionário XPC a montar; liberado no fim.
struct Dict(Xpc);

impl Dict {
    fn new() -> Dict {
        // SAFETY: dicionário vazio, +1.
        Dict(unsafe { xpc_dictionary_create(std::ptr::null(), std::ptr::null(), 0) })
    }
    fn key(k: &str) -> CString {
        CString::new(k).expect("chave sem zero")
    }
    fn string(self, k: &str, v: &str) -> Dict {
        let v = CString::new(v).expect("texto sem zero");
        // SAFETY: dicionário vivo, strings terminadas em zero (o XPC copia).
        unsafe { xpc_dictionary_set_string(self.0, Self::key(k).as_ptr(), v.as_ptr()) };
        self
    }
    fn bool(self, k: &str, v: bool) -> Dict {
        // SAFETY: idem.
        unsafe { xpc_dictionary_set_bool(self.0, Self::key(k).as_ptr(), v) };
        self
    }
    fn u64(self, k: &str, v: u64) -> Dict {
        // SAFETY: idem.
        unsafe { xpc_dictionary_set_uint64(self.0, Self::key(k).as_ptr(), v) };
        self
    }
    fn f64(self, k: &str, v: f64) -> Dict {
        // SAFETY: idem.
        unsafe { xpc_dictionary_set_double(self.0, Self::key(k).as_ptr(), v) };
        self
    }
    fn dict(self, k: &str, v: Dict) -> Dict {
        // SAFETY: idem; o dicionário de fora retém o de dentro, e `v` solta o seu ao sair.
        unsafe { xpc_dictionary_set_value(self.0, Self::key(k).as_ptr(), v.0) };
        self
    }
}

impl Drop for Dict {
    fn drop(&mut self) {
        // SAFETY: +1 de `xpc_dictionary_create`.
        unsafe { xpc_release(self.0) };
    }
}

fn message(kind: &str, barrier: bool, payload: Dict) -> Dict {
    Dict::new().string("messageType", kind).bool("isBarrier", barrier).string("featureIdentifier", DIGITIZER).dict("payload", payload)
}

struct Connection {
    xpc: Xpc,
    dead: Arc<AtomicBool>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        // SAFETY: a conexão é nossa (+1); cancelar antes de soltar.
        unsafe {
            xpc_connection_cancel(self.xpc);
            xpc_release(self.xpc);
        }
    }
}

pub struct Dtu {
    device: Shared,
    queue: DispatchRetained<DispatchQueue>,
    connection: Mutex<Option<Connection>>,
}

// SAFETY: a conexão XPC aceita mensagens de qualquer thread; o resto é retido e travado.
unsafe impl Send for Dtu {}
unsafe impl Sync for Dtu {}

impl Dtu {
    /// Abre a conexão e confere que o `dtuhidd` responde. Bloqueia (até ~12 s): chame fora da interface.
    pub fn open(device: &Shared) -> Result<Dtu, String> {
        // SAFETY: retém o SimDevice para reabrir a conexão depois.
        let device = Shared(unsafe { Retained::retain(device.ptr()) }.ok_or("aparelho nulo")?);
        let dtu = Dtu { device, queue: DispatchQueue::new("ade.simulator.dtuhid", None), connection: Mutex::new(None) };
        let mut last = String::new();
        for _ in 0..LIVENESS_TRIES {
            match dtu.connect().and_then(|c| dtu.alive(&c).map(|()| c)) {
                Ok(c) => {
                    *dtu.connection.lock().map_err(|e| e.to_string())? = Some(c);
                    return Ok(dtu);
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn connect(&self) -> Result<Connection, String> {
        let name = ns_string(DIGITIZER);
        let mut error: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: `lookup:error:` de SimDevice, tipo "I32@0:8@16^@24" conferido no binário.
        let port = unsafe {
            call!(self.device.ptr(), sel!(lookup:error:), Retained::as_ptr(&name) as *mut AnyObject => *mut AnyObject, &mut error => *mut *mut AnyObject; -> u32)
        };
        if port == 0 || port == u32::MAX {
            return Err("O aparelho não tem o serviço de toque novo (dtuhidd).".into());
        }
        let dead = Arc::new(AtomicBool::new(false));
        let on_event = dead.clone();
        // Erro na conexão (o serviço saiu): o próximo evento abre outra.
        let handler = RcBlock::new(move |event: Xpc| {
            // SAFETY: o XPC entrega um objeto vivo durante o bloco.
            if unsafe { xpc_get_type(event) } == unsafe { &_xpc_type_error } as *const u8 as *const c_void {
                on_event.store(true, Ordering::Release);
            }
        });
        // SAFETY: a ordem do idb; `enable_sim2host` antes do resume. O endpoint consome o direito de envio da
        // porta; endpoint e conexão vêm +1 (o endpoint é solto depois de criar a conexão).
        let xpc = unsafe {
            let endpoint = xpc_endpoint_create_mach_port_4sim(port);
            let xpc = xpc_connection_create_from_endpoint(endpoint);
            xpc_release(endpoint);
            if xpc.is_null() {
                return Err("Não abri a conexão com o dtuhidd.".into());
            }
            xpc_connection_enable_sim2host_4sim(xpc);
            xpc_connection_set_target_queue(xpc, &*self.queue as *const DispatchQueue as *mut c_void);
            xpc_connection_set_event_handler(xpc, &*handler as *const _ as *mut c_void);
            xpc_connection_resume(xpc);
            xpc
        };
        Ok(Connection { xpc, dead })
    }

    /// O `dtuhidd` responde? Uma tecla 0 solta, com resposta (o mesmo teste do idb).
    fn alive(&self, connection: &Connection) -> Result<(), String> {
        let probe = message("IndigoKeyboardButtonEvent", true, Dict::new().u64("usageCode", 0).u64("state", 2));
        let (tx, rx) = mpsc::channel::<bool>();
        let reply = RcBlock::new(move |answer: Xpc| {
            // SAFETY: objeto vivo durante o bloco.
            let error = unsafe { xpc_get_type(answer) } == unsafe { &_xpc_type_error } as *const u8 as *const c_void;
            let _ = tx.send(!error);
        });
        // SAFETY: conexão ativa; o XPC copia o bloco.
        unsafe {
            xpc_connection_send_message_with_reply(connection.xpc, probe.0, &*self.queue as *const DispatchQueue as *mut c_void, &*reply as *const _ as *mut c_void);
        }
        match rx.recv_timeout(LIVENESS_WAIT) {
            Ok(true) => Ok(()),
            Ok(false) => Err("O dtuhidd recusou a conexão.".into()),
            Err(_) => Err("O dtuhidd não respondeu.".into()),
        }
    }

    /// Manda pela fila do HID (a ordem fica a de chegada; a interface não espera nada).
    fn send(self: &Arc<Self>, event: Dict) {
        struct Pending(Dict);
        // SAFETY: o dicionário só é lido pela fila depois daqui.
        unsafe impl Send for Pending {}
        let event = Pending(event);
        let this = self.clone();
        self.queue.exec_async(move || {
            let event = event;
            let Ok(mut current) = this.connection.lock() else { return };
            if current.as_ref().is_none_or(|c| c.dead.load(Ordering::Acquire)) {
                *current = this.connect().ok();
            }
            if let Some(c) = current.as_ref() {
                // SAFETY: conexão ativa; o XPC copia a mensagem.
                unsafe { xpc_connection_send_message(c.xpc, event.0 .0) };
            }
        });
    }

    /// Um dedo em `ratio` (0..1, origem no topo).
    pub fn touch(self: &Arc<Self>, ratio: (f64, f64), phase: Touch) {
        let point = Dict::new().f64("x", ratio.0).f64("y", ratio.1);
        let payload = Dict::new().dict("pointOne", point).u64("eventType", phase as u64).u64("edge", 0).u64("target", 0);
        self.send(message("IndigoDigitizerEvent", false, payload));
    }

    /// Um botão pelo uso HID da página de consumo (0x0C).
    pub fn button(self: &Arc<Self>, usage: u64, down: bool) {
        let payload = Dict::new().u64("usagePage", 0x0C).u64("usageCode", usage).u64("state", if down { 1 } else { 2 });
        self.send(message("IndigoButtonEvent", false, payload));
    }

    pub fn key(self: &Arc<Self>, usage: u32, down: bool) {
        let payload = Dict::new().u64("usageCode", u64::from(usage)).u64("state", if down { 1 } else { 2 });
        self.send(message("IndigoKeyboardButtonEvent", false, payload));
    }
}

/// Os botões do Indigo legado (`model::button_source`) no uso HID que o `dtuhidd` espera.
pub fn button_usage(source: i32) -> Option<u64> {
    match source {
        0 => Some(0x40),             // home
        1 | 0xbb8 => Some(0x30),     // lock, side
        0x400002 => Some(0xCF),      // siri
        _ => None,
    }
}
