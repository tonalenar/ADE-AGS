//! Conversaciones por proyecto: cada una es un canvas con varios terminales.
//!
//! Al cambiar de conversación, la lista de terminales de la que se va se guarda acá (para
//! reabrirlos después) y sus terminales se cierran. El canvas en sí (nodos, notas,
//! posiciones) lo guarda otro módulo; acá solo vive el cadastro y el snapshot de terminales.

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, Row, params};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::database::DbConnection;
use crate::util::now_ts;

/// Largo máximo (en caracteres) de los títulos.
const TITLE_MAX_CHARS: usize = 120;
/// Largo máximo (en caracteres) de la clave del proyecto y del cwd.
const TEXT_MAX_CHARS: usize = 1024;
/// Cuántos terminales puede guardar una conversación.
const TERMINALS_MAX_ITEMS: usize = 24;
/// Tamaño máximo, serializado, de la lista de terminales.
const TERMINALS_MAX_BYTES: usize = 64 * 1024;

const COLUMNS: &str = "id, workspace_id, project_key, cwd, title, custom_title, pinned, hidden, \
     state, terminals, created_at, last_active_at";

/// Una conversación tal como la ve el frontend.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub workspace_id: String,
    pub project_key: String,
    pub cwd: String,
    pub title: Option<String>,
    pub custom_title: Option<String>,
    pub pinned: bool,
    pub hidden: bool,
    pub state: String,
    pub terminals: Value,
    pub created_at: i64,
    pub last_active_at: i64,
}

/// Cambios sobre una conversación. Cada campo distingue "no tocar" (ausente) de "limpiar":
/// `customTitle: null` borra el título propio y ausente lo deja como estaba.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub custom_title: Option<Option<String>>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub hidden: Option<bool>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub terminals: Option<Value>,
    #[serde(default)]
    pub touch: Option<bool>,
}

/// `Option<Option<T>>` que distingue ausente (`None`) de `null` (`Some(None)`).
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Quita controles (saltos de línea incluidos) y espacios de los extremos. Vacío = `None`.
fn clean_title(raw: &str) -> Option<String> {
    let spaced: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = spaced.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.chars().take(TITLE_MAX_CHARS).collect())
    }
}

/// Título propio: igual que el título, pero pasarse del máximo es un error y no un recorte,
/// porque lo escribió la persona a propósito.
fn clean_custom_title(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let spaced: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = spaced.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > TITLE_MAX_CHARS {
        return Err(format!("O título personalizado passa de {TITLE_MAX_CHARS} caracteres."));
    }
    Ok(Some(t.to_string()))
}

/// Valida un texto obligatorio (clave de proyecto, cwd): no vacío y con largo máximo.
fn check_text(what: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{what} não pode ficar vazio."));
    }
    if value.chars().count() > TEXT_MAX_CHARS {
        return Err(format!("{what} passa de {TEXT_MAX_CHARS} caracteres."));
    }
    Ok(())
}

fn validate_state(state: &str) -> Result<String, String> {
    match state {
        "active" | "saved" => Ok(state.to_string()),
        otro => Err(format!("Estado inválido '{otro}': use 'active' ou 'saved'.")),
    }
}

/// Quantas conexões (cordas) uma conversa guarda: bem acima do que cabe em 24 terminais.
const LINKS_MAX_ITEMS: usize = 300;

/// Valida o que a conversa guarda dos terminais e devolve a forma serializada.
///
/// Aceita as duas formas: a lista de terminais (a antiga) e o objeto `{ terminals: [...], links: [[a, b], ...] }`
/// que o frontend grava (as conexões entre os terminais vão junto). Antes só valia a lista, e salvar a conversa
/// ao trocar de uma para outra falhava sempre.
fn validate_terminals(value: &Value) -> Result<String, String> {
    let (items, links) = match value {
        Value::Array(items) => (items, None),
        Value::Object(map) => (
            map.get("terminals")
                .and_then(Value::as_array)
                .ok_or_else(|| "Os terminais da conversa precisam ser uma lista.".to_string())?,
            map.get("links"),
        ),
        _ => return Err("Os terminais da conversa precisam ser uma lista.".to_string()),
    };
    if items.len() > TERMINALS_MAX_ITEMS {
        return Err(format!("Uma conversa guarda no máximo {TERMINALS_MAX_ITEMS} terminais."));
    }
    if items.iter().any(|item| !item.is_object()) {
        return Err("Cada terminal da conversa precisa ser um objeto.".to_string());
    }
    if let Some(links) = links {
        let pairs = links
            .as_array()
            .ok_or_else(|| "As conexões da conversa precisam ser uma lista.".to_string())?;
        let valid = |pair: &Value| {
            pair.as_array().is_some_and(|p| p.len() == 2 && p.iter().all(|n| n.as_u64().is_some_and(|i| (i as usize) < items.len())))
        };
        if pairs.len() > LINKS_MAX_ITEMS || !pairs.iter().all(valid) {
            return Err("As conexões da conversa precisam ser pares de posições de terminais.".to_string());
        }
    }
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if json.len() > TERMINALS_MAX_BYTES {
        return Err("Os terminais da conversa passam de 64 KB.".to_string());
    }
    Ok(json)
}

