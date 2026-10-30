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
    CREATE INDEX IF NOT EXISTS design_comment_idx ON design_comment(artboard_id);")?;
    // Tela de Design (F1–F4): só acrescenta colunas e tabelas; nada é apagado nem reescrito.
    for (table, column, ddl) in [
        ("design_comment", "anchor", "TEXT"),
        ("design_comment", "point_x", "REAL"),
        ("design_comment", "point_y", "REAL"),
        ("design_comment", "parent_id", "TEXT"),
        ("design_comment", "created_at", "INTEGER"),
        ("design_artboard", "radius", "REAL NOT NULL DEFAULT 0"),
        ("design_artboard", "hidden", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        add_column(c, table, column, ddl)?;
    }
    c.execute_batch("CREATE TABLE IF NOT EXISTS design_note (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES design_page(id) ON DELETE CASCADE,
        x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
        text TEXT NOT NULL DEFAULT '', color TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS design_shape (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES design_page(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('rect','oval','line','arrow','pencil','pen','text')),
        x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS design_note_idx ON design_note(page_id);
    CREATE INDEX IF NOT EXISTS design_shape_idx ON design_shape(page_id);")
}
/// `ADD COLUMN` só quando a coluna ainda não existe: roda a cada abertura do banco.
fn add_column(c: &Connection, table: &str, column: &str, ddl: &str) -> rusqlite::Result<()> {
    if c.prepare(&format!("SELECT {column} FROM {table} LIMIT 0")).is_err() {
        c.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))?;
    }
    Ok(())
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
/// Limites dos campos novos da tela de Design.
const MAX_ANCHOR: usize = 1024;
const MAX_TEXT: usize = 16_384;
const MAX_SHAPE_DATA: usize = 262_144;
const MAX_RADIUS: f64 = 4096.0;
const MAX_SIZE: f64 = 16_384.0;
const SHAPE_KINDS: [&str; 7] = ["rect", "oval", "line", "arrow", "pencil", "pen", "text"];
/// Uma string opcional com limite próprio (o `optional` corta em 512).
fn optional_max(a: &Value, key: &str, max: usize) -> Result<Option<String>> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= max => Ok((!s.trim().is_empty()).then(|| s.trim().to_string())),
        Some(Value::String(_)) => Err(format!("{key} passa de {max} bytes")),
        _ => Err(format!("{key} inválido")),
    }
}
/// Um número que precisa vir (coordenada de nota ou forma).
fn required_number(a: &Value, key: &str) -> Result<f64> {
    if a.get(key).is_none_or(Value::is_null) {
        return Err(format!("Falta {key}"));
    }
    number(a, key, 0.0)
}
/// Um número opcional dentro de um intervalo fechado.
fn ranged(a: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = number(a, key, default)?;
    if n < min || n > max {
        return Err(format!("{key} fora do intervalo {min}–{max}"));
    }
    Ok(n)
}
/// Largura e altura de nota: positivas e no mesmo teto das pranchetas.
fn size(a: &Value, key: &str, default: f64) -> Result<f64> {
    let n = number(a, key, default)?;
    if n <= 0.0 || n > MAX_SIZE {
        return Err(format!("{key} fora do intervalo 0–{MAX_SIZE}"));
    }
    Ok(n)
}
/// Ponto relativo ao elemento ou à prancheta (0–1), opcional.
fn point(a: &Value, key: &str) -> Result<Option<f64>> {
    if a.get(key).is_none_or(Value::is_null) {
        return Ok(None);
    }
    ranged(a, key, 0.0, 0.0, 1.0).map(Some)
}
/// Cor de nota: um token curto (nome, `#hex`, `var(--x)`), nunca markup.
fn color(a: &Value) -> Result<Option<String>> {
    let c = optional_max(a, "color", 64)?;
    if c.as_deref().is_some_and(|c| !c.chars().all(|ch| ch.is_ascii_alphanumeric() || "#-_(),. %".contains(ch))) {
        return Err("color inválida".into());
    }
    Ok(c)
}
/// Texto de nota: pode ficar vazio, mas tem teto.
fn note_text(a: &Value) -> Result<String> {
    match a.get("text") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) if s.len() <= MAX_TEXT => Ok(s.clone()),
        Some(Value::String(_)) => Err(format!("text passa de {MAX_TEXT} bytes")),
        _ => Err("text inválido".into()),
    }
}
fn shape_kind(a: &Value) -> Result<String> {
    let kind = text(a, "kind")?;
    if !SHAPE_KINDS.contains(&kind) {
        return Err(format!("kind inválido: use {}", SHAPE_KINDS.join(", ")));
    }
    Ok(kind.into())
}
/// O `data` da forma é JSON opaco (pontos, texto, cor, traço): objeto/array, ou string com JSON.
fn shape_data(a: &Value) -> Result<String> {
    let raw = match a.get("data") {
        None | Some(Value::Null) => "{}".to_string(),
        Some(Value::String(s)) => {
            serde_json::from_str::<Value>(s).map_err(|_| "data precisa ser JSON".to_string())?;
            s.clone()
        }
        Some(v @ (Value::Object(_) | Value::Array(_))) => v.to_string(),
        _ => return Err("data precisa ser um objeto JSON".into()),
    };
    if raw.len() > MAX_SHAPE_DATA {
        return Err(format!("data passa de {MAX_SHAPE_DATA} bytes"));
    }
    Ok(raw)
}
/// Título até 512 bytes, cortado numa fronteira de caractere.
fn clip(s: &str, max: usize) -> String {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}
fn artboard(c: &Connection, id: &str) -> Result<Value> {
    c.query_row("SELECT id,page_id,title,html,width,height,x,y,version,status,radius,hidden FROM design_artboard WHERE id=?1",[id],|r| Ok(json!({
        "id":r.get::<_,String>(0)?,"pageId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"html":r.get::<_,String>(3)?,
        "width":r.get::<_,f64>(4)?,"height":r.get::<_,f64>(5)?,"x":r.get::<_,f64>(6)?,"y":r.get::<_,f64>(7)?,"version":r.get::<_,i64>(8)?,"status":r.get::<_,String>(9)?,
        "radius":r.get::<_,f64>(10)?,"hidden":r.get::<_,bool>(11)?}))).map_err(err)
}
fn notes(c: &Connection, page: &str) -> Result<Vec<Value>> {
    let mut s = c.prepare("SELECT id,x,y,w,h,text,color,created_at FROM design_note WHERE page_id=?1 ORDER BY rowid").map_err(err)?;
    let rows = s.query_map([page], |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"pageId":page,"x":r.get::<_,f64>(1)?,"y":r.get::<_,f64>(2)?,"w":r.get::<_,f64>(3)?,"h":r.get::<_,f64>(4)?,
        "text":r.get::<_,String>(5)?,"color":r.get::<_,Option<String>>(6)?,"createdAt":r.get::<_,i64>(7)?}))).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}
