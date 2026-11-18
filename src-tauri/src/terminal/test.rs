//! Tests de la terminal: cómo se arma el lanzamiento y cómo se contiene el árbol de
//! procesos de una tab.

use super::pty_manager::{PARENT_SESSION_ENV, build_launch, launch_script};

#[test]
fn resize_measurements_preserve_valid_sizes_and_bound_extremes() {
    use super::pty_manager::{MAX_PTY_DIMENSION, measured_pty_size};
    for (cols, rows) in [
        (1, 1),
        (80, 24),
        (240, 80),
        (MAX_PTY_DIMENSION, MAX_PTY_DIMENSION),
    ] {
        let size = measured_pty_size(cols, rows).unwrap();
        assert_eq!((size.cols, size.rows), (cols, rows));
        assert_eq!((size.pixel_width, size.pixel_height), (0, 0));
    }
    for (cols, rows, expected) in [
        (u16::MAX, 24, (MAX_PTY_DIMENSION, 24)),
        (80, u16::MAX, (80, MAX_PTY_DIMENSION)),
        (u16::MAX, u16::MAX, (MAX_PTY_DIMENSION, MAX_PTY_DIMENSION)),
    ] {
        let size = measured_pty_size(cols, rows).unwrap();
        assert_eq!((size.cols, size.rows), expected);
    }
}

