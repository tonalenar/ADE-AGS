//! Contrato comum do harness de execução (Fase 0): o que cada provider e superfície promete.
//!
//! Este módulo só descreve; não muda comportamento. O descritor ainda não é lido pela UI, pelo IPC
//! nem pelo MCP. O desenho, a matriz explicada e o plano de adoção estão em
//! `docs/ade-ags/HARNESS_CONTRATO.md`. Não confundir com `runs::harness`, que é a projeção de leitura
//! da árvore de execução.

pub mod capability;
pub mod matrix;

#[cfg(test)]
mod test;

pub use capability::{Capability, Claim, Proof, Scope, Support, Surface};
pub use matrix::{find, matrix};
