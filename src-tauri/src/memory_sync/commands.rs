use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::credentials::{WipeString, helper_program, sanitize_error};
use super::export::{DEFAULT_INTERVAL_HOURS, SkippedMemoryPage, build_export_bundle, load_legacy_snapshot};
use super::repo::{RemoteCredentials, fetch_ai_memory_pages, push_bundle};
use super::restore::{RestoreReport, import_project_pages};
use crate::database::DbConnection;
use crate::forge::for_sync::{Api, ForgeError, ForgeKind, ForgeRepo, account_api, account_api_and_token};
use crate::memory::repo_scope;
use crate::util::now_ts;

const KEY_ENABLED: &str = "memory_sync.enabled";
const KEY_ACCOUNT_ID: &str = "memory_sync.account_id";
const KEY_REPO: &str = "memory_sync.repo";
const KEY_URL: &str = "memory_sync.url";
const KEY_WEB_URL: &str = "memory_sync.web_url";
const KEY_BRANCH: &str = "memory_sync.branch";
const KEY_AUTO_ENABLED: &str = "memory_sync.auto_enabled";
const KEY_INTERVAL_HOURS: &str = "memory_sync.interval_hours";
const KEY_LAST: &str = "memory_sync.last";
const KEY_LAST_ERROR: &str = "memory_sync.last_error";

const MIN_INTERVAL_HOURS: u32 = 1;
const MAX_INTERVAL_HOURS: u32 = 168;

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy)]
struct SyncOptions<'a> {
    workspace_id: Option<&'a str>,
    cwd: Option<&'a str>,
    keep_local_path: Option<&'a str>,
    accept_remote_path: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncReport {
    pub at: i64,
    #[serde(default)]
    pub restored: bool,
    pub pushed: bool,
    pub commit: Option<String>,
    pub ai_memory_pages: usize,
    pub sqlite_entries: usize,
    pub sqlite_revisions: usize,
    #[serde(default)]
    pub skipped_pages: Vec<SkippedMemoryPage>,
    #[serde(default)]
    pub ai_memory_note: Option<String>,
    #[serde(default)]
    pub restore: RestoreReport,
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

fn db(app: &AppHandle) -> Result<DbConnection, String> {
    app.try_state::<DbConnection>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "O banco de dados ainda não está pronto.".into())
}

fn get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn del(conn: &Connection, key: &str) {
    let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [key]);
}

fn read_status(conn: &Connection) -> MemorySyncStatus {
    let account_id = get(conn, KEY_ACCOUNT_ID);
    let repo = get(conn, KEY_REPO);
    let configured = account_id.is_some() && repo.is_some();
    let enabled = configured && get(conn, KEY_ENABLED).as_deref() == Some("1");
    let interval_hours = get(conn, KEY_INTERVAL_HOURS)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(DEFAULT_INTERVAL_HOURS)
        .clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS);
    MemorySyncStatus {
        enabled,
        configured,
        account_id,
        repo,
        web_url: get(conn, KEY_WEB_URL),
        auto_enabled: get(conn, KEY_AUTO_ENABLED).as_deref() == Some("1"),
        interval_hours,
        last: get(conn, KEY_LAST).and_then(|v| serde_json::from_str(&v).ok()),
        last_error: get(conn, KEY_LAST_ERROR),
    }
}

fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['.', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub(crate) fn status_db(db: &DbConnection) -> Result<MemorySyncStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(read_status(&conn))
}

pub(crate) fn set_enabled_db(db: &DbConnection, enabled: bool) -> Result<MemorySyncStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let current = read_status(&conn);
    if enabled && !current.configured {
        return Err("Configure uma conta git e um repositório privado antes de ligar o envio.".into());
    }
    set(&conn, KEY_ENABLED, if enabled { "1" } else { "0" })?;
    Ok(read_status(&conn))
}

