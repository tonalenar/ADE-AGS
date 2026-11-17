//! User purge removes the revision from SQLite and from the artifacts ADE writes:
//! the local memory git repository, `revisions.json`, upgrade backups, and the
//! live database file (including freed pages).
//!
//! The git history is replaced by a single snapshot commit. That drops per-approval
//! history on purpose: SQLite stays authoritative, and a filter that left dangling
//! objects would keep the text recoverable. A remote, if one was configured despite
//! the export ban, is not updated and is not reattached.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

/// Where derived artifacts live. Absent in unit tests so they never touch `~/.ags`.
pub struct Scope {
    pub memory_root: PathBuf,
    pub database_file: Option<PathBuf>,
    /// NDJSON que o supervisor grava em `~/.ags/runs`. Fora daqui o purge não mexe:
    /// transcript de TUI fica no perfil do Claude/Codex, e fato/handoff é a fonte, não uma cópia.
    pub events_root: Option<PathBuf>,
}

struct Applied {
    workspace: String,
    entry_id: String,
    revisions: Vec<i64>,
    bodies: Vec<String>,
    restore_rows: Vec<RevisionRow>,
    entry_state: Option<EntryState>,
    event_paths: Vec<String>,
}

#[derive(Clone)]
struct RevisionRow {
    revision: i64,
    status: String,
    operation: String,
    kind: String,
    priority: i64,
    body: String,
    content_hash: String,
    actor_kind: String,
    source_run_id: Option<String>,
    source_task_id: Option<String>,
    source_fact_id: Option<String>,
    reason: Option<String>,
    expected_revision: Option<i64>,
    created_at: i64,
    decided_at: Option<i64>,
}

#[derive(Clone)]
struct EntryState {
    status: String,
    current_revision: Option<i64>,
    updated_at: i64,
}

