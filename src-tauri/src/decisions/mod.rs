//! Decisões tipadas em modo sombra (Laya / Jev).
//!
//! A heurística que já existe continua devolvendo o resultado. O provedor HTTP só é
//! consultado em segundo plano e a comparação vai para `decision_shadow_log`. Nada daqui
//! aprova memória, despacha tarefa nem fecha missão.

pub(crate) mod commands;
mod config;
mod http;
pub(crate) mod log;
mod points;
mod protocol;
mod shadow;

pub(crate) use points::{
    fleet_jobs, observe_dreams, observe_memory_mission, observe_memory_workspace, observe_mission,
};
pub(crate) use shadow::enqueue;

#[cfg(test)]
mod test;
