//! Comandos da interface para tarefas agendadas do chat estruturado.
//!
//! Não há rota CLI/MCP de criação nesta primeira versão: tarefas persistentes só são criadas
//! e geridas pela pessoa na interface. O disparo usa a API normal do chat e revalida a política.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Local};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::conversa::{
    api,
    envio::{SendError, SendMode},
};
use crate::database::DbConnection;
use crate::routines::Schedule;
use crate::scheduled_tasks::{self, ScheduledTask, TaskDraft, TaskRun, TaskView};

pub const CHANGED_EVENT: &str = "cc-scheduled-tasks-changed";

lazy_static::lazy_static! {
    /// Impede que um tick e o botão "executar agora" disparem a mesma tarefa em paralelo.
    static ref IN_FLIGHT: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
    let _ = app.emit(crate::missions::automation::CHANGED_EVENT, ());
}

fn clean_optional(
    value: Option<String>,
    field: &str,
    max: usize,
) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("O campo {field} está inválido."));
    }
    Ok(Some(value))
}

fn workspace_for(db: &DbConnection, thread_id: &str) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    crate::conversa::store::thread_workspace_id(&conn, thread_id).map_err(|error| error.to_string())
}

fn workspace_exists(db: &DbConnection, workspace_id: Option<&str>) -> Result<(), String> {
    let Some(workspace_id) = workspace_id else {
        return Ok(());
    };
    let conn = db.lock().map_err(|error| error.to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL)",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("O workspace escolhido não existe mais.".into());
    }
    Ok(())
}

fn project_path(raw: &str) -> Result<String, String> {
    let path = raw.trim();
    if path.is_empty() || path.len() > 4096 || path.contains('\0') || !Path::new(path).is_absolute()
    {
        return Err("A pasta do projeto precisa ser um caminho absoluto válido.".into());
    }
    if !Path::new(path).is_dir() {
        return Err("A pasta do projeto não existe ou não é uma pasta.".into());
    }
    Ok(path.to_owned())
}

fn validate_project_agent(db: &DbConnection, cwd: &str, agent_id: &str) -> Result<(), String> {
    if !api::structured_agent(agent_id) {
        return Err(format!(
            "{agent_id} não está disponível no chat estruturado."
        ));
    }
    let conn = db.lock().map_err(|error| error.to_string())?;
    crate::project_chat_policy::ensure_agent_enabled(&conn, cwd, agent_id)
}

/// Valida a configuração e, quando o alvo é uma conversa existente, impede que o draft altere
/// silenciosamente a pasta, o provedor, o modelo ou o workspace que essa conversa já usa.
fn resolve_draft(
    db: &DbConnection,
    mut draft: TaskDraft,
    now: DateTime<Local>,
    preserve_expired_once: bool,
) -> Result<(TaskDraft, String), String> {
    draft.name = crate::routines::clean_name(&draft.name)?;
    draft.prompt = scheduled_tasks::clean_prompt(&draft.prompt)?;
    draft.model = clean_optional(draft.model, "modelo", 128)?;
    draft.effort = clean_optional(draft.effort, "esforço", 64)?;
    if !preserve_expired_once || !is_expired_once(&draft.schedule, now) {
        draft.schedule = scheduled_tasks::validate_schedule(draft.schedule, now)?;
    }

    if let Some(thread_id) = draft
        .existing_thread_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
    {
        let row = api::thread(db, thread_id)?;
        let workspace_id = workspace_for(db, thread_id)?;
        if draft.agent_id != row.agent_id
            || draft.cwd != row.cwd
            || draft.model != row.model
            || draft.effort != row.effort
        {
            return Err("Os dados do draft não correspondem à conversa existente. Atualize a seleção e tente novamente.".into());
        }
        validate_project_agent(db, &row.cwd, &row.agent_id)?;
        draft.agent_id = row.agent_id.clone();
        draft.cwd = row.cwd.clone();
        draft.model = row.model.clone();
        draft.effort = row.effort.clone();
        draft.workspace_id = workspace_id;
        return Ok((draft, row.access));
    }

    draft.existing_thread_id = None;
    draft.cwd = project_path(&draft.cwd)?;
    validate_project_agent(db, &draft.cwd, &draft.agent_id)?;
    workspace_exists(db, draft.workspace_id.as_deref())?;
    Ok((draft, "ask".into()))
}

fn is_expired_once(schedule: &Schedule, now: DateTime<Local>) -> bool {
    matches!(schedule, Schedule::Once { at } if *at <= now.timestamp())
}

fn can_preserve_expired_once(
    task: &ScheduledTask,
    requested_schedule: &Schedule,
    now: DateTime<Local>,
) -> bool {
    !task.enabled
        && &task.schedule == requested_schedule
        && is_expired_once(requested_schedule, now)
}

