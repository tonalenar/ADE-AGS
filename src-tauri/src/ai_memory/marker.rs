//! Par explícito do marcador oficial; não lê config, credenciais ou a base do ai-memory.
use std::{io::Read, path::Path};

/// Resultado da resolução do marcador `.ai-memory.toml`: um par seguro, um projeto
/// reservado explicitamente bloqueado, ou nenhum marcador utilizável.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Scope {
    Pair(String, String),
    Reserved,
    Missing,
}

/// Mesma fronteira de docs/marker-file.md v3.3.0. Um marcador parcial governa a busca,
/// mas não fornece par seguro: nesse caso o chamador pode usar seu fallback único.
#[cfg(test)]
pub(super) fn scope(cwd: &Path, home: Option<&Path>) -> Option<(String, String)> {
    match resolve(cwd, home) {
        Scope::Pair(workspace, project) => Some((workspace, project)),
        Scope::Reserved | Scope::Missing => None,
    }
}

pub(super) fn resolve(cwd: &Path, home: Option<&Path>) -> Scope {
    let Ok(start) = std::fs::canonicalize(cwd) else {
        return Scope::Missing;
    };
    let home = home.map(|h| std::fs::canonicalize(h).unwrap_or_else(|_| h.to_path_buf()));
    let boundary = match home {
        Some(home) if start.starts_with(&home) => home,
        Some(_) => start
            .ancestors()
            .find(|dir| dir.join(".git").is_file() || dir.join(".git").is_dir())
            .unwrap_or(&start)
            .to_path_buf(),
        None => {
            let Some(root) = start.ancestors().last() else {
                return Scope::Missing;
            };
            root.to_path_buf()
        }
    };
    for dir in start
        .ancestors()
        .take_while(|dir| dir.starts_with(&boundary))
    {
        if let Some(document) = read(&dir.join(".ai-memory.toml")) {
            // Capture-only é transparente; outros settings reconhecidos formam uma fronteira.
            if [
                "workspace",
                "project",
                "project_strategy",
                "identity",
                "identity_style",
                "aliases",
                "drop_subagent_captures",
                "recall",
                "briefing",
                "handoff",
                "profile",
                "server",
            ]
            .iter()
            .any(|key| document.contains_key(key))
            {
                let (Some(workspace), Some(project)) =
                    (document.get("workspace"), document.get("project"))
                else {
                    return Scope::Missing;
                };
                let (Some(workspace), Some(project)) = (workspace.as_str(), project.as_str())
                else {
                    continue;
                };
                let (workspace, project) = (workspace.to_owned(), project.to_owned());
                if super::scoped_bridge::reserved_project(&project) {
                    return Scope::Reserved;
                }
                if super::sessions::validate_scope(&workspace, &project).is_err() {
                    continue;
                }
                return Scope::Pair(workspace, project);
            }
        }
        if dir == boundary {
            break;
        }
    }
    Scope::Missing
}
fn read(path: &Path) -> Option<toml_edit::DocumentMut> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    std::str::from_utf8(&bytes)
        .ok()?
        .trim_start_matches('\u{feff}')
        .parse()
        .ok()
}

#[cfg(test)]
mod test;
