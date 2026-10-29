//! O que o modo chat pede ao backend e não cabe em outro módulo. Hoje: o worktree de uma conversa
//! nova ("Novo worktree" na faixa do composer), feito pelo mesmo `runs::worktrees` da frota.

use std::path::Path;

use serde::Serialize;

/// Onde ficam os worktrees das conversas, dentro da pasta de dados do app (`ADE_AGS_DATA_DIR`).
const DIR: &str = "chat-worktrees";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    /// Onde o agente da conversa roda: a mesma subpasta do repo, dentro do worktree.
    pub cwd: String,
    pub branch: String,
}

/// Um worktree novo para uma conversa, partindo do último commit (o que não foi commitado na pasta
/// não vai junto — como na frota). A branch é `cc/<título>-<id>`.
#[tauri::command]
pub async fn chat_new_worktree(cwd: String, title: String) -> Result<NewWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
        let base = home.join(DIR);
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let wt = crate::runs::worktrees::create_from(&base, Path::new(&cwd), &title, "HEAD")?;
        Ok(NewWorktree { cwd: wt.task_cwd.to_string_lossy().into_owned(), branch: wt.branch })
    })
    .await
    .map_err(|e| e.to_string())?
}
