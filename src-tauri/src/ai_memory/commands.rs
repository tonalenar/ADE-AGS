use super::{
    client::{Client, PageWrite, Read},
    migracao::{self, MigrationRow, MigrationSummary},
    types::*,
};
use crate::database::DbConnection;
use crate::util::path_env;
use sha2::{Digest, Sha256};

/// Lê o contexto durável do projeto da pasta sem tocar o banco da ADE.
pub(crate) fn project_context(cwd: &str, query: &str) -> Result<Option<String>, String> {
    let client = Client::installed(cwd)?;
    let scope = project_scope(&client, cwd)?;
    client.project_context(query, &scope.0, &scope.1)
}

fn project_scope(client: &Client, cwd: &str) -> Result<(String, String), String> {
    let scope = super::marker::scope(std::path::Path::new(cwd), dirs::home_dir().as_deref())
        .or_else(|| {
            let projects = client.read::<Vec<Project>>(Read::Projects).ok()?.data;
            let project = super::tabs::unique_project(&projects, std::path::Path::new(cwd))?;
            Some((project.workspace_name.clone(), project.project_name.clone()))
        });
    let Some((workspace, project)) = scope else {
        return Err("Não foi possível resolver o escopo do projeto no ai-memory.".into());
    };
    super::sessions::validate_scope(&workspace, &project)?;
    Ok((workspace, project))
}

/// Grava memória escrita por um agente no projeto resolvido pelo marcador ou pasta única.
/// O detector rígido é compartilhado com as propostas antigas; segredos são recusados antes do binário.
pub(crate) fn write_agent_memory(
    cwd: &str,
    key: &str,
    kind: &str,
    body: &str,
    tags: &[String],
    reason: Option<&str>,
) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 128 || body.trim().is_empty() || body.len() > 16 * 1024 {
        return Err("Informe uma chave e um corpo de memória dentro dos limites.".into());
    }
    if [key, body, reason.unwrap_or("")].iter().any(|text| crate::memory::agent::looks_like_secret(text)) {
        return Err(crate::memory::agent::secret_confirmation_error());
    }
    let client = Client::installed(cwd)?;
    let _scope = project_scope(&client, cwd)?;
    write_agent_memory_with_client(&client, key, kind, body, tags, reason)
}

fn write_agent_memory_with_client(
    client: &Client,
    key: &str,
    kind: &str,
    body: &str,
    tags: &[String],
    reason: Option<&str>,
) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 128 || body.trim().is_empty() || body.len() > 16 * 1024 {
        return Err("Informe uma chave e um corpo de memória dentro dos limites.".into());
    }
    if [key, body, reason.unwrap_or("")].iter().any(|text| crate::memory::agent::looks_like_secret(text)) {
        return Err(crate::memory::agent::secret_confirmation_error());
    }
    let slug = key.to_ascii_lowercase().chars().map(|ch| {
        if ch.is_ascii_alphanumeric() { ch } else { '-' }
    }).collect::<String>().split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        return Err("A chave precisa ter ao menos uma letra ou número ASCII.".into());
    }
    let page_kind = match kind {
        "decision" => "decision",
        "constraint" => "rule",
        "finding" | "file" | "note" | "fact" => "fact",
        _ => return Err("Tipo de memória desconhecido.".into()),
    };
    let key_hash = Sha256::digest(key.as_bytes());
    let suffix = key_hash[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let path = format!("ade-ags/{slug}-{suffix}.md");
    let write = PageWrite {
        path: &path,
        title: key,
        kind: page_kind,
        tags,
        pinned: false,
    };
    write.check()?;
    client.write_page(&write, body.as_bytes().to_vec())
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

#[cfg(all(test, unix))]
mod test {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    struct Fake {
        root: PathBuf,
        cwd: PathBuf,
        client: Client,
    }

    impl Fake {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ade-ai-memory-write-{}", uuid::Uuid::new_v4()));
            let cwd = root.join("project");
            fs::create_dir_all(&cwd).unwrap();
            fs::write(cwd.join(".ai-memory.toml"), "workspace = \"team\"\nproject = \"ADE-AGS\"\n").unwrap();
            let program = root.join("fake-ai-memory");
            fs::write(&program, format!(
                "#!/bin/sh\n[ \"$AI_MEMORY_RUN_AUTOWIRE\" = false ] || exit 70\n[ \"$AI_MEMORY_EMBEDDING_PROVIDER\" = none ] || exit 71\n[ \"$AI_MEMORY_HOST_CWD\" -ef \"$PWD\" ] || exit 72\nprintf '%s\\n' \"$@\" > '{}/argv'\ncat > '{}/body'\n",
                root.display(), root.display()
            )).unwrap();
            fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
            let client = Client::at(Some(program), cwd.clone()).unwrap();
            Self { root, cwd, client }
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn escrita_de_agente_usa_o_binario_ai_memory_e_escopo_do_marcador() {
        let fake = Fake::new();
        let scope = project_scope(&fake.client, fake.cwd.to_str().unwrap()).unwrap();
        assert_eq!(scope, ("team".into(), "ADE-AGS".into()));
        write_agent_memory_with_client(&fake.client, "arquitetura", "decision", "Usar filas locais", &["ade-ags".into()], None).unwrap();
        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.starts_with("write-page\n"));
        assert!(argv.contains("--path=ade-ags/arquitetura-"));
        assert_eq!(fs::read_to_string(fake.root.join("body")).unwrap(), "Usar filas locais");
    }

    #[test]
    fn filtro_recusa_segredos_antes_de_chamar_o_binario() {
        let fake = Fake::new();
        let error = write_agent_memory_with_client(&fake.client, "token", "note", "token: sk-abcdefghijklmnopqrstuv", &[], None).unwrap_err();
        assert!(error.contains(crate::memory::agent::SECRET_CONFIRMATION_CODE));
        assert!(!fake.root.join("argv").exists());
    }
}
