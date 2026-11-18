//! Apertura de la base y el handle compartido que usa el resto de la app.
//!
//! Acá NO hay consultas: solo dónde vive el archivo, cómo se abre y en qué orden se deja
//! listo (migrar → sembrar → limpiar). El SQL vive en `queries`, el schema en `schema`.

use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `false` mientras un upgrade de schema (copia + migración) no terminó. Las escrituras
/// de `settings` esperan esta bandera para no colarse en medio del `VACUUM INTO`.
static DB_READY: AtomicBool = AtomicBool::new(true);

pub fn mark_db_upgrading() {
    DB_READY.store(false, Ordering::SeqCst);
}

pub fn mark_db_ready() {
    DB_READY.store(true, Ordering::SeqCst);
}

pub fn db_is_ready() -> bool {
    DB_READY.load(Ordering::SeqCst)
}

pub fn db_upgrade_pending() -> bool {
    !db_is_ready()
}

/// Bloquea hasta que la base está en el schema de esta build. El splash es quien
/// impide que la UI dispare escrituras; esto cubre las que igual salen (el idioma).
pub fn wait_until_db_ready() {
    while !db_is_ready() {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbBootStatus {
    pub phase: &'static str,
}

#[tauri::command]
pub fn db_boot_status() -> DbBootStatus {
    DbBootStatus {
        phase: if db_is_ready() { "ready" } else { "upgrading" },
    }
}

/// La conexión es única y compartida por toda la app: SQLite en modo por defecto no
/// admite escrituras concurrentes, así que el `Mutex` es el que serializa el acceso.
pub type DbConnection = Arc<Mutex<Connection>>;

/// Roda `work` com a conexão travada numa thread de bloqueio, fora do runtime async.
pub(crate) async fn blocking_db<T, F>(db: &DbConnection, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
{
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|error| error.to_string())?;
        work(&conn)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Falha de boot que o app mostra ao usuário antes de sair (ver `app::fatal`). O texto é PT-BR
/// porque é o que aparece na caixa de aviso.
#[derive(Debug)]
pub enum BootError {
    /// Sem a pasta do usuário e sem `ADE_AGS_DATA_DIR`: não há onde guardar a base.
    SemDiretorioDeDados,
    /// A pasta de dados existe no plano, mas o sistema não deixou criá-la.
    DiretorioNaoCriado { caminho: PathBuf, motivo: String },
    /// O SQLite falhou ao abrir, migrar ou semear.
    Banco(rusqlite::Error),
}

impl std::fmt::Display for BootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SemDiretorioDeDados => write!(
                f,
                "Não foi possível descobrir a pasta de dados do ADE AGS: a pasta do usuário não está disponível. \
                 Defina ADE_AGS_DATA_DIR ou verifique o perfil do usuário."
            ),
            Self::DiretorioNaoCriado { caminho, motivo } => {
                write!(f, "Não foi possível criar a pasta de dados {}: {motivo}", caminho.display())
            }
            Self::Banco(erro) => write!(f, "Erro no banco de dados: {erro}"),
        }
    }
}

impl From<rusqlite::Error> for BootError {
    fn from(erro: rusqlite::Error) -> Self {
        Self::Banco(erro)
    }
}

/// Caminho da base para a manutenção em segundo plano. `None` só se a pasta de dados sumiu depois do boot.
pub(crate) fn user_db_path() -> Option<PathBuf> {
    db_path().ok()
}

/// Pasta e arquivo da base. Sem pasta de dados, devolve erro tipado em vez de dar pânico.
fn db_path() -> Result<PathBuf, BootError> {
    db_path_in(crate::util::datadir::ags_home())
}

/// A pasta de dados chega de fora, então o erro se testa sem tocar em `~/.ags`. Cria a pasta se preciso.
fn db_path_in(dir: Option<PathBuf>) -> Result<PathBuf, BootError> {
    let dir = dir.ok_or(BootError::SemDiretorioDeDados)?;
    std::fs::create_dir_all(&dir).map_err(|erro| BootError::DiretorioNaoCriado {
        caminho: dir.clone(),
        motivo: erro.to_string(),
    })?;
    Ok(dir.join("data.db"))
}

