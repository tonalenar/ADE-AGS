//! O núcleo das conversas por protocolo: o que a tela (comandos Tauri, `commands`), a CLI `ags chat`
//! e o MCP fazem, pelo mesmo caminho. Recebe o app e o banco; nunca segura o lock do banco durante
//! o I/O com o agente.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::TransactionBehavior;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::canal::timeline::{Item, ItemKind};
use crate::database::DbConnection;

use super::codex::RequestFailure;
use super::envio::{SendError, SendMode};
use super::store::{self, MessageSearchHit, RequestRow, ThreadRow, Tuning};
use super::{agy, claude, codex, codex_map, cursor, opencode};

/// Quem fala com o agente de uma conversa por protocolo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// `codex app-server` (`codex.rs`).
    Codex,
    /// `claude -p` em stream-json (`claude.rs`).
    Claude,
    /// `opencode acp`, o Agent Client Protocol por stdio (`opencode.rs`).
    OpenCode,
    /// `agy --input-format stream-json`, um processo persistente por conversa (`agy.rs`).
    Antigravity,
    /// `cursor-agent -p --output-format stream-json`, um processo por turno (`cursor.rs`).
    Cursor,
}

/// Registro dos motores de conversa por protocolo. A matriz recebe o mesmo id que `Engine::of` resolve.
const CHAT_ENGINE_REGISTRY: [(&str, Engine); 5] = [
    ("codex", Engine::Codex),
    ("claude-code", Engine::Claude),
    ("opencode", Engine::OpenCode),
    ("antigravity", Engine::Antigravity),
    ("cursor", Engine::Cursor),
];

/// Capacidades observáveis do runtime de conversa. A camada de orquestração consulta este
/// contrato em vez de inferir suporte pelo nome do agente.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    /// Modos que este runtime realmente aceita no ADE.
    pub access_modes: &'static [&'static str],
    pub plan: bool,
    /// Se uma nova mensagem pode entrar no turno vivo sem encerrar o turno.
    pub mid_turn: MidTurnBehavior,
    pub context_compaction: bool,
    pub automatic_compaction: bool,
    pub persistent_goal: bool,
    pub goal_pause_resume: bool,
    /// A pergunta lateral pode nascer como fork nativo da sessão da origem (`conversa::fork`); sem isso, vale o recorte.
    pub session_fork: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MidTurnBehavior {
    Steer,
    Interrupt,
}

impl Engine {
    /// Protocolo usado pelo runtime da conversa. É informativo: cada adapter continua
    /// preservando seu processo e seu formato nativo.
    pub const fn protocol(self) -> &'static str {
        match self {
            Engine::Codex => "codex-app-server",
            Engine::Claude => "claude-stream-json",
            Engine::OpenCode => "agent-client-protocol",
            Engine::Antigravity => "antigravity-stream-json",
            Engine::Cursor => "cursor-stream-json",
        }
    }

    /// Capacidades descritas só quando já há implementação no runtime atual. Isso não torna
    /// providers diferentes iguais por baixo: cada adapter continua usando o protocolo nativo.
    pub fn capabilities(self) -> EngineCapabilities {
        let provider = self.provider_id();
        let supported = |capability| {
            crate::harness::matrix::supports(
                provider,
                crate::harness::capability::Surface::Chat,
                capability,
            )
                .is_some_and(|support| support != crate::harness::capability::Support::Unsupported)
        };
        let fork = crate::harness::matrix::find(crate::harness::capability::Surface::Chat, provider)
            .is_some_and(|column| column.fork.promises());
        let mid_turn = if supported(crate::harness::capability::Capability::Steer) {
            MidTurnBehavior::Steer
        } else {
            MidTurnBehavior::Interrupt
        };
        match self {
            Engine::Codex => EngineCapabilities {
                // `edits` não aparece na tela do Codex, mas continua aceito pela CLI e pelo MCP:
                // `codex_map` o trata como `safe` (`on-request`, `workspace-write`).
                access_modes: &["ask", "edits", "safe", "full"],
                plan: supported(crate::harness::capability::Capability::Plan),
                mid_turn,
                context_compaction: supported(crate::harness::capability::Capability::Compact),
                automatic_compaction: false,
                persistent_goal: supported(crate::harness::capability::Capability::Goal),
                goal_pause_resume: true,
                session_fork: fork,
            },
            Engine::Claude => EngineCapabilities {
                access_modes: &["ask", "edits", "safe", "full", "plan"],
                plan: supported(crate::harness::capability::Capability::Plan),
                mid_turn,
                context_compaction: supported(crate::harness::capability::Capability::Compact),
                automatic_compaction: true,
                persistent_goal: supported(crate::harness::capability::Capability::Goal),
                goal_pause_resume: false,
                session_fork: fork,
            },
            Engine::OpenCode => EngineCapabilities {
                access_modes: &["ask", "edits", "safe", "full", "plan"],
                plan: supported(crate::harness::capability::Capability::Plan),
                mid_turn,
                context_compaction: supported(crate::harness::capability::Capability::Compact),
                automatic_compaction: false,
                persistent_goal: supported(crate::harness::capability::Capability::Goal),
                goal_pause_resume: false,
                session_fork: fork,
            },
            Engine::Antigravity => EngineCapabilities {
                access_modes: &["ask", "edits", "safe", "full", "plan"],
                plan: supported(crate::harness::capability::Capability::Plan),
                mid_turn,
                context_compaction: supported(crate::harness::capability::Capability::Compact),
                automatic_compaction: false,
                persistent_goal: supported(crate::harness::capability::Capability::Goal),
                goal_pause_resume: false,
                session_fork: fork,
            },
            Engine::Cursor => EngineCapabilities {
                access_modes: &["ask", "full", "plan"],
                plan: supported(crate::harness::capability::Capability::Plan),
                mid_turn,
                context_compaction: supported(crate::harness::capability::Capability::Compact),
                automatic_compaction: false,
                persistent_goal: supported(crate::harness::capability::Capability::Goal),
                goal_pause_resume: false,
                session_fork: fork,
            },
        }
    }

    fn provider_id(self) -> &'static str {
        CHAT_ENGINE_REGISTRY
            .iter()
            .find_map(|(provider, engine)| (*engine == self).then_some(*provider))
            .expect("todo Engine precisa ter id no registro de conversa")
    }

    pub fn supports_access(self, access: &str) -> bool {
        let capabilities = self.capabilities();
        (access != "plan" || capabilities.plan) && capabilities.access_modes.contains(&access)
    }

    pub fn of(agent_id: &str) -> Option<Engine> {
        CHAT_ENGINE_REGISTRY
            .iter()
            .find_map(|(provider, engine)| (*provider == agent_id).then_some(*engine))
            .or_else(|| crate::local_acp::is_local_acp_id(agent_id).then_some(Engine::OpenCode))
    }

    /// Os acessos que o agente aceita. O Plano é um modo do Claude (permissão), do OpenCode (o agente
    /// `plan`), do Antigravity (`--mode plan`) e do Cursor (`--mode plan`); o Codex não tem. O Cursor só tem
    /// Supervisionado, Plano e Acesso total: Aceitar edições e Auto não têm flag documentada.
    pub fn accepts(self, access: &str) -> bool {
        self.supports_access(access)
    }
}

/// Os agentes que falam por protocolo no chat.
pub fn structured_agent(agent_id: &str) -> bool {
    Engine::of(agent_id).is_some()
}

fn engine_for(agent_id: &str) -> Result<Engine, String> {
    Engine::of(agent_id).ok_or_else(|| format!("{agent_id} não conversa por protocolo"))
}

fn engine_of(row: &ThreadRow) -> Result<Engine, String> {
    engine_for(&row.agent_id)
}

pub(crate) fn unsupported_capability_error(
    provider: &str,
    capability: crate::harness::capability::Capability,
) -> Option<String> {
    crate::harness::matrix::unsupported_capability_error(
        provider,
        crate::harness::capability::Surface::Chat,
        capability,
    )
}

/// O turno em andamento de uma conversa, em qualquer um dos agentes. `None` = sem processo aberto.
fn live_turn(thread_id: &str) -> Option<Option<String>> {
    codex::get(thread_id)
        .map(|s| s.turn())
        .or_else(|| claude::get(thread_id).map(|s| s.turn()))
        .or_else(|| opencode::get(thread_id).map(|s| s.turn()))
        .or_else(|| agy::get(thread_id).map(|s| s.turn()))
        .or_else(|| cursor::get(thread_id).map(|s| s.turn()))
}

