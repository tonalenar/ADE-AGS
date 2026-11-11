//! Comandos Tauri da superfície "Páginas HTML" (a lista, a leitura, apagar e abrir no navegador do sistema). São da
//! pessoa, pela interface: não passam pela CLI nem pela tabela de autorização de método.

use std::time::Duration;

use crate::util::spawn::{hidden_command, output};

use super::{delete_in, dir, known_html_path, list_in, read_html_in, RenderPage};

#[tauri::command]
pub fn render_list() -> Result<Vec<RenderPage>, String> {
    list_in(&dir()?, None)
}

#[tauri::command]
pub fn render_read(id: String) -> Result<String, String> {
    read_html_in(&dir()?, &id)
}

#[tauri::command]
pub fn render_delete(id: String) -> Result<(), String> {
    delete_in(&dir()?, &id)
}

/// Abre a página no navegador padrão do sistema, pelo arquivo que já está na pasta de dados. Não é uma URL da rede:
/// o caminho sai do índice, e o programa é o do sistema para abrir arquivos `.html`.
#[tauri::command]
pub fn render_open_external(id: String) -> Result<(), String> {
    let path = crate::util::external_path::external_path(&known_html_path(&dir()?, &id)?);
    let (program, args): (&str, Vec<std::path::PathBuf>) = if cfg!(target_os = "macos") {
        ("open", vec![path])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![path])
    } else {
        ("xdg-open", vec![path])
    };
    let mut cmd = hidden_command(program);
    cmd.args(&args);
    // O programa só entrega o arquivo ao navegador e volta; o código de saída do `explorer` não diz nada útil.
    output(&mut cmd, Duration::from_secs(15))
        .map(|_| ())
        .map_err(|e| format!("Não consegui abrir a página no navegador: {e}"))
}
