//! A «consciência» do orquestrador: a carga da máquina, o limite de agentes simultâneos, a sobreposição de áreas e a
//! fila de tarefas com condição. Tudo aqui é puro ou SQL sobre `&Connection`; a cola com o app (lançar, avisar,
//! comandos) fica em `ipc/commands/consciencia.rs`.

pub mod gate;
pub mod load;
pub mod overlap;
pub mod queue;
#[cfg(test)]
mod test;
