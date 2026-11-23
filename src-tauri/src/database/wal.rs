//! Checkpoint periódico do WAL em modo `PASSIVE` (não bloqueante).
//!
//! O autosave de abas escreve seguido e o `-wal` pode crescer com o app aberto. Este hilo
//! monitora o arquivo e, acima do teto, executa `PRAGMA wal_checkpoint(PASSIVE)` numa conexão
//! lateral com `busy_timeout` curto (~250 ms), sem prender o mutex global do banco e sem usar
//! `TRUNCATE`/`RESTART` no caminho quente. O modo `PASSIVE` transfere as páginas prontas ao
//! arquivo principal para o SQLite reutilizar o `-wal` sem bloquear escritores nem leitores.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{user_db_path, DbConnection};

/// Acima deste tamanho (8 MiB), dispara `wal_checkpoint(PASSIVE)` na conexão lateral para
/// reutilizar o `-wal` e impedir crescimento sem limite.
pub const WAL_CHECKPOINT_CEILING: u64 = 8 * 1024 * 1024;

const INTERVAL: Duration = Duration::from_secs(30);

const WAL_CHECKPOINT_PASSIVE_SQL: &str = "PRAGMA wal_checkpoint(PASSIVE)";

/// Resultado retornado pelo SQLite em `PRAGMA wal_checkpoint(PASSIVE)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalCheckpointOutcome {
    pub busy: i64,
    pub log_frames: i64,
    pub checkpointed_frames: i64,
}

/// SQLite nombra el sidecar `{archivo}-wal`, no `{stem}.wal`.
pub fn wal_sidecar(db_file: &Path) -> PathBuf {
    let mut name = db_file.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

pub fn wal_needs_checkpoint(size: u64, ceiling: u64) -> bool {
    size > ceiling
}

/// `true` se o `-wal` passou do teto e o checkpoint `PASSIVE` foi executado na conexão lateral.
pub fn checkpoint_wal(db: &DbConnection, db_file: &Path, ceiling: u64) -> bool {
    checkpoint_wal_with(db, db_file, ceiling, || {})
}

/// Como `checkpoint_wal`. `antes_do_io` roda logo antes do `PASSIVE`, com o mutex do banco solto
/// (os testes usam para provar isso). Roda numa conexão lateral com `busy_timeout` curto:
/// nunca retém o mutex do banco nem bloqueia escritores. `_db` fica pela assinatura do laço.
pub(crate) fn checkpoint_wal_with(
    db: &DbConnection,
    db_file: &Path,
    ceiling: u64,
    antes_do_io: impl FnOnce(),
) -> bool {
    checkpoint_wal_passive_with(db, db_file, ceiling, antes_do_io).is_some()
}

/// Executa `PRAGMA wal_checkpoint(PASSIVE)` se o `-wal` ultrapassou `ceiling`, devolvendo
/// os contadores `(busy, log_frames, checkpointed_frames)` do SQLite.
pub(crate) fn checkpoint_wal_passive_with(
    _db: &DbConnection,
    db_file: &Path,
    ceiling: u64,
    antes_do_io: impl FnOnce(),
) -> Option<WalCheckpointOutcome> {
    let wal = wal_sidecar(db_file);
    let size = std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0);
    if !wal_needs_checkpoint(size, ceiling) {
        return None;
    }
    antes_do_io();
    let conn = crate::database::open_wal_checkpoint_connection_at(db_file).ok()?;
    conn.query_row(WAL_CHECKPOINT_PASSIVE_SQL, [], |row| {
        Ok(WalCheckpointOutcome {
            busy: row.get(0)?,
            log_frames: row.get(1)?,
            checkpointed_frames: row.get(2)?,
        })
    })
    .ok()
}

/// Hilo de fondo. No se arranca desde `init_db`: los tests abren la base del usuario.
///
/// Espera a que el upgrade de la onda 2 termine (`VACUUM INTO` + migración). Hasta
/// `mark_db_ready` el hilo no mira el `-wal` y no corre `wal_checkpoint`.
pub fn spawn_wal_maintenance(db: DbConnection) {
    let _ = std::thread::Builder::new().name("wal-checkpoint".into()).spawn(move || {
        super::connection::wait_until_db_ready();
        // Sem pasta de dados não há base para checkpointar: a thread simplesmente termina.
        let Some(path) = user_db_path() else { return };
        loop {
            std::thread::sleep(INTERVAL);
            let _ = checkpoint_wal(&db, &path, WAL_CHECKPOINT_CEILING);
        }
    });
}

