use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::*;

fn pasta_temporaria(nome: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ade-ags-storage-{nome}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("criar a pasta de teste");
    dir
}

/// Um arquivo com `bytes` bytes e a data de modificação `ha` atrás (o relógio do teste fica no `now`).
fn arquivo_com_idade(path: &Path, bytes: usize, ha: Duration) {
    std::fs::write(path, vec![7u8; bytes]).unwrap();
    let quando = SystemTime::now().checked_sub(ha).unwrap();
    std::fs::File::options().write(true).open(path).unwrap().set_modified(quando).unwrap();
}

#[test]
fn o_banco_inclui_o_wal_e_o_shm_mas_nunca_entra_na_limpeza() {
    let home = pasta_temporaria("home");
    let areas = areas(&home, &home.join("capturas"));
    let banco = areas.iter().find(|a| a.id == AreaId::Database).expect("a área do banco");
    assert!(!banco.cleanable);
    assert!(banco.paths.contains(&home.join("data.db-wal")));
    assert!(banco.paths.contains(&home.join("data.db-shm")));
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn so_as_capturas_se_limpam_e_as_worktrees_nao() {
    let home = pasta_temporaria("limpaveis");
    let areas = areas(&home, &home.join("capturas"));
    let limpaveis: Vec<AreaId> = areas.iter().filter(|a| a.cleanable).map(|a| a.id).collect();
    assert_eq!(limpaveis, vec![AreaId::DeviceCaptures, AreaId::BrowserCaptures]);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_medida_separa_o_que_e_antigo_e_so_mostra_isso_nas_capturas() {
    let dir = pasta_temporaria("medida");
    let shots = dir.join("screens");
    std::fs::create_dir_all(&shots).unwrap();
    arquivo_com_idade(&shots.join("nova.png"), 100, Duration::from_secs(60));
    arquivo_com_idade(&shots.join("velha.png"), 300, Duration::from_secs(10 * 24 * 60 * 60));
    let cutoff = cutoff_now();
    let capturas = measure(&areas(&dir, &dir.join("capturas"))[3], cutoff);
    assert_eq!((capturas.files, capturas.bytes), (2, 400));
    assert_eq!((capturas.old_files, capturas.old_bytes), (1, 300));
    // Nas worktrees, o "antigo" não aparece: a limpeza não mexe nelas.
    let worktrees = measure(&areas(&dir, &dir.join("capturas"))[2], cutoff);
    assert_eq!((worktrees.old_files, worktrees.old_bytes), (0, 0));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_limpeza_apaga_so_o_antigo_e_deixa_a_pasta() {
    let dir = pasta_temporaria("limpeza");
    let shots = dir.join("screens");
    std::fs::create_dir_all(&shots).unwrap();
    arquivo_com_idade(&shots.join("nova.png"), 100, Duration::from_secs(60));
    arquivo_com_idade(&shots.join("velha.png"), 300, Duration::from_secs(10 * 24 * 60 * 60));
    let spec = areas(&dir, &dir.join("capturas")).into_iter().find(|a| a.id == AreaId::DeviceCaptures).unwrap();
    let feito = clean_area(&spec, cutoff_now()).expect("a área é limpável");
    assert_eq!(feito, CleanResult { files: 1, bytes: 300 });
    assert!(shots.join("nova.png").exists());
    assert!(!shots.join("velha.png").exists());
    assert!(shots.is_dir());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn uma_area_sem_limpeza_recusa_e_nao_apaga_nada() {
    let dir = pasta_temporaria("recusa");
    std::fs::create_dir_all(dir.join("chat-worktrees")).unwrap();
    let velho = dir.join("chat-worktrees").join("velho.txt");
    arquivo_com_idade(&velho, 50, Duration::from_secs(30 * 24 * 60 * 60));
    let spec = areas(&dir, &dir.join("capturas")).into_iter().find(|a| a.id == AreaId::ChatWorktrees).unwrap();
    assert!(clean_area(&spec, cutoff_now()).is_err());
    assert!(velho.exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn um_link_para_fora_da_pasta_nao_e_medido_nem_apagado() {
    let dir = pasta_temporaria("link");
    let shots = dir.join("screens");
    std::fs::create_dir_all(&shots).unwrap();
    let fora = dir.join("fora.png");
    arquivo_com_idade(&fora, 500, Duration::from_secs(30 * 24 * 60 * 60));
    std::os::unix::fs::symlink(&fora, shots.join("atalho.png")).unwrap();
    let spec = areas(&dir, &dir.join("capturas")).into_iter().find(|a| a.id == AreaId::DeviceCaptures).unwrap();
    let medido = measure(&spec, cutoff_now());
    assert_eq!((medido.files, medido.bytes), (0, 0));
    assert_eq!(clean_area(&spec, cutoff_now()).unwrap(), CleanResult::default());
    assert!(fora.exists());
    std::fs::remove_dir_all(&dir).ok();
}
