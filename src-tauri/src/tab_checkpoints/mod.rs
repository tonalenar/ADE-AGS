//! Pontos de restauração das abas interativas: uma foto dos arquivos da pasta da aba a cada
//! mensagem que chega ao agente, para poder ver o que mudou desde ali e voltar os arquivos.
//!
//! - **Quando**: antes de cada mensagem que o app escreve na aba (`submit_prompt_seen`), a cada Enter
//!   que a tela vê no terminal de um agente, e no "Marcar ponto". Sem mudança desde o último ponto,
//!   não cria outro.
//! - **Onde**: um commit feito com índice temporário, pai = `HEAD`, na ref escondida
//!   `refs/ags/checkpoints/<aba>/<n>`; a ficha (quando, primeira linha, quem mandou) em
//!   `tab_checkpoints`. A branch, o índice e o stash da pessoa não mudam.
//! - **Voltar**: confirma, recusa se outra aba ou tarefa usa a mesma pasta (a não ser que a pessoa
//!   force), tira uma foto de segurança e reescreve só os arquivos que diferem. A conversa do
//!   agente não volta.
//! - **Limpeza**: 50 por aba; os da aba fechada de vez saem (ficha e ref).
//!
//! Detalhes em `docs/ade-ags/CHECKPOINTS_ABAS.md`.

mod commands;
pub(crate) mod git;
pub(crate) mod lock;
pub(crate) mod service;
pub(crate) mod store;

pub use commands::*;
pub use store::migrate;

#[cfg(test)]
mod test;
