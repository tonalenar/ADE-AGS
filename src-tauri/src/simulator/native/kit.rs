//! Carrega o CoreSimulator e o SimulatorKit do Xcode instalado e acha as funções do Indigo (o HID do
//! simulador). Uma vez por processo; sem Xcode, cada chamada devolve o mesmo erro explicando o que falta.

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use crate::util::spawn;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

/// `IndigoHIDMessageForMouseNSEvent(ponto0, ponto1, alvo, tipo do NSEvent, tamanho, borda)`. Com tamanho
/// (1, 1) o ponto é a proporção da tela, como o próprio SimulatorKit chama.
pub type MouseFn = unsafe extern "C" fn(*const CGPoint, *const CGPoint, u32, u64, CGSize, u64) -> *mut c_void;
/// `IndigoHIDMessageForButton(origem, direção, alvo)`.
pub type ButtonFn = unsafe extern "C" fn(i32, i32, i32) -> *mut c_void;
/// `IndigoHIDMessageForKeyboardArbitrary(uso HID, direção)`.
pub type KeyFn = unsafe extern "C" fn(u32, u32) -> *mut c_void;

pub struct Kit {
    pub mouse: MouseFn,
    pub button: ButtonFn,
    pub key: KeyFn,
    pub developer_dir: PathBuf,
}

const CORE_SIMULATOR: &str = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator";

/// A pasta Developer do Xcode escolhido (`xcode-select -p`), ou a do Xcode em /Applications.
fn developer_dir() -> PathBuf {
    let mut cmd = spawn::hidden_command("xcode-select");
    cmd.arg("-p");
    if let Ok(out) = spawn::output(&mut cmd, Duration::from_secs(5)) {
        let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !dir.is_empty() && !dir.contains("CommandLineTools") {
            return PathBuf::from(dir);
        }
    }
    PathBuf::from("/Applications/Xcode.app/Contents/Developer")
}

/// O SimulatorKit mudou de lugar entre versões do Xcode: hoje fica em `Contents/SharedFrameworks`.
fn simulator_kit(developer: &Path) -> Option<PathBuf> {
    let contents = developer.parent()?;
    [
        contents.join("SharedFrameworks/SimulatorKit.framework/SimulatorKit"),
        developer.join("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

fn open(path: &Path) -> Result<*mut c_void, String> {
    let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: caminho terminado em zero; os frameworks do Xcode podem ser carregados mais de uma vez.
    let handle = unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_NOW) };
    if handle.is_null() { Err(format!("Não consegui carregar {}.", path.display())) } else { Ok(handle) }
}

fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
    let c = CString::new(name).map_err(|e| e.to_string())?;
    // SAFETY: `handle` veio de `dlopen` e nunca é fechado.
    let ptr = unsafe { libc::dlsym(handle, c.as_ptr()) };
    if ptr.is_null() {
        Err(format!("Esta versão do Xcode não tem `{name}`: o simulador embutido ainda não a conhece."))
    } else {
        Ok(ptr)
    }
}

fn load() -> Result<Kit, String> {
    let developer_dir = developer_dir();
    if !Path::new(CORE_SIMULATOR).exists() {
        return Err("Não encontrei o CoreSimulator. Instale o Xcode e abra-o uma vez para instalar os simuladores.".into());
    }
    open(Path::new(CORE_SIMULATOR))?;
    let kit_path = simulator_kit(&developer_dir).ok_or_else(|| {
        format!("Não encontrei o SimulatorKit do Xcode em {}. Confira o `xcode-select -p`.", developer_dir.display())
    })?;
    let kit = open(&kit_path)?;
    // SAFETY: as assinaturas foram conferidas no binário do SimulatorKit (Xcode 27) e são as que ele mesmo usa.
    unsafe {
        Ok(Kit {
            mouse: std::mem::transmute::<*mut c_void, MouseFn>(symbol(kit, "IndigoHIDMessageForMouseNSEvent")?),
            button: std::mem::transmute::<*mut c_void, ButtonFn>(symbol(kit, "IndigoHIDMessageForButton")?),
            key: std::mem::transmute::<*mut c_void, KeyFn>(symbol(kit, "IndigoHIDMessageForKeyboardArbitrary")?),
            developer_dir,
        })
    }
}

/// Os frameworks carregados, ou por que não dá.
pub fn kit() -> Result<&'static Kit, String> {
    static KIT: OnceLock<Result<Kit, String>> = OnceLock::new();
    KIT.get_or_init(load).as_ref().map_err(Clone::clone)
}
