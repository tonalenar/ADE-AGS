//! De que repositório é uma memória.
//!
//! O workspace do app é a janela do usuário, não o projeto: no banco real havia UM workspace
//! (`default`) com missões no ADE-AGS, num clone de revisão dele, num repo Node (CredPro) e em pastas
//! temporárias. A memória de workspace era a mesma para todos, e a missão do repo Node recebia regras
//! de cargo e de Tauri. Agora cada memória pode levar a chave do repositório (`repo_key`): uma missão
//! só enxerga as do próprio repositório e as sem chave (que valem em todos).
//!
//! A chave é o `remote.origin.url` normalizado (dois clones do mesmo projeto são o mesmo repositório)
//! ou, sem remoto, a raiz do repositório. Lida dos arquivos do `.git`, sem rodar o git: é chamada a
//! cada briefing e na migração.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

/// O `.git` comum do repositório que contém `cwd` (o de um worktree aponta para o principal).
fn common_git_dir(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    while let Some(current) = dir {
        let dot_git = current.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if dot_git.is_file() {
            let raw = std::fs::read_to_string(&dot_git).ok()?;
            let gitdir = raw.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            let gitdir = if Path::new(gitdir).is_absolute() { PathBuf::from(gitdir) } else { current.join(gitdir) };
            return Some(match std::fs::read_to_string(gitdir.join("commondir")) {
                Ok(common) => {
                    let common = common.trim();
                    if Path::new(common).is_absolute() { PathBuf::from(common) } else { gitdir.join(common) }
                }
                Err(_) => gitdir,
            });
        }
        dir = current.parent();
    }
    None
}

/// A URL do `origin` num `config` do git. Pura.
pub fn origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line.replace(' ', "") == "[remote\"origin\"]";
            continue;
        }
        if in_origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

/// `https://github.com/A/B.git`, `git@github.com:A/B` e `ssh://git@github.com/A/B` viram
/// `github.com/a/b`; um caminho local vira o caminho com `/` e em minúsculas. Pura.
pub fn normalize_url(url: &str) -> String {
    let mut s = url.trim().replace('\\', "/");
    for prefix in ["https://", "http://", "ssh://", "git://", "file://"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
        }
    }
    if let Some((user, rest)) = s.split_once('@') {
        if !user.contains('/') {
            s = rest.to_string();
        }
    }
    // `github.com:A/B` (scp) → `github.com/A/B`; um drive do Windows (`c:/x`) fica como está.
    if let Some((host, rest)) = s.split_once(':') {
        if host.len() > 1 && !host.contains('/') && !rest.starts_with('/') {
            s = format!("{host}/{rest}");
        }
    }
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    s.to_lowercase()
}

/// A chave do repositório de `cwd`, ou `None` fora de um repositório git.
pub fn repo_key(cwd: &Path) -> Option<String> {
    let common = common_git_dir(cwd)?;
    if let Some(url) = std::fs::read_to_string(common.join("config")).ok().as_deref().and_then(origin_url) {
        return Some(normalize_url(&url));
    }
    let root = common.parent().unwrap_or(&common);
    Some(normalize_url(&root.to_string_lossy()))
}

/// A chave do repositório de uma missão (pela pasta dela).
pub fn mission_repo_key(conn: &Connection, mission_id: &str) -> Option<String> {
    let cwd: String = conn.query_row("SELECT cwd FROM missions WHERE id = ?1", [mission_id], |r| r.get(0)).ok()?;
    repo_key(Path::new(&cwd))
}

