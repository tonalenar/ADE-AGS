use std::path::PathBuf;

use super::*;

fn pasta_temporaria(nome: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ade-ags-diag-{nome}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("criar a pasta de teste");
    dir
}

#[test]
fn o_tamanho_do_banco_vem_do_arquivo_principal_e_nao_do_wal() {
    let dir = pasta_temporaria("banco");
    std::fs::write(dir.join("data.db"), vec![0u8; 10]).unwrap();
    std::fs::write(dir.join("data.db-wal"), vec![0u8; 99]).unwrap();
    let snap = snapshot("1.0.0", Some(&dir), false, vec![]);
    assert_eq!(snap.database_bytes, 10);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn sem_banco_ou_sem_pasta_o_tamanho_e_zero() {
    let dir = pasta_temporaria("vazio");
    assert_eq!(snapshot("1.0.0", Some(&dir), false, vec![]).database_bytes, 0);
    let sem_pasta = snapshot("1.0.0", None, false, vec![]);
    assert_eq!(sem_pasta.database_bytes, 0);
    assert_eq!(sem_pasta.data_dir, None);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn o_diagnostico_leva_versao_pasta_isolamento_e_terminais() {
    let dir = pasta_temporaria("campos");
    let terminais = vec![PtySessionInfo { id: 7, tab_id: Some("aba-1".into()), output_bytes: 42 }];
    let snap = snapshot("2.3.4", Some(&dir), true, terminais.clone());
    assert_eq!(snap.version, "2.3.4");
    assert_eq!(snap.data_dir.as_deref(), Some(dir.to_string_lossy().as_ref()));
    assert!(snap.isolated);
    assert_eq!(snap.terminals, terminais);
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn um_link_para_o_banco_nao_conta_como_banco() {
    let dir = pasta_temporaria("link");
    let alvo = dir.join("outro.db");
    std::fs::write(&alvo, vec![0u8; 500]).unwrap();
    std::os::unix::fs::symlink(&alvo, dir.join("data.db")).unwrap();
    assert_eq!(file_bytes(&dir.join("data.db")), 0);
    std::fs::remove_dir_all(&dir).ok();
}