fn from_row(row: &Row) -> SqlResult<Conversation> {
    let terminals_text: String = row.get(9)?;
    let terminals = serde_json::from_str(&terminals_text).unwrap_or_else(|_| Value::Array(vec![]));
    Ok(Conversation {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_key: row.get(2)?,
        cwd: row.get(3)?,
        title: row.get(4)?,
        custom_title: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        hidden: row.get::<_, i64>(7)? != 0,
        state: row.get(8)?,
        terminals,
        created_at: row.get(10)?,
        last_active_at: row.get(11)?,
    })
}

fn get_conversation(conn: &Connection, id: &str) -> Result<Conversation, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM project_conversations WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| "Conversa não encontrada.".to_string())
}

pub(crate) fn create_conversation(
    conn: &Connection,
    workspace_id: &str,
    project_key: &str,
    cwd: &str,
    title: Option<&str>,
) -> Result<Conversation, String> {
    check_text("A chave do projeto", project_key)?;
    check_text("O diretório (cwd)", cwd)?;
    let title = title.and_then(clean_title);
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    conn.execute(
        "INSERT INTO project_conversations
            (id, workspace_id, project_key, cwd, title, custom_title, pinned, hidden,
             state, terminals, created_at, last_active_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, 'active', '[]', ?6, ?6)",
        params![id, workspace_id, project_key, cwd, title, now],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(_, _) if !workspace_exists(conn, workspace_id) => {
            "Workspace inexistente.".to_string()
        }
        outro => db_err(outro),
    })?;
    get_conversation(conn, &id)
}

fn workspace_exists(conn: &Connection, workspace_id: &str) -> bool {
    conn.query_row("SELECT 1 FROM workspaces WHERE id = ?1", [workspace_id], |_| Ok(()))
        .is_ok()
}

/// Fijadas primero, después la más reciente. Incluye las ocultas: el frontend las filtra.
pub(crate) fn list_conversations(
    conn: &Connection,
    workspace_id: &str,
    project_key: Option<&str>,
) -> Result<Vec<Conversation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM project_conversations
             WHERE workspace_id = ?1 AND (?2 IS NULL OR project_key = ?2)
             ORDER BY pinned DESC, last_active_at DESC, created_at DESC, id"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![workspace_id, project_key], from_row)
        .map_err(db_err)?;
    rows.collect::<SqlResult<Vec<_>>>().map_err(db_err)
}

pub(crate) fn update_conversation(
    conn: &mut Connection,
    id: &str,
    patch: &ConversationPatch,
) -> Result<Conversation, String> {
    let tx = conn.transaction().map_err(db_err)?;
    let current = get_conversation(&tx, id)?;

    let title = match &patch.title {
        Some(t) => clean_title(t),
        None => current.title.clone(),
    };
    let custom_title = match &patch.custom_title {
        Some(v) => clean_custom_title(v.clone())?,
        None => current.custom_title.clone(),
    };
    let pinned = patch.pinned.unwrap_or(current.pinned);
    let hidden = patch.hidden.unwrap_or(current.hidden);
    let state = match &patch.state {
        Some(s) => validate_state(s)?,
        None => current.state.clone(),
    };
    let (terminals_json, terminals_changed) = match &patch.terminals {
        Some(v) => (validate_terminals(v)?, *v != current.terminals),
        None => (
            serde_json::to_string(&current.terminals).map_err(|e| e.to_string())?,
            false,
        ),
    };

    let touch = patch.touch == Some(true) || state != current.state || terminals_changed;
    let last_active_at = if touch { now_ts() } else { current.last_active_at };

    tx.execute(
        "UPDATE project_conversations
         SET title = ?2, custom_title = ?3, pinned = ?4, hidden = ?5,
             state = ?6, terminals = ?7, last_active_at = ?8
         WHERE id = ?1",
        params![
            id,
            title,
            custom_title,
            pinned as i64,
            hidden as i64,
            state,
            terminals_json,
            last_active_at
        ],
    )
    .map_err(db_err)?;
    let updated = get_conversation(&tx, id)?;
    tx.commit().map_err(db_err)?;
    Ok(updated)
}

