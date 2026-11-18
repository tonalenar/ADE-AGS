//! Falha de inicialização que a pessoa precisa ler.
//!
//! Antes do Tauri existir não há janela nem toast, e no Windows o binário de release é
//! `windows_subsystem = "windows"`: um `panic!`/`expect` ali some sem deixar rastro
//! (a app "não abre"). A falha vai para o stderr, para o log de inicialização da pasta de
//! dados (`logs/inicializacao.log`, quando a pasta existe) e para uma caixa nativa
//! (`MessageBoxW` no Windows, `osascript` no macOS). Depois, o processo sai com código 1.

use std::path::{Path, PathBuf};

/// Onde a falha de boot ficou registrada. Diz ao aviso o que a pessoa pode fazer com ela.
#[derive(Debug, PartialEq)]
pub(crate) enum LogEstado {
    /// Sem pasta de dados não há log: o detalhe só saiu no terminal.
    SemPasta,
    /// A falha foi acrescentada ao arquivo de log.
    Gravado(PathBuf),
    /// A pasta existe, mas gravar falhou (permissão, disco cheio): o motivo vai para o aviso.
    Falhou(String),
}

/// Título e corpo do aviso. Separado para testar o texto sem abrir janela.
pub(crate) fn startup_failure_text(error: &str, log: &LogEstado) -> (&'static str, String) {
    let detalhe = match log {
        LogEstado::Gravado(caminho) => format!("O detalhe técnico ficou em:\n{}", caminho.display()),
        LogEstado::Falhou(motivo) => format!("Não foi possível gravar o log: {motivo}."),
        LogEstado::SemPasta => {
            "O detalhe técnico só saiu no terminal: a pasta de dados do ADE AGS não está disponível.".to_string()
        }
    };
    ("ADE AGS não pôde iniciar", format!("{error}\n\n{detalhe}"))
}

/// Acrescenta a falha ao log de inicialização e diz onde ela ficou, ou por que não ficou.
///
pub(crate) fn estado_do_log(dir: Option<&Path>, error: &str) -> LogEstado {
    match dir {
        None => LogEstado::SemPasta,
        Some(dir) => match registrar_falha(dir, error) {
            Ok(caminho) => LogEstado::Gravado(caminho),
            Err(erro) => LogEstado::Falhou(erro.to_string()),
        },
    }
}

/// Acrescenta a falha ao log de inicialização da pasta de dados e devolve o caminho do arquivo.
pub(crate) fn registrar_falha(dir: &Path, error: &str) -> std::io::Result<PathBuf> {
    crate::util::datadir::anexar_log_em(dir, "inicializacao.log", error)
}

/// Mostra o aviso e encerra. Não volta.
pub(crate) fn exit_with_startup_error(error: &str) -> ! {
    let log = estado_do_log(crate::util::datadir::ags_home().as_deref(), error);
    let (title, body) = startup_failure_text(error, &log);
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
    use super::{LogEstado, estado_do_log};
    use std::path::PathBuf;

    #[test]
    fn o_aviso_leva_a_frase_do_erro() {
        let msg = "Este banco é de uma versão mais nova do ADE AGS (v99)";
        let (title, body) = super::startup_failure_text(msg, &LogEstado::SemPasta);
        assert!(title.contains("ADE AGS"));
        assert!(body.contains("versão mais nova do ADE AGS (v99)"), "{body}");
    }

    /// Com a pasta de dados disponível, o aviso aponta o arquivo de log para a pessoa ter onde olhar.
    #[test]
    fn o_aviso_aponta_o_caminho_do_log() {
        let log = LogEstado::Gravado(PathBuf::from("/dados/logs/inicializacao.log"));
        let (_, body) = super::startup_failure_text("falha", &log);
        assert!(body.contains("/dados/logs/inicializacao.log"), "{body}");
    }

    /// Sem pasta de dados não há log: o aviso diz onde o detalhe saiu, sem inventar um caminho.
    #[test]
    fn sem_log_o_aviso_diz_que_o_detalhe_ficou_no_terminal() {
        let (_, body) = super::startup_failure_text("falha", &LogEstado::SemPasta);
        assert!(body.contains("terminal"), "{body}");
        assert!(!body.contains("inicializacao.log"), "{body}");
    }

    /// A pasta existe mas não grava (aqui, um arquivo ocupa o lugar dela, como um disco cheio ou sem permissão).
    /// O aviso tem que dizer a causa e manter o erro original, em vez de fingir que a pasta não existe.
    #[test]
    fn log_que_nao_grava_diz_a_causa() {
        let root = std::env::temp_dir().join(format!("ade-fatal-falha-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ocupado = root.join("arquivo");
        std::fs::write(&ocupado, b"nao e pasta").unwrap();
        let estado = estado_do_log(Some(ocupado.as_path()), "falha de boot");
        assert!(matches!(estado, LogEstado::Falhou(_)), "{estado:?}");
        let (_, body) = super::startup_failure_text("falha de boot", &estado);
        assert!(body.contains("Não foi possível gravar o log"), "{body}");
        assert!(body.contains("falha de boot"), "o erro original continua no aviso: {body}");
        std::fs::remove_dir_all(root).unwrap();
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
