//! El ciclo de vida de la aplicación: arranque, eventos y apagado.

mod housekeeping;
mod rendering;
mod run;
mod signals;
#[cfg(test)]
mod test;

pub use rendering::*;
pub use run::run;
