//! Falha se produção criar processo fora do helper.
//!
//! Permitido: `util/spawn.rs`, `util/proc.rs`, `util/launch.rs` (só construção),
//! `bin/cli.rs`, `build.rs`, `examples/`, arquivos de teste e blocos `#[cfg(test)]`.
//! `android.rs` pode usar `Command::new` só ao lado de `WindowMode::OwnWindow`.
//! `launch.rs` não pode chamar `.spawn()`, `.output()` nem `.status()`.

use std::path::Path;

fn is_allowed(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let name = path.rsplit('/').next().unwrap_or(&path);
    path.ends_with("src/util/spawn.rs")
        || path.ends_with("src/util/proc.rs")
        || path.ends_with("src/util/launch.rs")
        || path.ends_with("src/bin/cli.rs")
        || name == "build.rs"
        || path.contains("/examples/")
        || path.starts_with("examples/")
        || name == "test.rs"
        || name.ends_with("_test.rs")
        || name == "tests.rs"
}

/// `true` quando o `cfg(...)` não compila em produção (exige `test`).
fn test_only_cfg(expr: &str) -> bool {
    !eval_cfg(expr.trim(), false)
}

fn eval_cfg(expr: &str, test_mode: bool) -> bool {
    let expr = expr.trim();
    if expr == "test" {
        return test_mode;
    }
    if let Some(inner) = wrapped(expr, "not") {
        return !eval_cfg(inner, test_mode);
    }
    if let Some(inner) = wrapped(expr, "all") {
        return split_top(inner).iter().all(|part| eval_cfg(part, test_mode));
    }
    if let Some(inner) = wrapped(expr, "any") {
        return split_top(inner).iter().any(|part| eval_cfg(part, test_mode));
    }
    // `windows`, `unix`, `target_os = "linux"` e o resto compilam em alguma produção.
    true
}

fn wrapped<'a>(expr: &'a str, name: &str) -> Option<&'a str> {
    let rest = expr.strip_prefix(name)?.trim_start();
    let rest = rest.strip_prefix('(')?;
    let rest = rest.strip_suffix(')')?;
    Some(rest)
}

