//! O Claude Code de cada conversa, sem TUI: um processo `claude -p` por conversa, em
//! `--input-format stream-json` / `--output-format stream-json` (JSON por linha no stdio, o mesmo
//! protocolo do Agent SDK). O processo sobe na primeira mensagem, com a sessão nova
//! (`--session-id`, escolhido pelo app) ou retomada (`--resume`) quando a conversa já existia.
//!
//! As permissões vêm pelo próprio stdio (`--permission-prompt-tool stdio`): o Claude manda um
//! `control_request` `can_use_tool` e espera a resposta; o pedido vira uma linha de `chat_request`
//! e a resposta sai quando a pessoa clica. Parar é o `control_request` `interrupt`.
//!
//! Emite o mesmo evento `cc-chat-thread` do Codex (`item`, `delta`, `phase`, `request`,
//! `requestResolved`, `thread`, `error`, `closed`). O lock do banco só é pego para gravar, nunca
//! durante o I/O.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::canal::event::clip;
use crate::canal::timeline::{Item, ItemKind};
use crate::database::DbConnection;

use super::claude_map::{self, Mapper, Out, Pending, Start};
use super::events::emit;
use super::{memoria, permission, resume, store, turn};
use crate::ai_memory::tabs::TabInjection;

/// Quanto esperar a resposta de um pedido de controle (abrir, parar). O turno não tem prazo.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Linhas finais do stderr guardadas para explicar um processo que fechou no meio do turno.
const STDERR_TAIL: usize = 20;

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Session {
    thread_id: String,
    tx: mpsc::UnboundedSender<String>,
    /// Os pedidos de controle do app esperando resposta, pelo `request_id`.
    pending: Mutex<HashMap<String, Reply>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// O id da sessão no Claude.
    remote: Mutex<Option<String>>,
    /// O turno em andamento (o id é do app: o Claude não numera os turnos).
    turn: Mutex<Option<String>>,
    /// Fecha o processo quando o turno acabar (modelo ou esforço trocados no meio do turno).
    stale: AtomicBool,
    mapper: Mutex<Mapper>,
    /// Os `can_use_tool` esperando a pessoa, pelo `request_id` do Claude.
    asks: Mutex<HashMap<String, Pending>>,
    stderr: Mutex<VecDeque<String>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// Os hooks temporários do ai-memory: o arquivo vive tanto quanto o processo e some quando a sessão é solta.
    _memory: TabInjection,
}

impl Session {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn remote(&self) -> Option<String> {
        self.remote.lock().ok().and_then(|r| r.clone())
    }

    pub fn turn(&self) -> Option<String> {
        self.turn.lock().ok().and_then(|t| t.clone())
    }

    fn set_turn(&self, turn: Option<String>) {
        if let Ok(mut t) = self.turn.lock() {
            *t = turn;
        }
    }

    fn send(&self, msg: &Value) -> Result<(), String> {
        self.tx.send(msg.to_string()).map_err(|_| "O processo do Claude fechou".to_string())
    }

    /// Um pedido de controle (`initialize`, `interrupt`…), esperando a resposta.
    pub async fn control(&self, subtype: &str, extra: Value) -> Result<Value, String> {
        if !self.alive() {
            return Err("O processo do Claude fechou".into());
        }
        let id = format!("ags-{}", self.next.fetch_add(1, Ordering::SeqCst));
        let mut request = json!({ "subtype": subtype });
        if let (Some(map), Value::Object(extra)) = (request.as_object_mut(), extra) {
            map.extend(extra);
        }
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id.clone(), tx);
        }
        self.send(&json!({ "type": "control_request", "request_id": id, "request": request }))?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("O processo do Claude fechou".into()),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("O Claude não respondeu a {subtype}"))
            }
        }
    }

    fn respond(&self, request_id: &str, response: Value) -> Result<(), String> {
        self.send(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }))
    }

    fn refuse(&self, request_id: &str) {
        let _ = self.send(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "não suportado pelo ADE AGS" } }));
    }

    /// Fecha o processo quando o turno em andamento acabar (ou já, se não há turno).
    pub fn retire(&self) {
        if self.turn().is_some() {
            self.stale.store(true, Ordering::SeqCst);
        } else {
            close(&self.thread_id);
        }
    }

    /// Encerra o processo. O laço de leitura vê o fim e limpa.
    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let _ = child.start_kill();
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A sessão viva de uma conversa, sem subir uma.
pub fn get(thread_id: &str) -> Option<Arc<Session>> {
    sessions().lock().ok()?.get(thread_id).filter(|s| s.alive()).cloned()
}

