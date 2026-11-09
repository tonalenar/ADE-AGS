//! Busca rápida de nomes de arquivo no workspace para a paleta.
//!
//! Usa o walker de `ignore` para respeitar `.gitignore`, ignora `.git` e `node_modules`,
//! e limita tempo, entradas percorridas e resultados. A busca antiga de cada janela é
//! cancelada quando chega uma consulta mais nova.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

const MAX_RESULTS: usize = 100;
const MAX_VISITED: usize = 100_000;
const MAX_QUERY_CHARS: usize = 128;
const SEARCH_BUDGET: Duration = Duration::from_millis(400);
const ALWAYS_SKIP: &[&str] = &[".git", "node_modules"];

static GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenQuery {
    pub root: String,
    pub query: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenFile {
    pub name: String,
    /// Caminho absoluto relativo à raiz pedida, preservando a grafia do workspace.
    pub path: String,
    /// Caminho relativo com separadores `/`, usado para exibição e ranking.
    pub rel: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenResult {
    pub files: Vec<QuickOpenFile>,
    /// A busca atingiu o limite de tempo, entradas ou resultados.
    pub truncated: bool,
    /// Uma consulta mais nova substituiu esta antes de terminar.
    pub cancelled: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct RankedFile {
    score: u32,
    file: QuickOpenFile,
}

impl Ord for RankedFile {
    fn cmp(&self, other: &Self) -> Ordering {
        // A cabeça do heap guarda a pior correspondência para manter apenas as melhores.
        (self.score, &self.file.rel).cmp(&(other.score, &other.file.rel))
    }
}

impl PartialOrd for RankedFile {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn normalize(value: &str) -> String {
    value
        .nfd()
        .filter(|ch| !is_combining_mark(*ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn subsequence_penalty(candidate: &str, query: &str) -> Option<u32> {
    let candidate: Vec<char> = candidate.chars().collect();
    let query: Vec<char> = query.chars().collect();
    let mut next = 0;
    let mut previous = None;
    let mut penalty = 0u32;

    for (index, ch) in candidate.iter().enumerate() {
        if *ch != query[next] {
            continue;
        }
        if let Some(previous) = previous {
            penalty = penalty.saturating_add((index - previous - 1) as u32 * 3);
            if index == previous + 1 {
                penalty = penalty.saturating_sub(1);
            }
        } else {
            penalty = penalty.saturating_add(index as u32 * 2);
        }
        if index == 0 || !candidate[index - 1].is_alphanumeric() {
            penalty = penalty.saturating_sub(2);
        }
        previous = Some(index);
        next += 1;
        if next == query.len() {
            return Some(penalty);
        }
    }
    None
}

fn score_path(rel: &str, query: &str) -> Option<u32> {
    let rel = normalize(&rel.replace('\\', "/"));
    let query = normalize(&query.replace('\\', "/"));
    let fuzzy_query: String = query.chars().filter(|ch| !ch.is_whitespace()).collect();
    if query.is_empty() {
        return None;
    }
    let name = rel.rsplit('/').next().unwrap_or(&rel);

    if rel == query {
        return Some(0);
    }
    if name == query {
        return Some(1);
    }
    if name.starts_with(&query) {
        return Some(10 + name.len().saturating_sub(query.len()) as u32);
    }
    if rel.starts_with(&query) {
        return Some(20 + rel.len().saturating_sub(query.len()) as u32);
    }
    if name
        .split(|ch: char| !ch.is_alphanumeric())
        .any(|part| part.starts_with(&query))
    {
        return Some(30 + name.len().saturating_sub(query.len()) as u32);
    }
    if name.contains(&query) {
        return Some(40 + name.len().saturating_sub(query.len()) as u32);
    }
    if rel.contains(&query) {
        return Some(50 + rel.len().saturating_sub(query.len()) as u32);
    }
    subsequence_penalty(name, &fuzzy_query)
        .map(|penalty| 60 + penalty)
        .or_else(|| subsequence_penalty(&rel, &fuzzy_query).map(|penalty| 90 + penalty))
}

fn search(query: &QuickOpenQuery, is_stale: impl Fn() -> bool) -> Result<QuickOpenResult, String> {
    let needle = query.query.trim();
    if needle.is_empty() {
        return Ok(QuickOpenResult::default());
    }
    if needle.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "a busca rápida aceita até {MAX_QUERY_CHARS} caracteres"
        ));
    }

    let root = Path::new(&query.root);
    if !root.is_dir() {
        return Err(format!("{} não é um diretório", query.root));
    }

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| !ALWAYS_SKIP.iter().any(|skip| entry.file_name() == *skip))
        .build();
    let started = Instant::now();
    let mut visited = 0usize;
    let mut matched = 0usize;
    let mut truncated = false;
    let mut best = BinaryHeap::with_capacity(MAX_RESULTS);

    for entry in walker {
        if is_stale() {
            return Ok(QuickOpenResult {
                files: Vec::new(),
                truncated: false,
                cancelled: true,
            });
        }
        if started.elapsed() >= SEARCH_BUDGET || visited >= MAX_VISITED {
            truncated = true;
            break;
        }
        visited += 1;
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(rel_path) = entry.path().strip_prefix(root).ok() else {
            continue;
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        let Some(score) = score_path(&rel, needle) else {
            continue;
        };
        let path = entry.path().to_string_lossy().to_string();
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        matched += 1;
        let ranked = RankedFile {
            score,
            file: QuickOpenFile { name, path, rel },
        };

        if best.len() < MAX_RESULTS {
            best.push(ranked);
        } else if best.peek().is_some_and(|worst| ranked < *worst) {
            best.pop();
            best.push(ranked);
        }
    }

    if matched > MAX_RESULTS {
        truncated = true;
    }
    let files = best
        .into_sorted_vec()
        .into_iter()
        .map(|ranked| ranked.file)
        .collect();
    Ok(QuickOpenResult {
        files,
        truncated,
        cancelled: false,
    })
}

#[tauri::command]
pub async fn explorer_quick_open(
    window: tauri::Window,
    query: QuickOpenQuery,
) -> Result<QuickOpenResult, String> {
    let label = window.label().to_string();
    let generation = {
        let mut generations = GENERATIONS.lock().map_err(|error| error.to_string())?;
        let next = generations.get(&label).copied().unwrap_or(0) + 1;
        generations.insert(label.clone(), next);
        next
    };

    tauri::async_runtime::spawn_blocking(move || {
        search(&query, || {
            GENERATIONS
                .lock()
                .map(|generations| generations.get(&label).copied() != Some(generation))
                .unwrap_or(false)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