fn to_view(task: &ScheduledTask) -> TaskView {
    TaskView::from(task)
}

fn ensure_unique_name(
    tasks: &[ScheduledTask],
    name: &str,
    except: Option<&str>,
) -> Result<(), String> {
    if tasks
        .iter()
        .any(|task| Some(task.id.as_str()) != except && task.name.eq_ignore_ascii_case(name))
    {
        return Err(format!("Já existe uma tarefa chamada '{}'.", name));
    }
    Ok(())
}

fn claim(id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id.to_owned())
}

fn release(id: &str) {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(id);
}

#[tauri::command]
pub fn scheduled_task_list() -> Result<Vec<TaskView>, String> {
    Ok(scheduled_tasks::all()?.iter().map(to_view).collect())
}

#[tauri::command]
pub fn scheduled_task_create(
    app: AppHandle,
    db: State<'_, DbConnection>,
    input: TaskDraft,
) -> Result<TaskView, String> {
    let db = db.inner().clone();
    let now = Local::now();
    let (input, access) = resolve_draft(&db, input, now, false)?;
    let created = scheduled_tasks::update(|tasks| {
        if tasks.len() >= scheduled_tasks::MAX_TASKS {
            return Err(format!(
                "O limite é de {} tarefas agendadas.",
                scheduled_tasks::MAX_TASKS
            ));
        }
        ensure_unique_name(tasks, &input.name, None)?;
        let now_ms = crate::util::now_ts_ms();
        let task = ScheduledTask {
            id: scheduled_tasks::new_id(),
            name: input.name,
            prompt: input.prompt,
            agent_id: input.agent_id,
            model: input.model,
            effort: input.effort,
            cwd: input.cwd,
            workspace_id: input.workspace_id,
            existing_thread_id: input.existing_thread_id,
            access,
            next_run: scheduled_tasks::next_run(&input.schedule, now),
            schedule: input.schedule,
            enabled: true,
            armed_at_ms: now_ms,
            created_at: now.timestamp(),
            updated_at: now.timestamp(),
            history: Vec::new(),
        };
        tasks.push(task.clone());
        Ok(task)
    })?;
    changed(&app);
    Ok(to_view(&created))
}

#[tauri::command]
pub fn scheduled_task_update(
    app: AppHandle,
    db: State<'_, DbConnection>,
    id: String,
    input: TaskDraft,
) -> Result<TaskView, String> {
    let db = db.inner().clone();
    let now = Local::now();
    let existing = scheduled_tasks::all()?
        .into_iter()
        .find(|task| task.id == id)
        .ok_or("A tarefa não existe mais.")?;
    let preserve_expired_once = can_preserve_expired_once(&existing, &input.schedule, now);
    let (input, access) = resolve_draft(&db, input, now, preserve_expired_once)?;
    if !claim(&id) {
        return Err("A tarefa está em execução; aguarde antes de editá-la.".into());
    }
    let update_result = scheduled_tasks::update(|tasks| {
        ensure_unique_name(tasks, &input.name, Some(&id))?;
        let task = tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or("A tarefa não existe mais.")?;
        if preserve_expired_once && !can_preserve_expired_once(task, &input.schedule, now) {
            return Err("A tarefa ou sua agenda mudou; atualize a lista antes de editar.".into());
        }
        let was_enabled = task.enabled;
        task.name = input.name;
        task.prompt = input.prompt;
        task.agent_id = input.agent_id;
        task.model = input.model;
        task.effort = input.effort;
        task.cwd = input.cwd;
        task.workspace_id = input.workspace_id;
        task.existing_thread_id = input.existing_thread_id;
        task.access = access;
        task.schedule = input.schedule;
        task.enabled = was_enabled;
        task.next_run = if was_enabled {
            scheduled_tasks::next_run(&task.schedule, now)
        } else {
            None
        };
        task.updated_at = now.timestamp();
        Ok(task.clone())
    });
    release(&id);
    let updated = update_result?;
    changed(&app);
    Ok(to_view(&updated))
}

#[tauri::command]
pub fn scheduled_task_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<TaskView, String> {
    if !claim(&id) {
        return Err("A tarefa está em execução; aguarde antes de alterá-la.".into());
    }
    let now = Local::now();
    let update_result = scheduled_tasks::update(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or("A tarefa não existe mais.")?;
        let next_run = if enabled {
            scheduled_tasks::next_run(&task.schedule, now)
        } else {
            None
        };
        if enabled && next_run.is_none() {
            return Err(
                "O horário desta tarefa já passou. Edite a tarefa para escolher um novo horário."
                    .into(),
            );
        }
        task.enabled = enabled;
        task.armed_at_ms = crate::util::now_ts_ms();
        task.next_run = next_run;
        task.updated_at = now.timestamp();
        Ok(task.clone())
    });
    release(&id);
    let updated = update_result?;
    changed(&app);
    Ok(to_view(&updated))
}

