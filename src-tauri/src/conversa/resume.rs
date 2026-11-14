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

/// A nota honesta que o PRÓXIMO envio leva ao agente quando o turno anterior caiu com ferramenta sem resultado
/// (aviso `toolOutcomeUnknown` gravado por `turn::record_end`): ele pode ter rodado um `git push`, uma migração
/// ou um envio, e repeti-lo às cegas faria de novo. Vale só enquanto não houve mensagem da pessoa depois do
/// aviso. Pura: recebe os itens da conversa (do mais velho ao mais novo).
pub fn unknown_outcome_note(items: &[crate::canal::timeline::Item]) -> Option<String> {
    use crate::canal::timeline::ItemKind;
    for item in items.iter().rev() {
        match item.kind {
            ItemKind::User => return None,
            ItemKind::Notice if item.label.as_deref() == Some("toolOutcomeUnknown") => {
                return item.text.as_deref().filter(|t| !t.trim().is_empty()).map(|t| format!("[Aviso do ADE AGS, não da pessoa] {t}"));
            }
            _ => {}
        }
    }
    None
}

/// Pura: a mensagem que vai ao agente, com a nota (se houver) antes do texto da pessoa.
pub fn with_note(note: Option<&str>, text: &str) -> String {
    match note {
        Some(note) => format!("{note}\n\n{text}"),
        None => text.to_string(),
    }
}

/// O que o processo de um turno viu enquanto rodava: quem o executa preenche, `run_turn_resuming` lê.
#[derive(Debug, Default, Clone)]
pub struct Observed {
    pub began: bool,
    pub stderr: Vec<String>,
}

/// O que o processo de UM turno deixa para decidir se a sessão foi recusada antes de o turno começar.
#[derive(Debug, Clone)]
pub struct TurnAttempt<T> {
    /// O desfecho do turno: o que `drive` devolve (`Err` = não subiu ou caiu com erro).
    pub result: Result<T, String>,
    /// Chegou alguma linha do stdout do turno (o `init`/`system` com o id da sessão, item, texto, o que for). Com
    /// isso o processo aceitou a sessão e o prompt já saiu: nada de repetir.
    pub began: bool,
    /// As linhas finais do stderr do processo (a prova que o classificador do motor lê).
    pub stderr: Vec<String>,
}

/// Motores que precisam validar `--resume`/`--conversation` junto ao primeiro prompt (Cursor e o boot do Antigravity):
/// **não** se usa [`open_resuming`] (feito para abrir a sessão antes de qualquer mensagem sair). Repetir o turno só é
/// seguro com PROVA de que o processo recusou a sessão antes de o turno começar:
/// 1. havia id remoto (`remote`) e o turno acabou em erro (`Err`);
/// 2. nenhuma linha do stdout chegou (`began == false`): nem `init`, nem item, nem texto;
/// 3. o classificador do motor (`refused`) reconhece, no stderr, a frase de sessão ou conversa inexistente.
///
/// Só nesse caso: `forget` limpa o id remoto (memória e banco), `notice("resumeLost", …)` grava o aviso e o turno
/// roda UMA vez, sem retomada (`run(None)`). Qualquer outro desfecho (erro depois de eventos, erro sem a frase,
/// parada, sucesso) é devolvido como está, com o id mantido: o prompt já saiu e repeti-lo duplicaria ações.
pub async fn run_turn_resuming<T, R, RF>(remote: Option<&str>, refused: impl Fn(&[String]) -> bool, mut run: R, mut forget: impl FnMut(), mut notice: impl FnMut(&str, &str)) -> Result<T, String>
where
    R: FnMut(Option<&str>) -> RF,
    RF: Future<Output = TurnAttempt<T>>,
{
    let first = run(remote).await;
    let reason = match &first.result {
        Err(message) if remote.is_some() && !first.began && refused(&first.stderr) => message.clone(),
        _ => return first.result,
    };
    forget();
    notice("resumeLost", &lost_notice(&reason));
    run(None).await.result
}

/// Pura: a linha de erro de um CLI diz que a sessão (conversa, chat) não existe? Casa só frases que citam o próprio
/// `subjects` do motor, coladas a um marcador de inexistência («chat not found», «no conversation found», «invalid
/// session»…). Um «file not found» ou «model not found» de outra coisa não casa. `_` vale como espaço
/// (`SESSION_NOT_FOUND`).
pub fn says_session_missing(line: &str, subjects: &[&str]) -> bool {
    let line = line.to_lowercase().replace('_', " ");
    subjects.iter().any(|s| {
        [
            format!("{s} not found"),
            format!("no {s} found"),
            format!("no such {s}"),
            format!("{s} does not exist"),
            format!("{s} doesn't exist"),
            format!("{s} not exist"),
            format!("invalid {s}"),
            format!("unknown {s}"),
            format!("could not find {s}"),
            format!("couldn't find {s}"),
            format!("cannot find {s}"),
            format!("unable to find {s}"),
            format!("{s} expired"),
        ]
        .iter()
        .any(|phrase| line.contains(phrase.as_str()))
    })
}
