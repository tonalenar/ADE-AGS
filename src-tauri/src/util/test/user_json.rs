use super::super::user_json::{
    read_user_json, read_user_json_snapshot, sync_user_json, write_user_json,
    write_user_json_if_unchanged, write_user_json_with_sync, SyncMode, UserJsonError,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct Sample {
    value: String,
}

fn temp_file(tag: &str) -> (PathBuf, TestDir) {
    let dir = std::env::temp_dir().join(format!("ags-user-json-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    (dir.join(format!("{tag}.json")), TestDir(dir))
}

struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ausente_vira_none() {
    let (path, _dir) = temp_file("missing");
    assert_eq!(read_user_json::<Sample>(&path).unwrap(), None);
}

#[test]
fn ilegivel_vira_unreadable_e_preserva_original() {
    let (path, _dir) = temp_file("broken");
    let bytes = br#"{"boards":"#;
    std::fs::write(&path, bytes).unwrap();

    let err = read_user_json::<Sample>(&path).unwrap_err();
    let UserJsonError::Unreadable { quarantined, .. } = err else {
        panic!("esperava erro de JSON ilegível");
    };
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(quarantined).unwrap(), bytes);
}

#[test]
fn quarentena_reutiliza_conteudo_igual_e_limita_cinco_copias() {
    let (path, _dir) = temp_file("quarantine-retention");
    let bytes = br#"{"value":"truncado""#;
    std::fs::write(&path, bytes).unwrap();

    let first = read_user_json::<Sample>(&path).unwrap_err();
    let UserJsonError::Unreadable { quarantined: first_copy, .. } = first else {
        panic!("esperava JSON ilegível");
    };
    let second = read_user_json::<Sample>(&path).unwrap_err();
    let UserJsonError::Unreadable { quarantined: second_copy, .. } = second else {
        panic!("esperava JSON ilegível");
    };
    assert_eq!(first_copy, second_copy, "conteúdo idêntico não ganha outra cópia");

    for index in 0..6 {
        std::fs::write(&path, format!("{{\"value\":{index}" )).unwrap();
        let _ = read_user_json::<Sample>(&path);
    }
    let copies = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        .count();
    assert_eq!(copies, 5);
}

#[test]
fn gravar_mantem_bak() {
    let (path, _dir) = temp_file("backup");
    let old = Sample {
        value: "antigo".into(),
    };
    let new = Sample {
        value: "novo".into(),
    };
    write_user_json(&path, &old).unwrap();
    write_user_json(&path, &new).unwrap();

    let backup = path.with_file_name("backup.json.bak");
    assert_eq!(read_user_json::<Sample>(&backup).unwrap(), Some(old));
    assert_eq!(read_user_json::<Sample>(&path).unwrap(), Some(new));
}

#[test]
fn temporarios_concorrentes_nao_colidem() {
    let (path, _dir) = temp_file("concurrent");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let writers: Vec<_> = ["um", "dois"]
        .into_iter()
        .map(|value| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                write_user_json(
                    &path,
                    &Sample {
                        value: value.into(),
                    },
                )
            })
        })
        .collect();
    barrier.wait();
    for writer in writers {
        writer.join().unwrap().unwrap();
    }
    assert!(read_user_json::<Sample>(&path).unwrap().is_some());
}

#[test]
fn escrita_condicional_preserva_alteracao_concorrente() {
    let (path, _dir) = temp_file("concurrent-update");
    let original = Sample { value: "antigo".into() };
    write_user_json(&path, &original).unwrap();
    let (_, snapshot) = read_user_json_snapshot::<Sample>(&path).unwrap().unwrap();
    let next = Sample {
        value: "novo pela ADE".into(),
    };
    std::fs::write(&path, br#"{"value":"novo pelo Claude"}"#).unwrap();

    let error = write_user_json_if_unchanged(&path, &next, Some(&snapshot)).unwrap_err();

    assert!(error.contains("alterado"));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        br#"{"value":"novo pelo Claude"}"#
    );
}

#[test]
fn gravacao_atomica_sem_fsync_e_sync_posterior_preservam_dados_e_bak() {
    let (path, _dir) = temp_file("atomic-nosync");
    let old = Sample {
        value: "v1".into(),
    };
    let new = Sample {
        value: "v2".into(),
    };
    write_user_json_with_sync(&path, &old, SyncMode::AtomicNoSync).unwrap();
    write_user_json_with_sync(&path, &new, SyncMode::AtomicNoSync).unwrap();
    sync_user_json(&path).unwrap();

    let backup = path.with_file_name("atomic-nosync.json.bak");
    assert_eq!(read_user_json::<Sample>(&backup).unwrap(), Some(old));
    assert_eq!(read_user_json::<Sample>(&path).unwrap(), Some(new));
    let leftovers = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0, "nenhum arquivo temporário deve sobrar após o rename");
}
