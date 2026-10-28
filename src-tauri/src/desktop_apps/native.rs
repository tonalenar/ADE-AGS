use super::{DesktopBounds, DesktopStatus};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{Emitter, Manager, WebviewWindow};
use windows_sys::Win32::UI::Accessibility::*;
use windows_sys::Win32::{
    Foundation::*,
    System::Threading::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Google/Gemini"))
}

pub fn configure_host_dpi() {
    if executable().is_none() {
        return;
    }
    // Gemini 1.15 uses Per-Monitor V1; Tao defaults to V2. Mixing these in a
    // cross-process window tree can reset the child's process DPI. Match window
    // creation on ADE's UI thread up front (Tao supports V1 as its own fallback).
    // Prefer the running application's measured context when it is available.
    unsafe {
        let context = find_window()
            .ok()
            .flatten()
            .map(|(hwnd, _, _)| GetWindowDpiAwarenessContext(hwnd as HWND))
            .unwrap_or(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
        if GetAwarenessFromDpiAwarenessContext(context) == DPI_AWARENESS_PER_MONITOR_AWARE {
            SetThreadDpiAwarenessContext(context);
        }
    }
}
fn executable() -> Option<PathBuf> {
    // The unversioned Gemini.exe may be an unsigned update trampoline. Launch and
    // verify the actual versioned Google executable instead.
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(root()?)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let version = name
                .strip_prefix("app-")?
                .split('.')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            let path = entry.path().join("Gemini.exe");
            (version.len() == 3 && path.is_file()).then_some((version, path))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().next().map(|(_, path)| path)
}

struct Session {
    app: tauri::AppHandle,
    focus_hook: isize,
    owner: String,
    view: String,
    host: isize,
    lock: isize,
    saved: Saved,
}

unsafe extern "system" fn focused(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    // Out-of-context events are delivered on the hook's UI thread. Never block
    // reentrant Windows event delivery while a layout/detach owns the session lock.
    let target = sessions()
        .try_lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| (s.app.clone(), s.view.clone())));
    if let Some((app, view)) = target {
        let _ = app.emit("gemini-desktop-focus", view);
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    hwnd: isize,
    pid: u32,
    parent_pid: u32,
    host: isize,
    style: isize,
    ex_style: isize,
    flags: u32,
    show: u32,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    visible: bool,
    executable: PathBuf,
}
fn sessions() -> &'static Mutex<Option<Session>> {
    static S: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}
fn alive(saved: &Saved) -> bool {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(saved.hwnd as HWND, &mut pid);
        IsWindow(saved.hwnd as HWND) != 0 && pid == saved.pid
    }
}

pub fn status() -> DesktopStatus {
    let guard = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let active = guard.as_ref().filter(|s| alive(&s.saved));
    DesktopStatus {
        supported: true,
        installed: executable().is_some(),
        attached: active.is_some(),
        owner_window: active.map(|s| s.owner.clone()),
        owner_view: active.map(|s| s.view.clone()),
        automatic_messaging: active.is_some(),
        orchestration: if active.is_some() { "automatic" } else { "assisted" },
    }
}

pub fn automation_window(view_id: &str) -> Result<isize, String> {
    let guard = sessions().lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("Connect Gemini to an ADE panel first")?;
    if session.view != view_id {
        return Err("Gemini is connected to another ADE panel".into());
    }
    if !alive(&session.saved) {
        return Err("Gemini window was closed or restarted. Release and reconnect.".into());
    }
    Ok(session.saved.hwnd)
}

