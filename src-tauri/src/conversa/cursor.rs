//! O Cursor (`cursor-agent`) de cada conversa, sem TUI: um processo `cursor-agent -p --output-format stream-json
//! --stream-partial-output` POR TURNO (ver `cursor_map` para o protocolo e o que não foi conferido). A conversa continua
//! com `--resume <session_id>`; o id vem do `system/init` e fica em `chat_thread.remote_id`. É o mesmo desenho do
//! Antigravity (`agy.rs`): sem processo entre os turnos, parar mata o processo do turno, e uma mensagem que chega com o
//! turno em andamento fica na fila e começa o turno seguinte.
//!
//! No modo `-p` o Cursor não pergunta nada: sem `--force`, o que precisaria de aprovação não é aplicado (e vem como
//! ação recusada), então esta conversa nunca gera pedidos de aprovação. Não há conta por conversa (o login é o do
//! `cursor-agent login`) nem ai-memory.
//!
//! Emite o mesmo evento `cc-chat-thread` dos outros motores. O lock do banco só é pego para gravar.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::database::DbConnection;

use super::agy::pick_duration;
use super::cursor_map::{self as map, Mapper, Out};
use super::claude_map::TurnResult;
use super::events::emit;
use super::{store, turn};

/// Linhas finais do stderr guardadas para explicar um processo que fechou sem `result`.
const STDERR_TAIL: usize = 20;

pub struct Session {
    thread_id: String,
    turn: Mutex<Option<String>>,
    /// Mensagens que chegaram com o turno em andamento. Só entram no fio quando o turno delas começa; se a fila é
    /// descartada, cada uma vira um aviso «não enviada».
    queue: Mutex<VecDeque<String>>,
    app: AppHandle,
    db: DbConnection,
    /// A conversa no Cursor (`--resume`).
    conversation: Mutex<Option<String>>,
    /// A pessoa parou o turno (ou fechou a conversa): o processo foi morto de propósito.
    killed: AtomicBool,
    alive: AtomicBool,
    child: Mutex<Option<tokio::process::Child>>,
}

impl Session {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn turn(&self) -> Option<String> {
        self.turn.lock().ok().and_then(|t| t.clone())
    }

    fn set_turn(&self, turn: Option<String>) {
        if let Ok(mut t) = self.turn.lock() {
            *t = turn;
        }
    }

    fn kill_child(&self) {
        if let Ok(mut slot) = self.child.lock()
            && let Some(child) = slot.as_mut()
        {
            let _ = child.start_kill();
        }
    }

    /// Esvazia a fila e marca cada mensagem como «não enviada» na timeline.
    fn discard_queue(&self) {
        let dropped: Vec<String> = self.queue.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
        turn::discard_queue(&self.app, &self.db, &self.thread_id, dropped);
    }

    /// Mata o processo do turno e descarta a fila (visivelmente).
    pub fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.discard_queue();
        self.kill_child();
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A sessão de uma conversa com turno em andamento, se houver.
pub fn get(thread_id: &str) -> Option<Arc<Session>> {
    sessions().lock().ok()?.get(thread_id).filter(|s| s.alive()).cloned()
}

/// Para o turno e fecha a sessão de uma conversa, se houver.
pub fn close(thread_id: &str) {
    if let Some(s) = get(thread_id) {
        s.kill();
    }
}

/// Para o turno em andamento.
pub fn interrupt(thread_id: &str) {
    close(thread_id);
}

/// Manda uma mensagem: começa um turno, ou, com um em andamento, entra na fila.
pub fn send(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str) -> Result<(), String> {
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
        store::thread(&conn, thread_id).map_err(|e| e.to_string())?.ok_or("Conversa não encontrada")?
    };
    let turn_id = uuid::Uuid::new_v4().to_string();
    let session = {
        let mut map = sessions().lock().map_err(|e| e.to_string())?;
        if let Some(running) = map.get(thread_id).filter(|s| s.alive() && !s.killed.load(Ordering::SeqCst)).cloned() {
            // Entra na fila sob o mesmo lock do fim do laço: não se perde entre o último `pop` e a saída.
            if let Ok(mut queue) = running.queue.lock() {
                queue.push_back(text.to_string());
            }
            drop(map);
            // Só entra no fio quando o turno dela começar (`next_turn`).
            return Ok(());
        }
        let session = Arc::new(Session {
            thread_id: thread_id.to_string(),
            turn: Mutex::new(Some(turn_id.clone())),
            queue: Mutex::new(VecDeque::new()),
            app: app.clone(),
            db: db.clone(),
            conversation: Mutex::new(row.remote_id.clone()),
            killed: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            child: Mutex::new(None),
        });
        map.insert(thread_id.to_string(), session.clone());
        session
    };
    turn::begin(app, db, thread_id, &turn_id);
    turn::save_user(app, db, thread_id, &turn_id, text);
    let (app, db, text) = (app.clone(), db.clone(), text.to_string());
    tauri::async_runtime::spawn(async move {
        let mut next = Some((turn_id, text));
        while let Some((turn_id, text)) = next.take() {
            run_turn(&app, &db, &session, &turn_id, &text).await;
            next = next_turn(&app, &db, &session);
        }
    });
    Ok(())
}

