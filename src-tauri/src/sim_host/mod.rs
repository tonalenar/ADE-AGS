//! Simulador iOS na ADE, sem abrir o Device Hub da Apple.
//!
//! No Xcode 27 o Expo não acha o `Simulator.app` e cai em `open devices://` /
//! `open -a DeviceHub`. O app da Apple é só a janela: o aparelho continua
//! ligado se ela morre com SIGKILL (um SIGTERM deixa o próprio Hub desligar o
//! simulador ao sair). Os terminais da ADE ganham um `open` na frente do PATH
//! que engole esses argumentos, e um binário sem janela chamado `DeviceHub`
//! satisfaz a checagem do Expo (`System Events` procura um processo com esse
//! nome). A tela e o toque ficam no painel do simulador (`simulator/`).

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

#[cfg(target_os = "macos")]
const DECOY_STAMP: &str = "cocoa-accessory-1";

/// App Cocoa sem dock e sem janela. O nome que o Expo procura no System Events é o
/// do executável (`DeviceHub`); um `pause()` puro não aparece na lista de processos.
#[cfg(target_os = "macos")]
const DECOY_SOURCE: &str = r#"
#import <Cocoa/Cocoa.h>
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp run];
    }
    return 0;
}
"#;

static STOP: AtomicBool = AtomicBool::new(false);
static DECOY_PID: AtomicI32 = AtomicI32::new(0);

/// O Expo (e o `open -a Simulator` que ele tenta antes) pede a janela da Apple.
#[cfg_attr(not(test), allow(dead_code))]
pub fn blocks_device_hub_open(args: &[String]) -> bool {
    args.iter().any(|arg| blocks_open_arg(arg))
}

#[cfg_attr(not(test), allow(dead_code))]
fn blocks_open_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    lower.starts_with("devices:")
        || lower == "simulator"
        || lower == "devicehub"
        || lower == "device hub"
        || lower.contains("devicehub.app")
}

/// Reconhece só o executável dentro do bundle da Apple; o chamariz da ADE não entra.
fn is_apple_device_hub_path(path: &str) -> bool {
    path.ends_with("/DeviceHub.app/Contents/MacOS/DeviceHub")
}

fn apple_device_hub_pids_from_paths(
    processes: impl IntoIterator<Item = (i32, String)>,
) -> Vec<i32> {
    processes
        .into_iter()
        .filter_map(|(pid, path)| (pid > 1 && is_apple_device_hub_path(&path)).then_some(pid))
        .collect()
}

/// Coloca `dir` na frente do PATH quando `dir/open` existe.
pub fn prepend_dir(dir: Option<&Path>, current: &OsStr) -> OsString {
    let Some(dir) = dir else {
        return current.to_os_string();
    };
    if !dir.join("open").is_file() {
        return current.to_os_string();
    }
    let mut dirs = vec![dir.to_path_buf()];
    dirs.extend(std::env::split_paths(current).filter(|path| path != dir));
    std::env::join_paths(dirs).unwrap_or_else(|_| current.to_os_string())
}

pub fn shim_installed() -> bool {
    installed_shim_dir().is_some()
}

/// PATH do filho do PTY, com o `open` da ADE na frente quando o bloqueio está instalado.
/// `current` vazio herda o PATH deste processo: setar só a pasta do bloqueio apagaria o resto.
pub fn path_with_open_shim(current: &OsStr) -> OsString {
    let inherited;
    let base = if current.is_empty() {
        inherited = std::env::var_os("PATH").unwrap_or_default();
        inherited.as_os_str()
    } else {
        current
    };
    prepend_dir(installed_shim_dir().as_deref(), base)
}

fn installed_shim_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let dir = shim_dir()?;
        dir.join("open").is_file().then_some(dir)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn shim_dir() -> Option<PathBuf> {
    Some(crate::util::datadir::ags_home()?.join("bin"))
}

