//! Conector externo de leitura; não captura sessões nem importa memória.
mod client;
mod commands;
mod types;

pub use commands::*;

#[cfg(test)]
mod test;
