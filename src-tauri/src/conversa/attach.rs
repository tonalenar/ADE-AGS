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
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};
#[cfg(target_os = "macos")]
use crate::util::spawn;

const MEDIA_TOOLS_HELPER: &str = "ade-image-tools";

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

fn media_tools_helper_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let mut candidates = vec![
        directory.join("../Resources/binaries").join(MEDIA_TOOLS_HELPER),
        directory.join("binaries").join(MEDIA_TOOLS_HELPER),
        directory.join(MEDIA_TOOLS_HELPER),
    ];
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(MEDIA_TOOLS_HELPER));
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub fn background_removal_available() -> bool {
    cfg!(target_os = "macos") && media_tools_helper_path().is_some()
}

pub fn remove_background(path: &str) -> Result<String, String> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return Err("caminho não absoluto".into());
    }
    // Confere caminho, tipo e limite antes de entregar o arquivo ao helper.
    read_image(path, PREVIEW_IMAGE_MAX)?;
    #[cfg(not(target_os = "macos"))]
    {
        return Err("remoção de fundo disponível só no macOS".into());
    }
    #[cfg(target_os = "macos")]
    {
        let helper = media_tools_helper_path().ok_or("helper de imagem não disponível")?;
        let input = input.canonicalize().map_err(|error| error.to_string())?;
        let output = std::env::temp_dir().join(format!("ade-sem-fundo-{}.png", uuid::Uuid::new_v4()));
        let mut command = spawn::hidden_command(helper);
        command.arg("remove-background").arg(input).arg(&output);
        let result = spawn::output(&mut command, Duration::from_secs(120)).map_err(|error| error.to_string())?;
        if !result.status.success() {
            let _ = fs::remove_file(&output);
            let error = String::from_utf8_lossy(&result.stderr).trim().to_string();
            return Err(if error.is_empty() { "não foi possível remover o fundo".into() } else { error });
        }
        if !output.is_file() {
            return Err("o helper não gerou uma imagem".into());
        }
        Ok(output.to_string_lossy().into_owned())
    }
}

/// O caminho livre para a cópia anotada de `original`: `nome-anotado.png` na mesma pasta, ou
/// `nome-anotado-2.png`, `-3`… se já existir. Nunca sobrescreve nada.
pub fn annotated_path(original: &Path) -> Option<PathBuf> {
    let dir = original.parent()?;
    let stem = original.file_stem()?.to_string_lossy().into_owned();
    (1..1000).map(|n| if n == 1 { format!("{stem}-anotado.png") } else { format!("{stem}-anotado-{n}.png") })
        .map(|name| dir.join(name))
        .find(|candidate| !candidate.exists())
}

/// Grava a cópia anotada (PNG em base64) AO LADO de uma imagem ou vídeo que o app já mostra (o quadro
/// anotado de um vídeo). Só aceita original absoluto que seja imagem legível ou arquivo de vídeo, e
/// conteúdo PNG dentro do limite; cria um arquivo novo, nunca sobrescreve. Devolve o caminho novo.
pub fn save_annotated(original: &str, png_base64: &str) -> Result<String, String> {
    let source = Path::new(original);
    if !source.is_absolute() {
        return Err("caminho não absoluto".into());
    }
    let video = source.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| matches!(e.as_str(), "mp4" | "mov" | "m4v" | "webm" | "mkv"));
    if video {
        if !source.is_file() {
            return Err("não é um arquivo".into());
        }
    } else {
        read_image(original, PREVIEW_IMAGE_MAX)?;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(png_base64.trim()).map_err(|_| "PNG inválido".to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("o conteúdo não é PNG".into());
    }
    if bytes.len() as u64 > PREVIEW_IMAGE_MAX * 2 {
        return Err("imagem anotada grande demais".into());
    }
    let target = annotated_path(Path::new(original)).ok_or("não há nome livre para a cópia anotada")?;
    fs::OpenOptions::new().write(true).create_new(true).open(&target)
        .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
        .map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
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

#[tauri::command]
pub fn chat_attachment_remove_background_available() -> bool {
    background_removal_available()
}

#[tauri::command]
pub fn chat_attachment_remove_background(path: String) -> Result<String, String> {
    remove_background(&path)
}

#[tauri::command]
pub fn chat_attachment_save_annotated(path: String, png_base64: String) -> Result<String, String> {
    save_annotated(&path, &png_base64)
}
