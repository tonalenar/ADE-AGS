use super::{
    client::{Client, Read},
    migracao::{self, MigrationRow, MigrationSummary},
    types::*,
};
use crate::database::DbConnection;
use crate::util::path_env;
use sha2::{Digest, Sha256};

fn scoped_client(cwd: &str) -> Result<(Client, String, String), String> {
    let path = std::path::Path::new(cwd);
    let binary = path_env::find_program("ai-memory")
        .ok_or_else(|| "O ai-memory não está instalado ou não está disponível no PATH.".to_string())?;
    let client = Client::at(Some(binary.clone()), path.to_path_buf())?;
    let home = dirs::home_dir().unwrap_or_default();
    let (workspace, project) = super::tabs::resolve_scope(&binary, path, &home)
        .ok_or_else(|| "Não foi possível resolver um projeto único no ai-memory para esta pasta.".to_string())?;
    super::sessions::validate_scope(&workspace, &project)?;
    if super::scoped_bridge::reserved_project(&project) {
        return Err("Projeto reservado não permitido.".into());
    }
    Ok((client, workspace, project))
}

/// A preferência por memória de sessão desligada mantém apenas o fallback histórico de leitura.
pub(crate) fn memory_enabled(db: &DbConnection) -> bool {
    crate::database::get_setting(db, super::tabs::TABS_SETTING)
        .map(|value| super::tabs::enabled(value.as_deref()))
        .unwrap_or(false)
}

/// Busca memória do projeto da pasta sem ler o banco SQLite legado.
pub(crate) fn project_context(cwd: &str, query: &str) -> Result<String, String> {
    let (client, workspace, project) = scoped_client(cwd)?;
    client.project_context(query, &workspace, &project)
}

/// Grava memória no projeto resolvido, isolando o diretório quando pertence a uma missão.
pub(crate) fn write_agent_memory_for_scope(
    cwd: &str,
    mission_id: Option<&str>,
    key: &str,
    kind: &str,
    body: &str,
    tags: &[String],
    reason: Option<&str>,
) -> Result<(), String> {
    let prepared = prepare_agent_write(key, mission_id, kind, body, tags, reason)?;
    let (client, workspace, project) = scoped_client(cwd)?;
    write_prepared_agent_memory(&client, &workspace, &project, prepared)
}

fn user_write_tags(mission_id: Option<&str>) -> Vec<String> {
    let mut tags = vec!["ade-ags".to_string(), "user".to_string()];
    if let Some(id) = mission_id.map(str::trim).filter(|id| !id.is_empty()) {
        tags.push(format!("mission-{}", id.chars().take(32).collect::<String>()));
    }
    tags
}

/// Grava memória do usuário no ai-memory resolvendo o projeto pela pasta atual (nunca pelo front).
pub(super) fn write_user_memory_in_db(
    db: &DbConnection,
    cwd: &str,
    mission_id: Option<&str>,
    key: &str,
    kind: &str,
    body: &str,
    reason: Option<&str>,
) -> Result<String, String> {
    if !memory_enabled(db) {
        return Err("O ai-memory está desativado nas configurações.".into());
    }
    if cwd.trim().is_empty() {
        return Err("Nenhuma pasta aberta para resolver o projeto no ai-memory.".into());
    }
    let mission_id = mission_id.map(str::trim).filter(|id| !id.is_empty());
    let tags = user_write_tags(mission_id);
    let prepared = prepare_agent_write(key, mission_id, kind, body, &tags, reason)?;
    let path = prepared.path.clone();
    let (client, workspace, project) = scoped_client(cwd)?;
    write_prepared_agent_memory(&client, &workspace, &project, prepared)?;
    Ok(path)
}

/// Busca páginas no projeto resolvido pela pasta da aba. Nunca aceita projeto vindo do chamador.
pub(crate) fn search_project_pages(cwd: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let (client, workspace, project) = scoped_client(cwd)?;
    let hits = client.read::<Vec<SearchHit>>(Read::SearchScoped {
        query: query.to_owned(),
        workspace: workspace.clone(),
        project: project.clone(),
    })?;
    Ok(hits.data.into_iter().filter(|hit| {
        hit.workspace.as_deref().is_none_or(|value| value == workspace)
            && hit.project.as_deref().is_none_or(|value| value == project)
    }).collect())
}