/// Encerra a sessão de uma conversa, se houver.
pub fn close(thread_id: &str) {
    let session = sessions().lock().ok().and_then(|mut m| m.remove(thread_id));
    if let Some(s) = session {
        s.kill();
    }
}


/// A sessão de uma conversa: a viva, ou uma nova (sobe o processo e faz o `initialize`). A sessão guardada é
/// retomada (`--resume`); só se ela sumiu (ou o erro transitório persistiu) abre outra, e então a timeline recebe o
/// aviso de que o agente recomeçou sem o histórico (ver `resume`). O id da sessão anterior só é trocado depois de
/// a nova abrir.
pub async fn session(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<Arc<Session>, String> {
    if let Some(s) = get(thread_id) {
        return Ok(s);
    }
    // Uma trava por conversa: um Claude lento a abrir não segura o início das outras.
    let gate = resume::start_gate("claude", thread_id);
    let _guard = gate.lock().await;
    if let Some(s) = get(thread_id) {
        return Ok(s);
    }
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::thread(&conn, thread_id).map_err(|e| e.to_string())?.ok_or("Conversa não encontrada")?
    };
    let env = row.account_id.as_deref().and_then(|a| crate::accounts::env_for_account(db, a));

    let fresh = || {
        let env = env.clone();
        let row = &row;
        async move {
            let id = uuid::Uuid::new_v4().to_string();
            open(app, db, row, env, Start::New(&id)).await.map(|s| (s, id))
        }
    };
    let opened = match row.remote_id.clone() {
        Some(remote) => {
            resume::open_resuming(
                || {
                    let (env, remote, row) = (env.clone(), remote.clone(), &row);
                    async move { open(app, db, row, env, Start::Resume(&remote)).await.map(|s| (s, remote)).map_err(|e| resume::classify(&e)) }
                },
                fresh,
                tokio::time::sleep,
            )
            .await?
        }
        None => resume::Opened { session: fresh().await?, lost: None },
    };
    let (session, remote) = opened.session;
    if let Ok(conn) = db.lock() {
        let _ = store::set_remote_id(&conn, thread_id, &remote);
    }
    if let Ok(mut r) = session.remote.lock() {
        *r = Some(remote);
    }
    if let Ok(mut map) = sessions().lock() {
        map.insert(thread_id.to_string(), session.clone());
    }
    if let Some(reason) = opened.lost {
        turn::save_notice(app, db, thread_id, "resumeLost", &resume::lost_notice(&reason));
    }
    Ok(session)
}

async fn open(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>, start: Start<'_>) -> Result<Arc<Session>, String> {
    let session = spawn(app, db, row, env, start)?;
    // O `--resume` de uma sessão que não existe fecha o processo antes de responder.
    if let Err(e) = session.control("initialize", json!({})).await {
        // O que o processo escreveu antes de fechar diz se a sessão sumiu ("No conversation found…").
        let tail = session.stderr.lock().ok().map(|t| t.iter().rev().take(2).rev().cloned().collect::<Vec<_>>().join(" | ")).unwrap_or_default();
        session.kill();
        return Err(if tail.trim().is_empty() { e } else { format!("{e}: {}", tail.trim()) });
    }
    Ok(session)
}

