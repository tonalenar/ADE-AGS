//! Quem mais está usando a pasta que uma restauração vai reescrever.
//!
//! Voltar os arquivos por baixo de outro agente que trabalha na mesma pasta (ou numa pasta de
//! dentro, ou numa que a contém) apagaria o trabalho dele sem ele saber. Por isso a restauração
//! se recusa enquanto houver outra aba viva ou tarefa da frota ali, a não ser que a pessoa diga
//! explicitamente que quer assim mesmo.

use serde::Serialize;

/// Algo que usa uma pasta: uma aba (`tab`) ou uma tarefa da frota (`task`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub kind: String,
    pub id: String,
    pub dir: String,
}

/// O caminho como dá para comparar: barras normais, sem a barra do fim, sem `\\?\`, e sem
/// diferença de maiúsculas no Windows (onde `C:\Repo` e `c:\repo` são a mesma pasta). Pura.
pub fn normalize(path: &str) -> String {
    let mut p = path.trim().replace('\\', "/");
    if let Some(rest) = p.strip_prefix("//?/") {
        p = rest.to_string();
    }
    while p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    if cfg!(windows) || looks_like_drive(&p) { p.to_lowercase() } else { p }
}

fn looks_like_drive(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `a` e `b` são a mesma pasta, ou uma está dentro da outra? Pura.
pub fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let inside = |child: &str, parent: &str| child == parent || child.starts_with(&format!("{}/", parent.trim_end_matches('/')));
    inside(&a, &b) || inside(&b, &a)
}

/// Quem, além da própria aba (`own_tab`), usa uma pasta que se sobrepõe a `root`. Pura.
pub fn blockers(root: &str, own_tab: &str, tabs: &[(String, String)], tasks: &[(String, String)]) -> Vec<Blocker> {
    let mut out: Vec<Blocker> = Vec::new();
    for (id, dir) in tabs {
        if id != own_tab && overlaps(root, dir) && !out.iter().any(|b| b.kind == "tab" && &b.id == id) {
            out.push(Blocker { kind: "tab".into(), id: id.clone(), dir: dir.clone() });
        }
    }
    for (id, dir) in tasks {
        if overlaps(root, dir) && !out.iter().any(|b| b.kind == "task" && &b.id == id) {
            out.push(Blocker { kind: "task".into(), id: id.clone(), dir: dir.clone() });
        }
    }
    out
}
