use std::path::{Path, PathBuf};

use super::gallery::{delete_in, image_path_in, is_snapshot_id, list_in};
use crate::computer_use::snapshot::{info_json, Scope, SnapshotInfo, PREFIX};

/// Uma pasta nova por teste, na temporária do sistema. Nunca a pasta de capturas do usuário.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        Scratch(std::env::temp_dir().join(format!("ade-snapshots-{}", uuid::Uuid::new_v4().simple())))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const CAPTURE_A: &str = "ADE-AGS_SnapShot_2026-11-10_21-00-00_aaaaaaaa-0000-4000-8000-000000000001";
const CAPTURE_B: &str = "ADE-AGS_SnapShot_2026-11-10_21-05-00_bbbbbbbb-0000-4000-8000-000000000002";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

fn legenda(app: &str) -> String {
    info_json(&SnapshotInfo {
        version: 1,
        scope: Scope::Window,
        app: Some(app.to_string()),
        title: Some("ade".to_string()),
        display_number: None,
        captured_at: "2026-11-10T21:00:00-03:00".to_string(),
    })
}

fn grava(dir: &Path, nome: &str, bytes: &[u8]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(nome), bytes).unwrap();
}

#[test]
fn reconhece_so_o_nome_de_uma_captura_do_snapshot() {
    assert!(is_snapshot_id(CAPTURE_A));
    assert!(!is_snapshot_id("../ADE-AGS_SnapShot_x"), "um id com barra sai da pasta");
    assert!(!is_snapshot_id(PREFIX), "o prefixo sozinho não é uma captura");
    assert!(!is_snapshot_id("foto_de_ferias"));
    assert!(!is_snapshot_id("ADE-AGS_SnapShot_a.b"), "ponto não entra no id");
}

#[test]
fn lista_so_os_pngs_com_o_prefixo_e_traz_a_legenda_quando_ha_json() {
    let scratch = Scratch::new();
    grava(&scratch.0, &format!("{CAPTURE_A}.png"), PNG);
    grava(&scratch.0, &format!("{CAPTURE_A}.json"), legenda("Terminal").as_bytes());
    grava(&scratch.0, &format!("{CAPTURE_B}.png"), PNG);
    grava(&scratch.0, "foto_de_ferias.png", PNG);
    grava(&scratch.0, &format!("{CAPTURE_B}.txt"), b"nao e captura");

    let mut itens = list_in(&scratch.0).unwrap();
    itens.sort_by(|a, b| a.id.cmp(&b.id));
    let ids: Vec<&str> = itens.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, [CAPTURE_A, CAPTURE_B]);

    let com_legenda = &itens[0];
    assert_eq!(com_legenda.app.as_deref(), Some("Terminal"));
    assert_eq!(com_legenda.title.as_deref(), Some("ade"));
    assert_eq!(com_legenda.scope.as_deref(), Some("window"));
    assert_eq!(com_legenda.captured_at.as_deref(), Some("2026-11-10T21:00:00-03:00"));

    let sem_legenda = &itens[1];
    assert_eq!(sem_legenda.app, None);
    assert_eq!(sem_legenda.captured_at, None);
    assert_eq!(sem_legenda.bytes, PNG.len() as u64);
}

#[test]
fn pasta_que_ainda_nao_existe_e_lista_vazia() {
    let scratch = Scratch::new();
    assert_eq!(list_in(&scratch.0.join("nada")).unwrap(), Vec::new());
}

#[test]
fn o_caminho_da_captura_so_existe_para_id_valido_e_arquivo_presente() {
    let scratch = Scratch::new();
    std::fs::create_dir_all(&scratch.0).unwrap();
    assert!(image_path_in(&scratch.0, CAPTURE_A).unwrap_err().contains("não está mais"));
    grava(&scratch.0, &format!("{CAPTURE_A}.png"), PNG);
    let caminho = image_path_in(&scratch.0, CAPTURE_A).unwrap();
    assert!(caminho.ends_with(format!("{CAPTURE_A}.png")));
    assert!(image_path_in(&scratch.0, "../etc").unwrap_err().contains("inválido"));
}

#[test]
fn apagar_tira_o_png_e_o_json_e_nao_toca_no_resto() {
    let scratch = Scratch::new();
    grava(&scratch.0, &format!("{CAPTURE_A}.png"), PNG);
    grava(&scratch.0, &format!("{CAPTURE_A}.json"), legenda("Safari").as_bytes());
    grava(&scratch.0, "foto_de_ferias.png", PNG);

    delete_in(&scratch.0, CAPTURE_A).unwrap();
    assert!(!scratch.0.join(format!("{CAPTURE_A}.png")).exists());
    assert!(!scratch.0.join(format!("{CAPTURE_A}.json")).exists());
    assert!(scratch.0.join("foto_de_ferias.png").exists(), "arquivo de fora da galeria fica");
    assert!(delete_in(&scratch.0, CAPTURE_A).is_err(), "apagar de novo é erro, não silêncio");
}
