//! Opções informativas não inicializam Tauri nem acessam o diretório de dados.
pub(super) fn informational_output(args: impl IntoIterator<Item = String>) -> Option<String> {
    for arg in args {
        match arg.as_str() {
            "--version" | "-V" => return Some(format!("ade-ags {}", env!("CARGO_PKG_VERSION"))),
            "--help" | "-h" => return Some("ADE AGS\n\nUso: ade-ags [OPÇÕES]\n\n  --version, -V  Mostra a versão e sai\n  --help, -h     Mostra esta ajuda e sai\n  --headless     Inicia sem mostrar janelas\n\nADE_AGS_DATA_DIR permite uma instância com dados isolados.".into()),
            _ => {}
        }
    }
    None
}
