//! Contrato comum do harness de execução: o que cada provider e superfície promete (Fase 0) e a
//! identidade durável de turnos e filhos (Fase 1).
//!
//! O descritor (`capability`, `matrix`) só descreve; ainda não é lido pela UI, pelo IPC nem pelo MCP.
//! A Fase 1 grava `harness_run` e `harness_node` no primeiro filho de um turno e deriva o estado do
//! registro nativo. O desenho, a matriz explicada e o plano de adoção estão em
//! `docs/ade-ags/HARNESS_CONTRATO.md`. Não confundir com `runs::harness`, que é a projeção de leitura
//! da árvore de execução.
//!
//! A Fase 2 acrescenta `receipts` (recibos idempotentes de comando) e `effects` (fila de efeitos com
//! lease), contrato §11.

pub mod capability;
pub mod effects;
pub mod identity;
pub mod matrix;
pub mod receipts;
pub mod recovery;
pub mod state;
pub mod store;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_fase2;
