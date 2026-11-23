//! Testes do módulo `remote` (Parte B1: servidor HTTP e tokens de cliente).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::clients::{ClientStore, Preset};
use super::http::{AuditEntry, Limits, MAX_BODY_BYTES, RATE_LIMIT_PER_SEC, ServerConfig, start_on};
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
        limits: Limits::default(),
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

// ── Conexões: teto, prazos, desligamento e limite antes da autenticação ──

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn spawn_with_limits(store: ClientStore, limits: Limits) -> (super::http::RunningServer, SocketAddr) {
    let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let mut config = test_config(store, Arc::new(Mutex::new(Vec::new())), Arc::new(crate::util::now_ts));
    config.limits = limits;
    let server = start_on(&[loopback], config).await.expect("servidor de teste");
    let addr = server.addrs()[0];
    (server, addr)
}

fn ping_request(token: &str) -> String {
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    format!(
        "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

/// Lê uma resposta HTTP inteira (cabeçalhos + corpo por Content-Length) e devolve o texto.
async fn read_response(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    loop {
        let mut chunk = [0u8; 2048];
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .expect("resposta não chegou")
            .unwrap();
        assert!(n > 0, "conexão fechada antes da resposta completa: {:?}", String::from_utf8_lossy(&buf));
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let len = text[..end]
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                return text;
            }
        }
    }
}

/// A conexão foi fechada pelo servidor (EOF) dentro do prazo?
async fn closed_by_server(stream: &mut TcpStream, within: Duration) -> bool {
    let mut chunk = [0u8; 256];
    matches!(tokio::time::timeout(within, stream.read(&mut chunk)).await, Ok(Ok(0)) | Ok(Err(_)))
}

#[tokio::test]
async fn desligar_fecha_tambem_as_conexoes_keep_alive_ja_abertas() {
    let store = isolated_store("shutdown-keepalive");
    let (_, token) = store.pair("KA", Preset::Read, vec!["/repo".into()], "/repo", None).unwrap();
    let (server, addr) = spawn_with_limits(store, Limits::default()).await;

    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(ping_request(&token).as_bytes()).await.unwrap();
    assert!(read_response(&mut stream).await.starts_with("HTTP/1.1 200"));

    server.shutdown();
    assert!(closed_by_server(&mut stream, Duration::from_secs(3)).await, "a conexão keep-alive seguiu aberta depois de desligar");
}

#[tokio::test]
async fn conexoes_alem_do_teto_sao_fechadas_e_as_de_dentro_do_teto_seguem() {
    let store = isolated_store("teto-conexoes");
    let (_, token) = store.pair("Teto", Preset::Read, vec!["/repo".into()], "/repo", None).unwrap();
    let limits = Limits { max_connections: 2, ..Limits::default() };
    let (server, addr) = spawn_with_limits(store, limits).await;

    let mut first = TcpStream::connect(addr).await.unwrap();
    let _second = TcpStream::connect(addr).await.unwrap();
    let mut third = TcpStream::connect(addr).await.unwrap();
    assert!(closed_by_server(&mut third, Duration::from_secs(3)).await, "a terceira conexão deveria ser fechada");
    first.write_all(ping_request(&token).as_bytes()).await.unwrap();
    assert!(read_response(&mut first).await.starts_with("HTTP/1.1 200"));
    server.shutdown();
}

#[tokio::test]
async fn cabecalho_que_nao_termina_expira() {
    let store = isolated_store("prazo-cabecalho");
    let limits = Limits { header_read_timeout: Duration::from_millis(300), ..Limits::default() };
    let (server, addr) = spawn_with_limits(store, limits).await;

    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"POST /mcp HTTP/1.1\r\nHost: x\r\n").await.unwrap();
    assert!(closed_by_server(&mut stream, Duration::from_secs(5)).await, "cabeçalho incompleto deveria expirar");
    server.shutdown();
}

