//! Fase 8 — La app expuesta a la CLI `ags`.
//!
//! - [`server`] — el socket que escucha y despacha.
//! - [`protocol`] — el formato del mensaje y el handshake, compartido con la CLI.
//! - [`commands`] — un handler por comando.
//! - [`bridge`] — el puente al frontend, para lo que solo él sabe.
//! - [`install`] — instalar/desinstalar el binario `ags` en el PATH del usuario.
//! - [`mcp`] — el servidor MCP que les da a los agentes sus herramientas.
//! - [`cancel`] — las llamadas de ese servidor que el agente canceló.
//! - [`spill`] — respostas grandes da CLI e do MCP vão para `~/.ags/spill/` (cabeça, cauda e caminho).

pub mod bridge;
pub mod cancel;
pub(crate) mod guard;
pub(crate) mod commands;
pub mod install;
mod intake;
pub mod mcp;
pub mod protocol;
mod server;
pub mod spill;
mod transport;
#[cfg(test)]
mod test;

pub use commands::routine::start_scheduler as start_routine_scheduler;
pub use commands::chat_watch::start as start_chat_watch;
pub use commands::peer_queue::start_resume as start_peer_queue;
pub use commands::canal::start as start_canal;

/// Compactar e restaurar apagam ou recuperam dados. Só a interface (comando Tauri)
/// pode executá-los. Um terminal de agente, mesmo com o token IPC, não.
pub const AGENT_MAINTENANCE_DENIED: &str = "Este comando altera dados de forma irreversível e só pode ser executado pelo usuário na interface do ADE AGS.";

pub fn agent_maintenance_error(command: &str) -> Option<&'static str> {
    matches!(command, "memory.compact" | "workspace.restore").then_some(AGENT_MAINTENANCE_DENIED)
}
/// F-01: decidir (ou listar) os pedidos de permissão da Frota é só da pessoa, na tela.
///
/// O servidor **não consegue provar** que quem chama o IPC não é um agente: o token está num
/// arquivo legível pelo mesmo usuário, o PID do par só prova o que É descendente de um
/// PTY/conversa da ADE (um `setsid`, duplo fork ou `open -a Terminal` sai da árvore), o TCP
/// não traz PID e `ADE_TAB_ID`/`taskId` são declarados pelo chamador. Na dúvida, recusa
/// sempre, para qualquer chamador, como `AGENT_MAINTENANCE_DENIED`. A tela decide por um comando
/// Tauri próprio, que não passa pelo IPC.
pub const APPROVAL_SCREEN_ONLY: &str = "Decidir ou listar pedidos de permissão da Frota é só da pessoa, pela tela da ADE AGS (painel de aprovações). O IPC não consegue provar que quem chama não é um agente, então recusa sempre. Para CI sem tela, escreva regras de permissão da pasta antes.";

pub fn person_only_error(command: &str) -> Option<&'static str> {
    matches!(command, "approval.decide" | "approval.list").then_some(APPROVAL_SCREEN_ONLY)
}
pub use server::{cleanup, export_instance_env, other_instance_alive, start};
pub use transport::{exchange, ExchangeError};
pub(crate) use transport::current_client_pid;
#[cfg(test)]
pub(crate) use transport::with_client_pid;
