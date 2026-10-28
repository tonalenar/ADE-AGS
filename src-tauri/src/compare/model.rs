//! O que é uma comparação e como seus nomes são montados. Sem git e sem processo: puro.
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Prefixo das branches de comparação. Fica fora do `cc/` das missões de propósito: a limpeza de
/// missões (`missions::cleanup`) só mexe em `cc/`, e a desta tela só mexe em `cmp/`.
pub const BRANCH_ROOT: &str = "cmp/";
/// Onde fica guardado o que foi descartado com confirmação (trabalho sem commit e commits da
/// branch). Fora de `refs/heads`: não aparece como branch, mas `git branch <nome> <ref>` recupera.
pub const TRASH_REF_ROOT: &str = "refs/ags/descartes/";
pub const MIN_PICKS: usize = 2;
pub const MAX_PICKS: usize = 6;

/// Um agente/modelo escolhido no diálogo. `pick` é o pedaço do nome da branch (o frontend o gera
/// a partir do agente, do modelo e do esforço); `label` é só para mostrar.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparePick {
    pub pick: String,
    pub label: String,
    pub agent_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareEntry {
    pub pick: String,
    pub label: String,
    pub agent_id: String,
    /// Onde o agente roda: a subpasta do worktree equivalente à pasta escolhida.
    pub cwd: String,
    /// Raiz do worktree. `None` = sem isolamento (todos na mesma pasta).
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// A aba aberta para este agente (o frontend avisa depois de abrir).
    #[serde(default)]
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub id: String,
    pub title: String,
    pub slug: String,
    /// A pasta escolhida no diálogo (a do projeto, não a de um worktree).
    pub cwd: String,
    #[serde(default)]
    pub repo: Option<String>,
    /// O commit de onde os worktrees saíram e contra o qual o diff é calculado.
    #[serde(default)]
    pub base: Option<String>,
    pub isolated: bool,
    pub created_at: i64,
    /// O `pick` que o usuário escolheu manter, se já escolheu.
    #[serde(default)]
    pub kept: Option<String>,
    pub entries: Vec<CompareEntry>,
}

#[derive(Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    comparisons: Vec<Comparison>,
}

/// Um `pick` que pode ir num nome de branch sem surpresa: minúsculas, dígitos, `-` e `.`,
/// começando e terminando em letra ou dígito, sem `..` e sem `.lock` no fim (regras de ref do git).
pub fn valid_pick(pick: &str) -> bool {
    let ok_char = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.';
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    (1..=48).contains(&pick.len())
        && pick.chars().all(ok_char)
        && edge(pick.chars().next())
        && edge(pick.chars().last())
        && !pick.contains("..")
        && !pick.ends_with(".lock")
}

fn valid_agent_id(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// De 2 a 6 escolhas, cada uma com nome de branch válido e único. Pura.
pub fn validate_picks(picks: &[ComparePick]) -> Result<(), String> {
    if !(MIN_PICKS..=MAX_PICKS).contains(&picks.len()) {
        return Err(format!("Escolha de {MIN_PICKS} a {MAX_PICKS} modelos para comparar."));
    }
    let mut seen = std::collections::HashSet::new();
    for p in picks {
        if !valid_pick(&p.pick) {
            return Err(format!("Nome inválido para a branch: '{}'.", p.pick));
        }
        if !valid_agent_id(&p.agent_id) {
            return Err(format!("Agente inválido: '{}'.", p.agent_id));
        }
        let label = p.label.trim();
        if label.is_empty() || label.chars().count() > 120 {
            return Err("Cada modelo precisa de um rótulo de até 120 caracteres.".into());
        }
        if !seen.insert(p.pick.as_str()) {
            return Err(format!("O modelo '{}' aparece duas vezes.", p.pick));
        }
    }
    Ok(())
}

/// O pedaço legível da comparação, tirado do título (até 24 caracteres). Pura.
pub fn title_slug(title: &str) -> String {
    if title.trim().is_empty() {
        return "comparacao".into();
    }
    let slug = crate::runs::worktrees::branch_slug(title);
    let cut: String = slug.chars().take(24).collect();
    let cut = cut.trim_matches('-').to_string();
    if cut.is_empty() { "comparacao".into() } else { cut }
}

/// `cmp/<slug>-<id>/<pick>`: o id curto evita colidir com uma comparação antiga do mesmo título. Pura.
pub fn branch_for(slug: &str, id: &str, pick: &str) -> String {
    format!("{BRANCH_ROOT}{slug}-{id}/{pick}")
}

/// Onde fica guardado o que se descartou de um `pick`. Pura.
pub fn trash_ref_for(id: &str, pick: &str) -> String {
    format!("{TRASH_REF_ROOT}{id}/{pick}")
}

/// `numstat` do git → (arquivos, linhas adicionadas, linhas removidas). Binário (`-`) conta como
/// arquivo, sem linhas. Pura.
pub fn parse_numstat(out: &str) -> (usize, u64, u64) {
    let mut files = 0;
    let (mut add, mut del) = (0u64, 0u64);
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let mut parts = line.splitn(3, '\t');
        let (a, d) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if parts.next().is_none() {
            continue;
        }
        files += 1;
        add += a.parse::<u64>().unwrap_or(0);
        del += d.parse::<u64>().unwrap_or(0);
    }
    (files, add, del)
}

/// Corta `text` em até `limit` bytes sem partir um caractere. Pura.
pub fn truncate_utf8(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

pub fn read_registry(path: &Path) -> Vec<Comparison> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RegistryFile>(&raw).ok())
        .map(|f| f.comparisons)
        .unwrap_or_default()
}

pub fn write_registry(path: &Path, comparisons: &[Comparison]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&RegistryFile { comparisons: comparisons.to_vec() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