/// Fecha o processo do agente da conversa, qualquer que seja.
fn close(thread_id: &str) {
    super::autocompact::on_closed(thread_id);
    codex::close(thread_id);
    claude::close(thread_id);
    opencode::close(thread_id);
    agy::close(thread_id);
    cursor::close(thread_id);
}

/// Fecha o processo do agente (a troca de conta do pool usa).
pub(super) fn close_process(thread_id: &str) {
    close(thread_id);
}

fn db_err(e: impl ToString) -> String {
    e.to_string()
}

pub fn threads(db: &DbConnection) -> Result<Vec<ThreadRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::threads(&conn).map_err(db_err)
}

pub fn thread(db: &DbConnection, thread_id: &str) -> Result<ThreadRow, String> {
    let conn = db.lock().map_err(db_err)?;
    store::thread(&conn, thread_id).map_err(db_err)?.ok_or_else(|| format!("Conversa {thread_id} não encontrada"))
}

/// O que se escolhe ao abrir uma conversa.
#[derive(Clone, Debug)]
pub struct NewThread {
    pub agent_id: String,
    pub cwd: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: String,
    pub account_id: Option<String>,
    pub parent_ref: Option<String>,
}

pub fn create(db: &DbConnection, input: NewThread) -> Result<ThreadRow, String> {
    create_inner(db, input, None, false).map(|outcome| outcome.thread)
}

/// Identidade estável de um pedido de conversa filha feito pelo harness.
#[derive(Clone, Debug)]
pub struct ChildRequestIdentity {
    pub caller_key: String,
    pub request_id: String,
    pub request_hash: String,
}

#[derive(Clone, Debug)]
pub struct ChildThreadOutcome {
    pub thread: ThreadRow,
    pub reused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChildDeliveryClaim {
    Claimed { thread_id: String },
    AlreadyClaimed { thread_id: String, state: String },
}

/// Cria a conversa e o recibo na mesma transação. Repetições do mesmo pedido retornam a thread
/// já criada; o prompt inicial é reclamado separadamente antes do I/O com o provider.
pub fn create_child(
    db: &DbConnection,
    input: NewThread,
    identity: &ChildRequestIdentity,
) -> Result<ChildThreadOutcome, String> {
    create_inner(db, input, Some(identity), false)
}

/// Como [`create_child`], e o acompanhamento do resultado (`harness_child_watch`) entra na **mesma**
/// transação que grava a conversa e o recibo. Uma queda no meio não deixa filha sem entrega.
pub fn create_child_async(
    db: &DbConnection,
    input: NewThread,
    identity: &ChildRequestIdentity,
) -> Result<ChildThreadOutcome, String> {
    create_inner(db, input, Some(identity), true)
}

fn existing_child_outcome(
    conn: &rusqlite::Connection,
    identity: &ChildRequestIdentity,
) -> Result<Option<ChildThreadOutcome>, String> {
    let Some(receipt) = store::child_chat_receipt(conn, &identity.caller_key, &identity.request_id)
        .map_err(db_err)?
    else {
        return Ok(None);
    };
    if receipt.request_hash != identity.request_hash {
        return Err("client_request_id já foi usado com outro conteúdo; use um ID novo".into());
    }
    let thread = store::thread(conn, &receipt.thread_id)
        .map_err(db_err)?
        .ok_or_else(|| {
            "a conversa criada por este client_request_id foi removida; use um ID novo".to_string()
        })?;
    Ok(Some(ChildThreadOutcome {
        thread,
        reused: true,
    }))
}

fn create_inner(
    db: &DbConnection,
    input: NewThread,
    identity: Option<&ChildRequestIdentity>,
    async_watch: bool,
) -> Result<ChildThreadOutcome, String> {
    if let Some(identity) = identity {
        let conn = db.lock().map_err(db_err)?;
        if let Some(outcome) = existing_child_outcome(&conn, identity)? {
            if async_watch {
                register_chat_watch(&conn, &outcome.thread)?;
            }
            return Ok(outcome);
        }
    }
    if !structured_agent(&input.agent_id) {
        return Err(format!(
            "{} ainda não conversa por protocolo",
            input.agent_id
        ));
    }
    let engine = engine_for(&input.agent_id)?;
    if crate::local_acp::is_local_acp_id(&input.agent_id) {
        if !crate::local_acp::contains(db, &input.agent_id)? {
            return Err("Este agente ACP local não está mais cadastrado".into());
        }
        if input.access != "ask"
            || input.model.is_some()
            || input.effort.is_some()
            || input.account_id.is_some()
        {
            return Err(
                "Agentes ACP locais iniciam em Supervisionado, sem conta, modelo ou esforço da ADE"
                    .into(),
            );
        }
    }
    if !engine.accepts(&input.access) {
        return Err(access_error(engine, &input.access));
    }
    {
        let conn = db.lock().map_err(db_err)?;
        crate::project_chat_policy::ensure_agent_enabled(&conn, &input.cwd, &input.agent_id)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    // `pool:<nome>` no lugar da conta: o pool escolhe a conta agora e a conversa fica ligada a ele (o pool de
    // contas do chat só troca com o pool escolhido pela pessoa).
    let (account_id, pool_id) = match input
        .account_id
        .as_deref()
        .and_then(crate::accounts::pools::pool_ref)
    {
        Some(name) => {
            let (account, pool) = super::pool::resolve_at_create(db, &input.agent_id, name)?;
            (account, Some(pool))
        }
        None => (input.account_id.clone(), None),
    };
    let (row, created) = {
        let mut conn = db.lock().map_err(db_err)?;
        crate::project_chat_policy::ensure_agent_enabled(&conn, &input.cwd, &input.agent_id)?;
        let tuning = Tuning {
            model: input.model,
            effort: input.effort,
            access: input.access,
        };
        if let Some(parent_ref) = input.parent_ref.as_deref() {
            if parent_ref.trim().is_empty() || parent_ref.len() > 512 {
                return Err("Referência da conversa de origem inválida".into());
            }
        }

        if let Some(identity) = identity {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_err)?;
            if let Some(outcome) = existing_child_outcome(&tx, identity)? {
                if async_watch {
                    register_chat_watch(&tx, &outcome.thread)?;
                }
                tx.commit().map_err(db_err)?;
                (outcome.thread, false)
            } else {
                let inherited_workspace = input
                    .parent_ref
                    .as_deref()
                    .and_then(|parent| parent.strip_prefix("thread:"))
                    .and_then(|parent| store::thread_workspace_id(&tx, parent).ok().flatten());
                let workspace_id = input
                    .workspace_id
                    .clone()
                    .or(inherited_workspace)
                    .or_else(|| crate::runs::store::workspace_of_folder(&tx, &input.cwd));
                validate_workspace(&tx, workspace_id.as_deref())?;
                let now = crate::util::now_ts_ms();
                let row = store::insert_thread_with_context(
                    &tx,
                    &id,
                    &input.agent_id,
                    &input.cwd,
                    &input.title,
                    &tuning,
                    account_id.as_deref(),
                    input.parent_ref.as_deref(),
                    workspace_id.as_deref(),
                    now,
                )
                .map_err(db_err)?;
                store::save_child_chat_receipt(
                    &tx,
                    &identity.caller_key,
                    &identity.request_id,
                    &identity.request_hash,
                    &row.id,
                    "prepared",
                    now,
                )
                .map_err(db_err)?;
                if async_watch {
                    register_chat_watch(&tx, &row)?;
                }
                tx.commit().map_err(db_err)?;
                (row, true)
            }
        } else {
            let inherited_workspace = input
                .parent_ref
                .as_deref()
                .and_then(|parent| parent.strip_prefix("thread:"))
                .and_then(|parent| store::thread_workspace_id(&conn, parent).ok().flatten());
            let workspace_id = input
                .workspace_id
                .clone()
                .or(inherited_workspace)
                .or_else(|| crate::runs::store::workspace_of_folder(&conn, &input.cwd));
            validate_workspace(&conn, workspace_id.as_deref())?;
            let now = crate::util::now_ts_ms();
            let row = store::insert_thread_with_context(
                &conn,
                &id,
                &input.agent_id,
                &input.cwd,
                &input.title,
                &tuning,
                account_id.as_deref(),
                input.parent_ref.as_deref(),
                workspace_id.as_deref(),
                now,
            )
            .map_err(db_err)?;
            (row, true)
        }
    };
    if created {
        let conn = db.lock().map_err(db_err)?;
        if let Err(error) = crate::skills::reconcile_link_dir(&conn, &row.cwd, &row.agent_id) {
            eprintln!(
                "[skills] não consegui preparar as skills sempre ativas para a conversa {}: {error}",
                row.id
            );
        }
    }
    if created && let Some(pool) = pool_id {
        super::pool::bind(db, &id, Some(&pool))?;
    }
    Ok(ChildThreadOutcome {
        thread: row,
        reused: !created,
    })
}

/// O acompanhamento da conversa filha, na conexão ou na transação de quem está criando.
fn register_chat_watch(conn: &rusqlite::Connection, row: &ThreadRow) -> Result<(), String> {
    let Some(parent_ref) = row.parent_ref.as_deref() else { return Ok(()) };
    crate::harness::child_delivery::register(
        conn,
        &crate::harness::child_delivery::WatchSpec {
            kind: crate::harness::delegate::Target::ProviderChat,
            child_ref: &row.id,
            parent_ref,
            title: &row.title,
            agent_id: &row.agent_id,
            parent_turn_id: row.parent_turn_id.as_deref(),
            session_id: None,
            message_id: None,
        },
        crate::util::now_ts_ms(),
    )?;
    Ok(())
}

fn validate_workspace(conn: &rusqlite::Connection, workspace_id: Option<&str>) -> Result<(), String> {
    if let Some(workspace_id) = workspace_id {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL)",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if !exists {
            return Err("O workspace desta conversa não existe mais".into());
        }
    }
    Ok(())
}

