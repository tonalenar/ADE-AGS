//! Piezas chicas que no son de ningún dominio en particular.

pub mod external_path;
pub mod launch;
pub mod legacy;
pub mod path_env;
mod proc;
pub mod spawn;
mod time;
pub mod win_quote;
#[cfg(test)]
mod spawn_lint;
#[cfg(test)]
mod test;

pub use external_path::external_path;
pub use launch::external_command;
pub use path_env::{find_program, program};
pub use proc::output_with_timeout;
pub use time::{now_ts, now_ts_ms};
