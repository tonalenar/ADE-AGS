//! Tarefas agendadas do chat estruturado, separadas das rotinas que escrevem em abas TUI.
//!
//! O sidecar local guarda apenas a definição e o histórico de dispatch, nunca o transcript.
//! O scheduler reaproveitado fica em `ipc::commands::routine` e consulta este módulo no mesmo tick.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use crate::routines::{self, Schedule};

pub const MAX_TASKS: usize = 100;
const FILE_VERSION: u32 = 1;
const MAX_PROMPT_CHARS: usize = 12_000;
const MAX_SCHEDULE_HORIZON_SECS: i64 = 10 * 365 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub name: String,
    pub prompt: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: String,
    pub workspace_id: Option<String>,
    /// `None` cria uma conversa estruturada a cada execução; `Some` reutiliza esta conversa.
    pub existing_thread_id: Option<String>,
    pub schedule: Schedule,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: String,
    pub workspace_id: Option<String>,
    pub existing_thread_id: Option<String>,
    /// Acesso escolhido na criação; conversa nova sempre usa `ask`.
    pub access: String,
    pub schedule: Schedule,
    pub enabled: bool,
    pub next_run: Option<i64>,
    pub armed_at_ms: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub history: Vec<TaskRun>,
}

/// Forma exibida na lista; o histórico é carregado pelo comando próprio.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: String,
    pub workspace_id: Option<String>,
    pub existing_thread_id: Option<String>,
    pub access: String,
    pub schedule: Schedule,
    pub enabled: bool,
    pub next_run: Option<i64>,
    pub armed_at_ms: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub runs: usize,
    pub last_run: Option<i64>,
    pub last_result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub agent_id: String,
    pub model: Option<String>,
    pub scheduled_for: Option<i64>,
    /// Instante em que o dispatch começou, inclusive em execução manual.
    #[serde(default)]
    pub scheduled_at: i64,
    pub finished_at: Option<i64>,
    /// `running`, `dispatched`, `failed` ou `missed`.
    pub status: String,
    pub thread_id: Option<String>,
    /// Resultado curto do dispatch, nunca texto da conversa.
    pub result: String,
}

impl From<&ScheduledTask> for TaskView {
    fn from(task: &ScheduledTask) -> Self {
        Self {
            id: task.id.clone(),
            name: task.name.clone(),
            prompt: task.prompt.clone(),
            agent_id: task.agent_id.clone(),
            model: task.model.clone(),
            effort: task.effort.clone(),
            cwd: task.cwd.clone(),
            workspace_id: task.workspace_id.clone(),
            existing_thread_id: task.existing_thread_id.clone(),
            access: task.access.clone(),
            schedule: task.schedule.clone(),
            enabled: task.enabled,
            next_run: task.next_run,
            armed_at_ms: task.armed_at_ms,
            created_at: task.created_at,
            updated_at: task.updated_at,
            runs: task.history.len(),
            last_run: task.history.last().map(|run| run.scheduled_at),
            last_result: task.history.last().map(|run| run.result.clone()),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct TasksFile {
    version: u32,
    #[serde(default)]
    tasks: Vec<ScheduledTask>,
}

impl Default for TasksFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            tasks: Vec::new(),
        }
    }
}

lazy_static::lazy_static! {
    /// Serializa a leitura-modificação-gravação do sidecar entre comandos e o tick.
    static ref LOCK: Mutex<()> = Mutex::new(());
}

fn file_path() -> Result<PathBuf, String> {
    let dir = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("scheduled-tasks.json"))
}

fn read_file() -> Result<TasksFile, String> {
    let path = file_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TasksFile::default())
        }
        Err(error) => return Err(format!("Não foi possível ler {}: {error}", path.display())),
    };
    let file: TasksFile = serde_json::from_str(&raw)
        .map_err(|error| format!("O arquivo de tarefas agendadas está inválido: {error}"))?;
    if file.version != FILE_VERSION {
        return Err(format!(
            "Versão {} do arquivo de tarefas agendadas não é suportada.",
            file.version
        ));
    }
    Ok(file)
}

fn write_file(file: &TasksFile) -> Result<(), String> {
    let path = file_path()?;
    let tmp = path.with_file_name(format!(
        ".scheduled-tasks.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let body = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    let write_result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        file.write_all(&body)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "Não foi possível gravar {}: {error}",
            tmp.display()
        ));
    }
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "Não foi possível atualizar {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

