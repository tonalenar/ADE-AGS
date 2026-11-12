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

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::canal::timeline::{Item, ItemKind};
use crate::database::DbConnection;

use super::claude_map::{self, Mapper, Out, Pending, Start};
use super::codex_parar::{StopAction, StopGate};
use super::events::emit;
use super::{memoria, permission, resume, store, turn};
use crate::ai_memory::tabs::TabInjection;

/// Quanto esperar a resposta de um pedido de controle (abrir, parar). O turno não tem prazo.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Linhas finais do stderr guardadas para explicar um processo que fechou no meio do turno.
const STDERR_TAIL: usize = 20;
const AUTO_COMPACT_WINDOWS_SETTING: &str = "chat.claude_auto_compact_windows";

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Session {
    thread_id: String,
    /// Modo Fast configurado na abertura do processo.
    fast_mode: bool,
    tx: mpsc::UnboundedSender<String>,
    /// Os pedidos de controle do app esperando resposta, pelo `request_id`.
    pending: Mutex<HashMap<String, Reply>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// O id da sessão no Claude.
    remote: Mutex<Option<String>>,
    /// Raiz temporária usada pelo Claude para os arquivos de saída das tarefas.
    task_output_root: Option<PathBuf>,
    /// Caminhos anunciados no fim da tarefa, limitados à raiz privada acima.
    task_output_files: Mutex<HashMap<String, PathBuf>>,
    /// Pasta da conversa: base dos caminhos relativos que um comando redireciona.
    cwd: PathBuf,
    /// Comando de cada `Bash` lançado em segundo plano, pelo `tool_use_id`.
    bash_commands: Mutex<HashMap<String, String>>,
    /// O comando de cada tarefa (`task_started` liga a tarefa ao `tool_use_id`).
    task_commands: Mutex<HashMap<String, String>>,
    /// O turno em andamento (o id é do app: o Claude não numera os turnos).
    turn: Mutex<Option<String>>,
    /// O Parar que chega antes de o turno mostrar que roda (ver `codex_parar`). Trava antes da do `turn`.
    stop: Mutex<StopGate>,
    /// Os `tool_use` que lançaram uma tarefa em segundo plano (`is_backgrounded`), pelo id. O desfecho deles vem pelo
    /// canal de tarefas (`task_notification`, `stop_task`), não por `tool_result`: com o processo vivo, o fim do turno
    /// não os marca (ver `finish_turn`).
    background: Mutex<HashSet<String>>,
    /// Fecha o processo quando o turno acabar (modelo ou esforço trocados no meio do turno).
    stale: AtomicBool,
    /// Marca as chamadas de uso que fazem parte de uma compactação automática iniciada pela ADE.
    auto_compacting: AtomicBool,
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

    /// Lê a cauda que o Claude grava para um shell em segundo plano.
    pub fn task_output(&self, task_id: &str) -> Option<Value> {
        let root = self.task_output_root.as_deref()?;
        let cached = self.task_output_files.lock().ok()?.get(task_id).cloned();
        let path = cached.or_else(|| self.remote().and_then(|remote| super::tarefas_saida::find_task_output(root, &remote, task_id)));
        let empty = || json!({ "output": "", "total_bytes": 0, "truncated": false });
        let own = path.and_then(|path| {
            if let Ok(mut files) = self.task_output_files.lock() {
                files.insert(task_id.to_string(), path.clone());
            }
            super::tarefas_saida::read_task_output(&path)
        });
        if own.as_ref().is_some_and(|o| o["total_bytes"].as_u64().unwrap_or(0) > 0) {
            return own;
        }
        // O agente costuma mandar a saída para um log próprio (`> /tmp/build.log 2>&1`): o arquivo da tarefa fica
        // vazio e a saída de verdade está lá.
        let command = self.task_commands.lock().ok().and_then(|c| c.get(task_id).cloned());
        if let Some(found) = command.and_then(|c| super::tarefas_saida::read_redirected_output(&c, &self.cwd)) {
            return Some(found);
        }
        Some(own.unwrap_or_else(empty))
    }

    /// Guarda o comando dos `Bash` em segundo plano e liga cada tarefa ao comando que a lançou.
    fn remember_task_command(&self, msg: &Value) {
        match msg.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let Some(blocks) = msg.pointer("/message/content").and_then(Value::as_array) else { return };
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") || block.get("name").and_then(Value::as_str) != Some("Bash") {
                        continue;
                    }
                    let input = block.get("input").unwrap_or(&Value::Null);
                    if input.get("run_in_background").and_then(Value::as_bool) != Some(true) { continue; }
                    if let (Some(id), Some(command)) = (block.get("id").and_then(Value::as_str), input.get("command").and_then(Value::as_str)) {
                        if let Ok(mut map) = self.bash_commands.lock() { map.insert(id.to_string(), command.to_string()); }
                    }
                }
            }
            Some("system") if msg.get("subtype").and_then(Value::as_str) == Some("task_started") => {
                let (Some(task), Some(tool)) = (msg.get("task_id").and_then(Value::as_str), msg.get("tool_use_id").and_then(Value::as_str)) else { return };
                let command = self.bash_commands.lock().ok().and_then(|m| m.get(tool).cloned());
                if let (Some(command), Ok(mut map)) = (command, self.task_commands.lock()) { map.insert(task.to_string(), command); }
            }
            _ => {}
        }
    }

    /// Guarda o arquivo final informado pelo Claude, sem aceitar caminhos fora da árvore temporária da sessão.
    fn remember_task_output(&self, msg: &Value) {
        if msg.get("type").and_then(Value::as_str) != Some("system")
            || msg.get("subtype").and_then(Value::as_str) != Some("task_notification")
        {
            return;
        }
        let (Some(root), Some(task_id), Some(raw_path)) = (
            self.task_output_root.as_deref(),
            msg.get("task_id").and_then(Value::as_str),
            msg.get("output_file").and_then(Value::as_str),
        ) else { return };
        if !safe_task_component(task_id) { return; }
        let path = Path::new(raw_path);
        let (Ok(root), Ok(path)) = (root.canonicalize(), path.canonicalize()) else { return };
        if path.starts_with(&root) {
            if let Ok(mut files) = self.task_output_files.lock() {
                files.insert(task_id.to_string(), path);
            }
        }
    }

    pub fn turn(&self) -> Option<String> {
        self.turn.lock().ok().and_then(|t| t.clone())
    }

    fn set_turn(&self, turn: Option<String>) {
        if let Ok(mut t) = self.turn.lock() {
            *t = turn;
        }
    }

    /// O guarda do Parar. Envenenado só se alguém panicou com a trava: o estado é trivial, segue com ele.
    fn gate<T>(&self, f: impl FnOnce(&mut StopGate) -> T) -> T {
        let mut gate = self.stop.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut gate)
    }

    /// O turno em andamento; sem um, abre outro com id novo, já sob o guarda do Parar. Devolve o id e se este
    /// chamador o abriu. O id existe antes de a mensagem sair: um Parar que chegar a partir daqui já vê o turno e
    /// fica pendente, em vez de achar a conversa sem turno com a mensagem a caminho.
    pub(super) fn ensure_turn(&self) -> (String, bool) {
        self.gate(|gate| {
            if let Some(turn) = self.turn() {
                return (turn, false);
            }
            let turn = uuid::Uuid::new_v4().to_string();
            gate.begin_turn();
            self.set_turn(Some(turn.clone()));
            (turn, true)
        })
    }

    /// Escreve a mensagem da pessoa. Se ela abre um turno, o id já existe antes da escrita (ver `ensure_turn`). Uma
    /// escrita que falha desfaz a abertura: a mensagem não saiu, e o Parar pendente nela morre junto. Devolve o id do
    /// turno e se este envio o abriu.
    pub(super) fn send_message(&self, message: &Value) -> Result<(String, bool), String> {
        let (turn, opened) = self.ensure_turn();
        match self.send(message) {
            Ok(()) => Ok((turn, opened)),
            Err(error) => {
                if opened {
                    self.gate(|gate| {
                        gate.on_completed(&turn);
                        if self.turn().as_deref() == Some(turn.as_str()) {
                            self.set_turn(None);
                        }
                    });
                }
                Err(error)
            }
        }
    }

    /// O turno acabou (o `result`, ou o processo caiu): tira o turno e o Parar pendente dele. Devolve o id, se havia um.
    pub(super) fn close_turn(&self) -> Option<String> {
        self.gate(|gate| {
            let turn = self.turn()?;
            gate.on_completed(&turn);
            self.set_turn(None);
            Some(turn)
        })
    }

    /// Um aviso do turno chegou: o Claude está rodando a mensagem. O Parar que esperava por isso sai agora, como o
    /// `turn/started` do Codex. Um Parar que já saiu não se repete.
    pub(super) fn confirm_turn(&self) {
        let Some(turn) = self.turn() else { return };
        if self.gate(|gate| gate.on_started(&turn)) {
            self.send_control("interrupt");
        }
    }

    /// Escreve um `control_request` sem esperar a resposta. Quem pediu o Parar já recebeu `Deferred`; a resposta chega
    /// sem pedido pendente e o laço de leitura a descarta.
    fn send_control(&self, subtype: &str) {
        let id = format!("ags-{}", self.next.fetch_add(1, Ordering::SeqCst));
        let _ = self.send(&json!({ "type": "control_request", "request_id": id, "request": { "subtype": subtype } }));
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
    session_with_fast_mode(app, db, thread_id, None).await
}

