//! Monta el directorio de una skill dentro de un proyecto.
//!
//! El mecanismo preferido es un symlink de directorio: un archivo escrito en la copia
//! global aparece al instante del otro lado, y es lo que git ya entiende en Unix. En
//! Windows crearlo exige `SeCreateSymbolicLinkPrivilege` (Developer Mode o
//! administrador). Sin ese privilegio el sistema responde 1314
//! (`ERROR_PRIVILEGE_NOT_HELD`).
//!
//! El respaldo es un junction de directorio (`IO_REPARSE_TAG_MOUNT_POINT`, el mismo
//! `mklink /J`). No pide ese privilegio para un directorio local del usuario, y también
//! es un montaje en vivo: no hay una segunda copia que pueda quedar desactualizada, ni
//! un protocolo de sincronización que mantener. Un hard link no aplica a directorios.
//! Una copia quedaría muda cuando la skill global se actualiza; no se usa.
//!
//! Quitar el montaje nunca entra al destino. `remove_dir_all` sobre un junction borraría
//! la skill global.

use std::io;
use std::path::{Path, PathBuf};

use crate::util::external_path;

/// El error de Windows cuando el proceso no puede crear symlinks.
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

/// Un symlink (cualquier plataforma) o un junction de directorio (Windows).
///
/// Una carpeta real del usuario no lo es: `read_link` falla y no se toca.
pub fn is_mount(path: &Path) -> bool {
    let Ok(meta) = path.symlink_metadata() else { return false };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        // Un junction es un directorio con reparse point. `is_symlink` solo reconoce
        // `IO_REPARSE_TAG_SYMLINK`; Rust sí lee el destino de un mount point.
        meta.is_dir() && std::fs::read_link(path).is_ok()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Misma ruta, aunque una de las dos haya pasado por `canonicalize` (`\\?\` en Windows).
pub fn same_path(a: &Path, b: &Path) -> bool {
    if a == b || external_path(a) == external_path(b) {
        return true;
    }
    match (std::path::absolute(a), std::path::absolute(b)) {
        (Ok(a), Ok(b)) => a == b || external_path(&a) == external_path(&b),
        _ => false,
    }
}

/// `target` vive dentro de `root`. Compara la forma Win32, no el texto con `\\?\`.
pub fn points_inside(target: &Path, root: &Path) -> bool {
    external_path(target).starts_with(external_path(root))
}

/// Crea el montaje de `target` en `link`.
///
/// Prueba el symlink de directorio. Solo si Windows niega el privilegio crea un
/// junction. Cualquier otro error se propaga: no se disfraza de éxito con una copia.
pub fn mount_dir(target: &Path, link: &Path) -> io::Result<()> {
    match symlink::symlink_dir(target, link) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => {
            #[cfg(windows)]
            {
                create_junction(target, link)
            }
            #[cfg(not(windows))]
            {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

/// Saca el montaje y deja el destino intacto.
///
/// `remove_symlink_auto` abre el enlace sin `FILE_FLAG_OPEN_REPARSE_POINT`, sigue el
/// junction y después se niega a borrarlo. `remove_dir` quita el reparse point. Nunca
/// `remove_dir_all`, que entraría a la skill global.
pub fn remove_mount(path: &Path) -> io::Result<()> {
    if path.symlink_metadata().is_err() {
        return Ok(());
    }
    if !is_mount(path) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path is not a mount"));
    }
    // `remove_dir` en un junction o en un symlink de directorio quita el enlace.
    // En un symlink de archivo falla, y `remove_file` lo quita. Ninguno de los dos
    // entra al destino: el primero no sigue el reparse point.
    std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path))
}

#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> io::Result<()> {
    let absolute = std::path::absolute(target)?;
    let substitute = nt_prefix(&absolute);
    std::fs::create_dir(link)?;
    if let Err(error) = set_mount_point(link, &substitute, &absolute) {
        let _ = std::fs::remove_dir(link);
        return Err(error);
    }
    Ok(())
}

/// Crea siempre un junction de directorio en Windows, sin intentar primero un symlink.
///
/// Los worktrees usan este montaje para `node_modules`: no debe depender de que el usuario
/// tenga habilitado el privilegio de symlink.
#[cfg(windows)]
pub(crate) fn junction_dir(target: &Path, link: &Path) -> io::Result<()> {
    create_junction(target, link)
}

/// `\??\C:\...` o `\??\UNC\server\share\...`, que es lo que el reparse point guarda.
#[cfg(windows)]
fn nt_prefix(path: &Path) -> PathBuf {
    let win32 = external_path(path);
    let text = win32.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\") {
        PathBuf::from(format!(r"\??\UNC\{rest}"))
    } else {
        PathBuf::from(format!(r"\??\{text}"))
    }
}

#[cfg(windows)]
fn set_mount_point(link: &Path, substitute: &Path, print: &Path) -> io::Result<()> {
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;

    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

    let sub = wide(substitute);
    let print = wide(print);
    let sub_bytes = (sub.len() * 2) as u16;
    let print_bytes = (print.len() * 2) as u16;

    let mut path_buffer: Vec<u8> = Vec::with_capacity((sub.len() + print.len() + 2) * 2);
    for unit in &sub {
        path_buffer.extend_from_slice(&unit.to_le_bytes());
    }
    path_buffer.extend_from_slice(&0u16.to_le_bytes());
    let print_offset = path_buffer.len() as u16;
    for unit in &print {
        path_buffer.extend_from_slice(&unit.to_le_bytes());
    }
    path_buffer.extend_from_slice(&0u16.to_le_bytes());

    // Los 8 bytes de offsets van después del encabezado de 8 y antes del buffer.
    let data_length = (8 + path_buffer.len()) as u16;
    let mut buffer: Vec<u8> = Vec::with_capacity(8 + data_length as usize);
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend_from_slice(&data_length.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&sub_bytes.to_le_bytes());
    buffer.extend_from_slice(&print_offset.to_le_bytes());
    buffer.extend_from_slice(&print_bytes.to_le_bytes());
    buffer.extend_from_slice(&path_buffer);

    let link = std::path::absolute(link)?;
    let mut name = wide(&link);
    name.push(0);
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = Handle(handle);
    let mut returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle.0,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
struct Handle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cc-mount-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn el_montaje_ve_los_cambios_de_la_copia_global_y_borrarlo_no_la_toca() {
        let root = scratch("vivo");
        let source = root.join("global").join("mi carpeta").join("café");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "uno\n").unwrap();
        let link = root.join("proyecto").join(".claude").join("skills").join("cafe");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();

        mount_dir(&source, &link).unwrap();
        assert!(is_mount(&link), "symlink o junction, nunca una copia");
        assert!(same_path(&std::fs::read_link(&link).unwrap(), &source));
        assert_eq!(std::fs::read_to_string(link.join("SKILL.md")).unwrap(), "uno\n");

        // Escrito DESPUÉS del montaje: una copia habría quedado en "uno".
        std::fs::write(source.join("SKILL.md"), "dos\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "dos\n",
            "el montaje tiene que seguir a la copia global"
        );

        remove_mount(&link).unwrap();
        assert!(!link.exists());
        assert_eq!(std::fs::read_to_string(source.join("SKILL.md")).unwrap(), "dos\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn una_carpeta_real_no_es_un_montaje() {
        let root = scratch("real");
        let dir = root.join("propia");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_mount(&dir));
        let _ = std::fs::remove_dir_all(&root);
    }
}