/// Uma conexão própria à mesma base, para o trabalho que mistura banco com git ou disco (limpeza
/// de worktrees: `git status`/`log`/`worktree remove` e a medição de GBs de `target/`). Com a
/// conexão global (`DbConnection`) o `Mutex` ficava preso durante tudo isso e o resto do app
/// (autosave, IPC, Vigia) parava. Em WAL as duas convivem; `busy_timeout` cobre as escritas.
pub(crate) fn open_side_connection() -> Result<Connection, BootError> {
    open_side_connection_at(&db_path()?).map_err(BootError::from)
}

/// Como `open_side_connection`, para um arquivo de base dado. Os testes usam uma base temporária.
pub(crate) fn open_side_connection_at(path: &std::path::Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 30000;",
    )?;
    Ok(conn)
}

/// Abre el archivo y deja WAL y las claves foráneas. No migra.
fn open_configured() -> Result<DbConnection, BootError> {
    let path = db_path()?;
    let conn = Connection::open(&path)?;

    // SQLite trae el enforcement de FK apagado por defecto en cada conexión — sin esto,
    // todos los `ON DELETE CASCADE` del schema (workspaces→windows→tabs→project_skills,
    // skills→project_skills, workspaces→session_history) son un no-op silencioso: borrar
    // un workspace/ventana/skill deja filas huérfanas en las tablas hijas para siempre
    // en vez de limpiarlas.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // WAL: un commit escribe al final del log en vez de reescribir páginas con doble fsync,
    // que es lo que hacía que guardar las tabs o el progreso de la flota se notara.
    // `synchronous=NORMAL` es lo seguro en WAL (un corte de luz pierde a lo sumo la última
    // transacción, nunca corrompe), y `busy_timeout` espera en vez de fallar con
    // SQLITE_BUSY si otro proceso (la CLI, un `sqlite3` abierto) tiene la base un momento.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;

    Ok(Arc::new(Mutex::new(conn)))
}

/// `true` quando a base é de uma versão anterior e precisa migrar. Uma base de versão
/// MAIOR que a desta build é erro (ver [`super::schema::refuse_newer`]), nunca "pronta".
fn needs_upgrade(conn: &DbConnection) -> SqlResult<bool> {
    let guard = conn.lock().unwrap_or_else(|err| err.into_inner());
    let version: i32 = guard.pragma_query_value(None, "user_version", |row| row.get(0))?;
    super::schema::refuse_newer(version)?;
    Ok(version > 0 && version < super::schema::SCHEMA_VERSION)
}

/// Abre la base. Si ya está en el schema de esta build (o es nueva: no hay `VACUUM`),
/// la deja lista acá. Si hay que subir de versión, no copia ni migra: la ventana tiene
/// que poder pintarse con el aviso de "actualizando datos" antes de ese trabajo.
pub fn prepare_db() -> Result<(DbConnection, bool), BootError> {
    let conn = open_configured()?;
    let pending = needs_upgrade(&conn)?;
    if pending {
        mark_db_upgrading();
    } else {
        finish_db(&conn)?;
        mark_db_ready();
    }
    Ok((conn, pending))
}

/// Abre (o crea) la base del usuario y la deja lista para usar.
///
/// El arranque usa [`prepare_db`]: si hay que subir el schema, la copia y la migración
/// no corren acá. Esta queda para quien necesita el camino completo en el mismo hilo.
#[allow(dead_code)]
pub fn init_db() -> Result<DbConnection, BootError> {
    let conn = open_configured()?;
    finish_db(&conn)?;
    Ok(conn)
}

/// Copia consistente y migración, en ese orden, más la siembra y la limpieza.
///
/// Quien llama sostiene que nadie más está escribiendo un schema viejo: o esto corre
/// antes de que exista la ventana, o la UI está en el splash y las escrituras esperan
/// [`wait_until_db_ready`].
pub fn finish_db(conn: &DbConnection) -> Result<(), BootError> {
    let path = db_path()?;
    let guard = conn.lock().unwrap_or_else(|err| err.into_inner());
    upgrade_schema(&guard, &path)
}