#[tokio::test]
async fn corpo_que_nao_chega_expira_com_408() {
    let store = isolated_store("prazo-corpo");
    let (_, token) = store.pair("Corpo", Preset::Read, vec!["/repo".into()], "/repo", None).unwrap();
    let limits = Limits { body_read_timeout: Duration::from_millis(300), ..Limits::default() };
    let (server, addr) = spawn_with_limits(store, limits).await;

    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!("POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: 100\r\n\r\n{{");
    stream.write_all(head.as_bytes()).await.unwrap();
    assert!(read_response(&mut stream).await.starts_with("HTTP/1.1 408"));
    server.shutdown();
}

#[tokio::test]
async fn o_limite_por_ip_vale_antes_da_autenticacao() {
    let store = isolated_store("limite-antes-da-auth");
    let limits = Limits { pre_auth_per_sec: 3, ..Limits::default() };
    let (server, addr) = spawn_with_limits(store, limits).await;

    let http = reqwest::Client::new();
    let url = format!("http://{addr}/mcp");
    let mut statuses = Vec::new();
    for _ in 0..4 {
        let res = http.post(&url).bearer_auth("token-errado").json(&json!({ "id": 1 })).send().await.unwrap();
        statuses.push(res.status());
    }
    assert_eq!(&statuses[..3], &[reqwest::StatusCode::UNAUTHORIZED; 3]);
    assert_eq!(statuses[3], reqwest::StatusCode::TOO_MANY_REQUESTS, "token errado também gasta o limite do IP");
    server.shutdown();
}

#[test]
fn autenticar_nao_regrava_o_indice_no_keyring_e_o_last_seen_vem_da_memoria() {
    let store = isolated_store("last-seen-memoria");
    let (client, token) = store.pair("Visto", Preset::Read, vec!["/repo".into()], "/repo", None).unwrap();
    let antes = store.raw_index_json().unwrap();
    for _ in 0..5 {
        store.authenticate_at(&token, 1_700_000_000).unwrap();
    }
    assert_eq!(store.raw_index_json().unwrap(), antes, "cada requisição regravava o índice inteiro no keyring");
    let listado = store.list().into_iter().find(|c| c.id == client.id).unwrap();
    assert_eq!(listado.last_seen_at, Some(1_700_000_000));
}

// ── Parte B3: presets e ações perigosas com confirmação ──────────

fn remote_ctx(preset: Preset) -> crate::ipc::mcp::McpContext {
    crate::ipc::mcp::McpContext::Remote {
        client: "cli-b3".into(),
        cwd: "/repo".into(),
        preset,
        folders: vec!["/repo".into()],
    }
}

fn listed_tool_names(ctx: &crate::ipc::mcp::McpContext) -> Vec<String> {
    let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let resp = crate::ipc::mcp::handle_frame(ctx, "", &req, &mut |_, _| Ok(json!({})))
        .expect("tools/list devolve resposta");
    resp["result"]["tools"]
        .as_array()
        .expect("lista de tools")
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect()
}

#[test]
fn preset_leitura_nao_lista_nem_chama_browser_type() {
    let ctx = remote_ctx(Preset::Read);
    let names = listed_tool_names(&ctx);
    assert!(
        !names.iter().any(|n| n == "browser_type"),
        "Leitura não deve listar browser_type: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n == "chat_send"),
        "Leitura não deve listar chat_send"
    );
    assert!(
        names.iter().any(|n| n == "chat_list") && names.iter().any(|n| n == "design_list"),
        "Leitura mantém ferramentas de consulta: {names:?}"
    );

    let req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "browser_type", "arguments": { "target": "e1", "text": "x" } }
    });
    let mut dispatched = false;
    let resp = crate::ipc::mcp::handle_frame(&ctx, "", &req, &mut |_, _| {
        dispatched = true;
        Ok(json!({ "text": "ok" }))
    })
    .unwrap();
    assert!(!dispatched, "browser_type não pode ser despachada no preset Leitura");
    assert_eq!(resp["result"]["isError"], true);
}

