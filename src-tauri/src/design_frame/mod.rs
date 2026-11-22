//! Protocolo customizado `ags-design` para servir HTML isolado (pranchetas de Design,
//! renders publicados, apps MCP e prévias visuais) por uma origem própria, sem herdar a
//! CSP do documento principal do app no WKWebView/WebKitGTK/WebView2.
//!
//! Segurança:
//! - O HTML é NÃO CONFIÁVEL e é servido com CSP restritiva por header HTTP (definida
//!   exclusivamente por `FramePolicy` aqui no backend, nunca por string livre do cliente).
//! - Os iframes mantêm `sandbox="allow-scripts"` SEM `allow-same-origin` (origem opaca,
//!   sem cookies, sem acesso ao DOM do app e sem `window.__TAURI_INTERNALS__`).
//! - O conteúdo fica em memória por um identificador SHA-256 efêmero com TTL e limites
//!   de tamanho, nunca na URL.

mod commands;
mod protocol;
mod store;

#[cfg(test)]
mod test;

pub use commands::*;
pub use protocol::handle_request;
pub use store::{DesignFrameStore, SCHEME};
