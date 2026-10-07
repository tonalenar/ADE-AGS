//! Control de versiones del panel derecho: el estado del repo y lo que se hace con él
//! (preparar, descartar, commitear, cambiar de rama, sincronizar).
//!
//! Igual que el explorador, todo sale de invocar `git`: el resultado es el que vería el
//! usuario en su terminal, con su configuración, sus hooks y sus credenciales.
//!
//! Las operaciones de red pasan por un único lugar (`git::network`), que recibe las
//! variables con las que git se autentica con la cuenta de la app (ver `forge`). Un remoto
//! sin cuenta sigue usando lo que git ya tenga configurado — credential helper, agente SSH.

mod commands;
mod git;
mod parse;
mod remote;
#[cfg(test)]
mod test;

pub use commands::*;
pub(crate) use commands::{create_tag, push_tag, sync, Sync};
pub(crate) use remote::{host_and_path, parse_remotes, provider_of, Provider};
pub(crate) use git::{network, network_with, ScmError};

use std::cell::Cell;
use std::time::Duration;

thread_local! {
    static LOCAL_LIMIT: Cell<Option<Duration>> = const { Cell::new(None) };
}

fn local_limit() -> Duration {
    LOCAL_LIMIT.with(|cell| cell.get()).unwrap_or(git::LOCAL)
}

/// Un git local, con el mismo entorno que el panel (sin terminal, con tiempo límite).
pub(crate) fn run_local(root: &str, args: &[&str]) -> Result<String, ScmError> {
    git::run_text(root, args, local_limit())
}

/// Lo mismo, devolviendo los bytes tal cual (archivos binarios).
pub(crate) fn run_bytes(root: &str, args: &[&str]) -> Result<Vec<u8>, ScmError> {
    git::run(root, args, local_limit())
}

/// Só o teste que estoura 20s com a suíte em paralelo. Um hang real ainda falha, só mais tarde.
#[cfg(test)]
pub(crate) fn with_longer_local_git<R>(limit: Duration, body: impl FnOnce() -> R) -> R {
    struct Restore(Option<Duration>);
    impl Drop for Restore {
        fn drop(&mut self) {
            LOCAL_LIMIT.with(|cell| cell.set(self.0.take()));
        }
    }
    let previous = LOCAL_LIMIT.with(|cell| cell.replace(Some(limit)));
    let _restore = Restore(previous);
    body()
}
