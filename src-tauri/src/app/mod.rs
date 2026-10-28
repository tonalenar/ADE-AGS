//! El ciclo de vida de la aplicación: arranque, eventos y apagado.

mod disk_hygiene;
mod fatal;
mod housekeeping;
mod rendering;
mod run;
mod shutdown;
mod signals;
#[cfg(test)]
mod test;

pub use rendering::*;
pub use run::run;
pub(crate) use shutdown::shutdown_once;
