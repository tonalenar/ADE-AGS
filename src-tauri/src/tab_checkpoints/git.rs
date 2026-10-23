//! A parte git dos pontos de restauração das abas.
//!
//! Tudo aqui trabalha "por fora": a foto é montada num índice temporário (`GIT_INDEX_FILE`),
//! vira um commit cujo pai é o `HEAD` do momento e fica pendurada numa ref escondida
//! (`refs/ags/checkpoints/<aba>/<n>`). A branch, o índice e o stash da pessoa não mudam.
//! Restaurar escreve só os arquivos que diferem (também por um índice temporário) e apaga os
//! que nasceram depois da foto; o `HEAD` fica onde está.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::util::{external_path, output_with_timeout};

const GIT_FAST: Duration = Duration::from_secs(20);
const GIT_SLOW: Duration = Duration::from_secs(120);

/// Onde ficam as refs escondidas. `git push` comum (heads e tags) não as leva.
pub const REF_PREFIX: &str = "refs/ags/checkpoints";

/// Um gitlink (submódulo): não é um arquivo, e restaurar não mexe nele.
const GITLINK_MODE: &str = "160000";

/// Linha de comando cabe em 32 K no Windows: os caminhos vão em lotes bem menores.
const ARGS_BUDGET: usize = 8_000;

fn command(dir: &Path, args: &[&str], envs: &[(&str, &str)]) -> Command {
    let mut cmd = crate::util::spawn::hidden_command("git");
    // Um `GIT_DIR`/`GIT_INDEX_FILE` herdado apontaria o git para outro repositório ou para o
    // índice da pessoa: aqui só vale o que este módulo passa.
    for var in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"] {
        cmd.env_remove(var);
    }
    cmd.arg("-C").arg(external_path(dir));
    // `longpaths`: caminhos longos no Windows. `safecrlf=false`: com `core.safecrlf=true` um
    // arquivo com fim de linha misto faria o `add` falhar e a foto inteira com ele.
    // `quotepath=false`: nomes com acento saem como são.
    cmd.args(["-c", "core.longpaths=true", "-c", "core.safecrlf=false", "-c", "core.quotepath=false"]);
    cmd.args(args);
    // Identidade própria: a foto não pode falhar porque a máquina não tem `user.name`.
    cmd.env("GIT_AUTHOR_NAME", "ADE AGS")
        .env("GIT_AUTHOR_EMAIL", "checkpoint@ags.local")
        .env("GIT_COMMITTER_NAME", "ADE AGS")
        .env("GIT_COMMITTER_EMAIL", "checkpoint@ags.local")
        // Sem prompt de senha nem lock opcional no índice da pessoa (`git diff` o atualizaria).
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd
}

fn run(dir: &Path, args: &[&str], envs: &[(&str, &str)], limit: Duration) -> Result<String, String> {
    let mut cmd = command(dir, args, envs);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            format!("o git demorou mais de {} s (git {})", limit.as_secs(), args.first().copied().unwrap_or(""))
        } else {
            format!("não foi possível rodar o git: {e}")
        }
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} falhou", args.first().copied().unwrap_or("")) } else { err })
    }
}

