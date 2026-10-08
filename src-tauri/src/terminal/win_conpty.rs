//! ConPTY com `CREATE_NO_WINDOW`.
//!
//! `portable-pty` 0.8 (e o 0.9 / main do wezterm) chama `CreateProcessW` só com
//! `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`. Não há API para
//! acrescentar `CREATE_NO_WINDOW`, então o pseudoconsole nasce aqui.

#![cfg(windows)]

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtyPair, PtySize, SlavePty};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, FALSE, HANDLE, INVALID_HANDLE_VALUE,
    S_OK, TRUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;
const PSEUDOCONSOLE_WIN32_INPUT_MODE: u32 = 0x4;

struct Con {
    hpc: HPCON,
}

unsafe impl Send for Con {}
unsafe impl Sync for Con {}

impl Drop for Con {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.hpc) };
    }
}

struct AttrList {
    data: Vec<u8>,
}

impl AttrList {
    fn new() -> io::Result<Self> {
        let mut bytes = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes) };
        let mut data = vec![0u8; bytes];
        let ok = unsafe {
            InitializeProcThreadAttributeList(data.as_mut_ptr().cast(), 1, 0, &mut bytes)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { data })
    }

    fn set_pty(&mut self, hpc: HPCON) -> io::Result<()> {
        let ok = unsafe {
            UpdateProcThreadAttribute(
                self.data.as_mut_ptr().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                hpc as *const _,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.data.as_mut_ptr().cast()) };
    }
}

struct WinMaster {
    con: Arc<Con>,
    size: Mutex<PtySize>,
    reader: Mutex<std::fs::File>,
    writer: Mutex<Option<std::fs::File>>,
}

struct WinSlave {
    con: Arc<Con>,
}

struct WinChild {
    handle: Mutex<HANDLE>,
    pid: u32,
}

unsafe impl Send for WinChild {}
unsafe impl Sync for WinChild {}

pub(crate) fn open(size: PtySize) -> Result<PtyPair, String> {
    let (input_read, input_write) = pipe().map_err(|e| e.to_string())?;
    let (output_read, output_write) = pipe().map_err(|e| e.to_string())?;
    // `HPCON` no windows-sys 0.61 é `isize`, não um ponteiro.
    let mut hpc: HPCON = 0;
    let hr = unsafe {
        CreatePseudoConsole(
            COORD { X: size.cols as i16, Y: size.rows as i16 },
            input_read,
            output_write,
            PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE,
            &mut hpc,
        )
    };
    unsafe {
        CloseHandle(input_read);
        CloseHandle(output_write);
    }
    if hr != S_OK {
        unsafe {
            CloseHandle(input_write);
            CloseHandle(output_read);
        }
        return Err(format!("CreatePseudoConsole: HRESULT {hr}"));
    }
    let con = Arc::new(Con { hpc });
    let reader = unsafe { std::fs::File::from_raw_handle(output_read as RawHandle) };
    let writer = unsafe { std::fs::File::from_raw_handle(input_write as RawHandle) };
    Ok(PtyPair {
        slave: Box::new(WinSlave { con: Arc::clone(&con) }),
        master: Box::new(WinMaster {
            con,
            size: Mutex::new(size),
            reader: Mutex::new(reader),
            writer: Mutex::new(Some(writer)),
        }),
    })
}

fn pipe() -> io::Result<(HANDLE, HANDLE)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    let mut sa = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let ok = unsafe { CreatePipe(&mut read, &mut write, &sa, 0) };
    if ok == 0 { Err(io::Error::last_os_error()) } else { Ok((read, write)) }
}

impl MasterPty for WinMaster {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        let hr = unsafe {
            ResizePseudoConsole(self.con.hpc, COORD { X: size.cols as i16, Y: size.rows as i16 })
        };
        if hr != S_OK {
            return Err(io::Error::other(format!("ResizePseudoConsole: HRESULT {hr}")).into());
        }
        *self.size.lock().unwrap_or_else(|e| e.into_inner()) = size;
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        Ok(*self.size.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, anyhow::Error> {
        let file = self.reader.lock().unwrap_or_else(|e| e.into_inner()).try_clone()?;
        Ok(Box::new(file))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
        self.writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|file| Box::new(file) as Box<dyn Write + Send>)
            .ok_or_else(|| io::Error::other("o writer do PTY já foi consumido").into())
    }
}

impl SlavePty for WinSlave {
    fn spawn_command(&self, cmd: CommandBuilder) -> Result<Box<dyn Child + Send + Sync>, anyhow::Error> {
        let mut attrs = AttrList::new()?;
        attrs.set_pty(self.con.hpc)?;

        let args: Vec<String> = cmd.get_argv().iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        if args.is_empty() {
            return Err(io::Error::other("comando vazio").into());
        }
        let mut exe: Vec<u16> = OsStr::new(&args[0]).encode_wide().chain(Some(0)).collect();
        let cmdline = crate::util::win_quote::quote_cmdline(&args);
        let mut cmdline: Vec<u16> = OsStr::new(&cmdline).encode_wide().chain(Some(0)).collect();
        let cwd: Option<Vec<u16>> = cmd.get_cwd().map(|dir| OsStr::new(dir).encode_wide().chain(Some(0)).collect());
        let mut env = env_block(&cmd);

        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        si.lpAttributeList = attrs.data.as_mut_ptr().cast();

        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
        let ok = unsafe {
            CreateProcessW(
                exe.as_mut_ptr(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                FALSE,
                flags,
                env.as_mut_ptr().cast(),
                cwd.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
                &si.StartupInfo as *const STARTUPINFOW,
                &mut pi,
            )
        };
        if ok == 0 {
            return Err(io::Error::other(format!("CreateProcessW sem janela: {}", io::Error::last_os_error())).into());
        }
        unsafe { CloseHandle(pi.hThread) };
        Ok(Box::new(WinChild { handle: Mutex::new(pi.hProcess), pid: pi.dwProcessId }))
    }
}

fn env_block(cmd: &CommandBuilder) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in cmd.iter_full_env_as_str() {
        block.extend(key.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

impl std::fmt::Debug for WinChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WinChild").field("pid", &self.pid).finish()
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
        if handle.is_null() {
            return Ok(Some(ExitStatus::with_exit_code(1)));
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        if wait != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0u32;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(ExitStatus::with_exit_code(code)))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
            unsafe { WaitForSingleObject(handle, 50) };
        }
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
        if handle.is_null() { None } else { Some(handle as RawHandle) }
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> io::Result<()> {
        let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
        if handle.is_null() {
            return Ok(());
        }
        let ok = unsafe { TerminateProcess(handle, 1) };
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
        let mut duplicated = std::ptr::null_mut();
        if !handle.is_null() {
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    handle,
                    GetCurrentProcess(),
                    &mut duplicated,
                    0,
                    FALSE,
                    DUPLICATE_SAME_ACCESS,
                );
            }
        }
        Box::new(WinChild { handle: Mutex::new(duplicated), pid: self.pid })
    }
}

impl Drop for WinChild {
    fn drop(&mut self) {
        let handle = *self.handle.lock().unwrap_or_else(|e| e.into_inner());
        if !handle.is_null() {
            unsafe { CloseHandle(handle) };
        }
    }
}
