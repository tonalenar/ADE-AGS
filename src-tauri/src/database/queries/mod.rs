//! Todo el SQL de la app, agrupado por lo que consulta.
//!
//! La conexión y el schema viven un nivel más arriba (`database::connection`,
//! `database::schema`); acá solo hay lecturas y escrituras sobre tablas ya creadas.

mod conversations;
mod sessions;
mod session_search;
mod snapshots;
mod settings;
mod windows;
mod workspaces;

pub use conversations::*;
pub use sessions::*;
pub use session_search::*;
pub(crate) use session_search::{forget_archived_message_index, invalidate_archived_message_index};
pub use snapshots::*;
pub use settings::*;
pub use windows::*;
pub use workspaces::*;
