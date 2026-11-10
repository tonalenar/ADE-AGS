//! Delegação única (Fase 4, contrato §12): os três destinos de `delegate_agent` e o caminho
//! `connected_session`.
//!
//! O que mora aqui é o que não depende do app aberto, para ser provado com um banco em memória:
//! a escolha do destino, a revalidação da sessão no instante do envio, o recibo idempotente e a
//! classificação do que o `peer` respondeu. A cola com o app (descobrir as sessões, falar com o
//! `peer`) fica em `ipc/commands/delegate.rs`.

use serde_json::Value;

use super::receipts::{CommandIdentity, CommandReceipt, ReceiptState};
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
        todo!()
    }

    pub fn parse(_raw: &str) -> Option<Target> {
        todo!()
    }

    /// O tipo do recibo que guarda a idempotência do destino.
    pub fn receipt_kind(self) -> &'static str {
        todo!()
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
        todo!()
    }
}

/// Escolhe o destino. `target` é o campo novo; `execution` (`chat` ou `fleet`) continua valendo
/// como apelido do que já existia. Os dois juntos têm de concordar.
pub fn resolve_target(_target: Option<&str>, _execution: Option<&str>) -> Result<Target, DelegateError> {
    todo!()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Pty,
    Conversation,
    GeminiDesktop,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        todo!()
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
pub fn parse_ceiling(_raw: Option<&str>) -> Result<Policy, DelegateError> {
    todo!()
}

/// Acha a sessão pelo id ou pelo nome (sem distinguir maiúsculas). Nome repetido é erro: mandar o
/// trabalho à sessão errada é pior que pedir o id.
pub fn resolve_session<'a>(_to: &str, _sessions: &'a [SessionFacts]) -> Result<&'a SessionFacts, DelegateError> {
    todo!()
}

/// Tudo o que precisa valer no instante do envio. A primeira falha vence e nada foi escrito.
pub fn check_session(_caller: &CallerFacts, _session: &SessionFacts, _opts: &Options) -> Result<(), DelegateError> {
    todo!()
}

/// A entrada da descoberta (`team_candidates`): o que a sessão é, onde está, se pode receber
/// trabalho agora e se a pessoa precisa aprovar o vínculo.
pub fn describe_session(_caller: &CallerFacts, _session: &SessionFacts) -> Value {
    todo!()
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
    pub fn from_args(_args: &Value) -> Result<SessionRequest, DelegateError> {
        todo!()
    }

    pub fn options(&self) -> Options {
        Options { ceiling: self.ceiling, when_busy: self.when_busy }
    }

    /// A chave e o hash do pedido. O hash cobre o destino, o alvo e o conteúdo; não cobre o próprio
    /// `client_request_id` nem o prazo de espera.
    pub fn identity(&self, _caller_key: &str) -> CommandIdentity {
        todo!()
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
pub fn classify_peer_reply(_reply: &Value) -> SendResult {
    todo!()
}

/// Executa uma delegação a uma sessão com recibo.
///
/// 1. Um recibo `accepted`, `submitting` ou `unknown` volta como está: nada é revalidado nem enviado.
/// 2. `resolve` revalida a sessão (sem lock do banco) e devolve o alvo. Se falhar, nada foi escrito.
/// 3. O recibo é gravado e reclamado numa transação; `send` roda sem o lock; o resultado fecha o recibo.
pub fn dispatch<R, S>(
    _db: &DbConnection,
    _identity: &CommandIdentity,
    _now: &dyn Fn() -> i64,
    _resolve: R,
    _send: S,
) -> Result<Value, DelegateError>
where
    R: FnOnce() -> Result<String, DelegateError>,
    S: FnOnce(&str) -> SendResult,
{
    todo!()
}

/// O que um recibo de qualquer destino guarda: o id da conversa, do run ou da mensagem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replay {
    pub target: Target,
    pub state: ReceiptState,
    pub id: String,
    pub receipt: CommandReceipt,
}

/// Lê o recibo do destino (a tabela nova e, na falta dela, a antiga). `None` = pedido novo. O mesmo
/// id com outro conteúdo é `request_conflict`.
pub fn lookup_replay(
    _conn: &rusqlite::Connection,
    _target: Target,
    _caller_key: &str,
    _request_id: &str,
    _request_hash: &str,
) -> Result<Option<Replay>, DelegateError> {
    todo!()
}
