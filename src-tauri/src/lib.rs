//! ADE AGS — el backend de la app.
//!
//! Cada módulo cubre un dominio; `app` es el que los ensambla y arranca Tauri.

pub mod ai_memory;
mod agent_secrets;
mod accounts;
mod agents;
mod approval_audit;
mod canal;
mod canvas;
mod chat;
mod chat_team;
mod compare;
mod conversa;
pub mod computer_use;
mod app;
#[cfg(test)]
mod bench;
mod bus;
mod database;
mod decisions;
mod design;
pub mod desktop_apps;
pub mod build_info;
#[cfg_attr(not(test), allow(dead_code))]
mod build_fingerprint;
mod explorer;
mod floors;
mod floors_land;
mod forge;
mod graphify;
pub mod ipc;
mod surfaces;
mod marketplace;
mod memory;
pub mod missions;
mod notifier;
mod orchestrator;
mod peer_queue;
mod android;
mod pet;
mod project_scripts;
mod local_acp;
mod prompt_stashes;
mod project_chat_policy;
mod prelaunch;
mod privacy_settings;
mod preview;
mod real_browser;
mod roles;
mod simulator;
pub(crate) mod iphone;
mod sim_host;
mod routines;
pub(crate) mod scheduled_tasks;
mod runs;
mod scm;
mod session;
mod skills;
mod squads;
mod sync;
mod tab_checkpoints;
mod terminal;
mod screen_recording;
mod voice_input;
#[cfg_attr(not(test), allow(dead_code, reason = "contrato da Fase 0 do harness: ainda não ligado à UI, ao IPC nem ao MCP"))]
mod harness;
pub mod testspeed;
pub use terminal::SESSION_ENV;
mod updates;
mod usage;
pub mod util;
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