pub(crate) fn upgrade_schema(conn: &Connection, path: &std::path::Path) -> Result<(), BootError> {
    backup_before_upgrade(conn, path)?;
    super::schema::migrate(conn)?;
    // A reconciliação de boot (chat, efeitos e Frota) roda em `app::housekeeping`, já com o
    // lease SQLite do harness. Assim duas instâncias que abrem o mesmo arquivo não fazem o sweep
    // simultaneamente durante a etapa de migração.
    super::seeds::seed_defaults(conn)?;
    super::queries::dedupe_session_history_once(conn)?;

    // Las ventanas cerradas que no guardan tabs no representan nada y se acumulan: una por
    // cierre, y una por intento cuando un arranque falla en bucle.
    let purgadas = super::queries::purge_empty_closed_windows(conn)?;
    if purgadas > 0 {
        eprintln!("se limpiaron {purgadas} filas de ventanas cerradas y vacías");
    }
    if crate::util::datadir::is_isolated() {
        seed_decisions_from_installed(conn);
    }
    Ok(())
}

/// Instancia isolada (ADE_AGS_DATA_DIR): traz só a configuração NÃO secreta do Jev (`decisions.*`:
/// provedor, URL, modelo, pontos ligados) do banco do app instalado, lido em modo somente leitura e
/// só quando a base isolada ainda não tem nenhuma. A chave de API não é copiada: vive no cofre do
/// sistema (serviço `ade-ags.decisions`), que as duas instâncias já enxergam. Contas de agentes
/// ficam de fora de propósito.
fn seed_decisions_from_installed(conn: &Connection) {
    let Some(real) = dirs::home_dir().map(|h| h.join(".ags").join("data.db")) else { return };
    let have: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings WHERE key LIKE 'decisions.%'", [], |r| r.get(0))
        .unwrap_or(1);
    if have > 0 || !real.is_file() {
        return;
    }
    let Ok(src) = Connection::open_with_flags(&real, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return };
    let Ok(mut stmt) = src.prepare("SELECT key, value FROM settings WHERE key LIKE 'decisions.%'") else { return };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) else { return };
    for (k, v) in rows.flatten() {
        let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)", [k, v]);
    }
}

/// SQLite produces a consistent backup, including committed WAL pages. A failed
/// backup aborts startup before migrations; copying the main file alone is unsafe.
fn backup_before_upgrade(conn: &Connection, path: &std::path::Path) -> SqlResult<()> {
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 0 && version < super::schema::SCHEMA_VERSION {
        let backup = path.with_extension(format!("v{version}-{}.backup", uuid::Uuid::new_v4()));
        conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])?;
    }
    Ok(())
}

/// Erros de boot que o app mostra antes de sair (ver `app::fatal`). Testes puros: não abrem a
/// base do usuário nem `~/.ags`.
#[cfg(test)]
mod boot_tests {
    use super::*;

    /// Sem home e sem `ADE_AGS_DATA_DIR`, não há onde guardar a base. O boot devolve o erro
    /// tipado: antes era `expect`, que fechava o app sem nenhuma mensagem.
    #[test]
    fn boot_sem_data_dir_devolve_erro_tipado() {
        // `catch_unwind` separa o caso: a versão com `expect` entra em pânico, e a falha aparece como
        // "devolve Err" na asserção, não como abort do teste.
        let resultado = std::panic::catch_unwind(|| db_path_in(None));
        let err = match resultado {
            Ok(Err(err)) => err,
            Ok(Ok(caminho)) => panic!("sem pasta de dados não há base, e veio {caminho:?}"),
            Err(_) => panic!("boot entrou em pânico em vez de devolver Err"),
        };
        assert!(matches!(err, BootError::SemDiretorioDeDados), "{err:?}");
        assert!(err.to_string().contains("pasta de dados"), "{err}");
    }

