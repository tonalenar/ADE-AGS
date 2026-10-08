//! Único lugar que cria um `Command` do app e o único que espera um processo com prazo.
//!
//! No Windows todo processo sai com `CREATE_NO_WINDOW` (`0x08000000`), salvo o modo
//! explícito [`WindowMode::OwnWindow`] do emulador Android. A flag é aplicada no
//! `std::process::Command` **antes** de `tokio::process::Command::from`: o `from` copia
//! o que já está no comando, e setar depois não chega no `CreateProcess`.
//!
//! `output` e `wait_copying_stdout` têm timeout obrigatório. No estouro o grupo morre
//! (sessão nova no Unix, Job Object no Windows) e o erro é `TimedOut`.
//!
//! Este helper não embrulha argv em `cmd /C`. A exceção é o prelaunch do PTY: um `.cmd`
//! no mesmo `cmd` do agente, lançado pelo `CommandBuilder` dentro do ConPTY
//! (`CREATE_NO_WINDOW`), não por aqui.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

/// `CREATE_NO_WINDOW`. Sem isso um binário de console aberto por um app de janela
/// pisca um `conhost`. No Linux a constante existe para o teste de fonte.
#[cfg_attr(not(windows), allow(dead_code))]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `DETACHED_PROCESS`. Junto com `CREATE_NO_WINDOW`, o emulador sobrevive à app.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DETACHED_PROCESS: u32 = 0x0000_0008;

const POLL: Duration = Duration::from_millis(25);

/// Como a janela do processo filho deve nascer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowMode {
    /// Sem console. É o caminho de todo spawn do app.
    Hidden,
    /// Processo destacado, ainda sem console herdado. Só `android::start_avd`.
    OwnWindow,
}

/// `Command` já com a flag da plataforma. No Unix a flag não existe e isto é `Command::new`.
pub fn command(program: impl AsRef<OsStr>, window: WindowMode) -> Command {
    let mut cmd = Command::new(program);
    apply_window(&mut cmd, window);
    cmd
}

/// Atalho de [`command`] com [`WindowMode::Hidden`].
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    command(program, WindowMode::Hidden)
}

/// Aplica o modo de janela. Pode ser chamada mais de uma vez: no Windows as flags se acumulam.
pub fn apply_window(cmd: &mut Command, window: WindowMode) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let flags = match window {
            WindowMode::Hidden => CREATE_NO_WINDOW,
            WindowMode::OwnWindow => CREATE_NO_WINDOW | DETACHED_PROCESS,
        };
        cmd.creation_flags(flags);
    }
    #[cfg(not(windows))]
    {
        let _ = (cmd, window);
    }
}

/// Converte para tokio **depois** de gravar a flag no comando padrão.
pub fn into_tokio(mut command: Command) -> tokio::process::Command {
    apply_window(&mut command, WindowMode::Hidden);
    tokio::process::Command::from(command)
}

/// Como `Command::output()`, com prazo, kill do grupo e uma linha de log.
pub fn output(cmd: &mut Command, timeout: Duration) -> io::Result<Output> {
    apply_window(cmd, WindowMode::Hidden);
    prepare_session(cmd);
    let started = Instant::now();
    let program = program_of(cmd);
    let argv = redact_argv(cmd.get_args());

    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).spawn()?;
    let mut guard = GroupGuard::adopt(&child);

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_all(out_pipe.as_mut()));
    let err_reader = std::thread::spawn(move || read_all(err_pipe.as_mut()));

    let status = match wait_deadline(&mut child, &mut guard, timeout) {
        Ok(status) => status,
        Err(error) => {
            log_finish(&program, &argv, started.elapsed(), None);
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(error);
        }
    };

    log_finish(&program, &argv, started.elapsed(), status.code());
    Ok(Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Espera o filho copiando o stdout para o stderr deste processo. Usado pelo `ags test`,
/// que não pode guardar a suíte inteira na memória nem ficar sem prazo.
pub fn wait_copying_stdout(cmd: &mut Command, timeout: Duration) -> io::Result<ExitStatus> {
    apply_window(cmd, WindowMode::Hidden);
    prepare_session(cmd);
    let started = Instant::now();
    let program = program_of(cmd);
    let argv = redact_argv(cmd.get_args());

    let mut child = cmd.stdout(Stdio::piped()).spawn()?;
    let mut guard = GroupGuard::adopt(&child);
    let mut pipe = child.stdout.take();
    let copier = std::thread::spawn(move || {
        if let Some(source) = pipe.as_mut() {
            let _ = io::copy(source, &mut io::stderr());
        }
    });

    let status = match wait_deadline(&mut child, &mut guard, timeout) {
        Ok(status) => status,
        Err(error) => {
            log_finish(&program, &argv, started.elapsed(), None);
            let _ = copier.join();
            return Err(error);
        }
    };
    let _ = copier.join();
    log_finish(&program, &argv, started.elapsed(), status.code());
    Ok(status)
}

/// Uma linha: programa, argv sem segredo, duração e exit code (`timeout` se o prazo estourou).
pub fn log_finish(program: &str, argv: &str, elapsed: Duration, code: Option<i32>) {
    let exit = match code {
        Some(code) => code.to_string(),
        None => "timeout".to_string(),
    };
    eprintln!(
        "[spawn] program={program} argv={argv} dur_ms={} exit={exit}",
        elapsed.as_millis()
    );
}

/// Junta os argumentos numa linha, tirando segredo e cortando o que for enorme.
pub fn redact_argv<'a>(args: impl Iterator<Item = &'a OsStr>) -> String {
    let mut parts = Vec::new();
    let mut total = 0usize;
    for arg in args {
        let text = arg.to_string_lossy();
        let redacted = redact_arg(&text);
        total += redacted.len();
        parts.push(redacted);
        if total > 400 {
            parts.push("…".to_string());
            break;
        }
    }
    parts.join(" ")
}

