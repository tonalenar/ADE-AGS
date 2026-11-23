use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::ai_memory::client::{Client, PageWrite};
use crate::memory::agent::looks_like_user_secret;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConflict {
    pub path: String,
    pub title: String,
    pub local_body: String,
    pub remote_body: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub imported: usize,
    pub unchanged: usize,
    pub conflicts: Vec<MemoryConflict>,
    pub skipped_secrets: usize,
    #[serde(skip)]
    pub(crate) allowed_remote_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExportedPage {
    pub workspace: String,
    pub project: String,
    pub path: String,
    pub title: String,
    pub body: String,
    pub pinned: bool,
}

pub(crate) fn safe_page_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains(['\\', '\0', ':'])
        && Path::new(path).components().all(|part| match part {
            Component::Normal(seg) => seg != ".git" && !seg.to_string_lossy().chars().any(char::is_control),
            _ => false,
        })
}

fn scalar(frontmatter: &str, key: &str) -> Option<String> {
    let value = frontmatter.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name.trim() == key).then(|| value.trim())
    })?;
    serde_json::from_str::<String>(value).ok().or_else(|| Some(value.to_string()))
}

fn safe_segment(raw: &str, fallback: &str) -> String {
    let clean: String = raw.trim().chars().map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }
    }).collect();
    let trimmed = clean.trim_matches('.');
    if trimmed.is_empty() || trimmed == ".." { fallback.into() } else { trimmed.into() }
}

fn page_has_secret(page: &ExportedPage) -> bool {
    looks_like_user_secret(&page.path) || looks_like_user_secret(&page.title) || looks_like_user_secret(&page.body)
}

fn conflict_preview(text: &str) -> String {
    if text.len() <= 2048 {
        return text.to_string();
    }
    let mut end = 2048;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}\n[… prévia truncada …]", &text[..end])
}

/// Aceita apenas o subconjunto exato de Markdown que `render_ai_memory_page` exporta.
pub(crate) fn parse_exported_page(raw: &[u8]) -> Option<ExportedPage> {
    let text = std::str::from_utf8(raw).ok()?;
    let rest = text.strip_prefix("---\n")?;
    let (frontmatter, markdown) = rest.split_once("\n---\n\n")?;
    if scalar(frontmatter, "source")?.as_str() != "ai-memory" {
        return None;
    }
    let workspace = scalar(frontmatter, "workspace")?;
    let project = scalar(frontmatter, "project")?;
    let path = scalar(frontmatter, "path")?;
    let title = scalar(frontmatter, "title")?;
    if !safe_page_path(&path) || title.is_empty() || title.len() > 128 || title.chars().any(char::is_control) {
        return None;
    }
    let body = markdown.strip_prefix(&format!("# {title}\n\n"))?;
    Some(ExportedPage {
        workspace,
        project,
        path,
        title,
        body: body.trim_end_matches('\n').to_string(),
        pinned: scalar(frontmatter, "pinned").as_deref() == Some("true"),
    })
}

pub(crate) fn apply_import(
    client: &Client,
    workspace: &str,
    project: &str,
    pages: impl IntoIterator<Item = ExportedPage>,
    accept_remote_path: Option<&str>,
) -> Result<RestoreReport, String> {
    let mut report = RestoreReport::default();
    for page in pages {
        if page.workspace != workspace || page.project != project {
            continue;
        }
        if page_has_secret(&page) {
            report.skipped_secrets += 1;
            continue;
        }
        let local = client.find_page_scoped(&page.path, workspace, project)?;
        if let Some(local_page) = local.as_ref() {
            if local_page.title.as_deref().unwrap_or(&page.path) == page.title
                && local_page.body.trim_end() == page.body.trim_end()
            {
                report.unchanged += 1;
                continue;
            }
            if accept_remote_path != Some(page.path.as_str()) {
                if looks_like_user_secret(local_page.title.as_deref().unwrap_or(&page.path))
                    || looks_like_user_secret(&local_page.body)
                {
                    report.skipped_secrets += 1;
                    continue;
                }
                report.conflicts.push(MemoryConflict {
                    path: page.path,
                    title: page.title,
                    local_body: conflict_preview(&local_page.body),
                    remote_body: conflict_preview(&page.body),
                });
                continue;
            }
        }
        let write = PageWrite {
            path: &page.path,
            title: &page.title,
            kind: "fact",
            tags: &[],
            pinned: page.pinned,
        };
        client.write_scoped_page(&write, page.body.into_bytes(), workspace, project)?;
        report.imported += 1;
    }
    Ok(report)
}

/// Resolve o projeto no backend pela pasta de trabalho, sem aceitar identidade de escopo do front.
pub(crate) fn import_project_pages(
    ai_memory_program: Option<&Path>,
    cwd: Option<&str>,
    files: impl IntoIterator<Item = (String, Vec<u8>)>,
    accept_remote_path: Option<&str>,
) -> Result<RestoreReport, String> {
    let pages: Vec<_> = files.into_iter().filter_map(|(remote_path, raw)| {
        parse_exported_page(&raw).map(|page| (remote_path, page))
    }).collect();
    if pages.is_empty() {
        return Ok(RestoreReport::default());
    }
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return Ok(RestoreReport::default());
    };
    let cwd = Path::new(cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("A pasta do projeto precisa ser absoluta e existir para restaurar as memórias.".into());
    }
    let Some(program) = ai_memory_program else {
        return Ok(RestoreReport::default());
    };
    let client = Client::at(Some(program.to_path_buf()), cwd.to_path_buf())?;
    client.ensure_supported()?;
    let home = dirs::home_dir().unwrap_or_default();
    let (workspace, project) = crate::ai_memory::tabs::resolve_scope(program, cwd, &home)
        .ok_or_else(|| "Não foi possível resolver um projeto único no ai-memory para esta pasta.".to_string())?;
    if crate::ai_memory::scoped_bridge::reserved_project(&workspace)
        || crate::ai_memory::scoped_bridge::reserved_project(&project)
    {
        return Err("Projeto reservado não permitido para restauração.".into());
    }
    let mut report = apply_import(
        &client,
        &workspace,
        &project,
        pages.iter().map(|(_, page)| page.clone()),
        accept_remote_path,
    )?;
    for (remote_path, page) in pages {
        if page.workspace == workspace && page.project == project && safe_page_path(&page.path)
            && !page_has_secret(&page)
            && remote_path == format!("ai-memory/{}/{}/{}", safe_segment(&workspace, "default"), safe_segment(&project, "project"), page.path)
        {
            report.allowed_remote_files.push(remote_path);
        }
    }
    Ok(report)
}
