// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    if let Some(code) = ade_ags_lib::cef_helper_entry() {
        std::process::exit(code);
    }
    // Sonda de desenvolvimento: sobe e derruba o CEF sem janela (só debug).
    #[cfg(all(target_os = "macos", debug_assertions))]
    if std::env::args_os().any(|argument| argument == "--cef-probe") {
        match ade_ags_lib::cef_initialize_probe() {
            Ok(()) => println!("[cef-probe] CEF inicializou e encerrou sem criar janela."),
            Err(error) => {
                eprintln!("[cef-probe] {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if ade_ags_lib::desktop_apps::recovery_entry() { return; }
    ade_ags_lib::run()
}
