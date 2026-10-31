//! O ai-memory na conversa do Claude Code por protocolo (`claude -p`): a mesma injeção por processo que as abas de
//! terminal recebem em `pty_create` (hooks por `--settings` temporário, MCP por `--mcp-config`, `AI_MEMORY_RUN_AUTOWIRE=false`),
//! só no nascimento do processo. Ver `docs/ade-ags/AI_MEMORY_CONNECTOR.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::store::ThreadRow;
use crate::ai_memory::tabs::{enabled as tabs_enabled, prepare_new_tab_with, remove_owned_server, supported_binary, TabInjection, PROTECT_ENV, TABS_SETTING};
use crate::database::{get_setting, DbConnection};
use tauri::AppHandle;

/// O que a abertura do `claude` leva da memória.
pub struct Memory {
    /// Argumentos a somar aos do processo (`--settings <arquivo>`, `--mcp-config <arquivo>`).
    pub args: Vec<String>,
    /// Ambiente a somar ao do processo.
    pub env: Vec<(String, String)>,
    /// O arquivo temporário dos hooks vive enquanto isto viver (o `Drop` o remove).
    pub guard: TabInjection,
    /// O que fica gravado na conversa: `on`, ou `off:<código>` (`disabled`, `unavailable`, `failed`, `nothing`).
    pub state: String,
    /// Um aviso para a timeline, só quando algo deu errado ao preparar.
    pub notice: Option<String>,
}

pub struct Inputs<'a> {
    pub enabled: bool,
    pub binary: Option<PathBuf>,
    pub thread_id: &'a str,
    pub dir: &'a Path,
    pub home: &'a Path,
    pub argv: &'a [String],
    pub extras: &'a HashMap<String, String>,
}

/// O nome (antes de `tab-`) do MCP e dos arquivos da conversa.
pub fn config_id(thread_id: &str) -> String {
    format!("thread-{thread_id}")
}

/// Pura de rede e de subprocesso (só grava os arquivos da injeção): o que a conversa leva do ai-memory. A falha nunca
/// impede a conversa de abrir: sem memória, com o estado e (só se algo deu errado) um aviso.
pub fn prepare(inputs: Inputs<'_>) -> Memory {
    let id = config_id(inputs.thread_id);
    let mut memory = Memory {
        args: Vec::new(),
        env: vec![(PROTECT_ENV.0.to_string(), PROTECT_ENV.1.to_string())],
        guard: TabInjection::default(),
        state: String::new(),
        notice: None,
    };
    // Um servidor que ficou de uma abertura anterior não pode sobreviver a um ajuste desligado nem a um binário que sumiu.
    remove_owned_server(inputs.dir, &id);
    if !inputs.enabled {
        memory.state = "off:disabled".into();
        return memory;
    }
    let Some(binary) = inputs.binary else {
        memory.state = "off:unavailable".into();
        return memory;
    };
    let tab = prepare_new_tab_with(Some(binary), &id, "claude", inputs.dir, inputs.home, inputs.argv, inputs.extras);
    if tab.failed {
        memory.state = "off:failed".into();
        memory.notice = Some("A memória do ai-memory ficou fora desta conversa: não consegui preparar os hooks e o MCP dela. A conversa segue normalmente.".into());
    } else if tab.plan.args.is_empty() {
        memory.state = "off:nothing".into();
    } else {
        memory.state = "on".into();
        memory.args = tab.plan.args.clone();
        memory.env.extend(tab.plan.env.clone());
    }
    memory.guard = tab.plan;
    memory
}

/// Roda `f` (subprocesso e arquivos) sem travar as outras tarefas do runtime, se houver um runtime de várias threads.
fn blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

/// A injeção da conversa que vai abrir: lê o ajuste, confere o binário (`--version`, em cache quando deu certo) e
/// prepara os arquivos. `program` e `args` são os do `claude` que será executado.
pub fn for_thread(db: &DbConnection, row: &ThreadRow, program: &Path, args: &[String], extras: Option<&HashMap<String, String>>) -> Memory {
    let enabled = get_setting(db, TABS_SETTING).map(|v| tabs_enabled(v.as_deref())).unwrap_or(false);
    let dir = crate::util::datadir::ags_home().map(|h| h.join("mcp"));
    let (Some(dir), Some(home)) = (dir, dirs::home_dir()) else {
        let mut memory = prepare(Inputs { enabled: false, binary: None, thread_id: &row.id, dir: Path::new(""), home: Path::new(""), argv: &[], extras: &HashMap::new() });
        memory.state = "off:unavailable".into();
        return memory;
    };
    let mut argv = vec![program.to_string_lossy().into_owned()];
    argv.extend(args.iter().cloned());
    let empty = HashMap::new();
    let extras = extras.unwrap_or(&empty);
    blocking(|| {
        let binary = if enabled { supported_binary(Path::new(&row.cwd)) } else { None };
        prepare(Inputs { enabled, binary, thread_id: &row.id, dir: &dir, home: &home, argv: &argv, extras })
    })
}

/// Grava na conversa o que aconteceu com o ai-memory nesta abertura (a tela mostra o que está gravado, não adivinha) e,
/// quando algo falhou, deixa um aviso no fio, uma vez por mudança de estado.
pub fn record(app: &AppHandle, db: &DbConnection, row: &ThreadRow, state: &str, notice: Option<&str>) {
    if row.memory.as_deref() == Some(state) {
        return;
    }
    if let Ok(conn) = db.lock() {
        let _ = super::store::set_memory(&conn, &row.id, state);
    }
    super::events::emit(app, &row.id, "thread", serde_json::json!({ "memory": state }));
    if let Some(text) = notice {
        super::turn::save_notice(app, db, &row.id, "memoryOff", text);
    }
}

/// Os motores de protocolo que não recebem o ai-memory (Codex, OpenCode, Antigravity): fica dito na conversa.
pub fn record_unsupported(app: &AppHandle, db: &DbConnection, row: &ThreadRow) {
    record(app, db, row, UNSUPPORTED, None);
}

pub const UNSUPPORTED: &str = "off:unsupported";
