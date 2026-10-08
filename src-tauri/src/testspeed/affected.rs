//! `ags test affected`: dos arquivos alterados aos comandos de teste que importam. Pura: não
//! toca no disco nem no git (quem chama passa a lista de `git diff origin/master` + não commitados).
//!
//! Regra de ouro: arquivo que não sabemos mapear NUNCA é ignorado em silêncio; vira `unmapped`
//! e o plano passa a ser a suite completa (`full`).

use std::collections::BTreeSet;

/// Acima disto, `vitest related <arquivos>` estoura o limite de linha de comando do Windows.
const MAX_RELATED_FILES: usize = 150;

pub const SUITE_FRONTEND: &str = "frontend";
pub const SUITE_TSC: &str = "tsc";
pub const SUITE_BABEL: &str = "babel";
pub const SUITE_RUST: &str = "rust";

/// Código unsafe/COM do Windows: mudança aqui pede a suite Rust completa (um módulo afetado não basta).
const WINDOWS_RISK_PATHS: &[&str] = &[
    "src-tauri/src/notifier/identity.rs",
    "src-tauri/src/terminal/containment.rs",
    "src-tauri/src/util/proc.rs",
    "src-tauri/src/util/path_env.rs",
    "src-tauri/src/app/signals.rs",
    "src-tauri/src/app/rendering.rs",
    "src-tauri/src/window/",
];

const VITEST: &str = "node_modules/vitest/vitest.mjs";
const TSC: &str = "node_modules/typescript/bin/tsc";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// Chave do cache de resultado e do span: frontend | tsc | babel | rust.
    pub suite: &'static str,
    pub program: String,
    pub args: Vec<String>,
    /// Relativo à raiz do repositório; `None` = a própria raiz.
    pub cwd: Option<&'static str>,
}

impl Step {
    fn new(suite: &'static str, program: &str, args: &[&str], cwd: Option<&'static str>) -> Self {
        Step { suite, program: program.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd }
    }