/// O turno seguinte da fila, já aberto no banco; sem fila, a sessão fecha.
fn next_turn(app: &AppHandle, db: &DbConnection, session: &Arc<Session>) -> Option<(String, String)> {
    let thread_id = session.thread_id.as_str();
    let next = {
        // O mesmo lock do `send`: ou a mensagem entrou na fila antes, ou acha a sessão fechada.
        let mut map = sessions().lock().ok()?;
        let next = session.queue.lock().ok().and_then(|mut q| q.pop_front());
        if next.is_none() || session.killed.load(Ordering::SeqCst) {
            session.set_turn(None);
            session.alive.store(false, Ordering::SeqCst);
            if map.get(thread_id).is_some_and(|s| Arc::ptr_eq(s, session)) {
                map.remove(thread_id);
            }
            None
        } else {
            next
        }
    };
    match next {
        Some(text) => {
            let turn_id = uuid::Uuid::new_v4().to_string();
            session.set_turn(Some(turn_id.clone()));
            turn::begin(app, db, thread_id, &turn_id);
            // A mensagem que esperava a vez entra no fio agora, que é quando o turno dela começa.
            turn::save_user(app, db, thread_id, &turn_id, &text);
            Some((turn_id, text))
        }
        None => {
            emit(app, thread_id, "phase", json!({ "phase": "idle" }));
            emit(app, thread_id, "closed", json!({}));
            None
        }
    }
}

/// Um turno: sobe o `cursor-agent`, lê a saída até o fim e fecha o turno no banco.
async fn run_turn(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, turn_id: &str, text: &str) {
    let thread_id = session.thread_id.as_str();
    let started = std::time::Instant::now();
    let result = match drive(app, db, session, turn_id, text).await {
        Ok(Some(result)) => result,
        // O processo acabou sem `result`.
        Ok(None) => TurnResult { interrupted: session.killed.load(Ordering::SeqCst), error: None, duration_ms: None },
        Err(message) => TurnResult { interrupted: false, error: Some(message), duration_ms: None },
    };
    let mut result = result;
    result.duration_ms = Some(pick_duration(result.duration_ms, started.elapsed().as_millis() as i64));
    if session.killed.load(Ordering::SeqCst) {
        result = TurnResult { interrupted: true, error: None, duration_ms: result.duration_ms };
    }
    turn::finish(app, db, thread_id, turn_id, &result);
    if let Some(error) = result.error.as_deref().filter(|_| !result.interrupted) {
        emit(app, thread_id, "error", json!({ "message": error }));
    }
}

