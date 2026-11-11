//! As conversas do modo chat que falam com o agente por protocolo, sem TUI (etapa 4 do modo chat,
//! ver `docs/ade-ags/MODO_CHAT.md`). Hoje: o Codex pelo `codex app-server`, o Claude Code pelo
//! `claude -p` em stream-json, o OpenCode pelo `opencode acp` e o Antigravity pelo `agy -p` em
//! stream-json (um processo por turno) e o Cursor pelo `cursor-agent -p`, também um processo por turno.
//!
//! - `store`: as tabelas (`chat_thread`, `chat_run`, `chat_item`, `chat_request`), só aditivas;
//! - `codex_map`: o item do Codex virando o `canal::timeline::Item` da timeline (puro);
//! - `codex`: o processo `app-server` de cada conversa (JSON por linha no stdio);
//! - `claude_map` e `claude`: o mesmo para o Claude Code (`claude -p`, stream-json no stdio);
//! - `opencode_map` e `opencode`: o mesmo para o OpenCode (Agent Client Protocol, JSON-RPC no stdio);
//! - `agy_map` e `agy`: o mesmo para o Antigravity (`agy --print --output-format stream-json`);
//! - `cursor_map` e `cursor`: o mesmo para o Cursor (`cursor-agent -p --output-format stream-json`);
//! - `turn`: abrir e fechar o turno no banco, comum aos motores mais novos;
//! - `attach`: os anexos das mensagens (conferir caminhos, miniaturas e imagens em linha do Claude);
//! - `handoff` e `troca`: trocar de agente na mesma conversa (resumo determinístico e a troca em si);
//! - `fork`: a pergunta lateral nascendo como cópia (fork nativo) da conversa de origem, ou o recorte como alternativa;
//! - `api`: o núcleo (criar, mandar, parar, responder, trocar), usado pela tela, pela CLI e pelo MCP;
//! - `commands`: os comandos Tauri;
//! - `worktree`: o worktree de uma conversa nova.

pub mod agy;
pub mod agy_map;
pub mod answer;
pub mod api;
pub mod attach;
pub mod claude;
pub mod claude_map;
pub mod codex;
pub mod codex_map;
pub mod codex_parar;
pub mod envio;
pub mod events;
pub mod fork;
pub mod handoff;
pub mod memoria;
pub mod commands;
pub mod cursor;
pub mod cursor_map;
pub mod opencode;
pub mod opencode_map;
pub mod permission;
pub mod pool;
pub mod resume;
pub mod send_receipt;
pub mod stop_receipt;
pub mod store;
pub mod tarefas;
pub mod troca;
pub mod turn;
pub mod worktree;
#[cfg(test)]
mod attach_test;
#[cfg(test)]
mod bancada;
#[cfg(test)]
mod fork_test;
#[cfg(test)]
mod handoff_test;
#[cfg(test)]
mod pool_test;
#[cfg(test)]
mod replay_protocolo;
#[cfg(test)]
mod troca_test;
#[cfg(test)]
mod tarefas_test;
#[cfg(test)]
mod send_receipt_test;
#[cfg(test)]
mod stop_receipt_test;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_bancada;
#[cfg(test)]
mod test_codex_parar;
#[cfg(test)]
mod test_parar_turno;
#[cfg(test)]
mod test_memoria;
#[cfg(test)]
mod test_motores;

pub use attach::*;
pub use troca::*;
pub use commands::*;
pub use store::migrate;
pub use worktree::*;