    /// A linha como se digitaria: `(src-tauri) cargo test --lib -- floors::`.
    pub fn display(&self) -> String {
        let cmd = std::iter::once(self.program.as_str()).chain(self.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
        match self.cwd {
            Some(dir) => format!("({dir}) {cmd}"),
            None => cmd,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Suite completa: algo sem mapa ou mudança de risco (ver `risk`).
    pub full: bool,
    /// Por que a suite Rust completa é obrigatória (banco, schema, unsafe/COM).
    pub risk: Vec<String>,
    pub unmapped: Vec<String>,
    /// Alterados que não exigem teste (docs, ícones...).
    pub ignored: Vec<String>,
}

impl Plan {
    /// Nada a rodar: só docs/arquivos sem efeito.
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    /// Texto do `--dry-run`: o que rodaria e por quê.
    pub fn render_dry_run(&self) -> String {
        let mut out = String::new();
        for reason in &self.risk {
            out.push_str(&format!("Mudança de risco, suite Rust COMPLETA: {reason}\n"));
        }
        if !self.unmapped.is_empty() {
            out.push_str("Não sei mapear estes arquivos; rodando a suite COMPLETA:\n");
            for f in &self.unmapped {
                out.push_str(&format!("  ? {f}\n"));
            }
        }
        if self.steps.is_empty() {
            out.push_str("Nada a testar: só arquivos sem efeito em código.\n");
        }
        for step in &self.steps {
            out.push_str(&format!("[{}] {}\n", step.suite, step.display()));
        }
        if !self.ignored.is_empty() {
            out.push_str(&format!("Sem teste ({}): {}\n", self.ignored.len(), self.ignored.join(", ")));
        }
        out
    }
}

enum Kind {
    Frontend,
    FrontendAll,
    Rust(String),
    RustAll,
    RustBin,
    Ignored,
    Unmapped,
}

fn normalize(path: &str) -> String {
    let p = path.trim().replace('\\', "/");
    p.strip_prefix("./").unwrap_or(&p).to_string()
}

/// Skill mounts and other agent metadata. They are not product code. An untracked
/// file here must not dirty the test cache and must not flip the plan to the full suite.
pub fn is_agent_metadata(path: &str) -> bool {
    let path = normalize(path);
    let path = path.strip_suffix('/').unwrap_or(&path);
    const ROOTS: &[&str] = &[".agents", ".claude", ".gemini", ".codex", ".kimi", ".opencode"];
    ROOTS.iter().any(|root| path == *root || path.starts_with(&format!("{root}/")))
        || path == ".cursor/skills"
        || path.starts_with(".cursor/skills/")
}

/// A source line that introduces `unsafe` (comments do not count).
pub fn line_adds_unsafe(added: &str) -> bool {
    let code = added.trim_start();
    if code.starts_with("//") {
        return false;
    }
    code.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|word| word == "unsafe")
}

/// Motivo de risco de um caminho, se houver. Pura.
fn risk_reason(path: &str) -> Option<String> {
    if path.starts_with("src-tauri/src/database/") {
        return Some(format!("{path} (banco/schema/migração)"));
    }
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".sql") || lower.ends_with(".schema.json") || lower.contains("/schema/") || lower.ends_with("/schema.rs") {
        return Some(format!("{path} (schema)"));
    }
    if WINDOWS_RISK_PATHS.iter().any(|p| path == *p || (p.ends_with('/') && path.starts_with(p))) {
        return Some(format!("{path} (unsafe/COM do Windows)"));
    }
    None
}

/// Arquivos `.rs` cujo diff unificado ADICIONA código `unsafe` (linhas `+`, fora de comentários).
/// Pura: quem chama passa a saída de `git diff`.
pub fn files_adding_unsafe(diff: &str) -> Vec<String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut current: Option<String> = None;
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ b/") {
            current = Some(normalize(path));
        } else if line.starts_with("+++ ") {
            current = None;
        } else if let (Some(file), Some(added)) = (&current, line.strip_prefix('+')) {
            if line_adds_unsafe(added) && file.ends_with(".rs") && !is_agent_metadata(file) {
                found.insert(file.clone());
            }
        }
    }
    found.into_iter().collect()
}

fn classify(path: &str) -> Kind {
    if is_agent_metadata(path) {
        return Kind::Ignored;
    }
    let ext = path.rsplit('.').next().unwrap_or("");
    if let Some(rest) = path.strip_prefix("src-tauri/src/") {
        if rest.starts_with("bin/") || rest == "cli_test.rs" {
            return Kind::RustBin;
        }
        // Raiz do crate (lib.rs, main.rs...) afeta tudo.
        let Some((head, _)) = rest.split_once('/') else {
            return match rest.strip_suffix(".rs") {
                Some("lib") | Some("main") | None => Kind::RustAll,
                Some(m) => Kind::Rust(m.to_string()),
            };
        };
        return Kind::Rust(head.to_string());
    }
    if let Some(rest) = path.strip_prefix("src-tauri/") {
        if rest == "Cargo.toml" || rest == "Cargo.lock" || rest == "build.rs" || rest.starts_with("tauri.conf") || rest.starts_with("capabilities/") || rest.starts_with(".cargo/") {
            return Kind::RustAll;
        }
        if rest.starts_with("icons/") {
            return Kind::Ignored;
        }
        return Kind::Unmapped;
    }
    if path.starts_with("src/") {
        return match ext {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "json" | "css" => Kind::Frontend,
            _ => Kind::Unmapped,
        };
    }
    if path.starts_with("docs/") || path.starts_with("skills/") || path.starts_with("public/") {
        return Kind::Ignored;
    }
    if !path.contains('/') {
        if ext == "md" || path == "LICENSE" || path == ".gitignore" {
            return Kind::Ignored;
        }
        if path == "package.json" || path == "bun.lock" || path.starts_with("tsconfig") || path.starts_with("vite.config") || path == "index.html" {
            return Kind::FrontendAll;
        }
    }
    if path.starts_with("scripts/") {
        return Kind::FrontendAll;
    }
    Kind::Unmapped
}

