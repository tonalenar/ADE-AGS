//! Rotinas: `ccode routines | routine create|show|edit|enable|disable|run|delete`, e o
//! agendador que as dispara (ver `crate::routines` para o modelo e as decisões).
//!
//! ## Quem pode o quê
//!
//! - Uma rotina escreve num terminal, então criá-la é poder falar com ele: um agente só
//!   agenda para si mesmo ou para quem alcança no canvas (`--to`), igual a `peer tell`.
//! - **Terminais de shell só os agenda quem está num terminal de shell** (o usuário
//!   digitando). Um agente não deixa um comando de shell agendado: seria execução
//!   recorrente e persistente, e sobreviveria à conversa que o criou.
//! - Cada um gerencia as rotinas que criou. Quem está num terminal de shell gerencia todas.
//!   A tela da app (o usuário) gerencia todas também.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use chrono::Local;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, open_tabs, peers, resolve_peer, OpenTab};
use super::tabs::{pty_id_for_tab, submit_prompt, wait_until_quiet};
use crate::ipc::bridge::{ask_frontend, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt};
use crate::routines::{self, Routine};

/// El evento que avisa a la tela que cambió la lista de rotinas.
pub const CHANGED_EVENT: &str = "cc-routines-changed";

/// Cada cuánto mira el agendador si hay algo que disparar. La precisión de una rotina es la
/// de este paso: una de las 9:00 sale entre las 9:00 y las 9:00:15.
const TICK: Duration = Duration::from_secs(15);

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

// ── Disparar ────────────────────────────────────────────────────────

/// Lo que llega a un agente: de quién viene, para que no lo tome por una orden del usuario.
fn framed(routine: &Routine) -> String {
    format!("[Rotina '{}' via ADE AGS] {}", routine.name, routine.text)
}

/// Hace lo que dice la rotina: escribe en la aba de destino o avisa al usuario. Devuelve lo
/// que pasó, para la ficha de la rotina.
pub(crate) fn fire(app: &AppHandle, routine: &Routine) -> Result<String, String> {
    let Some(target_id) = &routine.target_tab else {
        let raw = ask_frontend(app, "user.notify", &json!({ "from": routine.name, "message": routine.text }), None)?;
        unwrap_frontend_result(raw)?;
        // Un recordatorio es justo para cuando no estás mirando: también como aviso del sistema.
        let system = crate::notifier::show_custom(app, &routine.name, &routine.text);
        return Ok(if system { "lembrete mostrado (e notificação do sistema)" } else { "lembrete mostrado" }.into());
    };

    let tab = open_tabs(app)?
        .into_iter()
        .find(|t| &t.id == target_id)
        .ok_or_else(|| format!("a aba '{}' está fechada", routine.target_name))?;
    let pty = pty_id_for_tab(app, &tab.id, Some(&tab.window))?;

    // No se interrumpe a quien está a mitad de un turno: se espera a que se calle.
    wait_until_quiet(pty, Duration::from_millis(1500), Duration::from_secs(60), false);
    let text = if tab.agent_id == "bash" { routine.text.clone() } else { framed(routine) };
    submit_prompt(pty, &text)?;
    Ok(format!("enviada para {}", tab.name))
}

lazy_static::lazy_static! {
    /// Las que están disparándose ahora: una espera larga (el agente de destino ocupado) no
    /// debe provocar un segundo disparo en el tick siguiente.
    static ref IN_FLIGHT: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

/// Dispara una rotina y anota cómo le fue.
fn run_and_record(app: &AppHandle, id: &str, reschedule: bool) -> Result<String, String> {
    let routine = routines::all().into_iter().find(|r| r.id == id).ok_or("A rotina não existe mais.")?;
    let result = fire(app, &routine);
    let message = match &result {
        Ok(ok) => ok.clone(),
        Err(e) => format!("falhou: {e}"),
    };
    let now = Local::now();
    let _ = routines::update(|all| {
        if let Some(r) = all.iter_mut().find(|r| r.id == id) {
            if reschedule {
                routines::after_run(r, now, message.clone());
            } else {
                // `run` manual: conta e anota, mas não mexe no horário.
                r.last_run = Some(now.timestamp());
                r.last_result = message.clone();
                r.runs += 1;
            }
        }
        Ok(())
    });
    changed(app);
    result
}

/// Arranca o agendador: recupera o que ficou atrasado do fechamento anterior e, daí em
/// diante, olha a cada `TICK`. Cada disparo corre em sua própria hebra.
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        let _ = routines::update(|all| {
            routines::recover(all, Local::now());
            Ok(())
        });
        loop {
            std::thread::sleep(TICK);
            let due = routines::due(&routines::all(), Local::now().timestamp());
            for id in due {
                {
                    let mut busy = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
                    if !busy.insert(id.clone()) {
                        continue;
                    }
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = run_and_record(&app, &id, true);
                    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                });
            }
        }
    });
}

