//! Conector externo e integração efêmera de novas abas; não importa memória.
mod client;
mod marker;
mod commands;
pub(crate) use commands::{project_context, write_agent_memory};
pub(crate) mod continuation;
mod migracao;
mod sessions;
pub mod scoped_bridge;
mod types;
pub(crate) mod tabs;

pub use commands::*;

#[cfg(test)]
mod test;