pub fn main_database_file(conn: &Connection) -> Option<PathBuf> {
    conn.query_row("SELECT file FROM pragma_database_list WHERE name='main'", [], |row| row.get::<_, String>(0))
        .ok()
        .filter(|file| !file.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
pub fn revisions(conn: &Connection, entry_id: &str, revision: Option<i64>, scope: Option<&Scope>) -> Result<(), String> {
    let applied = apply_sqlite(conn, entry_id, revision, scope.and_then(|scope| scope.events_root.as_deref()))?;
    if applied.bodies.is_empty() && scope.is_none() {
        return Err("memory revision is unavailable".into());
    }
    finish_local(conn, &applied, scope)
}

/// Produção. Nada disto segura o mutex do banco durante I/O: o banco é lido e solto, o disco
/// gravação SQL é condicional sob lock; depois, o disco (NDJSON, repositório, backups) é tocado
/// sem ele, e o `VACUUM` roda numa conexão lateral. O git não corre com o mutex: a
/// pausa precisa que o worker termine o render, e `run_git` recusa a thread que ainda segura o
/// lock de exportação. `resume_workspace` roda no `Drop`, inclusive quando a pausa ou a
/// reescrita falha.
pub fn revisions_coordinated(
    db: &crate::database::DbConnection,
    sync: &super::repo_sync::RepoSync,
    entry_id: &str,
    revision: Option<i64>,
    scope: &Scope,
) -> Result<(), String> {
    revisions_coordinated_with(db, sync, entry_id, revision, scope, &|| {})
}

/// Como `revisions_coordinated`. `antes_do_io` roda em cada fase de I/O, com o mutex do banco
/// já solto: os testes usam para provar isso com `try_lock`.
pub(crate) fn revisions_coordinated_with(
    db: &crate::database::DbConnection,
    sync: &super::repo_sync::RepoSync,
    entry_id: &str,
    revision: Option<i64>,
    scope: &Scope,
    antes_do_io: &dyn Fn(),
) -> Result<(), String> {
    revisions_coordinated_impl(db, sync, entry_id, revision, scope, antes_do_io, &|_| Ok(()))
}

#[cfg(test)]
pub(crate) fn revisions_coordinated_failing_at(
    db: &crate::database::DbConnection,
    sync: &super::repo_sync::RepoSync,
    entry_id: &str,
    revision: Option<i64>,
    scope: &Scope,
    stage: &'static str,
) -> Result<(), String> {
    revisions_coordinated_impl(db, sync, entry_id, revision, scope, &|| {}, &|current| {
        if current == stage { Err(format!("falha de teste na etapa {stage}")) } else { Ok(()) }
    })
}

fn revisions_coordinated_impl(
    db: &crate::database::DbConnection,
    sync: &super::repo_sync::RepoSync,
    entry_id: &str,
    revision: Option<i64>,
    scope: &Scope,
    antes_do_io: &dyn Fn(),
    falha_no_io: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    let plan = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        plan_purge(&conn, entry_id, revision, scope.events_root.is_some())?
    };
    // A sonda fica entre o plano e o commit; se a memória mudar, o commit condicional recusa.
    // A confirmação final e a gravação SQL ocorrem juntas antes de qualquer arquivo ser tocado.
    {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        confirm_unchanged(&conn, &plan, revision)?;
    }
    antes_do_io();
    let applied = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        commit_purge(&conn, plan, revision)?
    };
    let _resume = PauseGuard { sync, workspace: applied.workspace.clone() };
    if let Err(error) = sync.pause_workspace(&applied.workspace) {
        restore_purge(db, &applied).map_err(|restore| format!("A exportação em andamento não pôde ser pausada ({error}) e a revisão não pôde ser restaurada ({restore})."))?;
        return Err(format!("A exportação em andamento não pôde ser pausada ({error}); a revisão foi restaurada no banco."));
    }
    if let Err(error) = scrub_event_paths(&applied.event_paths, scope.events_root.as_deref(), &applied.bodies) {
        // Mantém a regra anterior: se o NDJSON falhar, restaura a revisão para permitir nova tentativa.
        restore_purge(db, &applied).map_err(|restore| format!("A redação do NDJSON falhou ({error}) e a revisão não pôde ser restaurada ({restore})."))?;
        return Err(format!("A redação do NDJSON falhou; a revisão continua no banco para nova tentativa ({error})."));
    }
    sync.forget_discarded_pending(&applied.workspace);
    if let Err(error) = scrub_coordinated_with(db, scope, &applied, antes_do_io, falha_no_io) {
        return Err(match restore_purge(db, &applied) {
            Ok(()) => format!("A limpeza dos arquivos locais falhou ({error}); a revisão foi restaurada no banco. Os arquivos podem ter sido parcialmente limpos; repita o apagamento para concluir."),
            Err(restore) => format!("A limpeza dos arquivos locais falhou ({error}) e a revisão não pôde ser restaurada no banco ({restore}). O estado do apagamento pode estar parcial."),
        });
    }
    Ok(())
}

struct PauseGuard<'a> {
    sync: &'a super::repo_sync::RepoSync,
    workspace: String,
}

impl Drop for PauseGuard<'_> {
    fn drop(&mut self) {
        self.sync.resume_workspace(&self.workspace);
    }
}

/// O que o purge vai apagar, lido com o mutex tomado. Nada é apagado nessa fase.
struct Plan {
    workspace: String,
    entry_id: String,
    /// Revisões a apagar, com o corpo lido agora. Vazio quando a revisão já foi só auditada.
    rows: Vec<(i64, String)>,
    /// Linhas completas para desfazer o commit se a redação do NDJSON falhar.
    restore_rows: Vec<RevisionRow>,
    entry_state: Option<EntryState>,
    /// Ids das revisões só auditadas (sem linha a apagar).
    audited_ids: Vec<i64>,
    /// NDJSON das tasks do workspace que podem conter o texto. Redigidos sem o mutex.
    event_paths: Vec<String>,
}

impl Plan {
    fn bodies(&self) -> Vec<String> {
        self.rows.iter().map(|(_, body)| body.clone()).collect()
    }
}

