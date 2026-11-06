//! O iPhone ou iPad físico ao lado do simulador: a tela do aparelho de verdade espelhada na janela, pelo cabo ou
//! pelo Wi-Fi, com toque, botões e teclado pelo HID do CoreDevice (a pessoa pela tela; os agentes pelo `ags device`
//! e pelo `sim act`, com a mesma autorização do simulador).
//!
//! A conversa com o aparelho (CoreDevice, privado) fica num helper à parte (`helpers/iphone-mirror`), para que
//! uma interface errada derrube só ele. O app lê os pacotes do vídeo, monta os quadros (`model`), decodifica com
//! o VideoToolbox e mostra a `IOSurface` numa camada nossa por cima do webview, como a tela do simulador.
//! Como funciona e o que foi medido: `docs/ade-ags/ESPELHAMENTO_IPHONE.md`.

pub mod model;
#[cfg(test)]
mod test;
pub(crate) mod commands;
pub(crate) mod ops;
#[cfg(target_os = "macos")]
pub(crate) mod native;
#[cfg(target_os = "macos")]
pub(crate) mod session;

pub use commands::*;
