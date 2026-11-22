//! Conector externo e integração efêmera de novas abas com o ai-memory.
pub(crate) mod client;
mod commands;
mod config;
pub(crate) mod continuation;
pub(crate) mod marker;
mod migracao;
pub mod scoped_bridge;
mod sessions;
pub(crate) mod tabs;
pub(crate) mod types;

pub use commands::*;

#[cfg(test)]
mod test;
