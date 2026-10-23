//! "Comparar modelos": o mesmo pedido para vários agentes/modelos, cada um num worktree e numa
//! branch próprios (`cmp/<slug>-<id>/<pick>`). O registro fica em `<ags_home>/comparisons.json`;
//! os worktrees, na mesma pasta dos das missões. Ver `docs/ade-ags/COMPARAR_MODELOS.md`.
mod commands;
mod git;
mod model;

pub use commands::*;

#[cfg(test)]
mod test;
