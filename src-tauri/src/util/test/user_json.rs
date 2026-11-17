use super::super::user_json::{
    read_user_json, write_user_json, write_user_json_if_unchanged, UserJsonError,
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
    let original = br#"{"value":"antigo"}"#;
    std::fs::write(&path, original).unwrap();
    let next = Sample {
        value: "novo pela ADE".into(),
    };
    std::fs::write(&path, br#"{"value":"novo pelo Claude"}"#).unwrap();

    let error = write_user_json_if_unchanged(&path, &next, Some(original)).unwrap_err();

    assert!(error.contains("alterado"));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        br#"{"value":"novo pelo Claude"}"#
    );
}
