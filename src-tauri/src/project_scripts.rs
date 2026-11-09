//! Comandos locais de projeto. O texto fica exclusivamente no chaveiro do sistema.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Emitter, async_runtime};
use tokio::io::AsyncReadExt;

const SERVICE_PREFIX: &str = "ade-ags.project-scripts";
const MAX_PROJECT_PATH: usize = 4096;
const MAX_SCRIPT_ID: usize = 128;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const CHUNK_BYTES: usize = 1800;
const MAX_CHUNKS: usize = 8;
static KEYRING_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const RUN_OUTPUT_EVENT: &str = "cc-project-script-output";
const RUN_FINISHED_EVENT: &str = "cc-project-script-finished";
const MAX_RUN_OUTPUT_BYTES: usize = 256 * 1024;

struct RunningProjectScript {
    group: Mutex<crate::terminal::containment::ProcessGroup>,
    cancelled: AtomicBool,
}

#[derive(Clone)]
struct RunningProjectScriptRef(Arc<RunningProjectScript>);

fn running_scripts() -> &'static Mutex<HashMap<String, RunningProjectScriptRef>> {
    static RUNS: OnceLock<Mutex<HashMap<String, RunningProjectScriptRef>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptOutputPayload {
    run_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptFinishedPayload {
    run_id: String,
    code: Option<i32>,
    cancelled: bool,
    error: Option<String>,
}

fn lock_keyring() -> Result<MutexGuard<'static, ()>, String> {
    KEYRING_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "O acesso ao chaveiro foi interrompido".into())
}

#[derive(Serialize, Deserialize)]
struct StoredScriptRef {
    version: String,
    chunks: usize,
}

fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn namespace(cwd: &str, id: &str) -> Result<(String, String), String> {
    if cwd.trim().is_empty() || cwd.len() > MAX_PROJECT_PATH || cwd.contains('\0') {
        return Err("A pasta do projeto está inválida".into());
    }
    if id.is_empty()
        || id.len() > MAX_SCRIPT_ID
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("O identificador da ação está inválido".into());
    }
    let data_dir = crate::util::datadir::ags_home()
        .ok_or("Não foi possível identificar os dados desta instância")?;
    let service = format!("{SERVICE_PREFIX}.{}", digest(&data_dir.to_string_lossy()));
    let normalized_cwd = cwd.replace('\\', "/");
    let normalized_cwd = if normalized_cwd == "/" || normalized_cwd.ends_with(":/") {
        normalized_cwd
    } else {
        normalized_cwd.trim_end_matches('/').to_owned()
    };
    let account = format!("{}:{id}", digest(&normalized_cwd));
    Ok((service, account))
}

fn key(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account)
        .map_err(|_| "O chaveiro do sistema não está disponível".into())
}

fn meta(service: &str, account: &str) -> Result<keyring::Entry, String> {
    key(service, &format!("{account}:active"))
}

fn part(
    service: &str,
    account: &str,
    version: &str,
    index: usize,
) -> Result<keyring::Entry, String> {
    key(service, &format!("{account}:{version}:{index}"))
}

