use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ai_memory::client::{Client, Read};
use crate::ai_memory::marker;
use crate::ai_memory::scoped_bridge::reserved_project;
use crate::ai_memory::types::{Page, Project, RecentPage};
use crate::memory::agent::looks_like_user_secret;

pub const DEFAULT_INTERVAL_HOURS: u32 = 6;
const RECENT_EXPORT_LIMIT: u32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedMemoryPage {
    pub source: String,
    pub path: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub(crate) struct ExportBundle {
    pub files: BTreeMap<String, Vec<u8>>,
    pub ai_memory_prefix: Option<String>,
    pub sqlite_prefix: Option<String>,
    pub ai_memory_pages: usize,
    pub sqlite_entries: usize,
    pub sqlite_revisions: usize,
    pub skipped_pages: Vec<SkippedMemoryPage>,
    pub ai_memory_note: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LegacySnapshot {
    pub workspace_id: String,
    pub workspace_name: String,
    pub entries: Vec<LegacyEntry>,
    pub revisions: Vec<LegacyRevision>,
}

#[derive(Debug, Clone)]
pub(crate) struct LegacyEntry {
    pub id: String,
    pub scope: String,
    pub mission_id: Option<String>,
    pub mission_title: Option<String>,
    pub key: String,
    pub kind: String,
    pub body: String,
    pub priority: i64,
    pub revision: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct LegacyRevision {
    pub entry_id: String,
    pub scope: String,
    pub key: String,
    pub revision: i64,
    pub operation: String,
    pub kind: String,
    pub priority: i64,
    pub body: String,
    pub actor_kind: String,
    pub reason: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

fn id_suffix(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn slug(name: &str, id: &str) -> String {
    let stem = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-");
    format!("{}-{}", if stem.is_empty() { "memoria" } else { &stem }, id_suffix(id))
}

fn safe_segment(raw: &str, fallback: &str) -> String {
    let clean: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = clean.trim_matches('.');
    if trimmed.is_empty() || trimmed == ".." {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_rel_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > 1024 || path.contains(['\\', '\0', ':']) {
        return None;
    }
    let mut parts = Vec::new();
    for comp in Path::new(path).components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_str()?;
                if s.is_empty() || s == ".git" {
                    return None;
                }
                parts.push(s);
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn format_ts(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .unwrap_or_else(|| ts.to_string())
}

fn yaml_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Lê o histórico do SQLite legado em modo estritamente somente leitura.
pub(crate) fn load_legacy_snapshot(
    conn: &Connection,
    workspace_id: &str,
    repo_key: Option<&str>,
) -> Result<LegacySnapshot, String> {
    let workspace_name: String = conn
        .query_row("SELECT name FROM workspaces WHERE id = ?1", [workspace_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| workspace_id.to_string());

    let mut entry_stmt = conn
        .prepare(
            "SELECT e.id, e.scope, e.mission_id, m.title, e.key, r.kind, r.body, r.priority, r.revision, r.created_at
             FROM memory_entries e
             JOIN memory_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision AND r.status = 'approved'
             LEFT JOIN missions m ON m.id = e.mission_id
             WHERE e.workspace_id = ?1
               AND e.status = 'active'
               AND (?2 IS NULL OR e.repo_key IS NULL OR e.repo_key = ?2)
             ORDER BY e.scope ASC, r.priority DESC, e.key COLLATE BINARY ASC, e.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let entries = entry_stmt
        .query_map(rusqlite::params![workspace_id, repo_key], |r| {
            Ok(LegacyEntry {
                id: r.get(0)?,
                scope: r.get(1)?,
                mission_id: r.get(2)?,
                mission_title: r.get(3)?,
                key: r.get(4)?,
                kind: r.get(5)?,
                body: r.get(6)?,
                priority: r.get(7)?,
                revision: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut rev_stmt = conn
        .prepare(
            "SELECT r.entry_id, e.scope, e.key, r.revision, r.operation, r.kind, r.priority, r.body, r.actor_kind, r.reason, r.created_at, r.decided_at
             FROM memory_revisions r
             JOIN memory_entries e ON e.id = r.entry_id
             WHERE e.workspace_id = ?1
               AND r.status = 'approved'
               AND (?2 IS NULL OR e.repo_key IS NULL OR e.repo_key = ?2)
             ORDER BY e.id ASC, r.revision ASC",
        )
        .map_err(|e| e.to_string())?;
    let revisions = rev_stmt
        .query_map(rusqlite::params![workspace_id, repo_key], |r| {
            Ok(LegacyRevision {
                entry_id: r.get(0)?,
                scope: r.get(1)?,
                key: r.get(2)?,
                revision: r.get(3)?,
                operation: r.get(4)?,
                kind: r.get(5)?,
                priority: r.get(6)?,
                body: r.get(7)?,
                actor_kind: r.get(8)?,
                reason: r.get(9)?,
                created_at: r.get(10)?,
                decided_at: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(LegacySnapshot {
        workspace_id: workspace_id.to_string(),
        workspace_name,
        entries,
        revisions,
    })
}

fn resolve_explicit_ai_memory_scope(client: &Client, cwd: &Path) -> Option<(String, String)> {
    // Marcador explícito manda: par seguro é usado; projeto reservado bloqueia (sem palpite pela pasta).
    match marker::resolve(cwd, dirs::home_dir().as_deref()) {
        marker::Scope::Pair(workspace, project) => return Some((workspace, project)),
        marker::Scope::Reserved => return None,
        marker::Scope::Missing => {}
    }
    let projects = client.read::<Vec<Project>>(Read::Projects).ok()?.data;
    let folder = cwd.file_name()?.to_str()?;
    let mut matches = projects
        .iter()
        .filter(|p| p.project_name.eq_ignore_ascii_case(folder));
    let project = matches.next()?;
    if matches.next().is_some()
        || reserved_project(&project.project_name)
        || reserved_project(&project.workspace_name)
    {
        return None;
    }
    Some((project.workspace_name.clone(), project.project_name.clone()))
}

fn render_ai_memory_page(page: &Page) -> Vec<u8> {
    let title = page
        .title
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(&page.path);
    let tier = page
        .frontmatter
        .get("tier")
        .and_then(|v| v.as_str())
        .unwrap_or("semantic");
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: ai-memory\n");
    out.push_str(&format!("workspace: {}\n", yaml_scalar(&page.workspace)));
    out.push_str(&format!("project: {}\n", yaml_scalar(&page.project)));
    out.push_str(&format!("path: {}\n", yaml_scalar(&page.path)));
    out.push_str(&format!("title: {}\n", yaml_scalar(title)));
    out.push_str(&format!("tier: {}\n", yaml_scalar(tier)));
    out.push_str(&format!("pinned: {}\n", page.pinned));
    out.push_str(&format!("expired: {}\n", page.expired));
    if let Some(expires_at) = &page.expires_at {
        out.push_str(&format!("expires_at: {}\n", yaml_scalar(expires_at)));
    }
    out.push_str("---\n\n");
    out.push_str(&format!("# {title}\n\n"));
    out.push_str(page.body.trim_end());
    out.push('\n');
    out.into_bytes()
}

fn export_ai_memory(
    ai_memory_program: Option<&Path>,
    cwd: Option<&str>,
    bundle: &mut ExportBundle,
) -> Result<(), String> {
    let Some(cwd_str) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        bundle.ai_memory_note =
            Some("Nenhuma pasta de projeto aberta; enviado apenas o histórico legado do SQLite.".into());
        return Ok(());
    };
    let cwd_path = PathBuf::from(cwd_str);
    if !cwd_path.is_absolute() || !cwd_path.is_dir() {
        bundle.ai_memory_note =
            Some("Pasta do projeto indisponível; enviado apenas o histórico legado do SQLite.".into());
        return Ok(());
    }
    let Some(program) = ai_memory_program else {
        bundle.ai_memory_note =
            Some("ai-memory não encontrado no PATH; enviado apenas o histórico legado do SQLite.".into());
        return Ok(());
    };

    let client = Client::at(Some(program.to_path_buf()), cwd_path.clone())?;
    if let Err(err) = client.ensure_supported() {
        bundle.ai_memory_note =
            Some(format!("ai-memory indisponível ({err}); enviado apenas o histórico legado do SQLite."));
        return Ok(());
    }

    let explicit_scope = resolve_explicit_ai_memory_scope(&client, &cwd_path);
    if let Some((ref ws, ref proj)) = explicit_scope {
        bundle.ai_memory_prefix = Some(format!(
            "ai-memory/{}/{}/",
            safe_segment(ws, "default"),
            safe_segment(proj, "project")
        ));
    }

    let recent = match client.read::<Vec<RecentPage>>(Read::RecentLimit(RECENT_EXPORT_LIMIT)) {
        Ok(res) => res.data,
        Err(err) => {
            bundle.ai_memory_note =
                Some(format!("ai-memory não respondeu ({err}); enviado apenas o histórico legado do SQLite."));
            return Ok(());
        }
    };

    let mut seen_paths = HashSet::new();
    let mut detected_scope: Option<(String, String)> = explicit_scope.clone();

    for item in recent {
        let Some(rel_path) = safe_rel_path(&item.path) else {
            continue;
        };
        if !seen_paths.insert(rel_path.clone()) {
            continue;
        }
        let Some(page) = client.find_page(&item.path)? else {
            continue;
        };
        if page.workspace.trim().is_empty()
            || page.project.trim().is_empty()
            || reserved_project(&page.workspace)
            || reserved_project(&page.project)
        {
            continue;
        }
        if let Some((ref exp_ws, ref exp_proj)) = explicit_scope {
            if page.workspace != *exp_ws || page.project != *exp_proj {
                continue;
            }
        } else if let Some((ref cur_ws, ref cur_proj)) = detected_scope {
            if page.workspace != *cur_ws || page.project != *cur_proj {
                continue;
            }
        } else {
            detected_scope = Some((page.workspace.clone(), page.project.clone()));
            bundle.ai_memory_prefix = Some(format!(
                "ai-memory/{}/{}/",
                safe_segment(&page.workspace, "default"),
                safe_segment(&page.project, "project")
            ));
        }

        let raw_title = page.title.as_deref().unwrap_or(&page.path);
        let path_secret = looks_like_user_secret(&page.path);
        let title_secret = looks_like_user_secret(raw_title);
        let body_secret = looks_like_user_secret(&page.body);
        if path_secret || title_secret || body_secret {
            bundle.skipped_pages.push(SkippedMemoryPage {
                source: "ai-memory".into(),
                path: if path_secret {
                    "[caminho-redigido]".into()
                } else {
                    rel_path
                },
                title: if title_secret {
                    "[título redigido]".into()
                } else {
                    raw_title.to_string()
                },
                reason: "Possível credencial ou segredo detectado".into(),
            });
            continue;
        }

        let ws_seg = safe_segment(&page.workspace, "default");
        let proj_seg = safe_segment(&page.project, "project");
        let target = format!("ai-memory/{ws_seg}/{proj_seg}/{rel_path}");
        bundle.files.insert(target, render_ai_memory_page(&page));
        bundle.ai_memory_pages += 1;
    }

    Ok(())
}

fn render_legacy_entry(entry: &LegacyEntry) -> Vec<u8> {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: sqlite-legacy\n");
    out.push_str(&format!("entry_id: {}\n", yaml_scalar(&entry.id)));
    out.push_str(&format!("scope: {}\n", yaml_scalar(&entry.scope)));
    out.push_str(&format!("kind: {}\n", yaml_scalar(&entry.kind)));
    out.push_str(&format!("priority: {}\n", entry.priority));
    out.push_str(&format!("revision: {}\n", entry.revision));
    out.push_str(&format!("created_at: {}\n", yaml_scalar(&format_ts(entry.created_at))));
    if let Some(mid) = &entry.mission_id {
        out.push_str(&format!("mission_id: {}\n", yaml_scalar(mid)));
    }
    if let Some(mtitle) = &entry.mission_title {
        out.push_str(&format!("mission_title: {}\n", yaml_scalar(mtitle)));
    }
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", entry.key));
    out.push_str(entry.body.trim_end());
    out.push('\n');
    out.into_bytes()
}

fn render_legacy_history(key: &str, entry_id: &str, scope: &str, revs: &[&LegacyRevision]) -> Vec<u8> {
    let mut out = String::new();
    out.push_str(&format!("# Histórico: {key}\n\n"));
    out.push_str(&format!("- ID da entrada: `{entry_id}`\n"));
    out.push_str(&format!("- Escopo: `{scope}`\n\n"));
    for rev in revs {
        out.push_str(&format!(
            "## Revisão r{} ({}, {})\n\n",
            rev.revision, rev.operation, rev.kind
        ));
        out.push_str(&format!("- Ator: `{}`\n", rev.actor_kind));
        out.push_str(&format!("- Prioridade: {}\n", rev.priority));
        out.push_str(&format!("- Criada em: {}\n", format_ts(rev.created_at)));
        if let Some(decided_at) = rev.decided_at {
            out.push_str(&format!("- Decidida em: {}\n", format_ts(decided_at)));
        }
        if let Some(reason) = &rev.reason {
            out.push_str(&format!("- Motivo: {reason}\n"));
        }
        out.push('\n');
        out.push_str(rev.body.trim_end());
        out.push_str("\n\n");
    }
    out.into_bytes()
}

fn export_legacy(snapshot: &LegacySnapshot, bundle: &mut ExportBundle) {
    let ws_prefix = format!("sqlite/ws-{}/", id_suffix(&snapshot.workspace_id));
    bundle.sqlite_prefix = Some(ws_prefix.clone());

    let mut skipped_entries = HashSet::new();
    let mut index_lines = vec![
        format!("# Memórias legadas (SQLite) — {}", snapshot.workspace_name),
        String::new(),
        "Cópia somente leitura do histórico aprovado do SQLite do ADE AGS.".into(),
        String::new(),
    ];

    for entry in &snapshot.entries {
        let key_secret = looks_like_user_secret(&entry.key);
        let body_secret = looks_like_user_secret(&entry.body);
        let stem = if key_secret {
            format!("entrada-{}", id_suffix(&entry.id))
        } else {
            slug(&entry.key, &entry.id)
        };
        let rel_path = format!("{ws_prefix}entries/{stem}.md");

        if key_secret || body_secret {
            skipped_entries.insert(entry.id.clone());
            bundle.skipped_pages.push(SkippedMemoryPage {
                source: "sqlite".into(),
                path: rel_path,
                title: if key_secret {
                    "[chave redigida]".into()
                } else {
                    entry.key.clone()
                },
                reason: "Possível credencial ou segredo detectado".into(),
            });
            continue;
        }

        bundle.files.insert(rel_path.clone(), render_legacy_entry(entry));
        bundle.sqlite_entries += 1;
        index_lines.push(format!(
            "- [{}](entries/{stem}.md) (`{}` · {} · r{})",
            entry.key, entry.scope, entry.kind, entry.revision
        ));
    }

    let mut by_entry: BTreeMap<&str, Vec<&LegacyRevision>> = BTreeMap::new();
    for rev in &snapshot.revisions {
        by_entry.entry(rev.entry_id.as_str()).or_default().push(rev);
    }

    for (entry_id, revs) in by_entry {
        if skipped_entries.contains(entry_id) {
            continue;
        }
        let Some(first) = revs.first() else { continue };
        let key_secret = looks_like_user_secret(&first.key);
        let stem = if key_secret {
            format!("entrada-{}", id_suffix(entry_id))
        } else {
            slug(&first.key, entry_id)
        };

        let mut clean_revs = Vec::new();
        for rev in revs.iter().copied() {
            let reason_secret = rev.reason.as_deref().is_some_and(looks_like_user_secret);
            if key_secret || looks_like_user_secret(&rev.body) || reason_secret {
                bundle.skipped_pages.push(SkippedMemoryPage {
                    source: "sqlite".into(),
                    path: format!("{ws_prefix}history/{stem}@r{}.md", rev.revision),
                    title: if key_secret {
                        format!("[chave redigida] (r{})", rev.revision)
                    } else {
                        format!("{} (r{})", rev.key, rev.revision)
                    },
                    reason: "Possível credencial ou segredo detectado na revisão histórica".into(),
                });
                continue;
            }
            clean_revs.push(rev);
            bundle.sqlite_revisions += 1;
        }

        if !clean_revs.is_empty() {
            let safe_key = if key_secret { "[chave redigida]" } else { &first.key };
            let hist_path = format!("{ws_prefix}history/{stem}.md");
            bundle.files.insert(
                hist_path,
                render_legacy_history(safe_key, entry_id, &first.scope, &clean_revs),
            );
        }
    }

    index_lines.push(String::new());
    bundle
        .files
        .insert(format!("{ws_prefix}INDEX.md"), index_lines.join("\n").into_bytes());
}

/// Monta a árvore filtrada para envio ao espelho privado.
pub(crate) fn build_export_bundle(
    ai_memory_program: Option<&Path>,
    cwd: Option<&str>,
    legacy: Option<&LegacySnapshot>,
) -> Result<ExportBundle, String> {
    let mut bundle = ExportBundle::default();
    export_ai_memory(ai_memory_program, cwd, &mut bundle)?;
    if let Some(snapshot) = legacy {
        export_legacy(snapshot, &mut bundle);
    }
    Ok(bundle)
}
