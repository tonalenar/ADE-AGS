//! Entrada do servidor: vagas de conexão e leitura do pedido, com limites **antes** da autenticação (F-03).
//!
//! Sem isso, qualquer processo local sem token segurava uma vaga e até 8 MiB de memória por conexão, e o prazo era
//! por leitura (um byte a cada 29 s segurava a vaga quase para sempre). Aqui:
//!
//! - cada canal (TCP e credencial) tem as suas vagas, e só [`MAX_UNAUTHENTICATED`] delas podem estar sem token validado;
//! - o token precisa aparecer nos primeiros [`TOKEN_WINDOW`] bytes: só então o resto (até 8 MiB) é lido;
//! - o prazo é **total** por fase, medido por um relógio injetável (os testes não esperam tempo de verdade).

use std::io::BufRead;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Conexões abertas ao mesmo tempo, **por canal**. Folgado: cada agente com um `run_await` ou um permissão pendente ocupa uma.
pub(super) const MAX_CONNECTIONS: usize = 256;

/// Conexões ainda sem token validado, por canal. Um pedido legítimo sai desta fase em milissegundos.
pub(super) const MAX_UNAUTHENTICATED: usize = 32;

/// Tamanho máximo de um pedido (um handoff ou uma memória, que têm tetos próprios bem abaixo disto).
pub(super) const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

/// O token tem que estar nestes primeiros bytes da linha. A CLI serializa `token` primeiro.
pub(super) const TOKEN_WINDOW: usize = 1024;

/// Prazo total para a conexão mandar o começo do pedido e provar o token.
pub(super) const TOKEN_DEADLINE_MS: u64 = 5_000;

/// Prazo total para o resto do pedido, já autenticado.
pub(super) const REQUEST_DEADLINE_MS: u64 = 30_000;

/// Prazo de cada leitura no socket. Sem ele um cliente parado não devolve o controle para checar o prazo total.
pub(super) const READ_TIMEOUT_SECS: u64 = 5;

/// As vagas de um canal.
pub(super) struct Slots {
    open: AtomicUsize,
    unauthenticated: AtomicUsize,
    max_open: usize,
    max_unauthenticated: usize,
}

impl Slots {
    pub(super) fn new() -> Arc<Self> {
        Self::with_limits(MAX_CONNECTIONS, MAX_UNAUTHENTICATED)
    }

    pub(super) fn with_limits(max_open: usize, max_unauthenticated: usize) -> Arc<Self> {
        Arc::new(Slots { open: AtomicUsize::new(0), unauthenticated: AtomicUsize::new(0), max_open, max_unauthenticated })
    }

