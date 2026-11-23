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
    found.extend(helper_violations(root));
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
        let Some(body_end) = matching_delim(production, body_open, b'}') else { break };
        let body = &production[body_open + 1..body_end];
        // Em async, o lock só é aceito dentro de spawn_blocking; fora dele trava a thread do runtime.
        let locked = if prefix.split_whitespace().any(|word| word == "async") {
            has_db_lock(&without_blocking_calls(body))
        } else {
            has_db_lock(body)
        };
        if locked {
            let line = production[..attr].bytes().filter(|byte| *byte == b'\n').count() + 1;
            let violation = format!("{path}:{line}");
            if !ALLOW.iter().any(|entry| entry.starts_with(&format!("{violation}:"))) {
                found.push(violation);
            }
        }
        offset = body_end + 1;
    }
    found
}

// Nomes de funções que, direta ou indiretamente, travam o banco. Só entram nomes definidos uma vez no crate,
// para que um `list` genérico não contamine comandos que não têm relação com o banco.
fn locking_helpers(sources: &[(String, String)]) -> std::collections::HashSet<String> {
    let mut defs: Vec<(String, String)> = Vec::new();
    for (_, source) in sources {
        defs.extend(fn_definitions(source));
    }
    let mut count = std::collections::HashMap::new();
    for (name, _) in &defs {
        *count.entry(name.clone()).or_insert(0usize) += 1;
    }
    let mut locking = std::collections::HashSet::new();
    for (name, body) in &defs {
        if count[name] == 1 && locks_directly(&without_blocking_calls(body)) {
            locking.insert(name.clone());
        }
    }
    loop {
        let before = locking.len();
        for (name, body) in &defs {
            if count[name] == 1 && !locking.contains(name) {
                let outside = without_blocking_calls(body);
                if calls_any(&outside, &locking) {
                    locking.insert(name.clone());
                }
            }
        }
        if locking.len() == before {
            return locking;
        }
    }
}

// Trava o banco sem passar por `spawn_blocking`: o literal clássico ou o helper de acesso por AppHandle.
fn locks_directly(body: &str) -> bool {
    has_db_lock(body) || ["with_db(", "lock(&db)", "lock(&state.db)", "db(&app)?", "db(app)?"].iter().any(|n| body.contains(n))
}

fn calls_any(body: &str, names: &std::collections::HashSet<String>) -> bool {
    let bytes = body.as_bytes();
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index < bytes.len() {
        if is_ident(bytes[index]) && (index == 0 || !is_ident(bytes[index - 1])) {
            let mut end = index;
            while end < bytes.len() && is_ident(bytes[end]) {
                end += 1;
            }
            if bytes.get(end) == Some(&b'(') && names.contains(&body[index..end]) {
                return true;
            }
            index = end;
        } else {
            index += 1;
        }
    }
    false
}

// (nome, corpo) de cada `fn` com corpo; itens de teste ficam de fora.
fn fn_definitions(source: &str) -> Vec<(String, String)> {
    let masked = without_test_items(source);
    let text = masked.as_str();
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut offset = 0;
    while let Some(found) = text[offset..].find("fn ") {
        let start = offset + found;
        offset = start + 3;
        if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
            continue;
        }
        let name: String = text[start + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if name.is_empty() {
            continue;
        }
        let Some(stop) = text[start..].find(|c| c == '{' || c == ';') else { break };
        if bytes[start + stop] == b';' {
            continue;
        }
        let open = start + stop;
        if let Some(close) = matching_delim(text, open, b'}') {
            out.push((name, text[open + 1..close].to_string()));
        }
    }
    out
}

fn helper_violations(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_rs(root, &mut files);
    let sources: Vec<(String, String)> = files
        .iter()
        .filter_map(|file| {
            let source = std::fs::read_to_string(file).ok()?;
            let relative = file.strip_prefix(root).unwrap_or(file).to_string_lossy().to_string();
            Some((relative, source))
        })
        .collect();
    let locking = locking_helpers(&sources);
    sources.iter().flat_map(|(path, source)| sync_command_helper_violations(path, source, &locking)).collect()
}

