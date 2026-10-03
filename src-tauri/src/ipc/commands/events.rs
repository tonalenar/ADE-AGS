//! `ags events since|wait`: el bus de eventos de la ADE desde la CLI (ver `crate::bus`).
//!
//! Un script o un agente lead se pone al día con `since --after <seq>` y después espera lo
//! siguiente con `wait --after <último seq>`, sin sondear.

use std::time::Duration;

use serde_json::{json, Value};

use crate::bus::{self, Filter};
use crate::ipc::protocol::{arg_str_opt, arg_u64_opt};

const MAX_EVENTS: usize = 500;
const MAX_WAIT_SECS: u64 = 600;

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

/// Bloquea hasta que llega algo que cumpla el filtro, o hasta `--timeout` segundos.
pub(super) fn events_wait(args: &Value) -> Result<Value, String> {
    let timeout = Duration::from_secs(arg_u64_opt(args, "timeout").unwrap_or(60).clamp(1, MAX_WAIT_SECS));
    let page = bus::wait(arg_u64_opt(args, "after").unwrap_or(0), &filter(args), limit(args), timeout);
    Ok(json!(page))
}
