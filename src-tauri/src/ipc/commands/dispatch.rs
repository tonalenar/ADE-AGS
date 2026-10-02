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
use super::browser::browser_run;
use super::runs::{run_approve, run_orchestrate};
use super::shared::bridge_call;
use super::skills::{skill_edit, skill_install, skill_list, skill_new, skill_search, skill_show};
use super::tabs::{tab_create, tab_list, tab_output, tab_send};
use super::watch::{watch_add, watch_list, watch_remove, watch_wait};
use super::windows::{window_create, window_list};
use super::workspaces::{workspace_list, workspace_open, workspace_status};
use crate::ipc::protocol::Response;

pub fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Response {
    let result = match command {
        "tab.list" => tab_list(app),
        "tab.output" => tab_output(app, args),
        "tab.send" => tab_send(app, args),
        "tab.create" => tab_create(app, args),
        "tab.close" => bridge_call(app, "tab.close", args),
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
        // Los que manda un agente y no una persona, desde el `ccode mcp` que lanzó su TUI.
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
        "mission.accept" => missions::mission_accept(app, args),
        "mission.apply" => missions::mission_apply(app, args),
        "approval.list" => missions::approval_list(app),
        "approval.decide" => missions::approval_decide(app, args),
        other => Err(format!("Comando desconocido: {other}")),
    };

    match result {
        Ok(data) => Response::ok(data),
        Err(e) => Response::err(e),
    }
}
