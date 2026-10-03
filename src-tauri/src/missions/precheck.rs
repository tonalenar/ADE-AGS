//! "Isto já foi feito?": a checagem antes de convocar a equipe.
//!
//! Uma missão de teste mostrou o custo de não ter isto: o objetivo pedia uma melhoria que
//! JÁ estava no código, e três agentes passaram 17 minutos relendo e reconferindo antes de
//! concluir "nenhuma alteração necessária". A checagem é mecânica, sem inferência: tira do
//! objetivo os caminhos e os termos que nomeiam algo, e procura no repositório e nas missões
//! anteriores o que já mexeu neles. O resultado entra no briefing do Orquestrador, que decide
//! (com os fatos na mão) se convoca a equipe ou conclui.
//!
//! Só lê: `git log` e `git grep`, mais a tabela de missões. Nunca escreve nem executa o
//! projeto.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

const MAX_PATHS: usize = 8;
const MAX_TERMS: usize = 8;
const MAX_COMMITS: usize = 3;
const MAX_FILES: usize = 5;
const GIT_TIMEOUT: Duration = Duration::from_secs(8);
/// O texto que vai ao briefing não passa disto: é contexto, não um relatório.
const MAX_RENDER: usize = 2_400;

/// Carpetas que no son del producto: citarlas en un objetivo ("rode node_modules/.../tsc") no es
/// pedir algo sobre ellas.
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", ".git"];

const EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "rs", "json", "md", "css", "toml", "yml", "yaml", "py", "html"];

// ── Extração (pura) ─────────────────────────────────────────────────

/// Os caminhos de arquivo que o objetivo cita: o que tem `/` ou termina em extensão conhecida.
pub fn extract_paths(objective: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in objective.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | '"' | '`' | ',' | ';')) {
        let token = raw.trim_matches(|c: char| matches!(c, '\'' | '.' | ':' | '!' | '?'));
        if token.len() < 3 || token.contains("://") {
            continue;
        }
        let ext = token.rsplit('.').next().filter(|_| token.contains('.')).unwrap_or("");
        let looks_like_file = EXTENSIONS.contains(&ext) && !token.starts_with('.') && !token.ends_with('.');
        let looks_like_path = token.contains('/') && token.chars().any(|c| c.is_alphabetic());
        let in_artifacts = token.split('/').any(|part| IGNORED_DIRS.contains(&part));
        if (looks_like_file || looks_like_path) && !in_artifacts && !out.iter().any(|p| p == token) {
            out.push(token.to_string());
        }
        if out.len() >= MAX_PATHS {
            break;
        }
    }
    out
}