fn spawn(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>, start: Start<'_>) -> Result<Arc<Session>, String> {
    let name = crate::agents::agent_command("claude-code").unwrap_or("claude");
    let program = crate::util::find_program(name).ok_or("Não achei o Claude Code (claude) no PATH")?;
    let mut args = claude_map::launch_args(row, start);
    // O ai-memory entra por processo, como nas abas: hooks e MCP só no nascimento (a troca de modelo ou de acesso, e a
    // retomada, abrem outro processo e passam por aqui de novo). Falhar aqui nunca impede a conversa de abrir.
    let memory = memoria::for_thread(db, row, &program, &args, env.as_ref());
    args.extend(memory.args.iter().cloned());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = crate::util::external_command(&program, &args).map_err(|e| e.to_string())?;
    cmd.current_dir(crate::util::external_path(std::path::Path::new(&row.cwd)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        cmd.envs(env);
    }
    cmd.envs(memory.env.iter().map(|(k, v)| (k, v)));
    // Quem a conversa é para o `ags` (`thread:<id>`), para ela delegar e responder num time (`chat_team`).
    cmd.envs(crate::chat_team::env::thread_env(&row.id));
    let mut cmd = crate::util::spawn::into_tokio(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o Claude: {e}"))?;
    memoria::record(app, db, row, &memory.state, memory.notice.as_deref());
    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let session = Arc::new(Session {
        thread_id: row.id.clone(),
        tx,
        pending: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        remote: Mutex::new(None),
        turn: Mutex::new(None),
        stale: AtomicBool::new(false),
        mapper: Mutex::new(Mapper::default()),
        asks: Mutex::new(HashMap::new()),
        stderr: Mutex::new(VecDeque::new()),
        child: Mutex::new(Some(child)),
        _memory: memory.guard,
    });

    tauri::async_runtime::spawn(write_loop(rx, stdin));
    if let Some(stderr) = stderr {
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut tail) = session.stderr.lock() {
                    if tail.len() == STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        });
    }
    tauri::async_runtime::spawn(read_loop(app.clone(), db.clone(), session.clone(), stdout));
    Ok(session)
}

async fn write_loop(mut rx: mpsc::UnboundedReceiver<String>, mut stdin: tokio::process::ChildStdin) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn read_loop(app: AppHandle, db: DbConnection, session: Arc<Session>, stdout: tokio::process::ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        dispatch(&app, &db, &session, msg);
    }
    closed(&app, &db, &session);
}