fn shapes(c: &Connection, page: &str) -> Result<Vec<Value>> {
    let mut s = c.prepare("SELECT id,kind,x,y,w,h,data,created_at FROM design_shape WHERE page_id=?1 ORDER BY rowid").map_err(err)?;
    let rows = s.query_map([page], |r| {
        let data: String = r.get(6)?;
        Ok(json!({
        "id":r.get::<_,String>(0)?,"pageId":page,"kind":r.get::<_,String>(1)?,"x":r.get::<_,f64>(2)?,"y":r.get::<_,f64>(3)?,"w":r.get::<_,f64>(4)?,"h":r.get::<_,f64>(5)?,
        "data":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null),"createdAt":r.get::<_,i64>(7)?}))
    }).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
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
            let mut s=c.prepare("SELECT id,author,text,selector,resolved,anchor,point_x,point_y,parent_id,created_at FROM design_comment WHERE artboard_id=?1 ORDER BY rowid").map_err(err)?;
            b["comments"]=Value::Array(s.query_map([&bid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"artboardId":bid,"author":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"selector":r.get::<_,Option<String>>(3)?,"resolved":r.get::<_,bool>(4)?,
                "anchor":r.get::<_,Option<String>>(5)?,"pointX":r.get::<_,Option<f64>>(6)?,"pointY":r.get::<_,Option<f64>>(7)?,"parentId":r.get::<_,Option<String>>(8)?,"createdAt":r.get::<_,Option<i64>>(9)?}))).map_err(err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?);
            boards.push(b);
        }
        page["artboards"] = json!(boards);
        page["notes"] = json!(notes(c, &pid)?);
        page["shapes"] = json!(shapes(c, &pid)?);
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
fn design_of_page(c: &Connection, page: &str) -> Result<String> {
    c.query_row("SELECT design_id FROM design_page WHERE id=?1", [page], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("Página não encontrada: {page}"))
}
fn design_for(c: &Connection, op: &str, a: &Value) -> Result<String> {
    if matches!(op, "page_add" | "page_reorder" | "approve_all" | "delete" | "archive") {
        return canonical_id(c, text(a, "designId")?);
    }
    if matches!(op, "page_rename" | "page_delete" | "note_add" | "shape_add") {
        return design_of_page(c, text(a, "pageId")?);
    }
    for (ops, table, key) in [
        (["note_update", "note_delete"], "design_note", "noteId"),
        (["shape_update", "shape_delete"], "design_shape", "shapeId"),
    ] {
        if ops.contains(&op) {
            let id = text(a, key)?;
            let page: String = c
                .query_row(&format!("SELECT page_id FROM {table} WHERE id=?1"), [id], |r| r.get(0))
                .optional()
                .map_err(err)?
                .ok_or_else(|| format!("Não encontrado: {id}"))?;
            return design_of_page(c, &page);
        }
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
    if op == "open_target" {
        return open_target(c, a);
    }
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(err)?;
    let mut is_new = false;
    let mut comment_added = None;
    // O id do que acabou de nascer, para o front e o agente não precisarem procurá-lo.
    let mut created: Option<(&str, String)> = None;
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
            // Sem `order`, a página nova vai para o fim (as reordenadas têm 0..n).
            let order = if a.get("order").is_none_or(Value::is_null) {
                tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM design_page WHERE design_id=?1", [&id], |r| r.get::<_, i64>(0)).map_err(err)?
            } else {
                let order = number(a, "order", 0.0)?;
                if order.fract() != 0.0 {
                    return Err("order must be an integer".into());
                }
                order as i64
            };
            let pid = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO design_page(id,design_id,name,sort_order) VALUES(?1,?2,?3,?4)",
                params![pid, id, bounded(a, "name", 512)?.trim(), order],
            )
            .map_err(err)?;
            created = Some(("pageId", pid));
        }
        "page_rename" => {
            tx.execute(
                "UPDATE design_page SET name=?2 WHERE id=?1",
                params![text(a, "pageId")?, bounded(a, "name", 512)?.trim()],
            )
            .map_err(err)?;
        }
        "page_delete" => {
            let pages: i64 = tx.query_row("SELECT count(*) FROM design_page WHERE design_id=?1", [&id], |r| r.get(0)).map_err(err)?;
            if pages <= 1 {
                return Err("Não dá para apagar a última página do design".into());
            }
            tx.execute("DELETE FROM design_page WHERE id=?1", [text(a, "pageId")?]).map_err(err)?;
        }
        "page_reorder" => {
            let wanted: Vec<String> = a
                .get("pageIds")
                .and_then(Value::as_array)
                .ok_or("Falta pageIds")?
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or("pageIds precisa ser uma lista de ids"))
                .collect::<std::result::Result<_, _>>()?;
            let mut current = ids(&tx, "SELECT id FROM design_page WHERE design_id=?1", &id)?;
            let mut sorted = wanted.clone();
            current.sort();
            sorted.sort();
            if sorted != current {
                return Err("pageIds precisa ter exatamente as páginas do design, uma vez cada".into());
            }
            for (order, pid) in wanted.iter().enumerate() {
                tx.execute("UPDATE design_page SET sort_order=?2 WHERE id=?1", params![pid, order as i64]).map_err(err)?;
            }
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
                "INSERT INTO design_artboard(id,page_id,title,html,width,height,x,y,version,status,radius) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,'draft',?9)",
                params![
                    bid,
                    page_id,
                    bounded(a, "title", 512)?,
                    bounded(a, "html", MAX_HTML)?,
                    number(a, "width", 1024.0)?,
                    number(a, "height", 768.0)?,
                    number(a, "x", next_x)?,
                    number(a, "y", next_y)?,
                    ranged(a, "radius", 0.0, 0.0, MAX_RADIUS)?
                ],
            )
            .map_err(err)?;
            save_snapshot(&tx, &bid)?;
            created = Some(("artboardId", bid));
        }
        "artboard_duplicate" => {
            let source = artboard(&tx, text(a, "artboardId")?)?;
            let bid = uuid::Uuid::new_v4().to_string();
            let title = clip(&format!("{} cópia", source["title"].as_str().unwrap_or("")), 512);
            let width = source["width"].as_f64().unwrap_or(1024.0);
            // Sem posição, a cópia nasce à direita da original, na mesma altura.
            let x = number(a, "x", source["x"].as_f64().unwrap_or(0.0) + width + 48.0)?;
            let y = number(a, "y", source["y"].as_f64().unwrap_or(0.0))?;
            tx.execute(
                "INSERT INTO design_artboard(id,page_id,title,html,width,height,x,y,version,status,radius) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,'draft',?9)",
                params![bid, source["pageId"].as_str(), title, source["html"].as_str(), width, source["height"].as_f64(), x, y, source["radius"].as_f64()],
            )
            .map_err(err)?;
            save_snapshot(&tx, &bid)?;
            created = Some(("artboardId", bid));
        }
        "artboard_delete" => {
            tx.execute("DELETE FROM design_artboard WHERE id=?1", [text(a, "artboardId")?]).map_err(err)?;
        }
        "note_add" => {
            let nid = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO design_note(id,page_id,x,y,w,h,text,color,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![nid, text(a, "pageId")?, required_number(a, "x")?, required_number(a, "y")?, size(a, "w", 240.0)?, size(a, "h", 160.0)?, note_text(a)?, color(a)?, crate::util::now_ts_ms()],
            )
            .map_err(err)?;
            created = Some(("noteId", nid));
        }
        "note_update" => {
            let nid = text(a, "noteId")?;
            let current = tx.query_row("SELECT x,y,w,h,text,color FROM design_note WHERE id=?1", [nid], |r| Ok(json!({
                "x":r.get::<_,f64>(0)?,"y":r.get::<_,f64>(1)?,"w":r.get::<_,f64>(2)?,"h":r.get::<_,f64>(3)?,"text":r.get::<_,String>(4)?,"color":r.get::<_,Option<String>>(5)?}))).map_err(err)?;
            let mut n = current;
            for k in ["x", "y", "w", "h", "text", "color"] {
                if let Some(v) = a.get(k) {
                    n[k] = v.clone();
                }
            }
            tx.execute(
                "UPDATE design_note SET x=?2,y=?3,w=?4,h=?5,text=?6,color=?7 WHERE id=?1",
                params![nid, required_number(&n, "x")?, required_number(&n, "y")?, size(&n, "w", 240.0)?, size(&n, "h", 160.0)?, note_text(&n)?, color(&n)?],
            )
            .map_err(err)?;
        }
        "note_delete" => {
            tx.execute("DELETE FROM design_note WHERE id=?1", [text(a, "noteId")?]).map_err(err)?;
        }
        "shape_add" => {
            let sid = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO design_shape(id,page_id,kind,x,y,w,h,data,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![sid, text(a, "pageId")?, shape_kind(a)?, required_number(a, "x")?, required_number(a, "y")?, number(a, "w", 0.0)?, number(a, "h", 0.0)?, shape_data(a)?, crate::util::now_ts_ms()],
            )
            .map_err(err)?;
            created = Some(("shapeId", sid));
        }
        "shape_update" => {
            let sid = text(a, "shapeId")?;
            let mut s = tx.query_row("SELECT kind,x,y,w,h,data FROM design_shape WHERE id=?1", [sid], |r| Ok(json!({
                "kind":r.get::<_,String>(0)?,"x":r.get::<_,f64>(1)?,"y":r.get::<_,f64>(2)?,"w":r.get::<_,f64>(3)?,"h":r.get::<_,f64>(4)?,"data":r.get::<_,String>(5)?}))).map_err(err)?;
            for k in ["kind", "x", "y", "w", "h", "data"] {
                if let Some(v) = a.get(k) {
                    s[k] = v.clone();
                }
            }
            tx.execute(
                "UPDATE design_shape SET kind=?2,x=?3,y=?4,w=?5,h=?6,data=?7 WHERE id=?1",
                params![sid, shape_kind(&s)?, required_number(&s, "x")?, required_number(&s, "y")?, number(&s, "w", 0.0)?, number(&s, "h", 0.0)?, shape_data(&s)?],
            )
            .map_err(err)?;
        }
        "shape_delete" => {
            tx.execute("DELETE FROM design_shape WHERE id=?1", [text(a, "shapeId")?]).map_err(err)?;
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
                // A moldura (cantos) também é do canvas, não do conteúdo.
                b["radius"] = current["radius"].clone();
            }
            if op == "artboard_update" {
                for k in ["title", "html", "width", "height", "x", "y", "radius"] {
                    if let Some(v) = a.get(k) {
                        b[k] = v.clone();
                    }
                }
            }
            // Só conteúdo (título e HTML) vira versão nova; mover, redimensionar e arredondar
            // os cantos não cria versão nem tira a aprovação.
            let changed = op == "artboard_revert"
                || ["title", "html"]
                    .iter()
                    .any(|k| b[k] != current[k]);
            tx.execute("UPDATE design_artboard SET title=?2,html=?3,width=?4,height=?5,x=?6,y=?7,version=?8,status=?9,radius=?10 WHERE id=?1",params![bid,bounded(&b,"title",512)?,bounded(&b,"html",MAX_HTML)?,number(&b,"width",1024.0)?,number(&b,"height",768.0)?,number(&b,"x",0.0)?,number(&b,"y",0.0)?,current["version"].as_i64().unwrap()+i64::from(changed),if changed { "draft" } else { current["status"].as_str().unwrap() },ranged(&b,"radius",0.0,0.0,MAX_RADIUS)?]).map_err(err)?;
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
            let bid = text(a, "artboardId")?;
            let parent = optional(a, "parentId")?;
            if let Some(parent) = &parent {
                // A resposta fica no fio da mesma prancheta.
                let same: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM design_comment WHERE id=?1 AND artboard_id=?2)", params![parent, bid], |r| r.get(0)).map_err(err)?;
                if !same {
                    return Err(format!("Comentário pai não encontrado nesta prancheta: {parent}"));
                }
            }
            let cid = uuid::Uuid::new_v4().to_string();
            let inserted=tx.execute("INSERT INTO design_comment(id,artboard_id,author,text,selector,anchor,point_x,point_y,parent_id,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE NOT EXISTS(SELECT 1 FROM design_comment WHERE artboard_id=?2 AND author=?3 AND trim(text)=?4 AND selector IS ?5 AND anchor IS ?6 AND point_x IS ?7 AND point_y IS ?8 AND parent_id IS ?9 AND resolved=0)",params![cid,bid,author,bounded(a,"text",MAX_TEXT)?.trim(),optional(a,"selector")?,optional_max(a,"anchor",MAX_ANCHOR)?,point(a,"pointX")?,point(a,"pointY")?,parent,crate::util::now_ts_ms()]).map_err(err)?;
            comment_added = Some(inserted > 0);
            if inserted > 0 {
                created = Some(("commentId", cid));
            }
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
    if let Some((key, value)) = created {
        result[key] = json!(value);
    }
    tx.commit().map_err(err)?;
    Ok(result)
}
/// O que o front precisa para abrir a tela de Design: o design canônico e, se pedidos,
/// a página e a prancheta, conferidos contra o próprio design. Só leitura.
fn open_target(c: &Connection, a: &Value) -> Result<Value> {
    let design = canonical_id(c, text(a, "designId")?)?;
    let title: String = c.query_row("SELECT title FROM design WHERE id=?1", [&design], |r| r.get(0)).map_err(err)?;
    let mut page = optional(a, "pageId")?;
    let artboard_id = optional(a, "artboardId")?;
    if let Some(bid) = &artboard_id {
        let board_page: String = c
            .query_row("SELECT page_id FROM design_artboard WHERE id=?1", [bid], |r| r.get(0))
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("Prancheta não encontrada: {bid}"))?;
        if page.as_ref().is_some_and(|p| *p != board_page) {
            return Err("A prancheta não está nessa página".into());
        }
        page = Some(board_page);
    }
    if let Some(pid) = &page
        && design_of_page(c, pid)? != design
    {
        return Err("A página não é deste design".into());
    }
    Ok(json!({ "designId": design, "title": title, "pageId": page, "artboardId": artboard_id }))
}