#[tauri::command]
pub async fn scheduled_task_run_now(
    app: AppHandle,
    db: State<'_, DbConnection>,
    id: String,
) -> Result<TaskRun, String> {
    if !claim(&id) {
        return Err("A tarefa já está em execução.".into());
    }
    let db = db.inner().clone();
    let result = execute(&app, &db, &id, None, true).await;
    release(&id);
    result
}

#[tauri::command]
pub fn scheduled_task_delete(app: AppHandle, id: String) -> Result<bool, String> {
    if !claim(&id) {
        return Err("A tarefa está em execução; aguarde antes de removê-la.".into());
    }
    let remove_result = scheduled_tasks::update(|tasks| {
        let before = tasks.len();
        tasks.retain(|task| task.id != id);
        Ok(before != tasks.len())
    });
    release(&id);
    let removed = remove_result?;
    if removed {
        changed(&app);
    }
    Ok(removed)
}

#[tauri::command]
pub fn scheduled_task_history(task_id: String) -> Result<Vec<TaskRun>, String> {
    let task = scheduled_tasks::all()?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or("A tarefa não existe mais.")?;
    Ok(task.history.into_iter().rev().collect())
}

/// Chamado no mesmo tick já existente das rotinas; não cria um segundo scheduler.
pub(crate) fn scheduler_tick(app: &AppHandle, gate: crate::missions::automation::Gate, now: i64) {
    let tasks = match scheduled_tasks::all() {
        Ok(tasks) => tasks,
        Err(error) => {
            eprintln!("[tarefas agendadas] não foi possível ler o sidecar: {error}");
            return;
        }
    };
    for task in tasks {
        let Some(scheduled_for) = task.next_run.filter(|at| *at <= now) else {
            continue;
        };
        if !task.enabled || gate.pauses(task.armed_at_ms) || !claim(&task.id) {
            continue;
        }
        let id = task.id.clone();
        let app = app.clone();
        let db = app
            .try_state::<DbConnection>()
            .map(|state| state.inner().clone());
        std::thread::spawn(move || {
            let Some(db) = db else {
                if let Err(error) = record_unavailable(
                    &app,
                    &id,
                    scheduled_for,
                    "O banco de dados estava indisponível; o dispatch não foi iniciado.",
                ) {
                    eprintln!("[tarefas agendadas] falha ao registrar {id}: {error}");
                }
                release(&id);
                return;
            };
            let result =
                tauri::async_runtime::block_on(execute(&app, &db, &id, Some(scheduled_for), false));
            if let Err(error) = result {
                eprintln!("[tarefas agendadas] dispatch de {id} falhou: {error}");
            }
            release(&id);
        });
    }
}

fn record_unavailable(
    app: &AppHandle,
    task_id: &str,
    scheduled_for: i64,
    result: &str,
) -> Result<(), String> {
    let now = Local::now();
    scheduled_tasks::update(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("A tarefa não existe mais.")?;
        if !task.enabled || task.next_run != Some(scheduled_for) {
            return Ok(());
        }
        let run = TaskRun {
            id: scheduled_tasks::new_id(),
            task_id: task.id.clone(),
            cwd: task.cwd.clone(),
            agent_id: task.agent_id.clone(),
            model: task.model.clone(),
            scheduled_for: Some(scheduled_for),
            scheduled_at: now.timestamp(),
            finished_at: Some(now.timestamp()),
            status: "failed".into(),
            thread_id: task.existing_thread_id.clone(),
            result: result.to_owned(),
        };
        scheduled_tasks::push_history(task, run);
        task.updated_at = now.timestamp();
        match task.schedule {
            crate::routines::Schedule::Once { .. } => {
                task.enabled = false;
                task.next_run = None;
            }
            _ => task.next_run = scheduled_tasks::next_run(&task.schedule, now),
        }
        Ok(())
    })?;
    changed(app);
    Ok(())
}

