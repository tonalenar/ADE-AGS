//! O OpenCode de cada conversa, sem TUI: um processo `opencode acp` por conversa (Agent Client
//! Protocol: JSON-RPC 2.0 por linha no stdio). O processo sobe na primeira mensagem, abre a sessão
//! (`session/new`) ou a retoma (`session/resume`, com `session/load` de reserva) quando a conversa
//! já existia, e aplica modelo, esforço e modo (`session/set_config_option`).
//!
//! O OpenCode não tem aprovação por flag: o acesso vira a política de permissões dele, passada no
//! ambiente do processo (`opencode_map::launch_env`). Os pedidos dele chegam como
//! `session/request_permission`, viram uma linha de `chat_request`, e a resposta sai quando a pessoa
//! clica. Parar é o aviso `session/cancel`.
//!
//! Emite o mesmo evento `cc-chat-thread` dos outros motores. O OpenCode não aceita uma mensagem no
//! meio do turno: a que chega nessa hora fica numa fila e começa o turno seguinte.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::database::DbConnection;

use super::claude_map::TurnResult;
use super::events::emit;
use super::opencode_map::{self as map, Mapper, Out};
use super::{permission, resume, store, turn};

/// Quanto esperar a resposta de um pedido de abertura (`initialize`, `session/new`…). O turno não tem prazo.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Linhas finais do stderr guardadas para explicar um processo que fechou no meio do turno.
const STDERR_TAIL: usize = 20;

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Session {
    thread_id: String,
    tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// O id da sessão no OpenCode.
    remote: Mutex<Option<String>>,
    /// O turno em andamento (o id é do app) e a fila do que chegou durante ele. Só entram no fio (item `User`)
    /// quando o turno delas começa; se a fila é descartada, cada uma vira um aviso «não enviada».
    lane: turn::Lane,
    started: Mutex<Option<Instant>>,
    /// Fecha o processo quando o turno acabar (modelo, esforço ou acesso trocados no meio do turno).
    stale: AtomicBool,
    /// Durante o `session/load` o OpenCode reenvia o histórico todo: não vira nada.
    quiet: AtomicBool,
    mapper: Mutex<Mapper>,
    app: AppHandle,
    db: DbConnection,
    /// Os `session/request_permission` esperando a pessoa (o id do JSON-RPC, como veio).
    asks: Mutex<Vec<Value>>,
    stderr: Mutex<VecDeque<String>>,
    child: Mutex<Option<tokio::process::Child>>,
}

impl Session {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn remote(&self) -> Option<String> {
        self.remote.lock().ok().and_then(|r| r.clone())
    }

    pub fn turn(&self) -> Option<String> {
        self.lane.turn()
    }

    /// Esvazia a fila e marca cada mensagem como «não enviada» na timeline.
    fn discard_queue(&self) {
        turn::discard_queue(&self.app, &self.db, &self.thread_id, self.lane.drain());
    }

    /// Tira o turno em andamento: quem o tira é quem o fecha (o fim do prompt ou o processo que caiu).
    fn take_turn(&self) -> Option<String> {
        self.lane.take_turn()
    }

    fn send(&self, msg: &Value) -> Result<(), String> {
        self.tx.send(msg.to_string()).map_err(|_| "O processo do OpenCode fechou".to_string())
    }