/// Script que os terminais acham como `open`. `decoy` e `pidfile` são caminhos absolutos.
pub fn open_shim_script(decoy: &str, pidfile: &str) -> String {
    format!(
        r#"#!/bin/sh
# ADE AGS: o Expo no Xcode 27 abre o Device Hub por `open`. O simulador segue pelo simctl.
real="${{ADE_OPEN_REAL:-/usr/bin/open}}"
decoy="${{ADE_DEVICEHUB_DECOY:-{decoy}}}"
pidfile="${{ADE_DEVICEHUB_PIDFILE:-{pidfile}}}"
blocked=0
for arg in "$@"; do
  low=$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')
  case "$low" in
    devices:*|simulator|devicehub|device\ hub|*devicehub.app*) blocked=1 ;;
  esac
done
if [ "$blocked" = 1 ]; then
  if [ -x "$decoy" ]; then
    alive=0
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    fi
    if [ "$alive" = 0 ]; then
      "$decoy" >/dev/null 2>&1 &
      echo $! > "$pidfile"
    fi
  fi
  exit 0
fi
exec "$real" "$@"
"#
    )
}

/// Prepara o bloqueio do Device Hub. A tela continua no painel do simulador.
pub fn start() {
    #[cfg(target_os = "macos")]
    {
        STOP.store(false, Ordering::SeqCst);
        if let Err(error) = install() {
            eprintln!("[ade-ags] não preparei o bloqueio do Device Hub: {error}");
        }
        spawn_watcher();
    }
}

/// Mata o chamariz que esta instância subiu. O aparelho do simulador não é filho dele.
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let pid = DECOY_PID.swap(0, Ordering::SeqCst);
        if pid > 1 && decoy_command_matches(pid) {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
}