#[test]
fn zero_slot_measurement_keeps_live_pty_size_until_next_fit() {
    use super::pty_manager::{measured_pty_size, resize_measured_pty};
    use portable_pty::{PtySize, native_pty_system};

    let pair = native_pty_system()
        .openpty(PtySize {
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    for (cols, rows) in [(0, 0), (0, 24), (80, 0), (0, u16::MAX)] {
        assert!(measured_pty_size(cols, rows).is_none());
        resize_measured_pty(pair.master.as_ref(), cols, rows).unwrap();
        let size = pair.master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (80, 24));
    }
    resize_measured_pty(pair.master.as_ref(), 120, 40).unwrap();
    let size = pair.master.get_size().unwrap();
    assert_eq!((size.cols, size.rows), (120, 40));
}

// ── Lanzamiento del agente ──────────────────────────────────────

#[test]
fn un_solo_paso_precede_al_agente() {
    let script = launch_script("claude", &["conda activate ml".into()]);
    assert!(script.starts_with("conda activate ml && "), "{script}");
    assert!(script.ends_with("claude"), "{script}");
}

#[test]
fn los_pasos_conservan_el_orden() {
    // El orden es semántico: `nvm use` tiene que correr antes de nada que dependa de
    // npm, y el venv antes de un export que use una ruta suya.
    let script = launch_script(
        "codex",
        &["nvm use 18".into(), "source .venv/bin/activate".into()],
    );
    let nvm = script.find("nvm use 18").unwrap();
    let venv = script.find("source .venv").unwrap();
    let agente = script.find("codex").unwrap();
    assert!(nvm < venv && venv < agente, "{script}");
}

#[test]
fn los_pasos_se_encadenan_con_and_para_que_un_fallo_no_lance_el_agente() {
    let script = launch_script("claude", &["a".into(), "b".into()]);
    assert_eq!(script.matches("&&").count(), 2, "{script}");
    assert!(
        !script.contains(';'),
        "un `;` dejaría arrancar el agente igual: {script}"
    );
}

#[cfg(unix)]
#[test]
fn en_unix_el_agente_reemplaza_al_shell() {
    // Sin `exec` el shell quedaría de padre y `pty_kill` apuntaría a él en vez de al
    // agente.
    assert!(launch_script("claude", &["x".into()]).contains("&& exec claude"));
}

#[test]
fn el_comando_de_reanudacion_llega_entero() {
    // El `--resume <id>` lo arma el frontend antes de llegar acá; el envoltorio no
    // puede partirlo.
    let script = launch_script("claude --resume abc-123", &["nvm use".into()]);
    assert!(script.ends_with("claude --resume abc-123"), "{script}");
}

/// Sin pre-comandos el spawn tiene que quedar IDÉNTICO al de siempre: nada de shells
/// de por medio. Es la garantía de que esta feature no puede romper a quien no la usa.
#[test]
fn sin_pasos_se_lanza_el_binario_directo_sin_shell() {
    let cmd = build_launch("ade-test-missing-agent --resume abc", &[]).unwrap();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(argv, vec!["ade-test-missing-agent", "--resume", "abc"]);
}

/// Um caminho absoluto não volta a ser só o nome: o PTY não procura fora do PATH.
#[cfg(unix)]
#[test]
fn una_ruta_absoluta_se_lanza_tal_cual() {
    let dir = std::env::temp_dir().join(format!("ags-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("ags-cursor-fake");
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&bin).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&bin, perms).unwrap();
    let cmd = build_launch(&format!("{} --version", bin.display()), &[]).unwrap();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(argv[0], bin.to_string_lossy());
    assert_eq!(argv[1], "--version");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Con pre-comandos, el comando entero viaja como UN argumento del shell. Eso también
/// hace que el `split_whitespace` de arriba no llegue a partirlo.
#[test]
fn con_pasos_el_comando_viaja_entero_como_argumento_del_shell() {
    let cmd = build_launch("claude --resume abc", &["nvm use".into()]).unwrap();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let last = argv.last().expect("el script va último");
    // En Windows el script viaja en un .cmd (ver `shell_running`): se lee de ahí.
    let script = if cfg!(windows) && last.ends_with(".cmd") {
        std::fs::read_to_string(last).unwrap()
    } else {
        last.clone()
    };
    let script = script.trim_end();
    assert!(script.contains("nvm use"), "{script}");
    assert!(script.ends_with("claude --resume abc"), "{script}");
    assert!(
        argv.len() >= 2,
        "tendría que haber flags de shell antes del script: {argv:?}"
    );
}

/// `conda activate`, `nvm use`, `set` y `cd` tienen que quedar en el MISMO shell que el
/// agente. Un proceso por paso perdería el entorno. En Windows eso es un solo `cmd /C`
/// de un `.cmd`; en Unix, un solo `-c` con `&& exec`.
#[test]
fn prelaunch_e_agente_no_mesmo_processo_de_shell() {
    let steps = [
        "conda activate base".to_string(),
        "nvm use".to_string(),
        "set VAR=1".to_string(),
        r"cd /d C:\w".to_string(),
    ];
    let script = launch_script("claude --resume abc", &steps);
    for step in &steps {
        assert!(script.contains(step), "{script}");
    }
    assert!(script.contains("claude --resume abc"), "{script}");
    assert!(
        !script.contains(';'),
        "un `;` seguiría aunque un paso fallara: {script}"
    );
    assert_eq!(
        script.matches("&&").count(),
        steps.len(),
        "un solo script, no un proceso por paso: {script}"
    );

    let cmd = build_launch("claude --resume abc", &steps).unwrap();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    if cfg!(windows) {
        assert_eq!(
            argv.len(),
            3,
            "un único cmd /C, no un proceso por paso: {argv:?}"
        );
        assert!(argv[0].eq_ignore_ascii_case("cmd"), "{argv:?}");
        assert_eq!(argv[1], "/C");
        assert!(argv[2].ends_with(".cmd"), "{argv:?}");
        let body = std::fs::read_to_string(&argv[2]).unwrap();
        for step in &steps {
            assert!(body.contains(step), "{body}");
        }
        assert!(body.contains("claude --resume abc"), "{body}");
        assert!(!body.contains("\\\""), "{body}");
    } else {
        let last = argv.last().unwrap();
        assert!(
            last.contains("conda activate base") && last.contains("claude --resume abc"),
            "{argv:?}"
        );
        assert!(
            argv.iter().any(|arg| arg == "-c"),
            "el shell recibe el script en un solo -c: {argv:?}"
        );
    }
}

/// Las comillas del comando llegan intactas al agente: en Windows el script va en un .cmd y no
/// como argumento de `cmd /C`, que las volvía literales (`--mcp-config "C:\x.json"` fallaba).
#[cfg(windows)]
#[test]
fn con_pasos_las_comillas_del_comando_no_se_escapan() {
    let command = r#"claude --mcp-config "C:\Users\x\mcp\tab.json" --allowedTools "a,b""#;
    let cmd = build_launch(command, &["cd /d C:\\w".into()]).unwrap();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let last = argv.last().unwrap();
    assert!(last.ends_with(".cmd"), "{argv:?}");
    let body = std::fs::read_to_string(last).unwrap();
    assert!(body.contains(command), "{body}");
    assert!(!body.contains("\\\""), "{body}");
}

#[test]
fn conpty_windows_pede_create_no_window() {
    let src = include_str!("win_conpty.rs");
    assert!(
        src.contains("CREATE_NO_WINDOW"),
        "o wrapper tem que passar a flag"
    );
    assert!(src.contains("EXTENDED_STARTUPINFO_PRESENT"));
    assert!(src.contains("PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE") || src.contains("0x0002_0016"));
    let manager = include_str!("pty_manager.rs");
    assert!(
        manager.contains("ags-launch"),
        "o prelaunch do Windows volta a gravar um .cmd"
    );
    assert!(
        manager.contains("CommandBuilder::new(\"cmd\")"),
        "o .cmd sobe num único cmd"
    );
    assert!(
        !manager.contains("run_prelaunch_steps"),
        "passos separados perdem conda/nvm/set/cd"
    );
}

// ── Recorrido del árbol de procesos (unix) ──────────────────────

#[cfg(windows)]
#[test]
fn windows_pty_resolves_npm_shim_and_preserves_arguments() {
    let root = std::env::temp_dir().join(format!("ade-pty-shim-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    std::fs::write(root.join("node.exe"), b"fixture").unwrap();
    std::fs::write(root.join("node_modules/cli.js"), b"fixture").unwrap();
    std::fs::write(root.join("agent"), b"#!/bin/sh").unwrap();
    std::fs::write(root.join("agent.cmd"), "@echo off\r\nIF EXIST \"%dp0%\\node.exe\" (\r\nSET \"_prog=%dp0%\\node.exe\"\r\n)\r\n\"%_prog%\" \"%dp0%\\node_modules\\cli.js\" %*\r\n").unwrap();
    let command = format!(
        "\"{}\" --resume \"session with spaces & literal\"",
        root.join("agent").display()
    );
    let cmd = build_launch(&command, &[]).unwrap();
    let argv = cmd.get_argv();
    assert_eq!(std::path::Path::new(&argv[0]), root.join("node.exe"));
    assert_eq!(
        std::path::Path::new(&argv[1]),
        root.join("node_modules/cli.js")
    );
    assert_eq!(argv[2], "--resume");
    assert_eq!(argv[3], "session with spaces & literal");
    std::fs::remove_dir_all(&root).unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "requires the installed Codex CLI; only runs --version, no inference"]
fn installed_codex_starts_in_windows_pty_without_inference() {
    use portable_pty::{PtySize, native_pty_system};
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut child = pair
        .slave
        .spawn_command(build_launch("codex --version", &[]).unwrap())
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{status:?}");
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            panic!("Codex --version timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(unix)]
mod arbol {
    use crate::terminal::containment::unix_tree::descendants;

    #[test]
    fn recorre_el_arbol_completo_y_no_toca_ramas_ajenas() {
        // 100 ─ 200 ─ 300
        //     └ 201
        // 900 ─ 901   (rama ajena)
        let procs = [(200, 100), (300, 200), (201, 100), (901, 900), (100, 1)];
        let mut got = descendants(100, &procs);
        got.sort();
        assert_eq!(got, vec![200, 201, 300]);
    }

    #[test]
    fn los_hijos_salen_antes_que_los_nietos() {
        let procs = [(300, 200), (200, 100)];
        // El orden importa: `kill_tree` lo invierte para matar hojas primero.
        assert_eq!(descendants(100, &procs), vec![200, 300]);
    }

    #[test]
    fn un_ciclo_de_pids_no_cuelga_el_recorrido() {
        let procs = [(200, 100), (100, 200)];
        assert_eq!(descendants(100, &procs), vec![200]);
    }

    #[test]
    fn una_hoja_sin_hijos_no_devuelve_nada() {
        assert_eq!(descendants(100, &[(901, 900)]), Vec::<u32>::new());
    }
}

// ── Fin a fin: matar la tab se lleva su descendencia ────────────

/// Regresión del caso que motivó este módulo, reproducido punta a punta contra procesos
/// reales: un "agente" que lanza algo con `setsid`, o sea fuera de su grupo y de su sesión.
///
/// Es justo el que `examples/orphan_probe.rs` mide sobreviviendo tanto al `SIGHUP` que
/// manda `portable-pty` como a un `killpg`. Si este test se vuelve verde por accidente
/// —porque el nieto muriera por el colgado del terminal en vez de por el grupo— dejaría de
/// probar nada, así que el nieto se lanza con `setsid` precisamente para quedar fuera del
/// alcance de esa red de seguridad.
///
/// **Solo Linux, y solo con cgroups.** Atrapar a ese nieto es exactamente lo que ningún
/// recorrido por `ppid` puede hacer, así que el único mecanismo que cumple es el cgroup.
/// En macOS la contención es best-effort por diseño (ver `containment`), y en Linux sin
/// delegación de cgroups —un contenedor, o los runners de CI— la app cae al mismo respaldo
/// best-effort. Afirmar la garantía ahí sería afirmar algo que el código nunca prometió,
/// así que el test se saltea y dice por qué.
#[cfg(all(test, target_os = "linux"))]
mod tests_e2e {
    use crate::terminal::containment::ProcessGroup;
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn vivo(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn matar_una_tab_se_lleva_a_un_nieto_que_se_fue_a_su_propia_sesion() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        // `setsid` deja al nieto en su propia sesión: ni el hangup del tty ni un killpg
        // sobre el grupo del agente lo alcanzan.
        cmd.arg("setsid sleep 30 & sleep 0.3; pgrep -n -x sleep; sleep 30");

        let mut group = ProcessGroup::new(9_999);
        let child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);

        // Después de `adopt` y no antes: el cgroup puede existir y aun así no dejarnos
        // mover procesos, y eso recién se sabe al intentarlo.
        if !group.is_escape_proof() {
            eprintln!(
                "omitido: sin cgroups delegados, la app cae al recorrido por `ppid`, que \
                 por diseño no alcanza a un proceso en otra sesión. No hay garantía que probar."
            );
            return;
        }

        // El agente imprime el pid del nieto por el pty.
        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(pid) = acc.split_whitespace().find_map(|w| w.parse::<u32>().ok()) {
                    let _ = tx.send(pid);
                    break;
                }
            }
        });
        let nieto = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("pid del nieto");
        assert!(
            vivo(nieto),
            "el nieto tendría que estar vivo antes de matar el grupo"
        );

        group.kill_all();
        drop(pty);

        // La muerte no es instantánea: se le da margen antes de declararla fuga.
        let limite = Instant::now() + Duration::from_secs(5);
        while vivo(nieto) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }

        let sobrevivio = vivo(nieto);
        if sobrevivio {
            unsafe { libc::kill(nieto as i32, libc::SIGKILL) };
        }
        assert!(
            !sobrevivio,
            "el nieto {nieto} quedó huérfano tras matar el grupo"
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests_cgroup {
    use crate::terminal::containment::{ProcessGroup, imp};

    fn cgroup_de(pid: u32) -> String {
        std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
            .unwrap_or_default()
            .lines()
            .find_map(|l| l.strip_prefix("0::").map(str::to_string))
            .unwrap_or_default()
    }

    #[test]
    fn adoptar_mueve_al_proceso_a_un_cgroup_propio() {
        let antes = cgroup_de(std::process::id());
        let mut hijo = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn");
        let pid = hijo.id();

        let mut group = ProcessGroup::new(9_001);
        // Se adopta un `std::process::Child`, que implementa el mismo trait que el hijo
        // del PTY, así se ejercita `adopt` sin montar un pty entero.
        group.adopt(&hijo);

        let despues = cgroup_de(pid);
        // Si el entorno no permite cgroups (contenedor sin delegación, cgroup v1) el
        // módulo cae al recorrido por `ppid` y no hay nada que verificar acá.
        if imp::usa_cgroup(&group.imp) {
            assert_ne!(
                despues, antes,
                "el proceso tendría que haber cambiado de cgroup"
            );
            assert!(
                despues.ends_with("/cc-tab-9001"),
                "quedó en {despues}, no en el cgroup de la tab"
            );
        }

        group.kill_all();
        let _ = hijo.kill();
        let _ = hijo.wait();
    }

    #[test]
    fn el_cgroup_de_la_tab_se_borra_al_matarla() {
        let mut group = ProcessGroup::new(9_002);
        let dir: Option<std::path::PathBuf> = imp::dir_de(&group.imp);
        if let Some(d) = &dir {
            assert!(
                d.exists(),
                "el cgroup tendría que existir tras crear el grupo"
            );
        }
        group.kill_all();
        if let Some(d) = &dir {
            assert!(!d.exists(), "el cgroup quedó colgado tras matar la tab");
        }
    }
}

/// Regresión del caso que `examples/orphan_probe.rs` midió fugando en Windows: un hijo
/// **normal** del agente (ni siquiera hace falta que se desprenda de nada) sobrevive al
/// cierre de la tab, porque `TerminateProcess` no toca a los descendientes y allá no
/// existe la red del kernel que en unix tapa este caso.
#[cfg(all(test, windows))]
mod tests_e2e {
    use crate::terminal::containment::{ProcessGroup, imp};
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::Read;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    };

    fn process_handle(pid: u32) -> OwnedHandle {
        // O handle fica válido após a morte do processo; o PID pode ser reutilizado.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        assert!(
            !handle.is_null(),
            "OpenProcess({pid}): {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: OpenProcess devolveu um handle válido, transferido uma única vez ao RAII.
        unsafe { OwnedHandle::from_raw_handle(handle as _) }
    }

    #[test]
    fn matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // PowerShell hace de agente: lanza un proceso aparte y reporta su pid.
        let mut cmd = CommandBuilder::new("powershell");
        cmd.arg("-NoProfile");
        cmd.arg("-Command");
        cmd.arg(
            "$p = Start-Process -PassThru -WindowStyle Hidden ping \
             -ArgumentList '-n','60','127.0.0.1'; \
             Write-Output \"NIETO=$($p.Id)\"; Start-Sleep 60",
        );

        let mut group = ProcessGroup::new(9_003);
        let child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);
        assert!(imp::usa_job(&group.imp), "no se pudo crear el Job Object");

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(rest) = acc.split("NIETO=").nth(1) {
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    // Se espera a ver un separador para no leer un pid cortado a la mitad
                    // por el chunk.
                    if digits.len() < rest.len() {
                        if let Ok(pid) = digits.parse::<u32>() {
                            let _ = tx.send(pid);
                            break;
                        }
                    }
                }
            }
        });
        let nieto = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("pid del nieto");
        let original = process_handle(nieto);
        let handle = original.as_raw_handle() as HANDLE;
        assert_eq!(
            unsafe { WaitForSingleObject(handle, 0) },
            WAIT_TIMEOUT,
            "el nieto tendría que estar vivo antes de matar el grupo"
        );
        group.kill_all();
        drop(pty);

        // Espera o processo ORIGINAL, sem consultar de novo um PID que pode ser de git/tasklist.
        let wait = unsafe { WaitForSingleObject(handle, 5_000) };
        if wait != WAIT_OBJECT_0 {
            // A limpeza também usa identidade estável: nunca mata outro processo pelo PID reciclado.
            unsafe {
                TerminateProcess(handle, 1);
            }
        }
        assert_eq!(
            wait, WAIT_OBJECT_0,
            "el nieto original {nieto} quedó vivo tras matar el grupo (wait={wait})"
        );
    }
}

