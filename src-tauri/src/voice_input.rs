//! Ditado local para o composer. O áudio fica em memória e a transcrição exige o modo no dispositivo.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

const START_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(45);

struct ActiveInput {
    id: String,
    child: std::sync::Arc<Mutex<Child>>,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

struct StartingInput {
    id: String,
    child: Option<std::sync::Arc<Mutex<Child>>>,
}

fn active() -> &'static Mutex<Option<ActiveInput>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveInput>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn starting() -> &'static Mutex<Option<StartingInput>> {
    static STARTING_INPUT: OnceLock<Mutex<Option<StartingInput>>> = OnceLock::new();
    STARTING_INPUT.get_or_init(|| Mutex::new(None))
}

fn cancelled_starts() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_cancelled(id: &str) -> bool {
    cancelled_starts()
        .lock()
        .is_ok_and(|mut pending| pending.remove(id))
}

fn forget_cancelled(id: &str) {
    if let Ok(mut pending) = cancelled_starts().lock() {
        pending.remove(id);
    }
}

fn clear_starting(id: &str) {
    if let Ok(mut current) = starting().lock()
        && current.as_ref().is_some_and(|session| session.id == id)
    {
        *current = None;
    }
}

fn kill_child(child: &std::sync::Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

static STARTING: AtomicBool = AtomicBool::new(false);

struct StartingGuard {
    reset_on_drop: bool,
}

impl StartingGuard {
    fn new() -> Self {
        Self {
            reset_on_drop: true,
        }
    }

    fn preserve_until_session_ends(&mut self) {
        self.reset_on_drop = false;
    }
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        if self.reset_on_drop {
            STARTING.store(false, Ordering::Release);
        }
    }
}

/// Inicia a captura local do microfone para um idioma compatível com o composer.
pub fn start(locale: &str, id: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        start_macos(locale, id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (locale, id);
        Err("O ditado local está disponível no macOS nesta versão.".into())
    }
}

#[cfg(target_os = "macos")]
fn start_macos(locale: &str, id: &str) -> Result<String, String> {
    STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Já existe um ditado ou inicialização ativa nesta instância.".to_string())?;
    let mut starting_guard = StartingGuard::new();
    if active()
        .lock()
        .map_err(|_| "O estado do ditado ficou indisponível.")?
        .is_some()
    {
        return Err("Já existe um ditado ativo nesta instância.".into());
    }
    if starting()
        .lock()
        .map_err(|_| "O estado do ditado ficou indisponível.")?
        .is_some()
    {
        return Err("Já existe um ditado ativo nesta instância.".into());
    }
    if take_cancelled(id) {
        forget_cancelled(id);
        return Err("O ditado foi cancelado antes de iniciar.".into());
    }
    if !matches!(locale, "pt-BR" | "en-US" | "es-ES") {
        return Err("O idioma do ditado não é compatível.".into());
    }

    // Registra o ID antes de iniciar o subprocesso para que fechar a ADE também cubra essa janela.
    {
        let mut current = starting()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        if current.is_some() {
            return Err("Já existe um ditado ativo nesta instância.".into());
        }
        *current = Some(StartingInput {
            id: id.to_string(),
            child: None,
        });
    }
    if take_cancelled(id) {
        clear_starting(id);
        forget_cancelled(id);
        return Err("O ditado foi cancelado antes de iniciar.".into());
    }

    let mut command = crate::util::spawn::hidden_command("/usr/bin/swift");
    command
        .arg("-e")
        .arg(include_str!("voice_input.swift"))
        .arg(locale)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|e| {
        clear_starting(id);
        forget_cancelled(id);
        format!("Não consegui iniciar o ditado local: {e}")
    })?;
    let Some(input) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        clear_starting(id);
        forget_cancelled(id);
        return Err("O ditado não abriu o canal de controle.".into());
    };
    let Some(output) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        clear_starting(id);
        forget_cancelled(id);
        return Err("O ditado não abriu o canal de estado.".into());
    };
    let child = std::sync::Arc::new(Mutex::new(child));

    // A inicialização pode ter sido cancelada enquanto o processo era criado.
    let registered = {
        let mut current = starting()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        if take_cancelled(id) || !current.as_ref().is_some_and(|session| session.id == id) {
            false
        } else if let Some(session) = current.as_mut() {
            session.child = Some(std::sync::Arc::clone(&child));
            true
        } else {
            false
        }
    };
    if !registered {
        kill_child(&child);
        clear_starting(id);
        forget_cancelled(id);
        return Err("O ditado foi cancelado antes de iniciar.".into());
    }

    // A permissão do sistema pode aguardar uma resposta da pessoa; o prazo mantém o IPC livre.
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = BufReader::new(output);
        let mut line = String::new();
        let result = output.read_line(&mut line).map(|_| (line, output));
        let _ = sender.send(result);
    });
    let (line, output) = match receiver.recv_timeout(START_TIMEOUT) {
        Ok(Ok((line, output))) => (line, output),
        Ok(Err(error)) => {
            clear_starting(id);
            kill_child(&child);
            forget_cancelled(id);
            return Err(format!("Não consegui iniciar o ditado local: {error}"));
        }
        Err(_) => {
            clear_starting(id);
            kill_child(&child);
            forget_cancelled(id);
            return Err("O ditado não respondeu. Confira as permissões de Microfone e Reconhecimento de Fala do macOS.".into());
        }
    };
    let event: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(event) => event,
        Err(_) => {
            clear_starting(id);
            kill_child(&child);
            forget_cancelled(id);
            return Err("O serviço de ditado devolveu um estado inválido.".into());
        }
    };
    if event.get("type").and_then(serde_json::Value::as_str) != Some("ready") {
        let message = event
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("O macOS não iniciou o ditado local.");
        clear_starting(id);
        kill_child(&child);
        forget_cancelled(id);
        return Err(message.to_string());
    }

    // Transfere o subprocesso do estado "iniciando" para "ativo" sem uma janela sem dono.
    let transitioned = {
        let mut startup = starting()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        let mut current = active()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        if take_cancelled(id)
            || !startup.as_ref().is_some_and(|session| session.id == id)
            || current.is_some()
        {
            false
        } else {
            *current = Some(ActiveInput {
                id: id.to_string(),
                child: std::sync::Arc::clone(&child),
                input,
                output,
            });
            *startup = None;
            true
        }
    };
    if !transitioned {
        kill_child(&child);
        forget_cancelled(id);
        return Err("O ditado foi cancelado antes de iniciar.".into());
    }
    starting_guard.preserve_until_session_ends();
    Ok(id.to_string())
}

