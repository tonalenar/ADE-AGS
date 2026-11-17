//! Impede comandos Tauri síncronos de bloquear o handle global do SQLite.

use std::path::Path;

// Não há exceções: os comandos devem sair da thread principal.
const ALLOW: &[&str] = &[];

pub(crate) fn violations(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_rs(root, &mut files);
    let mut found = Vec::new();
    for file in files {
        let Ok(source) = std::fs::read_to_string(&file) else { continue };
        let relative = file.strip_prefix(root).unwrap_or(&file).to_string_lossy();
        found.extend(command_lock_violations(&relative, &source));
    }
    found.sort();
    found
}

fn collect_rs(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}

fn command_lock_violations(path: &str, source: &str) -> Vec<String> {
    let production = source.split("#[cfg(test)]").next().unwrap_or(source);
    let mut found = Vec::new();
    let mut offset = 0;
    while let Some(attr) = production[offset..].find("#[tauri::command") {
        let attr = offset + attr;
        let Some(attr_end) = production[attr..].find(']') else { break };
        let after_attr = attr + attr_end + 1;
        let Some(fn_pos) = production[after_attr..].find("fn ") else { break };
        let fn_pos = after_attr + fn_pos;
        let prefix = &production[after_attr..fn_pos];
        let Some(open_rel) = production[fn_pos..].find('{') else { break };
        let body_open = fn_pos + open_rel;
        let Some(body_end) = matching_brace(production, body_open) else { break };
        if !prefix.split_whitespace().any(|word| word == "async") {
            let body = &production[body_open + 1..body_end];
            if has_db_lock(body) {
                let line = production[..attr].bytes().filter(|byte| *byte == b'\n').count() + 1;
                let violation = format!("{path}:{line}");
                if !ALLOW.iter().any(|entry| entry.starts_with(&format!("{violation}:"))) {
                    found.push(violation);
                }
            }
        }
        offset = body_end + 1;
    }
    found
}

fn matching_brace(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = open;
    let mut string = false;
    while index < bytes.len() {
        match bytes[index] {
            b'"' if index == 0 || bytes[index - 1] != b'\\' => string = !string,
            b'{' if !string => depth += 1,
            b'}' if !string => {
                depth -= 1;
                if depth == 0 { return Some(index); }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn has_db_lock(body: &str) -> bool {
    ["db.lock(", "state.db.lock(", "conn.lock("]
        .iter()
        .any(|needle| body.contains(needle))
}

#[cfg(test)]
mod test {
    use super::violations;
    use std::path::Path;

    #[test]
    fn nenhum_comando_sincrono_trava_o_banco() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        assert!(violations(&src).is_empty(), "{:#?}", violations(&src));
    }

    #[test]
    fn detecta_lock_direto_e_qualificado_em_comando_sincrono() {
        let source = "#[tauri::command]\npub fn a() { db.lock().unwrap(); }\n#[tauri::command]\npub fn b() { state.db.lock().unwrap(); }\n#[tauri::command]\npub fn c() { conn.lock().unwrap(); }\n#[tauri::command]\npub async fn d() { db.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source).len(), 3);
    }
}
