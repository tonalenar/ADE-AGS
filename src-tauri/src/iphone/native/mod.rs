//! O lado macOS do espelhamento: o decodificador (VideoToolbox) e a view que mostra a tela na janela.

pub mod decoder;
pub mod view;
#[cfg(test)]
mod replay;
