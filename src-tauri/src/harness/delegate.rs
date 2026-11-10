//! Delegação única (Fase 4, contrato §12): os três destinos de `delegate_agent` e o caminho
//! `connected_session`.
//!
//! O que mora aqui é o que não depende do app aberto, para ser provado com um banco em memória:
//! a escolha do destino, a revalidação da sessão no instante do envio, o recibo idempotente e a
//! classificação do que o `peer` respondeu. A cola com o app (descobrir as sessões, falar com o
//! `peer`) fica em `ipc/commands/delegate.rs`.

use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::{json, Value};

use super::receipts::{self, Begin, CommandIdentity, CommandReceipt, ReceiptState};
use crate::chat_team::model::Policy;
use crate::database::DbConnection;

/// O recibo de uma delegação a uma sessão já conectada.
pub const KIND_CONNECTED_SESSION: &str = "connected_session";

/// Quanto tempo um envio `submitting` conta como em curso. Depois disso o desfecho é desconhecido:
/// o dono pode ter morrido antes ou depois de a mensagem sair, e o recibo nunca repete às cegas.
pub const SUBMIT_LEASE_MS: i64 = 120_000;

/// Os três destinos de uma delegação.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// Uma conversa nova de um provider nativo (`chat_new`).
    ProviderChat,
    /// Uma tarefa headless da Frota (`delegate_task`).
    FleetTask,
    /// Uma sessão que já está aberta e ligada ao time (`peer_tell` / `peer_ask`).
    ConnectedSession,
}

impl Target {
    pub fn as_str(self) -> &'static str {
        match self {
            Target::ProviderChat => "provider_chat",
            Target::FleetTask => "fleet_task",
            Target::ConnectedSession => "connected_session",
        }
    }

    pub fn parse(raw: &str) -> Option<Target> {
        [Target::ProviderChat, Target::FleetTask, Target::ConnectedSession]
            .into_iter()
            .find(|target| target.as_str() == raw.trim())
    }

    /// O tipo do recibo que guarda a idempotência do destino.
    pub fn receipt_kind(self) -> &'static str {
        match self {
            Target::ProviderChat => receipts::KIND_CHAT_NEW,
            Target::FleetTask => receipts::KIND_FLEET_DELEGATE,
            Target::ConnectedSession => KIND_CONNECTED_SESSION,
        }
    }
}

