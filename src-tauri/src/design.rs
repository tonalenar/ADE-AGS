//! Untrusted design documents. HTML is opaque data: never interpreted or executed here.
use crate::database::DbConnection;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use tauri::{Emitter, Manager};

const MAX_HTML: usize = 1_048_576;
type Result<T> = std::result::Result<T, String>;

pub(crate) fn migrate(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS design (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, mission_id TEXT, owner_tab_id TEXT,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')));
    CREATE TABLE IF NOT EXISTS design_page (
        id TEXT PRIMARY KEY, design_id TEXT NOT NULL REFERENCES design(id) ON DELETE CASCADE,
        name TEXT NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS design_artboard (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES design_page(id) ON DELETE CASCADE,
        title TEXT NOT NULL, html TEXT NOT NULL CHECK(length(CAST(html AS BLOB))<=1048576),
        width REAL NOT NULL CHECK(width>0 AND width<=16384), height REAL NOT NULL CHECK(height>0 AND height<=16384),
        x REAL NOT NULL, y REAL NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected')));
    CREATE TABLE IF NOT EXISTS design_artboard_version (
        artboard_id TEXT NOT NULL REFERENCES design_artboard(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(artboard_id,version));
    CREATE TABLE IF NOT EXISTS design_comment (
        id TEXT PRIMARY KEY, artboard_id TEXT NOT NULL REFERENCES design_artboard(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK(author IN ('user','agent')), text TEXT NOT NULL, selector TEXT,
        resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)));
    CREATE INDEX IF NOT EXISTS design_workspace_idx ON design(workspace);
    CREATE INDEX IF NOT EXISTS design_page_idx ON design_page(design_id,sort_order);
    CREATE INDEX IF NOT EXISTS design_artboard_idx ON design_artboard(page_id);
    CREATE INDEX IF NOT EXISTS design_comment_idx ON design_comment(artboard_id);")
}
/// v37: preserve every page, board, comment and version while consolidating documents.
/// Retain the old document as an archived alias so existing agent IDs still resolve.
pub(crate) fn migrate_v37(c: &Connection) -> rusqlite::Result<()> {
    // The main schema migration already owns a savepoint; nest instead of BEGIN.
    c.execute_batch("SAVEPOINT migrate_design_v37")?;
    let result = (|| -> rusqlite::Result<()> {
        let tx = c;
        for (column, ddl) in [
            ("archived", "INTEGER NOT NULL DEFAULT 0"),
            ("merged_into", "TEXT"),
        ] {
            if tx
                .prepare(&format!("SELECT {column} FROM design LIMIT 0"))
                .is_err()
            {
                tx.execute_batch(&format!("ALTER TABLE design ADD COLUMN {column} {ddl}"))?;
            }
        }
        let pairs = {
            let mut s = tx.prepare("SELECT d.id, (SELECT k.id FROM design k WHERE k.archived=0 AND trim(k.title)=trim(d.title) AND ((d.mission_id IS NOT NULL AND k.mission_id=d.mission_id) OR (d.mission_id IS NULL AND k.mission_id IS NULL AND k.workspace=d.workspace)) ORDER BY k.rowid LIMIT 1) FROM design d WHERE d.archived=0 ORDER BY d.rowid")?;
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (duplicate, canonical) in pairs {
            if duplicate == canonical {
                continue;
            }
            tx.execute("UPDATE design SET owner_tab_id=COALESCE(NULLIF(owner_tab_id,''),(SELECT NULLIF(owner_tab_id,'') FROM design WHERE id=?2)) WHERE id=?1", params![canonical, duplicate])?;
            tx.execute("UPDATE design_page SET sort_order=sort_order+(SELECT COALESCE(MAX(sort_order)+1,0) FROM design_page WHERE design_id=?1),design_id=?1 WHERE design_id=?2", params![canonical, duplicate])?;
            tx.execute(
                "UPDATE design SET archived=1,merged_into=?1 WHERE id=?2",
                params![canonical, duplicate],
            )?;
            aggregate(&tx, &canonical).map_err(|e| rusqlite::Error::InvalidParameterName(e))?;
        }
        tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS design_mission_title_unique ON design(mission_id,trim(title)) WHERE mission_id IS NOT NULL AND archived=0;
        CREATE UNIQUE INDEX IF NOT EXISTS design_workspace_title_unique ON design(workspace,trim(title)) WHERE mission_id IS NULL AND archived=0;")?;
        Ok(())
    })();
    match result {
        Ok(()) => c.execute_batch("RELEASE migrate_design_v37"),
        Err(e) => {
            c.execute_batch("ROLLBACK TO migrate_design_v37; RELEASE migrate_design_v37")?;
            Err(e)
        }
    }
}
fn err(e: rusqlite::Error) -> String {
    e.to_string()
}
fn text<'a>(a: &'a Value, key: &str) -> Result<&'a str> {
    a.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing or invalid {key}"))
}
fn bounded(a: &Value, key: &str, max: usize) -> Result<String> {
    let s = text(a, key)?;
    if s.len() > max {
        return Err(format!("{key} exceeds {max} bytes"));
    }
    Ok(s.into())
}
fn optional(a: &Value, key: &str) -> Result<Option<String>> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= 512 => {
            Ok((!s.trim().is_empty()).then(|| s.trim().to_string()))
        }
        _ => Err(format!("Invalid {key}")),
    }
}
fn number(a: &Value, key: &str, default: f64) -> Result<f64> {
    let n = match a.get(key) {
        None => default,
        Some(Value::Number(n)) => n.as_f64().ok_or("Invalid number")?,
        Some(Value::String(s)) => s.parse().map_err(|_| format!("Invalid {key}"))?,
        _ => return Err(format!("Invalid {key}")),
    };
    if !n.is_finite() || n.abs() > 1_000_000.0 {
        return Err(format!("Invalid {key}"));
    }
    Ok(n)
}
fn artboard(c: &Connection, id: &str) -> Result<Value> {
    c.query_row("SELECT id,page_id,title,html,width,height,x,y,version,status FROM design_artboard WHERE id=?1",[id],|r| Ok(json!({
        "id":r.get::<_,String>(0)?,"pageId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"html":r.get::<_,String>(3)?,
        "width":r.get::<_,f64>(4)?,"height":r.get::<_,f64>(5)?,"x":r.get::<_,f64>(6)?,"y":r.get::<_,f64>(7)?,"version":r.get::<_,i64>(8)?,"status":r.get::<_,String>(9)?}))).map_err(err)
}
fn ids(c: &Connection, sql: &str, id: &str) -> Result<Vec<String>> {
    let mut s = c.prepare(sql).map_err(err)?;
    let rows = s.query_map([id], |r| r.get(0)).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}