/// Reclama o primeiro envio uma única vez. Um estado `submitting` persistido após reinício é
/// tratado como incerto: a ADE não repete o prompt sem confirmação do provider.
pub fn claim_child_delivery(
    db: &DbConnection,
    identity: &ChildRequestIdentity,
) -> Result<ChildDeliveryClaim, String> {
    let mut conn = db.lock().map_err(db_err)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let receipt = store::child_chat_receipt(&tx, &identity.caller_key, &identity.request_id)
        .map_err(db_err)?
        .ok_or_else(|| "o recibo da conversa filha não foi encontrado".to_string())?;
    if receipt.request_hash != identity.request_hash {
        return Err("client_request_id já foi usado com outro conteúdo; use um ID novo".into());
    }
    let claimable = matches!(receipt.delivery_state.as_str(), "prepared" | "retryable");
    if claimable {
        let changed = store::transition_child_chat_receipt(
            &tx,
            &identity.caller_key,
            &identity.request_id,
            &[receipt.delivery_state.as_str()],
            "submitting",
            crate::util::now_ts_ms(),
        )
        .map_err(db_err)?;
        if changed {
            tx.commit().map_err(db_err)?;
            return Ok(ChildDeliveryClaim::Claimed { thread_id: receipt.thread_id });
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(ChildDeliveryClaim::AlreadyClaimed {
        thread_id: receipt.thread_id,
        state: receipt.delivery_state,
    })
}

pub fn finish_child_delivery(
    db: &DbConnection,
    identity: &ChildRequestIdentity,
    state: &str,
) -> Result<(), String> {
    if !matches!(state, "accepted" | "retryable" | "unknown") {
        return Err("estado final do primeiro envio inválido".into());
    }
    let conn = db.lock().map_err(db_err)?;
    let changed = store::transition_child_chat_receipt(
        &conn,
        &identity.caller_key,
        &identity.request_id,
        &["submitting"],
        state,
        crate::util::now_ts_ms(),
    )
    .map_err(db_err)?;
    if !changed {
        return Err("o estado do primeiro envio mudou antes de ser salvo".into());
    }
    Ok(())
}

/// Apaga somente uma conversa lateral ociosa; conversas normais e turnos em execução ficam protegidos.
pub async fn delete_side_chat(db: &DbConnection, thread_id: &str) -> Result<(), String> {
    // Serializa remoção e envio: uma mensagem que chegou primeiro termina antes da checagem; uma que
    // chegar depois encontra a conversa já removida, sem iniciar processo órfão.
    let gate = send_gate(thread_id);
    let _held = gate.lock().await;
    let row = thread(db, thread_id)?;
    if !row.is_side_chat {
        return Err("Só conversas laterais podem ser removidas por esta ação".into());
    }
    if status(thread_id).working {
        return Err("Pare a conversa lateral antes de removê-la".into());
    }
    if !requests(db, thread_id)?.is_empty() {
        return Err("Resolva os pedidos pendentes antes de remover a conversa lateral".into());
    }
    close(thread_id);
    let conn = db.lock().map_err(db_err)?;
    if !store::delete_side_chat(&conn, thread_id).map_err(db_err)? {
        return Err(format!("Conversa lateral {thread_id} não encontrada"));
    }
    Ok(())
}

fn access_error(engine: Engine, access: &str) -> String {
    let supported = engine.capabilities().access_modes.join(", ");
    format!("Acesso inválido: {access} ({supported})")
}

/// Avisa a tela que a lista mudou (uma conversa criada fora dela, pela CLI).
pub fn announce(app: &AppHandle, row: &ThreadRow) {
    super::events::emit(app, &row.id, "created", json!({ "thread": row }));
}

/// Manda uma mensagem: começa um turno, ou entra no turno em andamento (`turn/steer`). É o envio da pessoa
/// (tela, `ags chat`): entra no turno, como sempre foi. A fila de mensagens entre agentes usa [`send_mode`].
pub async fn send(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str) -> Result<(), String> {
    send_with(app, db, thread_id, text, &[]).await
}

/// Como [`send`], com as imagens anexadas (caminhos). Só o Claude as recebe em linha; nos outros
/// motores o caminho já está no texto (ver `attach`). Uma imagem que não cabe nos limites segue só
/// pelo texto: nunca derruba a mensagem.
pub async fn send_with(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str, images: &[String]) -> Result<(), String> {
    send_with_fast_mode(app, db, thread_id, text, images, None).await
}

/// Envia uma mensagem com a preferência Fast do composer. `None` (envios internos: fila, retomada, comandos)
/// herda o que a conversa já usa, sem reabrir o processo nem trocar o nível.
pub async fn send_with_fast_mode(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    images: &[String],
    fast_mode: Option<bool>,
) -> Result<(), String> {
    send_with_class(app, db, thread_id, text, images, fast_mode).await.map_err(String::from)
}

/// Como [`send_with`], mas com a classe do erro (ver [`SendError`]): o envio com recibo precisa saber se a
/// mensagem pode ter chegado.
async fn send_with_class(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str, images: &[String], fast_mode: Option<bool>) -> Result<(), SendError> {
    // A conta original renovou (conversa que trocou pelo pool)? Volta antes de enviar, só com a conversa livre.
    let text = if status(thread_id).working { text.to_string() } else { super::pool::before_send(app, db, thread_id, text) };
    send_mode_with_fast_mode(app, db, thread_id, &text, SendMode::SteerActive, images, fast_mode).await
}

/// O envio da pessoa com `client_request_id` (Fase 2, contrato §11.7): um reenvio idêntico devolve o recibo
/// e **não** manda a mensagem de novo; o mesmo id com outro conteúdo falha. `scope` é quem chamou (aba ou
/// conversa do MCP; `ui`, `cli`). Sem id, use [`send_with`].
pub async fn send_with_request(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    images: &[String],
    scope: &str,
    request_id: &str,
) -> Result<super::send_receipt::SendReceipt, String> {
    send_with_request_and_fast_mode(app, db, thread_id, text, images, scope, request_id, None).await
}

/// Como [`send_with_request`], propagando o Fast escolhido no composer.
pub async fn send_with_request_and_fast_mode(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    images: &[String],
    scope: &str,
    request_id: &str,
    fast_mode: Option<bool>,
) -> Result<super::send_receipt::SendReceipt, String> {
    let identity = super::send_receipt::identity(scope, request_id, thread_id, text, images)?;
    // A conversa precisa existir antes de a intenção ser gravada.
    thread(db, thread_id)?;
    let owner = format!("send:{}", uuid::Uuid::new_v4());
    super::send_receipt::run(db, &identity, thread_id, &owner, &crate::util::now_ts_ms, || {
        send_with_class(app, db, thread_id, text, images, fast_mode)
    })
    .await
}

/// Uma trava por conversa: a checagem do turno e o envio (`turn/start`/`turn/steer`) acontecem juntos, sem
/// outro envio no meio. Vale para todo chamador (tela, CLI, fila de mensagens entre agentes). É
/// `tokio::sync::Mutex` porque é segurada através de `.await`.
pub(super) fn send_gate(thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut map = GATES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(thread_id.to_string()).or_default().clone()
}

/// Pura: o modo deixa a mensagem entrar agora? `queue_after_active` só com a conversa livre.
pub(super) fn admits(mode: SendMode, working: bool) -> bool {
    mode == SendMode::SteerActive || !working
}

/// Pura: o `turn/steer` foi recusado pelo Codex. Se o turno que se tentou guiar já não é o atual (acabou
/// ou foi trocado no meio), a mensagem segue como `turn/start`; senão a recusa é de outro motivo.
pub(super) fn steer_falls_back_to_start(steered: &str, current: Option<&str>) -> bool {
    current != Some(steered)
}

/// Pura: o pedido ao Codex falhou: pode ter sido executado? Só o que SAIU e perdeu a resposta é `Unknown`.
pub(super) fn codex_error(failure: RequestFailure) -> SendError {
    match failure {
        RequestFailure::NotSent(m) | RequestFailure::Rejected(m) => SendError::NotSent(m),
        // O pedido saiu e a resposta se perdeu (o prazo do `turn/start`, o processo que caiu): o turno pode estar
        // aberto. Quem reenviar pode duplicar a ordem, então a mensagem diz para conferir antes.
        RequestFailure::Lost(m) => SendError::Unknown(format!("{m}. A mensagem pode ter chegado ao agente: confira a conversa antes de reenviar.")),
    }
}

/// Manda uma mensagem à conversa no modo dado, com a classe do erro (ver [`SendError`]). Qualquer falha antes
/// de a mensagem chegar ao agente (a sessão não abre, o processo já fechou, o canal de escrita fechou) é
/// `NotSent`; um pedido que saiu e perdeu a resposta é `Unknown`.
pub async fn send_mode(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str, mode: SendMode, images: &[String]) -> Result<(), SendError> {
    send_mode_with_fast_mode(app, db, thread_id, text, mode, images, None).await
}

async fn send_mode_with_fast_mode(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    mode: SendMode,
    images: &[String],
    fast_mode: Option<bool>,
) -> Result<(), SendError> {
    // Uma mensagem nova (da pessoa, de um agente ou da fila) já continua a conversa: a retomada agendada depois do
    // limite não tem mais o que fazer. A retomada em si apaga o plano antes de enviar, então não se cancela sozinha.
    super::limite::cancel_resume(db, thread_id);
    // Conversa que acabou de trocar de agente: o resumo do contexto vai na frente desta mensagem e só sai da fila
    // de pendências quando a mensagem foi de fato enviada (uma recusa não o perde).
    let (framed, carries_summary) = super::troca::before_send(db, thread_id, text);
    // Pergunta lateral recém-forkada: o contexto portátil (ou o digest da origem) vai na frente da primeira mensagem, com
    // a mesma regra: só sai da fila quando a mensagem foi de fato enviada.
    let (framed, carries_fork) = super::fork_portatil::before_send(db, thread_id, &framed);
    let sent = send_framed(app, db, thread_id, &framed, mode, images, fast_mode).await;
    if sent.is_ok() {
        if carries_summary {
            super::troca::summary_sent(db, thread_id);
        }
        if carries_fork {
            super::fork_portatil::sent(db, thread_id);
        }
    }
    sent
}

async fn send_framed(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str, mode: SendMode, images: &[String], fast_mode: Option<bool>) -> Result<(), SendError> {
    let gate = send_gate(thread_id);
    let _held = gate.lock().await;
    let row = {
        let conn = db.lock().map_err(|error| SendError::NotSent(db_err(error)))?;
        let row = store::thread(&conn, thread_id)
            .map_err(|error| SendError::NotSent(db_err(error)))?
            .ok_or_else(|| SendError::NotSent(format!("Conversa {thread_id} não encontrada")))?;
        crate::project_chat_policy::ensure_agent_enabled(&conn, &row.cwd, &row.agent_id)
            .map_err(SendError::NotSent)?;
        row
    };
    let engine = engine_of(&row).map_err(SendError::NotSent)?;
    if let Some(error) = unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Send) {
        return Err(SendError::NotSent(error));
    }
    if crate::local_acp::is_local_acp_id(&row.agent_id) {
        let exists = crate::local_acp::contains(db, &row.agent_id).map_err(SendError::NotSent)?;
        if !exists {
            return Err(SendError::NotSent("O agente ACP local não está mais cadastrado".into()));
        }
        if row.access != "ask" || row.account_id.is_some() {
            return Err(SendError::NotSent("A conversa ACP local aceita somente Supervisionado e não usa conta da ADE".into()));
        }
    }
    if !admits(mode, status(thread_id).working) {
        return Err(SendError::Busy);
    }
    // Compactando o contexto (autocompact): a mensagem espera. A fila do composer e a fila entre agentes a seguram e
    // a soltam quando o aviso «Contexto compactado» fecha.
    if super::autocompact::is_compacting(thread_id) {
        return Err(SendError::Busy);
    }
    // O turno anterior caiu com ferramenta sem resultado: o agente fica sabendo antes da mensagem nova.
    let noted = {
        let conn = db.lock().map_err(|e| SendError::NotSent(db_err(e)))?;
        super::resume::unknown_outcome_note(&store::tail_items(&conn, thread_id, 50).unwrap_or_default())
    };
    let text = &super::resume::with_note(noted.as_deref(), text);
    // Por motor, o que um `Err` quer dizer (revisado caso a caso; na dúvida seria `Unknown`):
    // - Claude: `session` só sobe o processo e o `initialize`; `send_user` falha só se o canal de escrita
    //   já fechou, e aí nada foi escrito;
    // - OpenCode: `send_user` falha antes de qualquer pedido (processo fechado, conversa sem sessão); o
    //   `session/prompt` roda em outra task e o erro dele vira erro do turno, não retorno daqui;
    // - Antigravity: `send` aceita a mensagem; spawn e falhas do protocolo são resolvidos na task do turno;
    // - Codex: ver o `RequestFailure` (saiu e perdeu a resposta = `Unknown`).
    match engine {
        Engine::Claude => {
            let session = claude::session_with_fast_mode(app, db, thread_id, fast_mode).await.map_err(SendError::NotSent)?;
            let (blocks, _skipped) = super::attach::image_blocks(images);
            return claude::send_user(app, db, &session, text, blocks).map_err(SendError::NotSent);
        }
        Engine::OpenCode => {
            let session = opencode::session(app, db, thread_id).await.map_err(SendError::NotSent)?;
            return opencode::send_user(app, db, &session, text).map_err(SendError::NotSent);
        }
        Engine::Antigravity => return agy::send(app, db, thread_id, text).map_err(SendError::NotSent),
        Engine::Cursor => return cursor::send(app, db, thread_id, text).map_err(SendError::NotSent),
        Engine::Codex => {}
    }
    let session = codex::session(app, db, thread_id).await.map_err(SendError::NotSent)?;
    let remote = session.remote().ok_or_else(|| SendError::NotSent("A conversa ainda não abriu no Codex".into()))?;
    let input = json!([{ "type": "text", "text": text, "text_elements": [] }]);
    if let Some(turn) = session.turn() {
        if !admits(mode, true) {
            return Err(SendError::Busy);
        }
        let steered = session.request_typed("turn/steer", json!({ "threadId": remote, "input": input, "expectedTurnId": turn })).await;
        match steered {
            Ok(_) => return Ok(()),
            // O turno acabou entre a checagem e o pedido: a mensagem abre um turno novo, em vez de se perder.
            Err(RequestFailure::Rejected(_)) if steer_falls_back_to_start(&turn, session.turn().as_deref()) => {}
            Err(failure) => return Err(codex_error(failure)),
        }
    }
    let row = {
        let conn = db.lock().map_err(|e| SendError::NotSent(db_err(e)))?;
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
        store::thread(&conn, thread_id).map_err(|e| SendError::NotSent(db_err(e)))?.ok_or_else(|| SendError::NotSent("Conversa não encontrada".into()))?
    };
    let (approval, _) = codex_map::access_policy(&row.access);
    let mut params = json!({ "threadId": remote, "input": input, "approvalPolicy": approval });
    if let Some(model) = &row.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &row.effort {
        params["effort"] = json!(effort);
    }
    apply_codex_fast_mode(&mut params, fast_mode);
    session.begin_start();
    let started = match session.request_typed("turn/start", params).await {
        Ok(started) => started,
        Err(failure) => {
            session.end_start(None);
            return Err(codex_error(failure));
        }
    };
    // O turno conta como aberto já na resposta (o aviso `turn/started` pode chegar depois): quem
    // perguntar o estado logo em seguida (`ags chat wait`) não o vê parado.
    // Se o turno já acabou (o aviso chegou antes desta resposta), não reabre.
    // O Parar que veio antes da resposta fica amarrado a este turno (ver `codex_parar`).
    let turn = started.pointer("/turn/id").and_then(Value::as_str);
    let finished = turn.is_some_and(|turn| {
        db.lock().ok().and_then(|conn| store::run_status(&conn, thread_id, turn).ok().flatten()).is_some_and(|s| s != "inProgress")
    });
    if let Some(turn) = turn.filter(|_| !finished) {
        if session.turn().is_none() {
            session.set_turn(Some(turn.to_string()));
        }
        session.end_start(Some(turn));
    } else {
        session.end_start(None);
    }
    Ok(())
}

/// Define o nível Fast no pedido de um turno, compartilhando a decisão com o adapter da Frota.
///
/// No app-server, o `serviceTier` do `turn/start` vale para este turno e os seguintes. Por isso desligar
/// manda `null`, que limpa o nível da conversa: só tirar a chave deixaria o Fast ligado. Sem preferência
/// (envio interno), a chave fica de fora e o turno herda o nível da conversa.
pub(super) fn apply_codex_fast_mode(params: &mut Value, fast_mode: Option<bool>) {
    match fast_mode {
        Some(fast) => params["serviceTier"] = crate::runs::codex_fast_service_tier(fast).map_or(Value::Null, |tier| json!(tier)),
        None => {
            if let Some(object) = params.as_object_mut() {
                object.remove("serviceTier");
            }
        }
    }
}

pub fn items(db: &DbConnection, thread_id: &str) -> Result<Vec<Item>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::items(&conn, thread_id).map_err(db_err)
}

