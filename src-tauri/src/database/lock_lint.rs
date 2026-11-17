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
    let masked = without_test_items(source);
    let production = masked.as_str();
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

const CFG_TEST: &str = "#[cfg(test)]";

// Troca por espaços só os itens marcados com #[cfg(test)]; quebras de linha e posições ficam iguais.
fn without_test_items(source: &str) -> String {
    let mut masked = source.as_bytes().to_vec();
    let mut offset = 0;
    while let Some(found) = source[offset..].find(CFG_TEST) {
        let start = offset + found;
        let after_attr = start + CFG_TEST.len();
        let end = test_item_end(source, after_attr).unwrap_or(after_attr);
        for byte in &mut masked[start..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        offset = end;
    }
    String::from_utf8(masked).unwrap_or_else(|_| source.to_string())
}

// Fim do item que segue o atributo: o `;` ou o `}` que fecha o primeiro `{` fora de parênteses e colchetes.
fn test_item_end(source: &str, from: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    for index in from..bytes.len() {
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => return Some(index + 1),
            b'{' if depth == 0 => return matching_brace(source, index).map(|close| close + 1),
            _ => {}
        }
    }
    None
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
    fn lint_nao_para_no_primeiro_cfg_test() {
        let source = "#[cfg(test)]\nmod test { fn x() {} }\n#[tauri::command]\npub fn a() { db.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source), vec!["x.rs:3".to_string()]);
    }

    #[test]
    fn ignora_comando_marcado_com_cfg_test() {
        let source = "#[cfg(test)]\n#[tauri::command]\npub fn a() { db.lock().unwrap(); }\n#[tauri::command]\npub fn b() { db.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source), vec!["x.rs:4".to_string()]);
    }

    #[test]
    fn detecta_lock_direto_e_qualificado_em_comando_sincrono() {
        let source = "#[tauri::command]\npub fn a() { db.lock().unwrap(); }\n#[tauri::command]\npub fn b() { state.db.lock().unwrap(); }\n#[tauri::command]\npub fn c() { conn.lock().unwrap(); }\n#[tauri::command]\npub async fn d() { db.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source).len(), 3);
    }
}