/// O que a pessoa está vendo em cada design aberto (só em memória): a tela publica com
/// `design_view_set` e o agente lê com `ags design view` antes de mexer no "isto aqui".
#[derive(Default)]
pub(crate) struct ViewStore {
    latest: Option<String>,
    by_design: std::collections::HashMap<String, Value>,
}
/// Quantos designs guardam o que se vê; acima disso, sai o mais antigo.
const MAX_VIEWS: usize = 64;
impl ViewStore {
    pub(crate) fn set(&mut self, design: &str, state: &Value) -> Result<Value> {
        let state = sanitize_view(state)?;
        if !self.by_design.contains_key(design) && self.by_design.len() >= MAX_VIEWS {
            let oldest = self
                .by_design
                .iter()
                .min_by(|a, b| a.1["updatedAt"].as_f64().unwrap_or(0.0).total_cmp(&b.1["updatedAt"].as_f64().unwrap_or(0.0)))
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.by_design.remove(&k);
            }
        }
        self.by_design.insert(design.to_string(), state.clone());
        self.latest = Some(design.to_string());
        Ok(state)
    }
    /// Sem id: o do design aberto mais recentemente.
    pub(crate) fn get(&self, design: Option<&str>) -> Value {
        let id = design.map(str::to_string).or_else(|| self.latest.clone());
        match id.as_deref().and_then(|id| self.by_design.get(id).map(|s| (id, s))) {
            Some((id, state)) => {
                let mut v = state.clone();
                v["designId"] = json!(id);
                v["open"] = json!(true);
                v
            }
            None => json!({ "designId": id, "open": false }),
        }
    }
    pub(crate) fn forget(&mut self, design: &str) {
        self.by_design.remove(design);
        if self.latest.as_deref() == Some(design) {
            self.latest = None;
        }
    }
}
static VIEWS: std::sync::LazyLock<std::sync::Mutex<ViewStore>> = std::sync::LazyLock::new(Default::default);

