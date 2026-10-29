//! Os aparelhos do Xcode pelo CoreSimulator: listar, ligar e desligar, sem o app Simulator.

use std::ptr::null_mut;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::sel;

use super::kit;
use super::objc::{call, class, ns_string, retain, string, Shared};
use crate::simulator::model::{self, Device};

/// `SimServiceContext` do Xcode escolhido → o conjunto de aparelhos padrão (o mesmo do `simctl`).
fn device_set() -> Result<*mut AnyObject, String> {
    let kit = kit::kit()?;
    let ctx_class = class(c"SimServiceContext").ok_or("O CoreSimulator não tem SimServiceContext.")?;
    let dir = ns_string(&kit.developer_dir.to_string_lossy());
    let mut error: *mut AnyObject = null_mut();
    // SAFETY: assinaturas públicas do CoreSimulator (as mesmas que o simctl usa); objetos +0.
    unsafe {
        let ctx = call!(ctx_class, sel!(sharedServiceContextForDeveloperDir:error:),
            Retained::as_ptr(&dir) as *mut AnyObject => *mut AnyObject, &mut error => *mut *mut AnyObject; -> *mut AnyObject);
        if ctx.is_null() {
            return Err("O serviço do CoreSimulator não respondeu.".into());
        }
        let set = call!(ctx, sel!(defaultDeviceSetWithError:), &mut error => *mut *mut AnyObject; -> *mut AnyObject);
        if set.is_null() { Err("Não consegui ler os aparelhos do Xcode.".into()) } else { Ok(set) }
    }
}

/// A tela do tipo de aparelho em pontos. `mainScreenSize` vem em pixels.
///
/// # Safety
/// `kind` é nulo ou um `SimDeviceType` vivo.
unsafe fn screen_points(kind: *mut AnyObject) -> (f64, f64) {
    if kind.is_null() {
        return (0.0, 0.0);
    }
    unsafe {
        let size = call!(kind, sel!(mainScreenSize); -> kit::CGSize);
        let scale = f64::from(call!(kind, sel!(mainScreenScale); -> f32));
        if scale < 1.0 { (0.0, 0.0) } else { (size.width / scale, size.height / scale) }
    }
}

/// # Safety
/// `device` é um `SimDevice` vivo.
unsafe fn describe(device: *mut AnyObject) -> Option<Device> {
    unsafe {
        let name = string(call!(device, sel!(name); -> *mut AnyObject));
        let uuid = call!(device, sel!(UDID); -> *mut AnyObject);
        let udid = string(call!(uuid, sel!(UUIDString); -> *mut AnyObject));
        let runtime_obj = call!(device, sel!(runtime); -> *mut AnyObject);
        let runtime = if runtime_obj.is_null() { String::new() } else { string(call!(runtime_obj, sel!(name); -> *mut AnyObject)) };
        let family = model::family_of(&name, &runtime)?;
        let state = call!(device, sel!(state); -> u64);
        let (width, height) = screen_points(call!(device, sel!(deviceType); -> *mut AnyObject));
        Some(Device { udid, name, runtime, family: family.into(), state: model::state_name(state).into(), width, height })
    }
}

/// Os iPhones e iPads instalados, na ordem do seletor.
pub fn list() -> Result<Vec<Device>, String> {
    autoreleasepool(|_| {
        let set = device_set()?;
        let mut out = Vec::new();
        // SAFETY: `devices` é um NSArray de SimDevice.
        unsafe {
            let devices = call!(set, sel!(devices); -> *mut AnyObject);
            let count = call!(devices, sel!(count); -> usize);
            for i in 0..count {
                let device = call!(devices, sel!(objectAtIndex:), i => usize; -> *mut AnyObject);
                out.extend(describe(device));
            }
        }
        model::sort_devices(&mut out);
        Ok(out)
    })
}

/// O `SimDevice` de um UDID, retido para usar fora do pool.
pub fn find(udid: &str) -> Result<Shared, String> {
    autoreleasepool(|_| {
        let set = device_set()?;
        // SAFETY: `devices` é um NSArray de SimDevice; o encontrado é retido.
        unsafe {
            let devices = call!(set, sel!(devices); -> *mut AnyObject);
            let count = call!(devices, sel!(count); -> usize);
            for i in 0..count {
                let device = call!(devices, sel!(objectAtIndex:), i => usize; -> *mut AnyObject);
                let uuid = call!(device, sel!(UDID); -> *mut AnyObject);
                if string(call!(uuid, sel!(UUIDString); -> *mut AnyObject)).eq_ignore_ascii_case(udid) {
                    return retain(device).map(Shared).ok_or_else(|| "O aparelho sumiu.".to_string());
                }
            }
        }
        Err(format!("O aparelho {udid} não existe mais no Xcode."))
    })
}

pub fn state(device: &Shared) -> u64 {
    // SAFETY: `device` é um SimDevice retido.
    unsafe { call!(device.ptr(), sel!(state); -> u64) }
}

fn error_text(error: *mut AnyObject) -> String {
    if error.is_null() {
        return "o CoreSimulator não disse por quê".into();
    }
    // SAFETY: é um NSError.
    unsafe { string(call!(error, sel!(localizedDescription); -> *mut AnyObject)) }
}

/// Liga sem `persist`: o aparelho fica preso a este processo e desliga junto com a ADE, mesmo se ela cair
/// (nada de simulador órfão gastando memória). Bloqueia até o launchd do aparelho subir (o iOS ainda termina de
/// iniciar depois); chame fora da thread da interface.
pub fn boot(device: &Shared) -> Result<(), String> {
    if state(device) == model::STATE_BOOTED {
        return Ok(());
    }
    autoreleasepool(|_| {
        let dict_class = class(c"NSMutableDictionary").ok_or("Sem Foundation.")?;
        let number_class = class(c"NSNumber").ok_or("Sem Foundation.")?;
        // SAFETY: Foundation pública; `bootWithOptions:error:` é a chamada do simctl.
        unsafe {
            let options = call!(dict_class, sel!(dictionary); -> *mut AnyObject);
            let no = call!(number_class, sel!(numberWithBool:), false => bool; -> *mut AnyObject);
            let persist = ns_string("persist");
            call!(options, sel!(setObject:forKey:), no => *mut AnyObject, Retained::as_ptr(&persist) as *mut AnyObject => *mut AnyObject; -> ());
            let mut error: *mut AnyObject = null_mut();
            let ok = call!(device.ptr(), sel!(bootWithOptions:error:), options => *mut AnyObject, &mut error => *mut *mut AnyObject; -> bool);
            if ok { Ok(()) } else { Err(format!("Não consegui ligar o aparelho: {}.", error_text(error))) }
        }
    })
}

pub fn shutdown(device: &Shared) -> Result<(), String> {
    if state(device) == model::STATE_SHUTDOWN {
        return Ok(());
    }
    autoreleasepool(|_| {
        let mut error: *mut AnyObject = null_mut();
        // SAFETY: `shutdownWithError:` é a chamada do simctl.
        let ok = unsafe { call!(device.ptr(), sel!(shutdownWithError:), &mut error => *mut *mut AnyObject; -> bool) };
        if ok { Ok(()) } else { Err(format!("Não consegui desligar o aparelho: {}.", error_text(error))) }
    })
}
