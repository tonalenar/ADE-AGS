//! Falha de inicialização que a pessoa precisa ler.
//!
//! Antes do Tauri existir não há janela nem toast, e no Windows o binário de release é
//! `windows_subsystem = "windows"`: um `panic!`/`expect` ali some sem deixar rastro
//! (a app "não abre"). A falha vai para o stderr, para o log de inicialização da pasta de
//! dados (`logs/inicializacao.log`, quando a pasta existe) e para uma caixa nativa
//! (`MessageBoxW` no Windows, `osascript` no macOS). Depois, o processo sai com código 1.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Título e corpo do aviso. `log` é o arquivo onde a falha ficou, se a pasta de dados existe.
/// Separado para testar o texto sem abrir janela.
pub(crate) fn startup_failure_text(error: &str, log: Option<&Path>) -> (&'static str, String) {
    let detalhe = match log {
        Some(log) => format!("O detalhe técnico ficou em:\n{}", log.display()),
        None => "O detalhe técnico só saiu no terminal: a pasta de dados do ADE AGS não está disponível.".to_string(),
    };
    ("ADE AGS não pôde iniciar", format!("{error}\n\n{detalhe}"))
}

/// Acrescenta a falha ao log de inicialização da pasta de dados e devolve o caminho do arquivo.
/// Quem chama ignora o erro de I/O: ele não pode esconder a falha original.
pub(crate) fn registrar_falha(dir: &Path, error: &str) -> std::io::Result<PathBuf> {
    let logs = dir.join("logs");
    std::fs::create_dir_all(&logs)?;
    let caminho = logs.join("inicializacao.log");
    let mut arquivo = std::fs::OpenOptions::new().create(true).append(true).open(&caminho)?;
    writeln!(arquivo, "[{}] {error}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))?;
    Ok(caminho)
}

/// Mostra o aviso e encerra. Não volta.
pub(crate) fn exit_with_startup_error(error: &str) -> ! {
    // O log só existe se a pasta de dados existe; sem ela, o detalhe fica só no terminal.
    let log = crate::util::datadir::ags_home().and_then(|dir| registrar_falha(&dir, error).ok());
    let (title, body) = startup_failure_text(error, log.as_deref());
    eprintln!("[ade-ags] {title}: {body}");
    show_native(title, &body);
    std::process::exit(1);
}

#[cfg(windows)]
fn show_native(title: &str, body: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (title, body) = (wide(title), wide(body));
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

/// macOS: caixa do sistema via `osascript`. O texto entra como argumento (`on run argv`), e não
/// montado dentro do AppleScript: aspas e barras do erro não quebram o script. Espera o clique em OK.
#[cfg(target_os = "macos")]
fn show_native(title: &str, body: &str) {
    const SCRIPT: &str = "on run argv\n\
        display dialog (item 2 of argv) with title (item 1 of argv) buttons {\"OK\"} default button \"OK\" with icon stop\n\
        end run";
    let mut comando = crate::util::spawn::hidden_command("osascript");
    comando.arg("-e").arg(SCRIPT).arg(title).arg(body);
    // Se o osascript não existir ou falhar, a saída segue: o stderr acima já tem a mensagem.
    let _ = comando.status();
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_native(_title: &str, _body: &str) {
    // Linux: o stderr acima é o que fica no terminal ou no log do lançador.
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn o_aviso_leva_a_frase_do_erro() {
        let msg = "Este banco é de uma versão mais nova do ADE AGS (v99)";
        let (title, body) = super::startup_failure_text(msg, None);
        assert!(title.contains("ADE AGS"));
        assert!(body.contains("versão mais nova do ADE AGS (v99)"), "{body}");
    }

    /// Com a pasta de dados disponível, o aviso aponta o arquivo de log para a pessoa ter onde olhar.
    #[test]
    fn o_aviso_aponta_o_caminho_do_log() {
        let log = Path::new("/dados/logs/inicializacao.log");
        let (_, body) = super::startup_failure_text("falha", Some(log));
        assert!(body.contains("/dados/logs/inicializacao.log"), "{body}");
    }

    /// Sem pasta de dados não há log: o aviso diz onde o detalhe saiu, sem inventar um caminho.
    #[test]
    fn sem_log_o_aviso_diz_que_o_detalhe_ficou_no_terminal() {
        let (_, body) = super::startup_failure_text("falha", None);
        assert!(body.contains("terminal"), "{body}");
        assert!(!body.contains("inicializacao.log"), "{body}");
    }

    #[test]
    fn registrar_falha_acrescenta_no_log_de_inicializacao() {
        let root = std::env::temp_dir().join(format!("ade-fatal-{}", uuid::Uuid::new_v4()));
        let primeiro = super::registrar_falha(&root, "primeira falha").unwrap();
        let segundo = super::registrar_falha(&root, "segunda falha").unwrap();
        assert_eq!(primeiro, root.join("logs").join("inicializacao.log"));
        assert_eq!(primeiro, segundo);
        let texto = std::fs::read_to_string(&primeiro).unwrap();
        assert!(texto.contains("primeira falha") && texto.contains("segunda falha"), "{texto}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
