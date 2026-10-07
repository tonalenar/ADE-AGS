//! Explicit user lifecycle actions; never reachable from Fleet write tools.
use super::{ProposalActor, ProposalInput, ProposalResult};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

pub fn stats(conn: &Connection, workspace: &str) -> Result<Value, String> {
    let mut result=conn.query_row("SELECT (SELECT COUNT(*) FROM memory_entries WHERE workspace_id=w.id),(SELECT COUNT(*) FROM memory_revisions r JOIN memory_entries e ON e.id=r.entry_id WHERE e.workspace_id=w.id),w.deleted_at,w.delete_after FROM workspaces w WHERE w.id=?1",[workspace],|r|Ok(json!({"entries":r.get::<_,i64>(0)?,"revisions":r.get::<_,i64>(1)?,"deletedAt":r.get::<_,Option<i64>>(2)?,"deleteAfter":r.get::<_,Option<i64>>(3)?}))).map_err(|e|e.to_string())?;
    let usage=conn.query_row("SELECT COUNT(*),COUNT(DISTINCT s.entry_id),COUNT(DISTINCT s.run_id) FROM run_memory_snapshot s JOIN memory_entries e ON e.id=s.entry_id WHERE e.workspace_id=?1",[workspace],|r|Ok(json!({"timesUsed":r.get::<_,i64>(0)?,"entriesUsed":r.get::<_,i64>(1)?,"runsUsingMemory":r.get::<_,i64>(2)?,"method":"selected_in_run_snapshot"}))).map_err(|e|e.to_string())?;
    result["memoryUsage"]=usage;
    Ok(result)
}

/// Session data becomes only a proposal; approval remains a user action.
pub fn swarm_promote(conn:&Connection,workspace:&str,mission:&str,id:&str,key:&str)->Result<ProposalResult,String>{
    let body:String=conn.query_row("SELECT body FROM memory_swarm_notes WHERE id=?1 AND workspace_id=?2 AND mission_id=?3",params![id,workspace,mission],|r|r.get(0)).map_err(|_|"swarm note unavailable")?;
    super::propose(conn,"mission",workspace,Some(mission),&ProposalInput{scope:"mission".into(),key:key.into(),kind:"note".into(),body,priority:0,operation:"create".into(),expected_revision:None,source_fact_id:None,reason:Some(format!("Swarm note {id}")),acknowledge_secret:false},ProposalActor{kind:"worker",run_id:None,task_id:None,fact_id:None})
}

struct ArchivePrep {
    stats: Value,
    body: Value,
}

