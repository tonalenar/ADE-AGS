//! O `codex app-server` de cada conversa: um processo por conversa, JSON por linha no stdio
//! (pedido `{id, method, params}`, resposta `{id, result | error}`, aviso `{method, params}`; sem o
//! campo `jsonrpc`). O processo sobe na primeira mensagem e retoma a thread do Codex
//! (`thread/resume`) quando a conversa já existia.
//!
//! O que chega vira linhas no banco (`store`) e o evento `cc-chat-thread` para a janela:
//! `item` (um item novo ou atualizado da timeline), `delta` (o texto e o resumo do raciocínio chegando, só na janela), `phase`
//! (`working`/`idle`), `request` e `requestResolved` (aprovações e perguntas), `thread` (o título
//! mudou), `error` e `closed`. O lock do banco só é pego para gravar, nunca durante o I/O.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::database::DbConnection;

use super::events::emit;
use super::{codex_map, permission, resume, store, turn};

/// Quanto esperar a resposta de um pedido (abrir thread, começar turno). O turno em si não tem
/// prazo: ele acaba por aviso (`turn/completed`).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Linhas do stderr do Codex que vão para o log (o resto é descartado).
const STDERR_LINES: usize = 40;

type Reply = oneshot::Sender<Result<Value, String>>;

/// A mensagem que o laço de leitura devolve aos pedidos pendentes quando o processo cai (`closed`).
const CLOSED: &str = "O processo do Codex fechou";

/// Como um pedido ao Codex falhou, pela única pergunta que a fila de mensagens faz: o servidor pode ter
/// agido nele?
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestFailure {
    /// Nem saiu (processo já fechado, canal de escrita fechado).
    NotSent(String),
    /// O Codex respondeu com erro: ele não executou o pedido.
    Rejected(String),
    /// O pedido saiu e a resposta se perdeu (processo caiu, prazo): pode ter sido executado.
    Lost(String),
}

impl RequestFailure {
    pub fn message(&self) -> &str {
        match self {
            RequestFailure::NotSent(m) | RequestFailure::Rejected(m) | RequestFailure::Lost(m) => m,
        }
    }
}

/// Pura: a resposta de um pedido que chegou ao laço de leitura. O erro com a mensagem de `closed` é o
/// processo que caiu com o pedido pendente (perdido), não uma recusa do servidor.
pub(super) fn failure_of(reply: Result<Value, String>) -> Result<Value, RequestFailure> {
    reply.map_err(|m| if m == CLOSED { RequestFailure::Lost(m) } else { RequestFailure::Rejected(m) })
}

pub struct Session {
    thread_id: String,
    tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    alive: AtomicBool,
    remote: Mutex<Option<String>>,
    turn: Mutex<Option<String>>,
    /// A base para os tokens do turno (`codex_map::TurnTokens`).
    tokens: Mutex<codex_map::TurnTokens>,
    child: Mutex<Option<tokio::process::Child>>,
}

impl Session {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// O id da thread no Codex.
    pub fn remote(&self) -> Option<String> {
        self.remote.lock().ok().and_then(|r| r.clone())
    }

    /// O turno em andamento, se houver.
    pub fn turn(&self) -> Option<String> {
        self.turn.lock().ok().and_then(|t| t.clone())
    }

    pub(crate) fn set_turn(&self, turn: Option<String>) {
        if let Ok(mut t) = self.turn.lock() {
            *t = turn;
        }
    }

    fn send(&self, msg: &Value) -> Result<(), String> {
        self.tx.send(msg.to_string()).map_err(|_| CLOSED.to_string())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_typed(method, params).await.map_err(|f| f.message().to_string())
    }

    /// Como `request`, dizendo na falha se o pedido chegou a sair (ver [`RequestFailure`]).
    pub async fn request_typed(&self, method: &str, params: Value) -> Result<Value, RequestFailure> {
        if !self.alive() {
            return Err(RequestFailure::NotSent(CLOSED.into()));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        if let Err(error) = self.send(&json!({ "id": id, "method": method, "params": params })) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(RequestFailure::NotSent(error));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => failure_of(result),
            Ok(Err(_)) => Err(RequestFailure::Lost(CLOSED.into())),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(RequestFailure::Lost(format!("O Codex não respondeu a {method}")))
            }
        }
    }

    fn notify(&self, method: &str) -> Result<(), String> {
        self.send(&json!({ "method": method }))
    }

    /// Responde a um pedido do Codex (`rpc_id` é o id como veio, número ou texto).
    pub fn respond(&self, rpc_id: Value, result: Value) -> Result<(), String> {
        self.send(&json!({ "id": rpc_id, "result": result }))
    }

    fn refuse(&self, rpc_id: Value) {
        let _ = self.send(&json!({ "id": rpc_id, "error": { "code": -32601, "message": "não suportado pelo ADE AGS" } }));
    }

    /// Encerra o processo (fechar a conversa, trocar o acesso). O laço de leitura vê o fim e limpa.
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