#[test]
fn el_fin_del_buffer_no_corta_un_caracter_al_medio() {
    use super::pty_manager::tail_start;
    let data = "olá — fim".as_bytes();
    assert_eq!(tail_start(data, 1000), 0);
    assert_eq!(&data[tail_start(data, 3)..], b"fim");
    // «—» tem 3 bytes: pedir 5 cai no meio dele e o começo avança para o próximo caractere.
    let start = tail_start(data, 7);
    assert!(std::str::from_utf8(&data[start..]).is_ok(), "{start}");
    assert_eq!(tail_start(b"", 10), 0);
}

/// Sin pre-comandos el comando se parte para lanzar el binario directo, y ahí las comillas
/// importan: una TUI instalada en una ruta con espacios, o un flag con un valor
/// entrecomillado, llegaban partidos en pedazos.
#[test]
fn el_comando_se_parte_respetando_las_comillas() {
    use super::pty_manager::split_command;

    assert_eq!(
        split_command("claude --resume abc"),
        vec!["claude", "--resume", "abc"]
    );
    assert_eq!(
        split_command("\"/home/u/mis tools/agente\" --flag"),
        vec!["/home/u/mis tools/agente", "--flag"]
    );
    assert_eq!(
        split_command("claude --system-prompt \"hola mundo\""),
        vec!["claude", "--system-prompt", "hola mundo"]
    );
    assert_eq!(
        split_command("agente 'un solo arg'"),
        vec!["agente", "un solo arg"]
    );
    // Un argumento vacío explícito es un argumento, no la ausencia de uno.
    assert_eq!(
        split_command("agente --flag \"\""),
        vec!["agente", "--flag", ""]
    );
    assert!(split_command("   ").is_empty());
}

/// El sandbox de Codex descarta `ADE_TAB_ID`; se le pasa por su propia config, y solo a Codex.
#[test]
fn codex_recibe_el_id_de_la_tab_por_su_config() {
    use super::pty_manager::{split_command, with_codex_tab_id};

    let launched = with_codex_tab_id("codex resume abc", Some("tab-1"));
    assert_eq!(
        split_command(&launched),
        vec![
            "codex",
            "-c",
            "shell_environment_policy.set.ADE_TAB_ID=\"tab-1\"",
            "resume",
            "abc"
        ]
    );
    // Con ruta y .exe también es Codex.
    assert!(
        with_codex_tab_id("\"C:\\bin\\codex.exe\"", Some("t"))
            .contains("shell_environment_policy.set.ADE_TAB_ID")
    );
    // Ruta entrecomillada con espacios: el flag va DESPUÉS de la ruta entera, no en medio.
    let spaced = with_codex_tab_id("\"C:\\Program Files\\codex.exe\" resume x", Some("t"));
    assert_eq!(
        split_command(&spaced),
        vec![
            "C:\\Program Files\\codex.exe",
            "-c",
            "shell_environment_policy.set.ADE_TAB_ID=\"t\"",
            "resume",
            "x"
        ]
    );
    // Otras TUIs, sin id, ids raros o ya puesto: no se toca.
    assert_eq!(
        with_codex_tab_id("claude --resume x", Some("t")),
        "claude --resume x"
    );
    assert_eq!(with_codex_tab_id("codex", None), "codex");
    assert_eq!(with_codex_tab_id("codex", Some("a b\"c")), "codex");
    assert_eq!(with_codex_tab_id(&launched, Some("tab-1")), launched);
}

