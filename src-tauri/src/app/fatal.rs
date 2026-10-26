//! Falha de inicialização que a pessoa precisa ler.
//!
//! Antes do Tauri existir não há janela nem toast, e no Windows o binário de release é
//! `windows_subsystem = "windows"`: um `panic!`/`expect` ali some sem deixar rastro
//! (a app "não abre"). Aqui a mensagem vai para o stderr e, no Windows, para uma caixa
//! nativa (`MessageBoxW`), e o processo sai com código 1.

/// Título e corpo do aviso. Separado para testar o texto sem abrir janela.
pub(crate) fn startup_failure_text(error: &str) -> (&'static str, String) {
    (
        "ADE AGS não pôde iniciar",
        format!("Não foi possível abrir o banco de dados do ADE AGS.\n\n{error}"),
    )
}

/// Mostra o aviso e encerra. Não volta.
pub(crate) fn exit_with_startup_error(error: &str) -> ! {
    let (title, body) = startup_failure_text(error);
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

#[cfg(not(windows))]
fn show_native(_title: &str, _body: &str) {
    // Linux/macOS: o stderr acima é o que fica no terminal ou no log do lançador.
}

#[cfg(test)]
mod tests {
    #[test]
    fn o_aviso_leva_a_frase_do_erro() {
        let msg = "Este banco é de uma versão mais nova do ADE AGS (v99)";
        let (title, body) = super::startup_failure_text(&msg);
        assert!(title.contains("ADE AGS"));
        assert!(body.contains("versão mais nova do ADE AGS (v99)"), "{body}");
    }
}