fn is_identifier(word: &str) -> bool {
    let has_alpha = word.chars().any(char::is_alphabetic);
    let snake = word.contains('_');
    let camel = word.chars().skip(1).any(char::is_uppercase) && word.chars().any(char::is_lowercase);
    has_alpha && word.len() >= 4 && word.len() <= 40 && (snake || camel) && word.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// Os termos que NOMEIAM algo: o que vem entre aspas ou crases e os identificadores
/// (camelCase, snake_case). Palavras comuns não: buscá-las só traria ruído.
pub fn extract_terms(objective: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |term: &str| {
        let t = term.trim().trim_matches(|c: char| matches!(c, '?' | '!' | '.' | ':' | ','));
        let long_enough = t.chars().count() >= 4;
        if long_enough && t.chars().count() <= 40 && !t.contains('/') && !out.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    };

    // Entre aspas simples, duplas ou crases.
    let chars: Vec<char> = objective.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let q = chars[i];
        if matches!(q, '\'' | '"' | '`') {
            let start = i + 1;
            // Um apóstrofo no meio de uma palavra (d'água) não abre aspas.
            let opens = i == 0 || !chars[i - 1].is_alphanumeric();
            if opens {
                if let Some(rel) = chars[start..].iter().position(|c| *c == q) {
                    let inner: String = chars[start..start + rel].iter().collect();
                    if !inner.contains(char::is_whitespace) || inner.split_whitespace().count() <= 3 {
                        push(&inner);
                    }
                    i = start + rel + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    for word in objective.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        if is_identifier(word) {
            push(word);
        }
    }
    out.truncate(MAX_TERMS);
    out
}

/// Parecença entre dois textos, de 0 a 1: palavras em comum sobre palavras no total.
pub fn similarity(a: &str, b: &str) -> f64 {
    fn words(text: &str) -> std::collections::HashSet<String> {
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() >= 4)
            .map(str::to_string)
            .collect()
    }
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    let shared = wa.intersection(&wb).count() as f64;
    shared / (wa.len() + wb.len()) as f64 * 2.0
}

// ── Achados ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathFinding {
    pub path: String,
    pub exists: bool,
    pub recent_commits: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TermFinding {
    pub term: String,
    pub commits: Vec<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarMission {
    pub id: String,
    pub title: String,
    pub status: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Precheck {
    pub paths: Vec<PathFinding>,
    pub terms: Vec<TermFinding>,
    pub similar_missions: Vec<SimilarMission>,
}

impl Precheck {
    /// Há algum indício de que o pedido já existe (um termo achado no código ou no histórico,
    /// ou uma missão parecida já concluída).
    pub fn has_leads(&self) -> bool {
        self.terms.iter().any(|t| !t.commits.is_empty() || !t.files.is_empty())
            || self.similar_missions.iter().any(|m| m.status == "done")
    }
}

fn git(dir: &Path, args: &[&str]) -> Vec<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    match crate::util::output_with_timeout(&mut cmd, GIT_TIMEOUT) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

const LOG_FORMAT: &str = "--format=%h %ad %s";

/// Un commit por línea, sin pasar de lo que cabe: es una pista, no el historial.
fn short(lines: Vec<String>) -> Vec<String> {
    lines.into_iter().map(|l| if l.chars().count() > 100 { l.chars().take(100).collect::<String>() + "…" } else { l }).collect()
}

fn commits_for_path(dir: &Path, path: &str) -> Vec<String> {
    short(git(dir, &["log", "-n", &MAX_COMMITS.to_string(), LOG_FORMAT, "--date=short", "--", path]))
}

fn commits_for_term(dir: &Path, term: &str) -> Vec<String> {
    short(git(dir, &["log", "-n", &MAX_COMMITS.to_string(), LOG_FORMAT, "--date=short", "-i", "-F", &format!("--grep={term}")]))
}

/// Un archivo de pruebas o de datos no dice si la funcionalidad existe en el producto.
fn is_product_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    !(lower.contains("/tests/") || lower.contains("/test.rs") || lower.contains(".test.") || lower.contains("/test/") || lower.contains("testdata") || lower.contains("fixtures") || lower.ends_with(".md") || lower.starts_with("docs/"))
}

/// `None` si el término está en tantos archivos que no distingue nada ("Confirmar", "node_modules").
fn files_with_term(dir: &Path, term: &str) -> Option<Vec<String>> {
    let all = git(dir, &["grep", "-l", "-i", "-F", "-e", term, "--", ".", ":(exclude)*.lock", ":(exclude)*.json"]);
    let mut files: Vec<String> = all.into_iter().filter(|f| is_product_file(f)).collect();
    if files.len() > MAX_FILES {
        return None;
    }
    files.truncate(MAX_FILES);
    Some(files)
}

/// Missões anteriores da mesma pasta que se parecem com este objetivo, da mais parecida à menos.
pub fn similar_missions(conn: &Connection, current_id: &str, cwd: &str, objective: &str) -> Vec<SimilarMission> {
    let Ok(mut stmt) = conn.prepare("SELECT id, title, objective, status FROM missions WHERE cwd = ?1 AND id != ?2 AND status != 'draft'") else {
        return Vec::new();
    };
    let rows = stmt.query_map([cwd, current_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)));
    let mut found: Vec<SimilarMission> = match rows {
        Ok(rows) => rows
            .flatten()
            .map(|(id, title, other, status)| {
                let score = similarity(objective, &format!("{title} {other}"));
                SimilarMission { id, title, status, score }
            })
            .filter(|m| m.score >= 0.45)
            .collect(),
        Err(_) => Vec::new(),
    };
    found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    found.truncate(3);
    found
}

/// A checagem completa de um objetivo em uma pasta.
pub fn run(conn: &Connection, mission_id: &str, cwd: &str, objective: &str) -> Precheck {
    let dir = Path::new(cwd);
    let paths = extract_paths(objective)
        .into_iter()
        .filter(|path| path.rsplit('.').next().is_some_and(|ext| path.contains('.') && EXTENSIONS.contains(&ext)) || dir.join(path).exists())
        .map(|path| {
            let exists = dir.join(&path).exists();
            let recent_commits = if exists { commits_for_path(dir, &path) } else { Vec::new() };
            PathFinding { path, exists, recent_commits }
        })
        .collect();
    let terms = extract_terms(objective)
        .into_iter()
        .filter_map(|term| {
            let files = files_with_term(dir, &term)?;
            Some(TermFinding { commits: commits_for_term(dir, &term), files, term })
        })
        .collect();
    Precheck { paths, terms, similar_missions: similar_missions(conn, mission_id, cwd, objective) }
}

/// O texto do briefing: curto, em português, com os fatos e a regra de decisão. Pura.
pub fn render(check: &Precheck) -> String {
    let mut lines: Vec<String> = Vec::new();
    for m in &check.similar_missions {
        lines.push(format!("- missão parecida ({}%, {}): \"{}\" ({})", (m.score * 100.0).round() as i64, m.status, m.title, &m.id[..m.id.len().min(8)]));
    }
    for p in &check.paths {
        if !p.exists {
            lines.push(format!("- {}: não existe neste projeto.", p.path));
        } else if p.recent_commits.is_empty() {
            lines.push(format!("- {}: existe, sem commits no histórico.", p.path));
        } else {
            lines.push(format!("- {}: existe; últimos commits: {}", p.path, p.recent_commits.join(" | ")));
        }
    }
    for t in &check.terms {
        if t.commits.is_empty() && t.files.is_empty() {
            continue;
        }
        let mut parts = Vec::new();
        if !t.files.is_empty() {
            parts.push(format!("aparece em {}", t.files.join(", ")));
        }
        if !t.commits.is_empty() {
            parts.push(format!("citado nos commits: {}", t.commits.join(" | ")));
        }
        lines.push(format!("- termo \"{}\" {}", t.term, parts.join("; ")));
    }
    if lines.is_empty() {
        return String::new();
    }
    let rule = if check.has_leads() {
        "Há indícios de que parte disto JÁ existe. ANTES de convocar a equipe, confira você mesmo esses pontos (leia os trechos, rode só o que for barato). Se o pedido já estiver atendido, conclua a missão com um resumo curto, sem acionar os integrantes."
    } else {
        "Nada indica que isto já exista; siga com o plano normal."
    };
    let mut text = format!("O QUE JÁ EXISTE (checagem automática, só leitura)\n{}\n{}", lines.join("\n"), rule);
    if text.chars().count() > MAX_RENDER {
        text = text.chars().take(MAX_RENDER).collect::<String>() + "…";
    }
    text
}

#[cfg(test)]
mod test;