// ── Comandos ────────────────────────────────────────────────────────

fn me(app: &AppHandle, args: &Value) -> Result<OpenTab, String> {
    let from = caller(args)?;
    open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())
}

fn is_shell(tab: &OpenTab) -> bool {
    tab.agent_id == "bash"
}

/// ¿Puede `me` gestionar esta rutina? La que creó, o todas si está en un shell.
fn can_manage(me: &OpenTab, r: &Routine) -> bool {
    is_shell(me) || r.creator == me.id
}

fn visible(me: &OpenTab) -> Vec<Routine> {
    routines::all().into_iter().filter(|r| can_manage(me, r)).collect()
}

fn describe(r: &Routine) -> Value {
    json!({
        "id": r.id,
        "name": r.name,
        "schedule": routines::describe(&r.schedule),
        "enabled": r.enabled,
        "target": if r.target_tab.is_some() { json!(r.target_name) } else { json!("(lembrete para o usuário)") },
        "nextRun": r.next_run.map(fmt_time),
        "lastRun": r.last_run.map(fmt_time),
        "lastResult": r.last_result,
        "runs": r.runs,
    })
}

fn fmt_time(unix: i64) -> String {
    use chrono::TimeZone;
    Local.timestamp_opt(unix, 0).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

fn flag(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "" | "true" | "1" | "yes"),
        _ => false,
    }
}

/// Lê o "quando" dos flags, se vier algum.
fn schedule_from(args: &Value) -> Result<Option<routines::Schedule>, String> {
    let (every, at, in_) = (arg_str_opt(args, "every"), arg_str_opt(args, "at"), arg_str_opt(args, "in"));
    if every.is_none() && at.is_none() && in_.is_none() && args.get("days").is_none() {
        return Ok(None);
    }
    routines::build_schedule(every.as_deref(), at.as_deref(), arg_str_opt(args, "days").as_deref(), in_.as_deref(), Local::now())
        .map(Some)
}

pub(super) fn routine_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    Ok(json!({ "routines": visible(&me).iter().map(describe).collect::<Vec<_>>() }))
}

pub(super) fn routine_show(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let mine = visible(&me);
    let r = routines::find(&mine, &arg_str(args, "name")?)?;
    let mut out = describe(r);
    out["text"] = json!(r.text);
    Ok(json!({ "routine": out }))
}

pub(super) fn routine_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let name = routines::clean_name(&arg_str(args, "name")?)?;
    let text = routines::clean_text(&arg_str(args, "text")?)?;
    let schedule = schedule_from(args)?.ok_or("Diga quando: --every 30m, --at 09:00 [--days seg,qua] ou --in 45m.")?;

    // A quién le habla: a nadie (un lembrete), a otro agente que alcanza, o a sí mismo.
    let target: Option<OpenTab> = if flag(args, "remind") {
        None
    } else if let Some(to) = arg_str_opt(args, "to").filter(|t| !t.trim().is_empty()) {
        if to.trim().eq_ignore_ascii_case(&me.name) || to == me.id {
            Some(me.clone())
        } else {
            let (_, list) = peers(app, &me.id)?;
            Some(resolve_peer(&list, &to)?.clone())
        }
    } else {
        Some(me.clone())
    };
    if let Some(t) = &target {
        if is_shell(t) && !is_shell(&me) {
            return Err("Um agente não agenda comandos de shell. Peça ao usuário para criar essa rotina a partir de um terminal.".into());
        }
    }

    let now = Local::now();
    let created = routines::update(|all| {
        if all.len() >= routines::MAX_ROUTINES {
            return Err(format!("Já há {} rotinas, o máximo. Apague alguma com `ccode routine delete`.", routines::MAX_ROUTINES));
        }
        if all.iter().any(|r| r.name.to_lowercase() == name.to_lowercase()) {
            return Err(format!("Já existe uma rotina chamada '{name}'."));
        }
        let routine = Routine {
            id: routines::new_id(),
            name: name.clone(),
            text: text.clone(),
            target_tab: target.as_ref().map(|t| t.id.clone()),
            target_name: target.as_ref().map(|t| t.name.clone()).unwrap_or_default(),
            creator: me.id.clone(),
            next_run: routines::next_run(&schedule, now).map(|t| t.timestamp()),
            schedule: schedule.clone(),
            enabled: true,
            last_run: None,
            last_result: String::new(),
            runs: 0,
        };
        all.push(routine.clone());
        Ok(routine)
    })?;
    changed(app);
    Ok(json!({ "created": describe(&created) }))
}