// Comando síncrono roda na thread principal: chamar helper que trava o banco ali congela a janela.
// A saída é `#[tauri::command(async)]` (ou `async fn` com `blocking_db`/`spawn_blocking`).
fn sync_command_helper_violations(path: &str, source: &str, locking: &std::collections::HashSet<String>) -> Vec<String> {
    let masked = without_test_items(source);
    let production = masked.as_str();
    let mut found = Vec::new();
    let mut offset = 0;
    while let Some(attr) = production[offset..].find("#[tauri::command") {
        let attr = offset + attr;
        let Some(attr_end) = production[attr..].find(']') else { break };
        let attr_text = &production[attr..attr + attr_end];
        let after_attr = attr + attr_end + 1;
        let Some(fn_pos) = production[after_attr..].find("fn ") else { break };
        let fn_pos = after_attr + fn_pos;
        let Some(open_rel) = production[fn_pos..].find('{') else { break };
        let body_open = fn_pos + open_rel;
        let Some(body_end) = matching_delim(production, body_open, b'}') else { break };
        let signature = &production[fn_pos..body_open];
        let body = without_blocking_calls(&production[body_open + 1..body_end]);
        let is_async = attr_text.contains("async") || production[after_attr..fn_pos].split_whitespace().any(|word| word == "async");
        let touches = signature.contains("DbConnection") || locks_directly(&body) || calls_any(&body, locking);
        if !is_async && touches {
            let line = production[..attr].bytes().filter(|byte| *byte == b'\n').count() + 1;
            found.push(format!("{path}:{line}"));
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
            b'{' if depth == 0 => return matching_delim(source, index, b'}').map(|close| close + 1),
            _ => {}
        }
    }
    None
}

// Índice do fechamento que casa com o delimitador de abertura em `open`.
fn matching_delim(source: &str, open: usize, close: u8) -> Option<usize> {
    let bytes = source.as_bytes();
    let open_byte = *bytes.get(open)?;
    let mut depth = 0usize;
    let mut index = open;
    let mut string = false;
    while index < bytes.len() {
        match bytes[index] {
            b'"' if index == 0 || bytes[index - 1] != b'\\' => string = !string,
            _ if string => {}
            byte if byte == open_byte => depth += 1,
            byte if byte == close => {
                depth -= 1;
                if depth == 0 { return Some(index); }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

// Troca por espaços o conteúdo de spawn_blocking(...): o que roda ali sai da thread principal.
fn without_blocking_calls(body: &str) -> String {
    let mut masked = body.as_bytes().to_vec();
    let mut offset = 0;
    while let Some(found) = body[offset..].find("spawn_blocking(") {
        let open = offset + found + "spawn_blocking".len();
        let Some(close) = matching_delim(body, open, b')') else { break };
        for byte in &mut masked[open..=close] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        offset = close + 1;
    }
    String::from_utf8(masked).unwrap_or_else(|_| body.to_string())
}

fn has_db_lock(body: &str) -> bool {
    ["db.lock(", "state.db.lock(", "conn.lock(", "db(&app)?.lock(", "db(app)?.lock("]
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
        let source = "#[tauri::command]\npub fn a() { db.lock().unwrap(); }\n#[tauri::command]\npub fn b() { state.db.lock().unwrap(); }\n#[tauri::command]\npub fn c() { conn.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source).len(), 3);
    }

    #[test]
    fn detecta_banco_obtido_por_funcao_auxiliar() {
        let source = "#[tauri::command]\npub async fn a(app: AppHandle) { db(&app)?.lock().unwrap(); }\n#[tauri::command]\npub fn b(app: AppHandle) { store::list(&db(app)?.lock().unwrap()); }";
        assert_eq!(super::command_lock_violations("x.rs", source), vec!["x.rs:1".to_string(), "x.rs:3".to_string()]);
    }

    #[test]
    fn comando_sincrono_com_helper_que_trava_o_banco_e_violacao() {
        let helper = "fn lista(db: &DbConnection) { db.lock().unwrap(); }\nfn indireto() { lista(&x); }";
        let comandos = "#[tauri::command]\npub fn a() { lista(&x); }\n#[tauri::command]\npub fn b() { indireto(); }\n#[tauri::command(async)]\npub fn c() { lista(&x); }\n#[tauri::command]\npub async fn d() { lista(&x); }\n#[tauri::command]\npub fn e() { spawn_blocking(move || lista(&x)); }\n#[tauri::command]\npub fn f(db: State<DbConnection>) {}\n#[tauri::command]\npub fn g() { outra(); }";
        let locking = super::locking_helpers(&[("h.rs".into(), helper.into())]);
        let achados = super::sync_command_helper_violations("x.rs", comandos, &locking);
        assert_eq!(achados, vec!["x.rs:1".to_string(), "x.rs:3".to_string(), "x.rs:11".to_string()]);
    }

    #[test]
    fn nome_de_helper_duplicado_nao_contamina() {
        let helper = "fn lista(db: &DbConnection) { db.lock().unwrap(); }\nmod outro { fn lista() {} }";
        assert!(super::locking_helpers(&[("h.rs".into(), helper.into())]).is_empty());
    }

    #[test]
    fn async_com_lock_fora_de_spawn_blocking_e_violacao() {
        let source = "#[tauri::command]\npub async fn a() { db.lock().unwrap(); }\n#[tauri::command]\npub async fn b() { tauri::async_runtime::spawn_blocking(move || { db.lock().unwrap(); }); }\n#[tauri::command]\npub async fn c() { let _ = spawn_blocking(move || 1); db.lock().unwrap(); }";
        assert_eq!(super::command_lock_violations("x.rs", source), vec!["x.rs:1".to_string(), "x.rs:5".to_string()]);
    }
}
