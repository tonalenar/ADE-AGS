//! `ags events since|wait`: el bus de eventos de la ADE desde la CLI (ver `crate::bus`).
//!
//! Un script o un agente lead se pone al día con `since --after <seq>` y después espera lo
//! siguiente con `wait --after <último seq>`, sin sondear.
//!
//! `wait` devolve `noProgress: true` na hora, sem esperar o prazo, quando ninguém vai produzir o
//! evento esperado: com `--run`/`--mission`, nenhuma tarefa do run trabalha nem pode subir; sem eles,
//! quem chama é um orquestrador e nenhum integrante do time está trabalhando ou provisionando
//! (mensagem na fila para ele, ou recrutado há pouco). `--allow-idle` desliga a checagem.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::bus::{self, Filter};
use crate::ipc::protocol::{arg_str_opt, arg_u64_opt};

const MAX_EVENTS: usize = 500;
const MAX_WAIT_SECS: u64 = 600;
/// Um recrutado conta como "provisionando" por este tempo depois do recruit (a aba sobe, o agente lê).
const PROVISIONING_SECS: i64 = 120;

fn filter(args: &Value) -> Filter {
    Filter {
        // `--topics task.,mission.` llega partido en array (ver `parse_flags` de la CLI).
        topics: match args.get("topics") {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(one)) => one.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
            _ => Vec::new(),
        },
        run_id: arg_str_opt(args, "run"),
        mission_id: arg_str_opt(args, "mission"),
        task_id: arg_str_opt(args, "task"),
    }
}

fn limit(args: &Value) -> usize {
    arg_u64_opt(args, "limit").map_or(MAX_EVENTS, |n| (n as usize).clamp(1, MAX_EVENTS))
}

pub(super) fn events_since(args: &Value) -> Result<Value, String> {
    let page = bus::since(arg_u64_opt(args, "after").unwrap_or(0), &filter(args), limit(args));
    Ok(json!(page))
}

/// O que se sabe de um integrante na hora do `wait`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Member {
    pub name: String,
    /// No meio de um turno. Estado desconhecido (agente sem canal) conta como trabalhando: na dúvida, espera.
    pub working: bool,
    /// Ainda vai trabalhar: tem mensagem na fila ou acabou de ser recrutado.
    pub provisioning: bool,
}

/// `Some(motivo)` quando há integrantes e nenhum trabalha nem provisiona. Sem integrantes, `None`:
/// não há time a julgar e o `wait` segue como sempre. Pura.
pub(crate) fn idle_team(members: &[Member]) -> Option<String> {
    if members.is_empty() || members.iter().any(|m| m.working || m.provisioning) {
        return None;
    }
    let names: Vec<&str> = members.iter().map(|m| m.name.as_str()).collect();
    Some(format!("nenhum integrante está trabalhando ou provisionando ({})", names.join(", ")))
}

fn db(app: &AppHandle) -> Option<crate::database::DbConnection> {
    app.try_state::<crate::database::DbConnection>().map(|s| s.inner().clone())
}

/// O run do filtro: `--run`, ou o run ativo de `--mission`.
fn run_of(conn: &rusqlite::Connection, filter: &Filter) -> Option<String> {
    filter.run_id.clone().or_else(|| {
        let mission = filter.mission_id.as_deref()?;
        crate::missions::store::get(conn, mission).ok().flatten()?.active_run_id
    })
}

fn run_idle(app: &AppHandle, filter: &Filter) -> Option<String> {
    let db = db(app)?;
    let conn = db.lock().ok()?;
    let run = run_of(&conn, filter)?;
    let tasks = crate::runs::store::tasks_of_run(&conn, &run).ok()?;
    crate::runs::orchestration::no_progress(&tasks)
}

fn working(member: &str) -> bool {
    if let Some(thread) = crate::chat_team::model::thread_id_of(member) {
        return crate::conversa::api::status(thread).working;
    }
    // Sem canal ou com o canal desligado não se sabe: conta como trabalhando.
    crate::canal::mode() == crate::canal::Mode::Off || crate::canal::snapshot(member).is_none() || crate::canal::busy(member)
}