    /// Um arquivo ocupa o lugar do pai da pasta: não dá para criá-la. Erro tipado, com o caminho.
    #[test]
    fn boot_com_diretorio_impossivel_devolve_erro_tipado() {
        let root = std::env::temp_dir().join(format!("ade-boot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ocupado = root.join("arquivo");
        std::fs::write(&ocupado, b"nao e pasta").unwrap();
        let destino = ocupado.join("ags");
        let err = db_path_in(Some(destino.clone())).expect_err("o pai é um arquivo");
        match &err {
            BootError::DiretorioNaoCriado { caminho, .. } => assert_eq!(caminho, &destino),
            outro => panic!("erro inesperado: {outro:?}"),
        }
        assert!(err.to_string().contains("Não foi possível criar"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Caminho feliz: cria a pasta e devolve o `data.db` dentro dela.
    #[test]
    fn com_diretorio_valido_o_banco_fica_dentro_dele() {
        let root = std::env::temp_dir().join(format!("ade-boot-ok-{}", uuid::Uuid::new_v4()));
        let dir = root.join("ags");
        assert_eq!(db_path_in(Some(dir.clone())).unwrap(), dir.join("data.db"));
        assert!(dir.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[test]
    fn upgrading_copies_committed_wal_data_before_schema_changes() {
        let root = std::env::temp_dir().join(format!("ade-db-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("isolated.sqlite");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE preserved(body TEXT);INSERT INTO preserved VALUES('keep');PRAGMA user_version=40;").unwrap();
        backup_before_upgrade(&c, &path).unwrap();
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|ext| ext == "backup"))
            .unwrap();
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(
            copy.query_row("SELECT body FROM preserved", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            copy.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
                .unwrap(),
            40
        );
        c.pragma_update(None, "user_version", super::super::schema::SCHEMA_VERSION)
            .unwrap();
        backup_before_upgrade(&c, &path).unwrap();
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|e| e == "backup"))
                .count(),
            1
        );
        drop(copy);
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn una_base_v40_llega_a_41_y_el_backup_existe() {
        let root = std::env::temp_dir().join(format!("ade-db-v40-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("data.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .unwrap();
        super::super::schema::migrate(&conn).unwrap();
        assert_eq!(user_version(&conn), super::super::schema::SCHEMA_VERSION);

        // El schema de esta build ya está aplicado. Se simula una base que se quedó en
        // v40: sin la columna que v41 agrega, y con `user_version` atrás.
        conn.execute("ALTER TABLE workspaces DROP COLUMN deleted_at", [])
            .unwrap();
        conn.pragma_update(None, "user_version", 40).unwrap();
        assert!(
            conn.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_err()
        );

        upgrade_schema(&conn, &path).unwrap();

        assert_eq!(user_version(&conn), 45);
        assert!(
            conn.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_ok()
        );
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|candidate| candidate.extension().is_some_and(|ext| ext == "backup"))
            .expect("el upgrade deja una copia");
        let copy = Connection::open(&backup).unwrap();
        assert_eq!(user_version(&copy), 40, "la copia es la de antes de migrar");
        assert!(
            copy.prepare("SELECT deleted_at FROM workspaces LIMIT 0")
                .is_err(),
            "la copia no incluye el schema nuevo"
        );
        drop(copy);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn base_mais_nova_que_o_binario_e_recusada_sem_regravar_a_versao() {
        let root = std::env::temp_dir().join(format!("ade-db-newer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("data.db");
        let conn = Connection::open(&path).unwrap();
        super::super::schema::migrate(&conn).unwrap();
        let newer = super::super::schema::SCHEMA_VERSION + 1;
        conn.pragma_update(None, "user_version", newer).unwrap();

        let err = upgrade_schema(&conn, &path).expect_err("uma base mais nova não abre");
        let msg = err.to_string();
        assert!(msg.contains("versão mais nova do ADE AGS"), "{msg}");
        assert!(msg.contains(&format!("(v{newer})")), "{msg}");
        assert!(msg.contains("atualize o app") || msg.contains("Atualize o app"), "{msg}");
        assert_eq!(user_version(&conn), newer, "a versão não pode ser rebaixada");
        assert!(
            std::fs::read_dir(&root)
                .unwrap()
                .all(|e| e.unwrap().path().extension().is_none_or(|ext| ext != "backup")),
            "nem copia: não há upgrade"
        );

        let shared: DbConnection = Arc::new(Mutex::new(conn));
        let err = needs_upgrade(&shared).expect_err("prepare_db também recusa");
        assert!(err.to_string().contains(&format!("(v{newer})")));
        let guard = shared.lock().unwrap();
        assert_eq!(user_version(&guard), newer);
        drop(guard);
        drop(shared);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn base_da_mesma_versao_ou_anterior_nao_e_recusada() {
        use super::super::schema::{refuse_newer, SCHEMA_VERSION};
        assert!(refuse_newer(0).is_ok());
        assert!(refuse_newer(SCHEMA_VERSION - 1).is_ok());
        assert!(refuse_newer(SCHEMA_VERSION).is_ok());
        assert!(refuse_newer(SCHEMA_VERSION + 1).is_err());
    }

    fn user_version(conn: &Connection) -> i32 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }
}