fn plan_purge(conn: &Connection, entry_id: &str, revision: Option<i64>, with_events: bool) -> Result<Plan, String> {
    let workspace: Option<String> = conn
        .query_row("SELECT workspace_id FROM memory_entries WHERE id=?1", [entry_id], |row| row.get(0))
        .optional()
        .map_err(|_| "could not verify purge revision")?;
    let Some(workspace) = workspace else {
        return Err("memory revision is unavailable".into());
    };
    let rows = revision_bodies(conn, entry_id, revision)?;
    if rows.is_empty() {
        if !audited(conn, entry_id, revision)? {
            return Err("memory revision is unavailable".into());
        }
        let audited_ids = audited_revisions(conn, entry_id, revision)?;
        return Ok(Plan { workspace, entry_id: entry_id.to_string(), rows, restore_rows: Vec::new(), entry_state: None, audited_ids, event_paths: Vec::new() });
    }
    let restore_rows = revision_rows(conn, entry_id, revision)?;
    let entry_state = conn.query_row(
        "SELECT status,current_revision,updated_at FROM memory_entries WHERE id=?1",
        [entry_id],
        |row| Ok(EntryState { status: row.get(0)?, current_revision: row.get(1)?, updated_at: row.get(2)? }),
    ).map_err(|_| "could not verify purge revision")?;
    let bodies: Vec<String> = rows.iter().map(|(_, body)| body.clone()).collect();
    let event_paths = if with_events { event_log_paths(conn, &workspace, &bodies)? } else { Vec::new() };
    Ok(Plan { workspace, entry_id: entry_id.to_string(), rows, restore_rows, entry_state: Some(entry_state), audited_ids: Vec::new(), event_paths })
}

/// Confere que as revisões são as mesmas que foram lidas no plano. Se a memória mudou enquanto
/// o mutex estava solto, não apaga o que não foi lido nem o que não foi redigido.
fn confirm_unchanged(conn: &Connection, plan: &Plan, revision: Option<i64>) -> Result<(), String> {
    if plan.rows.is_empty() {
        return Ok(());
    }
    if revision_bodies(conn, &plan.entry_id, revision)? != plan.rows {
        return Err("A memória mudou durante o apagamento. Repita o apagamento para concluir.".into());
    }
    Ok(())
}

/// Grava o purge, depois de conferir com `confirm_unchanged`.
fn commit_purge(conn: &Connection, plan: Plan, revision: Option<i64>) -> Result<Applied, String> {
    if plan.rows.is_empty() {
        return Ok(Applied {
            workspace: plan.workspace,
            entry_id: plan.entry_id,
            revisions: plan.audited_ids,
            bodies: Vec::new(),
            restore_rows: Vec::new(),
            entry_state: None,
            event_paths: Vec::new(),
        });
    }
    let revisions: Vec<i64> = plan.rows.iter().map(|(id, _)| *id).collect();
    let bodies = plan.bodies();
    delete_revisions(conn, &plan, revision, &revisions, &bodies)?;
    Ok(Applied { workspace: plan.workspace, entry_id: plan.entry_id, revisions, bodies, restore_rows: plan.restore_rows, entry_state: plan.entry_state, event_paths: plan.event_paths })
}