/// Abre ou retoma a conversa com a preferência Fast isolada nesta execução. O `--settings` só vale ao nascer o
/// processo: uma preferência diferente da do processo aberto, com a conversa parada, reabre a sessão (retomando).
/// `None` (comandos, fila, retomada) usa o processo que já está aberto, sem fechá-lo.
pub async fn session_with_fast_mode(app: &AppHandle, db: &DbConnection, thread_id: &str, fast_mode: Option<bool>) -> Result<Arc<Session>, String> {
    if let Some(session) = get(thread_id) {
        if fast_mode.is_none_or(|fast| fast == session.fast_mode) || session.turn().is_some() {
            return Ok(session);
        }
        close(thread_id);
    }
    // Uma trava por conversa: um Claude lento a abrir não segura o início das outras.
    let gate = resume::start_gate("claude", thread_id);
    let _guard = gate.lock().await;
    if let Some(s) = get(thread_id) {
        if fast_mode.is_none_or(|fast| fast == s.fast_mode) || s.turn().is_some() {
            return Ok(s);
        }
        close(thread_id);
    }
    // Sem preferência e sem processo aberto: nasce no padrão (sem Fast).
    let fast_mode = fast_mode.unwrap_or(false);
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
            open(app, db, row, env, Start::New(&id), fast_mode).await.map(|s| (s, id))
        }
    };
    let opened = match row.remote_id.clone() {
        Some(remote) => {
            resume::open_resuming(
                || {
                    let (env, remote, row) = (env.clone(), remote.clone(), &row);
                    async move { open(app, db, row, env, Start::Resume(&remote), fast_mode).await.map(|s| (s, remote)).map_err(|e| resume::classify(&e)) }
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

/// Abre a sessão da conversa `thread_id` como **fork** da sessão `from` (a da conversa de origem): a pergunta lateral
/// nasce como cópia dela. A origem não é tocada (outro processo, outra sessão), e o id novo é escolhido aqui. Falhou:
/// nada muda na conversa (quem chama cai no recorte do histórico).
/// `at`: o uuid do último turno concluído da origem, quando ela está no meio de outro turno (a cópia termina nele).
pub async fn open_forked(app: &AppHandle, db: &DbConnection, thread_id: &str, from: &str, at: Option<&str>) -> Result<(), String> {
    let gate = resume::start_gate("claude", thread_id);
    let _guard = gate.lock().await;
    if get(thread_id).is_some() {
        return Err("A conversa já tem sessão".into());
    }
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::thread(&conn, thread_id).map_err(|e| e.to_string())?.ok_or("Conversa não encontrada")?
    };
    let env = row.account_id.as_deref().and_then(|a| crate::accounts::env_for_account(db, a));
    let id = uuid::Uuid::new_v4().to_string();
    let session = open(app, db, &row, env, Start::Fork { from, id: &id, at }, false).await?;
    if let Ok(conn) = db.lock() {
        let _ = store::set_remote_id(&conn, thread_id, &id);
    }
    if let Ok(mut r) = session.remote.lock() {
        *r = Some(id);
    }
    if let Ok(mut map) = sessions().lock() {
        map.insert(thread_id.to_string(), session);
    }
    Ok(())
}

async fn open(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>, start: Start<'_>, fast_mode: bool) -> Result<Arc<Session>, String> {
    let session = spawn(app, db, row, env, start, fast_mode)?;
    // O `--resume` de uma sessão que não existe fecha o processo antes de responder.
    let init = session.control("initialize", json!({})).await;
    if let Ok(response) = &init {
        // Os comandos que o Claude anuncia viram a lista do composer, como o ACP faz com `available_commands_update`.
        emit(app, &row.id, "commands", json!({ "commands": claude_map::initialize_commands(response) }));
    }
    if let Err(e) = init {
        // O que o processo escreveu antes de fechar diz se a sessão sumiu ("No conversation found…").
        let tail = session.stderr.lock().ok().map(|t| t.iter().rev().take(2).rev().cloned().collect::<Vec<_>>().join(" | ")).unwrap_or_default();
        session.kill();
        return Err(if tail.trim().is_empty() { e } else { format!("{e}: {}", tail.trim()) });
    }
    Ok(session)
}

fn spawn(app: &AppHandle, db: &DbConnection, row: &store::ThreadRow, env: Option<HashMap<String, String>>, start: Start<'_>, fast_mode: bool) -> Result<Arc<Session>, String> {
    let task_output_root = claude_task_output_root(&row.cwd, env.as_ref());
    let name = crate::agents::agent_command("claude-code").unwrap_or("claude");
    let program = crate::util::find_program(name).ok_or("Não achei o Claude Code (claude) no PATH")?;
    let auto_compact_window = auto_compact_window(db, row);
    let (mut args, session_settings) = claude_map::launch_args_for_session(row, start, auto_compact_window, fast_mode);
    let mcp = crate::ipc::mcp::conversation_mcp(app, &row.cwd, &row.id, "claude-code");
    if let Some(mcp) = mcp.as_ref() {
        if let Some(config) = mcp.tab.config_path.as_deref() {
            args.extend(["--mcp-config".into(), config.into()]);
        }
        if !mcp.tab.allowed_tools.is_empty() {
            args.extend(["--allowedTools".into(), mcp.tab.allowed_tools.join(",")]);
        }
    }
    // O ai-memory entra por processo, como nas abas: hooks e MCP só no nascimento (a troca de modelo ou de acesso, e a
    // retomada, abrem outro processo e passam por aqui de novo). Falhar aqui nunca impede a conversa de abrir.
    let mut memory = memoria::for_thread(db, row, &program, &args, env.as_ref());
    memoria::merge_session_settings(&mut memory, &session_settings)?;
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
    if let Some(mcp) = mcp.as_ref() {
        cmd.envs(mcp.tab.env.iter().map(|(k, v)| (k, v)));
    }
    cmd.envs(memory.env.iter().map(|(k, v)| (k, v)));
    // Quem a conversa é para o `ags` (`thread:<id>`), para ela delegar e responder num time (`chat_team`).
    cmd.envs(crate::chat_team::env::thread_env(&row.id));
    let mut cmd = crate::util::spawn::into_tokio(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Não consegui abrir o Claude: {e}"))?;
    crate::chat_team::env::register_process(&row.id, child.id());
    memoria::record(app, db, row, &memory.state, memory.notice.as_deref());
    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let session = Arc::new(Session {
        thread_id: row.id.clone(),
        fast_mode,
        tx,
        pending: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        remote: Mutex::new(None),
        task_output_root,
        task_output_files: Mutex::new(HashMap::new()),
        cwd: PathBuf::from(&row.cwd),
        bash_commands: Mutex::new(HashMap::new()),
        task_commands: Mutex::new(HashMap::new()),
        turn: Mutex::new(None),
        stop: Mutex::new(StopGate::default()),
        background: Mutex::new(HashSet::new()),
        stale: AtomicBool::new(false),
        auto_compacting: AtomicBool::new(false),
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

/// Limite guardado por perfil de Claude: `system:claude-code` ou o id da conta ADE.
/// O mapa contém apenas números, nunca credenciais nem configuração global da TUI.
pub(super) fn auto_compact_window(db: &DbConnection, row: &store::ThreadRow) -> Option<u32> {
    let key = row.account_id.as_deref().unwrap_or("system:claude-code");
    let raw = crate::database::get_setting(db, AUTO_COMPACT_WINDOWS_SETTING).ok()??;
    let settings: HashMap<String, u32> = serde_json::from_str(&raw).ok()?;
    settings.get(key).copied().filter(|n| (100_000..=1_000_000).contains(n))
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
    session.gate(StopGate::reset);
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
    if let Some(turn) = session.close_turn() {
        session.auto_compacting.store(false, Ordering::SeqCst);
        let tail = session.stderr.lock().ok().and_then(|t| turn::stderr_reason(t.iter()));
        let (result, message) = turn::dropped(killed, tail.as_deref(), "Claude");
        // Sem o processo, o canal de tarefas morre com ele: nenhuma ferramenta fica de fora da marcação.
        finish_turn(app, db, thread_id, &turn, &result, &HashSet::new());
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
            session.remember_task_output(&msg);
            session.remember_task_command(&msg);
            let outs = session.mapper.lock().map(|mut m| m.feed(&msg, crate::util::now_ts_ms())).unwrap_or_default();
            for out in outs {
                on_out(app, db, session, out);
            }
            // Depois das saídas: a linha que abre um turno sem envio (o Claude começou sozinho) abre o turno aqui,
            // e só então o aviso dele vale para o Parar que estiver pendente.
            if is_turn_line(&msg) {
                session.confirm_turn();
            }
        }
    }
}

/// Espelha a raiz privada em que Claude Code 2.1 guarda os arquivos `tasks/<id>.output`.
fn claude_task_output_root(cwd: &str, env: Option<&HashMap<String, String>>) -> Option<PathBuf> {
    #[cfg(unix)]
    // SAFETY: `getuid` não recebe ponteiros nem acessa memória do chamador.
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    return None;
    #[cfg(unix)]
    {
        let from_env = |key: &str| env.and_then(|values| values.get(key).cloned()).or_else(|| std::env::var(key).ok());
        let base = from_env("CLAUDE_CODE_TMPDIR").filter(|v| !v.trim().is_empty()).or_else(|| {
            if cfg!(target_os = "macos") { Some("/tmp".to_string()) }
            else { from_env("TMPDIR").or_else(|| from_env("TMP")).or_else(|| from_env("TEMP")).or_else(|| Some("/tmp".to_string())) }
        })?;
        let base = PathBuf::from(base);
        let base = if base.is_absolute() { base } else { Path::new(cwd).join(base) };
        Some(base.join(format!("claude-{uid}")))
    }
}

fn safe_task_component(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Começa um turno (a pessoa mandou uma mensagem, ou o Claude seguiu sozinho com uma que estava
/// na fila). Devolve o id.
fn begin_turn(app: &AppHandle, db: &DbConnection, session: &Session) -> String {
    let (turn, opened) = session.ensure_turn();
    if opened {
        open_turn_rows(app, db, session, &turn);
    }
    turn
}

/// O que a conversa grava e mostra quando um turno abre: a linha do turno em andamento e a fase.
fn open_turn_rows(app: &AppHandle, db: &DbConnection, session: &Session, turn: &str) {
    if let Ok(conn) = db.lock() {
        let _ = store::upsert_run(&conn, &session.thread_id, turn, "inProgress", Some(crate::util::now_ts_ms()), None, None);
    }
    emit(app, &session.thread_id, "phase", json!({ "phase": "working", "turnId": turn }));
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

/// Fecha o turno do Claude no banco e na janela. Em qualquer fim (normal, interrompido, com erro ou por queda), as
/// ferramentas do turno que ficaram sem resultado viram «desfecho desconhecido», exceto as de `legit` (ver `gravar_fim`).
fn finish_turn(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, result: &claude_map::TurnResult, legit: &HashSet<String>) {
    let now = crate::util::now_ts_ms();
    let (expired, marked) = db.lock().ok().map(|conn| gravar_fim(&conn, thread_id, turn, result, legit, now)).unwrap_or_default();
    for id in expired {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    for item in marked {
        emit(app, thread_id, "item", json!({ "item": item }));
    }
    save_items(app, db, thread_id, Some(turn), vec![claude_map::turn_end(turn, result, Some(now))]);
    super::turn::after_turn_hooks(app, db, thread_id, result);
}

/// O que o banco guarda quando o turno do Claude acaba: o status, os pedidos pendentes que expiram (devolve os ids) e as
/// ferramentas sem desfecho, marcadas (devolve o que mudou, para a janela). `legit` são as tarefas em segundo plano que
/// seguem com o processo vivo; com o processo caído, `legit` vem vazio, porque o canal de tarefas morre com ele.
/// Separada de `finish_turn` para testar com `test_db()`.
pub(super) fn gravar_fim(
    conn: &rusqlite::Connection,
    thread_id: &str,
    turn: &str,
    result: &claude_map::TurnResult,
    legit: &HashSet<String>,
    now: i64,
) -> (Vec<String>, Vec<Item>) {
    let _ = store::upsert_run(conn, thread_id, turn, claude_map::run_status(result), None, Some(now), result.duration_ms);
    let expired = store::expire_requests(conn, thread_id).unwrap_or_default();
    let marked = turn::mark_unknown_outcomes_except(conn, thread_id, turn, now, legit).unwrap_or_default();
    (expired, marked)
}

/// O id do `tool_use` que lançou a tarefa, se o evento `task` é o começo de uma tarefa em segundo plano
/// (`is_backgrounded`). Pura: lê o que `tarefas::claude_task` devolveu.
pub(super) fn tarefa_em_segundo_plano(task: &Value) -> Option<String> {
    if task.get("op").and_then(Value::as_str) != Some("started") || task.get("background").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    task.get("toolUseId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string)
}

fn on_out(app: &AppHandle, db: &DbConnection, session: &Arc<Session>, out: Out) {
    let thread_id = session.thread_id.as_str();
    match out {
        Out::Item(item) => {
            let mut item = *item;
            if item.kind == ItemKind::Usage && session.auto_compacting.load(Ordering::SeqCst) {
                item.auto_compact_attempted = Some(true);
            }
            let turn = begin_turn(app, db, session);
            save_items(app, db, thread_id, Some(&turn), vec![item]);
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
        // As tarefas em segundo plano e o que um subagente faz vão só à janela (o painel de tarefas): não abrem turno,
        // porque o aviso de fim de um shell chega entre turnos, e não entram no banco da timeline.
        Out::Task(task) => {
            if let Some(id) = tarefa_em_segundo_plano(&task)
                && let Ok(mut background) = session.background.lock()
            {
                background.insert(id);
            }
            emit(app, thread_id, "task", json!({ "task": task }));
        }
        Out::SubItem { parent, item } => emit(app, thread_id, "taskItem", json!({ "parentToolUseId": parent, "item": item })),
        Out::Done(result) => {
            let Some(turn) = session.close_turn() else { return };
            session.auto_compacting.store(false, Ordering::SeqCst);
            if let Ok(mut asks) = session.asks.lock() {
                asks.clear();
            }
            // Com o processo vivo, as tarefas em segundo plano seguem depois do fim do turno: o desfecho delas não é deste turno.
            let legit = session.background.lock().map(|background| background.clone()).unwrap_or_default();
            // O uuid da última fala do agente neste turno: só um turno concluído o guarda (ponto estável do fork).
            let end_uuid = session.mapper.lock().ok().and_then(|mut mapper| mapper.take_end_uuid());
            finish_turn(app, db, thread_id, &turn, &result, &legit);
            if let Some(uuid) = end_uuid.filter(|_| claude_map::run_status(&result) == "completed")
                && let Ok(conn) = db.lock()
            {
                let _ = store::set_run_end_uuid(&conn, thread_id, &turn, &uuid);
            }
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
    // O turno, se a mensagem o abre, existe antes da escrita (ver `Session::ensure_turn`): nenhum Parar vê a conversa sem turno.
    let effort = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        store::thread(&conn, &session.thread_id).map_err(|error| error.to_string())?.and_then(|row| row.effort)
    };
    let prompt = claude_map::prompt_with_effort(text, effort.as_deref());
    let (turn, opened) = session.send_message(&claude_map::user_message_with(&prompt, images))?;
    if opened {
        open_turn_rows(app, db, session, &turn);
    }
    let item = Item { text: Some(super::handoff::clip_user(text, 20_000)), ..Item::new(ItemKind::User, format!("u:{}", uuid::Uuid::new_v4()), Some(crate::util::now_ts_ms())) };
    save_items(app, db, &session.thread_id, Some(&turn), vec![item]);
    Ok(())
}

/// Envia o `/compact` da automação local e marca o uso resultante para não repeti-lo ao reabrir.
pub fn send_auto_compact(app: &AppHandle, db: &DbConnection, session: &Arc<Session>) -> Result<(), String> {
    session.auto_compacting.store(true, Ordering::SeqCst);
    if let Err(error) = send_user(app, db, session, "/compact", Vec::new()) {
        session.auto_compacting.store(false, Ordering::SeqCst);
        return Err(error);
    }
    Ok(())
}

/// Para o turno em andamento. Enquanto o Claude não mostrou que o turno roda, o Parar fica pendente (`Deferred`) e sai
/// no primeiro aviso do turno (`confirm_turn`). Quando sai, espera a resposta do `control_request`, como antes.
pub async fn interrupt(session: &Session) -> Result<StopAction, String> {
    let action = session.gate(|gate| gate.request_stop(session.turn().as_deref()));
    if let StopAction::Send(_) = action {
        session.control("interrupt", json!({})).await?;
    }
    Ok(action)
}

/// Uma linha que só o turno em andamento produz: o Claude está rodando a mensagem. Não contam o `init`, o
/// `commands_changed` nem o `rate_limit_event`, e o `result` é o fim do turno (ver `Session::close_turn`).
pub(super) fn is_turn_line(msg: &Value) -> bool {
    match msg.get("type").and_then(Value::as_str) {
        Some("stream_event" | "assistant" | "user") => true,
        Some("system") => msg.get("subtype").and_then(Value::as_str) == Some("status"),
        _ => false,
    }
}

/// Uma sessão sem processo para os testes do Parar: o que ela escreveria no stdio chega ao receptor. A conversa aponta
/// para ela, como em produção, para que `api::interrupt` a encontre.
#[cfg(test)]
pub(crate) fn session_for_test(thread_id: &str) -> (Arc<Session>, mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let session = Arc::new(Session {
        thread_id: thread_id.to_string(),
        fast_mode: false,
        tx,
        pending: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        remote: Mutex::new(Some("remoto-1".to_string())),
        task_output_root: None,
        task_output_files: Mutex::new(HashMap::new()),
        cwd: PathBuf::new(),
        bash_commands: Mutex::new(HashMap::new()),
        task_commands: Mutex::new(HashMap::new()),
        turn: Mutex::new(None),
        stop: Mutex::new(StopGate::default()),
        background: Mutex::new(HashSet::new()),
        stale: AtomicBool::new(false),
        auto_compacting: AtomicBool::new(false),
        mapper: Mutex::new(Mapper::default()),
        asks: Mutex::new(HashMap::new()),
        stderr: Mutex::new(VecDeque::new()),
        child: Mutex::new(None),
        _memory: TabInjection::default(),
    });
    if let Ok(mut map) = sessions().lock() {
        map.insert(thread_id.to_string(), session.clone());
    }
    (session, rx)
}

/// Responde ao pedido de controle `request_id` da sessão de teste, como o laço de leitura faria com a resposta do Claude.
#[cfg(test)]
pub(crate) fn respond_for_test(session: &Session, request_id: &str) {
    if let Some(reply) = session.pending.lock().ok().and_then(|mut p| p.remove(request_id)) {
        let _ = reply.send(Ok(Value::Null));
    }
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