/// Codex recebe identidade pela configuração do agente e pela ancestralidade do IPC, sem `ADE_SESSION` em arquivo.
#[test]
fn codex_argv_nao_contem_o_token_da_sessao() {
    use super::pty_manager::{
        split_command, with_codex_identity, write_codex_profile_with_auth_at,
    };

    let token = "sess-1-token-secreto";
    let launched = with_codex_identity(
        "\"C:\\Program Files\\codex.exe\" resume x",
        Some("tab-1"),
        Some("ags-perfil"),
    );
    let argv = split_command(&launched);
    assert!(argv.iter().all(|arg| !arg.contains(token)), "{argv:?}");
    assert!(!launched.contains("ADE_SESSION"), "{launched}");
    assert_eq!(
        argv,
        vec![
            "C:\\Program Files\\codex.exe",
            "-c",
            "shell_environment_policy.set.ADE_TAB_ID=\"tab-1\"",
            "--profile",
            "ags-perfil",
            "resume",
            "x",
        ]
    );
    let cmd = with_codex_identity("C:\\Windows\\System32\\codex.cmd", Some("t"), Some("ags-s"));
    assert!(cmd.contains("--profile ags-s"));
    assert!(!cmd.contains(token));
    let unsafe_profile = with_codex_identity("codex", Some("tab-1"), Some("a\"b;calc"));
    assert!(!unsafe_profile.contains("calc"));
    assert!(!unsafe_profile.contains("--profile"));
    assert_eq!(
        with_codex_identity("claude", Some("t"), Some("ags-s")),
        "claude"
    );

    let home = std::env::temp_dir().join(format!("ags-codex-profile-{}", uuid::Uuid::new_v4()));
    let path = write_codex_profile_with_auth_at(&home, "ags-perfil", None).unwrap();
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(
        !body.contains(token),
        "o perfil não deve persistir o token: {body}"
    );
    assert!(!body.contains("ADE_SESSION"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "o perfil temporário continua privado");
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn perfil_codex_usa_o_auth_helper_sem_gravar_a_chave() {
    use super::pty_manager::write_codex_profile_with_auth_at;

    let home = std::env::temp_dir().join(format!("ags-codex-auth-{}", uuid::Uuid::new_v4()));
    let ags = std::path::Path::new("/tmp/ags");
    let auth = crate::accounts::broker::codex_provider_config(ags, "conta-123").unwrap();
    let path = write_codex_profile_with_auth_at(&home, "ags-perfil", Some(&auth)).unwrap();
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains("model_providers.ade-openai.auth"));
    assert!(body.contains("credential codex --account conta-123"));
    assert!(!body.contains("--ticket"));
    assert!(!body.contains("ADE_SESSION"));
    assert!(!body.contains("sk-teste-nao-real"));
    let _ = std::fs::remove_dir_all(&home);
}

/// Un carácter partido entre dos lecturas del PTY sale entero, no como dos `�`.
#[test]
fn un_caracter_partido_entre_lecturas_sale_entero() {
    use super::pty_manager::Utf8Stream;
    let text = "ção ─ 🚀";
    let bytes = text.as_bytes();
    // Todas las formas de cortarlo en dos.
    for cut in 0..=bytes.len() {
        let mut stream = Utf8Stream::default();
        let mut out = stream.push(&bytes[..cut]);
        out.push_str(&stream.push(&bytes[cut..]));
        out.push_str(&stream.finish());
        assert_eq!(out, text, "cortado en {cut}");
    }
    // Byte a byte también.
    let mut stream = Utf8Stream::default();
    let out: String = bytes.iter().map(|b| stream.push(&[*b])).collect();
    assert_eq!(out, text);

    // Lo inválido de verdad sigue saliendo como `�`, sin quedarse esperando.
    let mut stream = Utf8Stream::default();
    assert_eq!(stream.push(b"a\xffb"), "a\u{fffd}b");
    // Un comienzo de secuencia que nunca se completa sale al cerrar.
    assert_eq!(stream.push(b"x\xe2\x94"), "x");
    assert_eq!(stream.finish(), "\u{fffd}");
}

// ── Variables heredadas de una sesión de Claude Code ────────────

#[test]
fn las_marcas_de_sesion_padre_no_pasan_a_los_terminales() {
    // Sin esto el Claude de adentro se cree sesión hija y no guarda transcript.
    assert!(PARENT_SESSION_ENV.contains(&"CLAUDE_CODE_CHILD_SESSION"));
    assert!(PARENT_SESSION_ENV.contains(&"CLAUDE_CODE_SESSION_ID"));
    // `NO_COLOR` heredado dejaba los terminales de las misiones en blanco y negro.
    assert!(PARENT_SESSION_ENV.contains(&"NO_COLOR"));
    // La configuración del usuario NO es una marca de sesión: no se toca.
    for keep in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    ] {
        assert!(!PARENT_SESSION_ENV.contains(&keep), "{keep}");
    }
}

/// Al recargar la ventana, la tab se reconecta al terminal que ya corre en vez de lanzar otro.
#[test]
fn la_tab_encuentra_su_terminal_vivo_y_el_mas_nuevo_gana() {
    use super::pty_manager::newest_for_tab;

    let sessions = vec![
        (3u32, Some("tab-a")),
        (7, Some("tab-b")),
        (9, Some("tab-a")),
        (11, None),
    ];
    assert_eq!(newest_for_tab(sessions.iter().copied(), "tab-a"), Some(9));
    assert_eq!(newest_for_tab(sessions.iter().copied(), "tab-b"), Some(7));
    // Otra tab, o un PTY que no es de una tab, no se confunde.
    assert_eq!(newest_for_tab(sessions.iter().copied(), "tab-z"), None);
    assert_eq!(newest_for_tab(sessions.iter().copied(), ""), None);
}

// ── PTY robusto: escrita em fila, guarda de pânico e saída em lote ──