/// Restaura a linha quando a redação do NDJSON falha após o commit SQL.
fn restore_purge(db: &crate::database::DbConnection, applied: &Applied) -> Result<(), String> {
    if applied.restore_rows.is_empty() { return Ok(()); }
    let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    for row in &applied.restore_rows {
        tx.execute(
            "INSERT OR IGNORE INTO memory_revisions (entry_id,revision,status,operation,kind,priority,body,content_hash,actor_kind,source_run_id,source_task_id,source_fact_id,reason,expected_revision,created_at,decided_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![applied.entry_id, row.revision, row.status, row.operation, row.kind, row.priority, row.body, row.content_hash, row.actor_kind, row.source_run_id, row.source_task_id, row.source_fact_id, row.reason, row.expected_revision, row.created_at, row.decided_at],
        ).map_err(|e| format!("could not restore memory revision: {e}"))?;
        tx.execute("DELETE FROM memory_purge_audit WHERE entry_id=?1 AND revision=?2", params![applied.entry_id, row.revision]).map_err(|e| e.to_string())?;
    }
    if let Some(state) = &applied.entry_state {
        // A memória pode ter recebido outra revisão enquanto o NDJSON era redigido. Só revive
        // o estado anterior se ele ainda estiver no estado deixado por este purge.
        tx.execute(
            "UPDATE memory_entries SET status=?2,current_revision=?3,updated_at=?4 WHERE id=?1 AND status='deleted' AND current_revision IS NULL",
            params![applied.entry_id, state.status, state.current_revision, state.updated_at],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Só para teste: plano, redação e commit numa conexão só, como a versão anterior.
#[cfg(test)]
fn apply_sqlite(conn: &Connection, entry_id: &str, revision: Option<i64>, events_root: Option<&Path>) -> Result<Applied, String> {
    let plan = plan_purge(conn, entry_id, revision, events_root.is_some())?;
    scrub_event_paths(&plan.event_paths, events_root, &plan.bodies())?;
    commit_purge(conn, plan, revision)
}

#[cfg(test)]
fn finish_local(conn: &Connection, applied: &Applied, scope: Option<&Scope>) -> Result<(), String> {
    if let Err(error) = reclaim_pages(conn) {
        return Err(format!("A memória foi removida do banco, mas a limpeza do arquivo do banco falhou ({error}). Repita o apagamento para concluir."));
    }
    if let Some(scope) = scope {
        if let Err(error) = scrub_artifacts(conn, &applied.workspace, &applied.entry_id, scope, &applied.revisions, &applied.bodies) {
            return Err(format!("A memória foi removida do banco, mas a limpeza dos arquivos locais falhou ({error}). Repita o apagamento para concluir."));
        }
    }
    Ok(())
}

/// Lista os NDJSON das tasks do workspace que podem conter o texto, lida com o mutex tomado.
fn event_log_paths(conn: &Connection, workspace: &str, bodies: &[String]) -> Result<Vec<String>, String> {
    let needles = super::repo::redaction_needles(bodies);
    if needles.is_empty() || !table_exists(conn, "tasks") || !column_exists(conn, "tasks", "events_path") {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT t.events_path FROM tasks t JOIN runs r ON r.id=t.run_id WHERE r.workspace_id=?1 AND t.events_path IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([workspace], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(paths)
}

/// Redige o texto apagado nos NDJSON listados. Roda sem o mutex do banco.
fn scrub_event_paths(paths: &[String], events_root: Option<&Path>, bodies: &[String]) -> Result<(), String> {
    let Some(root) = events_root else { return Ok(()) };
    let needles = super::repo::redaction_needles(bodies);
    if needles.is_empty() || paths.is_empty() {
        return Ok(());
    }
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    for path in paths {
        scrub_one_event_log(Path::new(path), &root, &needles)?;
    }
    Ok(())
}

/// Artefatos derivados: repositório git, `revisions.json`, `VACUUM` e backups. Nenhum deles
/// roda com o mutex do banco preso; o `VACUUM` vai numa conexão lateral.
fn scrub_coordinated_with(
    db: &crate::database::DbConnection,
    scope: &Scope,
    applied: &Applied,
    antes_do_io: &dyn Fn(),
    falha_no_io: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    let projection = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        super::repo::render(&conn, &applied.workspace, &[]).ok()
    };
    antes_do_io();
    falha_no_io("repositório")?;
    super::repo::rewrite_workspace_repos(&scope.memory_root, &applied.workspace, projection.as_ref(), &applied.bodies)?;
    let dirs = super::repo::workspace_repo_dirs(&scope.memory_root, &applied.workspace)?;
    for dir in &dirs {
        falha_no_io("arquivo de revisão")?;
        super::repo::with_repo_gate(dir, || {
            super::lifecycle::refresh_revision_archive_db(db, &applied.workspace, dir, antes_do_io)
        })?;
    }
    antes_do_io();
    let main_file = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        main_database_file(&conn)
    };
    // Em base em memória não há arquivo para compactar: só os testes chegam aqui sem arquivo.
    if let Some(file) = main_file {
        falha_no_io("banco")?;
        reclaim_pages_side(&file)?;
    }
    if let Some(database) = &scope.database_file {
        antes_do_io();
        for backup in upgrade_backups(database)? {
            falha_no_io("backup")?;
            rewrite_backup(&backup, &applied.workspace, &applied.entry_id, &applied.revisions)?;
        }
    }
    Ok(())
}

/// `VACUUM` e checkpoint do WAL numa conexão lateral do arquivo da base. O mutex compartilhado
/// não fica preso: só as escritas concorrentes esperam pelo lock do próprio SQLite.
fn reclaim_pages_side(database: &Path) -> Result<(), String> {
    let conn = crate::database::open_side_connection_at(database).map_err(|error| error.to_string())?;
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    conn.execute_batch("VACUUM").map_err(|error| error.to_string())
}

fn revision_bodies(conn: &Connection, entry_id: &str, revision: Option<i64>) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT revision,body FROM memory_revisions WHERE entry_id=?1 AND (?2 IS NULL OR revision=?2) ORDER BY revision")
        .map_err(|_| "could not verify purge revision")?;
    let rows = stmt
        .query_map(params![entry_id, revision], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "could not verify purge revision")?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "could not verify purge revision".into())
}

fn revision_rows(conn: &Connection, entry_id: &str, revision: Option<i64>) -> Result<Vec<RevisionRow>, String> {
    let mut stmt = conn.prepare("SELECT revision,status,operation,kind,priority,body,content_hash,actor_kind,source_run_id,source_task_id,source_fact_id,reason,expected_revision,created_at,decided_at FROM memory_revisions WHERE entry_id=?1 AND (?2 IS NULL OR revision=?2) ORDER BY revision").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![entry_id, revision], |row| Ok(RevisionRow {
        revision: row.get(0)?, status: row.get(1)?, operation: row.get(2)?, kind: row.get(3)?, priority: row.get(4)?, body: row.get(5)?,
        content_hash: row.get(6)?, actor_kind: row.get(7)?, source_run_id: row.get(8)?, source_task_id: row.get(9)?, source_fact_id: row.get(10)?,
        reason: row.get(11)?, expected_revision: row.get(12)?, created_at: row.get(13)?, decided_at: row.get(14)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

fn audited(conn: &Connection, entry_id: &str, revision: Option<i64>) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_purge_audit WHERE entry_id=?1 AND (?2 IS NULL OR revision=?2))",
        params![entry_id, revision],
        |row| row.get(0),
    )
    .map_err(|_| "could not verify purge revision".into())
}

fn audited_revisions(conn: &Connection, entry_id: &str, revision: Option<i64>) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT revision FROM memory_purge_audit WHERE entry_id=?1 AND (?2 IS NULL OR revision=?2) ORDER BY revision")
        .map_err(|_| "could not verify purge revision")?;
    let rows = stmt
        .query_map(params![entry_id, revision], |row| row.get(0))
        .map_err(|_| "could not verify purge revision")?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "could not verify purge revision".into())
}

