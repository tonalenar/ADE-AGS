//! Decisões tipadas em modo sombra (Laya / Jev).
//!
//! A heurística que já existe continua devolvendo o resultado. O provedor HTTP só é
//! consultado em segundo plano e a comparação vai para `decision_shadow_log`. Nada daqui
//! aprova memória, despacha tarefa nem fecha missão.

pub(crate) mod browse;
pub(crate) mod commands;
mod config;
mod http;
pub(crate) mod delivery;
pub(crate) mod hints;
pub(crate) mod log;
pub(crate) mod relevance;
mod points;
mod protocol;
pub mod routing;
pub mod scorecard;
mod shadow;

pub(crate) use points::record_memory_decision;
pub(crate) use points::{
    fleet_jobs, observe_dreams, observe_memory_mission, observe_memory_workspace, observe_mission,
};
pub(crate) use shadow::enqueue;
#[cfg(test)]
pub(crate) use points::{memory_state_hash, POINT_MEMORY};

#[cfg(test)]
mod test;
