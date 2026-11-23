//! Sincronização opcional de páginas com repositório privado no forge (GitHub/GitLab/Gitea).
//!
//! - Nasce desligada por padrão.
//! - Confirma pela API do forge que o repositório é privado antes de cada pull/push.
//! - Importa páginas novas; divergências ficam para escolha explícita do usuário.
//! - Filtra segredos (`looks_like_user_secret`) antes de gravar no espelho e lista páginas puladas.
//! - Mantém um espelho git próprio sob `<app_data_dir>/memory-sync/repo`, sem tocar no repositório
//!   local de projeção (`~/.ags/memory/ws-<hash>/`).
//! - Entrega o token ao git apenas por `GIT_ASKPASS` efêmero em loopback, sem gravar em argv, env,
//!   URL, arquivo ou log.

mod commands;
mod credentials;
mod export;
mod repo;
mod restore;
#[cfg(test)]
mod test;

pub use commands::*;
pub use credentials::askpass_entry;