/// Validate the actual signed version executable, not the unversioned launcher alone.
fn verify_signature(path: &Path) -> Result<(), String> {
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").ok_or("SystemRoot unavailable")?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = crate::util::spawn::hidden_command(powershell);
    command.args(["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $env:ADE_GEMINI_EXECUTABLE; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'O=Google LLC') { exit 0 } else { Write-Output $s.Status; exit 1 }"])
        .env("ADE_GEMINI_EXECUTABLE", path).env_remove("PSModulePath");
    let output = crate::util::output_with_timeout(&mut command, std::time::Duration::from_secs(20))
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Gemini executable must have a valid Google LLC signature: {} {}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

pub fn prepare() -> Result<PathBuf, String> {
    if let Some((_, _, version)) = find_window()? {
        verify_signature(&version)?;
        return Ok(version);
    }
    let exe =
        executable().ok_or("Gemini Desktop is not installed in LocalAppData/Google/Gemini")?;
    verify_signature(&exe)?;
    if find_window()?.is_none() {
        crate::util::spawn::hidden_command(&exe)
            .spawn()
            .map_err(|e| e.to_string())?;
        for _ in 0..60 {
            if let Some((_, _, version)) = find_window()? {
                verify_signature(&version)?;
                return Ok(version);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        return Err(
            "Gemini did not expose its main window within 12 seconds. Open it and retry.".into(),
        );
    }
    let (_, _, version) = find_window()?.ok_or("Gemini window disappeared")?;
    verify_signature(&version)?;
    Ok(version)
}

unsafe extern "system" fn collect(hwnd: HWND, param: LPARAM) -> i32 {
    unsafe {
        let matches = &mut *(param as *mut Vec<(isize, u32, PathBuf)>);
        if IsWindowVisible(hwnd) == 0 || !GetParent(hwnd).is_null() {
            return 1;
        }
        let mut title = [0u16; 256];
        let len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        if String::from_utf16_lossy(&title[..len.max(0) as usize]) != "Gemini" {
            return 1;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return 1;
        }
        let mut path = [0u16; 32768];
        let mut size = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if ok != 0 {
            let p = PathBuf::from(String::from_utf16_lossy(&path[..size as usize]));
            if p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("Gemini.exe"))
                && root().is_some_and(|r| p.starts_with(r))
            {
                matches.push((hwnd as isize, pid, p));
            }
        }
        1
    }
}
fn find_window() -> Result<Option<(isize, u32, PathBuf)>, String> {
    let mut found = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut found as *mut _ as LPARAM);
    }
    if found.len() > 1 {
        return Err("More than one Gemini main window was found".into());
    }
    Ok(found.pop())
}

