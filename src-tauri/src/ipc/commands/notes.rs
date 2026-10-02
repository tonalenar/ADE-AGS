//! Las notas del canvas, para los agentes: `ccode note list|create|read|write|edit`.
//!
//! Una nota conectada a un agente es su memoria a la vista del usuario: el plan, una lista
//! de pendientes, lo que descubrió. El agente la lee y la escribe por acá; el usuario la ve
//! y la edita en el canvas.
//!
//! **Permiso:** las mismas conexiones que entre agentes (ver `crate::canvas::notes_for`).
//! Un agente alcanza las notas conectadas con él; una orquestadora, también las de su
//! equipo.
//!
//! **Quién escribe:** el frontend, igual que con `peer connect`. Él tiene el canvas en
//! memoria y lo guarda; escribir el archivo desde acá se perdería en su próximo guardado.
//! Leer sí se lee del archivo: el frontend lo guarda al instante cuando el cambio lo pidió
//! un agente (ver `flushSave`).
//!
//! No hay `delete`: borrar una nota queda en manos del usuario.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peers::{caller, open_tabs};
use crate::canvas::{self, Boards, Note};
use crate::ipc::bridge::{ask_frontend, unwrap_frontend_result};
use crate::ipc::protocol::{arg_str, arg_str_opt};

/// Una nota que el que pide alcanza, con dónde vive.
#[derive(Debug, Clone)]
pub(crate) struct Reachable {
    pub key: String,
    pub id: String,
    pub note: Note,
}

fn reachable(boards: &Boards, from: &str) -> Vec<Reachable> {
    canvas::notes_for(boards, from)
        .into_iter()
        .filter_map(|(key, id)| {
            let note = boards.get(&key)?.notes.get(&id)?.clone();
            Some(Reachable { key, id, note })
        })
        .collect()
}