/// A sessão de uma conversa: a viva, ou uma nova (sobe o processo, `initialize` e abre ou retoma a
/// thread do Codex com o modelo e o acesso da conversa). A thread guardada é retomada; só se ela sumiu (ou o
/// erro transitório persistiu) abre outra, e então a timeline recebe o aviso de que o agente recomeçou sem o
/// histórico (ver `resume`). O id da thread anterior só é trocado depois de a nova abrir.
pub async fn session(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<Arc<Session>, String> {
    if let Some(s) = get(thread_id) {
        return Ok(s);
    }
    // Uma trava por conversa: um Codex lento a abrir não segura o início das outras.
    let gate = resume::start_gate("codex", thread_id);
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
        let (env, row) = (env.clone(), &row);
        async move { open_fresh(app, db, row, env).await }
    };
    let opened = match row.remote_id.clone() {
        Some(remote) => {
            resume::open_resuming(
                || {
                    let (env, row, remote) = (env.clone(), &row, remote.clone());
                    async move { open_resumed(app, db, row, env, &remote).await }
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

/// Um processo novo com o `initialize` feito. Fecha o processo se o `initialize` falha.
async fn started(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>) -> Result<Arc<Session>, String> {
    let session = spawn(app, db, row, env)?;
    let init = async {
        session
            .request("initialize", json!({ "clientInfo": { "name": "ade-ags", "title": "ADE AGS", "version": env!("CARGO_PKG_VERSION") }, "capabilities": null }))
            .await?;
        session.notify("initialized")
    };
    if let Err(e) = init.await {
        session.kill();
        return Err(e);
    }
    Ok(session)
}

/// Um processo novo que retoma a thread `remote`. Um processo que não sobe é `Fatal` (abrir outra thread não
/// resolveria); o Codex dizendo que a thread não existe é `Gone`; o resto, pela classe do erro.
async fn open_resumed(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>, remote: &str) -> Result<(Arc<Session>, String), resume::ResumeFailure> {
    let session = started(app, db, row, env).await.map_err(|e| resume::classify(&e))?;
    let (approval, sandbox) = codex_map::access_policy(&row.access);
    let mut params = json!({ "cwd": row.cwd, "approvalPolicy": approval, "sandbox": sandbox, "threadId": remote, "excludeTurns": true });
    if let Some(model) = &row.model {
        params["model"] = json!(model);
    }
    match session.request_typed("thread/resume", params).await {
        Ok(result) => match thread_id_of(&result) {
            Ok(id) => Ok((session, id)),
            Err(e) => {
                session.kill();
                Err(resume::ResumeFailure::Transient(e))
            }
        },
        Err(failure) => {
            session.kill();
            Err(resume_failure(failure))
        }
    }
}

/// Pura: o erro de `thread/resume` como classe. O Codex respondendo com erro = a thread não existe (ou não
/// abre): `Gone`. O pedido que não saiu, ou o processo que caiu com ele pendente: `Transient`. O prazo: `Timeout`.
fn resume_failure(failure: RequestFailure) -> resume::ResumeFailure {
    match failure {
        RequestFailure::Rejected(m) => resume::ResumeFailure::Gone(m),
        RequestFailure::NotSent(m) => resume::ResumeFailure::Transient(m),
        RequestFailure::Lost(m) => resume::classify(&m),
    }
}

/// Um processo novo com uma thread nova.
async fn open_fresh(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>) -> Result<(Arc<Session>, String), String> {
    let session = started(app, db, row, env).await?;
    let (approval, sandbox) = codex_map::access_policy(&row.access);
    let mut params = json!({ "cwd": row.cwd, "approvalPolicy": approval, "sandbox": sandbox });
    if let Some(model) = &row.model {
        params["model"] = json!(model);
    }
    let result = session.request("thread/start", params).await.inspect_err(|_| session.kill())?;
    match thread_id_of(&result) {
        Ok(id) => Ok((session, id)),
        Err(e) => {
            session.kill();
            Err(e)
        }
    }
}

fn thread_id_of(result: &Value) -> Result<String, String> {
    result.pointer("/thread/id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "O Codex não devolveu a thread".to_string())
}

fn spawn(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>) -> Result<Arc<Session>, String> {
    let program = crate::util::find_program("codex").ok_or("Não achei o Codex CLI (codex) no PATH")?;
    let mut cmd = crate::util::external_command(&program, &["app-server"]).map_err(|e| e.to_string())?;
    cmd.current_dir(crate::util::external_path(std::path::Path::new(&row.cwd)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        cmd.envs(env);
    }
    // Quem a conversa é para o `ags` (`thread:<id>`), para ela delegar e responder num time (`chat_team`).
    cmd.envs(crate::chat_team::env::thread_env(&row.id));
    let mut cmd = crate::util::spawn::into_tokio(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o Codex: {e}"))?;
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
        tokens: Mutex::new(codex_map::TurnTokens::default()),
        child: Mutex::new(Some(child)),
    });

    tauri::async_runtime::spawn(write_loop(rx, stdin));
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut shown = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                if shown < STDERR_LINES {
                    eprintln!("[codex app-server] {line}");
                    shown += 1;
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
    // `kill` (fechar a conversa, trocar o acesso) já baixou `alive`: o fim por conta própria é queda.
    let killed = !session.alive.swap(false, Ordering::SeqCst);
    let waiting: Vec<Reply> = session.pending.lock().map(|mut p| p.drain().map(|(_, r)| r).collect()).unwrap_or_default();
    for reply in waiting {
        let _ = reply.send(Err(CLOSED.into()));
    }
    let expired = db.lock().ok().and_then(|conn| store::expire_requests(&conn, &session.thread_id).ok()).unwrap_or_default();
    for id in expired {
        emit(app, &session.thread_id, "requestResolved", json!({ "id": id }));
    }
    if let Ok(mut map) = sessions().lock()
        && map.get(&session.thread_id).is_some_and(|s| Arc::ptr_eq(s, session))
    {
        map.remove(&session.thread_id);
    }
    // O turno que o processo deixou aberto fecha aqui, como no Claude e no OpenCode: sem o `turnEnd` o
    // `chat_run` ficava `inProgress` e a tela, sem saber por que o agente parou.
    if let Some(turn_id) = session.turn() {
        session.set_turn(None);
        let (result, message) = turn::dropped(killed, None, "Codex");
        turn::finish(app, db, &session.thread_id, &turn_id, &result);
        if let Some(message) = message {
            emit(app, &session.thread_id, "error", json!({ "message": message }));
        }
    }
    emit(app, &session.thread_id, "phase", json!({ "phase": "idle" }));
    emit(app, &session.thread_id, "closed", json!({}));
}

fn dispatch(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let id = msg.get("id").cloned();
    match (method, id) {
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let reply = session.pending.lock().ok().and_then(|mut p| p.remove(&id));
            if let Some(reply) = reply {
                let result = match msg.get("error") {
                    Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("erro do Codex").to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(result);
            }
        }
        (Some(method), Some(rpc_id)) => on_request(app, db, session, &method, rpc_id, msg.get("params").unwrap_or(&Value::Null)),
        (Some(method), None) => on_notification(app, db, session, &method, msg.get("params").unwrap_or(&Value::Null)),
        (None, None) => {}
    }
}

fn on_request(app: &AppHandle, db: &DbConnection, session: &Session, method: &str, rpc_id: Value, params: &Value) {
    let Some(ask) = codex_map::ask_of(method, params) else {
        session.refuse(rpc_id);
        return;
    };
    // O pedido inteiro (o título só guarda a primeira linha do comando): é sobre ele que o backend decide.
    let draft = permission::draft_codex(method, params, &ask);
    let row = store::RequestRow {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id: session.thread_id.clone(),
        rpc_id: rpc_id.to_string(),
        kind: ask.kind.to_string(),
        item_id: ask.item_id,
        title: ask.title,
        detail: ask.detail,
        options: ask.options,
        state: "pending".into(),
        created_at: crate::util::now_ts_ms(),
    };
    let saved = db.lock().ok().map(|conn| store::insert_request(&conn, &row).is_ok()).unwrap_or(false);
    if saved {
        // A política do integrante e as regras da pessoa respondem o que cobrem, com a janela fechada ou não;
        // o resto fica pendente e vai à tela.
        if permission::on_arrival(app, db, &row, draft) {
            return;
        }
        emit(app, &session.thread_id, "request", json!({ "request": row }));
    } else {
        session.refuse(rpc_id);
    }
}

fn save_items(app: &AppHandle, db: &DbConnection, thread_id: &str, run_id: Option<&str>, items: Vec<crate::canal::timeline::Item>) {
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

fn on_notification(app: &AppHandle, db: &DbConnection, session: &Session, method: &str, params: &Value) {
    let thread_id = session.thread_id.as_str();
    let turn_id = params.get("turnId").and_then(Value::as_str);
    match method {
        "turn/started" => {
            let turn = params.get("turn").unwrap_or(&Value::Null);
            let id = turn.get("id").and_then(Value::as_str).unwrap_or("");
            session.set_turn(Some(id.to_string()));
            if let Ok(conn) = db.lock() {
                let _ = store::upsert_run(&conn, thread_id, id, "inProgress", Some(crate::util::now_ts_ms()), None, None);
            }
            emit(app, thread_id, "phase", json!({ "phase": "working", "turnId": id }));
        }
        "turn/completed" => {
            let turn = params.get("turn").unwrap_or(&Value::Null);
            let id = turn.get("id").and_then(Value::as_str).unwrap_or("");
            let now = crate::util::now_ts_ms();
            if session.turn().as_deref() == Some(id) {
                session.set_turn(None);
            }
            let expired = db.lock().ok().map(|conn| {
                let status = turn.get("status").and_then(Value::as_str).unwrap_or("completed");
                let _ = store::upsert_run(&conn, thread_id, id, status, None, Some(now), turn.get("durationMs").and_then(Value::as_i64));
                store::expire_requests(&conn, thread_id).unwrap_or_default()
            });
            for rid in expired.unwrap_or_default() {
                emit(app, thread_id, "requestResolved", json!({ "id": rid }));
            }
            save_items(app, db, thread_id, Some(id), codex_map::turn_end(turn, Some(now)).into_iter().collect());
            emit(app, thread_id, "phase", json!({ "phase": "idle" }));
        }
        "item/started" | "item/completed" => {
            let at = params.get("startedAtMs").or_else(|| params.get("completedAtMs")).and_then(Value::as_i64);
            let item = params.get("item").unwrap_or(&Value::Null);
            save_items(app, db, thread_id, turn_id, codex_map::items_of(item, at));
        }
        "turn/plan/updated" => {
            save_items(app, db, thread_id, turn_id, codex_map::plan_item(params, Some(crate::util::now_ts_ms())).into_iter().collect());
        }
        "thread/tokenUsage/updated" => {
            let item = session.tokens.lock().ok().and_then(|mut t| codex_map::usage_item(&mut t, params, Some(crate::util::now_ts_ms())));
            save_items(app, db, thread_id, turn_id, item.into_iter().collect());
        }
        // O texto chegando vai só à janela: o banco grava o item completo (`item/completed`).
        "item/agentMessage/delta" | "item/reasoning/summaryTextDelta" | "item/reasoning/summaryPartAdded" => {
            if let Some((item_id, delta, kind)) = codex_map::delta_of(method, params) {
                emit(app, thread_id, "delta", json!({ "itemId": item_id, "delta": delta, "kind": kind.as_str() }));
            }
        }
        "serverRequest/resolved" => {
            // Resolvido do lado do Codex (o turno foi interrompido, por exemplo): o pendente some.
            let rpc = params.get("requestId").map(Value::to_string);
            if let (Some(rpc), Ok(conn)) = (rpc, db.lock()) {
                let ids: Vec<String> = store::pending_requests(&conn, thread_id).unwrap_or_default().into_iter().filter(|r| r.rpc_id == rpc).map(|r| r.id).collect();
                for id in &ids {
                    let _ = store::answer_request(&conn, id, "resolved", crate::util::now_ts_ms());
                }
                drop(conn);
                for id in ids {
                    emit(app, thread_id, "requestResolved", json!({ "id": id }));
                }
            }
        }
        "thread/name/updated" => {
            if let Some(name) = params.get("threadName").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) {
                if let Ok(conn) = db.lock() {
                    let _ = store::set_title(&conn, thread_id, name.trim());
                }
                emit(app, thread_id, "thread", json!({ "title": name.trim() }));
            }
        }
        // Um erro que o Codex vai tentar de novo sozinho não aparece.
        "error" if params.get("willRetry").and_then(Value::as_bool) != Some(true) => {
            let message = params.pointer("/error/message").and_then(Value::as_str).unwrap_or("erro do Codex");
            emit(app, thread_id, "error", json!({ "message": message }));
        }
        _ => {}
    }
}