pub fn all() -> Result<Vec<ScheduledTask>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    Ok(read_file()?.tasks)
}

pub fn update<T>(
    change: impl FnOnce(&mut Vec<ScheduledTask>) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read_file()?;
    let value = change(&mut file.tasks)?;
    file.version = FILE_VERSION;
    write_file(&file)?;
    Ok(value)
}

pub fn validate_schedule(schedule: Schedule, now: DateTime<Local>) -> Result<Schedule, String> {
    match schedule {
        Schedule::Every { secs } if secs < routines::MIN_EVERY_SECS => {
            Err("O intervalo mínimo de uma tarefa é de 5 minutos.".into())
        }
        Schedule::Every { secs } if secs > MAX_SCHEDULE_HORIZON_SECS => {
            Err("O intervalo máximo de uma tarefa é de 10 anos.".into())
        }
        Schedule::Every { secs } => Ok(Schedule::Every { secs }),
        Schedule::Daily {
            hour,
            minute,
            mut days,
        } => {
            if hour > 23 || minute > 59 {
                return Err("Horário inválido (00:00 a 23:59).".into());
            }
            if days.iter().any(|day| *day > 6) {
                return Err("Dia inválido: use 0 (segunda) a 6 (domingo).".into());
            }
            days.sort_unstable();
            days.dedup();
            Ok(Schedule::Daily { hour, minute, days })
        }
        Schedule::Once { at } => {
            if at < now.timestamp() + routines::MIN_IN_SECS {
                return Err(
                    "Escolha um horário no futuro, com pelo menos 1 minuto de folga.".into(),
                );
            }
            if at > now.timestamp() + MAX_SCHEDULE_HORIZON_SECS {
                return Err("Uma tarefa única pode ser marcada para até 10 anos à frente.".into());
            }
            Ok(Schedule::Once { at })
        }
    }
}

pub fn clean_prompt(raw: &str) -> Result<String, String> {
    let prompt: String = raw
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t' | '\r'))
        .collect::<String>()
        .trim()
        .to_owned();
    if prompt.is_empty() {
        return Err("A tarefa precisa de uma instrução.".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "A instrução passa de {MAX_PROMPT_CHARS} caracteres."
        ));
    }
    Ok(prompt)
}

/// Ao iniciar a ADE, horários vencidos enquanto o processo estava fechado são ignorados.
/// Tarefas recorrentes seguem para o próximo horário futuro; tarefas únicas viram `missed`.
pub fn recover_at_boot(now: DateTime<Local>) -> Result<bool, String> {
    update(|tasks| {
        let mut changed = false;
        for task in tasks.iter_mut() {
            for run in task
                .history
                .iter_mut()
                .filter(|run| run.status == "running")
            {
                run.finished_at = Some(now.timestamp());
                run.status = "failed".into();
                run.result = "A ADE foi encerrada antes de confirmar o dispatch; o prompt pode ter sido enviado.".into();
                task.updated_at = now.timestamp();
                changed = true;
            }
            if !task.enabled {
                continue;
            }
            let Some(due) = task.next_run.filter(|at| *at <= now.timestamp()) else {
                continue;
            };
            changed = true;
            let already_recorded = task
                .history
                .iter()
                .any(|run| run.scheduled_for == Some(due));
            if !already_recorded {
                let run = TaskRun {
                    id: new_id(),
                    task_id: task.id.clone(),
                    cwd: task.cwd.clone(),
                    agent_id: task.agent_id.clone(),
                    model: task.model.clone(),
                    scheduled_for: Some(due),
                    scheduled_at: now.timestamp(),
                    finished_at: Some(now.timestamp()),
                    status: "missed".into(),
                    thread_id: task.existing_thread_id.clone(),
                    result: "Horário vencido com a ADE fechada; a execução foi ignorada.".into(),
                };
                push_history(task, run);
            }
            match task.schedule {
                Schedule::Once { .. } => {
                    task.enabled = false;
                    task.next_run = None;
                }
                _ => {
                    task.next_run = routines::next_run(&task.schedule, now).map(|at| at.timestamp())
                }
            }
            task.updated_at = now.timestamp();
        }
        Ok(changed)
    })
}

pub fn push_history(task: &mut ScheduledTask, run: TaskRun) {
    task.history.push(run);
}

pub fn next_run(schedule: &Schedule, now: DateTime<Local>) -> Option<i64> {
    routines::next_run(schedule, now).map(|at| at.timestamp())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
