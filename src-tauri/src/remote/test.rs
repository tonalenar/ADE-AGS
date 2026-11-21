//! Testes do módulo `remote` (Parte B1: servidor HTTP e tokens de cliente).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::clients::{ClientStore, Preset};
use super::http::{AuditEntry, MAX_BODY_BYTES, RATE_LIMIT_PER_SEC, ServerConfig, start_on};
use super::{DEFAULT_PORT, bind_addrs, bind_addrs_on};

fn isolated_store(name: &str) -> ClientStore {
    ClientStore::for_test(&format!("{name}-{}", uuid::Uuid::new_v4()))
}

fn test_config(
    store: ClientStore,
    audit_log: Arc<Mutex<Vec<AuditEntry>>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> ServerConfig {
    ServerConfig {
        store,
        handler: Arc::new(|client, req| {
            let id = req.get("id")?.clone();
            let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "client": client.id, "method": method }
            }))
        }),
        audit: Arc::new(move |entry| {
            audit_log.lock().unwrap().push(entry);
        }),
        now_fn: now,
    }
}

async fn spawn_test_server(
    store: ClientStore,
    audit_log: Arc<Mutex<Vec<AuditEntry>>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> (super::http::RunningServer, SocketAddr) {
    let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let server = start_on(&[loopback], test_config(store, audit_log, now))
        .await
        .expect("servidor HTTP de teste deve subir em 127.0.0.1:0");
    let addr = server.addrs()[0];
    (server, addr)
}

#[test]
fn nunca_escuta_em_todas_as_interfaces() {
    for addrs in [
        bind_addrs(None),
        bind_addrs(Some(Ipv4Addr::new(100, 64, 10, 20))),
        bind_addrs(Some(Ipv4Addr::UNSPECIFIED)),
        bind_addrs(Some(Ipv4Addr::new(192, 168, 1, 5))),
        bind_addrs_on(Some(Ipv4Addr::new(100, 100, 1, 2)), 48000),
    ] {
        assert!(!addrs.is_empty(), "sempre escuta em loopback");
        assert!(
            addrs.iter().any(|a| a.ip() == IpAddr::V4(Ipv4Addr::LOCALHOST)),
            "tem que incluir 127.0.0.1: {addrs:?}"
        );
        for addr in &addrs {
            assert!(!addr.ip().is_unspecified(), "nunca 0.0.0.0 nem ::: {addr}");
            assert!(addr.is_ipv4(), "somente IPv4 loopback/Tailscale: {addr}");
        }
    }

    let only_local = bind_addrs(None);
    assert_eq!(only_local, vec![SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))]);

    let with_ts = bind_addrs(Some(Ipv4Addr::new(100, 64, 10, 20)));
    assert_eq!(
        with_ts,
        vec![
            SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT)),
            SocketAddr::from((Ipv4Addr::new(100, 64, 10, 20), DEFAULT_PORT)),
        ]
    );

    // 0.0.0.0 nunca entra mesmo se passado diretamente.
    let bad = bind_addrs(Some(Ipv4Addr::UNSPECIFIED));
    assert_eq!(bad, vec![SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))]);
}

#[test]
fn token_nao_fica_guardado_em_claro() {
    let store = isolated_store("nao-claro");
    let (client, token) = store
        .pair("T3 Mac", Preset::Read, vec!["/repo".into()], "/repo", Some(30))
        .expect("pareamento deve funcionar");
    assert!(token.len() >= 40, "token de 32 bytes em base64url: {token}");
    let raw = store.raw_index_json().expect("índice gravado no keyring");
    assert!(!raw.contains(&token), "o token bruto não pode aparecer no índice");
    assert!(raw.contains(&client.id), "o índice guarda os metadados do cliente");

    // Autenticação encontra o cliente e atualiza last_seen_at.
    assert!(client.last_seen_at.is_none());
    let auth = store.authenticate(&token).expect("token válido autentica");
    assert_eq!(auth.id, client.id);
    assert!(auth.last_seen_at.is_some());
    assert!(store.list().iter().any(|c| c.id == client.id && c.last_seen_at.is_some()));
}