    /// Uma vaga nova, ainda sem autenticação. `None` se o canal está cheio ou já há demais esperando o token.
    pub(super) fn try_acquire(self: &Arc<Self>) -> Option<Slot> {
        if self.unauthenticated.fetch_add(1, Ordering::SeqCst) >= self.max_unauthenticated {
            self.unauthenticated.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        if self.open.fetch_add(1, Ordering::SeqCst) >= self.max_open {
            self.open.fetch_sub(1, Ordering::SeqCst);
            self.unauthenticated.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot { slots: self.clone(), unauthenticated: true })
    }
}

/// Uma vaga ocupada. Solta ao sair de escopo.
pub(super) struct Slot {
    slots: Arc<Slots>,
    unauthenticated: bool,
}

impl Slot {
    /// O token foi validado: a vaga deixa de contar como "sem autenticação".
    pub(super) fn authenticated(&mut self) {
        if std::mem::replace(&mut self.unauthenticated, false) {
            self.slots.unauthenticated.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.authenticated();
        self.slots.open.fetch_sub(1, Ordering::SeqCst);
    }
}

/// O que a leitura do pedido concluiu.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Intake {
    /// A linha do pedido, com o token já conferido.
    Line(String),
    /// Recusado antes do despacho: a mensagem vai na resposta.
    Refused(String),
    /// Nada a responder (linha vazia, fim da conexão, prazo ou erro de leitura).
    Closed,
}

const INVALID_TOKEN: &str = "Token inválido — leia de novo ~/.ags/ipc.json";

/// O valor do campo `"token"` dentro do começo da linha, sem parsear o JSON inteiro (que ainda nem chegou).
fn token_in(head: &[u8]) -> Option<&[u8]> {
    const KEY: &[u8] = b"\"token\"";
    let at = head.windows(KEY.len()).position(|w| w == KEY)? + KEY.len();
    let rest = &head[at..];
    fn after(rest: &[u8], byte: u8) -> Option<&[u8]> {
        let blanks = rest.iter().take_while(|b| b.is_ascii_whitespace()).count();
        (rest.get(blanks) == Some(&byte)).then(|| &rest[blanks + 1..])
    }
    let rest = after(rest, b':')?;
    let rest = after(rest, b'"')?;
    let end = rest.iter().position(|b| *b == b'"')?;
    Some(&rest[..end])
}

/// Lê a linha do pedido com limites antes da autenticação:
///
/// 1. até [`TOKEN_WINDOW`] bytes (ou o fim da linha), dentro de [`TOKEN_DEADLINE_MS`], e o token tem de estar lá e bater;
/// 2. só então o resto, até [`MAX_REQUEST_BYTES`] e [`REQUEST_DEADLINE_MS`] no total.
///
/// `now_ms` é o relógio (injetável, para os testes não esperarem). `on_authenticated` roda uma vez, quando o token bate.
pub(super) fn read_request(reader: &mut impl BufRead, expected_token: &str, now_ms: &mut dyn FnMut() -> u64, on_authenticated: &mut dyn FnMut()) -> Intake {
    let started = now_ms();
    let mut line: Vec<u8> = Vec::new();
    let mut authenticated = false;
    loop {
        let deadline = if authenticated { REQUEST_DEADLINE_MS } else { TOKEN_DEADLINE_MS };
        if now_ms().saturating_sub(started) > deadline {
            return Intake::Closed;
        }
        let available = match reader.fill_buf() {
            Ok(buf) => buf,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Intake::Closed,
        };
        if available.is_empty() {
            // Fim da conexão sem quebra de linha: vale o que veio (como o `read_line`), se o token já foi provado.
            if line.iter().all(u8::is_ascii_whitespace) {
                return Intake::Closed;
            }
            if !authenticated {
                match check_token(&line, expected_token) {
                    Some(refusal) => return refusal,
                    None => on_authenticated(),
                }
            }
            return finish(line);
        }
        // Antes do token, nunca puxa mais que a janela: o resto do que o cliente mandar nem é lido.
        let room = if authenticated { (MAX_REQUEST_BYTES as usize + 1).saturating_sub(line.len()) } else { TOKEN_WINDOW.saturating_sub(line.len()) };
        let chunk = &available[..available.len().min(room)];
        let newline = chunk.iter().position(|b| *b == b'\n');
        let take = newline.map_or(chunk.len(), |at| at + 1);
        line.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if !authenticated && newline.is_some() && line.iter().all(u8::is_ascii_whitespace) {
            return Intake::Closed;
        }
        if !authenticated && (newline.is_some() || line.len() >= TOKEN_WINDOW) {
            if let Some(refusal) = check_token(&line, expected_token) {
                return refusal;
            }
            authenticated = true;
            on_authenticated();
        }
        if newline.is_some() {
            return finish(line);
        }
        if line.len() as u64 > MAX_REQUEST_BYTES {
            return Intake::Refused(format!("Request demasiado grande (máximo {MAX_REQUEST_BYTES} bytes)"));
        }
    }
}

fn check_token(head: &[u8], expected_token: &str) -> Option<Intake> {
    let head = &head[..head.len().min(TOKEN_WINDOW)];
    match token_in(head) {
        Some(given) if super::server::token_matches(&String::from_utf8_lossy(given), expected_token) => None,
        _ => Some(Intake::Refused(INVALID_TOKEN.into())),
    }
}

fn finish(line: Vec<u8>) -> Intake {
    match String::from_utf8(line) {
        Ok(text) if text.trim().is_empty() => Intake::Closed,
        Ok(text) => Intake::Line(text),
        Err(_) => Intake::Refused("Requisição inválida: a linha não é UTF-8".into()),
    }
}
