use std::time::Instant;

use tauri::http::{Method, Request, Response, StatusCode, header};

use super::store::DesignFrameStore;

const ERROR_CSP: &str = "default-src 'none'";

/// Responde a uma requisição do URI scheme `ags-design` usando o relógio atual.
pub fn handle_request(store: &DesignFrameStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    handle_request_at(store, request, Instant::now())
}

/// Versão com relógio explícito para testes determinísticos de TTL (sem `sleep`).
pub(crate) fn handle_request_at(
    store: &DesignFrameStore,
    request: &Request<Vec<u8>>,
    now: Instant,
) -> Response<Vec<u8>> {
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, b"Method Not Allowed");
    }

    let id = request.uri().path().trim_start_matches('/');
    let Some(frame) = store.get_at(id, now) else {
        return error_response(StatusCode::NOT_FOUND, b"Not Found");
    };

    let body = if method == Method::HEAD {
        Vec::new()
    } else {
        frame.html
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, frame.policy.csp())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body)
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, b"Internal Error"))
}

fn error_response(status: StatusCode, body: &[u8]) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, ERROR_CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body.to_vec())
        .expect("resposta de erro estática sempre válida")
}