fn delete_revisions(conn: &Connection, plan: &Plan, revision: Option<i64>, revisions: &[i64], bodies: &[String]) -> Result<(), String> {
    let _ = conn.pragma_update(None, "secure_delete", "ON");
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|_| "could not begin purge")?;
    // A condição e as deleções ficam na mesma transação imediata: nenhum escritor pode mudar a
    // revisão entre a conferência e o commit SQL.
    confirm_unchanged(&tx, plan, revision)?;
    scrub_sqlite_copies(&tx, &plan.workspace, bodies)?;
    for revision in revisions {
        tx.execute("INSERT INTO memory_purge_guard(entry_id,revision) VALUES(?1,?2)", params![plan.entry_id, revision]).map_err(|_| "could not authorize purge")?;
        tx.execute(
            "INSERT INTO memory_purge_audit(entry_id,revision,actor_kind,created_at) VALUES(?1,?2,'user',?3)",
            params![plan.entry_id, revision, super::now()],
        )
        .map_err(|_| "could not audit purge")?;
        tx.execute("DELETE FROM run_memory_snapshot WHERE entry_id=?1 AND revision=?2", params![plan.entry_id, revision]).map_err(|_| "could not purge snapshot copies")?;
        if table_exists(&tx, "memory_secret_overrides") {
            tx.execute("DELETE FROM memory_secret_overrides WHERE entry_id=?1 AND revision=?2", params![plan.entry_id, revision]).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE memory_entries SET current_revision=NULL,status='deleted',updated_at=?3 WHERE id=?1 AND current_revision=?2",
            params![plan.entry_id, revision, super::now()],
        )
        .map_err(|_| "could not clear purged memory")?;
        tx.execute("DELETE FROM memory_revisions WHERE entry_id=?1 AND revision=?2", params![plan.entry_id, revision]).map_err(|_| "could not purge memory")?;
        tx.execute("DELETE FROM memory_purge_guard WHERE entry_id=?1 AND revision=?2", params![plan.entry_id, revision]).map_err(|_| "could not close purge authorization")?;
    }
    tx.commit().map_err(|_| "could not finish purge".into())
}