fn split_top(expr: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    for (index, ch) in expr.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(expr[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = expr[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

pub(crate) fn violations(path: &str, src: &str) -> Vec<String> {
    if is_allowed(path) {
        return launch_spawn_violations(path, src);
    }
    let mut found = Vec::new();
    let bytes = src.as_bytes();
    let mut i = 0;
    let mut line = 1usize;
    let mut depth = 0i32;
    let mut skip_until: Option<i32> = None;
    let mut pending_test_only = false;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            line += 1;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    line += 1;
                }
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        // Literal de caractere (`'"'`, `'\n'`). Sem isto a aspa de dentro abre uma string
        // e esconde um `Command::new` mais abaixo.
        if bytes[i] == b'\'' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                i += 2;
                if i < bytes.len() && bytes[i] == b'u' {
                    while i < bytes.len() && bytes[i] != b'\'' {
                        if bytes[i] == b'\n' {
                            line += 1;
                        }
                        i += 1;
                    }
                }
                i = (i + 1).min(bytes.len());
                continue;
            }
            if i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'r' && raw_string_end(src, i).is_some() {
            let end = raw_string_end(src, i).expect("raw");
            line += src[i..end].bytes().filter(|b| *b == b'\n').count();
            i = end;
            continue;
        }
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'\n' {
                    line += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            continue;
        }
        if bytes[i] == b'#'
            && src[i..].starts_with("#[")
            && let Some(end) = src[i..].find(']')
        {
            let attr = &src[i + 2..i + end];
            if let Some(expr) = attr.strip_prefix("cfg(").and_then(|rest| rest.strip_suffix(')'))
                && test_only_cfg(expr)
            {
                pending_test_only = true;
            }
            let newlines = src[i..i + end].bytes().filter(|b| *b == b'\n').count();
            line += newlines;
            i += end + 1;
            continue;
        }
        if bytes[i] == b'{' {
            depth += 1;
            if pending_test_only {
                skip_until = Some(depth);
                pending_test_only = false;
            }
        } else if bytes[i] == b'}' {
            depth -= 1;
            if skip_until.is_some_and(|until| depth < until) {
                skip_until = None;
            }
        } else if bytes[i] == b';' && pending_test_only && skip_until.is_none() {
            pending_test_only = false;
        }
        if skip_until.is_none() && src[i..].starts_with("Command::new") {
            let tokio = i >= "tokio::process::".len() && src[..i].ends_with("tokio::process::");
            let kind = if tokio { "tokio::process::Command::new" } else { "Command::new" };
            if !tokio && path.ends_with("android.rs") && own_window_nearby(src, i) {
                i += "Command::new".len();
                continue;
            }
            found.push(format!("{path}:{line}: {kind}"));
            i += "Command::new".len();
            continue;
        }
        // Um byte de UTF-8 no meio do caractere faz `src[i..]` panicar.
        if bytes[i] < 128 {
            i += 1;
        } else {
            i += 1;
            while i < bytes.len() && bytes[i] & 0b1100_0000 == 0b1000_0000 {
                i += 1;
            }
        }
    }
    found
}

fn raw_string_end(src: &str, index: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(index) != Some(&b'r') {
        return None;
    }
    let mut hashes = 0;
    let mut i = index + 1;
    while bytes.get(i) == Some(&b'#') {
        hashes += 1;
        i += 1;
    }
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    i += 1;
    let closer = format!("\"{}", "#".repeat(hashes));
    src[i..].find(&closer).map(|at| i + at + closer.len())
}

fn own_window_nearby(src: &str, index: usize) -> bool {
    let from = index.saturating_sub(500);
    let to = (index + 200).min(src.len());
    src[from..to].contains("WindowMode::OwnWindow") || src[from..to].contains("own_window")
}

fn launch_spawn_violations(path: &str, src: &str) -> Vec<String> {
    if !path.replace('\\', "/").ends_with("src/util/launch.rs") {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (line_no, line) in src.lines().enumerate() {
        let code = line.split("//").next().unwrap_or(line);
        for needle in [".spawn(", ".output(", ".status("] {
            if code.contains(needle) {
                found.push(format!("{}:{}: launch.rs não spawna ({needle})", path, line_no + 1));
            }
        }
    }
    found
}

fn scan_tree() -> Vec<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut found = Vec::new();
    for dir in [root.join("src"), root.join("examples"), root.join("build.rs")] {
        walk(&dir, &mut found);
    }
    found
}

fn walk(path: &Path, found: &mut Vec<String>) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.is_file() {
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            return;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("spawn_lint_fixture.rs") {
            return;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let rel = path.strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap_or(path);
        found.extend(violations(&rel.to_string_lossy(), &text));
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        walk(&entry.path(), found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfg_de_teste_nao_conta_e_cfg_de_producao_conta() {
        assert!(test_only_cfg("test"));
        assert!(test_only_cfg("all(windows, test)"));
        assert!(!test_only_cfg("any(windows, test)"));
        assert!(!test_only_cfg("not(test)"));
        assert!(!test_only_cfg("windows"));
    }

    #[test]
    fn a_arvore_de_producao_nao_spawna_fora_do_helper() {
        let found = scan_tree();
        assert!(found.is_empty(), "Command::new fora da allowlist:\n{}", found.join("\n"));
    }

    #[test]
    fn o_fixture_e_uma_violacao() {
        let src = include_str!("spawn_lint_fixture.rs");
        let found = violations("src/util/spawn_lint_fixture.rs", src);
        assert!(
            found.iter().any(|item| item.contains("Command::new")),
            "o fixture tem que falhar: {found:?}"
        );
        assert!(
            found.iter().any(|item| item.contains("tokio::process::Command::new")),
            "o fixture tokio tem que falhar: {found:?}"
        );
    }

    #[test]
    fn bloco_cfg_test_nao_e_violacao() {
        let src = r#"
            fn prod() { let _ = std::process::Command::new("git"); }
            #[cfg(test)]
            mod tests {
                fn t() { let _ = std::process::Command::new("git"); }
            }
        "#;
        let found = violations("src/exemplo.rs", src);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains(":2:"), "{found:?}");
    }
}
