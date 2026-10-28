// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if ade_ags_lib::desktop_apps::recovery_entry() { return; }
    ade_ags_lib::run()
}
