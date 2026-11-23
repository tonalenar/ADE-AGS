//! Servidor HTTP (hyper 1) para o MCP remoto (`POST /mcp`).
//!
//! Nunca escuta em `0.0.0.0` nem `::`. Toda requisição precisa de `Authorization: Bearer`,
//! respeita o teto de 8 MB e o limite de 20 req/s por cliente, e registra auditoria sem argumentos.
//! Tem teto de conexões, prazos de leitura e limite por IP antes da autenticação; desligar fecha as conexões abertas.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

use super::clients::{ClientStore, RemoteClient};

/// Teto do corpo de uma requisição MCP HTTP (mesmo teto de 8 MB do stdio).
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Limite de taxa por cliente (requisições por segundo).
pub const RATE_LIMIT_PER_SEC: usize = 20;

const RATE_WINDOW: Duration = Duration::from_secs(1);

/// Conexões simultâneas aceitas por listener; as de além do teto são fechadas na hora.
pub const MAX_CONNECTIONS: usize = 64;
/// Prazo para o cliente mandar os cabeçalhos de uma requisição (inclui a espera numa conexão keep-alive parada).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Prazo para o corpo chegar inteiro depois dos cabeçalhos.
pub const BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Requisições por segundo por IP de origem, contadas **antes** da autenticação (token errado também gasta).
pub const PRE_AUTH_LIMIT_PER_SEC: usize = 100;
/// Depois de desligar, uma requisição em curso tem este tempo para terminar antes de a conexão ser cortada.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Limites do listener (ajustáveis nos testes).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_connections: usize,
    pub header_read_timeout: Duration,
    pub body_read_timeout: Duration,
    pub pre_auth_per_sec: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: MAX_CONNECTIONS,
            header_read_timeout: HEADER_READ_TIMEOUT,
            body_read_timeout: BODY_READ_TIMEOUT,
            pre_auth_per_sec: PRE_AUTH_LIMIT_PER_SEC,
        }
    }
}

/// Registro de auditoria de uma chamada remota (sem argumentos).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub client: String,
    pub tool: String,
    pub timestamp: i64,
}

/// Callback de despacho de um quadro JSON-RPC já autenticado.
pub type FrameHandler =
    Arc<dyn Fn(&RemoteClient, Value) -> Option<Value> + Send + Sync + 'static>;

/// Callback de auditoria (por padrão grava no log do app sem argumentos).
pub type AuditSink = Arc<dyn Fn(AuditEntry) + Send + Sync + 'static>;

/// Configuração de um listener HTTP do servidor MCP remoto.
#[derive(Clone)]
pub struct ServerConfig {
    pub store: ClientStore,
    pub handler: FrameHandler,
    pub audit: AuditSink,
    pub now_fn: Arc<dyn Fn() -> i64 + Send + Sync + 'static>,
    pub limits: Limits,
}

/// Instância ativa do servidor HTTP em um ou mais endereços locais/Tailscale.
pub struct RunningServer {
    addrs: Vec<SocketAddr>,
    shutdown: watch::Sender<bool>,
}

impl RunningServer {
    pub fn addrs(&self) -> &[SocketAddr] {
        &self.addrs
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

pub fn default_audit_sink() -> AuditSink {
    Arc::new(|entry| {
        let line = format!(
            "[remote-mcp] client={} tool={} ts={}",
            entry.client, entry.tool, entry.timestamp
        );
        eprintln!("{line}");
        #[cfg(not(test))]
        let _ = crate::util::datadir::anexar_log("remote-mcp.log", &line);
    })
}

struct RateLimiter {
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            hits: Mutex::new(HashMap::new()),
        }
    }

    fn allow(&self, client_id: &str, limit: usize) -> bool {
        let now = Instant::now();
        let mut map = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let window = map.entry(client_id.to_string()).or_default();
        while window
            .front()
            .is_some_and(|ts| now.duration_since(*ts) >= RATE_WINDOW)
        {
            window.pop_front();
        }
        if window.len() >= limit {
            return false;
        }
        window.push_back(now);
        true
    }
}

struct ServerState {
    config: ServerConfig,
    limiter: RateLimiter,
    /// Limite por IP de origem, antes de qualquer leitura do keyring.
    pre_auth: RateLimiter,
}

/// Sobe o servidor MCP HTTP em cada endereço informado (recusa `0.0.0.0` e `::`).
pub async fn start_on(
    addrs: &[SocketAddr],
    config: ServerConfig,
) -> Result<RunningServer, String> {
    if addrs.is_empty() {
        return Err("Nenhum endereço configurado para o servidor MCP remoto".into());
    }
    for addr in addrs {
        if addr.ip().is_unspecified() {
            return Err(format!(
                "Endereço recusado ({addr}): o servidor MCP remoto nunca escuta em todas as interfaces"
            ));
        }
    }

    let mut listeners = Vec::with_capacity(addrs.len());
    let mut bound = Vec::with_capacity(addrs.len());
    for addr in addrs {
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("Não foi possível escutar em {addr}: {e}"))?;
        let local = listener
            .local_addr()
            .map_err(|e| format!("Não foi possível ler o endereço de {addr}: {e}"))?;
        bound.push(local);
        listeners.push(listener);
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let state = Arc::new(ServerState {
        config,
        limiter: RateLimiter::new(),
        pre_auth: RateLimiter::new(),
    });
    let permits = Arc::new(Semaphore::new(state.config.limits.max_connections));

    for listener in listeners {
        let state = state.clone();
        let permits = permits.clone();
        let mut rx = shutdown_rx.clone();
        let conn_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = rx.changed() => {
                        if changed.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { continue };
                        // Sem vaga, a conexão é fechada na hora (o `drop` do stream).
                        let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                        let state = state.clone();
                        let shutdown = conn_rx.clone();
                        tokio::spawn(async move {
                            serve_connection(stream, peer, state, shutdown).await;
                            drop(permit);
                        });
                    }
                }
            }
        });
    }

    Ok(RunningServer {
        addrs: bound,
        shutdown: shutdown_tx,
    })
}