/// Códigos estáveis dos erros de delegação. Quem lê a mensagem pode decidir pelo código.
pub mod code {
    pub const INVALID_TARGET: &str = "invalid_target";
    pub const TARGET_CONFLICT: &str = "target_conflict";
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const NOT_ORCHESTRATOR: &str = "not_orchestrator";
    pub const SESSION_NOT_FOUND: &str = "session_not_found";
    pub const SESSION_AMBIGUOUS: &str = "session_ambiguous";
    pub const SESSION_DISCONNECTED: &str = "session_disconnected";
    pub const SESSION_BUSY: &str = "session_busy";
    pub const SESSION_INCOMPATIBLE: &str = "session_incompatible";
    pub const SESSION_NOT_LINKED: &str = "session_not_linked";
    pub const SESSION_OTHER_WORKSPACE: &str = "session_other_workspace";
    pub const POLICY_ELEVATED: &str = "policy_elevated";
    pub const POLICY_NOT_ALLOWED: &str = "policy_not_allowed";
    pub const REQUEST_CONFLICT: &str = "request_conflict";
    pub const NOT_SENT: &str = "not_sent";
    pub const OUTCOME_UNKNOWN: &str = "outcome_unknown";
    pub const RECEIPT_FAILED: &str = "receipt_failed";
    pub const CALLER_NOT_OPEN: &str = "caller_not_open";
    pub const SNAPSHOT_FAILED: &str = "snapshot_failed";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegateError {
    pub code: &'static str,
    pub message: String,
}

impl DelegateError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        DelegateError { code, message: message.into() }
    }

    /// O texto que volta ao agente: `<código>: <mensagem>`.
    pub fn render(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

/// Escolhe o destino. `target` é o campo novo; `execution` (`chat` ou `fleet`) continua valendo
/// como apelido do que já existia. Os dois juntos têm de concordar.
pub fn resolve_target(target: Option<&str>, execution: Option<&str>) -> Result<Target, DelegateError> {
    const LEGACY: &str = "execution precisa ser 'chat' ou 'fleet'";
    let legacy = match execution {
        Some("chat") => Some(Target::ProviderChat),
        Some("fleet") => Some(Target::FleetTask),
        Some(_) => None,
        None => None,
    };
    match (target, execution) {
        (Some(raw), _) => {
            let chosen = Target::parse(raw).ok_or_else(|| {
                DelegateError::new(
                    code::INVALID_TARGET,
                    "target precisa ser 'provider_chat', 'fleet_task' ou 'connected_session'",
                )
            })?;
            match (execution, legacy) {
                (None, _) => Ok(chosen),
                (Some(_), Some(old)) if old == chosen => Ok(chosen),
                (Some(_), _) => Err(DelegateError::new(
                    code::TARGET_CONFLICT,
                    format!("target '{}' não concorda com execution; informe só target (execution é o apelido antigo de provider_chat e fleet_task)", chosen.as_str()),
                )),
            }
        }
        (None, Some(_)) => legacy.ok_or_else(|| DelegateError::new(code::INVALID_TARGET, LEGACY)),
        (None, None) => Err(DelegateError::new(
            code::INVALID_TARGET,
            format!("{LEGACY}, ou informe target: 'provider_chat', 'fleet_task' ou 'connected_session'"),
        )),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Pty,
    Conversation,
    GeminiDesktop,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Pty => "pty",
            Transport::Conversation => "conversation",
            Transport::GeminiDesktop => "gemini_desktop",
        }
    }
}

/// O vínculo da sessão com o time: o que a pessoa (ou o orquestrador, no teto `ask`) gravou.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberFacts {
    pub policy: Policy,
    pub role: String,
    pub subagent: bool,
}

/// O que se sabe da sessão no instante da decisão. Sempre lido de novo, nunca de uma listagem antiga.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionFacts {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub agent_id: String,
    pub transport: Transport,
    pub cwd: String,
    /// A aba tem processo ou a conversa está aberta.
    pub connected: bool,
    pub working: bool,
    pub member: Option<MemberFacts>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallerFacts {
    pub id: String,
    pub cwd: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhenBusy {
    /// Falha sem escrever nada (padrão).
    Fail,
    /// A mensagem entra na fila da sessão e vai quando ela ficar livre.
    Queue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `peer_tell`: devolve o id da mensagem.
    Async,
    /// `peer_ask`: espera a resposta (dado não confiável).
    Wait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    /// A política mais alta que o integrante pode ter para receber o trabalho. Nunca passa de `ask`.
    pub ceiling: Policy,
    pub when_busy: WhenBusy,
}

/// O teto de política pedido na delegação. Ausente é `ask`; `edits` e `full` são da pessoa.
pub fn parse_ceiling(raw: Option<&str>) -> Result<Policy, DelegateError> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(Policy::Ask);
    };
    let policy = Policy::parse(raw).map_err(|error| DelegateError::new(code::INVALID_REQUEST, error))?;
    if policy > Policy::Ask {
        return Err(DelegateError::new(
            code::POLICY_NOT_ALLOWED,
            format!("o teto da delegação é 'read' ou 'ask': só a pessoa aumenta a permissão de um integrante (pedido: '{}')", policy.as_str()),
        ));
    }
    Ok(policy)
}

