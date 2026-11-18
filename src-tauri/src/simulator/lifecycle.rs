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
use std::sync::atomic::{AtomicBool, Ordering};
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
pub(super) struct Usage {
    pub(super) last_used: Option<Instant>,
    pub(super) last_seen: Instant,
    pub(super) visible: bool,
    pub(super) priority: PriorityState,
    /// Marcado para hibernar: o registro fica no mapa até o desligamento terminar. Uma tela ou um agente que chegar
    /// antes do `shutdown` tira a marca, e o desligamento não acontece (ver `hibernate_marked`).
    pub(super) hibernating: bool,
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

/// O registro de um aparelho que acabou de ligar. Ligado da tela (`from_screen`), já nasce à vista. Ligado pelo agente,
/// sem nó no canvas, nasce fora de vista: antes nascia à vista e nunca hibernava.
pub(super) fn booted_entry(now: Instant, from_screen: bool) -> Usage {
    Usage { last_used: None, last_seen: now, visible: from_screen, priority: PriorityState::default(), hibernating: false }
}

/// Marca um aparelho para hibernar: só se ele ainda estiver devido agora, olhando o uso atual. O registro fica no mapa;
/// quem chegar antes do desligamento cancela a marca (ver `seen_in` e `used`).
pub(super) fn claim_due(map: &mut HashMap<String, Usage>, udid: &str, now: Instant, after: Option<Duration>) -> bool {
    let Some(u) = map.get_mut(udid) else { return false };
    // Já marcado: o shutdown anterior ainda corre. Remarcar faria o monitor desligar em paralelo.
    if u.hibernating || !due(now, u.last_seen, u.visible, after) {
        return false;
    }
    u.hibernating = true;
    true
}

/// A marca de hibernar ainda está de pé? Confere sob a trava, logo antes do `shutdown`.
pub(super) fn confirm_hibernation(map: &HashMap<String, Usage>, udid: &str) -> bool {
    map.get(udid).is_some_and(|u| u.hibernating)
}

/// Depois do desligamento. Se a marca caiu durante ele (uma tela ou um agente chegou), o aparelho tem que voltar:
/// devolve `true` quando é preciso religá-lo. Desligado de fato e sem marca, sai do ciclo. Falha: fica no ciclo.
pub(super) fn finish_hibernation(map: &mut HashMap<String, Usage>, udid: &str, off: bool) -> bool {
    let Some(u) = map.get_mut(udid) else { return false };
    if !u.hibernating {
        return off;
    }
    if off {
        map.remove(udid);
    } else {
        u.hibernating = false;
    }
    false
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

/// Desliga um aparelho marcado para hibernar. Confere a marca sob a trava logo antes do desligamento: se uma tela ou
/// um agente chegou depois da marca, o aparelho fica como está. Se chegou durante o desligamento, religa.
fn hibernate_marked(udid: &str, reason: &str, light: bool) {
    let confirmed = usage().lock().map(|map| confirm_hibernation(&map, udid)).unwrap_or(false);
    if !confirmed {
        return;
    }
    let off = match ops::shutdown(udid) {
        Ok(()) => {
            emit(udid, "shutdown", reason);
            true
        }
        Err(e) => {
            eprintln!("[simulator] não hibernei {udid}: {e}");
            false
        }
    };
    let reopen = usage().lock().map(|mut map| finish_hibernation(&mut map, udid, off)).unwrap_or(false);
    if reopen {
        match ops::boot(udid, light) {
            Ok(()) => emit(udid, "booted", "reopened"),
            Err(e) => eprintln!("[simulator] não religuei {udid}, que foi pedido durante o desligamento: {e}"),
        }
    }
}

/// Desliga um aparelho por economia (a regra "um por vez"), pela mesma marca e confirmação do monitor.
fn hibernate(udid: &str, reason: &str) {
    let light = settings().lock().map(|s| s.light).unwrap_or(true);
    if let Ok(mut map) = usage().lock() {
        if let Some(u) = map.get_mut(udid) {
            u.hibernating = true;
        }
    }
    hibernate_marked(udid, reason, light);
}

/// A ADE acabou de ligar `udid` (`from_screen`: pela tela, não por um agente). Com "um por vez", hiberna os outros.
pub fn booted(app: &AppHandle, udid: &str, from_screen: bool) {
    let _ = APP.set(app.clone());
    let now = Instant::now();
    let others: Vec<String> = match usage().lock() {
        Ok(mut map) => {
            map.insert(udid.to_string(), booted_entry(now, from_screen));
            start_monitor_locked();
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
    let restore_now = usage().lock().map(|mut map| seen_in(&mut map, udid, visible)).unwrap_or(false);
    if restore_now {
        restore_priority(udid);
    }
}

/// `seen` sobre o mapa. Uma tela à vista cancela a marca de hibernar. Devolve se a prioridade precisa voltar já.
pub(super) fn seen_in(map: &mut HashMap<String, Usage>, udid: &str, visible: bool) -> bool {
    let Some(u) = map.get_mut(udid) else { return false };
    if visible || u.visible {
        u.last_seen = Instant::now();
    }
    u.visible = visible;
    if visible {
        u.hibernating = false;
        return u.priority.queue_restore();
    }
    false
}

/// A pendência já foi marcada em usage(); ações repetidas não criam mais threads.
fn restore_priority(udid: &str) {
    let udid = udid.to_string();
    std::thread::spawn(move || apply_priority(&udid, true));
}

/// Reavalia dentro da serialização e após cada I/O. Uma ação durante a aplicação de
/// segundo plano é restaurada antes de liberar a vez para outra aplicação. Devolve quantos processos mudaram.
fn apply_priority(udid: &str, restore_worker: bool) -> usize {
    let Ok(_application) = priority_applications().lock() else { return 0 };
    let mut changed = 0;
    loop {
        let light = settings().lock().map(|s| s.light).unwrap_or(true);
        let wanted = {
            let Ok(mut map) = usage().lock() else { return changed };
            let Some(u) = map.get_mut(udid) else { return changed };
            let since_used = u.last_used.map(|last| Instant::now().saturating_duration_since(last)).unwrap_or(Duration::MAX);
            let wanted = wanted_nice(light, u.visible, since_used);
            match u.priority.prepare(wanted) {
                Some(wanted) => wanted,
                None => {
                    if restore_worker {
                        u.priority.pending = false;
                    }
                    return changed;
                }
            }
        };
        // O ps pode demorar: usage() está livre durante toda a operação.
        let count = ops::set_priority(udid, wanted).unwrap_or(0);
        let success = count > 0;
        changed += count;
        if let Ok(mut map) = usage().lock() {
            if let Some(u) = map.get_mut(udid) {
                u.priority.finish(wanted, success);
                if !success && restore_worker {
                    u.priority.pending = false;
                }
            }
        }
        if !success {
            return changed;
        }
    }
}

/// O ⚡ com o aparelho ligado: grava a preferência e reavalia a prioridade na hora, pela mesma regra do monitor.
/// À vista, ou com agente mexendo há pouco, o iOS continua na prioridade normal: baixar ali punha o iOS nos
/// núcleos de eficiência com a pessoa usando, e o estado daqui não sabia, então nunca restaurava. Um aparelho
/// que a ADE não ligou não entra no ciclo: só volta à normal. Devolve quantos processos mudaram.
pub fn set_light(udid: &str, light: bool) -> usize {
    if let Ok(mut s) = settings().lock() {
        s.light = light;
    }
    let tracked = usage().lock().map(|m| m.contains_key(udid)).unwrap_or(false);
    if tracked {
        apply_priority(udid, false)
    } else if light {
        0
    } else {
        ops::set_priority(udid, 0).unwrap_or(0)
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
            // Um agente que mexe no aparelho cancela a hibernação marcada.
            u.hibernating = false;
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

/// Há uma thread de monitor viva. Muda só com o mapa de uso travado, para o começo e o fim do monitor não se cruzarem
/// com um `booted`.
static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

/// Sobe o monitor se não houver um; quem chama segura a trava do mapa de uso.
fn start_monitor_locked() {
    if !MONITOR_RUNNING.swap(true, Ordering::AcqRel) {
        std::thread::spawn(monitor);
    }
}

/// Hiberna o que ficou esquecido e acerta a prioridade, a cada `CHECK_EVERY`. Sem aparelho que a ADE ligou, a thread
/// sai (o próximo `booted` a sobe de novo) em vez de acordar a cada 20 s para sempre.
fn monitor() {
    loop {
        std::thread::sleep(CHECK_EVERY);
        let now = Instant::now();
        let current = settings().lock().map(|s| *s).unwrap_or_default();
        let udids: Vec<String> = {
            let map = usage().lock().unwrap_or_else(|e| e.into_inner());
            if map.is_empty() {
                MONITOR_RUNNING.store(false, Ordering::Release);
                return;
            }
            map.keys().cloned().collect()
        };
        for udid in udids {
            // Decide com o uso de agora (sob a trava), não com uma cópia de antes do desligamento anterior.
            let claimed = usage().lock().map(|mut map| claim_due(&mut map, &udid, now, current.hibernate_after)).unwrap_or(false);
            if claimed {
                hibernate_marked(&udid, "hibernated", current.light);
            } else {
                apply_priority(&udid, false);
            }
        }
    }
}
