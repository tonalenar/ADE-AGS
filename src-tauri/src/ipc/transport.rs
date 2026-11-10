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
use std::time::Duration;

use tauri::AppHandle;

use super::protocol::Handshake;
use super::intake::{self, Slots};
use super::server;

/// Erro de ida e volta com a app. `retryable` é o mesmo critério da CLI:
/// a app ainda pode aparecer; um protocolo divergente, não.
pub struct ExchangeError {
    pub message: String,
    pub retryable: bool,
    /// O SO recusou a conexão (`EPERM`/`EACCES`): o app está de pé, quem bloqueia é o sandbox do
    /// agente. Não é "app fechado" (exit 3) nem se resolve esperando.
    pub denied: bool,
}

impl ExchangeError {
    fn unreachable(message: impl Into<String>) -> Self {
        ExchangeError { message: message.into(), retryable: true, denied: false }
    }

    fn gone(message: impl Into<String>) -> Self {
        ExchangeError { message: message.into(), retryable: false, denied: false }
    }

    fn denied(message: impl Into<String>) -> Self {
        ExchangeError { message: message.into(), retryable: false, denied: true }
    }
}

/// O sandbox em que a CLI parece estar, pelas variáveis que cada agente põe no shell dele:
/// o Codex põe `CODEX_SANDBOX` (`seatbelt` no macOS) e o Gemini CLI põe `SANDBOX`
/// (`sandbox-exec` no macOS, ou o nome do contêiner). Só serve para a mensagem: não autoriza nada.
pub fn sandbox_hint(var: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    if var("CODEX_SANDBOX").is_some_and(|v| !v.is_empty()) {
        Some("codex")
    } else if var("SANDBOX").is_some_and(|v| !v.is_empty()) {
        Some("gemini")
    } else {
        None
    }
}

/// O erro de conectar ao canal com PID. Pura, para testar sem socket nem sandbox.
///
/// Permissão negada não é o app fechado: é o sandbox do agente (o do Codex em `workspace-write`
/// devolve `Operation not permitted (os error 1)` ao conectar num socket Unix fora das pastas
/// liberadas). Reiniciar o app não resolve e mata os terminais da pessoa, então a mensagem diz o
/// que fazer em cada agente. O resto continua sendo "o app pode ter fechado".
pub(crate) fn credential_connect_error(endpoint: &str, error: &std::io::Error, sandbox: Option<&str>) -> ExchangeError {
    if error.kind() != std::io::ErrorKind::PermissionDenied {
        return ExchangeError::unreachable(format!(
            "Não foi possível conectar ao socket de credencial {endpoint} ({error}). O app pode ter fechado: peça à pessoa para abri-lo."
        ));
    }
    let dir = std::path::Path::new(endpoint).parent().map(|d| d.display().to_string()).unwrap_or_else(|| endpoint.to_string());
    let what = match sandbox {
        Some("codex") => "Você está no sandbox do Codex. Rode este mesmo comando `ags` de novo pedindo escalonamento \
(sandbox_permissions: \"require_escalated\", justificativa: \"falar com o ADE AGS pelo socket local\"); a pessoa aprova na conversa ou no terminal. \
Para não pedir a cada vez, ela pode aprovar \"para a sessão\". Não use danger-full-access por isso."
            .to_string(),
        Some("gemini") => "Você está no sandbox do Gemini CLI. O perfil do macOS precisa permitir rede (permissive-open, o padrão) \
ou a pessoa abre o Gemini sem --sandbox; num contêiner (docker/podman) o socket do app não existe.".to_string(),
        _ => format!(
            "Algum sandbox do agente bloqueou o socket. Libere só a pasta {dir} para conexões AF_UNIX \
(Claude Code: sandbox.network.allowUnixSockets; Codex: pedir escalonamento ao rodar `ags`) ou rode o `ags` fora do sandbox, com aprovação da pessoa."
        ),
    };
    ExchangeError::denied(format!(
        "O sandbox do agente bloqueou o socket do ADE AGS ({endpoint}: {error}). O app está aberto: não o reinicie (isso fecha os terminais da pessoa). {what}"
    ))
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
        .map_err(|e| ExchangeError::gone(format!("Não foi possível enviar o comando: {e}")))?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|e| ExchangeError::gone(format!("O app não respondeu ao comando: {e}")))?;
    if response.trim().is_empty() {
        return Err(ExchangeError::gone("O app fechou a conexão sem responder (o comando pode ter falhado dentro dele). Veja o log do app."));
    }
    Ok(response)
}