/// El guardado de la ventana no puede copiar el buffer del PTY con el mutex tomado.
#[cfg(test)]
fn save_window_source_avoids_pty_copy() {
    let src = include_str!("queries/windows.rs");
    let start = src.find("fn db_save_window_state_sync").expect("función");
    let rest = &src[start..];
    let end = rest.find("pub async fn db_load_window_state").expect("función siguiente");
    let body = &rest[..end];
    let needle = ["scrollback", "_of"].concat();
    assert!(!body.contains(&needle), "db_save_window_state_sync no puede llamar al copiado del PTY");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    /// O checkpoint do WAL não pode rodar com o mutex do banco preso: a sonda confere, no instante
    /// do `PASSIVE`, que o mutex está solto.
    #[test]
    fn el_checkpoint_corre_sin_el_mutex_del_banco() {
        let dir = std::env::temp_dir().join(format!("ags-wal-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("base.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE t(b BLOB);",
        )
        .unwrap();
        let blob = vec![0u8; 64 * 1024];
        for _ in 0..80 {
            conn.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
        }
        let db = Arc::new(Mutex::new(conn));
        let probe = db.clone();
        let mut chegou = false;
        let fez = checkpoint_wal_with(&db, &path, 1024 * 1024, || {
            assert!(probe.try_lock().is_ok(), "o checkpoint do WAL rodou com o mutex do banco preso");
            chegou = true;
        });
        assert!(fez && chegou, "o checkpoint não foi feito");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_sidecar_es_el_archivo_con_sufijo_wal() {
        let path = wal_sidecar(Path::new("dir/data.db"));
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("data.db-wal"));
    }

    #[test]
    fn el_techo_deja_pasar_un_wal_chico() {
        assert!(!wal_needs_checkpoint(0, WAL_CHECKPOINT_CEILING));
        assert!(!wal_needs_checkpoint(WAL_CHECKPOINT_CEILING, WAL_CHECKPOINT_CEILING));
        assert!(wal_needs_checkpoint(WAL_CHECKPOINT_CEILING + 1, WAL_CHECKPOINT_CEILING));
    }

    #[test]
    fn bajo_el_techo_no_toca_la_conexion() {
        let dir = std::env::temp_dir().join(format!("ade-wal-bajo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES (1);").unwrap();
        let db = Arc::new(Mutex::new(conn));
        assert!(!checkpoint_wal(&db, &path, WAL_CHECKPOINT_CEILING));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checkpoint_usa_passive_sem_truncate_nem_restart_e_timeout_curto() {
        let src = include_str!("wal.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("seção de testes")];
        assert!(
            production.contains("wal_checkpoint(PASSIVE)"),
            "o checkpoint periódico deve usar PRAGMA wal_checkpoint(PASSIVE)"
        );
        assert!(
            !production.contains("wal_checkpoint(TRUNCATE)"),
            "o caminho quente do WAL não pode usar wal_checkpoint(TRUNCATE)"
        );
        assert!(
            !production.contains("wal_checkpoint(RESTART)"),
            "o caminho quente do WAL não pode usar wal_checkpoint(RESTART)"
        );

        let dir = std::env::temp_dir().join(format!("ade-wal-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = crate::database::open_wal_checkpoint_connection_at(&path).unwrap();
        let timeout: i64 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert!(
            timeout > 0 && timeout <= 250,
            "busy_timeout da conexão de checkpoint deve ser curto (<= 250 ms), veio {timeout}"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn passive_checkpointa_frames_e_impede_crescimento_sem_limite() {
        let dir = std::env::temp_dir().join(format!("ade-wal-passive-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE t(b BLOB);",
        )
        .unwrap();
        let blob = vec![0u8; 64 * 1024];
        for _ in 0..80 {
            conn.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
        }
        let after_batch1 = std::fs::metadata(wal_sidecar(&path)).unwrap().len();
        assert!(after_batch1 > 1024 * 1024, "o wal de teste ficou em {after_batch1} bytes");

        let db = Arc::new(Mutex::new(conn));
        let outcome = checkpoint_wal_passive_with(&db, &path, 1024 * 1024, || {})
            .expect("checkpoint PASSIVE deve rodar acima do teto");
        assert_eq!(outcome.busy, 0, "sem leitores ativos, PASSIVE não deve reportar busy");
        assert!(outcome.log_frames > 0, "deve haver frames no WAL");
        assert_eq!(
            outcome.checkpointed_frames, outcome.log_frames,
            "PASSIVE deve transferir todos os frames prontos ao banco principal"
        );

        // Um segundo lote igual deve reutilizar o início do WAL em vez de dobrar o arquivo.
        {
            let guard = db.lock().unwrap();
            for _ in 0..80 {
                guard.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
            }
        }
        let after_batch2 = std::fs::metadata(wal_sidecar(&path)).unwrap().len();
        assert!(
            after_batch2 <= after_batch1 + 256 * 1024,
            "WAL cresceu além do esperado após PASSIVE ({after_batch1} -> {after_batch2} bytes)"
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn passive_nao_bloqueia_com_leitor_ativo() {
        let dir = std::env::temp_dir().join(format!("ade-wal-reader-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE t(b BLOB);",
        )
        .unwrap();
        let blob = vec![0u8; 64 * 1024];
        for _ in 0..40 {
            conn.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
        }

        // Mantém uma transação leitora aberta enquanto novas escritas entram no WAL.
        let reader = Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN;").unwrap();
        let count_before: i64 = reader
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, 40);

        for _ in 0..40 {
            conn.execute("INSERT INTO t VALUES (?1)", [&blob]).unwrap();
        }

        let db = Arc::new(Mutex::new(conn));
        let started = std::time::Instant::now();
        let outcome = checkpoint_wal_passive_with(&db, &path, 1024 * 1024, || {})
            .expect("checkpoint PASSIVE deve retornar mesmo com leitor ativo");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(2),
            "PASSIVE não deve ficar bloqueado esperando leitor ativo (levou {elapsed:?})"
        );
        assert!(
            outcome.log_frames > 0 && outcome.checkpointed_frames > 0,
            "PASSIVE deve avançar os frames anteriores ao leitor ativo: {outcome:?}"
        );

        reader.execute_batch("COMMIT;").unwrap();
        drop(reader);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_guardado_de_ventana_no_copia_el_pty_con_el_mutex() {
        save_window_source_avoids_pty_copy();
    }

    #[test]
    fn el_hilo_espera_el_upgrade_antes_de_checkpointar() {
        let src = include_str!("wal.rs");
        let start = src.find("fn spawn_wal_maintenance").expect("función");
        let body = &src[start..];
        let wait_at = body.find("wait_until_db_ready").expect("espera");
        let check_at = body.find("checkpoint_wal").expect("checkpoint");
        assert!(wait_at < check_at, "el checkpoint no puede correr antes de que termine el upgrade");
    }
}
