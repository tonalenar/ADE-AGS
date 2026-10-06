//! ADE AGS — el backend de la app.
//!
//! Cada módulo cubre un dominio; `app` es el que los ensambla y arranca Tauri.

mod accounts;
mod agents;
mod canvas;
mod chat;
mod app;
mod bus;
mod database;
mod explorer;
mod floors;
mod forge;
mod graphify;
pub mod ipc;
mod marketplace;
mod memory;
pub mod missions;
mod notifier;
mod orchestrator;
mod android;
mod pet;
mod prelaunch;
mod preview;
mod roles;
mod routines;
mod runs;
mod scm;
mod session;
mod skills;
mod squads;
mod sync;
mod terminal;
mod updates;
mod usage;
mod util;
mod window;

pub use app::run;
pub use database::migrate;

// Sin este manifiesto el harness de `cargo test` no arranca en Windows:
// importa TaskDialogIndirect y el loader, sin Common Controls 6, cae en
// comctl32 v5 (STATUS_ENTRYPOINT_NOT_FOUND). La app ya lo trae por tauri-build.
#[cfg(all(windows, test))]
#[link(
    name = "ade_test_manifest",
    kind = "static",
    modifiers = "+whole-archive"
)]
unsafe extern "C" {}
