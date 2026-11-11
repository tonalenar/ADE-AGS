//! Comandos Tauri da galeria de SnapShots (a superfície da interface). Não passam pela CLI nem pela tabela de método:
//! são da pessoa, pela tela. A miniatura e o anexo leem o caminho que a própria listagem devolveu.

use super::gallery::{delete_in, image_path_in, list_in, SnapshotItem};
use crate::computer_use::snapshot::captures_dir;

#[tauri::command]
pub fn snapshot_gallery_list() -> Result<Vec<SnapshotItem>, String> {
    list_in(&captures_dir()?)
}

/// Copia o PNG para a área de transferência do Mac. Reaproveita a cópia de PNG que já existe (ela só confere o formato);
/// o caminho vem da pasta de capturas, nunca de um texto livre.
#[tauri::command]
pub fn snapshot_gallery_copy(id: String) -> Result<(), String> {
    let path = image_path_in(&captures_dir()?, &id)?;
    crate::iphone::commands::iphone_copy_image(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn snapshot_gallery_delete(id: String) -> Result<(), String> {
    delete_in(&captures_dir()?, &id)
}
