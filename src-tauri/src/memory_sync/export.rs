use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const DEFAULT_REPO_NAME: &str = "ade-memoria";
pub const DEFAULT_INTERVAL_HOURS: u32 = 6;

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
    pub mission_id: Option<String>,
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

pub(crate) fn load_legacy_snapshot(
    _conn: &Connection,
    _workspace_id: &str,
    _repo_key: Option<&str>,
) -> Result<LegacySnapshot, String> {
    Err("não implementado".into())
}

pub(crate) fn build_export_bundle(
    _ai_memory_program: Option<&Path>,
    _cwd: Option<&str>,
    _legacy: Option<&LegacySnapshot>,
) -> Result<ExportBundle, String> {
    Err("não implementado".into())
}
