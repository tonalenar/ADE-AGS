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

#[test]
fn a_versao_do_app_coincide_nos_manifestos_de_release() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let tauri: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
            .unwrap();
    let package: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("../package.json")).unwrap(),
    )
    .unwrap();
    let cargo_version = env!("CARGO_PKG_VERSION");

    assert_eq!(tauri["version"].as_str(), Some(cargo_version));
    assert_eq!(package["version"].as_str(), Some(cargo_version));
}

/// F-08 (HOST_REMOTO.md): `set_var` só é seguro com um thread. Nada que crie thread pode vir antes das
/// chamadas que mexem no ambiente do processo, em `run()`.
#[test]
fn nenhum_thread_nasce_antes_das_chamadas_que_mexem_no_ambiente() {
    let run = include_str!("run.rs");
    let corpo = &run[run.find("pub fn run()").expect("run() mudou de forma")..];
    let pos = |trecho: &str| corpo.find(trecho).unwrap_or_else(|| panic!("run() deixou de chamar {trecho}"));
    let ultima_mexida_no_ambiente = [
        "super::rendering::configure(&db_conn)",
        "super::rendering::configure_scrollbars()",
        "crate::util::path_env::configure()",
        "crate::ipc::export_instance_env()",
    ]
    .into_iter()
    .map(pos)
    .max()
    .unwrap();
    for criador_de_thread in ["crate::database::spawn_wal_maintenance(", "super::signals::cleanup_on_signals()"] {
        assert!(
            pos(criador_de_thread) > ultima_mexida_no_ambiente,
            "{criador_de_thread} cria um thread antes de a última chamada que faz set_var terminar"
        );
    }
}

/// Vídeos anexados no chat usam `convertFileSrc` (`asset://` / `http://asset.localhost`). Sem a feature
/// `protocol-asset`, o escopo liberado (inclusive pastas com ponto como `~/.t3`) e a CSP, o `<video>` falha.
#[test]
fn o_protocolo_asset_e_a_csp_permitem_reproduzir_videos_locais() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let cargo = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(cargo.contains("protocol-asset"), "tauri precisa da feature protocol-asset");

    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
            .unwrap();
    let security = &conf["app"]["security"];
    let asset = &security["assetProtocol"];
    assert_eq!(asset["enable"], serde_json::Value::Bool(true));
    assert_eq!(asset["scope"]["requireLiteralLeadingDot"], serde_json::Value::Bool(false));
    let allow = asset["scope"]["allow"].as_array().expect("scope.allow precisa ser lista");
    assert!(allow.iter().any(|v| v.as_str() == Some("**")));
    assert!(allow.iter().any(|v| v.as_str() == Some("/**")));

    for directive in ["img-src", "media-src"] {
        let csp = security["csp"][directive].as_str().unwrap_or_default();
        assert!(csp.contains("asset:"), "{directive} deve liberar asset:");
        assert!(csp.contains("http://asset.localhost"), "{directive} deve liberar http://asset.localhost");
    }
}