/// Acha a sessão pelo id ou pelo nome (sem distinguir maiúsculas). Nome repetido é erro: mandar o
/// trabalho à sessão errada é pior que pedir o id.
pub fn resolve_session<'a>(to: &str, sessions: &'a [SessionFacts]) -> Result<&'a SessionFacts, DelegateError> {
    if let Some(found) = sessions.iter().find(|session| session.id == to) {
        return Ok(found);
    }
    let needle = to.trim().to_lowercase();
    let matches: Vec<&SessionFacts> = sessions.iter().filter(|session| session.name.trim().to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(DelegateError::new(
            code::SESSION_NOT_FOUND,
            format!("'{to}' não é uma sessão que você possa receber trabalho: veja team_candidates (e team_link para ligar uma da sua pasta)"),
        )),
        many => Err(DelegateError::new(
            code::SESSION_AMBIGUOUS,
            format!(
                "há {} sessões chamadas '{to}'. Use o id: {}",
                many.len(),
                many.iter().map(|session| session.id.as_str()).collect::<Vec<_>>().join(", ")
            ),
        )),
    }
}

/// Tudo o que precisa valer no instante do envio. A primeira falha vence e nada foi escrito.
pub fn check_session(caller: &CallerFacts, session: &SessionFacts, opts: &Options) -> Result<(), DelegateError> {
    let name = &session.name;
    if session.id == caller.id {
        return Err(DelegateError::new(code::SESSION_INCOMPATIBLE, "você não pode delegar a si mesmo"));
    }
    if session.agent_id == "bash" {
        return Err(DelegateError::new(code::SESSION_INCOMPATIBLE, format!("{name} é um terminal comum, não um agente que receba trabalho")));
    }
    if !session.connected {
        return Err(DelegateError::new(
            code::SESSION_DISCONNECTED,
            format!("{name} não está conectada agora (aba fechada, sem processo ou conversa encerrada). Nada foi enviado"),
        ));
    }
    let Some(member) = &session.member else {
        return Err(if session.cwd != caller.cwd {
            DelegateError::new(
                code::SESSION_OTHER_WORKSPACE,
                format!("{name} está em outra pasta e não está ligada ao seu time: só a pessoa liga outra pasta, no painel Time"),
            )
        } else {
            DelegateError::new(code::SESSION_NOT_LINKED, format!("{name} é da sua pasta, mas ainda não está no time: ligue-a primeiro com team_link"))
        });
    };
    if member.policy > opts.ceiling {
        return Err(DelegateError::new(
            code::POLICY_ELEVATED,
            format!(
                "{name} tem a política '{}', acima do teto '{}' desta delegação. A ADE não delega a um vínculo elevado nem o eleva: a pessoa ajusta no painel Time",
                member.policy.as_str(),
                opts.ceiling.as_str()
            ),
        ));
    }
    if session.working && opts.when_busy == WhenBusy::Fail {
        return Err(DelegateError::new(
            code::SESSION_BUSY,
            format!("{name} está no meio de um turno. Nada foi enviado; use when_busy=queue para entrar na fila dela, ou espere"),
        ));
    }
    Ok(())
}

/// A entrada da descoberta (`team_candidates`): o que a sessão é, onde está, se pode receber
/// trabalho agora e se a pessoa precisa aprovar o vínculo.
pub fn describe_session(caller: &CallerFacts, session: &SessionFacts) -> Value {
    let strict = Options { ceiling: Policy::Ask, when_busy: WhenBusy::Fail };
    let queueing = Options { when_busy: WhenBusy::Queue, ..strict };
    let blocker = check_session(caller, session, &strict).err().map(|error| error.code);
    let can_receive = check_session(caller, session, &queueing).is_ok();
    let same_workspace = session.cwd == caller.cwd;
    let linked = session.member.is_some();
    let availability = if !session.connected {
        "disconnected"
    } else if session.working {
        "busy"
    } else {
        "available"
    };
    json!({
        "id": session.id,
        "name": session.name,
        "agent": session.agent,
        "agentId": session.agent_id,
        "transport": session.transport.as_str(),
        "cwd": session.cwd,
        "sameWorkspace": same_workspace,
        "working": session.working,
        "available": availability == "available",
        "availability": availability,
        "linked": linked,
        "canLink": !linked && same_workspace,
        "canMessage": linked,
        "canReceiveWork": can_receive,
        "blocker": blocker,
        // Só a pessoa liga outra pasta; o orquestrador liga a da mesma pasta com team_link.
        "requiresPersonApproval": !linked && !same_workspace,
        "role": session.member.as_ref().map(|member| member.role.clone()),
        "policy": session.member.as_ref().map(|member| member.policy.as_str()),
        "subagent": session.member.as_ref().map(|member| member.subagent),
    })
}