fn exchange_tcp(handshake: &Handshake, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, handshake.port);
    let stream = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2)).map_err(|_| {
        ExchangeError::unreachable(format!(
            "Não foi possível conectar à porta {} (o app com PID {} pode ter fechado). Reinicie o app.",
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
    let stream = UnixStream::connect(endpoint)
        .map_err(|e| credential_connect_error(endpoint, &e, sandbox_hint(|k| std::env::var(k).ok())))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    write_and_read(stream, payload)
}

#[cfg(windows)]
fn exchange_credential(endpoint: &str, payload: &str, timeout: Duration) -> Result<String, ExchangeError> {
    let file = std::fs::OpenOptions::new().read(true).write(true).open(endpoint).map_err(|e| {
        ExchangeError::unreachable(format!(
            "Não foi possível conectar ao pipe {endpoint} ({e}). Reinicie o app."
        ))
    })?;
    // `File` não tem timeout de leitura. A thread só existe para não deixar
    // a CLI presa se a app aceitar o pipe e não responder.
    let (tx, rx) = std::sync::mpsc::channel();
    let payload = payload.to_owned();
    std::thread::spawn(move || {
        let _ = tx.send(write_and_read(file, &payload));
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => Err(ExchangeError::gone("O app não respondeu dentro do prazo.")),
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
    slots: std::sync::Arc<Slots>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let listener = bind_unix(&endpoint)?;
        std::thread::spawn(move || accept_unix(listener, app, token, slots));
        Ok(())
    }
    #[cfg(windows)]
    {
        // HANDLE é `*mut c_void` (não é Send): atravessa a thread como inteiro e volta lá dentro.
        let first = create_pipe(&endpoint)? as usize;
        std::thread::spawn(move || {
            accept_windows(first as windows_sys::Win32::Foundation::HANDLE, endpoint, app, token, slots)
        });
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (app, token, endpoint, slots);
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
fn accept_unix(listener: std::os::unix::net::UnixListener, app: AppHandle, token: String, slots: std::sync::Arc<Slots>) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        // Vagas só deste canal (F-03): o TCP cheio não tira a vaga de quem fala pelo socket de credencial.
        let Some(slot) = slots.try_acquire() else {
            drop(stream);
            continue;
        };
        let client_pid = peer_pid(&stream).ok();
        let app = app.clone();
        let token = token.to_string();
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(intake::READ_TIMEOUT_SECS)));
            let Ok(writer) = stream.try_clone() else { return };
            server::handle_connection(stream, writer, &app, &token, client_pid, slot);
        });
    }
}

#[cfg(windows)]
fn create_pipe(endpoint: &str) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
    let pipe = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            // PIPE_REJECT_REMOTE_CLIENTS é modo do pipe, não de abertura: no 2º argumento
            // o Windows recusa com "parâmetro incorreto" (87) e o canal nunca abre.
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
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
    slots: std::sync::Arc<Slots>,
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
        match slots.try_acquire() {
            None => {
                unsafe { CloseHandle(pipe) };
            }
            Some(slot) => {
                let file = unsafe { std::fs::File::from_raw_handle(pipe as RawHandle) };
                if let Ok(writer) = file.try_clone() {
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || {
                        server::handle_connection(file, writer, &app, &token, client_pid, slot);
                    });
                }
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
    use std::io::{Error, ErrorKind};

    #[test]
    fn socket_negado_pelo_sandbox_diz_o_que_fazer_e_nao_manda_reiniciar_o_app() {
        let endpoint = "/Users/x/.ags/ipc/42.sock";
        let eperm = Error::from_raw_os_error(1);
        assert_eq!(eperm.kind(), ErrorKind::PermissionDenied);
        let codex = super::credential_connect_error(endpoint, &eperm, Some("codex"));
        assert!(codex.denied && !codex.retryable);
        assert!(codex.message.contains("require_escalated"), "{}", codex.message);
        assert!(codex.message.contains("não o reinicie"));
        let gemini = super::credential_connect_error(endpoint, &eperm, Some("gemini"));
        assert!(gemini.message.contains("Gemini") && gemini.denied);
        let other = super::credential_connect_error(endpoint, &Error::from(ErrorKind::PermissionDenied), None);
        assert!(other.message.contains("/Users/x/.ags/ipc") && other.message.contains("allowUnixSockets"));
        // App fechado continua reintentável e não fala de sandbox.
        let gone = super::credential_connect_error(endpoint, &Error::from(ErrorKind::ConnectionRefused), Some("codex"));
        assert!(gone.retryable && !gone.denied && !gone.message.contains("sandbox"));
        assert!(!gone.message.contains("Reinicie o app"));
    }

    #[test]
    fn o_sandbox_vem_das_variaveis_que_cada_agente_poe_no_shell() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(super::sandbox_hint(env(&[("CODEX_SANDBOX", "seatbelt")])), Some("codex"));
        assert_eq!(super::sandbox_hint(env(&[("SANDBOX", "sandbox-exec")])), Some("gemini"));
        assert_eq!(super::sandbox_hint(env(&[("CODEX_SANDBOX", "")])), None);
        assert_eq!(super::sandbox_hint(env(&[])), None);
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[test]
    fn the_credential_socket_reports_this_process() {
        use std::os::unix::net::{UnixListener, UnixStream};
        // Nome curto: o caminho de um socket unix tem limite (104 bytes no macOS), e lá a pasta temporária já é longa.
        let id = uuid::Uuid::new_v4().simple().to_string();
        let path = std::env::temp_dir().join(format!("ags-{}-{}.sock", std::process::id(), &id[..8]));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        let pid = super::peer_pid(&server).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(pid, std::process::id());
    }

    /// O pipe abre de verdade e um cliente local conecta e é identificado pelo PID.
    #[cfg(windows)]
    #[test]
    fn the_credential_pipe_opens_and_reports_this_process() {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED};
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, GetNamedPipeClientProcessId};
        let endpoint = format!(r"\\.\pipe\ags-ipc-test-{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let pipe = super::create_pipe(&endpoint).expect("CreateNamedPipeW deve aceitar os parâmetros");
        let client = std::fs::OpenOptions::new().read(true).write(true).open(&endpoint).unwrap();
        let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
        assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
        let mut pid = 0u32;
        let ok = unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) };
        drop(client);
        unsafe { CloseHandle(pipe) };
        assert_ne!(ok, 0);
        assert_eq!(pid, std::process::id());
    }
}
