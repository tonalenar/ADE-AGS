//! O lado macOS do simulador: CoreSimulator (aparelhos), a tela (IOSurface), o HID (toque, botões, teclado) e
//! a view que mostra a tela na janela. As funções daqui bloqueiam (XPC com o serviço do CoreSimulator): os
//! comandos as chamam fora da thread da interface, menos as de `view`.

pub(crate) mod objc;
mod device;
mod dtu;
pub mod hid;
mod kit;
mod purple;
pub mod screen;
mod slim;
pub mod view;

use std::sync::Arc;
use std::time::Duration;

use crate::simulator::model::{self, Device};

pub use purple::orient;

/// Quanto esperar a tela aparecer depois do boot (o launchd sobe antes da porta de IO dela).
const SCREEN_WAIT: Duration = Duration::from_secs(60);

pub fn devices() -> Result<Vec<Device>, String> {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    SWEPT.call_once(slim::restore_leftovers);
    device::list()
}

/// Liga e espera a tela existir. No modo leve, com o aparelho desligado, sobe sem os serviços pesados do iOS
/// (`simulator::slim`: o arquivo original volta logo que a tela existe). A prioridade fica normal enquanto à
/// vista e só baixa quando a tela sai de vista (`lifecycle`).
pub fn boot(udid: &str, light: bool) -> Result<(), String> {
    let dev = device::find(udid)?;
    let slimmed = light && device::state(&dev) == model::STATE_SHUTDOWN && match slim::apply(udid) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[simulator] modo leve sem a lista de serviços: {e}");
            false
        }
    };
    let ready = device::boot(&dev).and_then(|()| screen::lcd(&dev, SCREEN_WAIT).map(|_| ()));
    if slimmed {
        // A porta da tela é do lado do Mac e pode surgir antes do `launchd_sim` ler o arquivo. Ele lê antes
        // de abrir o primeiro serviço: com filhos já rodando, já leu.
        if ready.is_ok() {
            launchd_started(udid, Duration::from_secs(30));
        }
        slim::restore(udid);
    }
    ready
}

pub fn shutdown(udid: &str) -> Result<(), String> {
    let dev = device::find(udid)?;
    hid::forget(udid);
    device::shutdown(&dev)
}

pub fn booted(udid: &str) -> Result<bool, String> {
    Ok(device::state(&device::find(udid)?) == model::STATE_BOOTED)
}

/// A tela e o HID de um aparelho ligado, para mostrar ou para um agente tocar.
pub fn connect(udid: &str) -> Result<(screen::Screen, Arc<hid::Hid>), String> {
    let dev = device::find(udid)?;
    if device::state(&dev) != model::STATE_BOOTED {
        return Err("O aparelho está desligado. Ligue-o primeiro.".into());
    }
    let screen = screen::lcd(&dev, SCREEN_WAIT)?;
    let hid = hid::for_device(udid, &dev)?;
    Ok((screen, hid))
}

/// Um toque em (x, y) pontos do iOS: desce e sobe.
pub fn tap(udid: &str, x: f64, y: f64) -> Result<(), String> {
    let (screen, hid) = connect(udid)?;
    // Os pontos são os da tela como se vê (os do `shot`, que já sai em pé): em paisagem, voltam para a
    // superfície em retrato, que é a do HID.
    let orientation = crate::simulator::ops::orientation(udid);
    let ratio = model::point_ratio(x, y, model::oriented_size(screen.points(), orientation))?;
    let ratio = model::native_ratio(ratio, orientation);
    hid.touch(ratio, hid::Phase::Down)?;
    std::thread::sleep(Duration::from_millis(60));
    hid.touch(ratio, hid::Phase::Up)
}