fn read_ref(service: &str, account: &str) -> Result<Option<StoredScriptRef>, String> {
    match meta(service, account)?.get_password() {
        Ok(raw) => {
            let stored: StoredScriptRef = serde_json::from_str(&raw)
                .map_err(|_| "A referência da ação no chaveiro está inválida".to_string())?;
            if stored.version.is_empty()
                || stored.version.len() > 128
                || !stored
                    .version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || stored.chunks == 0
                || stored.chunks > MAX_CHUNKS
            {
                return Err("A referência da ação no chaveiro está inválida".into());
            }
            Ok(Some(stored))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Não foi possível acessar a ação no chaveiro do sistema".into()),
    }
}

fn delete_version(service: &str, account: &str, stored: &StoredScriptRef) {
    for index in 0..stored.chunks {
        if let Ok(entry) = part(service, account, &stored.version, index) {
            let _ = entry.delete_credential();
        }
    }
}

fn split_chunks(command: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in command.chars() {
        if !current.is_empty() && current.len() + character.len_utf8() > CHUNK_BYTES {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn validate_command(command: &str) -> Result<&str, String> {
    let command = command.trim();
    if command.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
        return Err("O comando está vazio ou excede o limite de 8 KiB".into());
    }
    Ok(command)
}

fn project_script_shell(command: &str) -> std::process::Command {
    #[cfg(unix)]
    {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut process = crate::util::spawn::hidden_command(shell);
        process.args(["-l", "-c", command]);
        process
    }
    #[cfg(windows)]
    {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut process = crate::util::spawn::hidden_command(shell);
        process.args(["/D", "/S", "/C", command]);
        process
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
        crate::util::spawn::hidden_command("sh")
    }
}

async fn forward_script_output<R>(
    mut reader: R,
    app: AppHandle,
    run_id: String,
    output_budget: Arc<AtomicUsize>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let mut used = output_budget.load(Ordering::Relaxed);
                let allowed = loop {
                    let available = MAX_RUN_OUTPUT_BYTES.saturating_sub(used);
                    if available == 0 {
                        break 0;
                    }
                    let allowed = size.min(available);
                    match output_budget.compare_exchange_weak(
                        used,
                        used + allowed,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break allowed,
                        Err(actual) => used = actual,
                    }
                };
                if allowed > 0 {
                    let data = String::from_utf8_lossy(&buffer[..allowed]).into_owned();
                    let _ = app.emit(
                        RUN_OUTPUT_EVENT,
                        ScriptOutputPayload {
                            run_id: run_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
    }
}

fn load_command_locked(cwd: &str, id: &str) -> Result<Option<String>, String> {
    let (service, account) = namespace(cwd, id)?;
    let Some(stored) = read_ref(&service, &account)? else {
        return Ok(None);
    };
    let mut command = String::new();
    for index in 0..stored.chunks {
        let chunk = part(&service, &account, &stored.version, index)?
            .get_password()
            .map_err(|_| {
                "Uma parte da ação não está disponível no chaveiro do sistema".to_string()
            })?;
        command.push_str(&chunk);
        if command.len() > MAX_COMMAND_BYTES {
            return Err("O comando no chaveiro excede o limite de 8 KiB".into());
        }
    }
    Ok(Some(command))
}

/// Inicia um processo descartável para uma ação opt-in. Ele não compartilha nem escreve em PTYs de conversa.
#[tauri::command]
pub async fn chat_project_script_run_start(
    source_cwd: String,
    execution_cwd: String,
    id: String,
    run_id: String,
    app: AppHandle,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&run_id).is_err() {
        return Err("O identificador desta execução está inválido".into());
    }
    if execution_cwd.trim().is_empty()
        || execution_cwd.len() > MAX_PROJECT_PATH
        || execution_cwd.contains('\0')
    {
        return Err("A pasta de execução está inválida".into());
    }
    if !std::path::Path::new(&execution_cwd).is_dir() {
        return Err("A pasta de execução não existe mais".into());
    }
    let command = async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        load_command_locked(&source_cwd, &id)?
            .ok_or_else(|| "A ação não existe no chaveiro do sistema".to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let command = validate_command(&command)?.to_owned();

    let mut group =
        crate::terminal::containment::ProcessGroup::new(uuid::Uuid::new_v4().as_u128() as u32);
    let mut process = project_script_shell(&command);
    process
        .current_dir(&execution_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::terminal::scrub_app_child_env(&mut process);
    let mut process = crate::util::spawn::into_tokio(process);
    process.kill_on_drop(true);
    let mut child = process
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar a ação: {error}"))?;
    group.adopt(&child);
    let output = child
        .stdout
        .take()
        .ok_or("A saída da ação ficou indisponível")?;
    let error_output = child
        .stderr
        .take()
        .ok_or("A saída de erro da ação ficou indisponível")?;
    let control = RunningProjectScriptRef(Arc::new(RunningProjectScript {
        group: Mutex::new(group),
        cancelled: AtomicBool::new(false),
    }));
    {
        let mut runs = running_scripts()
            .lock()
            .map_err(|_| "O registro de ações está indisponível".to_string())?;
        if runs.contains_key(&run_id) {
            if let Ok(mut group) = control.0.group.lock() {
                group.kill_all();
            }
            return Err("Esta ação já está em execução".into());
        }
        runs.insert(run_id.clone(), control.clone());
    }

    let output_budget = Arc::new(AtomicUsize::new(0));
    let app_output = app.clone();
    let output_id = run_id.clone();
    let mut stdout_task = async_runtime::spawn(forward_script_output(
        output,
        app_output,
        output_id,
        output_budget.clone(),
    ));
    let mut stderr_task = async_runtime::spawn(forward_script_output(
        error_output,
        app.clone(),
        run_id.clone(),
        output_budget,
    ));
    async_runtime::spawn(async move {
        let status = child.wait().await;
        // Um hook é one-shot: não deixamos filhos em background sem um identificador ou cancelamento.
        if let Ok(mut group) = control.0.group.lock() {
            group.kill_all();
        }
        let readers_drained = tokio::time::timeout(std::time::Duration::from_millis(750), async {
            let _ = (&mut stdout_task).await;
            let _ = (&mut stderr_task).await;
        })
        .await
        .is_ok();
        if !readers_drained {
            // No macOS um descendente pode escapar da árvore por PPID e manter os pipes abertos.
            // Não deixamos isso prender o registro nem impedir o evento de conclusão.
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
        }
        let mut error = status.as_ref().err().map(ToString::to_string);
        if !readers_drained {
            error.get_or_insert_with(|| {
                "Um processo filho manteve a saída aberta após o encerramento da ação".into()
            });
        }
        let payload = ScriptFinishedPayload {
            run_id: run_id.clone(),
            code: status
                .as_ref()
                .ok()
                .and_then(std::process::ExitStatus::code),
            cancelled: control.0.cancelled.load(Ordering::SeqCst),
            error,
        };
        if let Ok(mut runs) = running_scripts().lock() {
            runs.remove(&run_id);
        }
        let _ = app.emit(RUN_FINISHED_EVENT, payload);
    });
    Ok(())
}

/// Cancela só o grupo de processos da ação identificada, nunca o PTY de uma conversa.
#[tauri::command]
pub fn chat_project_script_run_cancel(run_id: String) -> Result<(), String> {
    let run = running_scripts()
        .lock()
        .map_err(|_| "O registro de ações está indisponível".to_string())?
        .get(&run_id)
        .cloned()
        .ok_or("Esta ação já terminou")?;
    run.0.cancelled.store(true, Ordering::SeqCst);
    run.0
        .group
        .lock()
        .map_err(|_| "O cancelamento da ação foi interrompido".to_string())?
        .kill_all();
    Ok(())
}

/// Lê o comando somente quando a pessoa pede para editar ou executar a ação.
#[tauri::command]
pub async fn chat_project_script_get(cwd: String, id: String) -> Result<Option<String>, String> {
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        load_command_locked(&cwd, &id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Guarda o comando em blocos no chaveiro. A nova versão só fica ativa depois que todos os blocos foram escritos.
#[tauri::command]
pub async fn chat_project_script_save(
    cwd: String,
    id: String,
    command: String,
) -> Result<(), String> {
    let command = validate_command(&command)?.to_owned();
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let (service, account) = namespace(&cwd, &id)?;
        let previous = read_ref(&service, &account)?;
        let chunks = split_chunks(&command);
        if chunks.is_empty() || chunks.len() > MAX_CHUNKS {
            return Err("O comando excede o limite de armazenamento seguro".into());
        }
        let version = uuid::Uuid::new_v4().to_string();
        for (index, chunk) in chunks.iter().enumerate() {
            if part(&service, &account, &version, index)?
                .set_password(chunk)
                .is_err()
            {
                delete_version(
                    &service,
                    &account,
                    &StoredScriptRef {
                        version: version.clone(),
                        chunks: index + 1,
                    },
                );
                return Err("Não foi possível guardar o comando no chaveiro do sistema".into());
            }
        }
        let next = StoredScriptRef {
            version,
            chunks: chunks.len(),
        };
        let encoded = serde_json::to_string(&next)
            .map_err(|_| "Não foi possível preparar a referência da ação".to_string())?;
        if meta(&service, &account)?.set_password(&encoded).is_err() {
            delete_version(&service, &account, &next);
            return Err("Não foi possível ativar a ação no chaveiro do sistema".into());
        }
        if let Some(previous) = previous {
            delete_version(&service, &account, &previous);
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Remove a referência antes dos blocos, para que falha parcial nunca deixe a ação utilizável.
#[tauri::command]
pub async fn chat_project_script_delete(cwd: String, id: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let (service, account) = namespace(&cwd, &id)?;
        let Some(stored) = read_ref(&service, &account)? else {
            return Ok(());
        };
        match meta(&service, &account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Não foi possível remover a ação do chaveiro do sistema".into()),
        }
        delete_version(&service, &account, &stored);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
