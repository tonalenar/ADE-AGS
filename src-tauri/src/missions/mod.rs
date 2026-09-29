//! Misiones: lo que el usuario quiere lograr, por encima de los intentos de lograrlo.
//!
//! Una misión no ejecuta nada por sí misma. Es dominio: el objetivo, la carpeta y la
//! preferencia de cómo correrlo. La ejecución sigue siendo de `runs/` —run, lead, workers,
//! scheduler, supervisor, worktrees—, y una misión solo apunta al run que la está
//! cumpliendo.
//!
//! ```text
//! Workspace → Mission → Run → Task → Agent
//! ```

pub(crate) mod store;
mod types;

pub use types::{Mission, MissionDetail, MissionInput, MissionSummary};