#[tokio::test]
async fn sem_token_401() {
    let store = isolated_store("sem-token");
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) = spawn_test_server(store, audit, Arc::new(crate::util::now_ts)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.shutdown();
}

#[tokio::test]
async fn token_errado_401() {
    let store = isolated_store("token-errado");
    let _ = store
        .pair("Celular", Preset::Browser, vec!["/repo".into()], "/repo", None)
        .unwrap();
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) = spawn_test_server(store, audit, Arc::new(crate::util::now_ts)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .bearer_auth("token-que-nao-existe")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.shutdown();
}

#[tokio::test]
async fn token_revogado_401() {
    let store = isolated_store("token-revogado");
    let (client, token) = store
        .pair("Revogar", Preset::Read, vec!["/repo".into()], "/repo", None)
        .unwrap();
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) =
        spawn_test_server(store.clone(), audit, Arc::new(crate::util::now_ts)).await;

    let ok_res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .bearer_auth(&token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_res.status(), reqwest::StatusCode::OK);

    assert!(store.revoke(&client.id).unwrap());

    let rev_res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .bearer_auth(&token)
        .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rev_res.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.shutdown();
}

#[tokio::test]
async fn token_expirado_401() {
    let store = isolated_store("token-expirado");
    let (client, token) = store
        .pair("Expirar", Preset::Read, vec!["/repo".into()], "/repo", Some(1))
        .unwrap();
    let expired_ts = client.expires_at.expect("ttl_days gera expires_at") + 1;
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) = spawn_test_server(store, audit, Arc::new(move || expired_ts)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .bearer_auth(&token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.shutdown();
}

#[tokio::test]
async fn outra_rota_404_e_auditoria_sem_argumentos() {
    let store = isolated_store("rota-e-auditoria");
    let (client, token) = store
        .pair("Auditoria", Preset::All, vec!["/repo".into()], "/repo", None)
        .unwrap();
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) =
        spawn_test_server(store, audit.clone(), Arc::new(crate::util::now_ts)).await;

    let http = reqwest::Client::new();
    let not_found = http
        .post(format!("http://{addr}/outro"))
        .bearer_auth(&token)
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(not_found.status(), reqwest::StatusCode::NOT_FOUND);

    let res = http
        .post(format!("http://{addr}/mcp"))
        .bearer_auth(&token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "browser_click",
                "arguments": { "secret_arg": "nao-logar-isto" }
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);

    let entries = audit.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].client, client.id);
    assert_eq!(entries[0].tool, "browser_click");
    assert!(!entries[0].tool.contains("nao-logar-isto"));
    server.shutdown();
}

#[tokio::test]
async fn corpo_grande_recusado() {
    let store = isolated_store("corpo-grande");
    let (_, token) = store
        .pair("Grande", Preset::Read, vec!["/repo".into()], "/repo", None)
        .unwrap();
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) = spawn_test_server(store, audit, Arc::new(crate::util::now_ts)).await;

    let oversized = vec![b'a'; MAX_BODY_BYTES + 1024];
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .bearer_auth(&token)
        .body(oversized)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    server.shutdown();
}

#[tokio::test]
async fn limite_de_taxa_429() {
    let store = isolated_store("rate-limit");
    let (_, token) = store
        .pair("Rapido", Preset::Read, vec!["/repo".into()], "/repo", None)
        .unwrap();
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (server, addr) = spawn_test_server(store, audit, Arc::new(crate::util::now_ts)).await;

    let http = reqwest::Client::new();
    let url = format!("http://{addr}/mcp");
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });

    for i in 0..RATE_LIMIT_PER_SEC {
        let res = http
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            reqwest::StatusCode::OK,
            "requisição {i} dentro do limite deveria passar"
        );
    }

    let throttled = http
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(throttled.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    server.shutdown();
}