pub fn attach(window: &WebviewWindow, view: String, exe: &Path) -> Result<DesktopStatus, String> {
    {
        let guard = sessions().lock().map_err(|e| e.to_string())?;
        if let Some(s) = guard.as_ref() {
            if alive(&s.saved) {
                return if s.owner == window.label() && s.view == view {
                    drop(guard);
                    Ok(status())
                } else {
                    Err(
                        "Gemini is already attached to another ADE panel. Release it there first."
                            .into(),
                    )
                };
            }
        }
    }
    detach(None)?;
    let (hwnd, pid, signed_exe) = find_window()?.ok_or("Open the Gemini main window and retry")?;
    if signed_exe != exe {
        return Err("Gemini changed version while connecting. Retry.".into());
    }
    let recovery_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
    unsafe {
        if AreDpiAwarenessContextsEqual(
            GetWindowDpiAwarenessContext(parent),
            GetWindowDpiAwarenessContext(hwnd as HWND),
        ) == 0
        {
            return Err("Gemini and ADE use incompatible DPI contexts. Use the separate application window.".into());
        }
        let lock = CreateMutexW(
            std::ptr::null(),
            1,
            wide(format!("Local\\ADE-Gemini-{pid}")).as_ptr(),
        );
        if lock.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(lock);
            return Err("Another ADE instance owns the Gemini window".into());
        }
        let host = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            1,
            1,
            parent,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if host.is_null() {
            ReleaseMutex(lock);
            CloseHandle(lock);
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut p: WINDOWPLACEMENT = std::mem::zeroed();
        p.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if GetWindowPlacement(hwnd as HWND, &mut p) == 0 {
            DestroyWindow(host);
            ReleaseMutex(lock);
            CloseHandle(lock);
            return Err("Cannot save Gemini window placement".into());
        }
        let saved = Saved {
            hwnd,
            pid,
            parent_pid: std::process::id(),
            host: host as isize,
            style: GetWindowLongPtrW(hwnd as HWND, GWL_STYLE),
            ex_style: GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE),
            flags: p.flags,
            show: p.showCmd,
            min_x: p.ptMinPosition.x,
            min_y: p.ptMinPosition.y,
            max_x: p.ptMaxPosition.x,
            max_y: p.ptMaxPosition.y,
            left: p.rcNormalPosition.left,
            top: p.rcNormalPosition.top,
            right: p.rcNormalPosition.right,
            bottom: p.rcNormalPosition.bottom,
            visible: true,
            executable: signed_exe,
        };
        // Spawn recovery before making Gemini a child. It exits after normal detachment.
        let recovery_args = match serde_json::to_string(&saved) {
            Ok(args) => args,
            Err(e) => {
                DestroyWindow(host);
                ReleaseMutex(lock);
                CloseHandle(lock);
                return Err(e.to_string());
            }
        };
        let recovery = crate::util::spawn::hidden_command(recovery_exe)
            .arg("--gemini-recovery")
            .arg(recovery_args)
            .spawn();
        if let Err(e) = recovery {
            DestroyWindow(host);
            ReleaseMutex(lock);
            CloseHandle(lock);
            return Err(format!("Cannot start Gemini recovery helper: {e}"));
        }
        ShowWindow(hwnd as HWND, SW_HIDE);
        SetWindowLongPtrW(
            hwnd as HWND,
            GWL_STYLE,
            ((saved.style as u32
                & !(WS_POPUP
                    | WS_CAPTION
                    | WS_THICKFRAME
                    | WS_SYSMENU
                    | WS_MINIMIZEBOX
                    | WS_MAXIMIZEBOX))
                | WS_CHILD) as isize,
        );
        SetWindowLongPtrW(
            hwnd as HWND,
            GWL_EXSTYLE,
            (saved.ex_style as u32 & !WS_EX_APPWINDOW) as isize,
        );
        SetParent(hwnd as HWND, host);
        if GetParent(hwnd as HWND) != host {
            restore(&saved)?;
            DestroyWindow(host);
            ReleaseMutex(lock);
            CloseHandle(lock);
            return Err("Windows refused to attach the Gemini window".into());
        }
        *sessions().lock().map_err(|e| e.to_string())? = Some(Session {
            app: window.app_handle().clone(),
            focus_hook: SetWinEventHook(
                EVENT_OBJECT_FOCUS,
                EVENT_OBJECT_FOCUS,
                std::ptr::null_mut(),
                Some(focused),
                pid,
                0,
                WINEVENT_OUTOFCONTEXT,
            ) as isize,
            owner: window.label().into(),
            view,
            host: host as isize,
            lock: lock as isize,
            saved,
        });
    }
    Ok(status())
}

pub fn layout(owner: &str, view: &str, b: DesktopBounds) -> Result<(), String> {
    let mut guard = sessions().lock().map_err(|e| e.to_string())?;
    let Some(s) = guard.as_mut() else {
        return Ok(());
    };
    if s.owner != owner || s.view != view {
        return Err("This panel does not own the Gemini window".into());
    }
    if !alive(&s.saved) {
        return Err("Gemini window was closed or restarted. Release and reconnect.".into());
    }
    unsafe {
        let host = s.host as HWND;
        let hwnd = s.saved.hwnd as HWND;
        let show = b.visible && b.width >= 100. && b.height >= 100.;
        if !show {
            ShowWindow(host, SW_HIDE);
            return Ok(());
        }
        let parent = GetParent(host);
        if IsIconic(parent) != 0 {
            ShowWindow(host, SW_HIDE);
            return Ok(());
        }
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(parent, &mut client);
        let x = (b.x * b.scale).round().max(0.) as i32;
        let y = (b.y * b.scale).round().max(0.) as i32;
        let width = (b.width * b.scale)
            .round()
            .min((client.right - x).max(0) as f64) as i32;
        let height = (b.height * b.scale)
            .round()
            .min((client.bottom - y).max(0) as f64) as i32;
        if width <= 0 || height <= 0 {
            ShowWindow(host, SW_HIDE);
            return Ok(());
        }
        // Skip Electron's top-level minimum-size adjustment when hosted as a child.
        // WM_SIZE still reaches its renderer so the page reflows to the panel.
        let flags = SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOSENDCHANGING;
        if SetWindowPos(host, HWND_TOP, x, y, width, height, flags) == 0
            || SetWindowPos(hwnd, HWND_TOP, 0, 0, width, height, flags) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        ShowWindow(hwnd, SW_SHOWNA);
        ShowWindow(host, SW_SHOWNA);
    }
    Ok(())
}

