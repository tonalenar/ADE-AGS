//! Per-user Start Menu identity. No installer, elevation or shell script is needed.
use std::path::{Path, PathBuf};

// Windows AUMIDs cannot contain spaces. The shortcut's display name is ADE AGS.
pub const APP_ID: &str = "com.luis.controlcode.ADEAGS";

#[derive(Debug, PartialEq)]
struct ShortcutPlan {
    path: PathBuf,
    executable: PathBuf,
    icon: PathBuf,
    app_id: &'static str,
}

fn plan(programs: &Path, executable: &Path, data: &Path) -> ShortcutPlan {
    ShortcutPlan {
        path: programs.join("ADE AGS.lnk"),
        executable: executable.to_owned(),
        icon: data.join("ADE AGS").join("notifications").join("bot.ico"),
        app_id: APP_ID,
    }
}

fn needs_write(existing: Option<&[u8]>, desired: &[u8]) -> bool {
    existing != Some(desired)
}

fn registry_path() -> String {
    format!(r"Software\Classes\AppUserModelId\{APP_ID}")
}

#[cfg(windows)]
fn register_display_name(icon: &Path) -> Result<(), String> {
    use windows::{
        Win32::System::Registry::*,
        core::{HSTRING, PCWSTR},
    };
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
    // Only HKCU is used. These fixed app-owned values also repair stale branding.
    unsafe {
        let mut handle = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(registry_path()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut handle,
            None,
        )
        .ok()
        .map_err(|e| e.to_string())?;
        let key = Key(handle);
        let icon = icon
            .to_str()
            .ok_or("notification icon path is not Unicode")?;
        for (name, value) in [
            ("DisplayName", "ADE AGS"),
            ("IconUri", icon),
            ("IconBackgroundColor", "0"),
        ] {
            let bytes: Vec<u8> = value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            RegSetValueExW(key.0, &HSTRING::from(name), None, REG_SZ, Some(&bytes))
                .ok()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn initialize() -> Result<(), String> {
    use windows::{Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID, core::HSTRING};
    // This must run in the app process before its first window exists.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) }
        .map_err(|e| e.to_string())?;
    // Own an STA instead of depending on Tauri's thread apartment.
    std::thread::spawn(register_shortcut)
        .join()
        .map_err(|_| "identity thread panicked".to_string())?
}

#[cfg(windows)]
fn register_shortcut() -> Result<(), String> {
    use windows::{
        Win32::{
            Foundation::PROPERTYKEY,
            System::{
                Com::StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                Com::{
                    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance,
                    CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                },
                Variant::VT_LPWSTR,
            },
            UI::Shell::{
                FOLDERID_Programs, IShellLinkW, KF_FLAG_DEFAULT, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, ShellLink,
            },
        },
        core::{GUID, HSTRING, Interface, PCWSTR},
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    // SAFETY: all COM objects and borrowed UTF-16 buffers remain in this STA until saved.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = Apartment;
        let folder = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None)
            .map_err(|e| e.to_string())?;
        let programs = folder.to_string();
        CoTaskMemFree(Some(folder.0.cast()));
        let programs = PathBuf::from(programs.map_err(|e| e.to_string())?);
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let data = dirs::data_local_dir().ok_or("missing local application data directory")?;
        let spec = plan(&programs, &executable, &data);
        std::fs::create_dir_all(spec.icon.parent().unwrap()).map_err(|e| e.to_string())?;
        write_if_changed(&spec.icon, include_bytes!("../../icons/icon.ico"))?;
        register_display_name(&spec.icon)?;
        std::fs::create_dir_all(&programs).map_err(|e| e.to_string())?;
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        link.SetPath(&HSTRING::from(spec.executable.as_os_str()))
            .map_err(|e| e.to_string())?;
        link.SetIconLocation(&HSTRING::from(spec.icon.as_os_str()), 0)
            .map_err(|e| e.to_string())?;
        link.SetDescription(&HSTRING::from("ADE AGS"))
            .map_err(|e| e.to_string())?;
        let store: IPropertyStore = link.cast().map_err(|e| e.to_string())?;
        // PKEY_AppUserModel_ID. This PROPVARIANT borrows the buffer; do not PropVariantClear it.
        let id: Vec<u16> = spec.app_id.encode_utf16().chain(Some(0)).collect();
        let value = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: windows::core::PWSTR(id.as_ptr() as *mut u16),
                    },
                    ..Default::default()
                }),
            },
        };
        let key = PROPERTYKEY {
            fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid: 5,
        };
        store.SetValue(&key, &value).map_err(|e| e.to_string())?;
        store.Commit().map_err(|e| e.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let temporary = spec
            .path
            .with_extension(format!("{}.tmp.lnk", std::process::id()));
        let path = HSTRING::from(temporary.as_os_str());
        persist
            .Save(PCWSTR(path.as_ptr()), true)
            .map_err(|e| e.to_string())?;
        let result = std::fs::read(&temporary)
            .map_err(|e| e.to_string())
            .and_then(|bytes| write_if_changed(&spec.path, &bytes));
        let _ = std::fs::remove_file(&temporary);
        result
    }
}

#[cfg(windows)]
fn write_if_changed(path: &Path, desired: &[u8]) -> Result<(), String> {
    let existing = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if needs_write(existing.as_deref(), desired) {
        std::fs::write(path, desired).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_stable_for_dev_and_installed_executables() {
        let dev = plan(
            Path::new("programs"),
            Path::new("target/debug/ade-ags.exe"),
            Path::new("local"),
        );
        let installed = plan(
            Path::new("programs"),
            Path::new("installed/ade-ags.exe"),
            Path::new("local"),
        );
        assert_eq!(dev.app_id, installed.app_id);
        assert!(!APP_ID.contains(' '));
        assert!(APP_ID.len() < 128);
        assert_eq!(
            registry_path(),
            r"Software\Classes\AppUserModelId\com.luis.controlcode.ADEAGS"
        );
        assert_eq!(dev.path, Path::new("programs").join("ADE AGS.lnk"));
        assert_eq!(dev.icon, installed.icon);
        assert_ne!(dev.executable, installed.executable);
    }

    #[test]
    fn registration_repairs_missing_and_stale_content_without_rewriting_matches() {
        assert!(needs_write(None, b"shortcut"));
        assert!(needs_write(Some(b"old-target"), b"shortcut"));
        assert!(!needs_write(Some(b"shortcut"), b"shortcut"));
    }

    #[test]
    fn paths_preserve_unicode_and_spaces() {
        let spec = plan(
            Path::new("Usuário/Menu Iniciar"),
            Path::new("Minha aplicação/ADE AGS.exe"),
            Path::new("Dados locais"),
        );
        assert_eq!(spec.executable, Path::new("Minha aplicação/ADE AGS.exe"));
        assert_eq!(
            spec.icon,
            Path::new("Dados locais").join("ADE AGS/notifications/bot.ico")
        );
    }
}
