use super::*;

fn temp_db() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("ags-recovery-{}.db", Uuid::new_v4().simple()))
}

#[test]
fn duas_conexoes_no_mesmo_arquivo_serializam_o_lease_e_usam_agora_injetavel() {
    let path = temp_db();
    let mut first = Connection::open(&path).unwrap();
    first.pragma_update(None, "journal_mode", "WAL").unwrap();
    migrate(&first).unwrap();
    let mut second = Connection::open(&path).unwrap();

    assert!(acquire(&mut first, "instancia-a", 10_000, 500).unwrap());
    assert!(!acquire(&mut second, "instancia-b", 10_499, 500).unwrap());
    assert!(acquire(&mut second, "instancia-b", 10_500, 500).unwrap());
    assert!(
        !release(&first, "instancia-a").unwrap(),
        "o dono antigo não libera o lease novo"
    );
    assert!(release(&second, "instancia-b").unwrap());
    assert!(acquire(&mut first, "instancia-a", 10_501, 500).unwrap());

    drop(second);
    drop(first);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}