async fn execute(
    app: &AppHandle,
    db: &DbConnection,
    task_id: &str,
    scheduled_for: Option<i64>,
    manual: bool,
) -> Result<TaskRun, String> {
    let now = Local::now();
    let run = TaskRun {
        id: scheduled_tasks::new_id(),
        task_id: task_id.to_owned(),
        cwd: String::new(),
        agent_id: String::new(),
        model: None,
        scheduled_for,
        scheduled_at: now.timestamp(),
        finished_at: None,
        status: "running".into(),
        thread_id: None,
        result: String::new(),
    };
    let (task, run) = scheduled_tasks::update(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("A tarefa não existe mais.")?;
        if let Some(scheduled_for) = scheduled_for {
            if !task.enabled || task.next_run != Some(scheduled_for) {
                return Err("O horário desta tarefa mudou antes do dispatch.".into());
            }
        }
        let mut run = run.clone();
        run.cwd = task.cwd.clone();
        run.agent_id = task.agent_id.clone();
        run.model = task.model.clone();
        run.thread_id = task.existing_thread_id.clone();
        scheduled_tasks::push_history(task, run.clone());
        Ok((task.clone(), run))
    })?;
    let run_id = run.id.clone();
    changed(app);

    let dispatch = dispatch(app, db, &task, &run_id).await;
    let finished = Local::now();
    let (status, thread_id, message) = match dispatch {
        Ok((thread_id, message)) => ("dispatched", Some(thread_id), message),
        Err((thread_id, error)) => ("failed", thread_id, error),
    };
    let message: String = message.chars().take(1000).collect();
    let completed = scheduled_tasks::update(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("A tarefa foi removida durante o dispatch.")?;
        let history = task
            .history
            .iter_mut()
            .find(|entry| entry.id == run_id)
            .ok_or("O histórico do dispatch não existe mais.")?;
        history.finished_at = Some(finished.timestamp());
        history.status = status.into();
        history.thread_id = thread_id.clone().or(history.thread_id.clone());
        history.result = message.clone();
        task.updated_at = finished.timestamp();
        if !manual {
            match task.schedule {
                crate::routines::Schedule::Once { .. } => {
                    task.enabled = false;
                    task.next_run = None;
                }
                _ => task.next_run = scheduled_tasks::next_run(&task.schedule, finished),
            }
        }
        Ok(history.clone())
    })?;
    changed(app);
    Ok(completed)
}

async fn dispatch(
    app: &AppHandle,
    db: &DbConnection,
    task: &ScheduledTask,
    run_id: &str,
) -> Result<(String, String), (Option<String>, String)> {
    let thread_id = if let Some(thread_id) = task.existing_thread_id.as_deref() {
        let row =
            api::thread(db, thread_id).map_err(|error| (Some(thread_id.to_owned()), error))?;
        let workspace_id =
            workspace_for(db, thread_id).map_err(|error| (Some(thread_id.to_owned()), error))?;
        if row.agent_id != task.agent_id
            || row.cwd != task.cwd
            || row.model != task.model
            || row.effort != task.effort
            || row.access != task.access
            || workspace_id != task.workspace_id
        {
            return Err((Some(thread_id.to_owned()), "A conversa mudou desde a criação da tarefa; edite a tarefa para confirmar a nova configuração.".into()));
        }
        validate_project_agent(db, &row.cwd, &row.agent_id)
            .map_err(|error| (Some(thread_id.to_owned()), error))?;
        thread_id.to_owned()
    } else {
        project_path(&task.cwd).map_err(|error| (None, error))?;
        let row = api::create(
            db,
            api::NewThread {
                agent_id: task.agent_id.clone(),
                cwd: task.cwd.clone(),
                workspace_id: task.workspace_id.clone(),
                title: task.name.clone(),
                model: task.model.clone(),
                effort: task.effort.clone(),
                access: "ask".into(),
                account_id: None,
                parent_ref: None,
            },
        )
        .map_err(|error| (None, error))?;
        api::announce(app, &row);
        record_thread_id(app, task.id.as_str(), run_id, &row.id)
            .map_err(|error| (Some(row.id.clone()), error))?;
        row.id.clone()
    };

    let framed = format!(
        "[Tarefa agendada '{}' via ADE AGS] {}",
        task.name, task.prompt
    );
    api::send_mode(app, db, &thread_id, &framed, SendMode::QueueAfterActive, &[])
        .await
        .map_err(|error: SendError| (Some(thread_id.clone()), match error {
            SendError::Busy => "A conversa está ocupada; o prompt não foi enviado e esta execução ficou como falha.".into(),
            other => other.to_string(),
        }))?;
    Ok((thread_id, "Prompt enviado à conversa estruturada.".into()))
}

fn record_thread_id(
    app: &AppHandle,
    task_id: &str,
    run_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    scheduled_tasks::update(|tasks| {
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("A tarefa não existe mais.")?;
        let run = task
            .history
            .iter_mut()
            .find(|run| run.id == run_id)
            .ok_or("O histórico do dispatch não existe mais.")?;
        run.thread_id = Some(thread_id.to_owned());
        Ok(())
    })?;
    changed(app);
    Ok(())
}
