//! Los comandos que atiende el servidor IPC, uno por dominio.

mod agents;
mod app;
mod ask;
mod notes;
mod notify;
mod floor;
pub mod chat;
pub mod chat_watch;
pub mod conversas;
pub(crate) mod peers;
pub mod peer_queue;
pub mod routine;
mod role;
mod portals;
mod replay;
pub mod devices;
mod sim_act;
pub mod simulators;
pub mod pool;
mod browser;
pub mod canal;
mod dispatch;
mod events;
mod missions;
mod shared;
mod runs;
mod skills;
mod tabs;
// O time de agentes do modo chat (`ags team …`) e a entrega às conversas por protocolo.
mod team;
mod watch;
mod windows;
mod workspaces;

pub use dispatch::dispatch;

#[cfg(test)]
pub(crate) use agents::{match_account_id, match_preset_id};
#[cfg(test)]
pub(crate) use tabs::{init_prompt, match_skill_ids, skill_names, InstalledSkill};

#[cfg(test)]
mod replay_test;