/// O pedido de delegação a uma sessão, já validado na forma.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRequest {
    pub to: String,
    pub task: String,
    pub constraints: Option<String>,
    pub expecting: Option<String>,
    pub context: Option<String>,
    pub mode: Mode,
    pub ceiling: Policy,
    pub when_busy: WhenBusy,
    pub request_id: String,
    pub timeout_s: u64,
    /// A tarefa com o contexto explícito marcado como dado não confiável.
    pub prompt: String,
}

impl SessionRequest {
    pub fn from_args(args: &Value) -> Result<SessionRequest, DelegateError> {
        let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let invalid = |message: &str| DelegateError::new(code::INVALID_REQUEST, message);
        let to = text("to").ok_or_else(|| invalid("to precisa nomear a sessão (id ou nome de team_candidates)"))?;
        let task = text("task").ok_or_else(|| invalid("task precisa conter as instruções para a sessão"))?;
        let raw_id = args
            .get("client_request_id")
            .or_else(|| args.get("clientRequestId"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("client_request_id é obrigatório para evitar delegação duplicada em uma repetição"))?;
        let request_id = receipts::validate_request_id(raw_id).map_err(|error| DelegateError::new(code::INVALID_REQUEST, error))?;
        let mode = match args.get("mode").and_then(Value::as_str).unwrap_or("async") {
            "async" => Mode::Async,
            "wait" => Mode::Wait,
            _ => return Err(invalid("mode precisa ser 'async' ou 'wait'")),
        };
        let ceiling = parse_ceiling(args.get("policy").and_then(Value::as_str))?;
        let when_busy = match args.get("when_busy").and_then(Value::as_str).unwrap_or("fail") {
            "fail" => WhenBusy::Fail,
            "queue" => WhenBusy::Queue,
            _ => return Err(invalid("when_busy precisa ser 'fail' ou 'queue'")),
        };
        let context = match args.get("context") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => return Err(invalid("context precisa ser texto")),
        };
        let prompt = crate::runs::delegated_prompt(task, context).map_err(|error| DelegateError::new(code::INVALID_REQUEST, error))?;
        let timeout_s = args.get("timeout_s").and_then(Value::as_u64).unwrap_or(300).clamp(10, 1800);
        Ok(SessionRequest {
            to: to.to_string(),
            task: task.to_string(),
            constraints: text("constraints").map(str::to_string),
            expecting: text("expecting").map(str::to_string),
            context: context.map(str::to_string),
            mode,
            ceiling,
            when_busy,
            request_id,
            timeout_s,
            prompt,
        })
    }

    pub fn options(&self) -> Options {
        Options { ceiling: self.ceiling, when_busy: self.when_busy }
    }

    /// A chave e o hash do pedido. O hash cobre o destino, o alvo e o conteúdo; não cobre o próprio
    /// `client_request_id` nem o prazo de espera.
    pub fn identity(&self, caller_key: &str) -> CommandIdentity {
        let canonical = json!({
            "target": Target::ConnectedSession.as_str(),
            "to": self.to,
            "task": self.task,
            "constraints": self.constraints,
            "expecting": self.expecting,
            "context": self.context,
            "mode": match self.mode { Mode::Async => "async", Mode::Wait => "wait" },
            "policy": self.ceiling.as_str(),
            "when_busy": match self.when_busy { WhenBusy::Fail => "fail", WhenBusy::Queue => "queue" },
        });
        CommandIdentity {
            kind: KIND_CONNECTED_SESSION.to_string(),
            caller_key: caller_key.to_string(),
            request_id: self.request_id.clone(),
            request_hash: receipts::payload_hash(&canonical),
        }
    }
}

