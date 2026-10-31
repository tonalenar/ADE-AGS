//! Retomar a sessão de uma conversa por protocolo sem esquecer em silêncio.
//!
//! Antes, qualquer erro de `--resume`/`thread/resume`/`session/resume` (inclusive um prazo de 60 s) abria uma
//! sessão nova e sobrescrevia o id da anterior: o agente "esquecia" a conversa e a pessoa não era avisada.
//! Aqui o erro vira uma de quatro classes ([`ResumeFailure`]) e cada uma tem o seu destino ([`open_resuming`]):
//!
//! | Classe | O que é | Destino |
//! |---|---|---|
//! | `Gone` | a sessão não existe mais (apagada, outra conta) | abre uma nova, e AVISA na timeline |
//! | `Transient` | o processo caiu ou deu erro sem dizer por quê | tenta de novo 2 vezes, com pausa curta; se persistir, abre nova e avisa |
//! | `Timeout` | o agente não respondeu a tempo | NÃO abre nova: a sessão pode existir; falha e a pessoa tenta de novo |
//! | `Fatal` | nem o processo subiu, ou a sessão abriu mas as opções não valeram | falha; abrir outra não resolveria |
//!
//! O id da sessão anterior só é trocado depois de a nova abrir (quem chama grava o id depois daqui).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Por que a retomada falhou. A mensagem é a do motor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResumeFailure {
    Gone(String),
    Transient(String),
    Timeout(String),
    Fatal(String),
}

impl ResumeFailure {
    pub fn into_message(self) -> String {
        match self {
            ResumeFailure::Gone(m) | ResumeFailure::Transient(m) | ResumeFailure::Timeout(m) | ResumeFailure::Fatal(m) => m,
        }
    }
}

/// As pausas entre as tentativas de um erro transitório (uma retentativa por pausa).
pub const RETRY_PAUSES: [Duration; 2] = [Duration::from_millis(300), Duration::from_millis(1200)];

/// Pura: o erro de um motor (texto) como classe. Vale para os textos que `claude.rs`, `codex.rs` e `opencode.rs`
/// devolvem: erros de abrir o processo são `Fatal`; "não respondeu" é prazo; a resposta do agente dizendo que
/// a sessão não existe é `Gone`; o resto (processo que fechou, erro sem explicação) é `Transient`.
pub fn classify(error: &str) -> ResumeFailure {
    let lower = error.to_lowercase();
    let message = error.to_string();
    if ["não achei", "não consegui abrir", "sem stdin", "sem stdout"].iter().any(|p| lower.starts_with(p)) {
        ResumeFailure::Fatal(message)
    } else if lower.contains("não respondeu") {
        ResumeFailure::Timeout(message)
    } else if ["no conversation found", "session not found", "thread not found", "not found", "does not exist", "não encontrad", "no such session"]
        .iter()
        .any(|p| lower.contains(p))
    {
        ResumeFailure::Gone(message)
    } else {
        ResumeFailure::Transient(message)
    }
}

/// Como a conversa foi aberta.
#[derive(Debug, PartialEq, Eq)]
pub struct Opened<T> {
    pub session: T,
    /// A sessão anterior não pôde ser retomada e esta é nova: o motivo, para o aviso na timeline.
    pub lost: Option<String>,
}

/// Abre a conversa: retoma a sessão e, só se ela sumiu (ou o erro transitório persistiu), abre outra. `resume`
/// e `fresh` abrem uma sessão inteira (processo incluído) a cada chamada; `pause` espera entre as tentativas
/// (nos testes é um registro, sem relógio).
pub async fn open_resuming<T, R, RF, N, NF, P, PF>(mut resume: R, mut fresh: N, mut pause: P) -> Result<Opened<T>, String>
where
    R: FnMut() -> RF,
    RF: Future<Output = Result<T, ResumeFailure>>,
    N: FnMut() -> NF,
    NF: Future<Output = Result<T, String>>,
    P: FnMut(Duration) -> PF,
    PF: Future<Output = ()>,
{
    let mut attempt = 0;
    loop {
        let failure = match resume().await {
            Ok(session) => return Ok(Opened { session, lost: None }),
            Err(failure) => failure,
        };
        match failure {
            ResumeFailure::Gone(reason) => return open_fresh(&mut fresh, reason).await,
            ResumeFailure::Fatal(reason) => return Err(reason),
            ResumeFailure::Timeout(reason) => {
                return Err(format!("A retomada da sessão anterior demorou demais ({reason}). Ela foi mantida: tente de novo."));
            }
            ResumeFailure::Transient(reason) => match RETRY_PAUSES.get(attempt) {
                Some(wait) => {
                    pause(*wait).await;
                    attempt += 1;
                }
                None => return open_fresh(&mut fresh, reason).await,
            },
        }
    }
}

async fn open_fresh<T, N, NF>(fresh: &mut N, reason: String) -> Result<Opened<T>, String>
where
    N: FnMut() -> NF,
    NF: Future<Output = Result<T, String>>,
{
    Ok(Opened { session: fresh().await?, lost: Some(reason) })
}

/// A trava de abertura de UMA conversa. Era uma global por motor: um agente lento no `initialize` ou no resume
/// (até 60 s por pedido) segurava o início de todas as outras conversas do mesmo motor.
pub fn start_gate(engine: &'static str, thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    type Gates = Mutex<HashMap<(&'static str, String), Arc<tokio::sync::Mutex<()>>>>;
    static GATES: OnceLock<Gates> = OnceLock::new();
    let mut map = GATES.get_or_init(Gates::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry((engine, thread_id.to_string())).or_default().clone()
}

/// A frase do aviso na timeline quando a sessão anterior não pôde ser retomada.
pub fn lost_notice(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele.".to_string()
    } else {
        format!("A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele. Motivo: {}", crate::canal::event::clip(reason, 300))
    }
}
