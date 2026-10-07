//! Transporte em que o servidor lê o PID de quem conectou.
//!
//! O TCP em `127.0.0.1` continua de pé: é por ele que a app prova que está
//! viva e que uma CLI antiga ainda fala. Ele não tem credencial de peer.
//! Comandos de memória e swarm exigem o PID, então a CLI nova usa o canal
//! daqui quando o handshake o anuncia.
//!
//! - Linux/Android: socket Unix e `SO_PEERCRED`.
//! - macOS: socket Unix e `LOCAL_PEERPID`. `getpeereid` só devolve uid/gid.
//! - Windows: named pipe e `GetNamedPipeClientProcessId`.
//! - Outros Unix: não há PID do peer. O servidor aceita a conexão sem PID
//!   e a sessão cai no fallback explícito do token (`ancestry_required`).

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;

use super::protocol::Handshake;
use super::server::{self, MAX_CONNECTIONS};

/// Erro de ida e volta com a app. `retryable` é o mesmo critério da CLI:
/// a app ainda pode aparecer; um protocolo divergente, não.
pub struct ExchangeError {
    pub message: String,
    pub retryable: bool,
}

impl ExchangeError {
    fn unreachable(message: impl Into<String>) -> Self {
        ExchangeError { message: message.into(), retryable: true }
    }

    fn gone(message: impl Into<String>) -> Self {
        ExchangeError { message: message.into(), retryable: false }
    }
}

std::thread_local! {
    static CLIENT_PID: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

pub(crate) fn with_client_pid<T>(pid: Option<u32>, f: impl FnOnce() -> T) -> T {
    CLIENT_PID.with(|slot| {
        let previous = slot.replace(pid);
        let result = f();
        slot.set(previous);
        result
    })
}

pub(crate) fn current_client_pid() -> Option<u32> {
    CLIENT_PID.with(|slot| slot.get())
}

/// Uma linha de request, uma de response. Se o handshake traz `socket`,
/// a conexão é a que carrega o PID. Sem isso, fica o TCP antigo.
pub fn exchange(handshake: &Handshake, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    match handshake.socket.as_deref() {
        Some(endpoint) => exchange_credential(endpoint, payload, timeout),
        None => exchange_tcp(handshake, payload, timeout),
    }
}

fn write_and_read(mut stream: impl Read + Write, payload: &str) -> Result<String, ExchangeError> {
    let line = if payload.ends_with('\n') { payload.to_string() } else { format!("{payload}\n") };
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|e| ExchangeError::gone(format!("No se pudo enviar el comando: {e}")))?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|e| ExchangeError::gone(format!("No llegó respuesta: {e}")))?;
    if response.trim().is_empty() {
        return Err(ExchangeError::gone("No llegó respuesta"));
    }
    Ok(response)
}

fn exchange_tcp(handshake: &Handshake, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, handshake.port);
    let stream = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2)).map_err(|_| {
        ExchangeError::unreachable(format!(
            "No se pudo conectar al puerto {} (la app con PID {} pudo haber cerrado). Reiniciá la app.",
            handshake.port, handshake.pid
        ))
    })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    write_and_read(stream, payload)
}

#[cfg(unix)]
fn exchange_credential(endpoint: &str, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(endpoint).map_err(|e| {
        ExchangeError::unreachable(format!(
            "No se pudo conectar al socket de credencial {endpoint} ({e}). Reiniciá la app."
        ))
    })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    write_and_read(stream, payload)
}

#[cfg(windows)]
fn exchange_credential(endpoint: &str, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    let file = std::fs::OpenOptions::new().read(true).write(true).open(endpoint).map_err(|e| {
        ExchangeError::unreachable(format!(
            "No se pudo conectar al pipe {endpoint} ({e}). Reiniciá la app."
        ))
    })?;
    // `File` não tem timeout de leitura. A thread só existe para não deixar
    // a CLI presa se a app aceitar o pipe e não responder.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(write_and_read(file, payload));
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => Err(ExchangeError::gone("No llegó respuesta")),
    }
}

#[cfg(not(any(unix, windows)))]
fn exchange_credential(endpoint: &str, _payload: &str, _timeout: Duration) -> Result<String, ExchangeError> {
    Err(ExchangeError::gone(format!(
        "Esta plataforma no tiene transporte de credencial ({endpoint})."
    )))
}

/// Abre o canal com PID antes do handshake anunciá-lo. Se o bind falha, o
/// chamador deixa `socket` vazio: a CLI fica no TCP e memória/swarm fecham.
pub(super) fn start_credential_server(
    app: AppHandle,
    token: String,
    endpoint: String,
    open: Arc<AtomicUsize>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let listener = bind_unix(&endpoint)?;
        std::thread::spawn(move || accept_unix(listener, app, token, open));
        Ok(())
    }
    #[cfg(windows)]
    {
        let first = create_pipe(&endpoint)?;
        std::thread::spawn(move || accept_windows(first, endpoint, app, token, open));
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (app, token, endpoint, open);
        Err("sem transporte de credencial nesta plataforma".into())
    }
}

