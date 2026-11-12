//! Leitura limitada da saída que o Claude Code escreve para shells em segundo plano.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const MAX_OUTPUT_BYTES: u64 = 8 * 1024;

/// Procura o arquivo de uma tarefa na árvore privada temporária do Claude Code.
pub fn find_task_output(root: &Path, session_id: &str, task_id: &str) -> Option<PathBuf> {
    if !safe_component(session_id) || !safe_component(task_id) {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    std::fs::read_dir(root).ok()?.flatten().find_map(|project| {
        let path = project
            .path()
            .join(session_id)
            .join("tasks")
            .join(format!("{task_id}.output"));
        let canonical_path = path.canonicalize().ok()?;
        canonical_path
            .starts_with(&canonical_root)
            .then_some(canonical_path)
    })
}

/// Lê o fim do arquivo sem trazer saídas grandes inteiras para a memória.
pub fn read_task_output(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let total_bytes = file.metadata().ok()?.len();
    let start = total_bytes.saturating_sub(MAX_OUTPUT_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((total_bytes - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some(json!({
        "output": String::from_utf8_lossy(&bytes),
        "total_bytes": total_bytes,
        "truncated": start > 0,
    }))
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Os arquivos para onde um comando manda a saída (`> f`, `>> f`, `&> f`, `2> f`, `| tee [-a] f`), na ordem em que
/// aparecem. Caminhos relativos partem de `cwd`; `~/` vira a pasta pessoal. Ignora `/dev/*` e descritores (`>&2`).
pub fn redirect_targets(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let tokens = shell_words(command);
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i].as_str();
        let mut target: Option<&str> = None;
        let op = tok.trim_start_matches(|c: char| c.is_ascii_digit() || c == '&');
        if op == ">" || op == ">>" || op == ">|" {
            target = tokens.get(i + 1).map(String::as_str);
            i += 1;
        } else if let Some(rest) = op.strip_prefix(">>").or_else(|| op.strip_prefix('>')) {
            if !rest.is_empty() && !rest.starts_with('&') { target = Some(rest); }
        } else if tok == "tee" {
            let mut j = i + 1;
            while tokens.get(j).is_some_and(|t| t.starts_with('-')) { j += 1; }
            target = tokens.get(j).map(String::as_str);
            i = j;
        }
        if let Some(t) = target.filter(|t| !t.is_empty() && !t.starts_with("/dev/") && !t.starts_with('&')) {
            let path = if let Some(rest) = t.strip_prefix("~/") {
                dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(t))
            } else {
                let p = PathBuf::from(t);
                if p.is_absolute() { p } else { cwd.join(p) }
            };
            if !out.contains(&path) { out.push(path); }
        }
        i += 1;
    }
    out
}

/// A saída de um comando que redirecionou para um log: o arquivo de destino mais recente que existe.
pub fn read_redirected_output(command: &str, cwd: &Path) -> Option<Value> {
    let newest = redirect_targets(command, cwd)
        .into_iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok().filter(|m| m.is_file())?;
            Some((meta.modified().ok(), p))
        })
        .max_by_key(|(modified, _)| *modified)?
        .1;
    let mut value = read_task_output(&newest)?;
    value["source"] = Value::String(newest.to_string_lossy().into_owned());
    Some(value)
}

/// Palavras de um comando de shell, com aspas simples e duplas e `;`, `|`, `&&` como separadores próprios.
fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let flush = |cur: &mut String, words: &mut Vec<String>| if !cur.is_empty() { words.push(std::mem::take(cur)); };
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c.is_whitespace() => flush(&mut cur, &mut words),
            None if c == ';' || c == '|' || c == '(' || c == ')' => { flush(&mut cur, &mut words); words.push(c.to_string()); }
            None => cur.push(c),
        }
    }
    flush(&mut cur, &mut words);
    words
}
