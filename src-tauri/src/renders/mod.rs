//! Páginas HTML publicadas pelos agentes (o "HTML render" do T3 Code). Ver `store.rs` para o formato e as regras,
//! `images.rs` para as imagens locais embutidas na publicação, `commands.rs` para a interface e
//! `ipc/commands/renders.rs` para `ags render`.

pub mod commands;
mod images;
mod store;

pub use store::{RenderPage, delete_in, dir, known_html_path, list_in, publish_in, read_html_in};

#[cfg(test)]
mod test;