/// O que o `peer` fez com a mensagem.
#[derive(Clone, Debug, PartialEq)]
pub enum SendResult {
    /// A mensagem entrou na sessão (ou na fila dela). `result` é o que o recibo guarda (ids, nunca
    /// texto de agente); `reply` é a resposta do `ask`, que nunca vai ao banco.
    Sent { result: Value, reply: Option<Value> },
    /// Nada chegou à sessão: o recibo fica `retryable`.
    NotSent(String),
    /// A mensagem pode ter chegado: o recibo vira `unknown` e nunca repete.
    Unknown(String),
}

/// Traduz a resposta do `peer tell`/`ask` no que o recibo precisa saber.
pub fn classify_peer_reply(reply: &Value) -> SendResult {
    let flag = |key: &str| reply.get(key).and_then(Value::as_bool).unwrap_or(false);
    let message = || {
        ["message", "note"]
            .iter()
            .find_map(|key| reply.get(*key).and_then(Value::as_str))
            .unwrap_or("a sessão não recebeu a mensagem")
            .to_string()
    };
    let sent = |reply_body: Option<Value>| SendResult::Sent {
        result: json!({ "messageId": reply.get("messageId").cloned().unwrap_or(Value::Null), "queued": flag("queued") }),
        reply: reply_body,
    };
    if !reply.is_object() {
        return SendResult::Unknown("a resposta do envio não foi entendida".into());
    }
    if flag("unconfirmed") {
        return SendResult::Unknown(
            reply.get("note").and_then(Value::as_str).unwrap_or("o texto foi escrito na sessão, mas ela não o confirmou").to_string(),
        );
    }
    if flag("duplicate") && flag("repeat") {
        return sent(None);
    }
    if flag("refused") || flag("cancelled") || flag("escalated") || flag("duplicate") {
        return SendResult::NotSent(message());
    }
    match reply.get("sent").and_then(Value::as_bool) {
        // A resposta do `ask` (com a fala do outro agente) é dado não confiável e só volta ao chamador.
        Some(true) => sent(if reply.get("reply").is_some() || reply.get("finished").is_some() { Some(reply.clone()) } else { None }),
        Some(false) => SendResult::NotSent(message()),
        None => SendResult::Unknown("a resposta do envio não disse se a mensagem saiu".into()),
    }
}

fn receipt_error(error: String) -> DelegateError {
    if error == receipts::MISMATCH {
        DelegateError::new(code::REQUEST_CONFLICT, error)
    } else {
        DelegateError::new(code::RECEIPT_FAILED, format!("não consegui gravar o recibo da delegação: {error}"))
    }
}

/// Uma transação `Immediate` curta: o lock do banco nunca fica preso durante I/O.
fn immediate<T>(db: &DbConnection, work: impl FnOnce(&Transaction) -> Result<T, String>) -> Result<T, DelegateError> {
    let conn = db.lock().map_err(|error| receipt_error(error.to_string()))?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).map_err(|error| receipt_error(error.to_string()))?;
    let value = work(&tx).map_err(receipt_error)?;
    tx.commit().map_err(|error| receipt_error(error.to_string()))?;
    Ok(value)
}

fn stored(receipt: &CommandReceipt) -> Option<serde_json::Map<String, Value>> {
    receipt.result_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()).and_then(|value| match value {
        Value::Object(map) => Some(map),
        _ => None,
    })
}

