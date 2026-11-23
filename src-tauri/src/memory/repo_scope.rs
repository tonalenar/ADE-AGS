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
use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::database::DbConnection;

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

/// A pasta da missão, sem ler o `.git`.
pub fn mission_cwd(conn: &Connection, mission_id: &str) -> Option<String> {
    conn.query_row("SELECT cwd FROM missions WHERE id = ?1", [mission_id], |r| r.get(0)).ok()
}

/// A chave do repositório de uma missão (pela pasta dela). Lê o `.git` com o `conn` já aberto.
#[cfg(test)]
pub fn mission_repo_key(conn: &Connection, mission_id: &str) -> Option<String> {
    repo_key(Path::new(&mission_cwd(conn, mission_id)?))
}

fn task_repo_cwd(conn: &Connection, task_id: &str) -> Result<String, String> {
    let task = crate::runs::store::task_by_id(conn, task_id)?
        .ok_or("caller Task is unavailable")?;
    let run = crate::runs::store::run_by_id(conn, &task.run_id)?
        .ok_or("caller Run is unavailable")?;
    Ok(run.mission_id
        .as_deref()
        .and_then(|mission| mission_cwd(conn, mission))
        .unwrap_or(task.cwd))
}

/// Resolve a tarefa quando o chamador já tem a conexão aberta.
#[cfg(test)]
pub fn task_repo_key(conn: &Connection, task_id: &str) -> Result<Option<String>, String> {
    Ok(repo_key(Path::new(&task_repo_cwd(conn, task_id)?)))
}

/// Lê Task/Run/Mission sob o mutex e o `.git` depois de soltá-lo.
pub fn task_repo_key_unlocked(
    db: &DbConnection,
    task_id: &str,
) -> Result<Option<String>, String> {
    let cwd = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        task_repo_cwd(&conn, task_id)?
    };
    Ok(repo_key(Path::new(&cwd)))
}

#[derive(Default)]
pub struct TaskHistoryScope {
    pub repo_key: Option<String>,
    pub run_ids: HashSet<String>,
    pub mission_ids: HashSet<String>,
}

