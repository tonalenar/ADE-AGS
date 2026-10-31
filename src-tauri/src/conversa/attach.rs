//! Os anexos das mensagens do modo chat. A tela manda só CAMINHOS que a pessoa colou, soltou ou
//! escolheu; aqui cada um é conferido antes de qualquer leitura. Nunca se lê outra coisa.
//!
//! Como cada motor recebe o anexo (decisão registrada em `docs/ade-ags/MODO_CHAT.md`):
//! - o texto da mensagem SEMPRE leva o bloco `[Anexos]` com o caminho de cada anexo (montado pela
//!   tela): é o fallback explícito, vale para todos os motores e nunca descarta um anexo em silêncio;
//! - Claude Code (stream-json) recebe, além disso, as imagens como blocos `image` em base64
//!   ([`image_blocks`]), dentro dos limites abaixo;
//! - Codex, OpenCode e Antigravity recebem só o caminho no texto: o app ainda não lê a capacidade de
//!   imagem deles (`localImage` do app-server, `promptCapabilities.image` do ACP).

use std::fs;
use std::path::Path;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};

/// Uma imagem enviada em linha (base64) passa disto para o caminho no texto: o limite da API do Claude.
pub const INLINE_IMAGE_MAX: u64 = 5 * 1024 * 1024;
/// Uma imagem lida para a prévia da tela (miniatura e visualizador).
pub const PREVIEW_IMAGE_MAX: u64 = 20 * 1024 * 1024;
/// Quantas imagens vão em linha numa mensagem; as demais seguem só pelo caminho.
pub const INLINE_IMAGES_PER_MESSAGE: usize = 8;

/// O tipo MIME de uma imagem pela extensão, ou `None` se não for uma que a tela sabe mostrar.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// O que há num caminho que a pessoa soltou ou escolheu (só `stat`: nada é lido).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    pub path: String,
    pub name: String,
    /// `image`, `file` ou `folder`.
    pub kind: &'static str,
    pub mime: Option<&'static str>,
    pub size: Option<u64>,
    pub error: Option<String>,
}

pub fn inspect(path: &str) -> Inspected {
    let p = Path::new(path);
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    let fail = |error: &str| Inspected { path: path.to_string(), name: name.clone(), kind: "file", mime: None, size: None, error: Some(error.to_string()) };
    if !p.is_absolute() {
        return fail("caminho não absoluto");
    }
    match fs::metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fail("arquivo não encontrado"),
        Err(e) => fail(&e.to_string()),
        Ok(m) if m.is_dir() => Inspected { path: path.to_string(), name, kind: "folder", mime: None, size: None, error: None },
        Ok(m) => {
            let mime = image_mime(p);
            Inspected { path: path.to_string(), name, kind: if mime.is_some() { "image" } else { "file" }, mime, size: Some(m.len()), error: None }
        }
    }
}

/// Uma imagem lida para a tela (miniatura e visualizador), como URL de dados.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub mime: &'static str,
    pub data_url: String,
}

fn read_image(path: &str, max: u64) -> Result<(&'static str, Vec<u8>), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("caminho não absoluto".into());
    }
    let mime = image_mime(p).ok_or("não é uma imagem que o app mostra")?;
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("não é um arquivo".into());
    }
    if meta.len() == 0 || meta.len() > max {
        return Err(format!("imagem vazia ou maior que {} MB", max / (1024 * 1024)));
    }
    Ok((mime, fs::read(p).map_err(|e| e.to_string())?))
}

pub fn read_preview(path: &str) -> Result<ImageData, String> {
    let (mime, bytes) = read_image(path, PREVIEW_IMAGE_MAX)?;
    Ok(ImageData { mime, data_url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) })
}

/// Os blocos `image` (base64) do Claude para estes caminhos. Uma imagem que não cabe nos limites, ou
/// que não se lê, NÃO derruba a mensagem: segue só pelo caminho que já está no texto. Devolve também
/// os caminhos que ficaram de fora, para quem chama avisar.
pub fn image_blocks(paths: &[String]) -> (Vec<Value>, Vec<String>) {
    let mut blocks = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        if blocks.len() >= INLINE_IMAGES_PER_MESSAGE {
            skipped.push(path.clone());
            continue;
        }
        match read_image(path, INLINE_IMAGE_MAX) {
            Ok((mime, bytes)) => blocks.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) },
            })),
            Err(_) => skipped.push(path.clone()),
        }
    }
    (blocks, skipped)
}

#[tauri::command]
pub fn chat_attachment_inspect(paths: Vec<String>) -> Vec<Inspected> {
    paths.iter().take(200).map(|p| inspect(p)).collect()
}

#[tauri::command]
pub fn chat_attachment_read(path: String) -> Result<ImageData, String> {
    read_preview(&path)
}