pub(crate) fn set_auto_db(
    db: &DbConnection,
    auto_enabled: bool,
    interval_hours: u32,
) -> Result<MemorySyncStatus, String> {
    let hours = interval_hours.clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS);
    let conn = db.lock().map_err(|e| e.to_string())?;
    set(&conn, KEY_AUTO_ENABLED, if auto_enabled { "1" } else { "0" })?;
    set(&conn, KEY_INTERVAL_HOURS, &hours.to_string())?;
    Ok(read_status(&conn))
}

pub(crate) async fn setup_with(
    db: &DbConnection,
    account_id: &str,
    account_login: &str,
    forge_kind: ForgeKind,
    api: &impl ForgeClient,
    repo_name: &str,
) -> Result<MemorySyncStatus, String> {
    if !forge_kind.has_api() {
        return Err(
            "Use uma conta GitHub, GitLab ou Gitea com API para confirmar que o repositório é privado."
                .into(),
        );
    }
    let clean_name = repo_name.trim();
    if !valid_repo_name(clean_name) {
        return Err(format!("«{clean_name}» não é um nome de repositório válido."));
    }
    let full = format!("{account_login}/{clean_name}");
    let repo = match api.find_repo(&full).await.map_err(|e| e.to_string())? {
        Some(existing) if !existing.private => {
            return Err(format!(
                "O repositório {full} é público e foi recusado. Apenas repositórios privados são aceitos para memórias."
            ));
        }
        Some(existing) => existing,
        None => {
            let created = api
                .create_private_repo(clean_name, "ADE AGS private memory backup")
                .await
                .map_err(|e| e.to_string())?;
            if !created.private {
                return Err(format!(
                    "O repositório {} não foi confirmado como privado e foi recusado.",
                    created.full_name
                ));
            }
            created
        }
    };
    if repo.clone_url.trim().is_empty() {
        return Err("A API do forge não informou a URL de clone do repositório privado.".into());
    }

    let db_clone = db.clone();
    let account_id = account_id.to_string();
    let branch = repo
        .default_branch
        .clone()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "main".into());
    crate::database::blocking_db(&db_clone, move |conn| {
        set(conn, KEY_ACCOUNT_ID, &account_id)?;
        set(conn, KEY_REPO, &repo.full_name)?;
        set(conn, KEY_URL, &repo.clone_url)?;
        set(conn, KEY_WEB_URL, &repo.web_url)?;
        set(conn, KEY_BRANCH, &branch)?;
        set(conn, KEY_ENABLED, "1")?;
        del(conn, KEY_LAST_ERROR);
        Ok(read_status(conn))
    })
    .await
}

fn record_error(db: &DbConnection, message: &str) {
    if let Ok(conn) = db.lock() {
        let _ = set(&conn, KEY_LAST_ERROR, message);
    }
}

pub(crate) async fn sync_now_with(
    db: &DbConnection,
    data_dir: &Path,
    workspace_id: Option<&str>,
    cwd: Option<&str>,
    ai_memory_program: Option<PathBuf>,
    api: &impl ForgeClient,
    auth: Option<(&str, &str, &str, &Path)>,
) -> Result<MemorySyncResult, String> {
    sync_now_with_choice(
        db,
        data_dir,
        SyncOptions { workspace_id, cwd, keep_local_path: None, accept_remote_path: None },
        ai_memory_program,
        api,
        auth,
    ).await
}

