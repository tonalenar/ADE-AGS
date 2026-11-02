//! Leer y guardar un archivo del workspace, para las tabs de archivo.
//!
//! La tab no guarda el archivo en memoria como fuente de verdad: el disco lo es, porque
//! los agentes escriben ahí todo el tiempo. Por eso cada lectura devuelve un token de versión
//! (`tamanho:mtime_ns[:inode]`), y guardar exige presentarlo — si otro lo cambió en el medio,
//! no se pisa. Só o mtime não bastava: disco com resolução grossa ou `cp -p`/`touch -r` mantêm
//! o mtime de um arquivo que mudou, e o `rename` de outro editor troca o inode.

use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;

/// Más que esto no se abre como texto: un editor con un log de 50 MB adentro deja de
/// responder, y para leer eso está la terminal.
const MAX_TEXT: u64 = 5 * 1024 * 1024;

/// Las imágenes viajan enteras en base64; más de esto ya no es una imagen de proyecto.
const MAX_IMAGE: u64 = 20 * 1024 * 1024;

/// Cuánto se mira del principio para decidir si es binario. Es lo mismo que hace git.
const SNIFF: usize = 8000;

const IMAGES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
];

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileContent {
    Text { content: String, mtime: i64, size: u64, version: String },
    /// `data:` listo para un `<img>`.
    Image { data_url: String, mtime: i64, size: u64, version: String },
    /// No es texto (o no es UTF-8). Se dice en vez de mostrar basura: y editar basura y
    /// guardarla corrompería el archivo.
    Binary { size: u64 },
    TooLarge { size: u64 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteOutcome {
    Saved { mtime: i64, version: String },
    /// Cambió en disco desde que se leyó (o sumió, `version: None`; ou já existe, num pedido de
    /// criação). No se escribió nada.
    Conflict { mtime: Option<i64>, version: Option<String> },
}

/// O `expected_version` de quem quer criar: grava só se o nome ainda está livre (`create_new`).
pub const ABSENT: &str = "absent";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime: i64,
    pub size: u64,
    pub version: String,
}

/// O token de versão: tamanho, mtime em nanossegundos e, onde existe, o inode. Opaco para o
/// front: só se compara por igualdade.
pub(crate) fn version_token(meta: &std::fs::Metadata) -> String {
    let ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{ns}:{}", meta.len(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{}:{ns}", meta.len())
    }
}

/// Milisegundos desde epoch. En `i64` y no `u128` porque viaja a JS como número.
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn looks_binary(head: &[u8]) -> bool {
    head.iter().take(SNIFF).any(|b| *b == 0)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGES.iter().find(|(e, _)| *e == ext).map(|(_, mime)| *mime)
}

#[tauri::command]
pub fn explorer_read_file(path: String) -> Result<FileContent, String> {
    let file = Path::new(&path);
    let meta = std::fs::metadata(file).map_err(|e| format!("no se pudo leer {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} es una carpeta"));
    }
    let size = meta.len();
    let mtime = mtime_ms(&meta);
    let version = version_token(&meta);

    if let Some(mime) = image_mime(file) {
        if size > MAX_IMAGE {
            return Ok(FileContent::TooLarge { size });
        }
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(FileContent::Image { data_url: format!("data:{mime};base64,{data}"), mtime, size, version });
    }

    if size > MAX_TEXT {
        return Ok(FileContent::TooLarge { size });
    }

    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(file)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("no se pudo leer {path}: {e}"))?;

    if looks_binary(&bytes) {
        return Ok(FileContent::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent::Text { content, mtime, size, version }),
        Err(_) => Ok(FileContent::Binary { size }),
    }
}

/// `None` = ya no existe (lo borró un agente con la tab abierta).
#[tauri::command]
pub fn explorer_file_stat(path: String) -> Result<Option<FileStat>, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(Some(FileStat { mtime: mtime_ms(&meta), size: meta.len(), version: version_token(&meta) })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Guarda solo si el archivo sigue como estaba cuando se leyó (`expected_version`).
///
/// Sin esa condición, guardar una tab abierta hace un rato pisaría en silencio lo que un
/// agente escribió mientras tanto — y es exactamente lo que pasa en esta app todo el día.
///
/// - `None`: sobrescreve sem olhar (o usuário escolheu, ou é um "salvar como").
/// - `Some(ABSENT)`: cria; se o nome já foi ocupado, é conflito (`create_new`, sem corrida).
/// - `Some(token)`: o arquivo precisa ter esse token. Se sumiu, é conflito: recriar é outra
///   decisão, que o front pede com `ABSENT`.
#[tauri::command]
pub fn explorer_write_file(
    path: String,
    content: String,
    expected_version: Option<String>,
) -> Result<WriteOutcome, String> {
    // Se escribe sobre el archivo REAL: si la ruta es un symlink (las skills adjuntas lo
    // son), un rename sobre el enlace lo reemplazaría por un archivo suelto y la skill
    // dejaría de recibir cambios.
    let target = std::fs::canonicalize(&path).unwrap_or_else(|_| Path::new(&path).to_path_buf());
    let current = std::fs::metadata(&target).ok();
    let conflict = |meta: Option<&std::fs::Metadata>| WriteOutcome::Conflict {
        mtime: meta.map(mtime_ms),
        version: meta.map(version_token),
    };

    match expected_version.as_deref() {
        Some(ABSENT) => {
            if current.is_some() {
                return Ok(conflict(current.as_ref()));
            }
            match create_new(&target, content.as_bytes()) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Ok(conflict(std::fs::metadata(&target).ok().as_ref()));
                }
                Err(e) => return Err(format!("no se pudo crear {}: {e}", target.display())),
            }
        }
        Some(expected) => match &current {
            Some(meta) if version_token(meta) == expected => write_atomic(&target, content.as_bytes())?,
            other => return Ok(conflict(other.as_ref())),
        },
        None => write_atomic(&target, content.as_bytes())?,
    }

    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    Ok(WriteOutcome::Saved { mtime: mtime_ms(&meta), version: version_token(&meta) })
}

/// Cria o arquivo no mesmo syscall que confere que o nome está livre. Se a escrita falhar
/// no meio, apaga o que criou: não deixa um arquivo pela metade com o nome do usuário.
fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// Temporal al lado y `rename`: un corte a mitad de camino deja el original intacto. El
/// temporal hereda los permisos del original, o un script ejecutable dejaría de serlo.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.ags-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("no se pudo escribir {}: {e}", tmp.display()))?;

    if let Ok(meta) = std::fs::metadata(path) {
        if let Err(e) = std::fs::set_permissions(&tmp, meta.permissions()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("no se pudieron copiar los permisos: {e}"));
        }
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("no se pudo guardar {}: {e}", path.display())
    })
}