fn restore(s: &Saved) -> Result<(), String> {
    if !alive(s) {
        return Ok(());
    }
    unsafe {
        let h = s.hwnd as HWND;
        ShowWindow(h, SW_HIDE);
        SetParent(h, std::ptr::null_mut());
        SetWindowLongPtrW(h, GWL_STYLE, s.style);
        SetWindowLongPtrW(h, GWL_EXSTYLE, s.ex_style);
        let p = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            flags: s.flags,
            showCmd: s.show,
            ptMinPosition: POINT {
                x: s.min_x,
                y: s.min_y,
            },
            ptMaxPosition: POINT {
                x: s.max_x,
                y: s.max_y,
            },
            rcNormalPosition: RECT {
                left: s.left,
                top: s.top,
                right: s.right,
                bottom: s.bottom,
            },
        };
        if SetWindowPlacement(h, &p) == 0 || !GetParent(h).is_null() {
            return Err("Cannot restore Gemini; refusing to destroy its host".into());
        }
        SetWindowPos(
            h,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        );
        ShowWindow(h, if s.visible { s.show as i32 } else { SW_HIDE });
    }
    Ok(())
}

pub fn detach(owner: Option<(&str, &str)>) -> Result<(), String> {
    let mut guard = sessions().lock().map_err(|e| e.to_string())?;
    if let Some(s) = guard.as_ref() {
        if let Some((window, view)) = owner {
            if s.owner != window || s.view != view {
                return Err("This panel does not own the Gemini window".into());
            }
        }
        restore(&s.saved)?;
    }
    if let Some(s) = guard.take() {
        unsafe {
            if s.focus_hook != 0 {
                UnhookWinEvent(s.focus_hook as HWINEVENTHOOK);
            }
            DestroyWindow(s.host as HWND);
            ReleaseMutex(s.lock as HANDLE);
            CloseHandle(s.lock as HANDLE);
        }
    }
    Ok(())
}
pub fn release_window(owner: &str) -> Result<(), String> {
    let owns = sessions()
        .lock()
        .map(|g| g.as_ref().is_some_and(|s| s.owner == owner))
        .unwrap_or(false);
    if owns {
        detach(None)?;
    }
    Ok(())
}

pub fn recovery_entry() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--gemini-recovery") {
        return false;
    }
    let Some(saved) = std::env::args()
        .nth(2)
        .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
    else {
        return true;
    };
    unsafe {
        let parent = OpenProcess(0x00100000 /* SYNCHRONIZE */, 0, saved.parent_pid);
        if parent.is_null() {
            return true;
        }
        // Allow attachment to finish; no Tauri/database initialization in this process.
        std::thread::sleep(std::time::Duration::from_secs(2));
        loop {
            let waited = WaitForSingleObject(parent, 250);
            if waited == WAIT_FAILED {
                break;
            }
            if waited == WAIT_OBJECT_0 {
                if alive(&saved) {
                    let _ = restore(&saved);
                } else if root().is_some_and(|r| saved.executable.starts_with(r))
                    && saved
                        .executable
                        .file_name()
                        .is_some_and(|n| n.eq_ignore_ascii_case("Gemini.exe"))
                    && verify_signature(&saved.executable).is_ok()
                {
                    // Windows can destroy child HWNDs on a parent-process crash. Reopen
                    // the installed app in that case; an unsent draft cannot be guaranteed.
                    let _ = crate::util::spawn::hidden_command(&saved.executable).spawn();
                }
                break;
            }
            if !alive(&saved) || GetParent(saved.hwnd as HWND) != saved.host as HWND {
                break;
            }
        }
        CloseHandle(parent);
    }
    true
}