/// Busca prefixos de palavras nas falas locais. A entrada vira termos FTS entre aspas para não
/// permitir que operadores digitados alterem a consulta.
pub fn search_messages(db: &DbConnection, query: &str, limit: usize) -> Result<Vec<MessageSearchHit>, String> {
    let query: String = query.trim().chars().take(160).collect();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let fts = query.split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| format!("\"{}\"*", term.replace('\"', "\"\"")))
        .collect::<Vec<_>>().join(" AND ");
    if fts.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.lock().map_err(db_err)?;
    store::search_messages(&conn, &fts, &query, limit).map_err(db_err)
}

pub fn requests(db: &DbConnection, thread_id: &str) -> Result<Vec<RequestRow>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::pending_requests(&conn, thread_id).map_err(db_err)
}

/// Esquece o contexto do provedor sem apagar o histórico local da ADE. A próxima mensagem abre uma sessão nova.
pub async fn clear_context(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
) -> Result<(), String> {
    let gate = send_gate(thread_id);
    let _held = gate.lock().await;
    if status(thread_id).working {
        return Err("Espere o turno terminar antes de limpar o contexto".into());
    }

    let mut conn = db.lock().map_err(db_err)?;
    store::thread(&conn, thread_id)
        .map_err(db_err)?
        .ok_or_else(|| format!("Conversa {thread_id} não encontrada"))?;
    if !store::pending_requests(&conn, thread_id)
        .map_err(db_err)?
        .is_empty()
    {
        return Err("Resolva os pedidos pendentes antes de limpar o contexto".into());
    }

    // ID remoto e objetivo descrevem o estado da sessão do provedor. Atualize-os juntos; a timeline ADE é preservada.
    let tx = conn.transaction().map_err(db_err)?;
    store::clear_remote_id(&tx, thread_id).map_err(db_err)?;
    store::clear_goal(&tx, thread_id).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    drop(conn);

    close(thread_id);
    super::events::emit(app, thread_id, "goal", json!({ "goal": null }));
    super::turn::save_notice(app, db, thread_id, "contextCleared", "");
    Ok(())
}