/// Normaliza o view state que a tela manda: tipos conferidos, listas e textos com teto.
fn sanitize_view(state: &Value) -> Result<Value> {
    let s = state.as_object().ok_or("state precisa ser um objeto")?;
    let short = |v: Option<&Value>, max: usize| -> Value {
        v.and_then(Value::as_str).map_or(Value::Null, |s| json!(clip(s, max)))
    };
    let mode = match s.get("mode").and_then(Value::as_str).unwrap_or("canvas") {
        m @ ("canvas" | "focused") => m,
        _ => return Err("mode precisa ser canvas ou focused".into()),
    };
    let boards = |key: &str| -> Vec<Value> {
        s.get(key).and_then(Value::as_array).map_or_else(Vec::new, |list| {
            list.iter()
                .filter(|b| b["id"].is_string())
                .take(20)
                .map(|b| json!({ "id": short(b.get("id"), 128), "title": short(b.get("title"), 512) }))
                .collect()
        })
    };
    let selected: Vec<Value> = s.get("selected").and_then(Value::as_array).map_or_else(Vec::new, |list| {
        list.iter().filter_map(Value::as_str).take(20).map(|v| json!(clip(v, 128 + 1 + MAX_ANCHOR))).collect()
    });
    let selection: Vec<Value> = s.get("selection").and_then(Value::as_array).map_or_else(Vec::new, |list| {
        list.iter()
            .filter(|v| v.is_object())
            .take(5)
            .map(|v| json!({ "kind": short(v.get("kind"), 64), "label": short(v.get("label"), 512) }))
            .collect()
    });
    let zoom = s.get("zoom").and_then(Value::as_f64).filter(|z| z.is_finite() && *z > 0.0 && *z <= 1000.0);
    let updated = s.get("updatedAt").and_then(Value::as_f64).filter(|t| t.is_finite() && *t >= 0.0);
    Ok(json!({
        "mode": mode,
        "pageId": short(s.get("pageId"), 128),
        "pageName": short(s.get("pageName"), 512),
        "visibleArtboards": boards("visibleArtboards"),
        "selectedArtboards": boards("selectedArtboards"),
        "selected": selected,
        "selection": selection,
        "zoom": zoom,
        "updatedAt": updated.map_or_else(|| json!(crate::util::now_ts_ms()), |t| json!(t as i64)),
    }))
}