/// Desliza de um ponto a outro em `ms` milissegundos (pontos do iOS).
pub fn swipe(udid: &str, from: (f64, f64), to: (f64, f64), ms: u64) -> Result<(), String> {
    let (screen, hid) = connect(udid)?;
    // Como em `tap`: pontos da tela em pé → proporção na superfície em retrato (a conta é linear, então os
    // passos intermediários também caem certos).
    let orientation = crate::simulator::ops::orientation(udid);
    let size = model::oriented_size(screen.points(), orientation);
    let a = model::native_ratio(model::point_ratio(from.0, from.1, size)?, orientation);
    let b = model::native_ratio(model::point_ratio(to.0, to.1, size)?, orientation);
    // Passos de ~16 ms: o Indigo descarta arrasto acima de 60 por segundo.
    let steps = (ms / 16).clamp(4, 120) as u32;
    let points = model::swipe_points(a, b, steps);
    hid.touch(points[0], hid::Phase::Down)?;
    for p in &points[1..] {
        std::thread::sleep(Duration::from_millis(16));
        hid.touch(*p, hid::Phase::Move)?;
    }
    hid.touch(*points.last().unwrap_or(&b), hid::Phase::Up)
}

pub fn type_text(udid: &str, text: &str) -> Result<(), String> {
    let keys = model::text_keys(text)?;
    let (_, hid) = connect(udid)?;
    for (usage, shift) in keys {
        if shift {
            hid.key(0xe1, true)?;
        }
        hid.key(usage, true)?;
        hid.key(usage, false)?;
        if shift {
            hid.key(0xe1, false)?;
        }
    }
    Ok(())
}

pub fn key(udid: &str, name: &str) -> Result<(), String> {
    let usage = model::key_usage(name)?;
    let (_, hid) = connect(udid)?;
    hid.key(usage, true)?;
    hid.key(usage, false)
}

pub fn button(udid: &str, name: &str) -> Result<(), String> {
    let source = model::button_source(name)?;
    let (_, hid) = connect(udid)?;
    hid.button(source, true)?;
    std::thread::sleep(Duration::from_millis(80));
    hid.button(source, false)
}

/// Os processos do iOS de um aparelho: o `launchd_sim` dele (o caminho tem o UDID) e toda a descendência.
fn ios_processes(udid: &str) -> Result<Vec<u32>, String> {
    let mut cmd = crate::util::spawn::hidden_command("ps");
    cmd.args(["-axo", "pid=,ppid=,command="]);
    let out = crate::util::spawn::output(&mut cmd, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    Ok(model::process_tree(&String::from_utf8_lossy(&out.stdout), udid))
}

/// Espera o `launchd_sim` do aparelho abrir os primeiros serviços (até `wait`).
fn launchd_started(udid: &str, wait: Duration) {
    let until = std::time::Instant::now() + wait;
    while std::time::Instant::now() < until {
        if ios_processes(udid).map(|p| p.len() > 5).unwrap_or(false) {
            return;
        }
        // O `launchd_sim` não avisa quando sobe: é o mesmo caso da porta da tela em `screen::lcd`.
        std::thread::park_timeout(Duration::from_millis(150));
    }
}

/// Põe o iOS do aparelho na prioridade de segundo plano (`nice > 0`, `PRIO_DARWIN_BG`: núcleos de eficiência e I/O
/// baixo) ou de volta à normal (`0`). Ao contrário de `PRIO_PROCESS` (`nice = 10`), que sem root no macOS falha com
/// `EACCES` ao tentar voltar a `0` e deixava o aparelho preso em prioridade baixa para sempre, `PRIO_DARWIN_PROCESS`
/// é reversível pelo próprio usuário (o mesmo mecanismo de `taskpolicy -b/-B`). Devolve quantos processos mudaram.
pub fn set_priority(udid: &str, nice: i32) -> Result<usize, String> {
    const PRIO_DARWIN_PROCESS: i32 = 4;
    const PRIO_DARWIN_BG: i32 = 0x1000;
    let prio = if nice > 0 { PRIO_DARWIN_BG } else { 0 };
    let pids = ios_processes(udid)?;
    let mut changed = 0;
    for pid in &pids {
        // SAFETY: setpriority só lê os argumentos; processos do mesmo usuário.
        if unsafe { libc::setpriority(PRIO_DARWIN_PROCESS, *pid, prio) } == 0 {
            changed += 1;
        }
    }
    Ok(changed)
}