/// Resuelve una nota por id o por nombre (sin mayúsculas). Igual que con los agentes, un
/// nombre ambiguo es un error: escribir en la nota equivocada es peor que pedir el id.
pub(crate) fn resolve_note<'a>(notes: &'a [Reachable], wanted: &str) -> Result<&'a Reachable, String> {
    if let Some(n) = notes.iter().find(|n| n.id == wanted) {
        return Ok(n);
    }
    let needle = wanted.trim().to_lowercase();
    let matches: Vec<&Reachable> = notes.iter().filter(|n| n.note.name.to_lowercase() == needle).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] if notes.is_empty() => Err(format!(
            "'{wanted}' não está conectada com você. Você não tem nenhuma nota conectada: crie uma com `ccode note create` ou peça ao usuário para ligar uma nota ao seu terminal."
        )),
        [] => Err(format!(
            "'{wanted}' não está conectada com você. Notas conectadas: {}",
            notes.iter().map(|n| n.note.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "Há {} notas chamadas '{wanted}'. Use o id: {}",
            many.len(),
            many.iter().map(|n| n.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Un número que puede llegar como número (flag) o como texto (valor suelto).
fn arg_num(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().map(|n| Some(n as usize)).ok_or_else(|| format!("--{key} inválido")),
        Some(Value::String(s)) => s.trim().parse::<usize>().map(Some).map_err(|_| format!("--{key} tem que ser um número, veio '{s}'")),
        Some(_) => Err(format!("--{key} inválido")),
    }
}

/// Las líneas `[start, start + count)` (base 1) con su número, como las ve un editor.
pub(crate) fn numbered(content: &str, start: usize, count: Option<usize>) -> (String, usize) {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let first = start.max(1);
    let last = count.map(|c| (first - 1 + c).min(total)).unwrap_or(total);
    let width = last.max(1).to_string().len();
    let text = (first..=last)
        .filter_map(|n| lines.get(n - 1).map(|l| format!("{n:>width$}│ {l}")))
        .collect::<Vec<_>>()
        .join("\n");
    (text, total)
}

/// Reemplaza `old` por `new` si aparece UNA vez. Cero o varias es un error: en un caso no
/// hay nada que cambiar, en el otro no se sabe cuál.
pub(crate) fn replace_once(content: &str, old: &str, new: &str) -> Result<String, String> {
    if old.is_empty() {
        return Err("O texto a substituir não pode ser vazio.".into());
    }
    match content.matches(old).count() {
        0 => Err("Esse texto não está na nota. Leia de novo com `ccode note read` e copie o trecho exato.".into()),
        1 => Ok(content.replacen(old, new, 1)),
        n => Err(format!("Esse texto aparece {n} vezes na nota. Inclua mais contexto para que seja único.")),
    }
}

fn describe(n: &Reachable) -> Value {
    json!({ "id": n.id, "name": n.note.name, "lines": n.note.content.lines().count() })
}

/// La ventana que tiene ese canvas: la clave es `ventana|carpeta`.
fn window_of(key: &str) -> &str {
    key.split('|').next().unwrap_or("main")
}

fn write(app: &AppHandle, target: &Reachable, content: &str) -> Result<(), String> {
    let raw = ask_frontend(
        app,
        "canvas.note",
        &json!({ "op": "write", "key": target.key, "id": target.id, "content": content }),
        Some(window_of(&target.key)),
    )?;
    unwrap_frontend_result(raw).map(|_| ())
}

pub(super) fn note_list(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let notes = reachable(&canvas::load_boards(), &from);
    Ok(json!({ "notes": notes.iter().map(describe).collect::<Vec<_>>() }))
}

pub(super) fn note_read(_app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let notes = reachable(&canvas::load_boards(), &from);
    let target = resolve_note(&notes, &arg_str(args, "name")?)?;
    let start = arg_num(args, "start")?.unwrap_or(1);
    let (text, total) = numbered(&target.note.content, start, arg_num(args, "count")?);
    Ok(json!({ "note": describe(target), "totalLines": total, "text": text }))
}

/// Crea una nota al lado de quien la pide y conectada con él.
pub(super) fn note_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let me = open_tabs(app)?
        .into_iter()
        .find(|t| t.id == from)
        .ok_or_else(|| "A sua aba não está aberta em nenhuma janela.".to_string())?;
    let content = arg_str_opt(args, "content").unwrap_or_default();
    let mut req = json!({ "op": "create", "cwd": me.cwd, "near": me.id, "content": content });
    if let Some(name) = arg_str_opt(args, "name").filter(|n| !n.trim().is_empty()) {
        req["name"] = json!(name.trim());
    }
    let raw = ask_frontend(app, "canvas.note", &req, Some(&me.window))?;
    let created = unwrap_frontend_result(raw)?;
    Ok(json!({ "created": created }))
}

pub(super) fn note_write(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let notes = reachable(&canvas::load_boards(), &from);
    let target = resolve_note(&notes, &arg_str(args, "name")?)?;
    let content = arg_str(args, "content")?;
    write(app, target, &content)?;
    Ok(json!({ "note": target.note.name, "lines": content.lines().count() }))
}

pub(super) fn note_edit(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let notes = reachable(&canvas::load_boards(), &from);
    let target = resolve_note(&notes, &arg_str(args, "name")?)?;
    let updated = replace_once(&target.note.content, &arg_str(args, "old")?, &arg_str(args, "new")?)?;
    write(app, target, &updated)?;
    Ok(json!({ "note": target.note.name, "edited": true }))
}

#[cfg(test)]
mod test {
    use super::*;

    fn note(id: &str, name: &str) -> Reachable {
        Reachable { key: "main|/p".into(), id: id.into(), note: Note { name: name.into(), ..Default::default() } }
    }

    #[test]
    fn resuelve_por_nombre_sin_mayusculas_y_por_id() {
        let notes = vec![note("note-1", "Plano"), note("note-2", "Pendências")];
        assert_eq!(resolve_note(&notes, "plano").unwrap().id, "note-1");
        assert_eq!(resolve_note(&notes, "note-2").unwrap().id, "note-2");
    }

    #[test]
    fn una_nota_no_conectada_lista_las_que_si() {
        let err = resolve_note(&[note("note-1", "Plano")], "Outra").unwrap_err();
        assert!(err.contains("Plano"), "{err}");
    }

    #[test]
    fn sin_notas_explica_como_crear_una() {
        let err = resolve_note(&[], "Plano").unwrap_err();
        assert!(err.contains("ccode note create"), "{err}");
    }

    #[test]
    fn numera_las_lineas_pedidas() {
        let (text, total) = numbered("a\nb\nc\nd", 2, Some(2));
        assert_eq!(total, 4);
        assert_eq!(text, "2│ b\n3│ c");
        let (all, _) = numbered("a\nb", 1, None);
        assert_eq!(all, "1│ a\n2│ b");
    }

    #[test]
    fn numerar_fuera_de_rango_no_rompe() {
        let (text, total) = numbered("a", 5, Some(3));
        assert_eq!((text.as_str(), total), ("", 1));
    }

    #[test]
    fn reemplaza_solo_si_es_unico() {
        assert_eq!(replace_once("- [ ] tests", "[ ]", "[x]").unwrap(), "- [x] tests");
        assert!(replace_once("a a", "a", "b").unwrap_err().contains("2 vezes"));
        assert!(replace_once("abc", "z", "y").is_err());
        assert!(replace_once("abc", "", "y").is_err());
    }

    #[test]
    fn el_numero_llega_como_texto_o_numero() {
        assert_eq!(arg_num(&json!({ "start": "10" }), "start").unwrap(), Some(10));
        assert_eq!(arg_num(&json!({ "start": 3 }), "start").unwrap(), Some(3));
        assert_eq!(arg_num(&json!({}), "start").unwrap(), None);
        assert!(arg_num(&json!({ "start": "x" }), "start").is_err());
    }
}