/// Ops que não escrevem no banco: não emitem `design-changed`.
fn is_read(op: &str) -> bool {
    matches!(op, "get" | "list" | "open_target" | "view" | "view_set")
}
pub(crate) fn dispatch(app: &tauri::AppHandle, op: &str, args: &Value) -> Result<Value> {
    let db = app.state::<DbConnection>();
    if matches!(op, "view" | "view_set") {
        // O id passa pelo banco só para resolver apelidos; o estado em si fica em memória.
        let design = match optional(args, "designId")? {
            Some(id) => {
                let connection = db.lock().map_err(|e| e.to_string())?;
                Some(canonical_id(&connection, &id).map_err(|_| format!("Design não encontrado: {id}"))?)
            }
            None if op == "view_set" => return Err("Falta designId".into()),
            None => None,
        };
        let mut views = VIEWS.lock().map_err(|e| e.to_string())?;
        return match (op, design) {
            ("view_set", Some(id)) => {
                views.set(&id, args.get("state").unwrap_or(&Value::Null))?;
                Ok(views.get(Some(&id)))
            }
            (_, design) => Ok(views.get(design.as_deref())),
        };
    }
    let result = {
        let mut connection = db.lock().map_err(|e| e.to_string())?;
        execute(&mut connection, op, args)?
    };
    if op == "delete"
        && let (Ok(mut views), Some(id)) = (VIEWS.lock(), result["id"].as_str())
    {
        views.forget(id);
    }
    if !is_read(op) {
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
command!(design_artboard_duplicate, "artboard_duplicate");
command!(design_artboard_delete, "artboard_delete");
command!(design_page_rename, "page_rename");
command!(design_page_delete, "page_delete");
command!(design_page_reorder, "page_reorder");
command!(design_note_add, "note_add");
command!(design_note_update, "note_update");
command!(design_note_delete, "note_delete");
command!(design_shape_add, "shape_add");
command!(design_shape_update, "shape_update");
command!(design_shape_delete, "shape_delete");
command!(design_view_set, "view_set");
command!(design_view_get, "view");
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
                .unwrap(),41
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
            c.execute("INSERT INTO design_artboard(id,page_id,title,html,width,height,x,y,version,status) VALUES(?1,'duplicate-page',?2,'<p>real design</p>',720,560,0,0,1,'approved')",params![format!("copy-{i}"),title]).unwrap();
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
                .unwrap(),45
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

    /// Um banco de antes da tela de Design (sem as colunas e tabelas novas) migra sem perder nada,
    /// e rodar de novo não muda nada.
    #[test]
    fn a_migracao_da_tela_de_design_e_aditiva_sobre_um_banco_antigo() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE design (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, mission_id TEXT, owner_tab_id TEXT,
                title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft');
            CREATE TABLE design_page (id TEXT PRIMARY KEY, design_id TEXT NOT NULL REFERENCES design(id) ON DELETE CASCADE,
                name TEXT NOT NULL, sort_order INTEGER NOT NULL);
            CREATE TABLE design_artboard (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES design_page(id) ON DELETE CASCADE,
                title TEXT NOT NULL, html TEXT NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
                x REAL NOT NULL, y REAL NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL);
            CREATE TABLE design_artboard_version (artboard_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL,
                PRIMARY KEY(artboard_id,version));
            CREATE TABLE design_comment (id TEXT PRIMARY KEY, artboard_id TEXT NOT NULL REFERENCES design_artboard(id) ON DELETE CASCADE,
                author TEXT NOT NULL, text TEXT NOT NULL, selector TEXT, resolved INTEGER NOT NULL DEFAULT 0);
            INSERT INTO design VALUES('d','w',NULL,NULL,'Antigo','approved');
            INSERT INTO design_page VALUES('p','d','Página',0);
            INSERT INTO design_artboard VALUES('b','p','Home','<p>old</p>',800,600,10,20,3,'approved');
            INSERT INTO design_artboard_version VALUES('b',3,'{\"id\":\"b\",\"version\":3}');
            INSERT INTO design_comment VALUES('c','b','user','Mudar','#x',0);").unwrap();
        for _ in 0..2 {
            migrate(&c).unwrap();
            migrate_v37(&c).unwrap();
        }
        let d = get(&c, "d").unwrap();
        let b = &d["pages"][0]["artboards"][0];
        assert_eq!(b["html"], "<p>old</p>");
        assert_eq!(b["version"], 3);
        assert_eq!(b["status"], "approved");
        assert_eq!(b["radius"], 0.0);
        assert_eq!(b["hidden"], false);
        assert_eq!(b["versions"].as_array().unwrap().len(), 1);
        let cm = &b["comments"][0];
        assert_eq!(cm["selector"], "#x");
        assert_eq!(cm["anchor"], Value::Null);
        assert_eq!(cm["createdAt"], Value::Null);
        assert_eq!(d["pages"][0]["notes"], json!([]));
        assert_eq!(d["pages"][0]["shapes"], json!([]));
    }
    #[test]
    fn mover_redimensionar_e_arredondar_nao_criam_versao() {
        let (mut c, _, _, bid) = setup();
        execute(&mut c, "artboard_approve", &json!({"artboardId":bid})).unwrap();
        let d = execute(&mut c, "artboard_update", &json!({"artboardId":bid,"x":5,"y":6,"width":390,"height":844,"radius":24})).unwrap();
        let b = &d["pages"][0]["artboards"][0];
        assert_eq!((b["version"].clone(), b["status"].clone()), (json!(1), json!("approved")));
        assert_eq!((b["width"].clone(), b["radius"].clone()), (json!(390.0), json!(24.0)));
        assert_eq!(b["versions"].as_array().unwrap().len(), 1);
        for bad in [json!(-1), json!(5000), json!("NaN")] {
            assert!(execute(&mut c, "artboard_update", &json!({"artboardId":bid,"radius":bad})).is_err());
        }
        // A volta para uma versão não desfaz a moldura.
        execute(&mut c, "artboard_update", &json!({"artboardId":bid,"html":"<p>v2</p>"})).unwrap();
        let d = execute(&mut c, "artboard_revert", &json!({"artboardId":bid,"version":1})).unwrap();
        assert_eq!(d["pages"][0]["artboards"][0]["radius"], 24.0);
    }
    #[test]
    fn duplicar_e_apagar_prancheta() {
        let (mut c, _, pid, bid) = setup();
        execute(&mut c, "artboard_update", &json!({"artboardId":bid,"radius":12})).unwrap();
        let d = execute(&mut c, "artboard_duplicate", &json!({"artboardId":bid})).unwrap();
        let copy = d["artboardId"].as_str().unwrap().to_string();
        let b = &d["pages"][0]["artboards"][1];
        assert_eq!(b["id"], copy.as_str());
        assert_eq!(b["title"], "Home cópia");
        assert_eq!(b["html"], "<h1>Olá</h1>");
        assert_eq!((b["x"].clone(), b["y"].clone()), (json!(1072.0), json!(0.0)));
        assert_eq!((b["version"].clone(), b["status"].clone(), b["radius"].clone()), (json!(1), json!("draft"), json!(12.0)));
        let d = execute(&mut c, "artboard_duplicate", &json!({"artboardId":bid,"x":0,"y":900})).unwrap();
        assert_eq!(d["pages"][0]["artboards"][2]["y"], 900.0);
        let d = execute(&mut c, "artboard_delete", &json!({"artboardId":copy})).unwrap();
        assert_eq!(d["pages"][0]["artboards"].as_array().unwrap().len(), 2);
        assert!(execute(&mut c, "artboard_delete", &json!({"artboardId":copy})).is_err());
        let d = execute(&mut c, "artboard_add", &json!({"pageId":pid,"title":"T","html":"x","radius":8})).unwrap();
        assert!(d["artboardId"].is_string());
        assert_eq!(d["pages"][0]["artboards"][2]["radius"], 8.0);
    }
    #[test]
    fn paginas_renomeiam_reordenam_e_a_ultima_nao_se_apaga() {
        let (mut c, did, pid, _) = setup();
        assert!(execute(&mut c, "page_delete", &json!({"pageId":pid})).is_err());
        let d = execute(&mut c, "page_add", &json!({"designId":did,"name":"Segunda"})).unwrap();
        let second = d["pageId"].as_str().unwrap().to_string();
        assert_eq!(d["pages"][1]["id"], second.as_str());
        let d = execute(&mut c, "page_rename", &json!({"pageId":second,"name":" Fluxo "})).unwrap();
        assert_eq!(d["pages"][1]["name"], "Fluxo");
        let d = execute(&mut c, "page_reorder", &json!({"designId":did,"pageIds":[second,pid]})).unwrap();
        assert_eq!(d["pages"][0]["id"], second.as_str());
        for bad in [json!([second]), json!([second, second]), json!([second, "outra"])] {
            assert!(execute(&mut c, "page_reorder", &json!({"designId":did,"pageIds":bad})).is_err());
        }
        // Apagar leva junto as pranchetas da página; a outra fica e não se apaga mais.
        let d = execute(&mut c, "page_delete", &json!({"pageId":pid})).unwrap();
        assert_eq!(d["pages"].as_array().unwrap().len(), 1);
        assert!(execute(&mut c, "page_delete", &json!({"pageId":second})).is_err());
        assert_eq!(c.query_row("SELECT count(*) FROM design_artboard", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert!(execute(&mut c, "page_rename", &json!({"pageId":"nao-existe","name":"x"})).is_err());
    }
    #[test]
    fn notas_e_formas_do_canvas() {
        let (mut c, did, pid, _) = setup();
        let d = execute(&mut c, "note_add", &json!({"pageId":pid,"x":10,"y":-20,"text":"lembrar","color":"yellow"})).unwrap();
        let nid = d["noteId"].as_str().unwrap().to_string();
        let n = &d["pages"][0]["notes"][0];
        assert_eq!((n["w"].clone(), n["h"].clone(), n["text"].clone()), (json!(240.0), json!(160.0), json!("lembrar")));
        let d = execute(&mut c, "note_update", &json!({"noteId":nid,"text":"feito","w":300,"color":null})).unwrap();
        let n = &d["pages"][0]["notes"][0];
        assert_eq!((n["text"].clone(), n["w"].clone(), n["x"].clone(), n["color"].clone()), (json!("feito"), json!(300.0), json!(10.0), Value::Null));
        for bad in [
            json!({"pageId":pid,"y":0}),
            json!({"pageId":pid,"x":"inf","y":0}),
            json!({"pageId":pid,"x":0,"y":0,"w":0}),
            json!({"pageId":pid,"x":0,"y":0,"text":"a".repeat(MAX_TEXT+1)}),
            json!({"pageId":pid,"x":0,"y":0,"color":"<script>"}),
            json!({"pageId":"nao-existe","x":0,"y":0}),
        ] {
            assert!(execute(&mut c, "note_add", &bad).is_err(), "{bad}");
        }
        let d = execute(&mut c, "shape_add", &json!({"pageId":pid,"kind":"arrow","x":0,"y":0,"w":-40,"h":10,"data":{"stroke":"red","points":[[0,0],[1,1]]}})).unwrap();
        let sid = d["shapeId"].as_str().unwrap().to_string();
        assert_eq!(d["pages"][0]["shapes"][0]["data"]["points"][1], json!([1, 1]));
        let d = execute(&mut c, "shape_update", &json!({"shapeId":sid,"kind":"line","data":"{\"stroke\":\"blue\"}"})).unwrap();
        let s = &d["pages"][0]["shapes"][0];
        assert_eq!((s["kind"].clone(), s["data"]["stroke"].clone(), s["w"].clone()), (json!("line"), json!("blue"), json!(-40.0)));
        assert!(execute(&mut c, "shape_add", &json!({"pageId":pid,"kind":"star","x":0,"y":0})).is_err());
        assert!(execute(&mut c, "shape_add", &json!({"pageId":pid,"kind":"rect","x":0,"y":0,"data":"não é json"})).is_err());
        assert!(execute(&mut c, "shape_update", &json!({"shapeId":sid,"kind":"star"})).is_err());
        execute(&mut c, "shape_delete", &json!({"shapeId":sid})).unwrap();
        let d = execute(&mut c, "note_delete", &json!({"noteId":nid})).unwrap();
        assert_eq!((d["pages"][0]["notes"].clone(), d["pages"][0]["shapes"].clone()), (json!([]), json!([])));
        // Apagar o design leva notas e formas junto.
        execute(&mut c, "note_add", &json!({"pageId":pid,"x":0,"y":0})).unwrap();
        execute(&mut c, "delete", &json!({"designId":did})).unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM design_note", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    #[test]
    fn comentarios_com_ancora_ponto_e_fio() {
        let (mut c, _, pid, bid) = setup();
        let args = json!({"artboardId":bid,"author":"user","text":"Aqui","anchor":"main > button:nth-of-type(2)","pointX":0.25,"pointY":1});
        let d = execute(&mut c, "comment_add", &args).unwrap();
        let cid = d["commentId"].as_str().unwrap().to_string();
        let cm = &d["pages"][0]["artboards"][0]["comments"][0];
        assert_eq!((cm["anchor"].clone(), cm["pointX"].clone(), cm["pointY"].clone()), (json!("main > button:nth-of-type(2)"), json!(0.25), json!(1.0)));
        assert!(cm["createdAt"].as_i64().unwrap() > 0);
        // O mesmo pino de novo não duplica; outro ponto é outro comentário.
        assert_eq!(execute(&mut c, "comment_add", &args).unwrap()["commentAdded"], false);
        let mut other = args.clone();
        other["pointX"] = json!(0.5);
        assert_eq!(execute(&mut c, "comment_add", &other).unwrap()["commentAdded"], true);
        let d = execute(&mut c, "comment_add", &json!({"artboardId":bid,"author":"agent","text":"Feito","parentId":cid})).unwrap();
        assert_eq!(d["pages"][0]["artboards"][0]["comments"][2]["parentId"], cid.as_str());
        let elsewhere = execute(&mut c, "artboard_add", &json!({"pageId":pid,"title":"Outra","html":"x"})).unwrap()["artboardId"].clone();
        for bad in [
            json!({"artboardId":bid,"author":"user","text":"x","anchor":"a".repeat(MAX_ANCHOR+1)}),
            json!({"artboardId":bid,"author":"user","text":"x","pointX":1.5}),
            json!({"artboardId":bid,"author":"user","text":"x","pointY":"NaN"}),
            json!({"artboardId":bid,"author":"user","text":"a".repeat(MAX_TEXT+1)}),
            json!({"artboardId":bid,"author":"user","text":"x","parentId":"nao-existe"}),
            json!({"artboardId":elsewhere,"author":"user","text":"x","parentId":cid}),
        ] {
            assert!(execute(&mut c, "comment_add", &bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn abrir_confere_pagina_e_prancheta_do_design() {
        let (mut c, did, pid, bid) = setup();
        let t = execute(&mut c, "open_target", &json!({"designId":did,"artboardId":bid})).unwrap();
        assert_eq!(t, json!({"designId":did,"title":"Design","pageId":pid,"artboardId":bid}));
        let t = execute(&mut c, "open_target", &json!({"designId":did})).unwrap();
        assert_eq!((t["pageId"].clone(), t["artboardId"].clone()), (Value::Null, Value::Null));
        let other = execute(&mut c, "create", &json!({"workspace":"w","title":"Outro"})).unwrap();
        let other_page = execute(&mut c, "page_add", &json!({"designId":other["id"],"name":"P"})).unwrap()["pageId"].clone();
        assert!(execute(&mut c, "open_target", &json!({"designId":did,"pageId":other_page})).is_err());
        assert!(execute(&mut c, "open_target", &json!({"designId":did,"pageId":other_page,"artboardId":bid})).is_err());
        assert!(execute(&mut c, "open_target", &json!({"designId":"nao-existe"})).is_err());
    }
    #[test]
    fn o_view_state_fica_por_design_e_lembra_o_mais_recente() {
        let mut views = ViewStore::default();
        assert_eq!(views.get(None), json!({"designId":null,"open":false}));
        let many: Vec<Value> = (0..30).map(|i| json!({"id":format!("b{i}"),"title":"t"})).collect();
        let state = json!({"mode":"focused","pageId":"p","pageName":"Página","visibleArtboards":many,"selectedArtboards":[{"id":"b1","title":"Home"}],
            "selected":["b1#main > h1"],"selection":[{"kind":"text","label":"Título"}],"zoom":1.5,"updatedAt":1000,"extra":"fora"});
        let saved = views.set("d1", &state).unwrap();
        assert_eq!(saved["visibleArtboards"].as_array().unwrap().len(), 20);
        assert!(saved.get("extra").is_none());
        views.set("d2", &json!({"mode":"canvas","zoom":"x"})).unwrap();
        let latest = views.get(None);
        assert_eq!((latest["designId"].clone(), latest["open"].clone(), latest["zoom"].clone()), (json!("d2"), json!(true), Value::Null));
        let first = views.get(Some("d1"));
        assert_eq!((first["mode"].clone(), first["selected"][0].clone(), first["updatedAt"].clone()), (json!("focused"), json!("b1#main > h1"), json!(1000)));
        assert!(views.set("d1", &json!({"mode":"outro"})).is_err());
        assert!(views.set("d1", &json!("texto")).is_err());
        views.forget("d2");
        assert_eq!(views.get(None)["open"], false);
        assert_eq!(views.get(Some("d1"))["open"], true);
        for i in 0..(MAX_VIEWS + 5) {
            views.set(&format!("x{i}"), &json!({"updatedAt": i})).unwrap();
        }
        assert!(views.by_design.len() <= MAX_VIEWS);
        assert_eq!(views.get(None)["designId"], format!("x{}", MAX_VIEWS + 4));
    }
}