fn closed(app: &AppHandle, db: &DbConnection, session: &Arc<Session>) {
    let killed = !session.alive.swap(false, Ordering::SeqCst);
    let waiting: Vec<Reply> = session.pending.lock().map(|mut p| p.drain().map(|(_, r)| r).collect()).unwrap_or_default();
    for reply in waiting {
        let _ = reply.send(Err("O processo do Claude fechou".into()));
    }
    let registered = sessions().lock().is_ok_and(|mut map| {
        let mine = map.get(&session.thread_id).is_some_and(|s| Arc::ptr_eq(s, session));
        if mine {
            map.remove(&session.thread_id);
        }
        mine
    });
    // Uma sessão que nunca entrou no mapa (o `--resume` que falhou) não mexe na conversa.
    if !registered && session.remote().is_none() {
        return;
    }
    let thread_id = session.thread_id.as_str();
    let expired = db.lock().ok().and_then(|conn| store::expire_requests(&conn, thread_id).ok()).unwrap_or_default();
    for id in expired {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    if let Some(turn) = session.turn() {
        session.set_turn(None);
        let tail = session.stderr.lock().ok().and_then(|t| turn::stderr_reason(t.iter()));
        let (result, message) = turn::dropped(killed, tail.as_deref(), "Claude");
        finish_turn(app, db, thread_id, &turn, &result);
        if let Some(message) = message {
            emit(app, thread_id, "error", json!({ "message": message }));
        }
    }
    emit(app, thread_id, "phase", json!({ "phase": "idle" }));
    emit(app, thread_id, "closed", json!({}));
}

fn dispatch(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, msg: Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("control_response") => {
            let response = msg.get("response").unwrap_or(&Value::Null);
            let Some(id) = response.get("request_id").and_then(Value::as_str) else { return };
            let reply = session.pending.lock().ok().and_then(|mut p| p.remove(id));
            if let Some(reply) = reply {
                let result = match response.get("subtype").and_then(Value::as_str) {
                    Some("error") => Err(response.get("error").and_then(Value::as_str).unwrap_or("erro do Claude").to_string()),
                    _ => Ok(response.get("response").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(result);
            }
        }
        Some("control_request") => {
            let id = msg.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            on_request(app, db, session, &id, msg.get("request").unwrap_or(&Value::Null));
        }
        Some("control_cancel_request") => {
            // O Claude desistiu do pedido (o turno foi interrompido): o pendente some.
            if let Some(id) = msg.get("request_id").and_then(Value::as_str) {
                resolve_rpc(app, db, session, id);
            }
        }
        _ => {
            let outs = session.mapper.lock().map(|mut m| m.feed(&msg, crate::util::now_ts_ms())).unwrap_or_default();
            for out in outs {
                on_out(app, db, session, out);
            }
        }
    }
}

/// Começa um turno (a pessoa mandou uma mensagem, ou o Claude seguiu sozinho com uma que estava
/// na fila). Devolve o id.
fn begin_turn(app: &AppHandle, db: &DbConnection, session: &Session) -> String {
    if let Some(turn) = session.turn() {
        return turn;
    }
    let id = uuid::Uuid::new_v4().to_string();
    session.set_turn(Some(id.clone()));
    if let Ok(conn) = db.lock() {
        let _ = store::upsert_run(&conn, &session.thread_id, &id, "inProgress", Some(crate::util::now_ts_ms()), None, None);
    }
    emit(app, &session.thread_id, "phase", json!({ "phase": "working", "turnId": id }));
    id
}

fn save_items(app: &AppHandle, db: &DbConnection, thread_id: &str, run_id: Option<&str>, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    if let Ok(conn) = db.lock() {
        for item in &items {
            let _ = store::upsert_item(&conn, thread_id, run_id, item);
        }
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
    }
    for item in items {
        emit(app, thread_id, "item", json!({ "item": item }));
    }
}

fn finish_turn(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, result: &claude_map::TurnResult) {
    let now = crate::util::now_ts_ms();
    let expired = db.lock().ok().map(|conn| {
        let _ = store::upsert_run(&conn, thread_id, turn, claude_map::run_status(result), None, Some(now), result.duration_ms);
        store::expire_requests(&conn, thread_id).unwrap_or_default()
    });
    for id in expired.unwrap_or_default() {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    save_items(app, db, thread_id, Some(turn), vec![claude_map::turn_end(turn, result, Some(now))]);
}

fn on_out(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, out: Out) {
    let thread_id = session.thread_id.as_str();
    match out {
        Out::Item(item) => {
            let turn = begin_turn(app, db, session);
            save_items(app, db, thread_id, Some(&turn), vec![*item]);
        }
        // O texto chegando vai só à janela: o banco grava o item completo (a linha `assistant`).
        Out::Delta { item_id, delta, kind } => {
            begin_turn(app, db, session);
            emit(app, thread_id, "delta", json!({ "itemId": item_id, "delta": delta, "kind": kind.as_str() }));
        }
        Out::Mode(mode) => {
            if session.alive()
                && let Some(access) = claude_map::access_of_mode(&mode)
            {
                set_access(app, db, thread_id, access);
            }
        }
        Out::Session(id) => {
            if session.alive() && session.remote().as_deref() != Some(id.as_str()) {
                if let Ok(conn) = db.lock() {
                    let _ = store::set_remote_id(&conn, thread_id, &id);
                }
                if let Ok(mut r) = session.remote.lock() {
                    *r = Some(id);
                }
            }
        }
        Out::Done(result) => {
            let Some(turn) = session.turn() else { return };
            session.set_turn(None);
            if let Ok(mut asks) = session.asks.lock() {
                asks.clear();
            }
            finish_turn(app, db, thread_id, &turn, &result);
            emit(app, thread_id, "phase", json!({ "phase": "idle" }));
            if session.stale.load(Ordering::SeqCst) {
                close(thread_id);
            }
        }
    }
}

/// O acesso da conversa mudou do lado do Claude (saiu do Plano, aceitou edições na sessão): grava
/// e avisa a tela.
fn set_access(app: &AppHandle, db: &DbConnection, thread_id: &str, access: &str) {
    let changed = db.lock().ok().and_then(|conn| {
        let row = store::thread(&conn, thread_id).ok().flatten()?;
        if row.access == access {
            return None;
        }
        let tuning = store::Tuning { model: row.model, effort: row.effort, access: access.to_string() };
        store::set_tuning(&conn, thread_id, &tuning, crate::util::now_ts_ms()).ok()
    });
    if changed.is_some() {
        emit(app, thread_id, "thread", json!({ "access": access }));
    }
}

fn on_request(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, request_id: &str, request: &Value) {
    let Some(ask) = claude_map::ask_of(request) else {
        session.refuse(request_id);
        return;
    };
    begin_turn(app, db, session);
    // O pedido inteiro (o título só guarda a primeira linha do comando): é sobre ele que o backend decide.
    let draft = permission::draft_claude(request, &ask);
    let row = store::RequestRow {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id: session.thread_id.clone(),
        // Como o Codex: o id do protocolo em JSON (aqui, sempre texto).
        rpc_id: json!(request_id).to_string(),
        kind: ask.kind.to_string(),
        item_id: ask.item_id,
        title: ask.title,
        detail: ask.detail,
        options: ask.options,
        state: "pending".into(),
        created_at: crate::util::now_ts_ms(),
    };
    let saved = db.lock().ok().map(|conn| store::insert_request(&conn, &row).is_ok()).unwrap_or(false);
    if !saved {
        session.refuse(request_id);
        return;
    }
    if let Ok(mut asks) = session.asks.lock() {
        asks.insert(request_id.to_string(), Pending::of(request));
    }
    // A política do integrante e as regras da pessoa respondem o que cobrem; o resto fica pendente e vai à tela.
    if permission::on_arrival(app, db, &row, draft) {
        return;
    }
    emit(app, &session.thread_id, "request", json!({ "request": row }));
}

/// Tira da tela o pendente cujo pedido o Claude cancelou.
fn resolve_rpc(app: &AppHandle, db: &DbConnection, session: &Session, request_id: &str) {
    if let Ok(mut asks) = session.asks.lock() {
        asks.remove(request_id);
    }
    let rpc = json!(request_id).to_string();
    let thread_id = session.thread_id.as_str();
    let Ok(conn) = db.lock() else { return };
    let ids: Vec<String> = store::pending_requests(&conn, thread_id).unwrap_or_default().into_iter().filter(|r| r.rpc_id == rpc).map(|r| r.id).collect();
    for id in &ids {
        let _ = store::answer_request(&conn, id, "resolved", crate::util::now_ts_ms());
    }
    drop(conn);
    for id in ids {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
}

/// Manda a mensagem da pessoa. Sem turno em andamento, começa um; com turno, o Claude a recebe
/// no meio dele (ou logo depois, na fila).
pub fn send_user(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, text: &str, images: Vec<Value>) -> Result<(), String> {
    session.send(&claude_map::user_message_with(text, images))?;
    let turn = begin_turn(app, db, session);
    let item = Item { text: Some(clip(text, 20_000)), ..Item::new(ItemKind::User, format!("u:{}", uuid::Uuid::new_v4()), Some(crate::util::now_ts_ms())) };
    save_items(app, db, &session.thread_id, Some(&turn), vec![item]);
    Ok(())
}

/// Para o turno em andamento.
pub async fn interrupt(session: &Session) -> Result<(), String> {
    if session.turn().is_none() {
        return Ok(());
    }
    session.control("interrupt", json!({})).await.map(|_| ())
}

/// Responde ao `can_use_tool` (`rpc_id` como está em `chat_request`). A troca de modo que vem
/// junto (sair do Plano, aceitar edições na sessão) já vale para a conversa.
pub fn answer(app: &AppHandle, db: &DbConnection, session: &Session, rpc_id: &Value, item_id: Option<&str>, choice: &str) -> Result<(), String> {
    let request_id = rpc_id.as_str().ok_or("Pedido inválido")?;
    let pending = session.asks.lock().ok().and_then(|mut a| a.remove(request_id)).ok_or("O Claude já não espera esta resposta")?;
    let (response, access) = claude_map::answer_of(&pending, choice);
    if response.get("behavior").and_then(Value::as_str) == Some("deny")
        && let (Some(id), Ok(mut mapper)) = (item_id, session.mapper.lock())
    {
        mapper.deny(id);
    }
    session.respond(request_id, response)?;
    if let Some(access) = access {
        set_access(app, db, &session.thread_id, access);
    }
    Ok(())
}