/// Saída crua (com os `\0` de `-z`), sem aparar nada.
fn run_raw(dir: &Path, args: &[&str], envs: &[(&str, &str)], limit: Duration) -> Result<Vec<u8>, String> {
    let mut cmd = command(dir, args, envs);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| format!("não foi possível rodar o git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A raiz do repositório (ou worktree) que contém `dir`. `None` = não é um repositório git
/// (ou o git não está instalado): a aba simplesmente não tem pontos de restauração.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    run(dir, &["rev-parse", "--show-toplevel"], &[], GIT_FAST).ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// O `HEAD` de agora; `None` num repositório sem nenhum commit.
pub fn head(root: &Path) -> Option<String> {
    run(root, &["rev-parse", "--verify", "-q", "HEAD^{commit}"], &[], GIT_FAST).ok().filter(|s| !s.is_empty())
}

/// O objeto existe no repositório (`<sha>^{tree}`, `<sha>^{commit}`…)?
pub fn exists(root: &Path, rev: &str) -> bool {
    run(root, &["cat-file", "-e", rev], &[], GIT_FAST).is_ok()
}

/// Nome de ref seguro para o id de uma aba: só letras, números, `-` e `_`.
pub fn scope_of(tab_id: &str) -> String {
    let clean: String = tab_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if clean.is_empty() { "_".into() } else { clean }
}

pub fn ref_name(tab_id: &str, seq: i64) -> String {
    format!("{REF_PREFIX}/{}/{seq}", scope_of(tab_id))
}

/// O índice temporário: um arquivo único dentro do git dir, apagado (com o `.lock`) ao sair.
struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    fn new(root: &Path) -> Result<TempIndex, String> {
        let git_dir = run(root, &["rev-parse", "--absolute-git-dir"], &[], GIT_FAST)?;
        let path = Path::new(&git_dir).join(format!("ags-checkpoint-{}.index", uuid::Uuid::new_v4().simple()));
        Ok(TempIndex { path })
    }
    fn env(&self) -> String {
        external_path(&self.path).to_string_lossy().to_string()
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

/// O índice de verdade da pessoa (no worktree, `.git/worktrees/<nome>/index`).
fn real_index(root: &Path) -> Option<PathBuf> {
    let path = run(root, &["rev-parse", "--git-path", "index"], &[], GIT_FAST).ok()?;
    let path = PathBuf::from(path);
    let path = if path.is_absolute() { path } else { root.join(path) };
    path.is_file().then_some(path)
}

/// O estado de agora do árbol de trabalho como uma árvore git.
#[derive(Debug, Clone)]
pub struct Tree {
    pub tree: String,
    pub head: Option<String>,
    /// Arquivos que não deu para ler (travados por outro programa): na árvore, ficaram como
    /// estavam no índice, não como estão no disco.
    pub unreadable: Vec<String>,
}

/// Monta a árvore do que está no disco agora: o modificado, o novo e o apagado, sem o ignorado.
/// Só escreve objetos no repositório; o índice, a branch e os arquivos não mudam.
///
/// O índice temporário começa como uma CÓPIA do índice da pessoa: assim o `add` só lê os arquivos
/// que mudaram (os outros já têm o stat no índice), e as entradas `skip-worktree` de um sparse
/// checkout não somem da foto. Se a cópia não servir (um índice sendo escrito naquele instante),
/// começa do `HEAD`.
pub fn worktree_tree(root: &Path) -> Result<Tree, String> {
    let head = head(root);
    let index = TempIndex::new(root)?;
    let env_value = index.env();
    let env = [("GIT_INDEX_FILE", env_value.as_str())];

    let from_copy = real_index(root).is_some_and(|real| std::fs::copy(real, &index.path).is_ok());
    let mut unreadable = Vec::new();
    let staged = from_copy && add_all(root, &env).map(|u| unreadable = u).is_ok();
    if !staged {
        let _ = std::fs::remove_file(&index.path);
        match &head {
            Some(h) => run(root, &["read-tree", h], &env, GIT_FAST)?,
            None => run(root, &["read-tree", "--empty"], &env, GIT_FAST)?,
        };
        unreadable = add_all(root, &env)?;
    }
    let tree = run(root, &["write-tree"], &env, GIT_FAST)?;
    Ok(Tree { tree, head, unreadable })
}

/// `git add -A` que não para num arquivo que não dá para ler (aberto com trava exclusiva por outro
/// programa, comum no Windows): esse fica como estava no índice e o resto entra na foto. Qualquer
/// outro erro (índice corrompido, disco) é erro.
fn add_all(root: &Path, env: &[(&str, &str)]) -> Result<Vec<String>, String> {
    match run(root, &["add", "-A", "--ignore-errors", "--", "."], env, GIT_SLOW) {
        Ok(_) => Ok(Vec::new()),
        Err(e) => unreadable_files(&e).ok_or(e),
    }
}

/// Se o erro do `add --ignore-errors` é só de arquivos que não deu para ler, quais são. `None` =
/// houve outro erro. Pura.
pub fn unreadable_files(stderr: &str) -> Option<Vec<String>> {
    let mut files = Vec::new();
    for line in stderr.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let lower = line.to_lowercase();
        if lower.starts_with("warning:") {
            continue;
        }
        if lower.contains("unable to index file") {
            // error: unable to index file 'a.txt'
            if let Some(name) = line.split_once('\'').and_then(|(_, rest)| rest.rsplit_once('\'')).map(|(name, _)| name) {
                files.push(name.to_string());
            }
            continue;
        }
        let unreadable = lower.contains("permission denied")
            || lower.contains("updating files failed")
            || lower.contains("short read")
            || lower.starts_with("error: open(")
            || lower.starts_with("error: read error");
        if !unreadable {
            return None;
        }
    }
    (!files.is_empty()).then_some(files)
}

/// O commit da foto: a árvore, com o `HEAD` do momento como pai (sem pai num repositório vazio).
/// `--no-gpg-sign`: é um objeto interno; com `commit.gpgSign` ligado, cada mensagem abriria o
/// pedido de senha da chave.
pub fn commit(root: &Path, tree: &Tree, message: &str) -> Result<String, String> {
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree.tree.as_str()];
    if let Some(h) = tree.head.as_deref() {
        args.extend(["-p", h]);
    }
    args.extend(["-m", message]);
    run(root, &args, &[], GIT_FAST)
}

pub fn set_ref(root: &Path, name: &str, commit: &str) -> Result<(), String> {
    run(root, &["update-ref", name, commit], &[], GIT_FAST).map(|_| ())
}

/// Solta a ref (o objeto vira lixo que o `gc` da pessoa junta quando quiser). Uma ref que já
/// não existe não é erro.
pub fn delete_ref(root: &Path, name: &str) -> Result<(), String> {
    if !name.starts_with(REF_PREFIX) {
        return Err(format!("ref fora de {REF_PREFIX}: {name}"));
    }
    if !root.is_dir() {
        return Ok(());
    }
    match run(root, &["update-ref", "-d", name], &[], GIT_FAST) {
        Ok(_) => Ok(()),
        Err(_) if run(root, &["rev-parse", "--verify", "-q", name], &[], GIT_FAST).is_err() => Ok(()),
        Err(e) => Err(e),
    }
}

/// Uma linha de `git diff-tree --raw -z`.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// `A`, `M`, `D`, `T`…
    pub status: char,
    pub old_mode: String,
    pub new_mode: String,
    pub path: String,
}

