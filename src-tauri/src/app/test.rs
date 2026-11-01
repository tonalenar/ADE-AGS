use std::sync::{Arc, Mutex};

use super::rendering::{gpu_compositing_enabled, GPU_COMPOSITING_KEY};
use crate::database::set_setting;

/// Sin nada guardado, el texto nítido: es lo que se ve bien en Linux, y quien necesite la
/// GPU la prende a propósito (ver `rendering.rs`).
#[test]
fn por_defecto_no_se_compone_por_gpu() {
    let db = Arc::new(Mutex::new(crate::database::test_db()));
    assert!(!gpu_compositing_enabled(&db));
}

#[test]
fn solo_un_uno_explicito_prende_la_composicion() {
    let db = Arc::new(Mutex::new(crate::database::test_db()));
    set_setting(&db, GPU_COMPOSITING_KEY, "1").unwrap();
    assert!(gpu_compositing_enabled(&db));
    set_setting(&db, GPU_COMPOSITING_KEY, "0").unwrap();
    assert!(!gpu_compositing_enabled(&db));
    set_setting(&db, GPU_COMPOSITING_KEY, "true").unwrap();
    assert!(!gpu_compositing_enabled(&db), "cualquier otra cosa no cuenta");
}

/// Soltar arquivos num terminal depende do drop nativo do Tauri (`onDragDropEvent` em
/// `useFileDropToTerminal.ts`). Desligar `dragDropEnabled` numa janela, ou chamar
/// `disable_drag_drop_handler` num builder, quebra isso sem erro nenhum.
#[test]
fn o_drop_nativo_continua_ligado() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
            .unwrap();
    for window in conf["app"]["windows"].as_array().expect("tauri.conf tem janelas") {
        assert_ne!(
            window.get("dragDropEnabled"),
            Some(&serde_json::Value::Bool(false)),
            "dragDropEnabled não pode ser desligado no tauri.conf"
        );
    }
    let mut stack = vec![root.join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && path.file_name() != Some("test.rs".as_ref()) {
                let src = std::fs::read_to_string(&path).unwrap();
                assert!(
                    !src.contains(&["disable_drag", "_drop_handler("].concat()),
                    "{} desliga o drop nativo",
                    path.display()
                );
            }
        }
    }
}

#[test]
fn opcoes_informativas_saem_sem_iniciar_o_app() {
    use super::arguments::informational_output;
    for flag in ["--version", "-V"] {
        assert_eq!(informational_output([flag.into()]), Some(format!("ade-ags {}", env!("CARGO_PKG_VERSION"))));
    }
    for flag in ["--help", "-h"] {
        assert!(informational_output([flag.into()]).unwrap().contains("--headless"));
    }
    assert!(informational_output(["--headless".into()]).is_none());
}