pub(crate) fn delete_conversation(conn: &Connection, id: &str) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM project_conversations WHERE id = ?1", [id])
        .map_err(db_err)?;
    if n == 0 {
        return Err("Conversa não encontrada.".to_string());
    }
    Ok(())
}

/// Marca `id` como la conversación activa del proyecto y las demás del mismo proyecto como
/// 'saved'. `None` deja todas guardadas. Las de otros proyectos no se tocan.
pub(crate) fn set_active_conversation(
    conn: &mut Connection,
    workspace_id: &str,
    project_key: &str,
    id: Option<&str>,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(db_err)?;
    if let Some(id) = id {
        let owner: Option<(String, String)> = tx
            .query_row(
                "SELECT workspace_id, project_key FROM project_conversations WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        match owner {
            Some((w, p)) if w == workspace_id && p == project_key => {}
            _ => return Err("Conversa não encontrada neste projeto.".to_string()),
        }
    }
    let now = now_ts();
    // Solo toca las filas cuyo estado realmente cambia; así `last_active_at` solo se mueve
    // en las que cambiaron.
    tx.execute(
        "UPDATE project_conversations
         SET state = CASE WHEN id = ?3 THEN 'active' ELSE 'saved' END,
             last_active_at = ?4
         WHERE workspace_id = ?1 AND project_key = ?2
           AND state <> CASE WHEN id = ?3 THEN 'active' ELSE 'saved' END",
        params![workspace_id, project_key, id, now],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

#[tauri::command]
pub fn db_conversation_create(
    workspace_id: String,
    project_key: String,
    cwd: String,
    title: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<Conversation, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    create_conversation(&conn, &workspace_id, &project_key, &cwd, title.as_deref())
}

#[tauri::command]
pub fn db_conversation_list(
    workspace_id: String,
    project_key: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Conversation>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    list_conversations(&conn, &workspace_id, project_key.as_deref())
}

#[tauri::command]
pub fn db_conversation_update(
    id: String,
    patch: ConversationPatch,
    db: tauri::State<DbConnection>,
) -> Result<Conversation, String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    update_conversation(&mut conn, &id, &patch)
}

#[tauri::command]
pub fn db_conversation_delete(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    delete_conversation(&conn, &id)
}

#[tauri::command]
pub fn db_conversation_set_active(
    workspace_id: String,
    project_key: String,
    id: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    set_active_conversation(&mut conn, &workspace_id, &project_key, id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_db;
    use serde_json::json;

    /// Base en memoria con dos workspaces.
    fn setup() -> Connection {
        let conn = test_db();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
             INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws2', 'WS2', 0, 0);",
        )
        .unwrap();
        conn
    }

    fn new(conn: &Connection, project: &str, title: Option<&str>) -> Conversation {
        create_conversation(conn, "ws", project, "/proj", title).unwrap()
    }

    fn set_last_active(conn: &Connection, id: &str, ts: i64) {
        conn.execute(
            "UPDATE project_conversations SET last_active_at = ?2 WHERE id = ?1",
            params![id, ts],
        )
        .unwrap();
    }

    fn patch(v: Value) -> ConversationPatch {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn crear_deja_la_conversacion_activa_y_recorta_el_titulo() {
        let conn = setup();
        let largo = "x".repeat(200);
        let c = create_conversation(&conn, "ws", "/proj", "/proj/sub", Some(&format!("  a\nb {largo}  "))).unwrap();
        assert_eq!(c.state, "active");
        assert!(!c.pinned && !c.hidden);
        assert_eq!(c.terminals, json!([]));
        assert_eq!(c.custom_title, None);
        let title = c.title.unwrap();
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.starts_with("a b x"));
        assert!(!title.contains('\n'));
        assert_eq!(c.cwd, "/proj/sub");
    }

    #[test]
    fn crear_rechaza_claves_vacias_o_enormes_y_workspace_inexistente() {
        let conn = setup();
        assert!(create_conversation(&conn, "ws", "  ", "/c", None).is_err());
        assert!(create_conversation(&conn, "ws", "/p", "", None).is_err());
        let enorme = "p".repeat(TEXT_MAX_CHARS + 1);
        assert!(create_conversation(&conn, "ws", &enorme, "/c", None).is_err());
        assert!(create_conversation(&conn, "no-existe", "/p", "/c", None).is_err());
    }

    #[test]
    fn listar_ordena_fijadas_primero_y_filtra_por_proyecto() {
        let mut conn = setup();
        let a = new(&conn, "/p1", Some("a"));
        let b = new(&conn, "/p1", Some("b"));
        let c = new(&conn, "/p1", Some("c"));
        let d = new(&conn, "/p2", Some("d"));
        set_last_active(&conn, &a.id, 100);
        set_last_active(&conn, &b.id, 300);
        set_last_active(&conn, &c.id, 200);
        set_last_active(&conn, &d.id, 50);
        // Fijar `a` la pone primera aunque sea la más vieja.
        update_conversation(&mut conn, &a.id, &patch(json!({"pinned": true}))).unwrap();
        // `update` sin touch no debe haber movido `last_active_at` de `a`.
        set_last_active(&conn, &a.id, 100);

        let ids: Vec<String> = list_conversations(&conn, "ws", Some("/p1"))
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec![a.id.clone(), b.id.clone(), c.id.clone()]);

        let todas = list_conversations(&conn, "ws", None).unwrap();
        assert_eq!(todas.len(), 4);
        assert_eq!(todas.last().unwrap().id, d.id);
        assert!(list_conversations(&conn, "ws2", None).unwrap().is_empty());
    }

    #[test]
    fn patch_custom_title_distingue_ausente_de_null() {
        let mut conn = setup();
        let c = new(&conn, "/p", None);
        let up = |conn: &mut Connection, v: Value| update_conversation(conn, &c.id, &patch(v)).unwrap();

        assert_eq!(up(&mut conn, json!({"customTitle": "Mi título"})).custom_title.as_deref(), Some("Mi título"));
        // Ausente: no toca.
        assert_eq!(up(&mut conn, json!({"pinned": true})).custom_title.as_deref(), Some("Mi título"));
        // Vacío: se guarda como NULL.
        assert_eq!(up(&mut conn, json!({"customTitle": "   "})).custom_title, None);
        // null: limpia.
        up(&mut conn, json!({"customTitle": "otro"}));
        assert_eq!(up(&mut conn, json!({"customTitle": null})).custom_title, None);

        let largo = "t".repeat(TITLE_MAX_CHARS + 1);
        let err = update_conversation(&mut conn, &c.id, &patch(json!({"customTitle": largo})));
        assert!(err.is_err());
    }

    #[test]
    fn patch_pinned_hidden_state_y_errores() {
        let mut conn = setup();
        let c = new(&conn, "/p", None);
        let r = update_conversation(&mut conn, &c.id, &patch(json!({"pinned": true, "hidden": true}))).unwrap();
        assert!(r.pinned && r.hidden);
        let r = update_conversation(&mut conn, &c.id, &patch(json!({"pinned": false}))).unwrap();
        assert!(!r.pinned && r.hidden);
        assert_eq!(update_conversation(&mut conn, &c.id, &patch(json!({"state": "saved"}))).unwrap().state, "saved");
        assert!(update_conversation(&mut conn, &c.id, &patch(json!({"state": "rota"}))).is_err());
        assert!(update_conversation(&mut conn, "no-existe", &patch(json!({"pinned": true}))).is_err());
    }

    #[test]
    fn terminals_aceptan_lista_de_objetos_y_rechazan_lo_demas() {
        let mut conn = setup();
        let c = new(&conn, "/p", None);
        let up = |conn: &mut Connection, v: Value| update_conversation(conn, &c.id, &patch(json!({"terminals": v})));

        let ok = up(&mut conn, json!([{"tabId": "t1", "cwd": "/a"}, {"tabId": "t2"}])).unwrap();
        assert_eq!(ok.terminals, json!([{"tabId": "t1", "cwd": "/a"}, {"tabId": "t2"}]));

        let veinticuatro: Vec<Value> = (0..TERMINALS_MAX_ITEMS).map(|i| json!({"n": i})).collect();
        assert!(up(&mut conn, Value::Array(veinticuatro)).is_ok());

        let veinticinco: Vec<Value> = (0..=TERMINALS_MAX_ITEMS).map(|i| json!({"n": i})).collect();
        assert!(up(&mut conn, Value::Array(veinticinco)).is_err());
        assert!(up(&mut conn, json!({"tabId": "t1"})).is_err(), "objeto sem a lista de terminais");
        let com_cordas = json!({"terminals": [{"tabId": "t1"}, {"tabId": "t2"}], "links": [[0, 1]]});
        assert_eq!(up(&mut conn, com_cordas.clone()).unwrap().terminals, com_cordas);
        assert!(up(&mut conn, json!({"terminals": [{"tabId": "t1"}], "links": [[0, 5]]})).is_err(), "corda para um terminal que não existe");
        assert!(up(&mut conn, json!({"terminals": [], "links": "x"})).is_err(), "cordas fora de lista");
        assert!(up(&mut conn, json!("texto")).is_err(), "string no es array");
        assert!(up(&mut conn, json!([{"ok": 1}, 7])).is_err(), "item no objeto");
        assert!(up(&mut conn, json!([null])).is_err(), "null no es objeto");
        let grande = json!([{"dato": "a".repeat(TERMINALS_MAX_BYTES)}]);
        assert!(up(&mut conn, grande).is_err(), "más de 64 KB");
    }

    #[test]
    fn touch_y_cambios_de_estado_o_terminales_actualizan_last_active() {
        let mut conn = setup();
        let c = new(&conn, "/p", None);
        set_last_active(&conn, &c.id, 1);
        let last = |conn: &mut Connection, v: Value| {
            update_conversation(conn, &c.id, &patch(v)).unwrap().last_active_at
        };

        // Cambios que no son de actividad: no mueven el reloj.
        assert_eq!(last(&mut conn, json!({"pinned": true, "customTitle": "x"})), 1);
        // Mismo estado y mismos terminales: no es un cambio.
        assert_eq!(last(&mut conn, json!({"state": "active", "terminals": []})), 1);
        // touch explícito.
        assert!(last(&mut conn, json!({"touch": true})) > 1);

        set_last_active(&conn, &c.id, 1);
        assert!(last(&mut conn, json!({"terminals": [{"tabId": "t"}]})) > 1);
        set_last_active(&conn, &c.id, 1);
        assert!(last(&mut conn, json!({"state": "saved"})) > 1);
    }

    #[test]
    fn set_active_deja_una_sola_activa_por_proyecto() {
        let mut conn = setup();
        let a = new(&conn, "/p1", None);
        let b = new(&conn, "/p1", None);
        let otro = new(&conn, "/p2", None);
        assert_eq!(get_conversation(&conn, &otro.id).unwrap().state, "active");

        set_active_conversation(&mut conn, "ws", "/p1", Some(&a.id)).unwrap();
        assert_eq!(get_conversation(&conn, &a.id).unwrap().state, "active");
        assert_eq!(get_conversation(&conn, &b.id).unwrap().state, "saved");
        // El otro proyecto no se toca.
        assert_eq!(get_conversation(&conn, &otro.id).unwrap().state, "active");

        set_active_conversation(&mut conn, "ws", "/p1", Some(&b.id)).unwrap();
        assert_eq!(get_conversation(&conn, &a.id).unwrap().state, "saved");
        assert_eq!(get_conversation(&conn, &b.id).unwrap().state, "active");

        set_active_conversation(&mut conn, "ws", "/p1", None).unwrap();
        assert_eq!(get_conversation(&conn, &a.id).unwrap().state, "saved");
        assert_eq!(get_conversation(&conn, &b.id).unwrap().state, "saved");
        assert_eq!(get_conversation(&conn, &otro.id).unwrap().state, "active");

        // Una conversación de otro proyecto no se puede activar por este proyecto.
        assert!(set_active_conversation(&mut conn, "ws", "/p1", Some(&otro.id)).is_err());
    }

    #[test]
    fn delete_borra_y_repetir_da_error() {
        let conn = setup();
        let c = new(&conn, "/p", None);
        delete_conversation(&conn, &c.id).unwrap();
        assert!(get_conversation(&conn, &c.id).is_err());
        assert!(delete_conversation(&conn, &c.id).is_err());
    }

    #[test]
    fn borrar_el_workspace_borra_sus_conversaciones() {
        let conn = setup();
        new(&conn, "/p", None);
        create_conversation(&conn, "ws2", "/p", "/c", None).unwrap();
        conn.execute("DELETE FROM workspaces WHERE id = 'ws'", []).unwrap();
        assert!(list_conversations(&conn, "ws", None).unwrap().is_empty());
        assert_eq!(list_conversations(&conn, "ws2", None).unwrap().len(), 1);
    }

    #[test]
    fn migracion_v43_crea_la_tabla_sin_tocar_lo_existente() {
        let conn = setup();
        conn.execute_batch("DROP TABLE project_conversations; PRAGMA user_version = 42;").unwrap();
        crate::database::migrate_for_tests(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 45);
        assert!(list_conversations(&conn, "ws", None).unwrap().is_empty());
        // Idempotente: migrar otra vez no falla.
        crate::database::migrate_for_tests(&conn).unwrap();
    }
}
