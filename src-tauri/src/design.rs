//! Untrusted design documents. HTML is opaque data: never interpreted or executed here.
use crate::database::DbConnection;
use rusqlite::{Connection, params};
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
        Some(Value::String(s)) if s.len() <= 512 => Ok(Some(s.clone())),
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
    let mut d=c.query_row("SELECT id,workspace,mission_id,owner_tab_id,title,status FROM design WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"workspace":r.get::<_,String>(1)?,"missionId":r.get::<_,Option<String>>(2)?,"ownerTabId":r.get::<_,Option<String>>(3)?,"title":r.get::<_,String>(4)?,"status":r.get::<_,String>(5)?}))).map_err(err)?;
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
    if matches!(op, "page_add" | "approve_all") {
        return Ok(text(a, "designId")?.into());
    }
    if op == "artboard_add" {
        if a.get("page").is_some() {
            let id = text(a, "designId")?;
            c.query_row("SELECT id FROM design WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(err)?;
            return Ok(id.into());
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
                "SELECT id FROM design WHERE (?1='' OR workspace=?1) ORDER BY rowid",
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
    let id = if op == "create" {
        uuid::Uuid::new_v4().to_string()
    } else {
        design_for(&tx, op, a)?
    };
    match op {
        "create" => {
            tx.execute("INSERT INTO design(id,workspace,mission_id,owner_tab_id,title) VALUES(?1,?2,?3,?4,?5)",params![id,bounded(a,"workspace",4096)?,optional(a,"missionId")?,optional(a,"ownerTabId")?.or(optional(a,"from")?),bounded(a,"title",512)?]).map_err(err)?;
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
            tx.execute(
                "INSERT INTO design_artboard VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,'draft')",
                params![
                    bid,
                    page_id,
                    bounded(a, "title", 512)?,
                    bounded(a, "html", MAX_HTML)?,
                    number(a, "width", 1024.0)?,
                    number(a, "height", 768.0)?,
                    number(a, "x", 0.0)?,
                    number(a, "y", 0.0)?
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
            if op == "artboard_update" {
                for k in ["title", "html", "width", "height", "x", "y"] {
                    if let Some(v) = a.get(k) {
                        b[k] = v.clone();
                    }
                }
            }
            tx.execute("UPDATE design_artboard SET title=?2,html=?3,width=?4,height=?5,x=?6,y=?7,version=?8,status='draft' WHERE id=?1",params![bid,bounded(&b,"title",512)?,bounded(&b,"html",MAX_HTML)?,number(&b,"width",1024.0)?,number(&b,"height",768.0)?,number(&b,"x",0.0)?,number(&b,"y",0.0)?,current["version"].as_i64().unwrap()+1]).map_err(err)?;
            save_snapshot(&tx, bid)?;
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
            tx.execute("INSERT INTO design_comment(id,artboard_id,author,text,selector) VALUES(?1,?2,?3,?4,?5)",params![uuid::Uuid::new_v4().to_string(),text(a,"artboardId")?,text(a,"author")?,bounded(a,"text",16384)?,optional(a,"selector")?]).map_err(err)?;
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
    let result = get(&tx, &id)?;
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
        app.emit("design-changed", json!({"designId":result["id"]}))
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
            35
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
