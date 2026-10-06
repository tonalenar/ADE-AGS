//! El router: traduce el nombre del comando de la CLI al handler que lo atiende.
//!
//! Cada comando se resuelve por el camino más corto posible:
//!
//! - **Lecturas** (`*.list`, `tab output`, `workspace status`) van directo a SQLite o al
//!   registro de PTYs, sin molestar al frontend.
//! - **Acciones sobre ventanas/workspaces/skills** reusan los mismos comandos Tauri que
//!   usa la UI, así la CLI nunca toma un camino distinto al de un click.
//! - **Crear/cerrar tabs** pasa por `bridge`, porque mientras la app corre la fuente de
//!   verdad de las tabs es el store del frontend (ver el comentario de ese módulo).

use serde_json::Value;
use tauri::AppHandle;

use super::agents::{account_list, agent_list, prelaunch_list};
use super::app::app_status;
use super::ask::user_ask;
use super::events::{events_since, events_wait};
use super::missions;
use super::notify::notify_send;
use super::notes::{note_create, note_edit, note_list, note_read, note_write};
use super::devices::{device_action, device_create, device_list};
use super::pool::{pool_create, pool_delete, pool_list};
use super::portals::{portal_action, portal_create, portal_list};
use super::role::{role_create, role_edit, role_list, role_show};
use super::floor::{floor_create, floor_list};
use super::routine::{
    routine_create, routine_delete, routine_disable, routine_edit, routine_enable, routine_list, routine_run, routine_show,
};
use super::chat::{chat_recall, chat_say};
use super::peers::{peer_ask, peer_check, peer_connect, peer_disconnect, peer_list, peer_recruit, peer_tell};
use super::browser::browser_run;
use super::runs::{run_approve, run_orchestrate};
use super::shared::bridge_call;
use super::skills::{skill_edit, skill_install, skill_list, skill_new, skill_search, skill_show};
use super::tabs::{tab_create, tab_list, tab_output, tab_send};
use super::watch::{watch_add, watch_list, watch_remove, watch_wait};
use super::windows::{window_create, window_list};
use super::workspaces::{workspace_list, workspace_open, workspace_status};
use crate::ipc::protocol::Response;

/// Traduz o nome de CLI `design.*` para a operação do módulo `design` e a executa.
fn design_command(app: &AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    let op = match command {
        "design.page.add" => "page_add",
        "design.artboard.add" => "artboard_add",
        "design.update" | "design.artboard.update" => "artboard_update",
        "design.revert" | "design.artboard.revert" => "artboard_revert",
        "design.approve" | "design.artboard.approve" => "artboard_approve",
        "design.reject" | "design.artboard.reject" => "artboard_reject",
        "design.comment" | "design.comment.add" => "comment_add",
        "design.comment.resolve" => "comment_resolve",
        "design.approve.all" => "approve_all",
        other => &other[7..],
    };
    let mut args = args.clone();
    if args.get("html").is_none() {
        if let Some(content) = args.get("content").cloned() {
            args["html"] = content;
        }
    }
    crate::design::dispatch(app, op, &args)
}

