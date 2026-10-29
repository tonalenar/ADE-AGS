//! O ciclo de vida dos aparelhos que a ADE ligou, para o iOS só gastar quando alguém usa:
//!
//! - **Hibernar**: um aparelho fora de vista e sem agente mexendo por `hibernate_after` é desligado (sem perder
//!   dados: é um shutdown normal). O nó mostra "Pausado para economizar" e religa com um clique.
//! - **Um por vez**: ligar um aparelho hiberna os outros que a ADE ligou (os do app Simulator ficam como estão).
//! - **Prioridade**: no modo leve o iOS fica com prioridade baixa no pico do boot e fora de vista, e volta à
//!   normal enquanto a pessoa olha a tela (assim ele desenha mais rápido quando importa).
//!
//! "À vista" vem do frontend (`simulator_place` com parte visível); "em uso", das ações dos agentes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::ops;

/// O pico do boot: papéis de parede, widgets e Siri passam de 400% de CPU nos primeiros minutos.
const BOOT_STORM: Duration = Duration::from_secs(150);
/// De quanto em quanto tempo o monitor confere.
const CHECK_EVERY: Duration = Duration::from_secs(20);
const NICE_LOW: i32 = 10;

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    /// `None` = nunca hibernar.
    pub hibernate_after: Option<Duration>,
    pub single: bool,
    pub light: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { hibernate_after: Some(Duration::from_secs(10 * 60)), single: true, light: true }
    }
}

#[derive(Debug, Clone, Copy)]
struct Usage {
    booted_at: Instant,
    last_seen: Instant,
    visible: bool,
    nice: i32,
}

fn settings() -> &'static Mutex<Settings> {
    static S: OnceLock<Mutex<Settings>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn usage() -> &'static Mutex<HashMap<String, Usage>> {
    static U: OnceLock<Mutex<HashMap<String, Usage>>> = OnceLock::new();
    U.get_or_init(Default::default)
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Hora de hibernar: fora de vista há pelo menos `after`. Pura.
pub fn due(now: Instant, last_seen: Instant, visible: bool, after: Option<Duration>) -> bool {
    match after {
        Some(after) => !visible && now.saturating_duration_since(last_seen) >= after,
        None => false,
    }
}

/// A prioridade que o iOS deve ter agora: baixa no pico do boot ou fora de vista (no modo leve). Pura.
pub fn wanted_nice(light: bool, visible: bool, since_boot: Duration) -> i32 {
    if light && (!visible || since_boot < BOOT_STORM) { NICE_LOW } else { 0 }
}

pub fn set_settings(app: &AppHandle, new: Settings) {
    let _ = APP.set(app.clone());
    if let Ok(mut s) = settings().lock() {
        *s = new;
    }
}

fn emit(udid: &str, state: &str, reason: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("simulator-state", json!({ "udid": udid, "state": state, "reason": reason }));
    }
}

/// Desliga um aparelho por economia e avisa os nós.
fn hibernate(udid: &str, reason: &str) {
    if let Ok(mut map) = usage().lock() {
        map.remove(udid);
    }
    match ops::shutdown(udid) {
        Ok(()) => emit(udid, "shutdown", reason),
        Err(e) => eprintln!("[simulator] não hibernei {udid}: {e}"),
    }
}

/// A ADE acabou de ligar `udid`. Com "um por vez", hiberna os outros que ela ligou.
pub fn booted(app: &AppHandle, udid: &str) {
    let _ = APP.set(app.clone());
    start_monitor();
    let now = Instant::now();
    let others: Vec<String> = match usage().lock() {
        Ok(mut map) => {
            map.insert(udid.to_string(), Usage { booted_at: now, last_seen: now, visible: false, nice: NICE_LOW });
            map.keys().filter(|k| k.as_str() != udid).cloned().collect()
        }
        Err(_) => Vec::new(),
    };
    if settings().lock().map(|s| s.single).unwrap_or(true) {
        for other in others {
            hibernate(&other, "single");
        }
    }
}

/// A tela de `udid` está (ou deixou de estar) à vista.
pub fn seen(udid: &str, visible: bool) {
    if let Ok(mut map) = usage().lock() {
        if let Some(u) = map.get_mut(udid) {
            if visible || u.visible {
                u.last_seen = Instant::now();
            }
            u.visible = visible;
        }
    }
}

/// Um agente mexeu no aparelho: conta como uso (não hiberna no meio do trabalho dele).
pub fn used(udid: &str) {
    if let Ok(mut map) = usage().lock() {
        if let Some(u) = map.get_mut(udid) {
            u.last_seen = Instant::now();
        }
    }
}

/// A pessoa desligou o aparelho: sai do ciclo.
pub fn forget(udid: &str) {
    if let Ok(mut map) = usage().lock() {
        map.remove(udid);
    }
}

/// Uma thread só, a partir do primeiro boot: hiberna o que ficou esquecido e acerta a prioridade.
fn start_monitor() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(CHECK_EVERY);
        let now = Instant::now();
        let current = settings().lock().map(|s| *s).unwrap_or_default();
        let snapshot: Vec<(String, Usage)> = usage().lock().map(|m| m.iter().map(|(k, v)| (k.clone(), *v)).collect()).unwrap_or_default();
        for (udid, u) in snapshot {
            if due(now, u.last_seen, u.visible, current.hibernate_after) {
                hibernate(&udid, "hibernated");
                continue;
            }
            let nice = wanted_nice(current.light, u.visible, now.saturating_duration_since(u.booted_at));
            if nice != u.nice && ops::set_priority(&udid, nice).is_ok() {
                if let Ok(mut map) = usage().lock() {
                    if let Some(entry) = map.get_mut(&udid) {
                        entry.nice = nice;
                    }
                }
            }
        }
    });
}