pub(super) fn remove_credential_endpoint(pid: u32) {
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(super::protocol::credential_endpoint(pid));
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

#[cfg(unix)]
fn bind_unix(endpoint: &str) -> Result<std::os::unix::net::UnixListener, String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let path = std::path::Path::new(endpoint);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| format!("bind: {e}"))?;
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(listener)
}

#[cfg(unix)]
fn accept_unix(listener: std::os::unix::net::UnixListener, app: AppHandle, token: String, open: Arc<AtomicUsize>) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            drop(stream);
            continue;
        }
        let client_pid = peer_pid(&stream).ok();
        let app = app.clone();
        let token = token.to_string();
        let open = open.clone();
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
            let Ok(writer) = stream.try_clone() else {
                open.fetch_sub(1, Ordering::SeqCst);
                return;
            };
            server::handle_connection(stream, writer, &app, &token, client_pid);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[cfg(windows)]
fn create_pipe(endpoint: &str) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
    let pipe = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            65_536,
            65_536,
            0,
            std::ptr::null(),
        )
    };
    if pipe == INVALID_HANDLE_VALUE {
        return Err(format!("CreateNamedPipeW: {}", std::io::Error::last_os_error()));
    }
    Ok(pipe)
}

#[cfg(windows)]
fn accept_windows(
    mut pipe: windows_sys::Win32::Foundation::HANDLE,
    endpoint: String,
    app: AppHandle,
    token: String,
    open: Arc<AtomicUsize>,
) {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, GetNamedPipeClientProcessId};

    loop {
        let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            unsafe { CloseHandle(pipe) };
            match create_pipe(&endpoint) {
                Ok(next) => pipe = next,
                Err(error) => {
                    eprintln!("[ade-ags] named pipe indisponível ({endpoint}): {error}");
                    return;
                }
            }
            continue;
        }
        let mut raw_pid = 0u32;
        let client_pid = if unsafe { GetNamedPipeClientProcessId(pipe, &mut raw_pid) } != 0 && raw_pid > 0 {
            Some(raw_pid)
        } else {
            None
        };
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            unsafe { CloseHandle(pipe) };
        } else {
            let file = unsafe { std::fs::File::from_raw_handle(pipe as RawHandle) };
            if let Ok(writer) = file.try_clone() {
                let app = app.clone();
                let token = token.clone();
                let open = open.clone();
                std::thread::spawn(move || {
                    server::handle_connection(file, writer, &app, &token, client_pid);
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            } else {
                open.fetch_sub(1, Ordering::SeqCst);
            }
        }
        match create_pipe(&endpoint) {
            Ok(next) => pipe = next,
            Err(error) => {
                eprintln!("[ade-ags] named pipe indisponível ({endpoint}): {error}");
                return;
            }
        }
    }
}

/// PID do processo do outro lado do socket. Falha fechada: sem credencial
/// não há PID, e o chamador trata `Err` como cliente anônimo.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn peer_pid(stream: &std::os::unix::net::UnixStream) -> Result<u32, String> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(format!("SO_PEERCRED: {}", std::io::Error::last_os_error()));
    }
    if cred.pid <= 0 {
        return Err("SO_PEERCRED não informou o PID do cliente".into());
    }
    Ok(cred.pid as u32)
}

/// `getpeereid` não inclui o PID. `LOCAL_PEERPID` (sys/un.h) inclui.
#[cfg(target_os = "macos")]
pub(crate) fn peer_pid(stream: &std::os::unix::net::UnixStream) -> Result<u32, String> {
    use std::os::unix::io::AsRawFd;
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERPID: libc::c_int = 0x002;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            SOL_LOCAL,
            LOCAL_PEERPID,
            &mut pid as *mut libc::pid_t as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(format!("LOCAL_PEERPID: {}", std::io::Error::last_os_error()));
    }
    if pid <= 0 {
        return Err("LOCAL_PEERPID não informou o PID do cliente".into());
    }
    Ok(pid as u32)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android", target_os = "macos"))))]
pub(crate) fn peer_pid(_stream: &std::os::unix::net::UnixStream) -> Result<u32, String> {
    Err("este Unix não informa o PID do peer; a sessão usa só o token".into())
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[test]
    fn the_credential_socket_reports_this_process() {
        use std::os::unix::net::{UnixListener, UnixStream};
        let path = std::env::temp_dir().join(format!("ags-peer-{}-{}.sock", std::process::id(), uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        let pid = super::peer_pid(&server).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(pid, std::process::id());
    }
}