/// O objetivo local da conversa. Os eventos nativos do Codex mantêm status e conclusão sincronizados.
pub fn thread_goal(db: &DbConnection, thread_id: &str) -> Result<Option<store::ThreadGoal>, String> {
    let conn = db.lock().map_err(db_err)?;
    store::goal(&conn, thread_id).map_err(db_err)
}

/// Compacta o histórico no motor, sem enviar `/compact` como texto comum ao Codex.
pub async fn compact_context(app: &AppHandle, db: &DbConnection, thread_id: &str, instructions: Option<&str>) -> Result<(), String> {
    compact_context_inner(app, db, thread_id, instructions, false).await
}

pub(super) async fn compact_context_inner(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    instructions: Option<&str>,
    automatic: bool,
) -> Result<(), String> {
    // A compactação automática já está registrada como «em curso» (a fila espera): só um turno aberto a impede.
    if if automatic { turn_open(thread_id) } else { status(thread_id).working } {
        return Err("Espere o turno terminar antes de compactar o contexto".into());
    }
    {
        let conn = db.lock().map_err(db_err)?;
        if !store::pending_requests(&conn, thread_id).map_err(db_err)?.is_empty() {
            return Err("Resolva os pedidos pendentes antes de compactar o contexto".into());
        }
    }
    let instructions = instructions.map(str::trim).filter(|text| !text.is_empty());
    if instructions.is_some_and(|text| text.chars().count() > 10_000) {
        return Err("As instruções de compactação podem ter no máximo 10.000 caracteres".into());
    }
    let row = thread(db, thread_id)?;
    let engine = engine_of(&row)?;
    if let Some(error) = unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Compact) {
        return Err(error);
    }
    if !engine.capabilities().context_compaction {
        return Err("A compactação pelo ADE está disponível nas conversas Codex e Claude Code".into());
    }
    match engine {
        Engine::Codex => {
            if instructions.is_some() {
                return Err("O app-server do Codex não aceita instruções personalizadas para compactar".into());
            }
            // A compactação automática decide e pede sob a trava de envio: um envio que chegou no meio não abre turno junto.
            let gate = send_gate(thread_id);
            let _held = if automatic { Some(gate.lock().await) } else { None };
            if automatic && turn_open(thread_id) {
                return Err("Um turno começou antes da compactação automática".into());
            }
            let session = codex::session(app, db, thread_id).await?;
            let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
            session.request("thread/compact/start", json!({ "threadId": remote })).await?;
            Ok(())
        }
        Engine::Claude => {
            let slash = match super::autocompact::command_for(&row.agent_id) {
                Some(super::autocompact::Command::Slash(slash)) => slash,
                _ => "/compact",
            };
            let command = instructions.map_or_else(|| slash.to_string(), |text| format!("{slash} {text}"));
            if automatic {
                let gate = send_gate(thread_id);
                let _held = gate.lock().await;
                if turn_open(thread_id) {
                    return Err("Um turno começou antes da compactação automática".into());
                }
                {
                    let conn = db.lock().map_err(db_err)?;
                    if !store::pending_requests(&conn, thread_id).map_err(db_err)?.is_empty() {
                        return Err("Há uma aprovação pendente antes da compactação automática".into());
                    }
                }
                let session = claude::session(app, db, thread_id).await?;
                return claude::send_auto_compact(app, db, &session);
            }
            send_mode(app, db, thread_id, &command, SendMode::SteerActive, &[]).await.map_err(String::from)
        }
        _ => Err(unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Compact)
            .unwrap_or_else(|| format!("O adapter {engine:?} não implementa compactação apesar da matriz"))),
    }
}

