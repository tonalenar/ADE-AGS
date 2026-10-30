//! As conversas do modo chat que falam com o agente por protocolo, sem TUI (etapa 4 do modo chat,
//! ver `docs/ade-ags/MODO_CHAT.md`). Hoje: o Codex pelo `codex app-server`.
//!
//! - `store`: as tabelas (`chat_thread`, `chat_run`, `chat_item`, `chat_request`), só aditivas;
//! - `codex_map`: o item do Codex virando o `canal::timeline::Item` da timeline (puro);
//! - `codex`: o processo `app-server` de cada conversa (JSON por linha no stdio);
//! - `api`: o núcleo (criar, mandar, parar, responder, trocar), usado pela tela, pela CLI e pelo MCP;
//! - `commands`: os comandos Tauri;
//! - `worktree`: o worktree de uma conversa nova.

pub mod api;
pub mod codex;
pub mod codex_map;
pub mod commands;
pub mod store;
pub mod worktree;
#[cfg(test)]
mod test;

pub use commands::*;
pub use store::migrate;
pub use worktree::*;
