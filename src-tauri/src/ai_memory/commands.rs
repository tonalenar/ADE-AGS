use super::{
    client::{Client, Read},
    migracao::{self, MigrationRow, MigrationSummary},
    types::*,
};
use crate::database::DbConnection;
use crate::util::path_env;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "A consulta ao ai-memory foi interrompida.".to_string())?
}

#[tauri::command]
pub async fn ai_memory_probe(cwd: String) -> Result<Untrusted<Probe>, String> {
    blocking(move || Client::installed(&cwd)?.probe()).await
}

#[tauri::command]
pub async fn ai_memory_status(cwd: String) -> Result<Untrusted<Status>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Status)).await
}

#[tauri::command]
pub async fn ai_memory_handoffs(cwd: String) -> Result<Untrusted<Vec<Handoff>>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Handoffs)).await
}

#[tauri::command]
pub async fn ai_memory_recent(cwd: String) -> Result<Untrusted<Vec<RecentPage>>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Recent)).await
}

#[tauri::command]
pub async fn ai_memory_search(
    cwd: String,
    query: String,
) -> Result<Untrusted<Vec<SearchHit>>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Search(query))).await
}

#[tauri::command]
pub async fn ai_memory_read_page(cwd: String, path: String) -> Result<Untrusted<Page>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Page(path))).await
}

#[tauri::command]
pub async fn ai_memory_projects(cwd: String) -> Result<Untrusted<Vec<Project>>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Projects)).await
}

#[tauri::command]
pub async fn ai_memory_sessions(
    workspace: String,
    project: String,
) -> Result<Untrusted<Vec<Session>>, String> {
    super::sessions::validate_scope(&workspace, &project)?;
    let client = blocking(|| {
        let cwd = std::env::current_dir()
            .map_err(|_| "Não foi possível localizar a pasta do aplicativo.".to_string())?;
        let client = Client::installed(&cwd.to_string_lossy())?;
        client.ensure_supported()?;
        Ok(client)
    })
    .await?;
    client.sessions(workspace, project).await
}

/// Copia as memórias aprovadas do workspace para a wiki do ai-memory (cópia única, idempotente).
#[tauri::command]
pub async fn ai_memory_migrate(
    workspace_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<MigrationSummary, String> {
    let db = db.inner().clone();
    blocking(move || migracao::migrate(&db, &workspace_id, path_env::find_program("ai-memory")))
        .await
}

/// Registro da cópia do workspace, sem o corpo das memórias.
#[tauri::command]
pub fn ai_memory_migration_report(
    workspace_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<Vec<MigrationRow>, String> {
    migracao::report(&db, &workspace_id)
}