async fn sync_now_with_choice(
    db: &DbConnection,
    data_dir: &Path,
    options: SyncOptions<'_>,
    ai_memory_program: Option<PathBuf>,
    api: &impl ForgeClient,
    auth: Option<(&str, &str, &str, &Path)>,
) -> Result<MemorySyncResult, String> {
    let SyncOptions { workspace_id, cwd, keep_local_path, accept_remote_path } = options;
    let secrets: Vec<String> = auth
        .as_ref()
        .map(|(_, _, tok, _)| vec![(*tok).to_string()])
        .unwrap_or_default();
    let secret_refs: Vec<&str> = secrets.iter().map(String::as_str).collect();

    let (status, stored_branch) = {
        let db_clone = db.clone();
        crate::database::blocking_db(&db_clone, |conn| {
            let st = read_status(conn);
            let branch = get(conn, KEY_BRANCH).unwrap_or_else(|| "main".into());
            Ok((st, branch))
        })
        .await?
    };

    if !status.enabled || !status.configured {
        return Err("O envio privado das memórias está desligado.".into());
    }
    let full_name = status
        .repo
        .clone()
        .ok_or_else(|| "Nenhum repositório privado configurado.".to_string())?;

    // Confirma privacidade via API antes de qualquer operação git ou envio.
    let verified_repo = match api.find_repo(&full_name).await {
        Ok(Some(repo)) if !repo.private => {
            let msg = format!(
                "Envio recusado: o repositório {full_name} é público. Apenas repositórios privados são aceitos."
            );
            record_error(db, &msg);
            return Err(msg);
        }
        Ok(Some(repo)) => repo,
        Ok(None) => {
            let msg = format!(
                "Não foi possível confirmar pela API se {full_name} é privado: repositório não encontrado ou sem acesso."
            );
            record_error(db, &msg);
            return Err(msg);
        }
        Err(err) => {
            let raw = format!("Não foi possível confirmar pela API se {full_name} é privado: {err}");
            let msg = sanitize_error(&raw, &secret_refs);
            record_error(db, &msg);
            return Err(msg);
        }
    };

    let branch = verified_repo
        .default_branch
        .clone()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or(stored_branch);
    let remote_url = verified_repo.clone_url.clone();
    let web_url = verified_repo.web_url.clone();

    let clean_cwd = cwd.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let repo_key = clean_cwd
        .as_deref()
        .and_then(|p| repo_scope::repo_key(Path::new(p)));

    let legacy = if let Some(ws_id) = workspace_id.filter(|s| !s.trim().is_empty()) {
        let ws_id = ws_id.to_string();
        let db_clone = db.clone();
        Some(
            crate::database::blocking_db(&db_clone, move |conn| {
                load_legacy_snapshot(conn, &ws_id, repo_key.as_deref())
            })
            .await?,
        )
    } else {
        None
    };

    let data_dir = data_dir.to_path_buf();
    let owned_auth = auth.map(|(h, u, t, p)| {
        (
            h.to_string(),
            u.to_string(),
            WipeString(t.to_string()),
            p.to_path_buf(),
        )
    });

    let restore_cwd = clean_cwd.clone();
    let keep_local_path = keep_local_path.map(str::to_string);
    let accept_remote_path = accept_remote_path.map(str::to_string);
    let export_push = tokio::task::spawn_blocking(move || -> Result<(MemorySyncReport, String), String> {
        let make_creds = || owned_auth.as_ref().map(|(h, u, t, p)| RemoteCredentials {
            host: h.as_str(),
            git_user: u.as_str(),
            token: t.0.as_str(),
            helper_exe: p.as_path(),
        });
        let remote_pages = fetch_ai_memory_pages(&data_dir, &remote_url, &branch, make_creds())?;
        let remote_paths: Vec<String> = remote_pages.iter().map(|(path, _)| path.clone()).collect();
        let restore = import_project_pages(
            ai_memory_program.as_deref(),
            restore_cwd.as_deref(),
            remote_pages,
            accept_remote_path.as_deref(),
        )?;
        let mut restore = restore;
        restore.conflicts.retain(|conflict| keep_local_path.as_deref() != Some(conflict.path.as_str()));
        let bundle = build_export_bundle(ai_memory_program.as_deref(), clean_cwd.as_deref(), legacy.as_ref())?;
        // Conflitos ficam no remoto até a escolha do usuário; o push não pode apagar a cópia GitHub.
        let mut bundle = bundle;
        for remote_path in remote_paths {
            if remote_path.starts_with("ai-memory/")
                && bundle.files.contains_key(&remote_path)
                && !restore.allowed_remote_files.contains(&remote_path)
            {
                bundle.files.remove(&remote_path);
            }
        }
        for conflict in &restore.conflicts {
            if keep_local_path.as_deref() == Some(conflict.path.as_str()) {
                continue;
            }
            let prefix = bundle.ai_memory_prefix.as_deref().unwrap_or("");
            let normalized = conflict.path.trim_start_matches('/');
            bundle.files.remove(&format!("{prefix}{normalized}"));
        }
        let outcome = {
            push_bundle(&data_dir, &remote_url, &branch, &bundle, make_creds())?
        };
        let report = MemorySyncReport {
            at: now_ts(),
            restored: false,
            pushed: outcome.pushed,
            commit: outcome.commit,
            ai_memory_pages: bundle.ai_memory_pages,
            sqlite_entries: bundle.sqlite_entries,
            sqlite_revisions: bundle.sqlite_revisions,
            skipped_pages: bundle.skipped_pages,
            ai_memory_note: bundle.ai_memory_note,
            restore,
        };
        Ok((report, branch))
    })
    .await
    .map_err(|e| e.to_string())?;

    let (report, used_branch) = match export_push {
        Ok(res) => res,
        Err(err) => {
            let clean = sanitize_error(&err, &secret_refs);
            record_error(db, &clean);
            return Err(clean);
        }
    };

    let report_json = serde_json::to_string(&report).map_err(|e| e.to_string())?;
    let report_clone = report.clone();
    let remote_url_save = verified_repo.clone_url;
    let db_clone = db.clone();
    let updated_status = crate::database::blocking_db(&db_clone, move |conn| {
        set(conn, KEY_LAST, &report_json)?;
        set(conn, KEY_URL, &remote_url_save)?;
        set(conn, KEY_WEB_URL, &web_url)?;
        set(conn, KEY_BRANCH, &used_branch)?;
        del(conn, KEY_LAST_ERROR);
        Ok(read_status(conn))
    })
    .await?;

    Ok(MemorySyncResult {
        status: updated_status,
        report: report_clone,
    })
}