pub(super) fn routine_edit(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let wanted = arg_str(args, "name")?;
    let new_name = arg_str_opt(args, "rename").map(|n| routines::clean_name(&n)).transpose()?;
    let new_text = arg_str_opt(args, "text").map(|t| routines::clean_text(&t)).transpose()?;
    let new_schedule = schedule_from(args)?;
    if new_name.is_none() && new_text.is_none() && new_schedule.is_none() {
        return Err("Nada para mudar: use --rename, --text ou um novo horário (--every, --at, --in).".into());
    }

    let now = Local::now();
    let edited = routines::update(|all| {
        let id = routines::find(&visible_in(all, &me), &wanted)?.id.clone();
        if let Some(n) = &new_name {
            if all.iter().any(|r| r.id != id && r.name.to_lowercase() == n.to_lowercase()) {
                return Err(format!("Já existe uma rotina chamada '{n}'."));
            }
        }
        let r = all.iter_mut().find(|r| r.id == id).ok_or("A rotina não existe mais.")?;
        if let Some(n) = new_name {
            r.name = n;
        }
        if let Some(t) = new_text {
            r.text = t;
        }
        if let Some(s) = new_schedule {
            r.schedule = s;
            if r.enabled {
                r.next_run = routines::next_run(&r.schedule, now).map(|t| t.timestamp());
            }
        }
        Ok(r.clone())
    })?;
    changed(app);
    Ok(json!({ "edited": describe(&edited) }))
}

/// `visible` sobre una lista ya cargada (dentro de un `update`, que tiene el cerrojo).
fn visible_in(all: &[Routine], me: &OpenTab) -> Vec<Routine> {
    all.iter().filter(|r| can_manage(me, r)).cloned().collect()
}

fn set_enabled(app: &AppHandle, args: &Value, enabled: bool) -> Result<Value, String> {
    let me = me(app, args)?;
    let wanted = arg_str(args, "name")?;
    let now = Local::now();
    let out = routines::update(|all| {
        let id = routines::find(&visible_in(all, &me), &wanted)?.id.clone();
        let r = all.iter_mut().find(|r| r.id == id).ok_or("A rotina não existe mais.")?;
        apply_enabled(r, enabled, now)?;
        Ok(r.clone())
    })?;
    changed(app);
    Ok(json!({ "routine": describe(&out) }))
}

/// Liga o desliga. Al ligar se recalcula la próxima vez desde ahora (no se "recupera" el
/// tiempo apagada); una rutina de una sola vez que ya pasó no se puede volver a encender.
pub(crate) fn apply_enabled(r: &mut Routine, enabled: bool, now: chrono::DateTime<Local>) -> Result<(), String> {
    if enabled {
        let next = routines::next_run(&r.schedule, now).map(|t| t.timestamp());
        if next.is_none() {
            return Err("Essa rotina era de uma vez só e já passou. Crie outra.".into());
        }
        r.next_run = next;
    } else {
        r.next_run = None;
    }
    r.enabled = enabled;
    Ok(())
}

pub(super) fn routine_enable(app: &AppHandle, args: &Value) -> Result<Value, String> {
    set_enabled(app, args, true)
}