/// Compacta uma conversa Claude quando ela volta à tela, somente se a pessoa habilitou o modo no
/// perfil, o último contexto passou do limite e não há turno nem aprovação pendente.
pub async fn auto_compact_on_return(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<bool, String> {
    const MODES_SETTING: &str = "chat.claude_idle_compaction_modes";
    const DEFAULT_THRESHOLD: u64 = 200_000;

    // O mesmo gate dos envios evita duas montagens React/StrictMode decidirem compactar juntas.
    let gate = send_gate(thread_id);
    let held = gate.lock().await;
    let row = thread(db, thread_id)?;
    let engine = engine_of(&row)?;
    if !engine.capabilities().automatic_compaction || row.state != "active" {
        return Ok(false);
    }
    let account = row.account_id.as_deref().unwrap_or("system:claude-code");
    let modes = crate::database::get_setting(db, MODES_SETTING)?.and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok()).unwrap_or_default();
    if modes.get(account).map(String::as_str) != Some("onReturn") || status(thread_id).working {
        return Ok(false);
    }

    let threshold = claude::auto_compact_window(db, &row).map(u64::from).unwrap_or(DEFAULT_THRESHOLD);
    let mut usage_item = {
        let conn = db.lock().map_err(db_err)?;
        if !store::pending_requests(&conn, thread_id).map_err(db_err)?.is_empty() {
            return Ok(false);
        }
        let tail = store::tail_items(&conn, thread_id, 128).map_err(db_err)?;
        let Some(item) = tail.into_iter().rev().find(|item| item.kind == ItemKind::Usage) else {
            return Ok(false);
        };
        if item.auto_compact_attempted == Some(true) || item.context_tokens.is_none_or(|tokens| tokens < threshold) {
            return Ok(false);
        }
        item
    };

    // A tentativa fica junto ao item de uso, na tabela de timeline já existente (sem schema novo).
    usage_item.auto_compact_attempted = Some(true);
    {
        let conn = db.lock().map_err(db_err)?;
        store::upsert_item(&conn, thread_id, None, &usage_item).map_err(db_err)?;
    }
    super::events::emit(app, thread_id, "item", json!({ "item": usage_item }));
    drop(held);

    match compact_context_inner(app, db, thread_id, None, true).await {
        Ok(()) => {
            super::turn::save_notice(
                app,
                db,
                thread_id,
                "autoCompact",
                "O contexto passou do limite configurado para este perfil Claude Code.",
            );
            Ok(true)
        }
        Err(error) => {
            // Se o turno começou na janela entre a checagem e o envio, deixe a próxima abertura tentar novamente.
            usage_item.auto_compact_attempted = None;
            if let Ok(conn) = db.lock() {
                let _ = store::upsert_item(&conn, thread_id, None, &usage_item);
            }
            super::events::emit(app, thread_id, "item", json!({ "item": usage_item }));
            Err(error)
        }
    }
}

/// Executa `/goal` na conversa. Codex usa a API persistente do app-server; Claude Code recebe seu
/// comando nativo e o ADE mantém um espelho local para mostrar o objetivo entre turnos.
pub async fn thread_goal_action(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    action: &str,
    objective: Option<&str>,
) -> Result<Option<store::ThreadGoal>, String> {
    let row = thread(db, thread_id)?;
    let engine = engine_of(&row)?;
    if let Some(error) = unsupported_capability_error(
        &row.agent_id,
        crate::harness::capability::Capability::Goal,
    ) {
        return Err(error);
    }
    let capabilities = engine.capabilities();
    if !capabilities.persistent_goal {
        return Err("Objetivos persistentes estão disponíveis nas conversas Codex e Claude Code".into());
    }
    let saved = thread_goal(db, thread_id)?;
    if action == "show" {
        return Ok(saved);
    }
    if action == "pause" || action == "resume" {
        if !capabilities.goal_pause_resume {
            return Err("Pausar e retomar objetivos está disponível no Codex; no Claude Code, use /goal clear para remover".into());
        }
        let current = saved.ok_or("Não há objetivo definido nesta conversa")?;
        if action == "pause" {
            if status(thread_id).working {
                stop(app, db, thread_id).await?;
            }
            let session = codex::session(app, db, thread_id).await?;
            let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
            session.request("thread/goal/set", json!({ "threadId": remote, "status": "paused" })).await?;
            let conn = db.lock().map_err(db_err)?;
            let goal = store::set_goal_status(&conn, thread_id, "paused", crate::util::now_ts_ms()).map_err(db_err)?;
            return Ok(goal);
        }
        if status(thread_id).working {
            return Err("Espere o turno terminar antes de retomar o objetivo".into());
        }
        return start_codex_goal(app, db, thread_id, &current.objective, false).await;
    }
    if action == "clear" {
        if status(thread_id).working {
            return Err("Espere o turno terminar antes de limpar o objetivo".into());
        }
        match engine {
            Engine::Codex => {
                let session = codex::session(app, db, thread_id).await?;
                let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
                session.request("thread/goal/clear", json!({ "threadId": remote })).await?;
            }
            Engine::Claude => {
                send_mode(app, db, thread_id, "/goal clear", SendMode::SteerActive, &[]).await.map_err(String::from)?;
            }
            _ => return Err(unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Goal)
                .unwrap_or_else(|| "O adapter atual não implementa limpeza de objetivo".into())),
        }
        let conn = db.lock().map_err(db_err)?;
        store::clear_goal(&conn, thread_id).map_err(db_err)?;
        return Ok(None);
    }
    if action != "set" {
        return Err("Ação de objetivo desconhecida".into());
    }
    let objective = objective.unwrap_or_default().trim();
    if objective.is_empty() || objective.chars().count() > 10_000 {
        return Err("Informe um objetivo entre 1 e 10.000 caracteres".into());
    }
    if status(thread_id).working {
        return Err("Espere o turno terminar antes de definir outro objetivo".into());
    }
    match engine {
        Engine::Codex => start_codex_goal(app, db, thread_id, objective, true).await,
        Engine::Claude => {
            let previous = thread_goal(db, thread_id)?;
            {
                let conn = db.lock().map_err(db_err)?;
                store::set_goal(&conn, thread_id, objective, "active", crate::util::now_ts_ms()).map_err(db_err)?;
            }
            if let Err(error) = send_mode(app, db, thread_id, &format!("/goal {objective}"), SendMode::SteerActive, &[]).await {
                let conn = db.lock().map_err(db_err)?;
                match previous {
                    Some(previous) => {
                        store::set_goal(&conn, thread_id, &previous.objective, &previous.status, crate::util::now_ts_ms()).map_err(db_err)?;
                    }
                    None => { store::clear_goal(&conn, thread_id).map_err(db_err)?; }
                }
                return Err(String::from(error));
            }
            thread_goal(db, thread_id)
        }
        _ => Err(unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Goal)
            .unwrap_or_else(|| "O adapter atual não implementa objetivos persistentes".into())),
    }
}

async fn start_codex_goal(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    objective: &str,
    replace: bool,
) -> Result<Option<store::ThreadGoal>, String> {
    let session = codex::session(app, db, thread_id).await?;
    let remote = session.remote().ok_or("A conversa ainda não abriu no Codex")?;
    if replace {
        let _ = session.request("thread/goal/clear", json!({ "threadId": remote })).await;
    }
    session.request("thread/goal/set", json!({ "threadId": remote, "objective": objective, "status": "paused" })).await?;
    {
        let conn = db.lock().map_err(db_err)?;
        store::set_goal(&conn, thread_id, objective, "paused", crate::util::now_ts_ms()).map_err(db_err)?;
    }
    let prompt = if replace { format!("Start working toward this goal: {objective}") } else { format!("Continue working toward this goal: {objective}") };
    if let Err(error) = send_mode(app, db, thread_id, &prompt, SendMode::SteerActive, &[]).await {
        let _ = session.request("thread/goal/set", json!({ "threadId": remote, "status": "paused" })).await;
        return Err(String::from(error));
    }
    let response = session.request("thread/goal/set", json!({ "threadId": remote, "status": "active" })).await?;
    let status = response.pointer("/goal/status").and_then(Value::as_str).unwrap_or("active");
    let conn = db.lock().map_err(db_err)?;
    store::set_goal(&conn, thread_id, objective, status, crate::util::now_ts_ms()).map(Some).map_err(db_err)
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    /// O processo do agente está aberto.
    pub alive: bool,
    /// Há um turno em andamento.
    pub working: bool,
}

/// Há turno aberto no motor (sem contar a compactação de contexto, que também deixa a conversa ocupada em `status`).
pub(super) fn turn_open(thread_id: &str) -> bool {
    live_turn(thread_id).is_some_and(|turn| turn.is_some())
}