pub(crate) async fn restore_now_with(
    db: &DbConnection,
    data_dir: &Path,
    cwd: Option<&str>,
    ai_memory_program: Option<PathBuf>,
    api: &impl ForgeClient,
    auth: Option<(&str, &str, &str, &Path)>,
    accept_remote_path: Option<&str>,
) -> Result<MemorySyncResult, String> {
    let secrets: Vec<String> = auth.as_ref().map(|(_, _, token, _)| vec![(*token).to_string()]).unwrap_or_default();
    let secret_refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
    let (status, stored_branch) = {
        let db = db.clone();
        crate::database::blocking_db(&db, |conn| Ok((read_status(conn), get(conn, KEY_BRANCH).unwrap_or_else(|| "main".into())))).await?
    };
    if !status.enabled || !status.configured {
        return Err("O backup privado das memórias está desligado.".into());
    }
    let full_name = status.repo.clone().ok_or_else(|| "Nenhum repositório privado configurado.".to_string())?;
    let verified = match api.find_repo(&full_name).await {
        Ok(Some(repo)) if repo.private => repo,
        Ok(Some(_)) => return Err(format!("Restauração recusada: o repositório {full_name} é público.")),
        Ok(None) => return Err(format!("Não foi possível confirmar pela API se {full_name} é privado.")),
        Err(err) => {
            let msg = sanitize_error(&format!("Não foi possível confirmar pela API se {full_name} é privado: {err}"), &secret_refs);
            record_error(db, &msg);
            return Err(msg);
        }
    };
    let branch = verified.default_branch.filter(|value| !value.trim().is_empty()).unwrap_or(stored_branch);
    let remote_url = verified.clone_url;
    let owned_auth = auth.map(|(host, user, token, helper)| (host.to_string(), user.to_string(), WipeString(token.to_string()), helper.to_path_buf()));
    let data_dir = data_dir.to_path_buf();
    let cwd = cwd.map(str::to_string);
    let accept_remote_path = accept_remote_path.map(str::to_string);
    let result = tokio::task::spawn_blocking(move || {
        let credentials = owned_auth.as_ref().map(|(host, user, token, helper)| RemoteCredentials {
            host, git_user: user, token: &token.0, helper_exe: helper,
        });
        let files = fetch_ai_memory_pages(&data_dir, &remote_url, &branch, credentials)?;
        import_project_pages(ai_memory_program.as_deref(), cwd.as_deref(), files, accept_remote_path.as_deref())
    }).await.map_err(|err| err.to_string())?;
    let restore = match result {
        Ok(report) => report,
        Err(err) => {
            let clean = sanitize_error(&err, &secret_refs);
            record_error(db, &clean);
            return Err(clean);
        }
    };
    let report = MemorySyncReport {
        at: now_ts(), restored: true, pushed: false, commit: None, ai_memory_pages: 0,
        sqlite_entries: 0, sqlite_revisions: 0, skipped_pages: Vec::new(),
        ai_memory_note: None, restore,
    };
    let report_json = serde_json::to_string(&report).map_err(|err| err.to_string())?;
    let db_clone = db.clone();
    let updated = crate::database::blocking_db(&db_clone, move |conn| {
        set(conn, KEY_LAST, &report_json)?;
        del(conn, KEY_LAST_ERROR);
        Ok(read_status(conn))
    }).await?;
    Ok(MemorySyncResult { status: updated, report })
}