/// Lê a saída de `git diff-tree -r -z --no-renames <a> <b>`. Pura.
pub fn parse_raw_diff(raw: &[u8]) -> Vec<Change> {
    let mut out = Vec::new();
    let mut parts = raw.split(|b| *b == 0);
    while let Some(meta) = parts.next() {
        let meta = String::from_utf8_lossy(meta);
        let meta = meta.trim_start_matches('\n');
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let fields: Vec<&str> = meta.split(' ').collect();
        let Some(path) = parts.next() else { break };
        if fields.len() < 5 {
            continue;
        }
        let status = fields[4].chars().next().unwrap_or('M');
        out.push(Change {
            status,
            old_mode: fields[0].to_string(),
            new_mode: fields[1].to_string(),
            path: String::from_utf8_lossy(path).to_string(),
        });
    }
    out
}

/// Um caminho de uma árvore git que pode ser escrito dentro da raiz: relativo e sem `..`.
fn safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// O que uma restauração fez.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub written: usize,
    pub deleted: usize,
    /// Arquivos que não deu para escrever ou apagar (abertos por outro programa, sem permissão…).
    pub failed: Vec<String>,
}

/// Deixa os arquivos de `root` como na foto `target` (um commit), sabendo que o disco está como a
/// árvore `current` (a foto de segurança tirada logo antes). Escreve só o que difere e apaga o que
/// nasceu depois; o ignorado, o índice, a branch e o `HEAD` não mudam. Um arquivo travado não para
/// o resto: entra em `failed`.
pub fn restore(root: &Path, target: &str, current: &str) -> Result<RestoreReport, String> {
    let target_tree = format!("{target}^{{tree}}");
    if !exists(root, &target_tree) {
        return Err("a foto não está mais no repositório (foi limpa com git gc?)".into());
    }
    let raw = run_raw(root, &["diff-tree", "-r", "-z", "--no-renames", current, &target_tree], &[], GIT_SLOW)?;
    let changes = parse_raw_diff(&raw);
    let mut report = RestoreReport::default();

    // Primeiro o que sai (um arquivo que vira pasta precisa do lugar livre), depois o que entra.
    let mut to_write = Vec::new();
    for change in &changes {
        if !safe_relative(&change.path) {
            continue;
        }
        match change.status {
            'D' if change.old_mode != GITLINK_MODE => {
                let full = root.join(&change.path);
                match std::fs::remove_file(&full) {
                    Ok(()) => {
                        report.deleted += 1;
                        prune_empty_parents(root, &full);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => report.failed.push(change.path.clone()),
                }
            }
            'D' => {}
            _ if change.new_mode == GITLINK_MODE => {}
            _ => {
                // Um link simbólico ou arquivo trocado de tipo: some antes, o `checkout-index` o recria.
                if change.status == 'T' {
                    let _ = std::fs::remove_file(root.join(&change.path));
                }
                to_write.push(change.path.clone());
            }
        }
    }

    if !to_write.is_empty() {
        let index = TempIndex::new(root)?;
        let env_value = index.env();
        let env = [("GIT_INDEX_FILE", env_value.as_str())];
        run(root, &["read-tree", &target_tree], &env, GIT_FAST)?;
        for batch in batches(&to_write, ARGS_BUDGET) {
            let mut args = vec!["checkout-index", "-f", "--"];
            args.extend(batch.iter().map(String::as_str));
            if run(root, &args, &env, GIT_SLOW).is_ok() {
                report.written += batch.len();
                continue;
            }
            // O lote falhou: um por um, para saber qual (os outros são escritos).
            for path in batch {
                if run(root, &["checkout-index", "-f", "--", &path], &env, GIT_FAST).is_ok() {
                    report.written += 1;
                } else {
                    report.failed.push(path);
                }
            }
        }
    }
    Ok(report)
}

/// Lotes de caminhos que cabem numa linha de comando. Pura.
pub fn batches(paths: &[String], budget: usize) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut size = 0;
    for path in paths {
        if out.is_empty() || size + path.len() + 1 > budget {
            out.push(Vec::new());
            size = 0;
        }
        size += path.len() + 1;
        out.last_mut().expect("lote").push(path.clone());
    }
    out
}

