#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    if let Some(code) = ade_ags_lib::cef_helper_entry() {
        std::process::exit(code);
    }
    #[cfg(not(target_os = "macos"))]
    std::process::exit(1);
}
