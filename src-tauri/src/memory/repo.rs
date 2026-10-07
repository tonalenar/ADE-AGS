//! One-way, local Markdown projection. SQLite remains authoritative.
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::Duration};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub type Files = BTreeMap<String, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub commit: Option<String>,
    pub files: Vec<String>,
}

pub fn slug(name: &str, id: &str) -> String {
    let stem = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>().split('-').filter(|s| !s.is_empty()).take(8).collect::<Vec<_>>().join("-");
    let suffix = Sha256::digest(id.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect::<String>();
    format!("{}-{suffix}", if stem.is_empty() { "workspace" } else { &stem })
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").replace('\\', "\\\\")
        .replace('[', "\\[").replace(']', "\\]").replace('`', "\\`")
}

fn date(timestamp: i64) -> String {
    chrono::DateTime::from_timestamp(timestamp, 0).unwrap_or_default().format("%Y-%m-%d").to_string()
}

fn line(body: &str, run: Option<&str>, task: Option<&str>, timestamp: i64, id: &str, revision: i64, kind: &str) -> String {
    format!("- {} [source: ags://run/{}/task/{}; added: {}; id: {}@r{}; kind: {}]\n",
        one_line(body), run.unwrap_or("manual"), task.unwrap_or("user"), date(timestamp), id, revision, kind)
}

fn checked(text: &str) -> Result<(), String> {
    if super::agent::looks_like_secret(text) { Err("A projeção contém uma credencial; expurgue a revisão antes de exportar.".into()) } else { Ok(()) }
}

/// Pure rendering also underpins the Dream preview. Overrides are selected revisions;
/// they are never persisted or exported by this function.
pub fn render(conn: &Connection, workspace: &str, overrides: &[(String, i64)]) -> Result<Files, String> {
    let name: String = conn.query_row("SELECT name FROM workspaces WHERE id=?1", [workspace], |r| r.get(0)).map_err(|_| "workspace not found")?;
    let mut files = Files::new();
    for (file, title) in [("decisions.md", "Decisions"), ("constraints.md", "Constraints"), ("findings.md", "Findings"), ("files.md", "Files"), ("notes.md", "Notes"), ("questions.md", "Questions for the user")] {
        files.insert(file.into(), format!("# {title}\n\n"));
    }
    let mut stmt = conn.prepare("SELECT e.id,e.scope,e.mission_id,e.key,r.revision,r.kind,r.body,r.priority,r.source_run_id,r.source_task_id,r.created_at,r.operation,m.title FROM memory_entries e JOIN memory_revisions r ON r.entry_id=e.id LEFT JOIN missions m ON m.id=e.mission_id WHERE e.workspace_id=?1 AND ((e.status='active' AND r.revision=e.current_revision AND r.status='approved') OR r.status='proposed') ORDER BY r.priority DESC,e.key COLLATE BINARY,e.id,r.revision").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([workspace], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,i64>(10)?,r.get::<_,String>(11)?,r.get::<_,Option<String>>(12)?))).map_err(|e|e.to_string())?;
    let mut top = Vec::new();
    for row in rows {
        let (id,scope,mission,key,revision,kind,body,_priority,run,task,created,operation,title)=row.map_err(|e|e.to_string())?;
        let selected = overrides.iter().find(|(entry,_)| entry==&id).map(|(_,rev)|*rev);
        if let Some(selected)=selected { if selected!=revision || operation=="delete" { continue; } }
        else {
            let current: Option<i64>=conn.query_row("SELECT current_revision FROM memory_entries WHERE id=?1", [&id], |r|r.get(0)).map_err(|e|e.to_string())?;
            if current!=Some(revision) { continue; }
        }
        checked(&key)?; checked(&body)?;
        let row=line(&body,run.as_deref(),task.as_deref(),created,&id,revision,&kind);
        let file=match kind.as_str() {"decision"=>"decisions.md","constraint"=>"constraints.md","finding"=>"findings.md","file"=>"files.md",_=>"notes.md"};
        files.get_mut(file).unwrap().push_str(&row);
        if kind=="note" && key.starts_with("question:") { files.get_mut("questions.md").unwrap().push_str(&row); }
        if scope=="workspace" && matches!(kind.as_str(),"constraint"|"decision") && top.len()<24 { top.push(row.clone()); }
        if let Some(mission)=mission {
            let path=format!("missions/{}.md",slug(title.as_deref().unwrap_or("mission"),&mission));
            files.entry(path).or_insert_with(||"# Mission memory\n\n".into()).push_str(&row);
        }
    }
    let mut facts=conn.prepare("SELECT f.id,f.body,f.run_id,f.task_id,f.created_at,f.kind,r.mission_id,m.title FROM run_facts f JOIN runs r ON r.id=f.run_id LEFT JOIN missions m ON m.id=r.mission_id WHERE r.workspace_id=?1 ORDER BY r.mission_id,r.id,f.created_at,f.id").map_err(|e|e.to_string())?;
    for fact in facts.query_map([workspace],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?))).map_err(|e|e.to_string())? {
        let (id,body,run,task,created,kind,mission,title)=fact.map_err(|e|e.to_string())?; checked(&body)?;
        let owner=mission.as_deref().unwrap_or(&run);
        let path=format!("swarms/{}/findings.md",slug(title.as_deref().unwrap_or("run"),owner));
        files.entry(path).or_insert_with(||"# Run Facts (read-only)\n\n".into()).push_str(&line(&body,Some(&run),task.as_deref(),created,&format!("fact-{id}"),0,&kind));
    }
    let mut memory=format!("# Memory: {}\n\n",one_line(&name));
    for row in top { memory.push_str(&row); }
    memory.push_str("\n## Index\n\n");
    for file in ["decisions.md","constraints.md","findings.md","files.md","notes.md","questions.md","missions/","swarms/"] { memory.push_str(&format!("- [{file}]({file})\n")); }
    // Keep the briefing compact; detailed pages remain available in the repository.
    let mut lines=memory.lines().take(39).collect::<Vec<_>>().join("\n"); lines.push('\n');
    files.insert("MEMORY.md".into(),lines);
    for body in files.values() { checked(body)?; }
    Ok(files)
}

