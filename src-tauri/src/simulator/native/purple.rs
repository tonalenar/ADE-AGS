//! Girar o iOS do aparelho. Não há `simctl` para isso, e o Xcode 27 não traz mais o app Simulator: o giro vai
//! como um `GSEvent` de orientação (tipo 50) para a `PurpleWorkspacePort` de dentro do aparelho, que o
//! `-[SimDevice lookup:error:]` devolve como uma porta mach do lado do Mac. O `backboardd` lê o evento ("Got an
//! orientation event from a GSEvent"), muda a orientação do aparelho e avisa os apps, como no giro de verdade.
//! O formato da mensagem está em `model::orientation_message` (medido contra o iOS 27).

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::sel;

use super::device;
use super::objc::{call, ns_string};
use crate::simulator::model;

#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
    fn mach_msg(msg: *mut u8, option: i32, send_size: u32, rcv_size: u32, rcv_name: u32, timeout: u32, notify: u32) -> i32;
    fn mach_port_deallocate(task: u32, name: u32) -> i32;
    static mach_task_self_: u32;
}

const MACH_SEND_MSG: i32 = 0x0000_0001;
const MACH_SEND_TIMEOUT: i32 = 0x0000_0010;
/// Quanto esperar a fila da porta aceitar a mensagem (ms): o `backboardd` lê na hora.
const SEND_TIMEOUT_MS: u32 = 1000;

/// Põe o aparelho na orientação `orientation` (`UIDeviceOrientation`: 1 a 4).
pub fn orient(udid: &str, orientation: u32) -> Result<(), String> {
    let dev = device::find(udid)?;
    if device::state(&dev) != model::STATE_BOOTED {
        return Err("O aparelho está desligado. Ligue-o primeiro.".into());
    }
    let name = ns_string("PurpleWorkspacePort");
    let mut error: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: `lookup:error:` de SimDevice, tipo "I32@0:8@16^@24" (o mesmo de `dtu.rs`); devolve um direito de
    // envio para a porta, que é solto abaixo.
    let port = unsafe {
        call!(dev.ptr(), sel!(lookup:error:), Retained::as_ptr(&name) as *mut AnyObject => *mut AnyObject, &mut error => *mut *mut AnyObject; -> u32)
    };
    if port == 0 || port == u32::MAX {
        return Err("O aparelho não abriu a porta de eventos do iOS (PurpleWorkspacePort).".into());
    }
    let mut msg = model::orientation_message(port, orientation);
    // SAFETY: `msg` é uma mensagem mach completa e simples (sem descritores), do tamanho declarado no
    // cabeçalho; só envio, com prazo. A porta é nossa (veio do lookup) e é solta depois, com ou sem sucesso.
    let kr = unsafe {
        let kr = mach_msg(msg.as_mut_ptr(), MACH_SEND_MSG | MACH_SEND_TIMEOUT, msg.len() as u32, 0, 0, SEND_TIMEOUT_MS, 0);
        mach_port_deallocate(mach_task_self_, port);
        kr
    };
    if kr != 0 {
        return Err(format!("O iOS não recebeu o giro (mach_msg {kr:#x})."));
    }
    Ok(())
}
