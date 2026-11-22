use std::time::{Duration, Instant};

use tauri::http::{Method, Request, StatusCode, header};

use super::protocol::handle_request_at;
use super::store::{
    DESIGN_CSP, DesignFrameStore, FramePolicy, ISOLATED_FRAME_CSP, SCHEME, StoreConfig,
};

fn get_req(uri: &str) -> Request<Vec<u8>> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Vec::new())
        .unwrap()
}

#[test]
fn documento_registrado_responde_200_com_csp_no_header_e_html_integro() {
    let store = DesignFrameStore::new();
    let now = Instant::now();
    let html = "<!doctype html><html><body><button onclick=\"this.textContent='ok'\">clicar</button></body></html>";

    for (policy, expected_csp) in [
        (FramePolicy::Design, DESIGN_CSP),
        (FramePolicy::Isolated, ISOLATED_FRAME_CSP),
    ] {
        let id = store.register_at(html.to_string(), policy, now).unwrap();
        assert_eq!(id.len(), 64);

        // Formato macOS/Linux (`ags-design://localhost/<id>`) e formato Windows (`http://ags-design.localhost/<id>`).
        for uri in [
            format!("{SCHEME}://localhost/{id}"),
            format!("http://{SCHEME}.localhost/{id}"),
        ] {
            let res = handle_request_at(&store, &get_req(&uri), now);
            assert_eq!(res.status(), StatusCode::OK, "uri {uri}");
            assert_eq!(
                res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
                Some("text/html; charset=utf-8")
            );
            assert_eq!(
                res.headers()
                    .get(header::CONTENT_SECURITY_POLICY)
                    .and_then(|v| v.to_str().ok()),
                Some(expected_csp)
            );
            assert_eq!(
                res.headers()
                    .get(header::X_CONTENT_TYPE_OPTIONS)
                    .and_then(|v| v.to_str().ok()),
                Some("nosniff")
            );
            assert_eq!(
                res.headers()
                    .get(header::CACHE_CONTROL)
                    .and_then(|v| v.to_str().ok()),
                Some("no-store")
            );
            assert_eq!(
                res.headers()
                    .get(header::REFERRER_POLICY)
                    .and_then(|v| v.to_str().ok()),
                Some("no-referrer")
            );
            assert_eq!(res.body().as_slice(), html.as_bytes());
        }
    }
}

#[test]
fn csp_das_politicas_bloqueia_rede_e_ipc() {
    for csp in [DESIGN_CSP, ISOLATED_FRAME_CSP] {
        assert!(csp.contains("default-src 'none'"), "faltou default-src 'none': {csp}");
        assert!(csp.contains("form-action 'none'"), "faltou form-action 'none': {csp}");
        assert!(csp.contains("base-uri 'none'"), "faltou base-uri 'none': {csp}");
        assert!(csp.contains("script-src 'unsafe-inline'"), "faltou script-src inline: {csp}");
        // Curinga de esquema (`https:` sozinho) liberaria qualquer host; só hosts exatos entram.
        let tokens: Vec<&str> = csp.split([' ', ';']).collect();
        assert!(!tokens.contains(&"http:"), "não pode liberar rede http: {csp}");
        assert!(!tokens.contains(&"https:"), "não pode liberar rede https: {csp}");
        assert!(!csp.contains("http://"), "nada por http sem TLS: {csp}");
        assert!(!csp.contains("ipc:"), "não pode liberar ipc: {csp}");
        assert!(!csp.contains("unsafe-eval"), "não pode liberar unsafe-eval: {csp}");
        assert!(csp.contains("connect-src 'none'") || csp.starts_with("default-src 'none'"), "sem rede: {csp}");
    }
    // Quadros isolados (renders, apps MCP, prévias) não carregam nada de fora.
    assert!(!ISOLATED_FRAME_CSP.contains("https://"), "isolado sem hosts: {ISOLATED_FRAME_CSP}");
    // Pranchetas: só as bibliotecas da lista, como nos Artifacts.
    let hosts: Vec<&str> = DESIGN_CSP.split([' ', ';']).filter(|t| t.starts_with("https://")).collect();
    assert_eq!(hosts, [
        "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com",
        "https://cdn.tailwindcss.com", "https://code.jquery.com",
        "https://fonts.googleapis.com", "https://fonts.gstatic.com",
    ]);
    assert!(DESIGN_CSP.contains("connect-src 'none'"));
}

#[test]
fn conteudo_inexistente_ou_id_invalido_retorna_404() {
    let store = DesignFrameStore::new();
    let now = Instant::now();
    let missing_id = "0".repeat(64);

    for uri in [
        format!("{SCHEME}://localhost/{missing_id}"),
        format!("{SCHEME}://localhost/"),
        format!("{SCHEME}://localhost/favicon.ico"),
        format!("{SCHEME}://localhost/../segredo"),
        format!("{SCHEME}://localhost/abc/def"),
        format!("{SCHEME}://localhost/{}", "G".repeat(64)),
    ] {
        let res = handle_request_at(&store, &get_req(&uri), now);
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "uri {uri}");
        assert_eq!(
            res.headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("default-src 'none'")
        );
    }
}

