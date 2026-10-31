//! As conversas do modo chat que falam com o agente por protocolo, sem TUI (etapa 4 do modo chat,
//! ver `docs/ade-ags/MODO_CHAT.md`). Hoje: o Codex pelo `codex app-server`, o Claude Code pelo
//! `claude -p` em stream-json, o OpenCode pelo `opencode acp` e o Antigravity pelo `agy -p` em
//! stream-json (um processo por turno).
//!
//! - `store`: as tabelas (`chat_thread`, `chat_run`, `chat_item`, `chat_request`), só aditivas;
//! - `codex_map`: o item do Codex virando o `canal::timeline::Item` da timeline (puro);
//! - `codex`: o processo `app-server` de cada conversa (JSON por linha no stdio);
//! - `claude_map` e `claude`: o mesmo para o Claude Code (`claude -p`, stream-json no stdio);
//! - `opencode_map` e `opencode`: o mesmo para o OpenCode (Agent Client Protocol, JSON-RPC no stdio);
//! - `agy_map` e `agy`: o mesmo para o Antigravity (`agy --print --output-format stream-json`);
//! - `turn`: abrir e fechar o turno no banco, comum aos motores mais novos;
//! - `api`: o núcleo (criar, mandar, parar, responder, trocar), usado pela tela, pela CLI e pelo MCP;
//! - `commands`: os comandos Tauri;
//! - `worktree`: o worktree de uma conversa nova.

pub mod agy;
pub mod agy_map;
pub mod answer;
pub mod api;
pub mod claude;
pub mod claude_map;
pub mod codex;
pub mod codex_map;
pub mod envio;
pub mod events;
pub mod memoria;
pub mod commands;
pub mod opencode;
pub mod opencode_map;
pub mod permission;
pub mod resume;
pub mod store;
pub mod turn;
pub mod worktree;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_memoria;
#[cfg(test)]
mod test_motores;

pub use commands::*;
pub use store::migrate;
pub use worktree::*;