fn base_response(receipt_state: ReceiptState, replayed: bool, sent: bool, request_id: &str, to: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("target".into(), json!(Target::ConnectedSession.as_str()));
    map.insert("delegated".into(), json!(receipt_state == ReceiptState::Accepted));
    map.insert("sent".into(), json!(sent));
    map.insert("replayed".into(), json!(replayed));
    map.insert("requestId".into(), json!(request_id));
    map.insert("deliveryState".into(), json!(receipt_state.as_str()));
    map.insert("to".into(), json!(to));
    map
}

/// O que volta quando o recibo já existia: nada é enviado de novo.
fn replay_value(receipt: &CommandReceipt) -> Value {
    let mut map = base_response(receipt.state, true, false, &receipt.request_id, &receipt.target_ref);
    if let Some(result) = stored(receipt) {
        for (key, value) in result {
            map.entry(key).or_insert(value);
        }
    }
    let note = match receipt.state {
        ReceiptState::Accepted => "Pedido já aceito: a mensagem não foi enviada de novo. Veja a entrega com peer_receipt (messageId) ou leia a sessão.",
        ReceiptState::Unknown => "A mensagem pode ter chegado à sessão: confira a conversa ou a aba antes de pedir de novo. O envio não foi repetido.",
        _ => "O envio deste pedido está em curso: não reenviei. Repita depois para ler o resultado.",
    };
    map.insert("note".into(), json!(note));
    Value::Object(map)
}

/// O recibo que já existe: devolve o que repetir significa. `None` = pode (re)tentar. Um `submitting`
/// com o prazo vencido vira `unknown`: o dono pode ter enviado antes de morrer.
fn settle_existing(conn: &Connection, identity: &CommandIdentity, existing: CommandReceipt, now: i64) -> Result<Option<CommandReceipt>, String> {
    match existing.state {
        ReceiptState::Accepted | ReceiptState::Unknown => Ok(Some(existing)),
        ReceiptState::Submitting if now - existing.updated_at > SUBMIT_LEASE_MS => {
            receipts::transition(conn, &identity.kind, &identity.caller_key, &identity.request_id, &[ReceiptState::Submitting], ReceiptState::Unknown, now)?;
            receipts::lookup(conn, &identity.kind, &identity.caller_key, &identity.request_id)
        }
        ReceiptState::Submitting => Ok(Some(existing)),
        ReceiptState::Prepared | ReceiptState::Retryable => Ok(None),
    }
}

enum Claim {
    Mine,
    Replay(CommandReceipt),
}

