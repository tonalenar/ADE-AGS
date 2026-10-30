//! Conector externo e integração efêmera de novas abas; não importa memória.
mod client;
mod commands;
mod sessions;
mod types;
pub(crate) mod tabs;

pub use commands::*;

#[cfg(test)]
mod test;