/// Lê apenas uma página pertencente ao projeto resolvido pela pasta da aba.
pub(crate) fn read_project_page(cwd: &str, path: &str) -> Result<Option<Page>, String> {
    let (client, workspace, project) = scoped_client(cwd)?;
    let Some(page) = client.find_page_scoped(path, &workspace, &project)? else {
        return Ok(None);
    };
    if page.workspace != workspace || page.project != project || page.path != path {
        return Err("A página retornada não pertence ao projeto resolvido.".into());
    }
    Ok(Some(page))
}

pub(super) struct PreparedAgentWrite {
    pub(super) path: String,
    title: String,
    kind: &'static str,
    tags: Vec<String>,
    body: Vec<u8>,
}

pub(super) fn prepare_agent_write(
    key: &str,
    mission_id: Option<&str>,
    kind: &str,
    body: &str,
    tags: &[String],
    reason: Option<&str>,
) -> Result<PreparedAgentWrite, String> {
    let key = crate::memory::normalize_key(key)
        .map_err(|_| "A chave da memória deve ter de 1 a 128 bytes UTF-8 e não conter controles.".to_string())?;
    let body = crate::memory::normalize_body(body)
        .map_err(|_| "O corpo da memória deve ter de 1 a 4096 bytes UTF-8.".to_string())?;
    let reason = crate::memory::normalize_reason(reason)
        .map_err(|_| "O motivo da memória deve ter até 512 bytes UTF-8.".to_string())?;
    if [key.as_str(), body.as_str(), reason.as_deref().unwrap_or("")]
        .iter()
        .any(|text| crate::memory::agent::looks_like_secret(text))
        || tags.iter().any(|tag| crate::memory::agent::looks_like_secret(tag))
    {
        return Err(crate::memory::agent::secret_confirmation_error());
    }
    let page_kind = match kind {
        "decision" => "decision",
        "constraint" => "rule",
        "finding" | "file" | "note" => "fact",
        _ => return Err("Tipo de memória desconhecido.".into()),
    };
    let slug = key.to_ascii_lowercase().chars().map(|ch| {
        if ch.is_ascii_alphanumeric() { ch } else { '-' }
    }).collect::<String>().split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
    let digest = Sha256::digest(key.as_bytes());
    let suffix = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let page = format!("{}-{suffix}.md", if slug.is_empty() { "memory" } else { &slug });
    let path = if let Some(mission_id) = mission_id {
        if mission_id.is_empty() || mission_id.len() > 128 || mission_id.chars().any(char::is_control) {
            return Err("O id da missão é inválido para separar a memória.".into());
        }
        let mission_slug = mission_id.to_ascii_lowercase().chars().map(|ch| {
            if ch.is_ascii_alphanumeric() { ch } else { '-' }
        }).collect::<String>().split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
        let mission_digest = Sha256::digest(mission_id.as_bytes());
        let mission_suffix = mission_digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let directory = if mission_slug.is_empty() { mission_suffix } else { format!("{}-{mission_suffix}", mission_slug) };
        format!("ade-ags/mission-{directory}/{page}")
    } else {
        // Mantém o caminho antigo das memórias de workspace.
        format!("ade-ags/{page}")
    };
    let tags: Vec<String> = tags.iter().filter(|tag| {
        !tag.is_empty() && tag.len() <= 96 && !tag.chars().any(char::is_control) && !tag.chars().any(char::is_whitespace)
    }).cloned().collect();
    let page_body = if let Some(reason) = reason { format!("{body}\n\nMotivo: {reason}") } else { body };
    Ok(PreparedAgentWrite { path, title: key, kind: page_kind, tags, body: page_body.into_bytes() })
}

fn write_prepared_agent_memory(
    client: &Client,
    workspace: &str,
    project: &str,
    prepared: PreparedAgentWrite,
) -> Result<(), String> {
    let write = super::client::PageWrite {
        path: &prepared.path,
        title: &prepared.title,
        kind: prepared.kind,
        tags: &prepared.tags,
        pinned: false,
    };
    client.write_scoped_page(&write, prepared.body, workspace, project)
}

