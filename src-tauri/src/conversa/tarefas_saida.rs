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
