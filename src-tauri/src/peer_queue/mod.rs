//! A fila persistente das mensagens entre agentes (`peer tell`, `peer ask` enfileirado e
//! `peer deliver`): cada mensagem ganha um id e um registro no SQLite com o seu estado.
//!
//! Antes a fila era uma thread por mensagem, só em memória: invisível para o usuário,
//! perdida num reinício do app, e o dedupe era só por texto. Agora:
//! - a entrega sobrevive ao reinício (`store::resume`);
//! - quem chama pode mandar um id próprio (`--id`) e o mesmo id nunca é digitado duas vezes;
//! - o usuário vê, edita, reordena, cancela ou manda já o que está esperando.
//!
//! Aqui fica só o estado (SQL puro sobre `&Connection`). Quem digita no terminal é
//! `ipc/commands/peer_queue.rs`.

pub mod store;
#[cfg(test)]
mod test;

pub use store::migrate;