/// Marca uma memória recém-criada por uma missão com o repositório dela. Correção de uma memória
/// existente não muda a chave (uma memória sem chave, de antes, continua valendo em todos).
pub fn tag_new_entry(conn: &Connection, entry_id: &str, mission_id: &str) -> Result<(), String> {
    let Some(key) = mission_repo_key(conn, mission_id) else { return Ok(()) };
    conn.execute(
        "UPDATE memory_entries SET repo_key = ?1 WHERE id = ?2 AND repo_key IS NULL
            AND (SELECT COUNT(*) FROM memory_revisions r WHERE r.entry_id = memory_entries.id) <= 1",
        params![key, entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// O repositório dominante entre as missões de um workspace: o que tem pelo menos `share` das missões
/// cuja pasta ainda resolve. Pura sobre a lista de chaves.
pub fn dominant(keys: &[String], share: f64) -> Option<String> {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for key in keys {
        *counts.entry(key.as_str()).or_default() += 1;
    }
    let (key, n) = counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)))?;
    (n as f64 >= share * keys.len() as f64).then(|| key.to_string())
}

/// Uma vez, quando a coluna nasce: as memórias de missão ganham o repositório da missão, e as de
/// workspace o repositório dominante do workspace (≥ 80% das missões). Workspace misturado demais fica
/// sem chave (vale em todos, como antes) e o usuário decide depois.
pub fn backfill(conn: &Connection) -> Result<(), String> {
    let missions: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare("SELECT id, workspace_id, cwd FROM missions").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let mut by_workspace: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (id, workspace, cwd) in &missions {
        let Some(key) = repo_key(Path::new(cwd)) else { continue };
        conn.execute("UPDATE memory_entries SET repo_key = ?1 WHERE scope = 'mission' AND mission_id = ?2 AND repo_key IS NULL", params![key, id])
            .map_err(|e| e.to_string())?;
        by_workspace.entry(workspace.clone()).or_default().push(key);
    }
    for (workspace, keys) in by_workspace {
        if let Some(key) = dominant(&keys, 0.8) {
            conn.execute(
                "UPDATE memory_entries SET repo_key = ?1 WHERE scope = 'workspace' AND workspace_id = ?2 AND repo_key IS NULL",
                params![key, workspace],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_do_mesmo_projeto_tem_a_mesma_chave() {
        let a = normalize_url("https://github.com/tonalenar/ADE-AGS.git");
        assert_eq!(a, "github.com/tonalenar/ade-ags");
        assert_eq!(normalize_url("git@github.com:tonalenar/ADE-AGS"), a);
        assert_eq!(normalize_url("ssh://git@github.com/tonalenar/ADE-AGS.git/"), a);
        assert_eq!(normalize_url("C:/Users/x/.ags/site-api-origin.git"), "c:/users/x/.ags/site-api-origin");
        assert_eq!(normalize_url("C:\\Users\\x\\repo"), "c:/users/x/repo");
    }

    #[test]
    fn le_o_origin_do_config() {
        let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://x/y\n[remote \"origin\"]\n\turl = git@github.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
        assert_eq!(origin_url(config).as_deref(), Some("git@github.com:a/b.git"));
        assert_eq!(origin_url("[core]\n"), None);
    }

    #[test]
    fn o_dominante_precisa_da_maioria_clara() {
        let keys = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(dominant(&keys(&["a", "a", "a", "a", "b"]), 0.8).as_deref(), Some("a"));
        assert_eq!(dominant(&keys(&["a", "a", "b", "c"]), 0.8), None);
        assert_eq!(dominant(&[], 0.8), None);
    }

    #[test]
    fn worktree_e_subpasta_dao_a_chave_do_repositorio_principal() {
        let root = std::env::temp_dir().join(format!("ags-repo-key-{}", uuid::Uuid::new_v4().simple()));
        let git = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a"), "1").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "a"]);
        git(&repo, &["remote", "add", "origin", "https://github.com/A/B.git"]);
        git(&repo, &["worktree", "add", "-q", root.join("wt").to_str().unwrap()]);
        assert_eq!(repo_key(&repo).as_deref(), Some("github.com/a/b"));
        assert_eq!(repo_key(&repo.join("sub")).as_deref(), Some("github.com/a/b"));
        assert_eq!(repo_key(&root.join("wt")).as_deref(), Some("github.com/a/b"), "o worktree aponta para o principal");
        let _ = std::fs::remove_dir_all(&root);
    }
}