/// Os comandos de teste afetados por `changed`. Ordem estável: rápidos primeiro (babel, tsc,
/// vitest, cargo). Ver `Plan::full` quando algo não tem mapa.
pub fn plan(changed: &[String]) -> Plan {
    plan_with_unsafe(changed, &[])
}

/// Como `plan`, mas `unsafe_files` (de `files_adding_unsafe`) também contam como mudança de risco.
pub fn plan_with_unsafe(changed: &[String], unsafe_files: &[String]) -> Plan {
    let files: BTreeSet<String> = changed.iter().map(|f| normalize(f)).filter(|f| !f.is_empty()).collect();
    let mut frontend: Vec<String> = Vec::new();
    let mut frontend_all = false;
    let mut rust_mods: BTreeSet<String> = BTreeSet::new();
    let (mut rust_all, mut rust_bin) = (false, false);
    let (mut ignored, mut unmapped) = (Vec::new(), Vec::new());
    let mut risk: Vec<String> = Vec::new();

    for file in files {
        if let Some(reason) = risk_reason(&file) {
            risk.push(reason);
        } else if unsafe_files.iter().any(|u| normalize(u) == file) {
            risk.push(format!("{file} (adiciona unsafe)"));
        }
        match classify(&file) {
            Kind::Frontend => frontend.push(file),
            Kind::FrontendAll => frontend_all = true,
            Kind::Rust(m) => {
                rust_mods.insert(m);
            }
            Kind::RustAll => rust_all = true,
            Kind::RustBin => rust_bin = true,
            Kind::Ignored => ignored.push(file),
            Kind::Unmapped => unmapped.push(file),
        }
    }

    let unmapped_full = !unmapped.is_empty();
    let full = unmapped_full || !risk.is_empty();
    let (frontend_all, rust_all) = (frontend_all || unmapped_full, rust_all || full);
    let mut steps = Vec::new();

    if frontend_all || !frontend.is_empty() {
        steps.push(Step::new(SUITE_BABEL, "node", &["scripts/babel-parse-check.mjs", "src"], None));
        steps.push(Step::new(SUITE_TSC, "node", &[TSC, "--noEmit"], None));
        if frontend_all {
            steps.push(Step::new(SUITE_FRONTEND, "node", &[VITEST, "run"], None));
        } else if frontend.len() > MAX_RELATED_FILES {
            steps.push(Step::new(SUITE_FRONTEND, "node", &[VITEST, "run", "--changed", "origin/master"], None));
        } else {
            let mut args = vec![VITEST.to_string(), "related".to_string(), "--run".to_string()];
            args.extend(frontend.iter().cloned());
            steps.push(Step { suite: SUITE_FRONTEND, program: "node".into(), args, cwd: None });
        }
    }

    if rust_all {
        steps.push(Step::new(SUITE_RUST, "cargo", &["test", "--lib", "--bin", "ags"], Some("src-tauri")));
    } else {
        if !rust_mods.is_empty() {
            let mut args = vec!["test".to_string(), "--lib".to_string(), "--".to_string()];
            args.extend(rust_mods.iter().map(|m| format!("{m}::")));
            steps.push(Step { suite: SUITE_RUST, program: "cargo".into(), args, cwd: Some("src-tauri") });
        }
        if rust_bin {
            steps.push(Step::new(SUITE_RUST, "cargo", &["test", "--bin", "ags"], Some("src-tauri")));
        }
    }

    Plan { steps, full, risk, unmapped, ignored }
}

#[cfg(test)]
#[path = "affected_test.rs"]
mod test;