/// Serve uma conexão até ela fechar ou o servidor ser desligado. Desligar fecha também as keep-alive já abertas:
/// uma requisição em curso termina (até `SHUTDOWN_GRACE`) e a conexão é encerrada.
async fn serve_connection(stream: TcpStream, peer: SocketAddr, state: Arc<ServerState>, mut shutdown: watch::Receiver<bool>) {
    let limits = state.config.limits;
    let io = TokioIo::new(stream);
    let ip = peer.ip();
    let service = service_fn(move |req| {
        let state = state.clone();
        async move { Ok::<_, Infallible>(handle_request(req, state, ip).await) }
    });
    let conn = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(limits.header_read_timeout)
        .serve_connection(io, service);
    tokio::pin!(conn);
    tokio::select! {
        _ = &mut conn => {}
        _ = async { let _ = shutdown.wait_for(|stopped| *stopped).await.map(|_| ()); } => {
            conn.as_mut().graceful_shutdown();
            let _ = tokio::time::timeout(SHUTDOWN_GRACE, &mut conn).await;
        }
    }
}

async fn handle_request(req: Request<Incoming>, state: Arc<ServerState>, ip: IpAddr) -> Response<Full<Bytes>> {
    // Antes de tudo (e do keyring): um IP que passa do limite não gasta mais nada do servidor.
    if !state.pre_auth.allow(&ip.to_string(), state.config.limits.pre_auth_per_sec) {
        return json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "Limite de taxa excedido para este endereço" }),
        );
    }
    if req.uri().path() != "/mcp" {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "Rota não encontrada" }));
    }
    if *req.method() != Method::POST {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Método não permitido; use POST /mcp" }),
        );
    }

    let Some(token) = bearer_token(&req) else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Token Bearer ausente ou inválido" }),
        );
    };

    let now = (state.config.now_fn)();
    let store = state.config.store.clone();
    let token_owned = token.to_string();
    let client = match tokio::task::spawn_blocking(move || store.authenticate_at(&token_owned, now))
        .await
        .ok()
        .flatten()
    {
        Some(client) => client,
        None => {
            return json_response(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "Token inválido, revogado ou expirado" }),
            );
        }
    };

    if !state.limiter.allow(&client.id, RATE_LIMIT_PER_SEC) {
        return json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "Limite de taxa excedido (máximo 20 req/s por cliente)" }),
        );
    }

    if let Some(len) = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<usize>().ok())
        && len > MAX_BODY_BYTES
    {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({ "error": "Corpo excede o limite de 8 MB" }),
        );
    }

    let body_timeout = state.config.limits.body_read_timeout;
    let body = match tokio::time::timeout(body_timeout, read_limited_body(req.into_body(), MAX_BODY_BYTES)).await {
        Err(_) => {
            return json_response(
                StatusCode::REQUEST_TIMEOUT,
                json!({ "error": "O corpo da requisição não chegou a tempo" }),
            );
        }
        Ok(Ok(bytes)) => bytes,
        Ok(Err(BodyError::TooLarge)) => {
            return json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": "Corpo excede o limite de 8 MB" }),
            );
        }
        Ok(Err(BodyError::Read)) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Falha ao ler o corpo da requisição" }),
            );
        }
    };

    let frame: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": "JSON inválido" }
                }),
            );
        }
    };

    let audited_tool = audit_tool_name(&frame);
    (state.config.audit)(AuditEntry {
        client: client.id.clone(),
        tool: audited_tool,
        timestamp: (state.config.now_fn)(),
    });

    let handler = state.config.handler.clone();
    let result = tokio::task::spawn_blocking(move || handler(&client, frame)).await;
    match result {
        Ok(Some(response)) => json_response(StatusCode::OK, response),
        Ok(None) => Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Full::new(Bytes::new()))
            .expect("resposta HTTP válida"),
        Err(_) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32603, "message": "Erro interno ao despachar chamada MCP" }
            }),
        ),
    }
}

fn bearer_token(req: &Request<Incoming>) -> Option<&str> {
    let raw = req.headers().get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

fn audit_tool_name(frame: &Value) -> String {
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "tools/call" {
        frame
            .pointer("/params/name")
            .and_then(Value::as_str)
            .unwrap_or("tools/call")
            .to_string()
    } else if method.is_empty() {
        "unknown".to_string()
    } else {
        method.to_string()
    }
}

enum BodyError {
    TooLarge,
    Read,
}

async fn read_limited_body(mut body: Incoming, max_bytes: usize) -> Result<Vec<u8>, BodyError> {
    let mut out = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| BodyError::Read)?;
        if let Some(chunk) = frame.data_ref() {
            if out.len().saturating_add(chunk.len()) > max_bytes {
                return Err(BodyError::TooLarge);
            }
            out.extend_from_slice(chunk);
        }
    }
    Ok(out)
}

fn json_response(status: StatusCode, payload: Value) -> Response<Full<Bytes>> {
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Full::new(Bytes::from(bytes)))
        .expect("resposta JSON válida")
}