fn get(c: &Connection, id: &str) -> Result<Value> {
    let canonical = canonical_id(c, id)?;
    let id = canonical.as_str();
    let mut d=c.query_row("SELECT id,workspace,mission_id,owner_tab_id,title,status,archived FROM design WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"workspace":r.get::<_,String>(1)?,"missionId":r.get::<_,Option<String>>(2)?,"ownerTabId":r.get::<_,Option<String>>(3)?,"title":r.get::<_,String>(4)?,"status":r.get::<_,String>(5)?,"archived":r.get::<_,bool>(6)?}))).map_err(err)?;
    let available = match d["ownerTabId"].as_str() {
        Some(owner) => c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tabs WHERE id=?1)",
                [owner],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?,
        None => false,
    };
    d["ownerAvailable"] = json!(available);
    d["ownerWarning"] = if available {
        Value::Null
    } else if d["ownerTabId"].is_null() {
        json!("missing")
    } else {
        json!("closed")
    };
    let mut pages = Vec::new();
    for pid in ids(
        c,
        "SELECT id FROM design_page WHERE design_id=?1 ORDER BY sort_order,rowid",
        id,
    )? {
        let mut page=c.query_row("SELECT id,design_id,name,sort_order FROM design_page WHERE id=?1",[&pid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"designId":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"order":r.get::<_,i64>(3)?}))).map_err(err)?;
        let mut boards = Vec::new();
        for bid in ids(
            c,
            "SELECT id FROM design_artboard WHERE page_id=?1 ORDER BY rowid",
            &pid,
        )? {
            let mut b = artboard(c, &bid)?;
            let mut s=c.prepare("SELECT snapshot FROM design_artboard_version WHERE artboard_id=?1 ORDER BY version").map_err(err)?;
            let snapshots = s
                .query_map([&bid], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err)?;
            b["versions"] = Value::Array(
                snapshots
                    .iter()
                    .map(|s| serde_json::from_str(s).map_err(|e| e.to_string()))
                    .collect::<Result<Vec<Value>>>()?,
            );
            let mut s=c.prepare("SELECT id,author,text,selector,resolved FROM design_comment WHERE artboard_id=?1 ORDER BY rowid").map_err(err)?;
            b["comments"]=Value::Array(s.query_map([&bid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"artboardId":bid,"author":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"selector":r.get::<_,Option<String>>(3)?,"resolved":r.get::<_,bool>(4)?}))).map_err(err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?);
            boards.push(b);
        }
        page["artboards"] = json!(boards);
        pages.push(page);
    }
    d["pages"] = json!(pages);
    Ok(d)
}
fn canonical_id(c: &Connection, id: &str) -> Result<String> {
    c.query_row(
        "SELECT COALESCE(merged_into,id) FROM design WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .map_err(err)
}
fn save_snapshot(c: &Connection, id: &str) -> Result<()> {
    let b = artboard(c, id)?;
    c.execute(
        "INSERT INTO design_artboard_version(artboard_id,version,snapshot) VALUES(?1,?2,?3)",
        params![id, b["version"].as_i64(), b.to_string()],
    )
    .map_err(err)?;
    Ok(())
}
fn design_for(c: &Connection, op: &str, a: &Value) -> Result<String> {
    if matches!(op, "page_add" | "approve_all" | "delete" | "archive") {
        return canonical_id(c, text(a, "designId")?);
    }
    if op == "artboard_add" {
        if a.get("page").is_some() {
            let id = text(a, "designId")?;
            c.query_row("SELECT id FROM design WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?;
            return canonical_id(c, id);
        }
        return c
            .query_row(
                "SELECT design_id FROM design_page WHERE id=?1",
                [text(a, "pageId")?],
                |r| r.get(0),
            )
            .map_err(err);
    }
    let bid = if op == "comment_resolve" {
        c.query_row(
            "SELECT artboard_id FROM design_comment WHERE id=?1",
            [text(a, "commentId")?],
            |r| r.get::<_, String>(0),
        )
        .map_err(err)?
    } else {
        text(a, "artboardId")?.into()
    };
    c.query_row("SELECT p.design_id FROM design_page p JOIN design_artboard b ON b.page_id=p.id WHERE b.id=?1",[bid],|r|r.get(0)).map_err(err)
}
fn aggregate(c: &Connection, id: &str) -> Result<()> {
    c.execute("UPDATE design SET status=CASE
        WHEN NOT EXISTS(SELECT 1 FROM design_artboard b JOIN design_page p ON p.id=b.page_id WHERE p.design_id=?1) THEN 'draft'
        WHEN EXISTS(SELECT 1 FROM design_artboard b JOIN design_page p ON p.id=b.page_id WHERE p.design_id=?1 AND b.status='draft') THEN 'draft'
        WHEN EXISTS(SELECT 1 FROM design_artboard b JOIN design_page p ON p.id=b.page_id WHERE p.design_id=?1 AND b.status='approved') THEN 'approved'
        ELSE 'rejected' END WHERE id=?1",[id]).map_err(err)?;
    Ok(())
}
/// Single shared transaction path for Tauri and the CLI. Backend never loads HTML URLs.
pub(crate) fn execute(c: &mut Connection, op: &str, a: &Value) -> Result<Value> {
    if op == "list" {
        let workspace = optional(a, "workspace")?;
        return Ok(json!(
            ids(
                c,
                "SELECT id FROM design WHERE archived=0 AND (?1='' OR workspace=?1) ORDER BY rowid",
                workspace.as_deref().unwrap_or("")
            )?
            .iter()
            .map(|id| get(c, id))
            .collect::<Result<Vec<_>>>()?
        ));
    }
    if op == "get" {
        return get(c, text(a, "designId")?);
    }
    let tx = c.transaction().map_err(err)?;
    let mut is_new = false;
    let mut comment_added = None;
    let id = if op == "create" {
        let workspace = bounded(a, "workspace", 4096)?;
        let title = bounded(a, "title", 512)?.trim().to_string();
        let mission = optional(a, "missionId")?;
        let existing = tx.query_row("SELECT id FROM design WHERE archived=0 AND trim(title)=?1 AND ((?2 IS NOT NULL AND mission_id=?2) OR (?2 IS NULL AND mission_id IS NULL AND workspace=?3))", params![title, mission, workspace], |r| r.get::<_, String>(0)).optional().map_err(err)?;
        match existing {
            Some(id) => id,
            None => {
                is_new = true;
                uuid::Uuid::new_v4().to_string()
            }
        }
    } else {
        design_for(&tx, op, a)?
    };
    match op {
        "create" => {
            let owner = optional(a, "from")?.or(optional(a, "ownerTabId")?);
            if is_new {
                tx.execute("INSERT INTO design(id,workspace,mission_id,owner_tab_id,title) VALUES(?1,?2,?3,?4,?5)",params![id,bounded(a,"workspace",4096)?,optional(a,"missionId")?,owner,bounded(a,"title",512)?.trim()]).map_err(err)?;
            } else {
                // A retry retains the original creator; only fill an owner that was missing.
                tx.execute("UPDATE design SET owner_tab_id=COALESCE(NULLIF(owner_tab_id,''),?2) WHERE id=?1",params![id,owner]).map_err(err)?;
            }
        }
        "delete" => {
            let mut result = get(&tx, &id)?;
            tx.execute("DELETE FROM design WHERE merged_into=?1 OR id=?1", [&id])
                .map_err(err)?;
            result["deleted"] = json!(true);
            tx.commit().map_err(err)?;
            return Ok(result);
        }
        "archive" => {
            tx.execute("UPDATE design SET archived=1 WHERE id=?1", [&id])
                .map_err(err)?;
        }
        "page_add" => {
            get(&tx, &id)?;
            let order = number(a, "order", 0.0)?;
            if order.fract() != 0.0 {
                return Err("order must be an integer".into());
            }
            tx.execute(
                "INSERT INTO design_page VALUES(?1,?2,?3,?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    id,
                    bounded(a, "name", 512)?,
                    order as i64
                ],
            )
            .map_err(err)?;
        }
        "artboard_add" => {
            let page_id = if a.get("page").is_some() {
                let name = bounded(a, "page", 512)?;
                let pages = ids(
                    &tx,
                    "SELECT id FROM design_page WHERE design_id=?1 ORDER BY sort_order,rowid",
                    &id,
                )?;
                let mut found = None;
                for pid in pages {
                    let existing: String = tx
                        .query_row("SELECT name FROM design_page WHERE id=?1", [&pid], |r| {
                            r.get(0)
                        })
                        .map_err(err)?;
                    if existing == name {
                        found = Some(pid);
                        break;
                    }
                }
                match found {
                    Some(pid) => pid,
                    None => {
                        let pid = uuid::Uuid::new_v4().to_string();
                        tx.execute("INSERT INTO design_page(id,design_id,name,sort_order) VALUES(?1,?2,?3,(SELECT COALESCE(MAX(sort_order)+1,0) FROM design_page WHERE design_id=?2))",params![pid,id,name]).map_err(err)?;
                        pid
                    }
                }
            } else {
                text(a, "pageId")?.to_string()
            };
            let bid = uuid::Uuid::new_v4().to_string();
            // Default to the right of all existing boards, at the last board's y.
            // Explicit coordinates (including zero) always win independently.
            let (next_x, next_y): (f64, f64) = tx.query_row("SELECT COALESCE(MAX(x+width)+48,0),COALESCE((SELECT y FROM design_artboard WHERE page_id=?1 ORDER BY rowid DESC LIMIT 1),0) FROM design_artboard WHERE page_id=?1", [&page_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
            tx.execute(
                "INSERT INTO design_artboard VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,'draft')",
                params![
                    bid,
                    page_id,
                    bounded(a, "title", 512)?,
                    bounded(a, "html", MAX_HTML)?,
                    number(a, "width", 1024.0)?,
                    number(a, "height", 768.0)?,
                    number(a, "x", next_x)?,
                    number(a, "y", next_y)?
                ],
            )
            .map_err(err)?;
            save_snapshot(&tx, &bid)?;
        }
        "artboard_update" | "artboard_revert" => {
            let bid = text(a, "artboardId")?;
            let current = artboard(&tx, bid)?;
            if a.get("expectedVersion").is_some_and(|v| !v.is_null()) {
                if number(a, "expectedVersion", 0.0)? != current["version"].as_i64().unwrap() as f64
                {
                    return Err("Artboard changed; reload before editing".into());
                }
            }
            let mut b = if op == "artboard_revert" {
                let version = number(a, "version", 0.0)?;
                if version < 1.0 || version.fract() != 0.0 {
                    return Err("Invalid version".into());
                }
                let s: String=tx.query_row("SELECT snapshot FROM design_artboard_version WHERE artboard_id=?1 AND version=?2",params![bid,version as i64],|r|r.get(0)).map_err(err)?;
                serde_json::from_str(&s).map_err(|e| e.to_string())?
            } else {
                current.clone()
            };
            if op == "artboard_revert" {
                // Undo edits without moving a node back to an old canvas position.
                b["x"] = current["x"].clone();
                b["y"] = current["y"].clone();
            }
            if op == "artboard_update" {
                for k in ["title", "html", "width", "height", "x", "y"] {
                    if let Some(v) = a.get(k) {
                        b[k] = v.clone();
                    }
                }
            }
            let changed = op == "artboard_revert"
                || ["title", "html", "width", "height"]
                    .iter()
                    .any(|k| b[k] != current[k]);
            tx.execute("UPDATE design_artboard SET title=?2,html=?3,width=?4,height=?5,x=?6,y=?7,version=?8,status=?9 WHERE id=?1",params![bid,bounded(&b,"title",512)?,bounded(&b,"html",MAX_HTML)?,number(&b,"width",1024.0)?,number(&b,"height",768.0)?,number(&b,"x",0.0)?,number(&b,"y",0.0)?,current["version"].as_i64().unwrap()+i64::from(changed),if changed { "draft" } else { current["status"].as_str().unwrap() }]).map_err(err)?;
            if changed {
                save_snapshot(&tx, bid)?;
            }
        }
        "artboard_approve" | "artboard_reject" => {
            tx.execute(
                "UPDATE design_artboard SET status=?2 WHERE id=?1",
                params![
                    text(a, "artboardId")?,
                    if op == "artboard_approve" {
                        "approved"
                    } else {
                        "rejected"
                    }
                ],
            )
            .map_err(err)?;
        }
        "approve_all" => {
            get(&tx, &id)?;
            tx.execute("UPDATE design_artboard SET status='approved' WHERE status='draft' AND page_id IN (SELECT id FROM design_page WHERE design_id=?1)",[&id]).map_err(err)?;
        }
        "comment_add" => {
            let author = text(a, "author")?;
            if !matches!(author, "user" | "agent") {
                return Err("Invalid author".into());
            }
            let inserted=tx.execute("INSERT INTO design_comment(id,artboard_id,author,text,selector) SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS(SELECT 1 FROM design_comment WHERE artboard_id=?2 AND author=?3 AND trim(text)=?4 AND selector IS ?5 AND resolved=0)",params![uuid::Uuid::new_v4().to_string(),text(a,"artboardId")?,author,bounded(a,"text",16384)?.trim(),optional(a,"selector")?]).map_err(err)?;
            comment_added = Some(inserted > 0);
        }
        "comment_resolve" => {
            let resolved = match a.get("resolved") {
                None => true,
                Some(Value::Bool(v)) => *v,
                _ => return Err("Invalid resolved".into()),
            };
            tx.execute(
                "UPDATE design_comment SET resolved=?2 WHERE id=?1",
                params![text(a, "commentId")?, resolved],
            )
            .map_err(err)?;
        }
        _ => return Err(format!("Unknown design operation: {op}")),
    }
    aggregate(&tx, &id)?;
    let mut result = get(&tx, &id)?;
    if op == "create" {
        result["isNew"] = json!(is_new);
    }
    if let Some(added) = comment_added {
        result["commentAdded"] = json!(added);
    }
    tx.commit().map_err(err)?;
    Ok(result)
}
pub(crate) fn dispatch(app: &tauri::AppHandle, op: &str, args: &Value) -> Result<Value> {
    let db = app.state::<DbConnection>();
    let result = {
        let mut connection = db.lock().map_err(|e| e.to_string())?;
        execute(&mut connection, op, args)?
    };
    if !matches!(op, "get" | "list") {
        app.emit("design-changed", json!({"designId":result["id"],"isNew":result["isNew"].as_bool().unwrap_or(false),"deleted":op=="delete","archived":result["archived"],"title":result["title"],"workspace":result["workspace"],"missionId":result["missionId"]}))
            .map_err(|e| e.to_string())?;
    }
    Ok(result)
}
macro_rules! command {
    ($name:ident,$op:literal) => {
        #[tauri::command]
        pub(crate) fn $name(app: tauri::AppHandle, args: Value) -> Result<Value> {
            dispatch(&app, $op, &args)
        }
    };
}
command!(design_create, "create");
command!(design_delete, "delete");
command!(design_archive, "archive");
command!(design_list, "list");
command!(design_get, "get");
command!(design_page_add, "page_add");
command!(design_artboard_add, "artboard_add");
command!(design_artboard_update, "artboard_update");
command!(design_artboard_revert, "artboard_revert");
command!(design_artboard_approve, "artboard_approve");
command!(design_artboard_reject, "artboard_reject");
command!(design_approve_all, "approve_all");
command!(design_comment_add, "comment_add");
command!(design_comment_resolve, "comment_resolve");
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Run explicitly after a read-only SQLite backup to target/design-audit/data.db"]
    fn audit_real_database_copy() {
        // Fixed workspace-local path: this test can never open ~/.ags/data.db.
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/design-audit/data.db");
        let mut c = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        let counts = |c: &Connection| {
            [
                "design_page",
                "design_artboard",
                "design_artboard_version",
                "design_comment",
            ]
            .map(|table| {
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
            })
        };
        let before = counts(&c);
        let snapshots = ids(&c,"SELECT artboard_id || ':' || version || ':' || snapshot FROM design_artboard_version WHERE ?1='' ORDER BY artboard_id,version","").unwrap();
        crate::database::migrate_for_tests(&c).unwrap();
        crate::database::migrate_for_tests(&c).unwrap();
        assert_eq!(counts(&c), before);
        assert_eq!(ids(&c,"SELECT artboard_id || ':' || version || ':' || snapshot FROM design_artboard_version WHERE ?1='' ORDER BY artboard_id,version","").unwrap(),snapshots);
        let documents = execute(&mut c, "list", &json!({})).unwrap();
        let designs = documents
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["title"] == "Polir o bot - aura e acabamento")
            .collect::<Vec<_>>();
        assert_eq!(designs.len(), 1);
        let boards = designs[0]["pages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["artboards"].as_array().unwrap())
            .collect::<Vec<_>>();
        assert!(boards.len() >= 10);
        assert!(boards.iter().any(|b| b["status"] == "rejected"));
        assert!(boards.iter().any(|b| b["version"].as_i64().unwrap() > 1));
        assert!(designs[0]["ownerTabId"].as_str().is_some());
        let aliases = ids(
            &c,
            "SELECT id FROM design WHERE merged_into=?1",
            designs[0]["id"].as_str().unwrap(),
        )
        .unwrap();
        assert!(!aliases.is_empty());
        for alias in aliases {
            assert_eq!(get(&c, &alias).unwrap()["id"], designs[0]["id"]);
        }
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            37
        );
        eprintln!(
            "Real snapshot migration preserved {} boards, {} versions and {} comments",
            before[1], before[2], before[3]
        );
    }
    #[test]
    fn automatic_positions_are_spaced_and_explicit_zero_is_preserved() {
        let (mut c, _, pid, _) = setup();
        for n in 1..5 {
            let d = execute(
                &mut c,
                "artboard_add",
                &json!({"pageId":pid,"title":format!("Board {n}"),"html":"x"}),
            )
            .unwrap();
            assert_eq!(d["pages"][0]["artboards"][n]["x"], 1072.0 * n as f64);
        }
        let d = execute(
            &mut c,
            "artboard_add",
            &json!({"pageId":pid,"title":"Explicit","html":"x","x":0,"y":800}),
        )
        .unwrap();
        assert_eq!(d["pages"][0]["artboards"][5]["x"], 0.0);
        let d = execute(
            &mut c,
            "artboard_add",
            &json!({"pageId":pid,"title":"Next","html":"x"}),
        )
        .unwrap();
        assert_eq!(d["pages"][0]["artboards"][6]["x"], 5360.0);
        assert_eq!(d["pages"][0]["artboards"][6]["y"], 800.0);
        let d = execute(
            &mut c,
            "artboard_add",
            &json!({"designId":d["id"],"page":"Another","title":"First","html":"x"}),
        )
        .unwrap();
        assert_eq!(d["pages"][1]["artboards"][0]["x"], 0.0);
    }
    #[test]
    fn create_deduplicates_by_mission_or_workspace_and_keeps_creator() {
        let mut c = crate::database::test_db();
        let args = json!({"workspace":"one","missionId":"mission","title":"Design","from":"creator","ownerTabId":"wrong"});
        let d = execute(&mut c, "create", &args).unwrap();
        assert_eq!(d["ownerTabId"], "creator");
        assert_eq!(d["isNew"], true);
        let retry=execute(&mut c,"create",&json!({"workspace":"different-worktree","missionId":"mission","title":" Design ","from":"other"})).unwrap();
        assert_eq!(retry["id"], d["id"]);
        assert_eq!(retry["isNew"], false);
        assert_eq!(retry["ownerTabId"], "creator");
        let other = execute(
            &mut c,
            "create",
            &json!({"workspace":"one","missionId":"other","title":"Design"}),
        )
        .unwrap();
        assert_ne!(other["id"], d["id"]);
        let args = json!({"workspace":"one","title":"Without mission"});
        let first = execute(&mut c, "create", &args).unwrap();
        assert_eq!(execute(&mut c, "create", &args).unwrap()["id"], first["id"]);
        assert_ne!(
            execute(
                &mut c,
                "create",
                &json!({"workspace":"two","title":"Without mission"})
            )
            .unwrap()["id"],
            first["id"]
        );
    }
    #[test]
    fn duplicate_migration_preserves_boards_versions_comments_and_aliases() {
        let (mut c, did, pid, bid) = setup();
        c.execute_batch(
            "DROP INDEX design_workspace_title_unique; DROP INDEX design_mission_title_unique;",
        )
        .unwrap();
        c.execute("UPDATE design SET owner_tab_id=NULL WHERE id=?1", [&did])
            .unwrap();
        c.execute("INSERT INTO design(id,workspace,title,owner_tab_id) VALUES('duplicate','project','Design','creator')",[]).unwrap();
        c.execute("INSERT INTO design_page(id,design_id,name,sort_order) VALUES('duplicate-page','duplicate','Page 1',0)",[]).unwrap();
        // Actual user's five artboard titles, sizes and stacked positions.
        for (i, title) in [
            "Aura - 3 propostas",
            "Estados do bot",
            "Tamanhos",
            "Pixel-art detalhada",
            "Microinteracoes",
        ]
        .iter()
        .enumerate()
        {
            c.execute("INSERT INTO design_artboard VALUES(?1,'duplicate-page',?2,'<p>real design</p>',720,560,0,0,1,'approved')",params![format!("copy-{i}"),title]).unwrap();
            save_snapshot(&c, &format!("copy-{i}")).unwrap();
        }
        c.execute("INSERT INTO design_comment(id,artboard_id,author,text,selector) VALUES('comment','copy-0','user','Change aura','#aura')",[]).unwrap();
        migrate_v37(&c).unwrap();
        migrate_v37(&c).unwrap();
        let d = get(&c, "duplicate").unwrap();
        assert_eq!(d["id"], did);
        assert_eq!(d["ownerTabId"], "creator");
        assert_eq!(d["pages"].as_array().unwrap().len(), 2);
        assert_eq!(d["pages"][1]["artboards"].as_array().unwrap().len(), 5);
        assert_eq!(
            d["pages"][1]["artboards"][0]["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            d["pages"][1]["artboards"][0]["comments"][0]["selector"],
            "#aura"
        );
        assert_eq!(d["pages"][0]["id"], pid);
        assert_eq!(d["pages"][0]["artboards"][0]["id"], bid);
        assert_eq!(
            execute(&mut c, "list", &json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            c.execute(
                "INSERT INTO design(id,workspace,title) VALUES('again','project','Design')",
                []
            )
            .is_err()
        );
        let d = execute(
            &mut c,
            "page_add",
            &json!({"designId":"duplicate","name":"Via alias"}),
        )
        .unwrap();
        assert_eq!(d["id"], did);
        let d = execute(&mut c, "delete", &json!({"designId":"duplicate"})).unwrap();
        assert_eq!(d["deleted"], true);
        for table in [
            "design",
            "design_page",
            "design_artboard",
            "design_artboard_version",
            "design_comment",
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
    #[test]
    fn movement_preserves_approval_and_undo_preserves_position() {
        let (mut c, _, _, bid) = setup();
        execute(&mut c, "artboard_approve", &json!({"artboardId":bid})).unwrap();
        execute(
            &mut c,
            "artboard_update",
            &json!({"artboardId":bid,"x":800,"y":250}),
        )
        .unwrap();
        let b = artboard(&c, &bid).unwrap();
        assert_eq!(b["status"], "approved");
        assert_eq!(b["version"], 1);
        execute(
            &mut c,
            "artboard_update",
            &json!({"artboardId":bid,"html":"<p>edited</p>"}),
        )
        .unwrap();
        let d = execute(
            &mut c,
            "artboard_revert",
            &json!({"artboardId":bid,"version":1,"expectedVersion":2}),
        )
        .unwrap();
        let b = &d["pages"][0]["artboards"][0];
        assert_eq!(b["x"], 800.0);
        assert_eq!(b["y"], 250.0);
        assert_eq!(b["version"], 3);
        assert_eq!(b["status"], "draft");
    }
    #[test]
    fn archive_hides_document_without_deleting_history() {
        let (mut c, did, _, bid) = setup();
        assert_eq!(
            execute(&mut c, "archive", &json!({"designId":did})).unwrap()["archived"],
            true
        );
        assert!(
            execute(&mut c, "list", &json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(artboard(&c, &bid).unwrap()["version"], 1);
        assert_ne!(
            execute(
                &mut c,
                "create",
                &json!({"workspace":"project","title":"Design"})
            )
            .unwrap()["id"],
            did
        );
    }
    #[test]
    fn repeated_element_comments_are_idempotent_and_orphan_owner_is_reported() {
        let (mut c, _, _, bid) = setup();
        let args = json!({"artboardId":bid,"author":"user","text":"ESCOLHIDA: B","selector":"#proposal-b"});
        let first = execute(&mut c, "comment_add", &args).unwrap();
        assert_eq!(first["commentAdded"], true);
        assert_eq!(first["ownerAvailable"], false);
        assert_eq!(first["ownerWarning"], "closed");
        for _ in 0..3 {
            let d = execute(&mut c, "comment_add", &args).unwrap();
            assert_eq!(d["commentAdded"], false);
            assert_eq!(
                d["pages"][0]["artboards"][0]["comments"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        let mut different = args.clone();
        different["selector"] = json!("#proposal-c");
        assert_eq!(
            execute(&mut c, "comment_add", &different).unwrap()["commentAdded"],
            true
        );
        let cid = &first["pages"][0]["artboards"][0]["comments"][0]["id"];
        execute(&mut c, "comment_resolve", &json!({"commentId":cid})).unwrap();
        assert_eq!(
            execute(&mut c, "comment_add", &args).unwrap()["commentAdded"],
            true
        );
        let missing = execute(
            &mut c,
            "create",
            &json!({"workspace":"other","title":"No owner"}),
        )
        .unwrap();
        assert_eq!(missing["ownerWarning"], "missing");
        // A persisted live tab clears the warning. No chat/PTY side effect is needed to comment.
        c.execute("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('owner-workspace','Owner',0,0)",[]).unwrap();
        c.execute("INSERT INTO windows(id,workspace_id,label,last_active) VALUES('owner-window','owner-workspace','Owner',0)",[]).unwrap();
        c.execute("INSERT INTO tabs(id,window_id,agent_id,agent_label,command,cwd,opened_at,created_at,last_active) VALUES('owner','owner-window','codex','Codex','codex','/owner',0,0,0)",[]).unwrap();
        assert_eq!(
            get(&c, first["id"].as_str().unwrap()).unwrap()["ownerWarning"],
            Value::Null
        );
    }
    #[test]
    fn design_named_page_is_created_once_and_rolls_back_on_invalid_board() {
        let (mut c, did, _, _) = setup();
        let args = json!({"designId":did,"page":"New page","title":"Second","html":"<p>new</p>"});
        let d = execute(&mut c, "artboard_add", &args).unwrap();
        assert_eq!(d["pages"].as_array().unwrap().len(), 2);
        assert_eq!(d["pages"][1]["name"], "New page");
        let d = execute(&mut c, "artboard_add", &args).unwrap();
        assert_eq!(d["pages"].as_array().unwrap().len(), 2);
        assert_eq!(d["pages"][1]["artboards"].as_array().unwrap().len(), 2);
        let mut invalid = args;
        invalid["page"] = json!("Rollback page");
        invalid["width"] = json!(-1);
        assert!(execute(&mut c, "artboard_add", &invalid).is_err());
        assert_eq!(get(&c, &did).unwrap()["pages"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn design_null_expected_version_is_absent() {
        let (mut c, _, _, bid) = setup();
        execute(
            &mut c,
            "artboard_update",
            &json!({"artboardId":bid,"html":"changed","expectedVersion":null}),
        )
        .unwrap();
        assert_eq!(artboard(&c, &bid).unwrap()["version"], 2);
    }
    fn setup() -> (Connection, String, String, String) {
        let mut c = crate::database::test_db();
        let d = execute(
            &mut c,
            "create",
            &json!({"workspace":"project","title":"Design","ownerTabId":"owner"}),
        )
        .unwrap();
        let did = d["id"].as_str().unwrap().to_string();
        let d = execute(&mut c, "page_add", &json!({"designId":did,"name":"Page 1"})).unwrap();
        let pid = d["pages"][0]["id"].as_str().unwrap().to_string();
        let d = execute(
            &mut c,
            "artboard_add",
            &json!({"pageId":pid,"title":"Home","html":"<h1>Olá</h1>"}),
        )
        .unwrap();
        let bid = d["pages"][0]["artboards"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        (c, did, pid, bid)
    }
    #[test]
    fn design_migration_is_additive_and_idempotent() {
        let (c, did, _, bid) = setup();
        c.execute_batch("PRAGMA user_version=32").unwrap();
        crate::database::migrate_for_tests(&c).unwrap();
        crate::database::migrate_for_tests(&c).unwrap();
        assert_eq!(get(&c, &did).unwrap()["title"], "Design");
        assert_eq!(artboard(&c, &bid).unwrap()["version"], 1);
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            37
        );
    }
    #[test]
    fn design_versions_revert_and_require_approval_again() {
        let (mut c, _, _, bid) = setup();
        execute(&mut c, "artboard_approve", &json!({"artboardId":bid})).unwrap();
        execute(
            &mut c,
            "artboard_update",
            &json!({"artboardId":bid,"html":"<p>updated</p>","width":900,"expectedVersion":1}),
        )
        .unwrap();
        assert_eq!(artboard(&c, &bid).unwrap()["status"], "draft");
        assert!(
            execute(
                &mut c,
                "artboard_update",
                &json!({"artboardId":bid,"html":"stale","expectedVersion":1})
            )
            .is_err()
        );
        execute(&mut c, "artboard_approve", &json!({"artboardId":bid})).unwrap();
        let d = execute(
            &mut c,
            "artboard_revert",
            &json!({"artboardId":bid,"version":1}),
        )
        .unwrap();
        let b = &d["pages"][0]["artboards"][0];
        assert_eq!(b["html"], "<h1>Olá</h1>");
        assert_eq!(b["width"], 1024.0);
        assert_eq!(b["version"], 3);
        assert_eq!(b["status"], "draft");
        assert_eq!(b["versions"].as_array().unwrap().len(), 3);
        assert!(
            execute(
                &mut c,
                "artboard_revert",
                &json!({"artboardId":bid,"version":99})
            )
            .is_err()
        );
        assert_eq!(artboard(&c, &bid).unwrap()["version"], 3);
    }
    #[test]
    fn design_approve_all_preserves_rejected() {
        let (mut c, did, pid, bid) = setup();
        execute(&mut c, "artboard_reject", &json!({"artboardId":bid})).unwrap();
        execute(
            &mut c,
            "artboard_add",
            &json!({"pageId":pid,"title":"Other","html":"<p>new</p>"}),
        )
        .unwrap();
        let d = execute(&mut c, "approve_all", &json!({"designId":did})).unwrap();
        assert_eq!(d["status"], "approved");
        assert_eq!(d["pages"][0]["artboards"][0]["status"], "rejected");
        assert_eq!(d["pages"][0]["artboards"][1]["status"], "approved");
    }
    #[test]
    fn design_comments_roundtrip_and_resolution() {
        let (mut c, _, _, bid) = setup();
        let d = execute(
            &mut c,
            "comment_add",
            &json!({"artboardId":bid,"author":"user","text":"Change button","selector":"#submit"}),
        )
        .unwrap();
        let cm = &d["pages"][0]["artboards"][0]["comments"][0];
        assert_eq!(cm["selector"], "#submit");
        assert_eq!(cm["resolved"], false);
        let d = execute(&mut c, "comment_resolve", &json!({"commentId":cm["id"]})).unwrap();
        assert_eq!(
            d["pages"][0]["artboards"][0]["comments"][0]["resolved"],
            true
        );
        assert!(
            execute(
                &mut c,
                "comment_add",
                &json!({"artboardId":bid,"author":"invalid","text":"x"})
            )
            .is_err()
        );
    }
    #[test]
    fn design_limits_and_missing_targets_are_atomic() {
        let (mut c, did, pid, bid) = setup();
        for patch in [
            json!({"html":"a".repeat(MAX_HTML+1)}),
            json!({"width":-1}),
            json!({"height":20000}),
            json!({"title":""}),
        ] {
            let mut a = patch;
            a["artboardId"] = json!(bid);
            assert!(execute(&mut c, "artboard_update", &a).is_err());
        }
        assert_eq!(artboard(&c, &bid).unwrap()["version"], 1);
        assert!(
            execute(
                &mut c,
                "artboard_add",
                &json!({"pageId":"missing","title":"x","html":"x"})
            )
            .is_err()
        );
        assert!(execute(&mut c, "artboard_approve", &json!({"artboardId":"missing"})).is_err());
        let d = execute(&mut c, "get", &json!({"designId":did})).unwrap();
        assert_eq!(d["pages"][0]["id"], pid);
    }
    #[test]
    fn design_html_remains_opaque_data() {
        let (mut c, _, _, bid) = setup();
        let html = "<script>fetch('https://example.com');window.__TAURI__.invoke('evil')</script>";
        execute(
            &mut c,
            "artboard_update",
            &json!({"artboardId":bid,"html":html}),
        )
        .unwrap();
        assert_eq!(artboard(&c, &bid).unwrap()["html"], html);
    }
}
