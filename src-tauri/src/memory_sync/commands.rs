use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::export::{DEFAULT_INTERVAL_HOURS, SkippedMemoryPage};
use crate::database::DbConnection;
use crate::forge::for_sync::{Api, ForgeError, ForgeKind, ForgeRepo};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncReport {
    pub at: i64,
    pub pushed: bool,
    pub commit: Option<String>,
    pub ai_memory_pages: usize,
    pub sqlite_entries: usize,
    pub sqlite_revisions: usize,
    #[serde(default)]
    pub skipped_pages: Vec<SkippedMemoryPage>,
    #[serde(default)]
    pub ai_memory_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncStatus {
    pub enabled: bool,
    pub configured: bool,
    pub account_id: Option<String>,
    pub repo: Option<String>,
    pub web_url: Option<String>,
    pub auto_enabled: bool,
    pub interval_hours: u32,
    pub last: Option<MemorySyncReport>,
    pub last_error: Option<String>,
}

impl Default for MemorySyncStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            configured: false,
            account_id: None,
            repo: None,
            web_url: None,
            auto_enabled: false,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            last: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncResult {
    pub status: MemorySyncStatus,
    pub report: MemorySyncReport,
}

pub(crate) trait ForgeClient {
    async fn find_repo(&self, full_name: &str) -> Result<Option<ForgeRepo>, ForgeError>;
    async fn create_private_repo(&self, name: &str, description: &str) -> Result<ForgeRepo, ForgeError>;
}

impl ForgeClient for Api {
    async fn find_repo(&self, full_name: &str) -> Result<Option<ForgeRepo>, ForgeError> {
        Api::find_repo(self, full_name).await
    }

    async fn create_private_repo(&self, name: &str, description: &str) -> Result<ForgeRepo, ForgeError> {
        Api::create_private_repo(self, name, description).await
    }
}

pub(crate) fn status_db(_db: &DbConnection) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

pub(crate) fn set_enabled_db(_db: &DbConnection, _enabled: bool) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

pub(crate) fn set_auto_db(
    _db: &DbConnection,
    _auto_enabled: bool,
    _interval_hours: u32,
) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

pub(crate) async fn setup_with(
    _db: &DbConnection,
    _account_id: &str,
    _account_login: &str,
    _forge_kind: ForgeKind,
    _api: &impl ForgeClient,
    _repo_name: &str,
) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

pub(crate) async fn sync_now_with(
    _db: &DbConnection,
    _data_dir: &Path,
    _workspace_id: Option<&str>,
    _cwd: Option<&str>,
    _ai_memory_program: Option<PathBuf>,
    _api: &impl ForgeClient,
    _auth: Option<(&str, &str, &str, &Path)>,
) -> Result<MemorySyncResult, String> {
    Err("não implementado".into())
}

#[tauri::command]
pub async fn memory_sync_status(_app: AppHandle) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

#[tauri::command]
pub async fn memory_sync_setup(
    _app: AppHandle,
    _account_id: String,
    _repo_name: String,
) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

#[tauri::command]
pub async fn memory_sync_set_enabled(
    _app: AppHandle,
    _enabled: bool,
) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

#[tauri::command]
pub async fn memory_sync_set_auto(
    _app: AppHandle,
    _auto_enabled: bool,
    _interval_hours: u32,
) -> Result<MemorySyncStatus, String> {
    Err("não implementado".into())
}

#[tauri::command]
pub async fn memory_sync_now(
    _app: AppHandle,
    _workspace_id: Option<String>,
    _cwd: Option<String>,
) -> Result<MemorySyncResult, String> {
    Err("não implementado".into())
}