fn redact_arg(arg: &str) -> String {
    let lower = arg.to_ascii_lowercase();
    for marker in ["token=", "secret=", "password=", "api_key=", "apikey=", "authorization="] {
        if let Some(index) = lower.find(marker) {
            return format!("{}***", &arg[..index + marker.len()]);
        }
    }
    if arg.starts_with("sk-")
        || arg.starts_with("ghp_")
        || arg.starts_with("github_pat_")
        || arg.starts_with("xox")
    {
        return "***".into();
    }
    if arg.chars().count() > 180 {
        let head: String = arg.chars().take(24).collect();
        return format!("{head}…");
    }
    arg.to_string()
}

fn program_of(cmd: &Command) -> String {
    cmd.get_program().to_string_lossy().into_owned()
}

fn read_all(pipe: Option<&mut impl Read>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(pipe) = pipe {
        let _ = pipe.read_to_end(&mut buf);
    }
    buf
}

fn wait_deadline(child: &mut std::process::Child, guard: &mut GroupGuard, timeout: Duration) -> io::Result<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
            None if Instant::now() >= deadline => {
                guard.kill();
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("el comando no terminó en {}s", timeout.as_secs_f32()),
                ));
            }
            None => std::thread::sleep(POLL),
        }
    }
}

/// Novo grupo de processos no Unix para que `kill(-pid)` alcance o que o comando lançou.
///
/// `process_group(0)` é o caminho da biblioteca padrão. Um `pre_exec` nosso com `setsid`
/// deadlockava o `fork` quando a suíte inteira corria em paralelo (o filho herdava um
/// mutex e não chegava no `exec`).
fn prepare_session(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

struct GroupGuard {
    #[cfg(unix)]
    pid: i32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl GroupGuard {
    fn adopt(child: &std::process::Child) -> Self {
        #[cfg(unix)]
        {
            Self { pid: child.id() as i32 }
        }
        #[cfg(windows)]
        {
            Self { job: adopt_job(child) }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child;
            Self {}
        }
    }

    fn kill(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            if self.job.is_null() {
                return;
            }
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            }
        }
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if !self.job.is_null() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
            self.job = std::ptr::null_mut();
        }
    }
}

#[cfg(windows)]
fn adopt_job(child: &std::process::Child) -> windows_sys::Win32::Foundation::HANDLE {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return job;
    }
    // Sem KILL_ON_JOB_CLOSE: fechar o handle no sucesso não mata um neto que o
    // comando deixou de propósito. O timeout chama `TerminateJobObject`.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = 0;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // O handle do filho ainda é o nosso: evita reabrir por pid. A janela entre
        // o spawn e o assign é a mesma que o Job Object das tabs já aceita.
        AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
    }
    job
}

/// Mantém o nome vivo para o log do supervisor, que espera o tokio `Child` por conta própria.
pub fn argv_of(program: &OsStr, args: &[OsString]) -> (String, String) {
    (program.to_string_lossy().into_owned(), redact_argv(args.iter().map(OsString::as_os_str)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redige_segredo_e_corta_argumento_enorme() {
        let argv = redact_argv(
            [
                OsStr::new("--resume"),
                OsStr::new("password=hunter2"),
                OsStr::new("sk-live-secret"),
                OsStr::new(&"x".repeat(300)),
            ]
            .into_iter(),
        );
        assert!(argv.contains("--resume"), "{argv}");
        assert!(argv.contains("password=***"), "{argv}");
        assert!(!argv.contains("hunter2"), "{argv}");
        assert!(argv.contains("***"), "{argv}");
        assert!(!argv.contains(&"x".repeat(40)), "{argv}");
    }

    /// No CI Linux não dá para inspecionar a flag do `CreateProcess`. O contrato fica no fonte:
    /// a constante e o `creation_flags` vivem aqui, e `into_tokio` aplica a flag antes do `from`.
    #[test]
    fn a_flag_create_no_window_esta_no_helper() {
        let src = include_str!("spawn.rs");
        let flags = src.find("fn apply_window").expect("apply_window");
        let into = src.find("fn into_tokio").expect("into_tokio");
        let body = &src[into..into + 280];
        assert!(src.contains("0x0800_0000"), "{src}");
        assert!(src[flags..].contains("creation_flags"), "a flag tem que ir para o Command");
        assert!(body.find("apply_window").unwrap() < body.find("Command::from").unwrap(), "{body}");
        assert!(src.contains("WindowMode::OwnWindow"));
    }

    #[test]
    #[cfg(unix)]
    fn timeout_mata_o_grupo() {
        let started = Instant::now();
        let err = output(
            hidden_command("sh").arg("-c").arg("sleep 30"),
            Duration::from_millis(200),
        )
        .expect_err("o sleep não pode vencer o prazo");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }
}