/// Entrada de teste que mantém o mesmo validador e cliente, injetando apenas cliente e escopo.
#[cfg(test)]
pub(super) fn write_agent_memory_with_scope(
    client: &Client,
    workspace: &str,
    project: &str,
    key: &str,
    kind: &str,
    body: &str,
    tags: &[String],
    reason: Option<&str>,
) -> Result<(), String> {
    let prepared = prepare_agent_write(key, None, kind, body, tags, reason)?;
    write_prepared_agent_memory(client, workspace, project, prepared)
}

/// Entrada de teste para a escrita do usuário no ai-memory, preservando validação, preferência e escopo.
#[cfg(test)]
pub(super) fn write_user_memory_with_scope(
    db: &DbConnection,
    client: &Client,
    workspace: &str,
    project: &str,
    mission_id: Option<&str>,
    key: &str,
    kind: &str,
    body: &str,
    reason: Option<&str>,
) -> Result<String, String> {
    if !memory_enabled(db) {
        return Err("O ai-memory está desativado nas configurações.".into());
    }
    super::sessions::validate_scope(workspace, project)?;
    if super::scoped_bridge::reserved_project(project) {
        return Err("Projeto reservado não permitido.".into());
    }
    let mission_id = mission_id.map(str::trim).filter(|id| !id.is_empty());
    let tags = user_write_tags(mission_id);
    let prepared = prepare_agent_write(key, mission_id, kind, body, &tags, reason)?;
    let path = prepared.path.clone();
    write_prepared_agent_memory(client, workspace, project, prepared)?;
    Ok(path)
}

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
    workspace: Option<String>,
    project: Option<String>,
) -> Result<Untrusted<Vec<SearchHit>>, String> {
    let read = match (workspace, project) {
        (Some(workspace), Some(project)) => Read::SearchScoped {
            query,
            workspace,
            project,
        },
        (None, None) => Read::Search(query),
        _ => return Err("Informe workspace e project juntos para filtrar a busca.".into()),
    };
    blocking(move || Client::installed(&cwd)?.read(read)).await
}

#[tauri::command]
pub async fn ai_memory_read_page(cwd: String, path: String) -> Result<Untrusted<Page>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Page(path))).await
}

#[tauri::command]
pub async fn ai_memory_renew_page(cwd: String, path: String) -> Result<Untrusted<Page>, String> {
    blocking(move || Client::installed(&cwd)?.renew_page(&path, false)).await
}

#[tauri::command]
pub async fn ai_memory_pin_page(cwd: String, path: String) -> Result<Untrusted<Page>, String> {
    blocking(move || Client::installed(&cwd)?.renew_page(&path, true)).await
}

#[tauri::command]
pub async fn ai_memory_disable_forget_sweep(cwd: String) -> Result<ForgetSweepStatus, String> {
    blocking(move || Client::installed(&cwd)?.disable_forget_sweep()).await
}

#[tauri::command]
pub async fn ai_memory_projects(cwd: String) -> Result<Untrusted<Vec<Project>>, String> {
    blocking(move || Client::installed(&cwd)?.read(Read::Projects)).await
}

#[tauri::command]
pub async fn ai_memory_sessions(
    cwd: String,
    workspace: String,
    project: String,
) -> Result<Untrusted<Vec<Session>>, String> {
    super::sessions::validate_scope(&workspace, &project)?;
    // A pasta da aba, como nas outras leituras: não a do processo do app (que no Dock é `/`).
    let client = blocking(move || {
        let client = Client::installed(&cwd)?;
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
    cwd: Option<String>,
    db: tauri::State<'_, DbConnection>,
) -> Result<MigrationSummary, String> {
    let db = db.inner().clone();
    blocking(move || {
        migracao::migrate(&db, &workspace_id, path_env::find_program("ai-memory"), cwd.as_deref())
    })
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

/// Grava uma memória do usuário diretamente no ai-memory do projeto resolvido pela pasta atual.
/// Nunca aceita workspace ou projeto vindos do frontend; aplica filtro de segredos.
#[tauri::command]
pub async fn ai_memory_write_user(
    cwd: String,
    mission_id: Option<String>,
    key: String,
    kind: String,
    body: String,
    reason: Option<String>,
    db: tauri::State<'_, DbConnection>,
) -> Result<String, String> {
    let db = db.inner().clone();
    blocking(move || {
        write_user_memory_in_db(
            &db,
            &cwd,
            mission_id.as_deref(),
            &key,
            &kind,
            &body,
            reason.as_deref(),
        )
    })
    .await
}