/// Reúne os IDs de evidência do próprio repositório; só consulta o filesystem depois de soltar o lock.
pub fn task_history_scope_unlocked(
    db: &DbConnection,
    task_id: &str,
) -> Result<TaskHistoryScope, String> {
    let (task_cwd, runs, missions) = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        let cwd = task_repo_cwd(&conn, task_id)?;
        let workspace: String = conn.query_row(
            "SELECT r.workspace_id FROM tasks t JOIN runs r ON r.id=t.run_id WHERE t.id=?1",
            [task_id],
            |row| row.get(0),
        ).map_err(|_| "caller Task is unavailable".to_string())?;
        let runs = {
            let mut statement = conn.prepare(
                "SELECT r.id,COALESCE(m.cwd,r.cwd) FROM runs r LEFT JOIN missions m ON m.id=r.mission_id WHERE r.workspace_id=?1 ORDER BY r.created_at DESC,r.id LIMIT 128",
            ).map_err(|e| e.to_string())?;
            statement.query_map([&workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        };
        let missions = {
            let mut statement = conn.prepare(
                "SELECT id,cwd FROM missions WHERE workspace_id=?1 ORDER BY created_at DESC,id LIMIT 128",
            ).map_err(|e| e.to_string())?;
            statement.query_map([&workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        };
        (cwd, runs, missions)
    };
    let target = repo_key(Path::new(&task_cwd));
    let matches = |candidate: Option<&str>| match target.as_deref() {
        Some(key) => candidate.is_none_or(|value| value == key),
        None => candidate.is_none(),
    };
    let run_ids = runs.into_iter().filter_map(|(id, cwd)| {
        matches(repo_key(Path::new(&cwd)).as_deref()).then_some(id)
    }).collect();
    let mission_ids = missions.into_iter().filter_map(|(id, cwd)| {
        matches(repo_key(Path::new(&cwd)).as_deref()).then_some(id)
    }).collect();
    Ok(TaskHistoryScope { repo_key: target, run_ids, mission_ids })
}

/// Predicado SQL: falha fechada só com missão sem chave.
pub fn sql_match(placeholder: &str, fail_closed: bool) -> String {
    if fail_closed {
        format!("(e.repo_key IS NULL OR e.repo_key={placeholder})")
    } else {
        format!("({placeholder} IS NULL OR e.repo_key IS NULL OR e.repo_key={placeholder})")
    }
}

pub fn sql_match_bare(placeholder: &str, fail_closed: bool) -> String {
    if fail_closed {
        format!("(repo_key IS NULL OR repo_key={placeholder})")
    } else {
        format!("({placeholder} IS NULL OR repo_key IS NULL OR repo_key={placeholder})")
    }
}

/// Lê o `cwd` sob o mutex e o `.git/config` com o lock solto.
pub fn mission_repo_key_unlocked(db: &DbConnection, mission_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = mission_id else {
        return Ok(None);
    };
    let cwd = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        mission_cwd(&conn, id)
    };
    Ok(cwd.as_deref().and_then(|c| repo_key(Path::new(c))))
}

/// Resolve as chaves das missões do workspace sem manter o mutex durante a leitura do `.git`.
pub fn mission_repo_keys_unlocked(
    db: &DbConnection,
    workspace_id: &str,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let missions = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        let mut stmt = conn
            .prepare("SELECT id,cwd FROM missions WHERE workspace_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
        rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?
    };
    Ok(missions
        .into_iter()
        .map(|(id, cwd)| (id, repo_key(Path::new(&cwd))))
        .collect())
}

/// Lê o `cwd` da aba sob o mutex e o `.git/config` com o lock solto.
pub fn tab_repo_key_unlocked(db: &DbConnection, tab_id: &str) -> Result<Option<String>, String> {
    let cwd: Option<String> = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        conn.query_row("SELECT cwd FROM tabs WHERE id = ?1", [tab_id], |r| r.get(0))
            .ok()
    };
    Ok(cwd.as_deref().and_then(|c| repo_key(Path::new(c))))
}

/// Reúne os IDs de evidência do repositório de `cwd` no workspace; só consulta o filesystem após soltar o lock.
pub fn workspace_history_scope_unlocked(
    db: &DbConnection,
    workspace: &str,
    cwd: &str,
) -> Result<TaskHistoryScope, String> {
    let (runs, missions) = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        let runs = {
            let mut statement = conn.prepare(
                "SELECT r.id,COALESCE(m.cwd,r.cwd) FROM runs r LEFT JOIN missions m ON m.id=r.mission_id WHERE r.workspace_id=?1 ORDER BY r.created_at DESC,r.id LIMIT 128",
            ).map_err(|e| e.to_string())?;
            statement.query_map([workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        };
        let missions = {
            let mut statement = conn.prepare(
                "SELECT id,cwd FROM missions WHERE workspace_id=?1 ORDER BY created_at DESC,id LIMIT 128",
            ).map_err(|e| e.to_string())?;
            statement.query_map([workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        };
        (runs, missions)
    };
    let target = repo_key(Path::new(cwd));
    let matches = |candidate: Option<&str>| match target.as_deref() {
        Some(key) => candidate.is_none_or(|value| value == key),
        None => candidate.is_none(),
    };
    let run_ids = runs.into_iter().filter_map(|(id, run_cwd)| {
        matches(repo_key(Path::new(&run_cwd)).as_deref()).then_some(id)
    }).collect();
    let mission_ids = missions.into_iter().filter_map(|(id, mission_cwd)| {
        matches(repo_key(Path::new(&mission_cwd)).as_deref()).then_some(id)
    }).collect();
    Ok(TaskHistoryScope { repo_key: target, run_ids, mission_ids })
}

/// Marca uma memória recém-criada com o repositório dela (sem alterar entradas já existentes com revisões anteriores).
pub fn tag_new_entry_repo(
    conn: &Connection,
    entry_id: &str,
    key: Option<&str>,
) -> Result<(), String> {
    let Some(key) = key else { return Ok(()) };
    conn.execute(
        "UPDATE memory_entries SET repo_key = ?1 WHERE id = ?2 AND repo_key IS NULL
            AND (SELECT COUNT(*) FROM memory_revisions r WHERE r.entry_id = memory_entries.id) <= 1",
        params![key, entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marca uma memória recém-criada por uma missão com o repositório dela. Correção de uma memória
/// existente não muda a chave (uma memória sem chave, de antes, continua valendo em todos).
pub fn tag_new_entry(
    conn: &Connection,
    entry_id: &str,
    mission_id: &str,
    key: Option<&str>,
) -> Result<(), String> {
    // A origem: o dream cita a missão como fonte (antes as revisões de missão não tinham nenhuma e o
    // dream terminava com «falta de evidência citável»).
    conn.execute("UPDATE memory_entries SET source_mission = ?1 WHERE id = ?2 AND source_mission IS NULL", params![mission_id, entry_id])
        .map_err(|e| e.to_string())?;
    tag_new_entry_repo(conn, entry_id, key)
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
