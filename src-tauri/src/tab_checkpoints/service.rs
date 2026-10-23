//! Tirar, listar, comparar, restaurar e limpar pontos de restauração. Sem `AppHandle`: os testes
//! chamam isto direto, contra um repositório temporário e o banco em memória.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use super::git;
use super::lock::{self, Blocker};
use super::store::{self, kind, TabCheckpoint, MAX_PER_TAB};
use crate::database::DbConnection;

/// O tamanho máximo do patch que a tela recebe.
pub const DIFF_MAX_BYTES: usize = 512 * 1024;
/// Quantos caracteres da primeira linha da mensagem ficam na ficha.
pub const MESSAGE_MAX_CHARS: usize = 140;

/// Uma foto por vez em cada repositório: duas abas no mesmo repo mandando mensagem juntas não
/// fazem dois `git add` brigando pelo disco, e a restauração não corre por baixo de uma foto.
fn repo_lock(root: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = lock::normalize(&root.to_string_lossy());
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_default().clone()
}

/// A primeira linha com texto, cortada em `max` caracteres. Pura.
pub fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() <= max {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Capture {
    /// Um ponto novo.
    Created { checkpoint: TabCheckpoint },
    /// Nada mudou desde o último ponto da aba: não se cria outro.
    Unchanged { checkpoint: TabCheckpoint },
    /// A pasta não é um repositório git (ou o git não está instalado).
    NotRepo,
}

/// O pedido de um ponto.
pub struct Request<'a> {
    pub tab_id: &'a str,
    pub cwd: &'a Path,
    pub kind: &'a str,
    pub author: &'a str,
    pub message: &'a str,
    /// Cria mesmo que nada tenha mudado (a foto de segurança de uma restauração).
    pub force: bool,
}

/// Tira um ponto da pasta da aba (ver o módulo). Nunca segura o banco enquanto roda o git.
pub fn capture(db: &DbConnection, req: &Request<'_>) -> Result<Capture, String> {
    let Some(root) = git::repo_root(req.cwd) else { return Ok(Capture::NotRepo) };
    let guard = repo_lock(&root);
    let _held = guard.lock().unwrap_or_else(|e| e.into_inner());
    capture_locked(db, &root, req, false)
}

/// `strict`: um arquivo travado (que não deu para ler) é erro, e nada é criado. A foto de segurança
/// de uma restauração é estrita: sem o conteúdo de agora daquele arquivo, desfazer a restauração o
/// voltaria a uma versão velha.
fn capture_locked(db: &DbConnection, root: &Path, req: &Request<'_>, strict: bool) -> Result<Capture, String> {
    let tree = git::worktree_tree(root)?;
    if strict && !tree.unreadable.is_empty() {
        return Err(format!(
            "Estes arquivos estão abertos por outro programa e não dá para guardar como estão agora: {}. Feche-os e tente de novo.",
            tree.unreadable.join(", ")
        ));
    }
    let root_s = root.to_string_lossy().to_string();
    let (last, seq) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        (store::last(&conn, req.tab_id)?, store::next_seq(&conn, req.tab_id)?)
    };
    if !req.force
        && let Some(last) = last.filter(|l| l.tree_sha == tree.tree && lock::normalize(&l.repo_root) == lock::normalize(&root_s))
    {
        return Ok(Capture::Unchanged { checkpoint: last });
    }
    let ref_name = git::ref_name(req.tab_id, seq);
    // A mensagem do commit é genérica de propósito: o texto da pessoa fica no banco local, não no
    // repositório nem na linha de comando (que vai para o log).
    let commit = git::commit(root, &tree, &format!("ags checkpoint {} #{seq}", git::scope_of(req.tab_id)))?;
    git::set_ref(root, &ref_name, &commit)?;
    let checkpoint = TabCheckpoint {
        id: uuid::Uuid::new_v4().simple().to_string(),
        tab_id: req.tab_id.to_string(),
        seq,
        kind: req.kind.to_string(),
        author: req.author.to_string(),
        message: first_line(req.message, MESSAGE_MAX_CHARS),
        repo_root: root_s,
        ref_name,
        commit_sha: commit,
        tree_sha: tree.tree,
        head_sha: tree.head,
        created_at: crate::util::now_ts_ms(),
    };
    let evicted = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::insert(&conn, &checkpoint)?;
        store::evict_beyond(&conn, req.tab_id, MAX_PER_TAB)?
    };
    release_refs(&evicted);
    Ok(Capture::Created { checkpoint })
}

/// Solta as refs das fichas que saíram. Uma falha (pasta que sumiu) não é motivo para parar.
fn release_refs(gone: &[TabCheckpoint]) {
    for c in gone {
        if let Err(e) = git::delete_ref(Path::new(&c.repo_root), &c.ref_name) {
            eprintln!("[tab-checkpoints] não soltei {}: {e}", c.ref_name);
        }
    }
}