#[cfg(target_os = "macos")]
fn install() -> Result<(), String> {
    let dir = shim_dir().ok_or("sem pasta de dados")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let decoy = dir.join("DeviceHub");
    let pidfile = dir.join("devicehub.pid");
    let script = open_shim_script(&decoy.display().to_string(), &pidfile.display().to_string());
    let open_path = dir.join("open");
    std::fs::write(&open_path, script).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&open_path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    ensure_decoy(&decoy, &pidfile)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_decoy(path: &Path, pidfile: &Path) -> Result<(), String> {
    let running = adopted_decoy(path, pidfile);
    if decoy_current(path) {
        if let Some(pid) = running {
            DECOY_PID.store(pid, Ordering::SeqCst);
            return Ok(());
        }
    } else if let Some(pid) = running {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    if !decoy_current(path) {
        compile_decoy(path)?;
    }
    spawn_decoy(path, pidfile)
}

#[cfg(target_os = "macos")]
fn decoy_current(path: &Path) -> bool {
    path.is_file()
        && std::fs::read_to_string(path.with_extension("stamp"))
            .ok()
            .as_deref()
            == Some(DECOY_STAMP)
}

#[cfg(target_os = "macos")]
fn compile_decoy(path: &Path) -> Result<(), String> {
    let source = path.with_extension("m");
    std::fs::write(&source, DECOY_SOURCE).map_err(|e| e.to_string())?;
    let mut cmd = crate::util::spawn::hidden_command("clang");
    cmd.args(["-fobjc-arc", "-framework", "Cocoa", "-O2", "-o"])
        .arg(path)
        .arg(&source);
    let output = crate::util::spawn::output(&mut cmd, std::time::Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(path);
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("clang do chamariz falhou: {err}"));
    }
    std::fs::write(path.with_extension("stamp"), DECOY_STAMP).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_decoy(path: &Path, pidfile: &Path) -> Result<(), String> {
    if STOP.load(Ordering::SeqCst) {
        return Ok(());
    }
    use std::process::Stdio;
    let mut cmd = crate::util::spawn::hidden_command(path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id() as i32;
    if let Err(error) = std::fs::write(pidfile, pid.to_string()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    DECOY_PID.store(pid, Ordering::SeqCst);
    // Esperar num fio à parte recolhe o processo quando ele morre. Largar o
    // `Child` sem `wait` deixaria um zumbi, e o `Drop` não mata ninguém.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn adopted_decoy(path: &Path, pidfile: &Path) -> Option<i32> {
    let pid = std::fs::read_to_string(pidfile)
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()?;
    if pid <= 1 || unsafe { libc::kill(pid, 0) } != 0 {
        return None;
    }
    process_command(pid)
        .contains(&path.display().to_string())
        .then_some(pid)
}

#[cfg(target_os = "macos")]
fn decoy_command_matches(pid: i32) -> bool {
    let Some(path) = shim_dir().map(|dir| dir.join("DeviceHub")) else {
        return false;
    };
    process_command(pid).contains(&path.display().to_string())
}

#[cfg(target_os = "macos")]
fn process_command(pid: i32) -> String {
    let mut cmd = crate::util::spawn::hidden_command("ps");
    cmd.args(["-p", &pid.to_string(), "-o", "command="]);
    match crate::util::spawn::output(&mut cmd, std::time::Duration::from_secs(2)) {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
fn spawn_watcher() {
    std::thread::Builder::new()
        .name("ade-device-hub".into())
        .spawn(|| {
            while !STOP.load(Ordering::SeqCst) {
                dismiss_apple_device_hub();
                keep_decoy();
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        })
        .ok();
}

#[cfg(target_os = "macos")]
fn dismiss_apple_device_hub() {
    for pid in apple_device_hub_pids() {
        // SIGKILL, não SIGTERM: ao sair de forma limpa o Device Hub desliga os simuladores.
        let rc = unsafe { libc::kill(pid, libc::SIGKILL) };
        if rc == 0 {
            eprintln!("[ade-ags] fechei o Device Hub (pid {pid}); o simulador continua ligado");
        }
    }
}

/// Consulta os processos pelo libproc do macOS, sem criar um `ps` a cada ciclo do watcher.
#[cfg(target_os = "macos")]
fn apple_device_hub_pids() -> Vec<i32> {
    use std::mem::size_of;

    // PROC_ALL_PIDS em <libproc.h>.
    const PROC_ALL_PIDS: u32 = 1;
    let required = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if required <= 0 {
        return Vec::new();
    }

    // Reserva espaço extra para processos iniciados entre as duas chamadas.
    let pid_size = size_of::<libc::pid_t>();
    let capacity = (required as usize).saturating_add(1024 * pid_size);
    let mut pids = vec![0 as libc::pid_t; capacity / pid_size];
    let byte_count = unsafe {
        libc::proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr().cast(),
            capacity.min(i32::MAX as usize) as i32,
        )
    };
    if byte_count <= 0 {
        return Vec::new();
    }
    pids.truncate((byte_count as usize / pid_size).min(pids.len()));

    let processes = pids.into_iter().filter_map(|pid| {
        if pid <= 1 {
            return None;
        }
        let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length =
            unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        (length > 0).then(|| {
            (
                pid,
                String::from_utf8_lossy(&path[..length as usize]).into_owned(),
            )
        })
    });
    apple_device_hub_pids_from_paths(processes)
}

#[cfg(target_os = "macos")]
fn keep_decoy() {
    if STOP.load(Ordering::SeqCst) {
        return;
    }
    let Some(dir) = shim_dir() else { return };
    let path = dir.join("DeviceHub");
    let pidfile = dir.join("devicehub.pid");
    let pid = DECOY_PID.load(Ordering::SeqCst);
    if pid > 1 && unsafe { libc::kill(pid, 0) } == 0 {
        return;
    }
    if ensure_decoy(&path, &pidfile).is_err() {
        // O próximo ciclo tenta de novo. Sem o chamariz o Expo volta a abrir o app da Apple.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconhece_o_que_abre_o_device_hub() {
        let cases = [
            (vec!["-a", "Simulator"], true),
            (
                vec!["-a", "simulator", "--args", "-CurrentDeviceUDID", "ABC"],
                true,
            ),
            (vec!["devices://device/open?id=ABC"], true),
            (vec!["Devices://device/open?id=ABC"], true),
            (vec!["-a", "DeviceHub"], true),
            (vec!["-a", "Device Hub"], true),
            (
                vec!["/Applications/Xcode.app/Contents/Applications/DeviceHub.app"],
                true,
            ),
            (vec!["-a", "TextEdit"], false),
            (vec!["/tmp/nota.txt"], false),
            (vec!["-a", "Visual Studio Code"], false),
        ];
        for (args, blocked) in cases {
            let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
            assert_eq!(blocks_device_hub_open(&owned), blocked, "{args:?}");
        }
    }

    #[test]
    fn o_pid_do_app_nao_pega_o_chamariz() {
        let processes = [
            (
                12,
                "/Applications/Xcode.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub",
            ),
            (99, "/Users/x/.ags/bin/DeviceHub"),
            (
                1,
                "/Applications/Xcode.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub",
            ),
            (23, "/tmp/DeviceHub.app/Contents/MacOS/DeviceHub-helper"),
        ];
        let paths = processes
            .into_iter()
            .map(|(pid, path)| (pid, path.to_string()));
        assert_eq!(apple_device_hub_pids_from_paths(paths), vec![12]);
    }

    #[test]
    fn watcher_varre_processos_sem_criar_um_ps() {
        let source = include_str!("mod.rs");
        let watcher_scan = source
            .split("fn dismiss_apple_device_hub()")
            .nth(1)
            .unwrap()
            .split("#[cfg(target_os = \"macos\")]\nfn apple_device_hub_pids()")
            .next()
            .unwrap();
        assert!(watcher_scan.contains("apple_device_hub_pids()"));
        assert!(!watcher_scan.contains("hidden_command(\"ps\")"));
        assert!(source.contains("libc::proc_listpids("));
    }

    #[test]
    fn o_path_ganha_a_pasta_do_open_na_frente() {
        let dir = std::env::temp_dir().join(format!("ags-sim-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("open"), "#!/bin/sh\n").unwrap();
        let joined = prepend_dir(Some(&dir), OsStr::new("/usr/bin:/bin"));
        let mut parts = std::env::split_paths(&joined);
        assert_eq!(parts.next().unwrap(), dir);
        assert!(prepend_dir(None, OsStr::new("/usr/bin")) == OsStr::new("/usr/bin"));
        let vazio = dir.join("sem-open");
        std::fs::create_dir_all(&vazio).unwrap();
        assert!(prepend_dir(Some(&vazio), OsStr::new("/bin")) == OsStr::new("/bin"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn o_script_engole_o_device_hub_e_repassa_o_resto() {
        let dir = std::env::temp_dir().join(format!("ags-sim-sh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("open");
        let log = dir.join("log");
        let pidfile = dir.join("pid");
        std::fs::write(
            &script,
            open_shim_script("/usr/bin/true", &pidfile.display().to_string()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let recorder = dir.join("record");
        std::fs::write(
            &recorder,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$ADE_OPEN_LOG\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&recorder, std::fs::Permissions::from_mode(0o755)).unwrap();

        let cases = [
            (vec!["-a", "Simulator"], true),
            (vec!["devices://device/open?id=1"], true),
            (vec!["-a", "DeviceHub"], true),
            (vec!["-a", "Device Hub"], true),
            (vec!["-a", "TextEdit"], false),
            (vec!["/tmp/nota.txt"], false),
        ];
        for (args, blocked) in cases {
            let _ = std::fs::remove_file(&log);
            let mut cmd = crate::util::spawn::hidden_command(&script);
            cmd.env("ADE_OPEN_REAL", &recorder);
            cmd.env("ADE_OPEN_LOG", &log);
            cmd.env("ADE_DEVICEHUB_DECOY", "/usr/bin/true");
            cmd.env("ADE_DEVICEHUB_PIDFILE", &pidfile);
            cmd.args(&args);
            let output =
                crate::util::spawn::output(&mut cmd, std::time::Duration::from_secs(5)).unwrap();
            assert!(
                output.status.success(),
                "{args:?} {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let wrote = std::fs::read_to_string(&log).unwrap_or_default();
            assert_eq!(wrote.is_empty(), blocked, "{args:?} log={wrote}");
            if !blocked {
                assert!(wrote.contains(args.last().unwrap()), "{wrote}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
