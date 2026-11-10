//! O worktree de uma conversa nova ("Novo worktree" na faixa do composer), feito pelo mesmo `runs::worktrees` da frota.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::database::DbConnection;

/// Onde ficam os worktrees das conversas, dentro da pasta de dados do app (`ADE_AGS_DATA_DIR`).
const DIR: &str = "chat-worktrees";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorktree {
    /// Onde o agente da conversa roda: a mesma subpasta do repo, dentro do worktree.
    pub cwd: String,
    pub branch: String,
    /// Se a inicialização de submódulos foi ignorada, concluída ou falhou.
    pub submodules: String,
}

/// Um worktree novo para uma conversa, partindo do último commit (o que não foi commitado na pasta
/// não vai junto — como na frota). A branch é `cc/<título>-<id>`.
#[tauri::command]
pub async fn chat_new_worktree(db: State<'_, DbConnection>, cwd: String, title: String, agent_id: String, submodules: String) -> Result<NewWorktree, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(submodules.as_str(), "none" | "top-level" | "recursive") {
            return Err("opção de submódulos inválida".to_string());
        }
        {
            let conn = db.lock().map_err(|error| error.to_string())?;
            crate::project_chat_policy::ensure_agent_enabled(&conn, &cwd, &agent_id)?;
        }
        let home = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
        let base = home.join(DIR);
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let wt = crate::runs::worktrees::create_from(&base, Path::new(&cwd), &title, "HEAD")?;
        crate::project_chat_policy::register_worktree_alias(&db, &wt.task_cwd.to_string_lossy(), &cwd)?;
        let submodule_status = match submodules.as_str() {
            "none" => "none",
            mode => {
                // `.gitmodules` é dado do repositório: nega helpers/protocolos personalizados e libera só transportes comuns.
                let mut args = vec![
                    "-c", "protocol.allow=never",
                    "-c", "protocol.http.allow=always",
                    "-c", "protocol.https.allow=always",
                    "-c", "protocol.ssh.allow=always",
                    "-c", "protocol.git.allow=always",
                    "-c", "protocol.file.allow=never",
                    "-c", "protocol.ext.allow=never",
                    "-c", "submodule.recurse=false",
                    "-c", "fetch.recurseSubmodules=false",
                    "submodule", "update", "--init",
                ];
                if mode == "recursive" {
                    args.push("--recursive");
                }
                if crate::runs::worktrees::git(&wt.root, &args, Duration::from_secs(120)).is_ok() {
                    "initialized"
                } else {
                    // A mensagem do Git pode conter URLs privadas do .gitmodules; só devolve um status genérico.
                    "failed"
                }
            }
        };
        Ok(NewWorktree {
            cwd: wt.task_cwd.to_string_lossy().into_owned(),
            branch: wt.branch,
            submodules: submodule_status.to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