#[cfg(test)]
fn reclaim_pages(conn: &Connection) -> Result<(), String> {
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    conn.execute_batch("VACUUM").map_err(|error| error.to_string())
}

#[cfg(test)]
fn scrub_artifacts(conn: &Connection, workspace: &str, entry_id: &str, scope: &Scope, revisions: &[i64], bodies: &[String]) -> Result<(), String> {
    super::repo::replace_local_history(conn, workspace, &scope.memory_root, bodies)?;
    for dir in super::repo::workspace_repo_dirs(&scope.memory_root, workspace)? {
        if dir.join("revisions.json").is_symlink() {
            return Err("export cannot follow a symlink".into());
        }
        super::lifecycle::refresh_revision_archive(conn, workspace, &dir)?;
    }
    if let Some(database) = &scope.database_file {
        for backup in upgrade_backups(database)? {
            rewrite_backup(&backup, workspace, entry_id, revisions)?;
        }
    }
    Ok(())
}

/// Matches `backup_before_upgrade`: `{stem}.v{version}-{uuid}.backup` beside the database.
fn upgrade_backups(database: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = database.parent().ok_or("database path has no directory")?;
    let stem = database.file_stem().and_then(|value| value.to_str()).ok_or("database name is unavailable")?;
    let mut found = Vec::new();
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_upgrade_backup(stem, &name) {
            continue;
        }
        let path = entry.path();
        if path.is_symlink() {
            return Err("memory backup cannot be a symlink".into());
        }
        if path.is_file() {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

fn is_upgrade_backup(stem: &str, name: &str) -> bool {
    let Some(rest) = name.strip_prefix(&format!("{stem}.v")) else { return false };
    let Some((version, id)) = rest.split_once('-') else { return false };
    let Some(id) = id.strip_suffix(".backup") else { return false };
    !version.is_empty()
        && version.chars().all(|c| c.is_ascii_digit())
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn rewrite_backup(path: &Path, workspace: &str, entry_id: &str, revisions: &[i64]) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|error| format!("could not open memory backup: {error}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
    let _ = conn.pragma_update(None, "secure_delete", "ON");
    if !table_exists(&conn, "memory_revisions") {
        return Ok(());
    }
    {
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        if !table_exists(&tx, "memory_purge_guard") {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS memory_purge_guard (
                    entry_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(entry_id,revision)
                );",
            )
            .map_err(|e| e.to_string())?;
        }
        let has_snapshot = table_exists(&tx, "run_memory_snapshot");
        let has_entries = table_exists(&tx, "memory_entries");
        let stored = stored_bodies(&tx, entry_id, revisions)?;
        let bodies = if stored.is_empty() { Vec::new() } else { stored };
        scrub_sqlite_copies(&tx, workspace, &bodies)?;
        for revision in revisions {
            tx.execute("INSERT OR IGNORE INTO memory_purge_guard(entry_id,revision) VALUES(?1,?2)", params![entry_id, revision]).map_err(|e| e.to_string())?;
            if has_snapshot {
                tx.execute("DELETE FROM run_memory_snapshot WHERE entry_id=?1 AND revision=?2", params![entry_id, revision])
                    .map_err(|e| format!("could not purge backup snapshot: {e}"))?;
            }
            if has_entries {
                let _ = tx.execute(
                    "UPDATE memory_entries SET current_revision=NULL,status='deleted',updated_at=?3 WHERE id=?1 AND current_revision=?2",
                    params![entry_id, revision, super::now()],
                );
            }
            if table_exists(&tx, "memory_secret_overrides") {
                tx.execute("DELETE FROM memory_secret_overrides WHERE entry_id=?1 AND revision=?2", params![entry_id, revision]).map_err(|e| e.to_string())?;
            }
            tx.execute("DELETE FROM memory_revisions WHERE entry_id=?1 AND revision=?2", params![entry_id, revision])
                .map_err(|e| format!("could not purge backup revision: {e}"))?;
            tx.execute("DELETE FROM memory_purge_guard WHERE entry_id=?1 AND revision=?2", params![entry_id, revision]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("backup.scrub");
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()]).map_err(|e| format!("could not rewrite memory backup: {e}"))?;
    drop(conn);
    std::fs::copy(&tmp, path).map_err(|e| format!("could not replace memory backup: {e}"))?;
    std::fs::remove_file(&tmp).map_err(|e| format!("could not remove temporary backup: {e}"))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.is_symlink() {
            return Err("memory backup cannot be a symlink".into());
        }
        if sidecar.is_file() {
            std::fs::remove_file(&sidecar).map_err(|e| format!("could not remove backup sidecar: {e}"))?;
        }
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        params![table, column],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

fn stored_bodies(conn: &Connection, entry_id: &str, revisions: &[i64]) -> Result<Vec<String>, String> {
    let mut bodies = Vec::new();
    for revision in revisions {
        let body: Option<String> = conn
            .query_row("SELECT body FROM memory_revisions WHERE entry_id=?1 AND revision=?2", params![entry_id, revision], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(body) = body {
            bodies.push(body);
        }
    }
    Ok(bodies)
}

fn scrub_sqlite_copies(conn: &Connection, workspace: &str, bodies: &[String]) -> Result<(), String> {
    let needles = super::repo::redaction_needles(bodies);
    if needles.is_empty() {
        return Ok(());
    }
    if table_exists(conn, "tasks") && table_exists(conn, "runs") {
        let dreamer = if column_exists(conn, "tasks", "functional_role") {
            "(t.role='dreamer' OR t.functional_role='dreamer')"
        } else {
            "t.role='dreamer'"
        };
        let mut stmt = conn
            .prepare(&format!("SELECT t.id, t.prompt FROM tasks t JOIN runs r ON r.id=t.run_id WHERE r.workspace_id=?1 AND {dreamer}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for (id, prompt) in rows {
            let redacted = super::repo::redact_text(&prompt, &needles);
            if redacted != prompt {
                conn.execute("UPDATE tasks SET prompt=?2 WHERE id=?1", params![id, redacted]).map_err(|e| e.to_string())?;
            }
        }
    }
    if table_exists(conn, "memory_agent_drafts") {
        let mut stmt = conn
            .prepare("SELECT id, input_json FROM memory_agent_drafts WHERE workspace_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for (id, input) in rows {
            let redacted = super::repo::redact_text(&input, &needles);
            if redacted != input {
                conn.execute("UPDATE memory_agent_drafts SET input_json=?2 WHERE id=?1", params![id, redacted]).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn scrub_one_event_log(path: &Path, root: &Path, needles: &[String]) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(()) };
    if meta.file_type().is_symlink() {
        return Err("memory event log cannot be a symlink".into());
    }
    let Ok(canonical) = std::fs::canonicalize(path) else { return Ok(()) };
    if !canonical.starts_with(root) {
        return Ok(());
    }
    let Ok(text) = std::fs::read_to_string(&canonical) else { return Ok(()) };
    let redacted = super::repo::redact_text(&text, needles);
    if redacted != text {
        std::fs::write(&canonical, redacted).map_err(|e| e.to_string())?;
    }
    Ok(())
}