pub(super) fn routine_disable(app: &AppHandle, args: &Value) -> Result<Value, String> {
    set_enabled(app, args, false)
}

pub(super) fn routine_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let mine = visible(&me);
    let id = routines::find(&mine, &arg_str(args, "name")?)?.id.clone();
    let result = run_and_record(app, &id, false)?;
    Ok(json!({ "ran": result }))
}

pub(super) fn routine_delete(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let me = me(app, args)?;
    let wanted = arg_str(args, "name")?;
    let name = routines::update(|all| {
        let id = routines::find(&visible_in(all, &me), &wanted)?.id.clone();
        let at = all.iter().position(|r| r.id == id).ok_or("A rotina não existe mais.")?;
        Ok(all.remove(at).name)
    })?;
    changed(app);
    Ok(json!({ "deleted": name }))
}

// ── Para la pantalla ────────────────────────────────────────────────

#[tauri::command]
pub fn routine_list_all() -> Vec<Routine> {
    routines::all()
}

#[tauri::command]
pub fn routine_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let now = Local::now();
    routines::update(|all| {
        let r = all.iter_mut().find(|r| r.id == id).ok_or("A rotina não existe mais.")?;
        apply_enabled(r, enabled, now)
    })?;
    changed(&app);
    Ok(())
}

/// `async`: puede esperar a que el agente de destino se calle.
#[tauri::command(async)]
pub fn routine_run_now(app: AppHandle, id: String) -> Result<String, String> {
    run_and_record(&app, &id, false)
}

#[tauri::command]
pub fn routine_remove(app: AppHandle, id: String) -> Result<(), String> {
    routines::update(|all| {
        all.retain(|r| r.id != id);
        Ok(())
    })?;
    changed(&app);
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::routines::Schedule;
    use chrono::TimeZone;

    fn tab(id: &str, agent_id: &str) -> OpenTab {
        OpenTab {
            id: id.into(),
            name: id.into(),
            agent: agent_id.into(),
            agent_id: agent_id.into(),
            cwd: "/p".into(),
            window: "main".into(),
        }
    }

    fn routine(creator: &str) -> Routine {
        Routine {
            id: "r1".into(),
            name: "R".into(),
            text: "x".into(),
            target_tab: None,
            target_name: String::new(),
            creator: creator.into(),
            schedule: Schedule::Every { secs: 600 },
            enabled: true,
            next_run: None,
            last_run: None,
            last_result: String::new(),
            runs: 0,
        }
    }

    #[test]
    fn cada_uno_gestiona_las_suyas_y_el_shell_todas() {
        let r = routine("a1");
        assert!(can_manage(&tab("a1", "claude"), &r));
        assert!(!can_manage(&tab("a2", "claude"), &r), "otro agente no toca la rutina ajena");
        assert!(can_manage(&tab("sh", "bash"), &r), "quien está en un shell es el usuario");
    }

    #[test]
    fn el_mensaje_dice_que_viene_de_una_rutina() {
        let mut r = routine("a1");
        r.name = "Testes".into();
        r.text = "rode os testes".into();
        assert_eq!(framed(&r), "[Rotina 'Testes' via ADE AGS] rode os testes");
    }

    #[test]
    fn apagar_y_prender_recalcula_desde_ahora() {
        let now = Local.with_ymd_and_hms(2026, 10, 5, 12, 0, 0).earliest().unwrap();
        let mut r = routine("a1");
        r.next_run = Some(now.timestamp() - 9999);
        apply_enabled(&mut r, false, now).unwrap();
        assert!(!r.enabled && r.next_run.is_none());
        apply_enabled(&mut r, true, now).unwrap();
        assert!(r.enabled);
        assert_eq!(r.next_run, Some(now.timestamp() + 600), "no recupera el tiempo apagada");
    }

    #[test]
    fn una_de_una_sola_vez_que_paso_no_se_enciende() {
        let now = Local.with_ymd_and_hms(2026, 10, 5, 12, 0, 0).earliest().unwrap();
        let mut r = routine("a1");
        r.schedule = Schedule::Once { at: now.timestamp() - 60 };
        r.enabled = false;
        let err = apply_enabled(&mut r, true, now).unwrap_err();
        assert!(err.contains("já passou"), "{err}");
        assert!(!r.enabled);
    }
}