/// Corpos aprovados entram no arquivo. Rejeitadas e pendentes ficam só com metadados e
/// `content_hash`. O snapshot é lido na hora da escrita, nunca de um prepare anterior ao git:
/// um purge no meio não pode regravar o texto que acabou de sair.
fn prepare_archive(conn: &Connection, workspace: &str) -> Result<ArchivePrep, String> {
    let mut stmt = conn
        .prepare("SELECT id,mission_id FROM memory_entries WHERE workspace_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([workspace], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let details = ids
        .iter()
        .map(|(id, mission)| super::detail_for_owner(conn, id, workspace, mission.as_deref()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut archive = conn.prepare("SELECT metadata_json,content_hash,compacted_at FROM memory_compacted_revisions c JOIN memory_entries e ON e.id=c.entry_id WHERE e.workspace_id=?1 ORDER BY c.entry_id,c.revision").map_err(|e| e.to_string())?;
    let archived = archive.query_map([workspace], |r| Ok(json!({"metadata":r.get::<_,String>(0)?,"contentHash":r.get::<_,String>(1)?,"compactedAt":r.get::<_,i64>(2)?}))).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    let entries = details.iter().map(archive_detail).collect::<Result<Vec<_>, _>>()?;
    Ok(ArchivePrep { stats: stats(conn, workspace)?, body: json!({"entries": entries, "compactedRevisions": archived}) })
}

fn archive_detail(detail: &super::MemoryDetail) -> Result<Value, String> {
    let mut entry = detail.entry.clone();
    entry.pending_body = None;
    let revisions = detail
        .revisions
        .iter()
        .map(|revision| {
            let mut value = serde_json::to_value(revision).map_err(|e| e.to_string())?;
            if revision.status != "approved" {
                if let Some(object) = value.as_object_mut() {
                    object.remove("body");
                }
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({"entry": entry, "revisions": revisions}))
}

fn write_archive(repo_path: &std::path::Path, body: &Value) -> Result<(), String> {
    let path = repo_path.join("revisions.json");
    if path.is_symlink() {
        return Err("export cannot follow a symlink".into());
    }
    std::fs::write(&path, serde_json::to_vec_pretty(body).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Atalho de teste. Produção (`memory_export`, `ags memory export`) usa [`export_detached`],
/// que solta o mutex antes do git.
#[cfg(test)]
pub fn export(conn: &Connection, workspace: &str, root: &std::path::Path) -> Result<Value, String> {
    let projection = super::repo::export_at(conn, workspace, root, None)?;
    let prepared = prepare_archive(conn, workspace)?;
    write_archive(std::path::Path::new(&projection.path), &prepared.body)?;
    let mut result = prepared.stats;
    result["path"] = json!(projection.path);
    Ok(result)
}

/// Pede o git ao worker e só então relê o arquivo. O `revisions.json` sai com o banco
/// de depois do export, sob o mesmo gate do repositório que o purge segura na reescrita.
pub fn export_detached(db: &crate::database::DbConnection, sync: &super::repo_sync::RepoSync, workspace: &str) -> Result<Value, String> {
    let projection = sync.export_now(workspace)?;
    let path = std::path::PathBuf::from(&projection.path);
    let prepared: Result<ArchivePrep, String> = super::repo::with_repo_gate(&path, || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let prepared = prepare_archive(&conn, workspace)?;
        drop(conn);
        write_archive(&path, &prepared.body)?;
        Ok(prepared)
    });
    let prepared = prepared?;
    let mut result = prepared.stats;
    result["path"] = json!(projection.path);
    Ok(result)
}

/// Rewrites an archive that already exists. Purge does not create one that the user never exported.
pub(crate) fn refresh_revision_archive(conn: &Connection, workspace: &str, dir: &std::path::Path) -> Result<(), String> {
    if !dir.join("revisions.json").exists() {
        return Ok(());
    }
    let prepared = prepare_archive(conn, workspace)?;
    write_archive(dir, &prepared.body)
}

/// Rejected bodies only. Approved revisions, tombstones and provenance never disappear.
pub fn compact(conn: &Connection, days: i64) -> Result<usize, String> {
    compact_workspace(conn, days, None)
}

pub fn compact_workspace(conn: &Connection, days: i64, workspace: Option<&str>) -> Result<usize, String> {
    if days < 30 {
        return Err("minimum retention is 30 days".into());
    }
    let cutoff = super::now().saturating_sub(days.saturating_mul(86400));
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut stmt=tx.prepare("SELECT r.entry_id,r.revision FROM memory_revisions r JOIN memory_entries e ON e.id=r.entry_id WHERE r.status='rejected' AND r.decided_at<?1 AND (?2 IS NULL OR e.workspace_id=?2)").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![cutoff,workspace], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (entry, revision) in &rows {
        tx.execute("INSERT INTO memory_compacted_revisions(entry_id,revision,content_hash,metadata_json,compacted_at) SELECT entry_id,revision,content_hash,json_object('entryId',entry_id,'revision',revision,'status',status,'operation',operation,'kind',kind,'priority',priority,'actorKind',actor_kind,'sourceRunId',source_run_id,'sourceTaskId',source_task_id,'sourceFactId',source_fact_id,'reason',reason,'expectedRevision',expected_revision,'createdAt',created_at,'decidedAt',decided_at),?3 FROM memory_revisions WHERE entry_id=?1 AND revision=?2 AND status='rejected'",params![entry,revision,super::now()]).map_err(|e|e.to_string())?;
        tx.execute(
            "INSERT INTO memory_purge_guard(entry_id,revision) VALUES(?1,?2)",
            params![entry, revision],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_revisions WHERE entry_id=?1 AND revision=?2 AND status='rejected'",
            params![entry, revision],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_purge_guard WHERE entry_id=?1 AND revision=?2",
            params![entry, revision],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows.len())
}

pub fn drafts(conn: &Connection, workspace: &str) -> Result<Vec<Value>, String> {
    let mut stmt=conn.prepare("SELECT id,scope,mission_id,input_json,actor_kind,created_at FROM memory_agent_drafts WHERE workspace_id=?1 ORDER BY created_at,id LIMIT 256").map_err(|e|e.to_string())?;
    stmt.query_map([workspace],|r|Ok(json!({"id":r.get::<_,String>(0)?,"scope":r.get::<_,String>(1)?,"missionId":r.get::<_,Option<String>>(2)?,"proposal":r.get::<_,String>(3)?,"actorKind":r.get::<_,String>(4)?,"createdAt":r.get::<_,i64>(5)?,"status":"agent_draft"}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())
}

pub fn promote_draft(
    conn: &Connection,
    workspace: &str,
    id: &str,
) -> Result<ProposalResult, String> {
    let (scope,mission,input,actor,run,task,fact):(String,Option<String>,String,String,Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT scope,mission_id,input_json,actor_kind,source_run_id,source_task_id,source_fact_id FROM memory_agent_drafts WHERE id=?1 AND workspace_id=?2",params![id,workspace],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).map_err(|_|"draft unavailable")?;
    if super::owner_quota(conn, workspace, mission.as_deref())?.0 >= super::PENDING_MAX {
        return Err("pending inbox is full; review proposals before promoting drafts".into());
    }
    let input: ProposalInput = serde_json::from_str(&input).map_err(|e| e.to_string())?;
    let result = super::propose(
        conn,
        &scope,
        workspace,
        mission.as_deref(),
        &input,
        ProposalActor {
            kind: &actor,
            run_id: run.as_deref(),
            task_id: task.as_deref(),
            fact_id: fact.as_deref(),
        },
    )?;
    if result.status != "agent_draft" {
        conn.execute(
            "DELETE FROM memory_agent_drafts WHERE id=?1 AND workspace_id=?2",
            params![id, workspace],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

pub fn swarm_write(
    conn: &Connection,
    workspace: &str,
    mission: &str,
    kind: &str,
    body: &str,
) -> Result<String, String> {
    super::validate_owner(conn, "mission", workspace, Some(mission))?;
    if !matches!(kind, "note" | "question") {
        return Err("invalid swarm note kind".into());
    }
    let body = super::normalize_body(body)?;
    if super::agent::looks_like_secret(&body) {
        return Err("swarm notes cannot contain credentials".into());
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let bytes:i64=tx.query_row("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM memory_swarm_notes WHERE mission_id=?1",[mission],|r|r.get(0)).map_err(|e|e.to_string())?;
    if bytes + body.len() as i64 > 64 * 1024 {
        return Err("swarm notes exceeded 64 KiB; notify the orchestrator".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO memory_swarm_notes(id,workspace_id,mission_id,kind,body,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,workspace,mission,kind,body,super::now()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Frontend lifecycle name; keep the existing database command compatible.
#[tauri::command]
pub fn workspace_restore(
    workspace_id: String,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<(), String> {
    crate::database::db_restore_workspace(workspace_id, db)
}

pub fn deleted_workspaces(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare("SELECT id,name,deleted_at,delete_after FROM workspaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC,id").map_err(|e| e.to_string())?;
    let timestamp = super::now();
    stmt.query_map([], |r| {
        let deadline: Option<i64> = r.get(3)?;
        Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"deletedAt":r.get::<_,i64>(2)?,"deleteAfter":deadline,"remainingSeconds":deadline.map(|v| v.saturating_sub(timestamp).max(0))}))
    }).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_deleted_list(db: tauri::State<crate::database::DbConnection>) -> Result<Vec<Value>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    deleted_workspaces(&conn)
}

#[tauri::command]
pub fn memory_export(
    workspace_id: String,
    db: tauri::State<crate::database::DbConnection>,
    sync: tauri::State<super::repo_sync::RepoSync>,
) -> Result<Value, String> {
    export_detached(&db, &sync, &workspace_id)
}
#[tauri::command]
pub fn memory_workspace_stats(
    workspace_id: String,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<Value, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    stats(&c, &workspace_id)
}
#[tauri::command]
pub fn memory_agent_drafts(
    workspace_id: String,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<Vec<Value>, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    drafts(&c, &workspace_id)
}
#[tauri::command]
pub fn memory_promote_draft(
    workspace_id: String,
    draft_id: String,
    app: tauri::AppHandle,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<ProposalResult, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    let r = promote_draft(&c, &workspace_id, &draft_id);
    drop(c);
    super::notify_changed(&app);
    r
}
#[tauri::command]
pub fn memory_discard_draft(
    workspace_id: String,
    draft_id: String,
    app: tauri::AppHandle,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<(), String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    c.execute(
        "DELETE FROM memory_agent_drafts WHERE id=?1 AND workspace_id=?2",
        params![draft_id, workspace_id],
    )
    .map_err(|e| e.to_string())?;
    drop(c);
    super::notify_changed(&app);
    Ok(())
}
#[tauri::command]
pub fn memory_compact(
    retention_days: i64,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<usize, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    compact(&c, retention_days)
}

#[tauri::command]
pub fn memory_verify_source(
    entry_id: String,
    file_path: Option<String>,
    commit: Option<String>,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<Value, String> {
    let c = db.lock().map_err(|e| e.to_string())?;
    let source:Option<(Option<String>,Option<String>,Option<String>)>=c.query_row("SELECT r.source_run_id,r.source_task_id,COALESCE(s.cwd,m.cwd) FROM memory_entries e JOIN memory_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision LEFT JOIN runs s ON s.id=r.source_run_id LEFT JOIN missions m ON m.id=e.mission_id WHERE e.id=?1 AND r.status='approved'",[entry_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let (run, task, cwd) = source.ok_or("approved source unavailable")?;
    let run_exists = run
        .as_ref()
        .map(|id| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1)", [id], |r| {
                r.get::<_, bool>(0)
            })
        })
        .transpose()
        .map_err(|e| e.to_string())?;
    let task_exists = task
        .as_ref()
        .map(|id| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND run_id=?2)",
                params![id, run],
                |r| r.get::<_, bool>(0),
            )
        })
        .transpose()
        .map_err(|e| e.to_string())?;
    let root = cwd
        .as_ref()
        .and_then(|path| std::fs::canonicalize(path).ok());
    let file_exists = if let Some(path) = file_path {
        if path.contains("..")
            || path.contains(':')
            || path.starts_with('/')
            || path.starts_with('\\')
        {
            return Err("source path must be relative to the source repository".into());
        }
        match &root {
            Some(root) => {
                let candidate = std::fs::canonicalize(root.join(path.replace('\\', "/"))).ok();
                if candidate.as_ref().is_some_and(|p| !p.starts_with(root)) {
                    return Err("source path escapes repository".into());
                }
                Some(candidate.is_some_and(|p| p.is_file()))
            }
            None => Some(false),
        }
    } else {
        None
    };
    let commit_exists = if let Some(hash) = commit {
        if !(7..=64).contains(&hash.len()) || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("invalid source commit hash".into());
        }
        if let Some(root) = root {
            let mut cmd = crate::util::program("git");
            cmd.current_dir(root)
                .args(["cat-file", "-e", &format!("{hash}^{{commit}}")]);
            Some(
                crate::util::output_with_timeout(&mut cmd, std::time::Duration::from_secs(10))
                    .map_err(|e| e.to_string())?
                    .status
                    .success(),
            )
        } else {
            Some(false)
        }
    } else {
        None
    };
    Ok(
        json!({"runExists":run_exists,"taskExists":task_exists,"fileExists":file_exists,"commitExists":commit_exists,"lastVerifiedChanged":false}),
    )
}

#[tauri::command]
pub fn memory_set_verification(
    entry_id: String,
    last_verified: Option<i64>,
    ttl_days: Option<i64>,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<(), String> {
    if ttl_days.is_some_and(|v| v <= 0) || last_verified.is_some_and(|v| v < 0 || v > super::now())
    {
        return Err("invalid verification metadata".into());
    }
    let c = db.lock().map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE memory_entries SET last_verified=?2,ttl_days=?3 WHERE id=?1",
        params![entry_id, last_verified, ttl_days],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