pub fn default_root() -> Result<PathBuf,String> {
    Ok(dirs::home_dir().ok_or("home unavailable")?.join(".ags").join("memory"))
}

fn git(path: &Path, args: &[&str]) -> Result<String,String> {
    let mut cmd=crate::util::program("git"); cmd.current_dir(path).args(["-c","core.autocrlf=false"]).args(args)
        .env("GIT_CONFIG_NOSYSTEM","1").env("GIT_TERMINAL_PROMPT","0");
    let output=crate::util::output_with_timeout(&mut cmd,Duration::from_secs(30)).map_err(|e|e.to_string())?;
    if !output.status.success() { return Err(format!("memory git failed: {}",String::from_utf8_lossy(&output.stderr))); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn export_at(conn: &Connection, workspace: &str, root: &Path, approval: Option<(&str,i64)>) -> Result<ExportResult,String> {
    // Complete secret preflight precedes even directory creation.
    let files=render(conn,workspace,&[])?;
    let name:String=conn.query_row("SELECT name FROM workspaces WHERE id=?1",[workspace],|r|r.get(0)).map_err(|e|e.to_string())?;
    let path=root.join(slug(&name,workspace));
    if root.is_symlink() || path.is_symlink() { return Err("memory repository cannot be a symlink".into()); }
    std::fs::create_dir_all(&path).map_err(|e|e.to_string())?;
    if path.join(".git").is_symlink() { return Err("memory git directory cannot be a symlink".into()); }
    if !path.join(".git").exists() { git(&path,&["init","--quiet"])?; }
    if !git(&path,&["remote"])?.is_empty() { return Err("memory repository must have no remote".into()); }
    for staged in git(&path,&["diff","--cached","--name-only"])?.lines() {
        if !managed_path(staged) { return Err("memory repository has unrelated staged files".into()); }
    }
    for file in files.keys() {
        let mut candidate=path.clone();
        for component in Path::new(file).components() {
            candidate.push(component);
            if candidate.is_symlink() { return Err("memory projection cannot follow symlinks".into()); }
        }
    }
    let tracked=git(&path,&["ls-files","--","*.md"])?;
    for old in tracked.lines() {
        if !files.contains_key(old) && managed_path(old) { std::fs::remove_file(path.join(old)).map_err(|e|e.to_string())?; }
    }
    for (file,body) in &files {
        let target=path.join(file);
        if target.is_symlink() || target.parent().is_some_and(|p|p.is_symlink()) { return Err("memory projection cannot follow symlinks".into()); }
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;
        std::fs::write(target,body).map_err(|e|e.to_string())?;
    }
    for file in files.keys().map(String::as_str).chain(tracked.lines().filter(|p| managed_path(p))) {
        git(&path,&["add","--all","--",file])?;
    }
    let changed=!git(&path,&["diff","--cached","--name-only"])?.is_empty();
    for file in git(&path,&["diff","--cached","--diff-filter=ACMR","--name-only"])?.lines() {
        checked(&git(&path,&["show",&format!(":{file}")])?)?;
    }
    let mut commit=None;
    if changed || approval.is_some() {
        let message=approval.map(|(entry,revision)|format!("Approve memory {entry}@r{revision}")).unwrap_or_else(||"Export approved memory".into());
        let hooks=path.join(".git").join("ade-disabled-hooks");
        std::fs::create_dir_all(&hooks).map_err(|e|e.to_string())?;
        git(&path,&["-c","user.name=ADE AGS","-c","user.email=memory@ade-ags.local","-c",&format!("core.hooksPath={}",hooks.display()),"-c","commit.gpgSign=false","commit","--quiet","--allow-empty","-m",&message])?;
        commit=Some(git(&path,&["rev-parse","HEAD"])?);
    }
    Ok(ExportResult{path:path.to_string_lossy().into_owned(),commit,files:files.keys().cloned().collect()})
}

fn managed_path(path: &str) -> bool {
    !path.contains("..") && !path.contains('\\') && !Path::new(path).is_absolute()
        && (matches!(path,"MEMORY.md"|"decisions.md"|"constraints.md"|"findings.md"|"files.md"|"notes.md"|"questions.md") || path.starts_with("missions/") || path.starts_with("swarms/"))
}

#[tauri::command]
pub fn memory_export_repo(workspace_id:String,db:tauri::State<crate::database::DbConnection>) -> Result<ExportResult,String> {
    let conn=db.lock().map_err(|_|"database unavailable")?;
    export_at(&conn,&workspace_id,&default_root()?,None)
}

#[cfg(test)]
mod tests;