pub fn status(thread_id: &str) -> ThreadStatus {
    match live_turn(thread_id) {
        // Compactando o contexto também é estar ocupado: `ags chat wait` e a fila entre agentes esperam.
        Some(turn) => ThreadStatus { alive: true, working: turn.is_some() || super::autocompact::is_compacting(thread_id) },
        None => ThreadStatus { alive: false, working: false },
    }
}

/// O Parar da pessoa: para o turno do agente vivo; sem agente vivo, fecha o turno que ficou aberto no banco (um
/// agente que morreu sem fechar o turno deixaria a tela em «Pensando…» e a fila presa para sempre).
pub async fn stop(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<(), String> {
    stop_now(app, db, thread_id).await.map(|_| ())
}

/// O Parar com `client_request_id` (Fase 2, contrato §11.11): repetir o mesmo id devolve o recibo e não manda outra
/// interrupção; o mesmo id com outra conversa falha fechado. `scope` é quem chamou (`ui`, `cli`, aba ou conversa do
/// MCP). Sem id, use [`stop`].
pub async fn stop_with_request(
    app: &AppHandle,
    db: &DbConnection,
    thread_id: &str,
    scope: &str,
    request_id: &str,
) -> Result<super::stop_receipt::StopReceipt, String> {
    let identity = super::stop_receipt::identity(scope, request_id, thread_id)?;
    // A conversa precisa existir antes de o recibo ser gravado (como no envio).
    thread(db, thread_id)?;
    let owner = format!("stop:{}", uuid::Uuid::new_v4());
    super::stop_receipt::run(db, &identity, thread_id, &owner, &crate::util::now_ts_ms, || stop_now(app, db, thread_id)).await
}

/// O corpo do Parar: manda a interrupção se há turno. Sem turno, fecha no banco o que ficou aberto e avisa a tela.
/// Devolve o que aconteceu (`Sent`, `Pending` ou `NoTurn`).
async fn stop_now(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<Interrupted, String> {
    let row = thread(db, thread_id)?;
    // Parar a conversa também cancela a retomada agendada depois do limite de uso.
    super::limite::cancel_resume(db, thread_id);
    // A matriz só barra a interrupção de um turno vivo: fechar no banco um turno órfão não depende do motor.
    if live_turn(thread_id).is_some() {
        if let Some(error) = unsupported_capability_error(&row.agent_id, crate::harness::capability::Capability::Interrupt) {
            return Err(error);
        }
    }
    let interrupted = interrupt_if_live(thread_id).await?;
    if interrupted != Interrupted::NoTurn {
        return Ok(interrupted);
    }
    // Sem turno nenhum (Codex vivo, mas parado e sem `turn/start` a caminho) também fecha o que ficou aberto no banco.
    let now = crate::util::now_ts_ms();
    let ends = {
        let conn = db.lock().map_err(db_err)?;
        close_idle_orphans(&conn, thread_id, now)?
    };
    let Some(ends) = ends else {
        // Um turno começou entre a decisão e o fechamento: o Parar é registrado nele, e nada do banco foi fechado.
        return interrupt_if_live(thread_id).await;
    };
    // O fim gravado vai à janela como está no banco (só o turno da ponta da timeline o ganha).
    for end in ends {
        super::events::emit(app, thread_id, "item", json!({ "item": end }));
    }
    super::events::emit(app, thread_id, "phase", json!({ "phase": "idle" }));
    Ok(Interrupted::NoTurn)
}

/// O Parar quando há um agente vivo; sem agente, não há turno para parar.
async fn interrupt_if_live(thread_id: &str) -> Result<Interrupted, String> {
    if live_turn(thread_id).is_some() { interrupt(thread_id).await } else { Ok(Interrupted::NoTurn) }
}

/// Há um turno rodando ou abrindo nesta conversa. O Codex abre com `starting` antes de ter o id do turno.
fn turn_busy(thread_id: &str) -> bool {
    live_turn(thread_id).is_some_and(|turn| turn.is_some()) || codex::get(thread_id).is_some_and(|session| session.opening())
}

/// Fecha no banco os turnos órfãos da conversa e devolve os fins gravados, para a tela. `None` quando há turno rodando
/// ou abrindo agora: nada é fechado. A checagem e o fechamento correm sob o lock do banco. Um envio que abre um turno
/// marca o guarda antes de gravar a linha dele (`Session::ensure_turn`), e não pode ser fechado pelo Parar que chegou
/// um instante antes.
pub(super) fn close_idle_orphans(conn: &rusqlite::Connection, thread_id: &str, now: i64) -> Result<Option<Vec<Item>>, String> {
    if turn_busy(thread_id) {
        return Ok(None);
    }
    let closed = store::close_orphan_runs(conn, Some(thread_id), now, STOPPED_ORPHAN).map_err(db_err)?;
    let ids: Vec<String> = closed.iter().map(|(_, run)| format!("end:{run}")).collect();
    if ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let items = store::items(conn, thread_id).map_err(db_err)?;
    Ok(Some(items.into_iter().filter(|i| ids.contains(&i.id)).collect()))
}

/// O que o Parar fez, conforme o guarda do motor (`codex_parar`).
fn interrupted_of(action: codex::StopAction) -> Interrupted {
    match action {
        codex::StopAction::Send(_) => Interrupted::Sent,
        codex::StopAction::Deferred => Interrupted::Pending,
        codex::StopAction::NoTurn => Interrupted::NoTurn,
    }
}

/// Quem pode parar a conversa `target` (contrato §3.3 regra 9). Sem `caller_scope` é a pessoa, e para qualquer
/// conversa. Com ele, é um agente que chamou pelo MCP, e o escopo vem da sessão, nunca do modelo: esse agente só
/// para a conversa filha que a própria conversa (`thread:<id>`) ou a própria aba (`tab:<id>`) criou. Tarefa da
/// Frota e pasta, sem conversa de origem, não param conversa nenhuma.
pub fn check_stop_scope(conn: &rusqlite::Connection, caller_scope: Option<&str>, target: &str) -> Result<(), String> {
    const FORA_DO_ESCOPO: &str = "só a conversa que criou esta filha, ou a pessoa, pode pará-la";
    let Some(scope) = caller_scope else {
        return Ok(());
    };
    let Some(tab) = scope.strip_prefix("tab:") else {
        return Err(FORA_DO_ESCOPO.into());
    };
    // A mesma regra de `chat.new`: a conversa que origina é `thread:<id>`, e a aba de TUI é `tab:<id>`.
    let expected = if tab.starts_with("thread:") { tab.to_string() } else { format!("tab:{tab}") };
    let row = store::thread(conn, target)
        .map_err(db_err)?
        .ok_or_else(|| format!("não há nenhuma conversa {target}"))?;
    if row.parent_ref.as_deref() == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(FORA_DO_ESCOPO.into())
    }
}

/// O fim do turno que o Parar fechou sem agente vivo.
pub const STOPPED_ORPHAN: &str = "O turno foi parado: o agente já não estava rodando.";

/// O que o Parar fez.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupted {
    /// Mandou a parada ao agente.
    Sent,
    /// O turno ainda não mostrou que roda: a parada sai no primeiro aviso dele (Codex: `turn/started`; Claude e OpenCode:
    /// o primeiro aviso do turno), ver `codex_parar`.
    Pending,
    /// Não havia turno para parar.
    NoTurn,
}

/// Para o turno em andamento. O motor decide com o guarda do Parar (`codex_parar`): o que chega antes de o turno mostrar
/// que roda fica pendente e sai depois; o que chega com o turno rodando sai na hora.
pub async fn interrupt(thread_id: &str) -> Result<Interrupted, String> {
    if let Some(session) = claude::get(thread_id) {
        return claude::interrupt(&session).await.map(interrupted_of);
    }
    if let Some(session) = opencode::get(thread_id) {
        return opencode::interrupt(&session).await.map(interrupted_of);
    }
    if agy::get(thread_id).is_some() {
        agy::interrupt(thread_id);
        return Ok(Interrupted::Sent);
    }
    if cursor::get(thread_id).is_some() {
        cursor::interrupt(thread_id);
        return Ok(Interrupted::Sent);
    }
    let Some(session) = codex::get(thread_id) else { return Ok(Interrupted::NoTurn) };
    session.stop().await.map(interrupted_of)
}

