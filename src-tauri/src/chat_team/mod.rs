//! O time de agentes do modo chat (pranchetas 15 e 16): uma conversa (aba de TUI ou conversa por
//! protocolo) vira o Orquestrador e outras conversas viram integrantes, cada uma com papel, modelo,
//! política de permissões e branch. Ver `docs/ade-ags/MODO_CHAT.md`.
//!
//! - `model`: o que é um integrante, as políticas, os papéis e os textos para os agentes (puro);
//! - `store`: as tabelas `chat_team` e `chat_team_member`, só aditivas;
//! - `api`: criar, ligar, desligar, mudar papel e política, o fio de delegações;
//! - `watch`: o vigia do chat (puro): o que o orquestrador precisa saber dos integrantes;
//! - `commands`: os comandos Tauri da tela.
//!
//! A autorização para os agentes se falarem continua sendo o canvas: ligar alguém ao time faz a tela
//! criar a corda entre ele e o orquestrador (e a coroa), como numa missão. O time não abre outro canal.

pub mod api;
pub mod commands;
pub mod env;
pub mod model;
pub mod permission;
pub mod store;
pub mod watch;
pub mod watch_db;
#[cfg(test)]
mod test;
#[cfg(test)]
mod watch_test;

pub use commands::*;