pub fn list(db: &DbConnection, tab_id: &str) -> Result<Vec<TabCheckpoint>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list(&conn, tab_id)
}

fn get(db: &DbConnection, id: &str) -> Result<TabCheckpoint, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::get(&conn, id)?.ok_or_else(|| "Este ponto não existe mais.".to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffView {
    pub stat: String,
    pub patch: String,
    pub truncated: bool,
}

/// O que mudou nos arquivos desde o ponto `id` até agora (inclui o que ainda não foi commitado).
pub fn diff_since(db: &DbConnection, id: &str) -> Result<DiffView, String> {
    let cp = get(db, id)?;
    let root = PathBuf::from(&cp.repo_root);
    if !root.is_dir() {
        return Err(format!("A pasta {} já não existe.", cp.repo_root));
    }
    let now = {
        let guard = repo_lock(&root);
        let _held = guard.lock().unwrap_or_else(|e| e.into_inner());
        git::worktree_tree(&root)?
    };
    if !git::exists(&root, &format!("{}^{{commit}}", cp.commit_sha)) {
        return Err("A foto não está mais no repositório (foi limpa com git gc?).".into());
    }
    let (stat, patch, truncated) = git::diff(&root, &cp.commit_sha, &now.tree, DIFF_MAX_BYTES)?;
    Ok(DiffView { stat, patch, truncated })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    /// Quem mais usa a pasta. Não vazio = nada foi feito: a tela pergunta se é para forçar.
    pub blockers: Vec<Blocker>,
    /// A foto do estado de antes da restauração: restaurá-la desfaz esta.
    pub safety: Option<TabCheckpoint>,
    pub report: Option<git::RestoreReport>,
}

/// Volta os arquivos da pasta ao ponto `id`. `tabs`/`tasks` = quem mais está vivo, com a pasta de
/// cada um; com algum deles na mesma pasta e sem `force`, devolve os `blockers` sem mexer em nada.
/// Antes de restaurar, tira a foto de segurança (sempre, mesmo sem mudanças).
pub fn restore(
    db: &DbConnection,
    id: &str,
    force: bool,
    tabs: &[(String, String)],
    tasks: &[(String, String)],
) -> Result<Restore, String> {
    let cp = get(db, id)?;
    let root = PathBuf::from(&cp.repo_root);
    if !root.is_dir() {
        return Err(format!("A pasta {} já não existe.", cp.repo_root));
    }
    let blockers = lock::blockers(&cp.repo_root, &cp.tab_id, tabs, tasks);
    if !blockers.is_empty() && !force {
        return Ok(Restore { blockers, safety: None, report: None });
    }
    let guard = repo_lock(&root);
    let _held = guard.lock().unwrap_or_else(|e| e.into_inner());
    if !git::exists(&root, &format!("{}^{{tree}}", cp.commit_sha)) {
        return Err("A foto não está mais no repositório (foi limpa com git gc?).".into());
    }
    let label = format!("antes de voltar ao ponto #{}", cp.seq);
    let req = Request { tab_id: &cp.tab_id, cwd: &root, kind: kind::SAFETY, author: "ags", message: &label, force: true };
    let safety = match capture_locked(db, &root, &req, true)? {
        Capture::Created { checkpoint } | Capture::Unchanged { checkpoint } => checkpoint,
        Capture::NotRepo => return Err("A pasta deixou de ser um repositório git.".into()),
    };
    let report = git::restore(&root, &cp.commit_sha, &safety.tree_sha)?;
    Ok(Restore { blockers, safety: Some(safety), report: Some(report) })
}

/// Apaga todos os pontos da aba (fichas e refs). Devolve quantos saíram.
pub fn remove_tab(db: &DbConnection, tab_id: &str) -> Result<usize, String> {
    let gone = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::remove_tab(&conn, tab_id)?
    };
    release_refs(&gone);
    Ok(gone.len())
}

/// Quanto tempo um ponto de uma aba que não está salva espera antes de ser limpo: a aba recém-aberta
/// só aparece em `tabs` depois do salvamento (com debounce).
pub const ORPHAN_GRACE_MS: i64 = 10 * 60_000;

/// Limpa os pontos das abas fechadas de vez (fora de `tabs` e de `alive`). Devolve quantos saíram.
pub fn prune(db: &DbConnection, alive: &[String], now_ms: i64) -> Result<usize, String> {
    let orphans = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::orphan_tabs(&conn, alive, now_ms - ORPHAN_GRACE_MS)?
    };
    let mut total = 0;
    for tab in orphans {
        total += remove_tab(db, &tab)?;
    }
    Ok(total)
}
