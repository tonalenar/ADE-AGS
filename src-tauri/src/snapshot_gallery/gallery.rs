//! A galeria de SnapShots: as capturas que já estão na pasta `ADE AGS` do usuário (ver `computer_use::snapshot`). Ela só
//! lista, copia, apaga (por clique, na tela) e entrega o caminho para anexar ao chat. Não captura nada: a captura é de
//! `computer_use::snapshot`, e nenhuma captura some sozinha.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::computer_use::snapshot::{read_info, sidecar_for, Scope, PREFIX};

/// Um tamanho de id que cabe com folga no nome de arquivo mais longo que o SnapShot gera.
const ID_MAX_CHARS: usize = 200;

/// Uma captura da pasta, com a legenda do JSON ao lado quando ela existe.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotItem {
    /// O nome do PNG sem `.png`: é o id que a interface manda de volta para copiar ou apagar.
    pub id: String,
    /// O caminho absoluto do PNG, para a miniatura e para anexar ao chat.
    pub path: String,
    pub app: Option<String>,
    pub title: Option<String>,
    /// `display` ou `window`, como gravado no JSON.
    pub scope: Option<String>,
    /// O instante da captura como está no JSON. Sem JSON, `None`, e vale o horário do arquivo.
    pub captured_at: Option<String>,
    /// Milissegundos desde a época Unix, da última gravação do PNG.
    pub modified_ms: i64,
    pub bytes: u64,
}

/// Um id de captura é o nome do PNG sem extensão: começa com o prefixo do SnapShot e só tem letras, números, `-` e
/// `_`. Assim um id nunca sai da pasta de capturas. Pura.
pub fn is_snapshot_id(id: &str) -> bool {
    id.len() <= ID_MAX_CHARS
        && id.starts_with(PREFIX)
        && id.len() > PREFIX.len()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// As capturas da pasta, da mais nova para a mais antiga. Pasta que ainda não existe é lista vazia.
pub fn list_in(dir: &Path) -> Result<Vec<SnapshotItem>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Não consegui ler a pasta de capturas: {e}")),
    };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("png") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else { continue };
        if !is_snapshot_id(&id) {
            continue;
        }
        // Link simbólico ou pasta com cara de captura não entram: a galeria só mostra arquivos comuns.
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let info = read_info(&path, dir);
        items.push(SnapshotItem {
            id,
            path: path.to_string_lossy().into_owned(),
            app: info.as_ref().and_then(|i| i.app.clone()),
            title: info.as_ref().and_then(|i| i.title.clone()),
            scope: info.as_ref().map(|i| scope_name(&i.scope).to_string()),
            captured_at: info.as_ref().map(|i| i.captured_at.clone()),
            modified_ms: modified_ms(&meta),
            bytes: meta.len(),
        });
    }
    items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.id.cmp(&a.id)));
    Ok(items)
}

/// O caminho do PNG de uma captura da galeria. Recusa id fora do formato e captura que já não está na pasta.
pub fn image_path_in(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_snapshot_id(id) {
        return Err("Id de captura inválido.".into());
    }
    let path = dir.join(format!("{id}.png"));
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(path),
        _ => Err("Essa captura não está mais na pasta de capturas.".into()),
    }
}

/// Apaga a captura: o PNG e o JSON ao lado. Só a interface chama isto, por clique.
pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    let png = image_path_in(dir, id)?;
    std::fs::remove_file(&png).map_err(|e| format!("Não consegui apagar a captura: {e}"))?;
    if let Some(json) = sidecar_for(&png, dir) {
        match std::fs::remove_file(&json) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("A captura saiu, mas o JSON dela não foi apagado: {e}")),
        }
    }
    Ok(())
}

fn scope_name(scope: &Scope) -> &'static str {
    match scope {
        Scope::Display => "display",
        Scope::Window => "window",
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