pub fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Response {
    let result = match command {
        "design.create" => design_command(app, command, args),
        "design.delete" => design_command(app, command, args),
        "design.archive" => design_command(app, command, args),
        "design.list" => design_command(app, command, args),
        "design.get" => design_command(app, command, args),
        "design.page.add" => design_command(app, command, args),
        "design.artboard.add" => design_command(app, command, args),
        "design.update" => design_command(app, command, args),
        "design.artboard.update" => design_command(app, command, args),
        "design.revert" => design_command(app, command, args),
        "design.artboard.revert" => design_command(app, command, args),
        "design.approve" => design_command(app, command, args),
        "design.artboard.approve" => design_command(app, command, args),
        "design.reject" => design_command(app, command, args),
        "design.artboard.reject" => design_command(app, command, args),
        "design.comment" => design_command(app, command, args),
        "design.comment.add" => design_command(app, command, args),
        "design.comment.resolve" => design_command(app, command, args),
        "design.approve.all" => design_command(app, command, args),
        "tab.list" => tab_list(app),
        "tab.output" => tab_output(app, args),
        "tab.send" => tab_send(app, args),
        "tab.create" => tab_create(app, args),
        "tab.close" => bridge_call(app, "tab.close", args),
        // Conversar con los agentes conectados en el canvas (ver `peers`).
        "peer.list" => peer_list(app, args),
        "peer.ask" => peer_ask(app, args),
        "peer.tell" => peer_tell(app, args),
        "peer.check" => peer_check(app, args),
        "peer.recruit" => peer_recruit(app, args),
        "peer.connect" => peer_connect(app, args),
        "peer.disconnect" => peer_disconnect(app, args),
        // Las notas del canvas conectadas con quien pide (ver `notes`).
        "note.list" => note_list(app, args),
        "note.read" => note_read(app, args),
        "note.create" => note_create(app, args),
        "note.write" => note_write(app, args),
        "note.edit" => note_edit(app, args),
        // Los navegadores del canvas conectados con quien pide (ver `portals`).
        // Las pantallas Android del canvas (emulador o teléfono) conectadas con quien pide (ver `devices`).
        // Grupos de cuentas con una estrategia de reparto (ver `pool`).
        "pool.list" => pool_list(app, args),
        "pool.create" => pool_create(app, args),
        "pool.delete" => pool_delete(app, args),
        "device.list" => device_list(app, args),
        "device.create" => device_create(app, args),
        "device.start" => device_action(app, args, "start"),
        "device.tap" => device_action(app, args, "tap"),
        "device.swipe" => device_action(app, args, "swipe"),
        "device.type" => device_action(app, args, "type"),
        "device.key" => device_action(app, args, "key"),
        "device.launch" => device_action(app, args, "launch"),
        "device.shot" => device_action(app, args, "shot"),
        "device.tree" => device_action(app, args, "tree"),
        "portal.list" => portal_list(app, args),
        "portal.create" => portal_create(app, args),
        "portal.navigate" => portal_action(app, args, "navigate"),
        "portal.history" => portal_action(app, args, "history"),
        "portal.snapshot" => portal_action(app, args, "snapshot"),
        "portal.click" => portal_action(app, args, "click"),
        "portal.hover" => portal_action(app, args, "hover"),
        "portal.type" => portal_action(app, args, "type"),
        "portal.press" => portal_action(app, args, "press"),
        "portal.select" => portal_action(app, args, "select"),
        "portal.scroll" => portal_action(app, args, "scroll"),
        "portal.wait" => portal_action(app, args, "wait"),
        "portal.screenshot" => portal_action(app, args, "screenshot"),
        "portal.console" => portal_action(app, args, "console"),
        "portal.layout" => portal_action(app, args, "layout"),
        // Avisar al usuario (ver `notify`).
        "notify.send" => notify_send(app, args),
        // Papeles para recrutar (ver `role`).
        "role.list" => role_list(app, args),
        "role.show" => role_show(app, args),
        "role.create" => role_create(app, args),
        "role.edit" => role_edit(app, args),
        // Pisos: espacios aislados del proyecto (ver `floor`).
        "floor.list" => floor_list(app, args),
        "floor.create" => floor_create(app, args),
        // Rotinas: mensajes a la hora (ver `routine`).
        "routine.list" => routine_list(app, args),
        "routine.show" => routine_show(app, args),
        "routine.create" => routine_create(app, args),
        "routine.edit" => routine_edit(app, args),
        "routine.enable" => routine_enable(app, args),
        "routine.disable" => routine_disable(app, args),
        "routine.run" => routine_run(app, args),
        "routine.delete" => routine_delete(app, args),
        // Chat con el usuario (ver `chat`).
        "say.send" => chat_say(app, args),
        "recall.get" => chat_recall(app, args),
        "agent.list" => agent_list(app),
        "account.list" => account_list(app),
        "prelaunch.list" => prelaunch_list(app),
        "watch.add" => watch_add(app, args),
        "watch.remove" => watch_remove(app, args),
        "watch.list" => watch_list(app),
        "watch.wait" => watch_wait(args),
        "window.list" => window_list(app),
        "window.create" => window_create(app),
        "workspace.list" => workspace_list(app),
        "workspace.open" => workspace_open(app, args),
        "workspace.status" => workspace_status(app),
        "skill.list" => skill_list(app),
        "skill.search" => skill_search(app, args),
        "skill.install" => skill_install(app, args),
        "skill.show" => skill_show(app, args),
        "skill.new" => skill_new(app, args),
        "skill.edit" => skill_edit(app, args),
        // Los que manda un agente y no una persona, desde el `ags mcp` que lanzó su TUI.
        // `run.approve` bloquea hasta que alguien decide; `browser.run` maneja el
        // navegador de las tabs del proyecto.
        "run.approve" => run_approve(app, args),
        "browser.run" => browser_run(app, args),
        "user.ask" => user_ask(app, args),
        "forge.run" => crate::forge::tools::run(app, args),
        "mcp.cancel" => {
            if let Some(id) = args.get("callId").and_then(Value::as_str) {
                crate::ipc::cancel::cancel(id);
            }
            Ok(serde_json::json!({}))
        }
        "run.roster" => run_orchestrate(app, "run.roster", args),
        "run.plan" => run_orchestrate(app, "run.plan", args),
        "run.addTask" => run_orchestrate(app, "run.addTask", args),
        "run.status" => run_orchestrate(app, "run.status", args),
        "run.result" => run_orchestrate(app, "run.result", args),
        "run.await" => run_orchestrate(app, "run.await", args),
        "run.handoff" => run_orchestrate(app, "run.handoff", args),
        "run.addFact" => run_orchestrate(app, "run.addFact", args),
        "run.facts" => run_orchestrate(app, "run.facts", args),
        "run.factBody" => run_orchestrate(app, "run.factBody", args),
        "memory.list" => run_orchestrate(app, "memory.list", args),
        "memory.get" => run_orchestrate(app, "memory.get", args),
        "memory.propose" => run_orchestrate(app, "memory.propose", args),
        "memory.update" => run_orchestrate(app, "memory.update", args),
        "memory.delete" => run_orchestrate(app, "memory.delete", args),
        "memory.promoteFact" => run_orchestrate(app, "memory.promoteFact", args),
        "run.cancelTask" => run_orchestrate(app, "run.cancelTask", args),
        "run.rerouteTask" => run_orchestrate(app, "run.rerouteTask", args),
        "app.status" => app_status(app),
        // El bus de eventos (ver `crate::bus`): ponerse al día y esperar lo siguiente.
        "events.since" => events_since(args),
        "events.wait" => events_wait(args),
        // Misiones y aprobaciones sin la interfaz (modo headless, CI).
        "mission.create" => missions::mission_create(app, args),
        "mission.start" => missions::mission_start(app, args),
        "mission.status" => missions::mission_status(app, args),
        "mission.wait" => missions::mission_wait(app, args),
        "mission.run" => missions::mission_run(app, args),
        "mission.review" => missions::mission_review(app, args),
        "mission.timings" => missions::mission_timings(app, args),
        "mission.startcheck" => missions::mission_startcheck(app, args),
        "mission.efficiency" => missions::mission_efficiency(app, args),
        "mission.precheck" => missions::mission_precheck(app, args),
        "memory.search" => missions::memory_search(app, args),
        "memory.history" => missions::memory_history(app, args),
        "memory.suggest" => missions::memory_suggest(app, args),
        "mission.accept" => missions::mission_accept(app, args),
        "mission.apply" => missions::mission_apply(app, args),
        "mission.redeliver" => missions::mission_redeliver(app, args),
        "approval.list" => missions::approval_list(app),
        "approval.decide" => missions::approval_decide(app, args),
        other => Err(format!("Comando desconocido: {other}")),
    };

    match result {
        Ok(data) => Response::ok(data),
        Err(e) => Response::err(e),
    }
}