#[test]
fn metodo_diferente_de_get_ou_head_retorna_405() {
    let store = DesignFrameStore::new();
    let now = Instant::now();
    let id = store
        .register_at("<p>ok</p>".to_string(), FramePolicy::Design, now)
        .unwrap();

    let head = Request::builder()
        .method(Method::HEAD)
        .uri(format!("{SCHEME}://localhost/{id}"))
        .body(Vec::new())
        .unwrap();
    let head_res = handle_request_at(&store, &head, now);
    assert_eq!(head_res.status(), StatusCode::OK);
    assert!(head_res.body().is_empty());

    for method in [Method::POST, Method::PUT, Method::DELETE] {
        let req = Request::builder()
            .method(method)
            .uri(format!("{SCHEME}://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let res = handle_request_at(&store, &req, now);
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}

#[test]
fn ttl_expira_entrada_e_acesso_antes_renova_validade() {
    let ttl = Duration::from_secs(60);
    let store = DesignFrameStore::with_config(StoreConfig {
        ttl,
        max_document_bytes: 1024,
        max_total_bytes: 4096,
        max_entries: 8,
    });
    let t0 = Instant::now();
    let id = store
        .register_at("<p>vivo</p>".to_string(), FramePolicy::Design, t0)
        .unwrap();
    let uri = format!("{SCHEME}://localhost/{id}");

    // Acesso aos 40 s renova o TTL por mais 60 s (até 100 s).
    let t1 = t0 + Duration::from_secs(40);
    assert_eq!(handle_request_at(&store, &get_req(&uri), t1).status(), StatusCode::OK);

    // Aos 90 s ainda está válido graças à renovação em t1.
    let t2 = t0 + Duration::from_secs(90);
    assert_eq!(handle_request_at(&store, &get_req(&uri), t2).status(), StatusCode::OK);

    // 60 s depois do último acesso (t2 + 60 s), expira e devolve 404 limpando a memória.
    let t3 = t2 + ttl;
    assert_eq!(
        handle_request_at(&store, &get_req(&uri), t3).status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(store.len(), 0);
    assert_eq!(store.total_bytes(), 0);
}

#[test]
fn limite_de_tamanho_individual_rejeita_documento_acima_do_teto() {
    let store = DesignFrameStore::with_config(StoreConfig {
        ttl: Duration::from_secs(60),
        max_document_bytes: 16,
        max_total_bytes: 64,
        max_entries: 8,
    });
    let now = Instant::now();
    assert!(store.register_at("a".repeat(16), FramePolicy::Design, now).is_ok());
    let err = store
        .register_at("a".repeat(17), FramePolicy::Design, now)
        .unwrap_err();
    assert!(err.contains("16"), "erro deve informar o limite: {err}");
}

#[test]
fn limite_total_de_bytes_e_entradas_descarta_os_menos_recentes() {
    let store = DesignFrameStore::with_config(StoreConfig {
        ttl: Duration::from_secs(60),
        max_document_bytes: 32,
        max_total_bytes: 20,
        max_entries: 2,
    });
    let now = Instant::now();
    let id1 = store.register_at("1234567890".to_string(), FramePolicy::Design, now).unwrap();
    let id2 = store.register_at("abcdefghij".to_string(), FramePolicy::Design, now).unwrap();
    assert_eq!(store.len(), 2);
    assert_eq!(store.total_bytes(), 20);

    // Tocar id1 torna id2 o menos recente (LRU).
    assert!(store.get_at(&id1, now).is_some());

    // Novo documento de 10 bytes precisa despejar id2 para manter o limite.
    let id3 = store.register_at("klmnopqrst".to_string(), FramePolicy::Design, now).unwrap();
    assert_eq!(store.len(), 2);
    assert_eq!(store.total_bytes(), 20);
    assert!(store.get_at(&id1, now).is_some());
    assert!(store.get_at(&id2, now).is_none());
    assert!(store.get_at(&id3, now).is_some());
}

#[test]
fn mesmo_html_reutiliza_id_e_politicas_distintas_nao_colidem() {
    let store = DesignFrameStore::new();
    let now = Instant::now();
    let html = "<p>mesmo</p>";

    let a1 = store.register_at(html.to_string(), FramePolicy::Design, now).unwrap();
    let a2 = store.register_at(html.to_string(), FramePolicy::Design, now).unwrap();
    let b1 = store.register_at(html.to_string(), FramePolicy::Isolated, now).unwrap();

    assert_eq!(a1, a2);
    assert_ne!(a1, b1);
    assert_eq!(store.len(), 2);
    assert_eq!(store.total_bytes(), html.len() * 2);
}

#[test]
fn tauri_conf_e_capabilities_liberam_ags_design_so_em_frame_src_sem_permissao_remota() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
            .unwrap();
    let csp = &conf["app"]["security"]["csp"];
    let frame_src = csp["frame-src"].as_str().unwrap_or_default();
    assert!(frame_src.contains("ags-design:"), "frame-src deve liberar ags-design:");
    assert!(
        frame_src.contains("http://ags-design.localhost"),
        "frame-src deve liberar http://ags-design.localhost"
    );
    assert_eq!(csp["script-src"].as_str(), Some("'self'"));
    assert_eq!(csp["connect-src"].as_str(), Some("'self' ipc: http://ipc.localhost"));
    assert_ne!(conf["app"]["withGlobalTauri"], serde_json::Value::Bool(true));

    let cap: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    assert!(
        cap.get("remote").is_none(),
        "capabilities/default.json não deve conceder acesso remoto"
    );
    let raw_cap = serde_json::to_string(&cap).unwrap();
    assert!(
        !raw_cap.contains(SCHEME),
        "o scheme {SCHEME} não deve receber nenhuma capability"
    );
}