#[tauri::command]
pub async fn memory_sync_status(app: AppHandle) -> Result<MemorySyncStatus, String> {
    let db = db(&app)?;
    crate::database::blocking_db(&db, |conn| Ok(read_status(conn))).await
}

#[tauri::command]
pub async fn memory_sync_setup(
    app: AppHandle,
    account_id: String,
    repo_name: String,
    cwd: String,
) -> Result<MemorySyncStatus, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let (account, api) = account_api(&app, &account_id)
        .await
        .map_err(|e| e.to_string())?;
    setup_with(&db, &account.id, &account.login, account.kind, &api, &repo_name).await?;
    let (account, api, raw_token) = account_api_and_token(&app, &account_id).await.map_err(|e| e.to_string())?;
    let token = WipeString(raw_token);
    let data_dir = crate::util::datadir::app_data_dir(&app)?;
    let helper_exe = helper_program(Some(&app))?;
    let git_user = account.kind.git_user(&account.login, account.git_user.as_deref());
    let restored = restore_now_with(
        &db, &data_dir, Some(&cwd), crate::util::path_env::find_program("ai-memory"), &api,
        Some((&account.host, &git_user, &token.0, &helper_exe)), None,
    ).await?;
    Ok(restored.status)
}

#[tauri::command]
pub async fn memory_sync_set_enabled(
    app: AppHandle,
    enabled: bool,
    cwd: String,
) -> Result<MemorySyncStatus, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let db_for_toggle = db.clone();
    let status = tauri::async_runtime::spawn_blocking(move || set_enabled_db(&db_for_toggle, enabled))
        .await
        .map_err(|e| e.to_string())??;
    if !enabled {
        return Ok(status);
    }
    let account_id = status.account_id.clone().ok_or_else(|| "Nenhuma conta git configurada para memórias.".to_string())?;
    let (account, api, raw_token) = account_api_and_token(&app, &account_id).await.map_err(|e| e.to_string())?;
    let token = WipeString(raw_token);
    let helper_exe = helper_program(Some(&app))?;
    let data_dir = crate::util::datadir::app_data_dir(&app)?;
    let git_user = account.kind.git_user(&account.login, account.git_user.as_deref());
    Ok(restore_now_with(
        &db, &data_dir, Some(&cwd), crate::util::path_env::find_program("ai-memory"), &api,
        Some((&account.host, &git_user, &token.0, &helper_exe)), None,
    ).await?.status)
}