/// Roda o processo do turno. `Ok(Some)` = o `result` chegou; `Ok(None)` = o processo acabou sem ele
/// (parado de propósito); `Err` = não subiu, ou caiu com erro.
async fn drive(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, turn_id: &str, text: &str) -> Result<Option<TurnResult>, String> {
    let thread_id = session.thread_id.as_str();
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::thread(&conn, thread_id).map_err(|e| e.to_string())?.ok_or("Conversa não encontrada")?
    };
    let conversation = session.conversation.lock().ok().and_then(|c| c.clone());
    // A mesma resolução do app (PATH do shell de login e a pasta do instalador do Cursor), não um `which`.
    let name = crate::agents::agent_command("cursor").unwrap_or("cursor-agent");
    let program = crate::util::find_program(name).ok_or("Não achei o Cursor (cursor-agent) no PATH")?;
    let args = map::launch_args(&row, text, conversation.as_deref());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = crate::util::external_command(&program, &args).map_err(|e| e.to_string())?;
    cmd.current_dir(crate::util::external_path(std::path::Path::new(&row.cwd)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Quem a conversa é para o `ags` (`thread:<id>`), para ela delegar e responder num time (`chat_team`).
    cmd.envs(crate::chat_team::env::thread_env(&row.id));
    let mut cmd = crate::util::spawn::into_tokio(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o Cursor: {e}"))?;
    // O `ags sim act` reconhece a conversa por este PID (sem ADE_SESSION): ver `terminal::authorize_actor`.
    crate::chat_team::env::register_process(&row.id, child.id());
    super::memoria::record_unsupported(app, db, &row);
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let stderr = child.stderr.take();
    if let Ok(mut slot) = session.child.lock() {
        *slot = Some(child);
    }
    // Parado antes de o processo existir no mapa: não deixa rodar.
    if session.killed.load(Ordering::SeqCst) {
        session.kill_child();
    }

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_task = stderr.map(|stderr| {
        let tail = tail.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut t) = tail.lock() {
                    if t.len() == STDERR_TAIL {
                        t.remove(0);
                    }
                    t.push(line);
                }
            }
        })
    });

    let mut mapper = Mapper::new(turn_id);
    let mut done: Option<TurnResult> = None;
    let apply = |outs: Vec<Out>, done: &mut Option<TurnResult>| {
        for out in outs {
            match out {
                Out::Item(item) => turn::save_items(app, db, thread_id, Some(turn_id), vec![*item]),
                // O texto chegando vai só à janela: o banco grava o item completo.
                Out::Delta { item_id, delta, kind } => emit(app, thread_id, "delta", json!({ "itemId": item_id, "delta": delta, "kind": kind.as_str() })),
                Out::Session(id) => remember(db, session, &id),
                Out::Done(result) => *done = Some(result),
            }
        }
    };
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        apply(mapper.feed(&value, crate::util::now_ts_ms()), &mut done);
    }
    // Acabou sem `result` (parado, ou caiu): a fala que ficou aberta não se perde.
    apply(mapper.finish(Some(crate::util::now_ts_ms())), &mut done);
    // O processo acabou: espera sair (sem segurar o lock) e junta o stderr.
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    let status = match child {
        Some(mut child) => child.wait().await.ok(),
        None => None,
    };
    if let Some(task) = stderr_task {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }
    if done.is_some() || session.killed.load(Ordering::SeqCst) {
        return Ok(done);
    }
    let lines = tail.lock().map(|t| t.clone()).unwrap_or_default();
    let code = status.map(|s| s.code().unwrap_or(-1));
    // Saiu sem `result` e sem ninguém parar: o erro é o do stderr.
    Err(if code == Some(0) && lines.is_empty() { "O Cursor terminou sem responder".into() } else { map::error_from_stderr(&lines) })
}

/// Guarda o id da conversa no Cursor: o próximo turno continua com `--resume`.
fn remember(db: &DbConnection, session: &Arc<Session>, id: &str) {
    if session.conversation.lock().ok().is_some_and(|c| c.as_deref() == Some(id)) {
        return;
    }
    if let Ok(mut c) = session.conversation.lock() {
        *c = Some(id.to_string());
    }
    if let Ok(conn) = db.lock() {
        let _ = store::set_remote_id(&conn, &session.thread_id, id);
    }
}
