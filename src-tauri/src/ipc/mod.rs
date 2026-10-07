//! Fase 8 — La app expuesta a la CLI `ags`.
//!
//! - [`server`] — el socket que escucha y despacha.
//! - [`protocol`] — el formato del mensaje y el handshake, compartido con la CLI.
//! - [`commands`] — un handler por comando.
//! - [`bridge`] — el puente al frontend, para lo que solo él sabe.
//! - [`install`] — instalar/desinstalar el binario `ags` en el PATH del usuario.
//! - [`mcp`] — el servidor MCP que les da a los agentes sus herramientas.
//! - [`cancel`] — las llamadas de ese servidor que el agente canceló.

pub mod bridge;
pub mod cancel;
pub(crate) mod commands;
pub mod install;
pub mod mcp;
pub mod protocol;
mod server;
#[cfg(test)]
mod test;

pub use commands::routine::start_scheduler as start_routine_scheduler;

/// Compactar e restaurar apagam ou recuperam dados. Só a interface (comando Tauri)
/// pode executá-los. Um terminal de agente, mesmo com o token IPC, não.
pub const AGENT_MAINTENANCE_DENIED: &str = "Este comando altera dados de forma irreversível e só pode ser executado pelo usuário na interface do ADE AGS.";

pub fn agent_maintenance_error(command: &str) -> Option<&'static str> {
    matches!(command, "memory.compact" | "workspace.restore").then_some(AGENT_MAINTENANCE_DENIED)
}
pub use server::{cleanup, export_instance_env, other_instance_alive, start};