fn finish(id: &str, cancel: bool) -> Result<String, String> {
    let session = {
        let mut slot = active()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        let session = slot.take().ok_or("Não há ditado ativo nesta instância.")?;
        if session.id != id {
            *slot = Some(session);
            return Err("O ditado ativo pertence a outro composer.".into());
        }
        session
    };

    let ActiveInput {
        child,
        mut input,
        mut output,
        ..
    } = session;
    let _busy = StartingGuard::new();
    let command = if cancel { "cancel\n" } else { "stop\n" };
    if let Err(error) = input.write_all(command.as_bytes()) {
        kill_child(&child);
        return Err(format!("Não consegui encerrar o ditado local: {error}"));
    }
    drop(input);

    let child_for_reader = std::sync::Arc::clone(&child);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut transcript = String::new();
        let read_result = output.read_to_string(&mut transcript);
        let wait_result = child_for_reader
            .lock()
            .map_err(|_| "O processo de ditado ficou indisponível.".to_string())
            .and_then(|mut child| {
                child
                    .wait()
                    .map_err(|e| format!("Não consegui finalizar o ditado: {e}"))
            });
        let _ = sender.send((transcript, read_result, wait_result));
    });

    let (transcript, read_result, status) = match receiver.recv_timeout(STOP_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(
                "A transcrição local demorou demais para concluir; o áudio foi descartado.".into(),
            );
        }
    };
    read_result.map_err(|e| format!("Não consegui ler a transcrição: {e}"))?;
    let event: serde_json::Value = serde_json::from_str(transcript.trim())
        .map_err(|_| "O serviço de ditado devolveu uma transcrição inválida.".to_string())?;
    let status = status?;
    match event.get("type").and_then(serde_json::Value::as_str) {
        Some("cancelled") if cancel && status.success() => Ok(String::new()),
        Some("result") if !cancel && status.success() => Ok(event
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()),
        Some("error") => Err(event
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("O macOS não conseguiu transcrever este áudio.")
            .to_string()),
        _ if !status.success() => {
            Err("O serviço de ditado terminou sem concluir a transcrição.".into())
        }
        _ => Err("O serviço de ditado encerrou sem um resultado reconhecido.".into()),
    }
}

fn cancel_session(id: &str) -> Result<(), String> {
    let active_id = active()
        .lock()
        .map_err(|_| "O estado do ditado ficou indisponível.")?
        .as_ref()
        .map(|session| session.id.clone());
    if active_id.as_deref() == Some(id) {
        return finish(id, true).map(|_| ());
    }
    if active_id.is_some() {
        return Err("O ditado ativo pertence a outro composer.".into());
    }

    let startup = {
        let mut current = starting()
            .lock()
            .map_err(|_| "O estado do ditado ficou indisponível.")?;
        if current.as_ref().is_some_and(|session| session.id == id) {
            current.take()
        } else if current.is_some() {
            return Err("O ditado em inicialização pertence a outro composer.".into());
        } else {
            None
        }
    };
    if let Some(startup) = startup {
        if let Ok(mut pending) = cancelled_starts().lock() {
            pending.insert(id.to_string());
        }
        if let Some(child) = startup.child {
            kill_child(&child);
        }
        return Ok(());
    }

    // O comando de início pode ainda não ter criado o subprocesso; guarda o cancelamento por ID.
    cancelled_starts()
        .lock()
        .map_err(|_| "O estado do ditado ficou indisponível.")?
        .insert(id.to_string());
    Ok(())
}

/// Para o ditado e devolve somente o texto reconhecido; áudio nunca é salvo nem anexado.
#[tauri::command(async)]
pub fn voice_input_start(locale: String, id: String) -> Result<String, String> {
    start(&locale, &id)
}

#[tauri::command(async)]
pub fn voice_input_stop(id: String) -> Result<String, String> {
    finish(&id, false)
}

/// Cancela e descarta os buffers de áudio sem inserir texto no composer.
#[tauri::command(async)]
pub fn voice_input_cancel(id: String) -> Result<(), String> {
    cancel_session(&id)
}

/// Não deixa o subprocesso de captura de microfone aberto após a saída da ADE.
pub fn cancel_all() {
    // Fecha rápido no encerramento da ADE; não espera a transcrição terminar.
    let (startup, active_session) = match (starting().lock(), active().lock()) {
        (Ok(mut startup), Ok(mut active_session)) => (startup.take(), active_session.take()),
        _ => return,
    };
    if let Some(startup) = startup {
        if let Ok(mut pending) = cancelled_starts().lock() {
            pending.insert(startup.id);
        }
        if let Some(child) = startup.child {
            kill_child(&child);
        }
    }
    if let Some(active_session) = active_session {
        kill_child(&active_session.child);
    }
    STARTING.store(false, Ordering::Release);
}