/// O motivo de não parar uma tarefa só: o motor não tem como (só o Claude Code tem `stop_task`).
pub const NO_TASK_STOP: &str = "Este agente não para uma tarefa só; o Parar do composer para o turno inteiro.";

pub(super) fn supports_task_stop(provider: &str) -> bool {
    crate::harness::matrix::supports(
        provider,
        crate::harness::capability::Surface::Chat,
        crate::harness::capability::Capability::ChildStop,
    ) == Some(crate::harness::capability::Support::Supported)
}

/// Para UMA tarefa em segundo plano da conversa (um shell ou um subagente), sem mexer no turno nem nas
/// outras: o `control_request` `stop_task` do Claude Code. O fim chega pelo evento `task`
/// (`task_notification` com `stopped`). Nos outros motores, recusa com o motivo.
pub async fn stop_task(db: &DbConnection, thread_id: &str, task_id: &str) -> Result<(), String> {
    let session = claude_task_session(db, thread_id, task_id)?;
    session.control("stop_task", json!({ "task_id": task_id })).await.map(|_| ())
}

/// A saída de um shell em segundo plano: cauda do arquivo temporário do Claude Code, ou o controle
/// `get_task_output` quando não há raiz de arquivos disponível. Só leitura, sem turno de modelo.
pub async fn task_output(db: &DbConnection, thread_id: &str, task_id: &str) -> Result<Value, String> {
    let session = claude_task_session(db, thread_id, task_id)?;
    if let Some(output) = session.task_output(task_id) {
        return Ok(output);
    }
    session.control("get_task_output", json!({ "task_id": task_id })).await
}

/// A sessão viva do Claude que tem a tarefa; o motivo, se não há como falar com ela.
fn claude_task_session(db: &DbConnection, thread_id: &str, task_id: &str) -> Result<Arc<claude::Session>, String> {
    if task_id.trim().is_empty() {
        return Err("Tarefa inválida".into());
    }
    if !supports_task_stop(&thread(db, thread_id)?.agent_id) {
        return Err(NO_TASK_STOP.into());
    }
    claude::get(thread_id).ok_or_else(|| TASK_PROCESS_CLOSED.to_string())
}

/// O processo do Claude fechou: as tarefas dele já pararam junto.
pub const TASK_PROCESS_CLOSED: &str = "O processo do Claude desta conversa já fechou; as tarefas dele pararam junto.";

/// Responde a um pedido do agente: `allow`, `allowSession` ou `deny` numa aprovação; o texto da
/// resposta numa pergunta. `false` se o pedido já não estava pendente.
pub fn answer(app: &AppHandle, db: &DbConnection, request_id: &str, choice: &str) -> Result<bool, String> {
    answer_as(app, db, request_id, choice, "person", None)
}

/// Como `answer`, dizendo quem responde (`person`, `policy`, `rule:<id>`) e por quê: fica gravado e vai no aviso
/// `requestResolved`. A resposta da pessoa é a de sempre; as do backend vêm de `conversa::permission`.
pub fn answer_as(app: &AppHandle, db: &DbConnection, request_id: &str, choice: &str, by: &str, why: Option<&str>) -> Result<bool, String> {
    let thread_id = {
        let conn = db.lock().map_err(db_err)?;
        store::request(&conn, request_id).map_err(db_err)?.ok_or("Pedido não encontrado")?.thread_id
    };
    // A resposta ao agente só sai depois de o banco RESERVAR o pedido (ver `answer`): quem perde a corrida não envia nada.
    let sender = |row: &store::RequestRow, choice: &str| send_answer(app, db, row, choice);
    let answered = super::answer::answer_core(db, request_id, choice, by, why, &sender)?;
    if answered {
        super::events::emit(app, &thread_id, "requestResolved", json!({ "id": request_id, "by": by, "why": why }));
    }
    Ok(answered)
}

/// Fala com o agente do motor da conversa. Só é chamada com o pedido já reservado.
fn send_answer(app: &AppHandle, db: &DbConnection, row: &store::RequestRow, choice: &str) -> Result<(), String> {
    let rpc_id: Value = serde_json::from_str(&row.rpc_id).map_err(db_err)?;
    if let Some(session) = claude::get(&row.thread_id) {
        claude::answer(app, db, &session, &rpc_id, row.item_id.as_deref(), choice)
    } else if let Some(session) = opencode::get(&row.thread_id) {
        opencode::answer(&session, &rpc_id, row.item_id.as_deref(), &row.options, choice)
    } else {
        let session = codex::get(&row.thread_id).ok_or("O agente desta conversa já fechou")?;
        session.respond(rpc_id, codex_map::answer_of(&row.kind, choice, &row.options))
    }
}

/// Troca modelo, esforço ou acesso (no Claude, o Plano também é um acesso).
/// - Codex: modelo e esforço valem no próximo turno; o acesso muda o sandbox, que é da sessão: com
///   o agente parado, a sessão fecha e reabre (retomando a thread) na próxima mensagem.
/// - OpenCode: o acesso vira política de permissões no ambiente do processo, e modelo e esforço
///   são opções da sessão: qualquer troca fecha a sessão (no fim do turno) e a próxima mensagem a
///   retoma (`session/resume`).
/// - Antigravity: a sessão persistente lê o ajuste salvo antes de abrir o próximo turno; se mudou,
///   encerra e reabre o processo com a configuração nova.
/// - Claude: tudo é flag do processo, então qualquer troca fecha a sessão (no fim do turno, se há
///   um) e a próxima mensagem a retoma (`--resume`) com as flags novas.
pub fn retune(db: &DbConnection, thread_id: &str, model: Option<String>, effort: Option<String>, access: String) -> Result<ThreadRow, String> {
    let conn = db.lock().map_err(db_err)?;
    let before = store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    let engine = engine_of(&before)?;
    if crate::local_acp::is_local_acp_id(&before.agent_id) && access != "ask" {
        return Err("Agentes ACP locais aceitam somente Supervisionado".into());
    }
    if !engine.accepts(&access) {
        return Err(access_error(engine, &access));
    }
    let working = live_turn(thread_id).is_some_and(|turn| turn.is_some());
    if working && before.access != access {
        return Err("Para trocar o acesso, espere o agente terminar o turno.".into());
    }
    let changed = before.model != model || before.effort != effort || before.access != access;
    store::set_tuning(&conn, thread_id, &Tuning { model, effort, access: access.clone() }, crate::util::now_ts_ms()).map_err(db_err)?;
    let row = store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    drop(conn);
    match engine {
        Engine::Codex if before.access != access => codex::close(thread_id),
        Engine::Claude if changed => {
            if let Some(session) = claude::get(thread_id) {
                session.retire();
            }
        }
        // O OpenCode lê as permissões do ambiente e o resto na abertura: qualquer troca reabre.
        Engine::OpenCode if changed => {
            if let Some(session) = opencode::get(thread_id) {
                session.retire();
            }
        }
        // O Antigravity confere a configuração antes de iniciar o próximo turno.
        _ => {}
    }
    Ok(row)
}

pub fn rename(db: &DbConnection, thread_id: &str, title: &str) -> Result<(), String> {
    {
        let conn = db.lock().map_err(db_err)?;
        store::set_title(&conn, thread_id, title.trim()).map_err(db_err)?;
    }
    // O título agora é da pessoa: o gerador por modelo não o sobrescreve.
    super::titulo::mark_manual(db, thread_id);
    Ok(())
}

/// Conclui (fecha o processo do agente; dá para reabrir: a próxima mensagem retoma a thread) ou reabre.
pub fn settle(db: &DbConnection, thread_id: &str, settled: bool) -> Result<(), String> {
    {
        let conn = db.lock().map_err(db_err)?;
        let row = store::thread(&conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
        store::set_state(&conn, thread_id, if settled { "settled" } else { "active" }, crate::util::now_ts_ms()).map_err(db_err)?;
        if let Err(error) = crate::skills::reconcile_link_dir(&conn, &row.cwd, &row.agent_id) {
            eprintln!("[skills] não consegui atualizar as skills da conversa {}: {error}", row.id);
        }
    }
    if settled {
        // Concluída, a conversa não é mais retomada sozinha depois do limite.
        super::limite::cancel_resume(db, thread_id);
        close(thread_id);
    }
    Ok(())
}
