//! Chave de cache por suíte: o verde do Rust não deve cair por uma mudança que só mexe no frontend.
//!
//! A identidade da árvore inteira (`clean_tree`) muda com qualquer arquivo, e cada mudança de tela
//! refazia os ~160 s do `cargo test`. Aqui a identidade de uma suíte olha só os arquivos que ela lê.
//! É conservador: na dúvida o caminho ENTRA (um falso miss custa tempo; um falso verde custa
//! confiança). `AGS_TEST_SCOPE=off` volta à árvore inteira.

use sha2::{Digest, Sha256};
use std::path::Path;

/// A suíte lê este arquivo? Os cruzamentos entre as duas linguagens estão listados um a um: se um
/// teste novo passar a ler outro arquivo de fora da sua pasta, ele tem que entrar aqui.
pub fn suite_reads(suite: &str, path: &str) -> bool {
    // Relatórios e documentação não mudam o que um teste vê (mesma regra da identidade da árvore).
    if path.starts_with("docs/") || path.ends_with(".md") {
        return false;
    }
    match suite {
        "rust" => {
            path.starts_with("src-tauri/")
                || path.starts_with("skills/") // `skills/bundled.rs` lê `../skills`
                || path.starts_with(".cargo/")
                || path == "package.json" // versão do app
                || path == "rust-toolchain"
                || path == "rust-toolchain.toml"
                || path == "src/features/orchestrator/cliBridge.ts" // `ipc/test.rs` inclui o arquivo
                || path.starts_with("src/features/runs/tests/fixtures/") // `runs/handoff/test.rs`
        }
        "frontend" | "tsc" | "babel" => {
            !path.starts_with("src-tauri/")
                // Testes do frontend que leem fontes do Rust (`?raw`).
                || path == "src-tauri/src/agents/registry.rs"
                || path == "src-tauri/src/graphify/catalog.rs"
        }
        // Suíte desconhecida: tudo entra.
        _ => true,
    }
}

/// O hash da lista `git ls-tree -r -z` restrita aos arquivos que a suíte lê. Pura.
pub(crate) fn scope_hash(listing: &[u8], suite: &str) -> String {
    let mut hasher = Sha256::new();
    for entry in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        // "<modo> <tipo> <sha>\t<caminho>"
        let text = String::from_utf8_lossy(entry);
        let Some((meta, path)) = text.split_once('\t') else { continue };
        if !suite_reads(suite, path) {
            continue;
        }
        let mut parts = meta.split(' ');
        let (mode, _kind, sha) = (parts.next().unwrap_or(""), parts.next(), parts.next().unwrap_or(""));
        hasher.update(format!("{mode} {sha} {path}\0").as_bytes());
    }
    format!("scope:{suite}:{:x}", hasher.finalize())
}

/// A identidade da suíte para esta árvore. Sem git, ou com `AGS_TEST_SCOPE=off`, é a árvore inteira.
pub fn scoped_identity(root: &Path, tree: &str, suite: &str) -> String {
    if std::env::var("AGS_TEST_SCOPE").is_ok_and(|v| v == "off") {
        return tree.to_string();
    }
    match super::run::git_raw(root, &["ls-tree", "-r", "-z", tree]) {
        Ok(out) if out.status.success() => scope_hash(&out.stdout, suite),
        // Qualquer erro volta ao comportamento seguro: a árvore inteira.
        _ => tree.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(files: &[(&str, &str)]) -> Vec<u8> {
        files.iter().flat_map(|(path, sha)| format!("100644 blob {sha}\t{path}\0").into_bytes()).collect()
    }

    #[test]
    fn mudar_so_o_frontend_nao_muda_a_chave_do_rust_e_vice_versa() {
        let base = [("src/App.tsx", "a1"), ("src-tauri/src/lib.rs", "b1"), ("package.json", "c1"), ("docs/x.md", "d1")];
        let front = [("src/App.tsx", "a2"), ("src-tauri/src/lib.rs", "b1"), ("package.json", "c1"), ("docs/x.md", "d1")];
        let rust = [("src/App.tsx", "a1"), ("src-tauri/src/lib.rs", "b2"), ("package.json", "c1"), ("docs/x.md", "d1")];
        let docs = [("src/App.tsx", "a1"), ("src-tauri/src/lib.rs", "b1"), ("package.json", "c1"), ("docs/x.md", "d2")];
        let h = |files: &[(&str, &str)], suite: &str| scope_hash(&listing(files), suite);
        assert_eq!(h(&base, "rust"), h(&front, "rust"), "frontend não invalida o Rust");
        assert_ne!(h(&base, "frontend"), h(&front, "frontend"));
        assert_eq!(h(&base, "frontend"), h(&rust, "frontend"), "Rust não invalida o frontend");
        assert_ne!(h(&base, "rust"), h(&rust, "rust"));
        assert_eq!(h(&base, "rust"), h(&docs, "rust"));
        assert_eq!(h(&base, "tsc"), h(&docs, "tsc"));
        // A versão do app (package.json) entra nas duas.
        let bumped = [("src/App.tsx", "a1"), ("src-tauri/src/lib.rs", "b1"), ("package.json", "c2"), ("docs/x.md", "d1")];
        assert_ne!(h(&base, "rust"), h(&bumped, "rust"));
        assert_ne!(h(&base, "frontend"), h(&bumped, "frontend"));
        // Chaves de suítes diferentes nunca colidem, mesmo com o mesmo conteúdo.
        assert_ne!(h(&base, "frontend"), h(&base, "tsc"));
    }

    #[test]
    fn os_cruzamentos_entre_linguagens_ficam_na_chave() {
        // O Rust lê estes arquivos do frontend...
        assert!(suite_reads("rust", "src/features/orchestrator/cliBridge.ts"));
        assert!(suite_reads("rust", "src/features/runs/tests/fixtures/handoff-v1.json"));
        assert!(!suite_reads("rust", "skills/git-helper/SKILL.md"), "markdown nunca entra");
        assert!(suite_reads("rust", "skills/git-helper/run.mjs"));
        assert!(!suite_reads("rust", "src/features/missions/vigia.ts"));
        // ...e o frontend lê estes do Rust.
        assert!(suite_reads("frontend", "src-tauri/src/agents/registry.rs"));
        assert!(suite_reads("frontend", "src-tauri/src/graphify/catalog.rs"));
        assert!(!suite_reads("frontend", "src-tauri/src/missions/vigia.rs"));
        assert!(suite_reads("frontend", "scripts/build.mjs"));
        // Suíte que não conheço: tudo entra (só markdown e docs saem).
        assert!(suite_reads("outra", "src-tauri/src/lib.rs") && suite_reads("outra", "src/App.tsx"));
    }
}
