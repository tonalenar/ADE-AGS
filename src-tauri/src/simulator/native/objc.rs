//! Chamadas ao runtime do Objective-C para as classes privadas do CoreSimulator e do SimulatorKit.
//!
//! Por que não `msg_send!`: os objetos de tela e de IO do simulador são proxies remotos (`ROCKRemoteProxy`) que
//! só encaminham as mensagens, então o método não existe na classe, e em debug o `msg_send!` do objc2 entra em
//! pânico ("method not found") antes de mandar. Aqui a mensagem vai direto pelo `objc_msgSend`, com a
//! assinatura conferida no binário (ver `docs/ade-ags/SIMULADOR_IOS.md`). No arm64 o `objc_msgSend` serve para
//! qualquer retorno, inclusive estruturas.

use std::ffi::{c_char, CStr};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_msgSend();
}

/// `call!(obj, sel!(a:b:), x: T, y: U => R)`: manda a mensagem com essa assinatura exata.
macro_rules! call {
    ($obj:expr, $sel:expr $(, $arg:expr => $ty:ty)* ; -> $ret:ty) => {{
        let f: unsafe extern "C" fn(*mut objc2::runtime::AnyObject, objc2::runtime::Sel $(, $ty)*) -> $ret =
            std::mem::transmute($crate::simulator::native::objc::msg_send_ptr());
        f($obj as *mut objc2::runtime::AnyObject, $sel $(, $arg)*)
    }};
}
pub(crate) use call;

pub fn msg_send_ptr() -> unsafe extern "C" fn() {
    objc_msgSend
}

/// A classe pelo nome, se o framework dela está carregado.
pub fn class(name: &CStr) -> Option<*mut AnyObject> {
    AnyClass::get(name).map(|c| c as *const AnyClass as *mut AnyObject)
}

/// Um objeto devolvido sem posse (+0): retém para guardar.
///
/// # Safety
/// `ptr` é nulo ou um objeto vivo.
pub unsafe fn retain(ptr: *mut AnyObject) -> Option<Retained<AnyObject>> {
    unsafe { Retained::retain(ptr) }
}

/// `-[obj respondsToSelector:]`.
///
/// # Safety
/// `obj` é um objeto vivo.
pub unsafe fn responds(obj: *mut AnyObject, sel: Sel) -> bool {
    unsafe { call!(obj, objc2::sel!(respondsToSelector:), sel => Sel; -> bool) }
}

/// `NSString` → `String`.
///
/// # Safety
/// `s` é nulo ou um `NSString` vivo.
pub unsafe fn string(s: *mut AnyObject) -> String {
    if s.is_null() {
        return String::new();
    }
    let raw: *const c_char = unsafe { call!(s, objc2::sel!(UTF8String); -> *const c_char) };
    if raw.is_null() { String::new() } else { unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned() }
}

/// Um `NSString` novo (autorelease), para passar como argumento.
pub fn ns_string(text: &str) -> Retained<objc2_foundation::NSString> {
    objc2_foundation::NSString::from_str(text)
}

/// Um objeto que vive em outra thread: os do simulador (dispositivo, cliente de HID) aceitam mensagens de
/// qualquer thread, porque por baixo é XPC; o `Retained` só não sabe disso.
pub struct Shared(pub Retained<AnyObject>);
// SAFETY: só se guardam aqui objetos do CoreSimulator/SimulatorKit, que falam com o serviço por XPC e
// são feitos para ser chamados de filas quaisquer (o próprio Simulator os usa de várias).
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    pub fn ptr(&self) -> *mut AnyObject {
        Retained::as_ptr(&self.0) as *mut AnyObject
    }
}

/// As assinaturas dos blocos que vão para o simulador. O ROCKit (que encaminha a chamada ao serviço do
/// CoreSimulator) serializa o bloco pela assinatura dele e recusa um sem ("Block is missing signature field");
/// em Objective-C o clang a põe sozinho, no Rust é preciso dizer. Iguais às do protocolo `SimScreen`.
pub mod blocks {
    use std::ffi::CStr;

    use block2::ManualBlockEncoding;
    use objc2::runtime::AnyObject;

    /// `void (^)(void)`: quadro novo.
    pub struct Frame;
    // SAFETY: a assinatura corresponde aos tipos.
    unsafe impl ManualBlockEncoding for Frame {
        type Arguments = ();
        type Return = ();
        const ENCODING_CSTR: &'static CStr = c"v8@?0";
    }

    /// `void (^)(IOSurface *, IOSurface *)`: a superfície sem e com máscara mudou.
    pub struct Surfaces;
    // SAFETY: idem.
    unsafe impl ManualBlockEncoding for Surfaces {
        type Arguments = (*mut AnyObject, *mut AnyObject);
        type Return = ();
        const ENCODING_CSTR: &'static CStr = c"v24@?0@\"IOSurface\"8@\"IOSurface\"16";
    }

    /// `void (^)(id<SimScreenProperties>)`.
    pub struct Properties;
    // SAFETY: idem.
    unsafe impl ManualBlockEncoding for Properties {
        type Arguments = (*mut AnyObject,);
        type Return = ();
        const ENCODING_CSTR: &'static CStr = c"v16@?0@\"<SimScreenProperties>\"8";
    }

    /// `void (^)(NSArray *)`: os retângulos que mudaram.
    pub struct Damage;
    // SAFETY: idem.
    unsafe impl ManualBlockEncoding for Damage {
        type Arguments = (*mut AnyObject,);
        type Return = ();
        const ENCODING_CSTR: &'static CStr = c"v16@?0@\"NSArray\"8";
    }

    /// `void (^)(NSError *)`: o envio de HID terminou.
    pub struct Done;
    // SAFETY: idem.
    unsafe impl ManualBlockEncoding for Done {
        type Arguments = (*mut AnyObject,);
        type Return = ();
        const ENCODING_CSTR: &'static CStr = c"v16@?0@\"NSError\"8";
    }

}