/// Os integrantes do time de quem chama, se ele é orquestrador: o time do modo chat, senão a equipe
/// do canvas (coroa).
fn team_members(app: &AppHandle, from: &str) -> Vec<Member> {
    let Some(db) = db(app) else { return Vec::new() };
    let (ids, queued) = {
        let Ok(conn) = db.lock() else { return Vec::new() };
        let chat = crate::chat_team::api::team_of(&conn, from).ok().flatten().filter(|v| v.team.orchestrator == from);
        let ids: Vec<(String, String)> = match chat {
            Some(view) => view.members.iter().map(|m| (m.member.clone(), m.label.clone())).collect(),
            None => {
                let boards = crate::canvas::load_boards();
                if !crate::canvas::is_orchestrator(&boards, from) {
                    return Vec::new();
                }
                crate::canvas::team_of(&boards, from).into_iter().filter(|id| id != from).map(|id| (id.clone(), id)).collect()
            }
        };
        let queued = crate::peer_queue::store::pending_counts(&conn).unwrap_or_default();
        (ids, queued)
    };
    let book = crate::squads::recruit::load_book();
    let now = crate::util::now_ts();
    let names: Vec<(String, String)> = super::peers::open_tabs(app).unwrap_or_default().into_iter().map(|t| (t.id, t.name)).collect();
    ids.into_iter()
        .map(|(id, label)| {
            let fresh = book.get(&id).is_some_and(|r| now - r.at < PROVISIONING_SECS);
            let waiting = queued.iter().any(|(to, n)| to == &id && *n > 0);
            let name = names.iter().find(|(t, _)| t == &id).map(|(_, n)| n.clone()).unwrap_or(label);
            Member { working: working(&id), provisioning: fresh || waiting, name }
        })
        .collect()
}

/// Bloquea hasta que llega algo que cumpla el filtro, o hasta `--timeout` segundos. Volta na hora
/// com `noProgress` quando ninguém vai produzir o evento (ver o topo do arquivo).
pub(super) fn events_wait(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let timeout = Duration::from_secs(arg_u64_opt(args, "timeout").unwrap_or(60).clamp(1, MAX_WAIT_SECS));
    let after = arg_u64_opt(args, "after").unwrap_or(0);
    let filter = filter(args);
    if args.get("allowIdle").and_then(Value::as_bool) != Some(true) {
        // O que já está no anel ganha do "parado": um evento esperando é progresso.
        let ready = bus::since(after, &filter, limit(args));
        if ready.events.is_empty() {
            let idle = if filter.run_id.is_some() || filter.mission_id.is_some() {
                run_idle(app, &filter)
            } else {
                arg_str_opt(args, "from").and_then(|from| idle_team(&team_members(app, &from)))
            };
            if let Some(reason) = idle {
                let mut out = json!(ready);
                out["noProgress"] = json!(true);
                out["reason"] = json!(format!("{reason}. Esperar não traz evento: delegue, replaneje ou fale com a pessoa (`--allow-idle` espera mesmo assim)."));
                return Ok(out);
            }
        }
    }
    let page = bus::wait(after, &filter, limit(args), timeout);
    Ok(json!(page))
}

#[cfg(test)]
mod tests {
    use super::{idle_team, Member};

    fn m(name: &str, working: bool, provisioning: bool) -> Member {
        Member { name: name.into(), working, provisioning }
    }

    #[test]
    fn time_parado_volta_no_progress_e_qualquer_atividade_segura_a_espera() {
        assert_eq!(idle_team(&[]), None, "sem time não há o que julgar");
        let why = idle_team(&[m("QA", false, false), m("Back", false, false)]).unwrap();
        assert!(why.contains("QA, Back"), "{why}");
        assert_eq!(idle_team(&[m("QA", false, false), m("Back", true, false)]), None);
        assert_eq!(idle_team(&[m("QA", false, true)]), None, "mensagem na fila ou recrutado agora é provisionando");
    }
}