#[test]
fn preset_navegador_nao_chama_chat_send() {
    let ctx = remote_ctx(Preset::Browser);
    let names = listed_tool_names(&ctx);
    assert!(
        names.iter().any(|n| n == "browser_type"),
        "Navegador deve listar browser_type"
    );
    assert!(
        !names.iter().any(|n| n == "chat_send"),
        "Navegador não deve listar chat_send"
    );
    assert!(
        !names.iter().any(|n| n == "git_push"),
        "Navegador não deve listar git_push"
    );

    let req = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": { "name": "chat_send", "arguments": { "thread": "t1", "text": "oi" } }
    });
    let mut dispatched = false;
    let resp = crate::ipc::mcp::handle_frame(&ctx, "", &req, &mut |_, _| {
        dispatched = true;
        Ok(json!({ "text": "ok" }))
    })
    .unwrap();
    assert!(!dispatched, "chat_send não pode ser despachada no preset Navegador");
    assert_eq!(resp["result"]["isError"], true);
}

#[test]
fn acao_perigosa_fica_pendente_ate_confirmar() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    assert!(super::approval::needs_approval("git_push", &json!({})));
    assert!(super::approval::needs_approval("secret_run", &json!({ "secret_id": "s1", "program": "curl" })));
    assert!(super::approval::needs_approval("vault_run", &json!({})));
    assert!(super::approval::needs_approval("browser_fill_login", &json!({})));
    assert!(super::approval::needs_approval("floor_delete", &json!({})));
    assert!(super::approval::needs_approval("tab_send", &json!({ "tab": "t-usuario", "text": "rm -rf" })));
    assert!(super::approval::needs_approval("delegate_task", &json!({ "budget_usd": 25.0 })));
    assert!(!super::approval::needs_approval("browser_snapshot", &json!({})));

    let (asked_tx, asked_rx) = mpsc::channel::<serde_json::Value>();
    let (decide_tx, decide_rx) = mpsc::channel::<String>();
    let forge_executed = Arc::new(AtomicBool::new(false));
    let forge_flag = forge_executed.clone();

    let worker = std::thread::spawn(move || {
        let ctx = remote_ctx(Preset::All);
        let req = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": { "name": "git_push", "arguments": {} }
        });
        crate::ipc::mcp::handle_frame(&ctx, "", &req, &mut |command, payload| {
            if command == "user.ask" {
                asked_tx.send(payload).unwrap();
                let answer = decide_rx.recv().unwrap();
                return Ok(json!({ "text": answer }));
            }
            if command == "forge.run" {
                forge_flag.store(true, Ordering::SeqCst);
                return Ok(json!({ "text": "pushed" }));
            }
            Err(format!("comando inesperado: {command}"))
        })
    });

    // O pedido de confirmação chega com cliente e tool, e a ação ainda NÃO executou.
    let ask_payload = asked_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("ação perigosa deve pedir confirmação via user.ask");
    let question = ask_payload["question"].as_str().unwrap_or("");
    assert!(question.contains("cli-b3"), "cartão deve mostrar o cliente: {question}");
    assert!(question.contains("git_push"), "cartão deve mostrar a tool: {question}");
    assert!(
        !forge_executed.load(Ordering::SeqCst),
        "git_push não pode rodar antes da confirmação"
    );

    // Após a pessoa confirmar, a ação prossegue.
    decide_tx.send("Permitir".into()).unwrap();
    let resp = worker.join().unwrap().unwrap();
    assert!(forge_executed.load(Ordering::SeqCst), "git_push deve executar após confirmar");
    assert!(resp["result"].get("isError").is_none(), "{resp}");
}

#[test]
fn acao_perigosa_recusada_quando_a_pessoa_nega() {
    let ctx = remote_ctx(Preset::All);
    let req = json!({
        "jsonrpc": "2.0",
        "id": 11,
        "method": "tools/call",
        "params": { "name": "git_push", "arguments": {} }
    });
    let mut forge_called = false;
    let resp = crate::ipc::mcp::handle_frame(&ctx, "", &req, &mut |command, _payload| {
        if command == "user.ask" {
            return Ok(json!({ "text": "Recusar" }));
        }
        if command == "forge.run" {
            forge_called = true;
            return Ok(json!({ "text": "pushed" }));
        }
        Err(format!("comando inesperado: {command}"))
    })
    .unwrap();
    assert!(!forge_called, "quando a pessoa nega, git_push não pode rodar");
    assert_eq!(resp["result"]["isError"], true);
}

