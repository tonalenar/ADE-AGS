//! O iPhone ou iPad físico ao lado do simulador: a tela do aparelho de verdade espelhada na janela, pelo cabo ou
//! pelo Wi-Fi. Por enquanto só VER: nada de toque, botão, teclado ou HID.
//!
//! A conversa com o aparelho (CoreDevice, privado) fica num helper à parte (`helpers/iphone-mirror`), para que
//! uma interface errada derrube só ele. O app lê os pacotes do vídeo, monta os quadros (`model`), decodifica com
//! o VideoToolbox e mostra a `IOSurface` numa camada nossa por cima do webview, como a tela do simulador.
//! Como funciona e o que foi medido: `docs/ade-ags/ESPELHAMENTO_IPHONE.md`.

pub mod model;
#[cfg(test)]
mod test;
mod commands;
#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
mod session;

pub use commands::*;