/// Escritor falso: cada `write` espera um sinal do teste, como um TTY cuja TUI parou de ler.
struct EscritorTravado {
    portao: std::sync::mpsc::Receiver<()>,
    escrito: std::sync::mpsc::Sender<()>,
    saida: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

impl std::io::Write for EscritorTravado {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.portao.recv().is_err() {
            return Err(std::io::Error::other("portão fechado"));
        }
        self.saida.lock().unwrap().extend_from_slice(buf);
        let _ = self.escrito.send(());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn fila_preserva_ordem_e_recusa_quando_cheia() {
    use super::write_queue::{PtyWriteError, WriteQueue};
    use std::sync::{mpsc, Arc, Mutex};

    let (portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, escrito_rx) = mpsc::channel();
    let saida = Arc::new(Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida: saida.clone() };
    let fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();

    // 256 pedaços entram. O primeiro pode já estar sendo escrito, e conta na capacidade.
    let mut esperado = String::new();
    for i in 0..256 {
        let pedaco = format!("{i:03},");
        esperado.push_str(&pedaco);
        assert_eq!(fila.enqueue(pedaco.as_bytes()), Ok(()), "item {i}");
    }
    assert_eq!(fila.enqueue(b"257"), Err(PtyWriteError::Full));

    // Libera uma escrita por pedaço e espera as 256 terminarem.
    for _ in 0..256 {
        portao_tx.send(()).unwrap();
    }
    for _ in 0..256 {
        escrito_rx.recv().unwrap();
    }
    let escrito = String::from_utf8(saida.lock().unwrap().clone()).unwrap();
    assert_eq!(escrito, esperado);
}

#[test]
fn fila_recusa_com_encerrado_depois_que_a_escrita_falha() {
    use super::write_queue::{PtyWriteError, WriteQueue};
    use std::sync::mpsc;

    /// Escritor que falha no primeiro `write` (o processo fechou o TTY) e avisa ao ser solto.
    struct EscritaQuebrada {
        solta: mpsc::Sender<()>,
    }
    impl std::io::Write for EscritaQuebrada {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("tty fechado"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for EscritaQuebrada {
        fn drop(&mut self) {
            let _ = self.solta.send(());
        }
    }

    let (solta_tx, solta_rx) = mpsc::channel();
    let fila = WriteQueue::new(Box::new(EscritaQuebrada { solta: solta_tx }), Box::new(|| {}), Box::new(|_| {})).unwrap();
    assert_eq!(fila.enqueue(b"x"), Ok(()));
    // A thread solta o receptor antes da escrita: quando o aviso chega, a fila já está fechada.
    solta_rx.recv().unwrap();
    assert_eq!(fila.enqueue(b"y"), Err(PtyWriteError::Closed));
}

/// Escritor que cai no primeiro `write` depois de liberado: é o TTY que o processo fechou.
struct EscritorQueQuebra {
    portao: std::sync::mpsc::Receiver<()>,
    solta: std::sync::mpsc::Sender<()>,
}

impl std::io::Write for EscritorQueQuebra {
    fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.portao.recv();
        Err(std::io::Error::other("tty fechado"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for EscritorQueQuebra {
    fn drop(&mut self) {
        let _ = self.solta.send(());
    }
}

#[test]
fn queda_da_escrita_conta_as_entradas_perdidas_e_avisa() {
    use super::write_queue::{FalhaEscrita, PtyWriteError, WriteQueue};
    use std::sync::mpsc;

    let (portao_tx, portao_rx) = mpsc::channel();
    let (solta_tx, solta_rx) = mpsc::channel();
    let (aviso_tx, aviso_rx) = mpsc::channel::<FalhaEscrita>();
    let escritor = EscritorQueQuebra { portao: portao_rx, solta: solta_tx };
    let fila = WriteQueue::new(
        Box::new(escritor),
        Box::new(|| {}),
        Box::new(move |falha| {
            let _ = aviso_tx.send(falha);
        }),
    )
    .unwrap();

    // Três entradas aceitas antes de a escrita cair: nenhuma chegou ao processo.
    let pedacos: [&[u8]; 3] = [b"a", b"b", b"c"];
    for pedaco in pedacos {
        assert_eq!(fila.enqueue(pedaco), Ok(()));
    }
    portao_tx.send(()).unwrap();
    solta_rx.recv().unwrap();

    let falha = aviso_rx.try_recv().expect("a queda avisa quem é dono da fila");
    assert_eq!(falha.perdidas, 3, "a que falhou e as duas que estavam na fila");
    assert_eq!(fila.enqueue(b"d"), Err(PtyWriteError::Closed));
}

/// Escritor que fica preso até o lado mestre fechar, como um TTY cuja TUI parou de ler.
struct EscritorPreso {
    liberacao: std::sync::mpsc::Receiver<()>,
    entrou: std::sync::mpsc::Sender<()>,
    solta: std::sync::mpsc::Sender<()>,
}

impl std::io::Write for EscritorPreso {
    fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.entrou.send(());
        let _ = self.liberacao.recv();
        Err(std::io::Error::other("lado mestre fechado"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for EscritorPreso {
    fn drop(&mut self) {
        let _ = self.solta.send(());
    }
}

#[test]
fn remover_a_fila_fecha_o_lado_mestre_e_libera_a_escrita_presa() {
    use super::write_queue::WriteQueue;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};

    let (liberacao_tx, liberacao_rx) = mpsc::channel::<()>();
    let (entrou_tx, entrou_rx) = mpsc::channel();
    let (solta_tx, solta_rx) = mpsc::channel();
    let fechou = Arc::new(AtomicBool::new(false));
    let fechou_no_fechar = fechou.clone();
    let fila = WriteQueue::new(
        Box::new(EscritorPreso { liberacao: liberacao_rx, entrou: entrou_tx, solta: solta_tx }),
        Box::new(move || {
            fechou_no_fechar.store(true, Ordering::SeqCst);
            // Fechar o lado mestre: a escrita presa vê o fechamento e volta com erro.
            drop(liberacao_tx);
        }),
        Box::new(|_| {}),
    )
    .unwrap();
    fila.enqueue(b"x").unwrap();
    // A escrita já está presa quando a sessão sai do registro.
    entrou_rx.recv().unwrap();

    drop(fila);
    assert!(fechou.load(Ordering::SeqCst), "remover a fila fecha o lado mestre");
    // Sem o fechamento a escrita ficaria presa para sempre; com ele, a thread termina.
    solta_rx.recv().unwrap();
}

#[test]
fn linha_entra_inteira_ou_nao_entra() {
    use super::write_queue::WriteQueue;
    use std::sync::{mpsc, Arc, Mutex};

    let (portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, escrito_rx) = mpsc::channel();
    let saida = Arc::new(Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida: saida.clone() };
    let fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();

    // 255 entradas deixam uma vaga. A linha (texto + Enter) cabe inteira nela, como um pedido só.
    for i in 0..255 {
        fila.enqueue(format!("{i:03}").as_bytes()).unwrap();
    }
    assert_eq!(fila.enqueue_linha(b"ls"), Ok(()), "a linha cabe inteira na única vaga");

    for _ in 0..256 {
        portao_tx.send(()).unwrap();
    }
    for _ in 0..256 {
        escrito_rx.recv().unwrap();
    }
    let escrito = String::from_utf8(saida.lock().unwrap().clone()).unwrap();
    let mut esperado: String = (0..255).map(|i| format!("{i:03}")).collect();
    esperado.push_str("ls\r");
    assert_eq!(escrito, esperado);
}

/// `aguarda_saida_com` com relógio e pausa de teste: a espera é medida, nunca dormida.
#[test]
fn aguarda_saida_respeita_o_prazo_sem_relogio_real() {
    use super::pty_manager::aguarda_saida_com;
    use portable_pty::ExitStatus;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    let relogio = Cell::new(Instant::now());
    let agora = || {
        let t = relogio.get();
        relogio.set(t + Duration::from_millis(10));
        t
    };
    let pausas = Cell::new(0u32);
    let pausa = |_: Duration| pausas.set(pausas.get() + 1);

    // Prazo zero: quem ainda está vivo volta na hora, sem pausa.
    assert!(aguarda_saida_com(|| Ok(None), Duration::ZERO, &agora, &pausa).is_none());
    assert_eq!(pausas.get(), 0);

    // Sai na terceira consulta: duas pausas entre as consultas, e o status certo.
    let mut consultas = 0;
    let saida = aguarda_saida_com(
        || {
            consultas += 1;
            Ok(if consultas < 3 { None } else { Some(ExitStatus::with_exit_code(3)) })
        },
        Duration::from_secs(30),
        &agora,
        &pausa,
    );
    assert_eq!(saida.map(|s| s.exit_code()), Some(3));
    assert_eq!(pausas.get(), 2);
}

/// A080: uma aba com terminal vivo reaproveita o terminal, e nunca ganha um segundo com a mesma aba.
#[test]
fn aba_com_terminal_vivo_reaproveita_o_terminal_e_nao_cria_outro() {
    use super::pty_manager::{entrada_da_aba, EntradaDaAba};
    let vivos = vec![(3u32, Some("tab-a")), (9, Some("tab-a")), (7, Some("tab-b")), (11, None)];
    assert_eq!(entrada_da_aba(vivos.iter().copied(), Some("tab-a")), EntradaDaAba::Reaproveitar(9));
    assert_eq!(entrada_da_aba(vivos.iter().copied(), Some("tab-z")), EntradaDaAba::Criar);
    assert_eq!(entrada_da_aba(vivos.iter().copied(), None), EntradaDaAba::Criar);
}

/// A092: os `.cmd` de lançamento velhos saem; os recentes e os de outra extensão ficam.
#[test]
fn lancamentos_antigos_saem_e_os_recentes_ficam() {
    use super::pty_manager::limpa_lancamentos_antigos;
    use std::time::{Duration, SystemTime};
    let dir = std::env::temp_dir().join(format!("ade-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let agora = SystemTime::now();
    let velho = dir.join("velho.cmd");
    let recente = dir.join("recente.cmd");
    let outro = dir.join("velho.txt");
    for arquivo in [&velho, &recente, &outro] {
        std::fs::write(arquivo, "x").unwrap();
    }
    let dois_dias = agora - Duration::from_secs(2 * 86_400);
    std::fs::File::options().write(true).open(&velho).unwrap().set_modified(dois_dias).unwrap();
    std::fs::File::options().write(true).open(&outro).unwrap().set_modified(dois_dias).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&recente)
        .unwrap()
        .set_modified(agora - Duration::from_secs(3600))
        .unwrap();

    let removidos = limpa_lancamentos_antigos(&dir, agora, Duration::from_secs(86_400));
    assert_eq!(removidos, 1);
    assert!(!velho.exists() && recente.exists() && outro.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Rodada 2: composto, vaga reservada do Enter, remoção com descendente, aba viva e runtime ──

#[test]
fn composto_entra_inteiro_ou_e_recusado_inteiro() {
    use super::write_queue::{Passo, PtyWriteError, WriteQueue};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    let (portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, escrito_rx) = mpsc::channel();
    let saida = Arc::new(Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida: saida.clone() };
    let fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();

    // 255 pedidos ocupam quase tudo. O composto (texto, pausa, Enter) cabe inteiro na última vaga.
    let mut esperado = String::new();
    for i in 0..255 {
        let pedaco = format!("{i:03}");
        esperado.push_str(&pedaco);
        fila.enqueue(pedaco.as_bytes()).unwrap();
    }
    let composto = vec![Passo::Escreve(b"ls".to_vec()), Passo::Pausa(Duration::ZERO), Passo::Escreve(b"\r".to_vec())];
    assert_eq!(fila.enqueue_composto(composto), Ok(()), "o composto inteiro cabe na última vaga");
    esperado.push_str("ls\r");

    // Agora a fila está cheia: o próximo composto é recusado por inteiro, sem nenhum pedaço dele.
    let outro = vec![Passo::Escreve(b"x".to_vec()), Passo::Escreve(b"\r".to_vec())];
    assert_eq!(fila.enqueue_composto(outro), Err(PtyWriteError::Full));

    // 255 pedidos de um passo, mais os 2 passos do composto: 257 escritas.
    for _ in 0..257 {
        portao_tx.send(()).unwrap();
    }
    for _ in 0..257 {
        escrito_rx.recv().unwrap();
    }
    let escrito = String::from_utf8(saida.lock().unwrap().clone()).unwrap();
    assert_eq!(escrito, esperado, "texto e Enter saem juntos, em ordem, e o composto recusado não saiu");
}

#[test]
fn texto_aceito_leva_a_vaga_do_enter_reservada() {
    use super::write_queue::{PtyWriteError, WriteQueue};
    use std::sync::{mpsc, Arc, Mutex};

    let (portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, escrito_rx) = mpsc::channel();
    let saida = Arc::new(Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida: saida.clone() };
    let fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();

    // 254 pedidos. O texto e a vaga do Enter cabem nas duas últimas.
    let mut esperado = String::new();
    for i in 0..254 {
        let pedaco = format!("{i:03}");
        esperado.push_str(&pedaco);
        fila.enqueue(pedaco.as_bytes()).unwrap();
    }
    let envio = fila.reservar_envio(b"ls").expect("o texto e a vaga do Enter cabem juntos");
    esperado.push_str("ls");

    // Com a vaga do Enter reservada, nem outro envio nem outro pedido cabe: a fila está cheia.
    assert_eq!(fila.reservar_envio(b"x").err(), Some(PtyWriteError::Full));
    assert_eq!(fila.enqueue(b"y"), Err(PtyWriteError::Full));
    // O Enter da vaga reservada nunca é recusado por falta de espaço.
    assert_eq!(envio.enter(), Ok(()));
    esperado.push_str("\r");

    // 254 pedidos, o texto e o Enter: 256 escritas.
    for _ in 0..256 {
        portao_tx.send(()).unwrap();
    }
    for _ in 0..256 {
        escrito_rx.recv().unwrap();
    }
    let escrito = String::from_utf8(saida.lock().unwrap().clone()).unwrap();
    assert_eq!(escrito, esperado);
}

/// O envio composto que o front manda chega como passos na ordem certa, com a pausa em milissegundos.
#[test]
fn passos_do_front_viram_passos_da_fila_na_mesma_ordem() {
    use super::pty_manager::{passos_do_front, PassoDeEscrita};
    use super::write_queue::Passo;
    use std::time::Duration;

    let json = r#"[{"tipo":"texto","dados":"oi"},{"tipo":"pausa","ms":80},{"tipo":"texto","dados":"\r"}]"#;
    let passos: Vec<PassoDeEscrita> = serde_json::from_str(json).expect("o formato do front é aceito");
    let convertidos = passos_do_front(passos);
    assert_eq!(
        convertidos,
        vec![Passo::Escreve(b"oi".to_vec()), Passo::Pausa(Duration::from_millis(80)), Passo::Escreve(b"\r".to_vec())]
    );
}

/// Uma fila ociosa (a thread parada em `recv`) sai ao ser encerrada, sem esperar o limite inteiro.
#[test]
fn fila_ociosa_termina_ao_encerrar_sem_esperar_o_limite() {
    use super::write_queue::WriteQueue;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let (_portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, _escrito_rx) = mpsc::channel();
    let saida = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida };
    let mut fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();
    let inicio = Instant::now();
    assert!(fila.encerrar_e_esperar(Duration::from_secs(10)), "a thread ociosa não saiu");
    // A espera não pode ter ido até o limite: sair ocioso é imediato. (Sem relógio de parede: só uma cota.)
    assert!(inicio.elapsed() < Duration::from_secs(5), "esperou o limite inteiro");
}

/// Um envio reservado que sai sem o Enter fica registrado como não confirmado, e devolve a vaga à fila.
#[test]
fn envio_reservado_solto_sem_enter_fica_registrado_e_libera_a_vaga() {
    use super::write_queue::WriteQueue;
    use std::sync::{mpsc, Arc, Mutex};

    let (portao_tx, portao_rx) = mpsc::channel();
    let (escrito_tx, escrito_rx) = mpsc::channel();
    let saida = Arc::new(Mutex::new(Vec::new()));
    let escritor = EscritorTravado { portao: portao_rx, escrito: escrito_tx, saida: saida.clone() };
    let fila = WriteQueue::new(Box::new(escritor), Box::new(|| {}), Box::new(|_| {})).unwrap();

    // Reserva o texto e o Enter (2 vagas) e solta o envio sem mandar o Enter.
    let envio = fila.reservar_envio(b"ls").expect("o texto e o Enter cabem");
    drop(envio);
    assert_eq!(fila.nao_confirmados(), 1, "o envio sem Enter precisa ficar registrado");

    // As vagas voltaram: uma nova reserva inteira cabe, e o Enter dela é aceito.
    let novo = fila.reservar_envio(b"x").expect("as vagas do envio solto voltaram");
    assert_eq!(novo.enter(), Ok(()));
    for _ in 0..3 {
        portao_tx.send(()).unwrap();
    }
    for _ in 0..3 {
        escrito_rx.recv().unwrap();
    }
    // O texto do envio solto saiu (sem Enter), e depois o texto e o Enter do envio novo.
    assert_eq!(String::from_utf8(saida.lock().unwrap().clone()).unwrap(), "lsx\r");
}

/// Espera o descritor deixar de aceitar bytes (buffer cheio): sinal de que a escrita da fila já começou e está presa.
#[cfg(unix)]
fn fd_cheio(fd: std::os::fd::RawFd) -> bool {
    for _ in 0..100_000 {
        let mut pfd = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
        // SAFETY: `pfd` é um `pollfd` válido e vive durante a chamada; `nfds` é 1.
        if unsafe { libc::poll(&mut pfd, 1, 0) } == 0 {
            return true;
        }
        std::thread::yield_now();
    }
    false
}

/// A escrita presa num pipe cheio é solta ao remover a fila. O mecanismo (poll com cancelamento) é o mesmo do
/// PTY, e um pipe trava em qualquer unix, então o teste roda no macOS e no Linux.
#[cfg(unix)]
#[test]
fn remover_a_fila_libera_escrita_presa_num_pipe() {
    use super::pty_manager::fila_sobre_fd;
    use std::os::fd::AsRawFd;
    use std::time::Duration;

    let (leitura, escrita) = std::io::pipe().unwrap();
    let mut fila = fila_sobre_fd(escrita.as_raw_fd(), Box::new(|_| {})).unwrap();
    // Mais que o buffer do pipe: a escrita trava, porque ninguém lê a outra ponta.
    fila.enqueue(&vec![b'x'; 1024 * 1024]).unwrap();
    assert!(fd_cheio(escrita.as_raw_fd()), "a escrita grande não chegou a travar");
    assert!(
        fila.encerrar_e_esperar(Duration::from_secs(2)),
        "a thread de escrita não terminou ao remover a fila"
    );
    drop(leitura);
}

/// A remoção de uma sessão precisa soltar a escrita presa, mesmo com um descendente segurando o escravo. Matar só o
/// filho não basta: o `sleep` do descendente mantém o escravo aberto e o `write_all` continuaria preso. Só o Linux
/// trava uma escrita num pty sem leitor: o macOS aceitou 256 MB sem travar (medido), por isso o teste é restrito.
#[cfg(target_os = "linux")]
#[test]
fn remover_a_sessao_libera_escrita_presa_por_descendente() {
    use super::pty_manager::fila_de_escrita;
    use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
    use std::io::Read;
    use std::time::Duration;

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    // O filho larga um descendente que herda o escravo e só então escreve "pronto". Nenhum dos dois lê a entrada.
    let mut comando = CommandBuilder::new("sh");
    comando.arg("-c");
    comando.arg("sleep 5 & echo pronto; sleep 5");
    let filho = pair.slave.spawn_command(comando).unwrap();
    // Lê a saída até "pronto": o descendente já existe quando a fila começa a escrever.
    let mut saida = pair.master.try_clone_reader().unwrap();
    let mut visto = Vec::new();
    while !String::from_utf8_lossy(&visto).contains("pronto") {
        let mut buf = [0u8; 256];
        let n = saida.read(&mut buf).unwrap();
        assert!(n > 0, "o filho saiu antes de avisar");
        visto.extend_from_slice(&buf[..n]);
    }

    let mut fila = fila_de_escrita(pair.master.as_ref(), filho.clone_killer(), Box::new(|_| {})).unwrap();
    // Mais que o buffer do tty: a escrita trava, porque ninguém lê a entrada do escravo.
    fila.enqueue(&vec![b'x'; 512 * 1024]).unwrap();
    assert!(fd_cheio(pair.master.as_raw_fd().unwrap()), "a escrita grande não chegou a travar");

    // Remover a sessão: o lado mestre fecha e a escrita presa volta com erro, mesmo com o descendente vivo.
    assert!(
        fila.encerrar_e_esperar(Duration::from_secs(2)),
        "a thread de escrita não terminou ao remover a sessão"
    );
}

/// Uma aba que já tem terminal vivo não perde esse terminal para um lançamento concorrente.
#[cfg(unix)]
#[test]
fn aba_com_terminal_vivo_nao_perde_o_terminal_para_um_lancamento_concorrente() {
    use super::pty_manager::{registrar_sessao, sessao_de_teste};
    use std::collections::HashMap;

    let mut reg = HashMap::new();
    // A aba já tem um terminal vivo (id 1). Um lançamento concorrente da mesma aba chega depois.
    assert!(registrar_sessao(&mut reg, 1, Some("aba-a"), sessao_de_teste(1, Some("aba-a"))).is_ok());
    match registrar_sessao(&mut reg, 2, Some("aba-a"), sessao_de_teste(2, Some("aba-a"))) {
        Err((existente, _nao_inserida)) => assert_eq!(existente, 1),
        Ok(()) => panic!("a aba já tinha terminal vivo: o lançamento concorrente não devia entrar"),
    }
    assert_eq!(reg.keys().copied().collect::<Vec<_>>(), vec![1], "o terminal vivo continua o único da aba");
    // Outra aba, sem terminal vivo, registra normalmente.
    assert!(registrar_sessao(&mut reg, 3, Some("aba-b"), sessao_de_teste(3, Some("aba-b"))).is_ok());
    assert!(reg.contains_key(&3));
}

/// O lançamento bloqueante roda fora do runtime: outra tarefa do mesmo runtime progride enquanto ele espera.
#[tokio::test(flavor = "current_thread")]
async fn lancamento_bloqueante_nao_prende_o_runtime() {
    use super::pty_manager::executar_fora_do_runtime;
    use std::time::Duration;

    let (liberar_tx, liberar_rx) = std::sync::mpsc::channel::<()>();
    // O lançamento fica bloqueado até outra tarefa do mesmo runtime liberá-lo. Se ele rodasse no worker, essa
    // tarefa nunca chegaria a rodar.
    let lancamento = tokio::spawn(executar_fora_do_runtime(move || {
        liberar_rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
        Ok(7u32)
    }));
    let liberou = tokio::spawn(async move { liberar_tx.send(()).is_ok() });
    assert!(liberou.await.unwrap(), "a outra tarefa não rodou enquanto o lançamento esperava");
    assert_eq!(lancamento.await.unwrap(), Ok(7));
}

/// Destino de teste: guarda os pedaços e os fins, na ordem em que chegam.
#[derive(Default)]
struct Gravador {
    pedacos: Vec<Vec<u8>>,
    fins: Vec<i32>,
}

impl super::pty_manager::Destino for Gravador {
    fn pedaco(&mut self, bytes: Vec<u8>) -> bool {
        self.pedacos.push(bytes);
        true
    }
    fn fim(&mut self, code: i32) {
        self.fins.push(code);
    }
}

/// Um leitor que dá pânico no primeiro `read`, como um observador do caminho de saída que falha.
struct LeitorQueEntraEmPanico;

impl std::io::Read for LeitorQueEntraEmPanico {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        panic!("pânico de teste no leitor")
    }
}

#[test]
fn panico_no_leitor_emite_pty_exit() {
    use super::pty_manager::rodar_leitor;
    // Id que nenhuma sessão real usa: a limpeza encontra o registro vazio.
    const ID: u32 = 4_000_001;
    let mut destino = Gravador::default();
    rodar_leitor(ID, &mut LeitorQueEntraEmPanico, &mut destino);
    assert_eq!(destino.fins, vec![-1]);
    assert!(destino.pedacos.is_empty());
}

fn dados_de(eventos: &[super::pty_manager::Evento]) -> Vec<&super::pty_manager::PtyDataPayload> {
    use super::pty_manager::Evento;
    eventos
        .iter()
        .filter_map(|evento| match evento {
            Evento::Dados(payload) => Some(payload),
            Evento::Saida(_) => None,
        })
        .collect()
}

#[test]
fn saida_rapida_vira_poucos_eventos() {
    use super::pty_manager::{emissor, Evento, Mensagem};
    use std::sync::mpsc;
    use std::time::Instant;

    let (tx, rx) = mpsc::channel();
    let mut esperado = String::new();
    for i in 0..1000 {
        let pedaco = format!("{i:09}\n"); // 10 bytes por leitura
        esperado.push_str(&pedaco);
        tx.send(Mensagem::Pedaco(pedaco.into_bytes())).unwrap();
    }
    tx.send(Mensagem::Fim(0)).unwrap();

    // Relógio parado: as 1000 leituras caem na mesma janela de 16 ms, qualquer que seja a máquina.
    let t0 = Instant::now();
    let mut eventos = Vec::new();
    emissor(rx, &|| t0, &mut |evento| eventos.push(evento));

    let dados = dados_de(&eventos);
    assert!(dados.len() <= 2, "{} eventos para 1000 leituras", dados.len());
    let texto: String = dados.iter().map(|d| d.data.as_str()).collect();
    assert_eq!(texto, esperado);
    assert_eq!(dados.last().and_then(|d| d.end), Some(10_000));
    assert!(matches!(eventos.last(), Some(Evento::Saida(0))));
}

#[test]
fn end_cresce_estritamente_e_a_saida_final_vem_por_ultimo() {
    use super::pty_manager::{emissor, Evento, Mensagem};
    use std::cell::Cell;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    // «€» (E2 82 AC) chega partido em duas leituras; no fim sobra um byte que nunca completa.
    let pedacos: [&[u8]; 4] = [b"a\xE2", b"\x82\xAC", b"b", b"\xE2"];
    let (tx, rx) = mpsc::channel();
    for pedaco in pedacos {
        tx.send(Mensagem::Pedaco(pedaco.to_vec())).unwrap();
    }
    tx.send(Mensagem::Fim(3)).unwrap();

    // Cada consulta do relógio anda 20 ms: a janela de 16 ms fecha lotes no meio, e o teste vê mais de um evento.
    let relogio = Cell::new(Instant::now());
    let agora = || {
        let t = relogio.get();
        relogio.set(t + Duration::from_millis(20));
        t
    };
    let mut eventos = Vec::new();
    emissor(rx, &agora, &mut |evento| eventos.push(evento));

    let dados = dados_de(&eventos);
    assert!(dados.len() >= 2, "{} eventos de dados", dados.len());
    let ends: Vec<u64> = dados.iter().map(|d| d.end.expect("todo pty-data de fluxo tem end")).collect();
    assert!(ends.windows(2).all(|par| par[0] < par[1]), "end não cresce: {ends:?}");
    let texto: String = dados.iter().map(|d| d.data.as_str()).collect();
    assert_eq!(texto, "a€b\u{fffd}");
    assert_eq!(ends.last(), Some(&6));
    assert!(matches!(eventos.last(), Some(Evento::Saida(3))));
}

#[test]
fn lote_fecha_pela_janela_de_16_ms_ou_pelo_limite() {
    use super::pty_manager::{Lote, LIMITE_LOTE_BYTES};
    use std::time::{Duration, Instant};

    let t0 = Instant::now();
    let mut lote = Lote::default();
    assert!(lote.recebe("a", 1, t0).is_none());
    assert!(lote.recebe("b", 2, t0 + Duration::from_millis(15)).is_none(), "antes da janela, o texto segura");
    let ev = lote.recebe("c", 3, t0 + Duration::from_millis(16)).expect("a janela de 16 ms fecha o lote");
    assert_eq!((ev.data.as_str(), ev.end), ("abc", Some(3)));

    // Passou do limite de bytes: fecha sem esperar a janela.
    let grande = "x".repeat(LIMITE_LOTE_BYTES);
    let ev = lote
        .recebe(&grande, 3 + LIMITE_LOTE_BYTES as u64, t0 + Duration::from_millis(17))
        .expect("o limite de bytes fecha o lote");
    assert_eq!(ev.data.len(), LIMITE_LOTE_BYTES);
    assert!(lote.esvazia().is_none());
}


#[cfg(unix)]
#[test]
fn saida_de_um_processo_real_chega_inteira_e_o_fim_vem_por_ultimo() {
    use super::pty_manager::{emissor, rodar_leitor, Destino, Evento, Mensagem};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::sync::mpsc;
    use std::time::Instant;

    /// Destino que manda a saída para o emissor, como a produção faz pelo `CanalDeSaida`.
    struct PeloEmissor(mpsc::SyncSender<Mensagem>);
    impl Destino for PeloEmissor {
        fn pedaco(&mut self, bytes: Vec<u8>) -> bool {
            self.0.send(Mensagem::Pedaco(bytes)).is_ok()
        }
        fn fim(&mut self, code: i32) {
            let _ = self.0.send(Mensagem::Fim(code));
        }
    }

    // Id que nenhuma sessão real usa: o registro não tem a sessão, e o código de saída é o do leitor.
    const ID: u32 = 4_000_002;
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    let mut comando = CommandBuilder::new("sh");
    comando.arg("-c");
    comando.arg("printf 'linha 1\\nlinha 2\\n'");
    let mut filho = pair.slave.spawn_command(comando).unwrap();
    // O pai solta o escravo: assim o EOF chega quando o filho sai, e não antes.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();

    let (tx, rx) = mpsc::sync_channel(64);
    let emissor_thread = std::thread::spawn(move || {
        let mut eventos = Vec::new();
        emissor(rx, &Instant::now, &mut |evento| eventos.push(evento));
        eventos
    });
    rodar_leitor(ID, reader.as_mut(), &mut PeloEmissor(tx));
    let eventos = emissor_thread.join().unwrap();
    let _ = filho.wait();

    let texto: String = eventos
        .iter()
        .filter_map(|evento| match evento {
            Evento::Dados(payload) => Some(payload.data.as_str()),
            Evento::Saida(_) => None,
        })
        .collect();
    assert!(texto.contains("linha 1") && texto.contains("linha 2"), "{texto:?}");
    assert!(matches!(eventos.last(), Some(Evento::Saida(_))), "o pty-exit precisa ser o último evento");
}

#[test]
fn el_recorte_del_buffer_no_deja_un_caracter_partido() {
    use super::pty_manager::push_capped;
    // «é» são dois bytes (C3 A9). Cortar com `max = 3` cairia entre os dois.
    let mut data = b"ab\xC3\xA9cd".to_vec();
    push_capped(&mut data, b"", 3, 0);
    assert!(std::str::from_utf8(&data).is_ok(), "{data:?}");
    assert_eq!(data, b"cd");
}

// ── Encerramento escalado (ACP): SIGTERM agora, SIGKILL depois do prazo, com relógio falso ──
#[cfg(unix)]
mod escalada_falsa {
    use super::super::containment::{Adoptable, ProcessGroup, Sinais};
    use std::cell::RefCell;
    use std::time::Duration;

    #[derive(Debug, PartialEq)]
    enum Evento {
        Sinal(i32, libc::c_int),
        Espera(Duration),
    }

    /// Um mundo sem processos de verdade: quem ignora SIGTERM continua no grupo até o SIGKILL.
    struct Falso {
        vivos: RefCell<Vec<u32>>,
        ignoram_term: Vec<u32>,
        eventos: RefCell<Vec<Evento>>,
    }

    impl Falso {
        fn novo(membros: Vec<u32>, ignoram_term: Vec<u32>) -> Self {
            Falso { vivos: RefCell::new(membros), ignoram_term, eventos: RefCell::new(Vec::new()) }
        }
    }

    impl Sinais for Falso {
        fn enviar_grupo(&self, pgid: i32, sinal: libc::c_int) -> bool {
            self.eventos.borrow_mut().push(Evento::Sinal(-pgid, sinal));
            let encontrou_membros = !self.vivos.borrow().is_empty();
            if sinal == libc::SIGTERM {
                self.vivos.borrow_mut().retain(|pid| self.ignoram_term.contains(pid));
            } else if sinal == libc::SIGKILL {
                self.vivos.borrow_mut().clear();
            }
            encontrou_membros
        }
        fn esperar(&self, prazo: Duration) {
            self.eventos.borrow_mut().push(Evento::Espera(prazo));
        }
    }

    /// Um pid que não existe no kernel (acima do teto do Linux): o `adopt` só o anota, e nenhum processo real é tocado.
    struct PidInexistente;
    impl Adoptable for PidInexistente {
        fn pid(&self) -> Option<u32> {
            Some(0x7FFF_FFF0)
        }
    }

    #[test]
    fn escalada_manda_term_e_kill_ao_grupo_do_lider() {
        const PGID: u32 = 0x7FFF_FFF0;
        let falso = Falso::novo(vec![30, 20, 10], vec![30, 10]);
        let mut grupo = ProcessGroup::new_acp();
        grupo.adopt(&PidInexistente);
        let prazo = Duration::from_secs(2);
        let escalada = grupo.encerrar_escalando_com(&falso);
        let forcados = escalada.concluir_com(&falso, prazo);

        assert!(forcados, "o SIGKILL encontrou membros no grupo");
        assert_eq!(
            *falso.eventos.borrow(),
            vec![
                Evento::Sinal(-(PGID as i32), libc::SIGTERM),
                Evento::Espera(prazo),
                Evento::Sinal(-(PGID as i32), libc::SIGKILL),
            ],
            "os dois sinais vão ao PGID negativo, com a espera entre eles"
        );
    }
}