    /// Um pedido ao OpenCode, esperando a resposta. `timeout` `None` = sem prazo (o turno).
    async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, String> {
        if !self.alive() {
            return Err("O processo do OpenCode fechou".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let waited = match timeout {
            Some(limit) => tokio::time::timeout(limit, rx).await,
            None => Ok(rx.await),
        };
        match waited {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("O processo do OpenCode fechou".into()),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("O OpenCode não respondeu a {method}"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn respond(&self, rpc_id: &Value, result: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "id": rpc_id, "result": result }))
    }

    fn refuse(&self, rpc_id: &Value) {
        let _ = self.send(&json!({ "jsonrpc": "2.0", "id": rpc_id, "error": { "code": -32601, "message": "não suportado pelo ADE AGS" } }));
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

/// A sessão de uma conversa: a viva, ou uma nova (sobe o processo, `initialize`, abre ou retoma a
/// sessão do OpenCode e aplica modelo, esforço e modo). A sessão guardada é retomada (`session/resume`, e
/// `session/load` se ela recusa); só se ela sumiu (ou o erro transitório persistiu) abre outra, e então a
/// timeline recebe o aviso de que o agente recomeçou sem o histórico (ver `resume`). O id anterior só é trocado
/// depois de a nova abrir. Um erro ao aplicar o MODO falha a abertura: nunca se roda com um modo diferente do
/// que a tela mostra.
pub async fn session(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<Arc<Session>, String> {
    if let Some(s) = get(thread_id) {
        return Ok(s);
    }
    // Uma trava por conversa: um OpenCode lento a abrir não segura o início das outras.
    let gate = resume::start_gate("opencode", thread_id);
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
        async move {
            let session = spawn(app, db, row, env)?;
            match open_session(&session, row, None).await {
                Ok((remote, ignored)) => Ok((session, remote, ignored)),
                Err(e) => {
                    session.kill();
                    Err(e.into_message())
                }
            }
        }
    };
    let opened = match row.remote_id.clone() {
        Some(remote) => {
            resume::open_resuming(
                || {
                    let (env, row, remote) = (env.clone(), &row, remote.clone());
                    async move {
                        let session = spawn(app, db, row, env).map_err(|e| resume::classify(&e))?;
                        match open_session(&session, row, Some(&remote)).await {
                            Ok((remote, ignored)) => Ok((session, remote, ignored)),
                            Err(failure) => {
                                session.kill();
                                Err(failure)
                            }
                        }
                    }
                },
                fresh,
                tokio::time::sleep,
            )
            .await?
        }
        None => resume::Opened { session: fresh().await?, lost: None },
    };
    let (session, remote, ignored) = opened.session;
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
    for what in ignored {
        turn::save_notice(app, db, thread_id, "optionIgnored", &what);
    }
    Ok(session)
}

/// `initialize`, a sessão (nova, ou a retomada) e as opções da conversa. Devolve o id da sessão e os avisos do
/// que o OpenCode não aplicou. Com `resume`, qualquer recusa do OpenCode à sessão guardada é `Gone`; os erros ao
/// aplicar modelo e modo são `Fatal` (a sessão existe: trocá-la por outra não os resolveria).
async fn open_session(session: &Session, row: &store::ThreadRow, resume: Option<&str>) -> Result<(String, Vec<String>), resume::ResumeFailure> {
    use resume::ResumeFailure as Failure;
    session.request("initialize", map::initialize_params(), Some(REQUEST_TIMEOUT)).await.map_err(|e| resume::classify(&e))?;
    let cwd = row.cwd.as_str();
    let (remote, mut config) = match resume {
        Some(remote) => {
            // `session/resume` não reenvia o histórico; `session/load` sim (ignorado enquanto carrega).
            let resumed = session.request("session/resume", map::resume_params(remote, cwd), Some(REQUEST_TIMEOUT)).await;
            let found = match resumed {
                Ok(result) => result,
                // Sem resposta a tempo ou com o processo caído, o `load` não adianta: a classe do erro decide.
                Err(e) if !matches!(resume::classify(&e), Failure::Gone(_) | Failure::Transient(_)) || !session.alive() => return Err(resume::classify(&e)),
                Err(first) => {
                    session.quiet.store(true, Ordering::SeqCst);
                    let loaded = session.request("session/load", map::resume_params(remote, cwd), Some(REQUEST_TIMEOUT)).await;
                    session.quiet.store(false, Ordering::SeqCst);
                    // O OpenCode respondendo com erro às duas = a sessão não existe mais.
                    loaded.map_err(|second| if session.alive() { Failure::Gone(second) } else { resume::classify(&first) })?
                }
            };
            (remote.to_string(), found)
        }
        None => {
            let result = session.request("session/new", map::new_session_params(cwd), Some(REQUEST_TIMEOUT)).await.map_err(Failure::Fatal)?;
            let id = result.get("sessionId").and_then(Value::as_str).ok_or_else(|| Failure::Fatal("O OpenCode não devolveu a sessão".into()))?.to_string();
            (id, result)
        }
    };
    let ignored = apply_options(session, &remote, row, &mut config).await.map_err(Failure::Fatal)?;
    Ok((remote, ignored))
}

/// O que fazer com uma opção da sessão (`model`, `effort`, `mode`), dada a configuração que o OpenCode mostra.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum OptionPlan {
    /// Já está como se quer.
    Same,
    /// O valor não está entre os que o OpenCode oferece para esta opção.
    Unavailable,
    /// Pedir a troca (a opção existe e o valor é aceito, ou a configuração nem a lista).
    Set,
}

/// Pura: o plano de uma opção.
pub(super) fn plan_option(config: &Value, id: &str, want: &str) -> OptionPlan {
    match map::config_option(config, id) {
        Some((current, _)) if current.as_deref() == Some(want) => OptionPlan::Same,
        Some((_, values)) if !values.iter().any(|v| v == want) => OptionPlan::Unavailable,
        _ => OptionPlan::Set,
    }
}

/// Troca uma opção da sessão se ela é aceita e diferente da atual. `Ok(false)` = não precisou. A resposta traz as
/// opções novas (o esforço muda com o modelo). `Unavailable` é erro: quem aceita o valor ausente decide antes.
async fn set_option(session: &Session, remote: &str, config: &mut Value, id: &str, want: &str) -> Result<bool, String> {
    match plan_option(config, id, want) {
        OptionPlan::Same => return Ok(false),
        OptionPlan::Unavailable => return Err(format!("{want} não está disponível no OpenCode ({id})")),
        OptionPlan::Set => {}
    }
    let result = session.request("session/set_config_option", map::set_option_params(remote, id, want), Some(REQUEST_TIMEOUT)).await?;
    if result.get("configOptions").is_some() {
        *config = result;
    }
    Ok(true)
}

/// Aplica modelo, esforço e modo. Falha fechada: um erro no modelo ou no MODO (as permissões) recusa a abertura,
/// porque rodar com um modo diferente do mostrado é pior que não rodar. O esforço que o modelo não oferece fica
/// no padrão do OpenCode, mas o aviso vai para a timeline (devolvido). Outro erro do esforço também falha.
async fn apply_options(session: &Session, remote: &str, row: &store::ThreadRow, config: &mut Value) -> Result<Vec<String>, String> {
    let mut ignored = Vec::new();
    if let Some(model) = row.model.as_deref().filter(|m| !m.is_empty()) {
        set_option(session, remote, config, "model", model).await?;
    }
    // O esforço depende do modelo (por isso vem depois).
    if let Some(effort) = row.effort.as_deref().filter(|e| !e.is_empty()) {
        if plan_option(config, "effort", effort) == OptionPlan::Unavailable {
            ignored.push(format!("O esforço \"{effort}\" não existe para este modelo no OpenCode; ele usou o padrão."));
        } else {
            set_option(session, remote, config, "effort", effort).await.map_err(|e| format!("Não consegui aplicar o esforço {effort} no OpenCode: {e}"))?;
        }
    }
    let mode = map::mode_of(&row.access);
    let listed = map::config_option(config, "mode").is_some();
    match set_option(session, remote, config, "mode", mode).await {
        Ok(_) => {}
        // Um OpenCode que nem lista a opção `mode` não tem modo a mostrar errado: as permissões valem pelo
        // ambiente do processo (`map::launch_env`).
        Err(_) if !listed => {}
        Err(e) => return Err(format!("Não consegui aplicar o modo {mode} no OpenCode (as permissões não seriam as que a tela mostra): {e}")),
    }
    Ok(ignored)
}

fn spawn(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>) -> Result<Arc<Session>, String> {
    let name = crate::agents::agent_command("opencode").unwrap_or("opencode");
    let program = crate::util::find_program(name).ok_or("Não achei o OpenCode (opencode) no PATH")?;
    let mut cmd = crate::util::external_command(&program, &["acp"]).map_err(|e| e.to_string())?;
    cmd.current_dir(crate::util::external_path(std::path::Path::new(&row.cwd)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        cmd.envs(env);
    }
    cmd.envs(map::launch_env(row));
    // Quem a conversa é para o `ags` (`thread:<id>`), para ela delegar e responder num time (`chat_team`).
    cmd.envs(crate::chat_team::env::thread_env(&row.id));
    let mut cmd = crate::util::spawn::into_tokio(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o OpenCode: {e}"))?;
    super::memoria::record_unsupported(app, db, row);
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
        lane: turn::Lane::default(),
        started: Mutex::new(None),
        stale: AtomicBool::new(false),
        quiet: AtomicBool::new(false),
        mapper: Mutex::new(Mapper::new("")),
        app: app.clone(),
        db: db.clone(),
        asks: Mutex::new(Vec::new()),
        stderr: Mutex::new(VecDeque::new()),
        child: Mutex::new(Some(child)),
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
        let _ = reply.send(Err("O processo do OpenCode fechou".into()));
    }
    let registered = sessions().lock().is_ok_and(|mut map| {
        let mine = map.get(&session.thread_id).is_some_and(|s| Arc::ptr_eq(s, session));
        if mine {
            map.remove(&session.thread_id);
        }
        mine
    });
    // Uma sessão que nunca entrou no mapa (a abertura que falhou) não mexe na conversa.
    if !registered && session.remote().is_none() {
        return;
    }
    let thread_id = session.thread_id.as_str();
    if let Ok(mut asks) = session.asks.lock() {
        asks.clear();
    }
    let expired = db.lock().ok().and_then(|conn| store::expire_requests(&conn, thread_id).ok()).unwrap_or_default();
    for id in expired {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    if let Some(turn_id) = session.take_turn() {
        let tail = session.stderr.lock().ok().and_then(|t| turn::stderr_reason(t.iter()));
        let (result, message) = turn::dropped(killed, tail.as_deref(), "OpenCode");
        turn::finish(app, db, thread_id, &turn_id, &result);
        if let Some(message) = message {
            emit(app, thread_id, "error", json!({ "message": message }));
        }
    }
    session.discard_queue();
    emit(app, thread_id, "phase", json!({ "phase": "idle" }));
    emit(app, thread_id, "closed", json!({}));
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
                    Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("erro do OpenCode").to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(result);
            }
        }
        (Some(method), Some(rpc_id)) => match method.as_str() {
            "session/request_permission" => on_permission(app, db, session, rpc_id, msg.get("params").unwrap_or(&Value::Null)),
            // O app não declarou `fs` nem `terminal`: o OpenCode usa as ferramentas dele.
            _ => session.refuse(&rpc_id),
        },
        (Some(method), None) => {
            if method == "session/update" && !session.quiet.load(Ordering::SeqCst) {
                let update = msg.pointer("/params/update").cloned().unwrap_or(Value::Null);
                let outs = session.mapper.lock().map(|mut m| m.feed(&update, crate::util::now_ts_ms())).unwrap_or_default();
                for out in outs {
                    on_out(app, db, session, out);
                }
            }
        }
        (None, None) => {}
    }
}

fn on_out(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, out: Out) {
    let thread_id = session.thread_id.as_str();
    match out {
        Out::Item(item) => {
            let run = session.turn();
            turn::save_items(app, db, thread_id, run.as_deref(), vec![*item]);
        }
        // O texto chegando vai só à janela: o banco grava o item completo.
        Out::Delta { item_id, delta, kind } => {
            emit(app, thread_id, "delta", json!({ "itemId": item_id, "delta": delta, "kind": kind.as_str() }));
        }
        Out::Mode(mode) => {
            if !session.alive() {
                return;
            }
            let current = db.lock().ok().and_then(|conn| store::thread(&conn, thread_id).ok().flatten()).map(|r| r.access);
            match (map::access_of_mode(&mode), current.as_deref()) {
                (Some(access), Some(now)) if now != access => turn::set_access(app, db, thread_id, access),
                // Saiu do Plano: segue Supervisionado, nunca um modo com mais permissão.
                (None, Some("plan")) if mode == "build" => turn::set_access(app, db, thread_id, "ask"),
                _ => {}
            }
        }
    }
}

fn on_permission(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, rpc_id: Value, params: &Value) {
    let Some(ask) = map::ask_of(params) else {
        session.refuse(&rpc_id);
        return;
    };
    // O pedido inteiro (o título só guarda a primeira linha do comando): é sobre ele que o backend decide.
    let draft = permission::draft_opencode(params, &ask);
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
    if !saved {
        session.refuse(&rpc_id);
        return;
    }
    if let Ok(mut asks) = session.asks.lock() {
        asks.push(rpc_id);
    }
    // A política do integrante e as regras da pessoa respondem o que cobrem; o resto fica pendente e vai à tela.
    if permission::on_arrival(app, db, &row, draft) {
        return;
    }
    emit(app, &session.thread_id, "request", json!({ "request": row }));
}

/// Manda a mensagem da pessoa. Sem turno em andamento, começa um; com turno, fica na fila e começa quando ele
/// acabar. A decisão é uma só, sob a trava da sessão; a mensagem da fila só entra no fio quando o turno dela começa.
pub fn send_user(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, text: &str) -> Result<(), String> {
    if !session.alive() {
        return Err("O processo do OpenCode fechou".into());
    }
    let turn_id = match session.lane.admit(text) {
        turn::Admitted::Queued => return Ok(()),
        turn::Admitted::Start(turn_id) => turn_id,
    };
    start_turn(app, db, session, text, turn_id, true)
}

/// Abre o turno `turn_id` (já reservado) e manda o prompt. Se não dá para começar, o turno reservado é solto.
fn start_turn(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, text: &str, turn_id: String, save: bool) -> Result<(), String> {
    let Some(remote) = session.remote() else {
        session.take_turn();
        return Err("A conversa ainda não abriu no OpenCode".into());
    };
    if let Ok(mut started) = session.started.lock() {
        *started = Some(Instant::now());
    }
    if let Ok(mut mapper) = session.mapper.lock() {
        mapper.begin(&turn_id);
    }
    turn::begin(app, db, &session.thread_id, &turn_id);
    if save {
        turn::save_user(app, db, &session.thread_id, &turn_id, text);
    }
    let (app, db, session, text) = (app.clone(), db.clone(), session.clone(), text.to_string());
    tauri::async_runtime::spawn(async move {
        let response = session.request("session/prompt", map::prompt_params(&remote, &text), None).await;
        end_turn(&app, &db, &session, &turn_id, response);
    });
    Ok(())
}

/// O `session/prompt` respondeu (ou falhou): fecha o turno e segue com a fila.
fn end_turn(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, turn_id: &str, response: Result<Value, String>) {
    let thread_id = session.thread_id.as_str();
    let now = crate::util::now_ts_ms();
    let leftover = session.mapper.lock().map(|mut m| m.flush(Some(now))).unwrap_or_default();
    for out in leftover {
        on_out(app, db, session, out);
    }
    // O processo caiu antes: o `closed` já fechou o turno.
    if session.turn().as_deref() != Some(turn_id) {
        return;
    }
    session.take_turn();
    if let Ok(mut asks) = session.asks.lock() {
        asks.clear();
    }
    let duration = session.started.lock().ok().and_then(|s| s.map(|t| t.elapsed().as_millis() as i64));
    let result = match &response {
        Ok(done) => {
            if let Some(usage) = map::usage_item(turn_id, done, Some(now)) {
                turn::save_items(app, db, thread_id, Some(turn_id), vec![usage]);
            }
            map::turn_result(done, duration)
        }
        Err(message) => TurnResult { interrupted: false, error: Some(map::error_text(message)), duration_ms: duration },
    };
    turn::finish(app, db, thread_id, turn_id, &result);
    emit(app, thread_id, "phase", json!({ "phase": "idle" }));
    if session.stale.load(Ordering::SeqCst) {
        close(thread_id);
        return;
    }
    // A mensagem da fila entra no fio agora, que é quando o turno dela começa (`save`).
    if let Some((next_turn, next)) = session.lane.advance()
        && let Err(e) = start_turn(app, db, session, &next, next_turn, true)
    {
        emit(app, thread_id, "error", json!({ "message": e }));
    }
}

/// Para o turno em andamento: o aviso `session/cancel`, e os pedidos de permissão em aberto
/// respondem "cancelado" (o OpenCode espera por eles para terminar).
pub async fn interrupt(session: &Session) -> Result<(), String> {
    let Some(remote) = session.remote() else { return Ok(()) };
    if session.turn().is_none() {
        return Ok(());
    }
    let waiting: Vec<Value> = session.asks.lock().map(|mut a| std::mem::take(&mut *a)).unwrap_or_default();
    for rpc_id in waiting {
        let _ = session.respond(&rpc_id, json!({ "outcome": { "outcome": "cancelled" } }));
    }
    // O que esperava a vez não vai mais: cada mensagem fica marcada como «não enviada» na timeline.
    session.discard_queue();
    session.notify("session/cancel", json!({ "sessionId": remote }))
}

/// Responde ao `session/request_permission` (`rpc_id` e `options` como estão em `chat_request`).
pub fn answer(session: &Session, rpc_id: &Value, item_id: Option<&str>, options: &Value, choice: &str) -> Result<(), String> {
    let known = session.asks.lock().ok().map(|mut a| {
        let before = a.len();
        a.retain(|id| id != rpc_id);
        a.len() != before
    });
    if known != Some(true) {
        return Err("O OpenCode já não espera esta resposta".into());
    }
    let result = map::answer_of(options, choice);
    if !matches!(choice, "allow" | "allowSession")
        && let (Some(id), Ok(mut mapper)) = (item_id, session.mapper.lock())
    {
        mapper.deny(id);
    }
    session.respond(rpc_id, result)?;
    if choice == "cancel"
        && let Some(remote) = session.remote()
    {
        let _ = session.notify("session/cancel", json!({ "sessionId": remote }));
    }
    Ok(())
}
