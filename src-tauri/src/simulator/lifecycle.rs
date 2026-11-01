//! O ciclo de vida dos aparelhos que a ADE ligou, para o iOS só gastar quando alguém usa:
//!
//! - **Hibernar**: um aparelho fora de vista e sem agente mexendo por `hibernate_after` é desligado (sem perder
//!   dados: é um shutdown normal). O nó mostra "Pausado para economizar" e religa com um clique.
//! - **Um por vez**: ligar um aparelho hiberna os outros que a ADE ligou (os do app Simulator ficam como estão).
//! - **Prioridade**: no modo leve o iOS fica com prioridade baixa fora de vista e sem uso recente, e volta à
//!   normal enquanto a pessoa ou um agente usa a tela (assim ele desenha mais rápido quando importa).
//!
//! "À vista" vem do frontend (`simulator_place` com parte visível); "em uso", das ações dos agentes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::ops;

/// De quanto em quanto tempo o monitor confere.
const CHECK_EVERY: Duration = Duration::from_secs(20);
const NICE_LOW: i32 = 10;
/// Mantém animações e verificações do agente em prioridade normal por 60 s após a última ação.
pub const AGENT_PRIORITY_GRACE: Duration = Duration::from_secs(60);

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
    last_used: Option<Instant>,
    last_seen: Instant,
    visible: bool,
    priority: PriorityState,
}

/// Estado puro das aplicações: uma restauração enfileirada cobre todas as ações até terminar.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct PriorityState {
    pub nice: i32,
    pub pending: bool,
    pub applying: Option<i32>,
}

impl PriorityState {
    pub fn queue_restore(&mut self) -> bool {
        if self.pending || (self.nice == 0 && self.applying.is_none_or(|n| n == 0)) {
            return false;
        }
        self.pending = true;
        true
    }

    pub fn prepare(&mut self, wanted: i32) -> Option<i32> {
        if self.nice == wanted {
            return None;
        }
        self.applying = Some(wanted);
        Some(wanted)
    }

    pub fn finish(&mut self, applied: i32, success: bool) {
        self.applying = None;
        if success {
            self.nice = applied;
        }
    }
}

/// Só as threads de fundo tomam este mutex; nunca os comandos seen/used.
fn priority_applications() -> &'static Mutex<()> {
    static P: Mutex<()> = Mutex::new(());
    &P
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

/// Pura: só reduz a prioridade fora de vista e após a carência da última ação do agente.
pub fn wanted_nice(light: bool, visible: bool, since_used: Duration) -> i32 {
    if light && !visible && since_used >= AGENT_PRIORITY_GRACE { NICE_LOW } else { 0 }
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
            map.insert(udid.to_string(), Usage { last_used: None, last_seen: now, visible: true, priority: PriorityState::default() });
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

/// A tela de `udid` está (ou deixou de estar) à vista. Quando entra à vista com prioridade baixa, restaura a
/// prioridade normal na hora (fora da thread da interface) sem esperar os 20 s do monitor.
pub fn seen(udid: &str, visible: bool) {
    let mut restore_now = false;
    if let Ok(mut map) = usage().lock() {
        if let Some(u) = map.get_mut(udid) {
            if visible || u.visible {
                u.last_seen = Instant::now();
            }
            u.visible = visible;
            if visible {
                restore_now = u.priority.queue_restore();
            }
        }
    }
    if restore_now {
        restore_priority(udid);
    }
}

/// A pendência já foi marcada em usage(); ações repetidas não criam mais threads.
fn restore_priority(udid: &str) {
    let udid = udid.to_string();
    std::thread::spawn(move || apply_priority(&udid, true));
}

/// Reavalia dentro da serialização e após cada I/O. Uma ação durante a aplicação de
/// segundo plano é restaurada antes de liberar a vez para outra aplicação.
fn apply_priority(udid: &str, restore_worker: bool) {
    let Ok(_application) = priority_applications().lock() else { return };
    loop {
        let light = settings().lock().map(|s| s.light).unwrap_or(true);
        let wanted = {
            let Ok(mut map) = usage().lock() else { return };
            let Some(u) = map.get_mut(udid) else { return };
            let since_used = u.last_used.map(|last| Instant::now().saturating_duration_since(last)).unwrap_or(Duration::MAX);
            let wanted = wanted_nice(light, u.visible, since_used);
            match u.priority.prepare(wanted) {
                Some(wanted) => wanted,
                None => {
                    if restore_worker {
                        u.priority.pending = false;
                    }
                    return;
                }
            }
        };
        // O ps pode demorar: usage() está livre durante toda a operação.
        let success = ops::set_priority(udid, wanted).is_ok_and(|n| n > 0);
        if let Ok(mut map) = usage().lock() {
            if let Some(u) = map.get_mut(udid) {
                u.priority.finish(wanted, success);
                if !success && restore_worker {
                    u.priority.pending = false;
                }
            }
        }
        if !success {
            return;
        }
    }
}

/// Um agente mexeu no aparelho: impede hibernação e restaura prioridade fora da thread de quem chamou.
pub fn used(udid: &str) {
    let mut restore_now = false;
    if let Ok(mut map) = usage().lock() {
        if let Some(u) = map.get_mut(udid) {
            let now = Instant::now();
            u.last_seen = now;
            u.last_used = Some(now);
            restore_now = u.priority.queue_restore();
        }
    }
    if restore_now {
        restore_priority(udid);
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
            apply_priority(&udid, false);
        }
    });
}