/// Apaga as pastas que ficaram vazias depois de apagar `file`, subindo até a raiz (exclusive).
fn prune_empty_parents(root: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) {
            break;
        }
        // `remove_dir` só apaga pasta vazia: é exatamente o que se quer.
        if std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

/// O diff de uma foto até a árvore de agora, com o resumo por arquivo antes. `max_bytes` corta o
/// patch (um diff de megabytes trava a tela); o `bool` diz se cortou.
pub fn diff(root: &Path, from_commit: &str, to_tree: &str, max_bytes: usize) -> Result<(String, String, bool), String> {
    let base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
    let mut stat_args: Vec<&str> = base.to_vec();
    stat_args.extend(["--stat=200", from_commit, to_tree]);
    let stat = run(root, &stat_args, &[], GIT_SLOW)?;
    let mut patch_args: Vec<&str> = base.to_vec();
    patch_args.extend([from_commit, to_tree]);
    let patch = run_raw(root, &patch_args, &[], GIT_SLOW)?;
    let truncated = patch.len() > max_bytes;
    let mut text = String::from_utf8_lossy(&patch[..patch.len().min(max_bytes)]).to_string();
    if truncated {
        // Não termina no meio de uma linha.
        if let Some(cut) = text.rfind('\n') {
            text.truncate(cut);
        }
    }
    Ok((stat, text, truncated))
}
