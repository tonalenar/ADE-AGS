//! Conector externo e integração efêmera de novas abas; não importa memória.
pub(crate) mod client;
pub(crate) mod marker;
mod commands;
pub(crate) mod continuation;
mod migracao;
mod sessions;
pub mod scoped_bridge;
pub(crate) mod types;
pub(crate) mod tabs;

pub use commands::*;

#[cfg(test)]
mod test;
