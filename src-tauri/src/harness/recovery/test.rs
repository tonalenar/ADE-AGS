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

#[test]
fn perda_do_lease_durante_o_trabalho_vira_erro() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let db: crate::database::DbConnection =
        std::sync::Arc::new(std::sync::Mutex::new(conn));

    let result = with_boot_lease(&db, 20_000, || {
        db.lock().unwrap().execute(
            "UPDATE harness_recovery_lease SET owner='outro' WHERE id=1",
            [],
        ).unwrap();
        Ok(())
    });

    assert!(result.is_err(), "a reconciliação não pode declarar sucesso após perder o lease");
    assert!(result.unwrap_err().contains("lease"));
}

#[test]
fn o_lease_de_boot_libera_depois_de_panico() {
    let path = temp_db();
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        migrate(&conn).unwrap();
    }
    let db: crate::database::DbConnection =
        std::sync::Arc::new(std::sync::Mutex::new(Connection::open(&path).unwrap()));
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<Option<()>, String> = with_boot_lease(&db, 10_000, || panic!("falha no boot"));
    }));
    assert!(panicked.is_err());
    let mut conn = db.lock().unwrap();
    assert!(
        acquire(&mut conn, "depois", 10_001, 500).unwrap(),
        "o pânico tem que soltar o lease"
    );
    drop(conn);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}