#[tauri::command]
pub async fn memory_sync_set_auto(
    app: AppHandle,
    auto_enabled: bool,
    interval_hours: u32,
) -> Result<MemorySyncStatus, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || set_auto_db(&db, auto_enabled, interval_hours))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_sync_now(
    app: AppHandle,
    workspace_id: Option<String>,
    cwd: Option<String>,
) -> Result<MemorySyncResult, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let status = crate::database::blocking_db(&db, |conn| Ok(read_status(conn))).await?;
    if !status.enabled || !status.configured {
        return Err("O envio privado das memórias está desligado.".into());
    }
    let account_id = status
        .account_id
        .ok_or_else(|| "Nenhuma conta git configurada para memórias.".to_string())?;

    let (account, api, raw_token) = account_api_and_token(&app, &account_id)
        .await
        .map_err(|e| e.to_string())?;
    let token = WipeString(raw_token);
    let data_dir = crate::util::datadir::app_data_dir(&app)?;
    let helper_exe = helper_program(Some(&app))?;
    let ai_memory_program = crate::util::path_env::find_program("ai-memory");
    let git_user = account
        .kind
        .git_user(&account.login, account.git_user.as_deref());

    sync_now_with(
        &db,
        &data_dir,
        workspace_id.as_deref(),
        cwd.as_deref(),
        ai_memory_program,
        &api,
        Some((&account.host, &git_user, &token.0, &helper_exe)),
    )
    .await
}

#[tauri::command]
pub async fn memory_sync_restore_now(app: AppHandle, cwd: String) -> Result<MemorySyncResult, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let status = crate::database::blocking_db(&db, |conn| Ok(read_status(conn))).await?;
    if !status.enabled || !status.configured {
        return Err("O backup privado das memórias está desligado.".into());
    }
    let account_id = status.account_id.ok_or_else(|| "Nenhuma conta git configurada para memórias.".to_string())?;
    let (account, api, raw_token) = account_api_and_token(&app, &account_id).await.map_err(|e| e.to_string())?;
    let token = WipeString(raw_token);
    let helper_exe = helper_program(Some(&app))?;
    let data_dir = crate::util::datadir::app_data_dir(&app)?;
    let git_user = account.kind.git_user(&account.login, account.git_user.as_deref());
    restore_now_with(
        &db, &data_dir, Some(&cwd), crate::util::path_env::find_program("ai-memory"), &api,
        Some((&account.host, &git_user, &token.0, &helper_exe)), None,
    ).await
}

#[tauri::command]
pub async fn memory_sync_resolve_conflict(
    app: AppHandle,
    workspace_id: Option<String>,
    cwd: String,
    path: String,
    use_remote: bool,
) -> Result<MemorySyncResult, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let status = crate::database::blocking_db(&db, |conn| Ok(read_status(conn))).await?;
    if !status.enabled || !status.configured {
        return Err("O backup privado das memórias está desligado.".into());
    }
    if !status.last.as_ref().is_some_and(|report| report.restore.conflicts.iter().any(|conflict| conflict.path == path)) {
        return Err("Esse conflito não está mais pendente para escolha.".into());
    }
    let account_id = status.account_id.ok_or_else(|| "Nenhuma conta git configurada para memórias.".to_string())?;
    let (account, api, raw_token) = account_api_and_token(&app, &account_id).await.map_err(|e| e.to_string())?;
    let token = WipeString(raw_token);
    let helper_exe = helper_program(Some(&app))?;
    let data_dir = crate::util::datadir::app_data_dir(&app)?;
    let git_user = account.kind.git_user(&account.login, account.git_user.as_deref());
    sync_now_with_choice(
        &db, &data_dir,
        SyncOptions {
            workspace_id: workspace_id.as_deref(),
            cwd: Some(&cwd),
            keep_local_path: (!use_remote).then_some(path.as_str()),
            accept_remote_path: use_remote.then_some(path.as_str()),
        },
        crate::util::path_env::find_program("ai-memory"), &api,
        Some((&account.host, &git_user, &token.0, &helper_exe)),
    ).await
}
