//! O lado macOS do simulador: CoreSimulator (aparelhos), a tela (IOSurface), o HID (toque, botões, teclado) e
//! a view que mostra a tela na janela. As funções daqui bloqueiam (XPC com o serviço do CoreSimulator): os
//! comandos as chamam fora da thread da interface, menos as de `view`.

pub(crate) mod objc;
mod device;
pub mod hid;
mod kit;
pub mod screen;
pub mod view;

use std::sync::Arc;
use std::time::Duration;

use crate::simulator::model::{self, Device};

/// Quanto esperar a tela aparecer depois do boot (o launchd sobe antes da porta de IO dela).
const SCREEN_WAIT: Duration = Duration::from_secs(60);

pub fn devices() -> Result<Vec<Device>, String> {
    device::list()
}

/// Liga, espera a tela existir e, no modo leve, põe o iOS na prioridade baixa ([`set_priority`]).
pub fn boot(udid: &str, light: bool) -> Result<(), String> {
    let dev = device::find(udid)?;
    device::boot(&dev)?;
    screen::lcd(&dev, SCREEN_WAIT)?;
    if light {
        set_priority(udid, LIGHT_NICE)?;
    }
    Ok(())
}

/// A prioridade do iOS no modo leve: abaixo de tudo o que a pessoa usa, sem parar o aparelho.
pub const LIGHT_NICE: i32 = 10;

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
    let ratio = model::point_ratio(x, y, screen.points())?;
    hid.touch(ratio, hid::Phase::Down)?;
    std::thread::sleep(Duration::from_millis(60));
    hid.touch(ratio, hid::Phase::Up)
}

/// Desliza de um ponto a outro em `ms` milissegundos (pontos do iOS).
pub fn swipe(udid: &str, from: (f64, f64), to: (f64, f64), ms: u64) -> Result<(), String> {
    let (screen, hid) = connect(udid)?;
    let size = screen.points();
    let a = model::point_ratio(from.0, from.1, size)?;
    let b = model::point_ratio(to.0, to.1, size)?;
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

/// Põe o iOS do aparelho na prioridade `nice` (0 = normal, 10 = baixa): com o iOS ocupado (papel de parede
/// animado, indexação depois do boot) a ADE e o resto do Mac continuam com a CPU primeiro. Os processos que o
/// iOS abrir depois herdam a do `launchd_sim`. Devolve quantos processos mudaram.
pub fn set_priority(udid: &str, nice: i32) -> Result<usize, String> {
    let pids = ios_processes(udid)?;
    let mut changed = 0;
    for pid in &pids {
        // SAFETY: setpriority só lê os argumentos; processos do mesmo usuário.
        if unsafe { libc::setpriority(libc::PRIO_PROCESS, *pid, nice) } == 0 {
            changed += 1;
        }
    }
    Ok(changed)
}