/// Executa uma delegação a uma sessão com recibo.
///
/// 1. Um recibo `accepted`, `submitting` ou `unknown` volta como está: nada é revalidado nem enviado.
/// 2. `resolve` revalida a sessão (sem lock do banco) e devolve o alvo. Se falhar, nada foi escrito.
/// 3. O recibo é gravado e reclamado numa transação; `send` roda sem o lock; o resultado fecha o recibo.
pub fn dispatch<R, S>(
    db: &DbConnection,
    identity: &CommandIdentity,
    now: &dyn Fn() -> i64,
    resolve: R,
    send: S,
) -> Result<Value, DelegateError>
where
    R: FnOnce() -> Result<String, DelegateError>,
    S: FnOnce(&str) -> SendResult,
{
    let key = (identity.kind.as_str(), identity.caller_key.as_str(), identity.request_id.as_str());
    let earlier = immediate(db, |tx| {
        let Some(existing) = receipts::lookup(tx, key.0, key.1, key.2)? else { return Ok(None) };
        if existing.request_hash != identity.request_hash {
            return Err(receipts::MISMATCH.to_string());
        }
        settle_existing(tx, identity, existing, now())
    })?;
    if let Some(receipt) = earlier {
        return Ok(replay_value(&receipt));
    }

    // Revalida no instante do envio, sem o lock do banco. Falhou: nada foi escrito.
    let target = resolve()?;

    let claim = immediate(db, |tx| {
        let receipt = match receipts::begin(tx, identity, &target, now())? {
            Begin::Created(receipt) | Begin::Existing(receipt) => receipt,
        };
        if let Some(settled) = settle_existing(tx, identity, receipt, now())? {
            return Ok(Claim::Replay(settled));
        }
        let claimed = receipts::transition(
            tx, key.0, key.1, key.2, &[ReceiptState::Prepared, ReceiptState::Retryable], ReceiptState::Submitting, now(),
        )?;
        if claimed {
            return Ok(Claim::Mine);
        }
        // Outro chamador reclamou entre a leitura e a escrita: o que ele deixou é o que vale.
        let current = receipts::lookup(tx, key.0, key.1, key.2)?.ok_or_else(|| "o recibo sumiu".to_string())?;
        Ok(Claim::Replay(current))
    })?;
    if let Claim::Replay(receipt) = claim {
        return Ok(replay_value(&receipt));
    }

    let outcome = send(&target);

    let (state, result_json) = match &outcome {
        SendResult::Sent { result, .. } => (ReceiptState::Accepted, Some(result.to_string())),
        SendResult::NotSent(_) => (ReceiptState::Retryable, None),
        SendResult::Unknown(_) => (ReceiptState::Unknown, None),
    };
    immediate(db, |tx| {
        receipts::transition(tx, key.0, key.1, key.2, &[ReceiptState::Submitting], state, now())?;
        if let Some(result_json) = &result_json {
            receipts::set_result(tx, identity, result_json, now())?;
        }
        Ok(())
    })
    .map_err(|error| {
        DelegateError::new(
            code::RECEIPT_FAILED,
            format!("a mensagem pode ter sido enviada, mas o recibo não foi gravado ({}); confira a sessão antes de repetir", error.message),
        )
    })?;

    match outcome {
        SendResult::Sent { result, reply } => {
            let mut map = base_response(ReceiptState::Accepted, false, true, &identity.request_id, &target);
            if let Value::Object(fields) = result {
                for (key, value) in fields {
                    map.entry(key).or_insert(value);
                }
            }
            if let Some(reply) = reply {
                map.insert("untrustedReply".into(), reply);
            }
            Ok(Value::Object(map))
        }
        SendResult::NotSent(reason) => Err(DelegateError::new(
            code::NOT_SENT,
            format!("a mensagem não foi enviada: {reason}. Para tentar de novo, repita com o mesmo client_request_id"),
        )),
        SendResult::Unknown(reason) => Err(DelegateError::new(
            code::OUTCOME_UNKNOWN,
            format!("a mensagem pode ter chegado à sessão ({reason}): confira antes de pedir de novo. O mesmo client_request_id não a repete"),
        )),
    }
}

/// O que um recibo de qualquer destino guarda: o id da conversa, do run ou da sessão.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replay {
    pub target: Target,
    pub state: ReceiptState,
    /// provider_chat: o id da conversa; fleet_task: o id do run; connected_session: o id da sessão
    /// (o id da mensagem fica em `receipt.result_json`).
    pub id: String,
    pub receipt: CommandReceipt,
}

/// Lê o recibo do destino (a tabela nova e, na falta dela, a antiga). `None` = pedido novo. O mesmo
/// id com outro conteúdo é `request_conflict`.
pub fn lookup_replay(
    conn: &Connection,
    target: Target,
    caller_key: &str,
    request_id: &str,
    request_hash: &str,
) -> Result<Option<Replay>, DelegateError> {
    let Some(receipt) = receipts::lookup(conn, target.receipt_kind(), caller_key, request_id).map_err(receipt_error)? else {
        return Ok(None);
    };
    if receipt.request_hash != request_hash {
        return Err(receipt_error(receipts::MISMATCH.to_string()));
    }
    Ok(Some(Replay { target, state: receipt.state, id: receipt.target_ref.clone(), receipt }))
}
