use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use super::credentials::{EphemeralAskpass, sanitize_error};
use super::export::ExportBundle;
use crate::util::{external_path, output_with_timeout, spawn};

const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

pub(crate) fn mirror_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("memory-sync").join("repo")
}

pub(crate) struct RemoteCredentials<'a> {
    pub host: &'a str,
    pub git_user: &'a str,
    pub token: &'a str,
    pub helper_exe: &'a Path,
}

#[derive(Debug, Clone)]
pub(crate) struct GitCommandSpec {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushOutcome {
    pub pushed: bool,
    pub commit: Option<String>,
}

fn null_git_config() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

fn hooks_file_sentinel(fallback: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe()
        && exe.is_file()
    {
        return Ok(exe);
    }
    if let Some(path) = fallback
        && path.is_file()
    {
        return Ok(path.to_path_buf());
    }
    Err("Não foi possível isolar hooks do repositório espelho.".into())
}

pub(crate) fn build_network_git_spec(
    cwd: &Path,
    git_args: &[&str],
    auth: Option<RemoteCredentials<'_>>,
) -> Result<(GitCommandSpec, Option<EphemeralAskpass>), String> {
    let cwd_ext = external_path(cwd).to_string_lossy().into_owned();
    let mut args = vec!["-C".to_string(), cwd_ext];

    match auth {
        Some(creds) => {
            let askpass = EphemeralAskpass::start(creds.host, creds.git_user, creds.token)?;
            let no_hooks = hooks_file_sentinel(Some(creds.helper_exe))?;
            let helper_ext = external_path(creds.helper_exe)
                .to_string_lossy()
                .into_owned();
            let overrides = [
                format!("core.hooksPath={}", external_path(&no_hooks).display()),
                "core.fsmonitor=false".to_string(),
                "core.autocrlf=false".to_string(),
                format!("core.askPass={helper_ext}"),
                "credential.helper=".to_string(),
                format!("credential.https://{}.helper=", creds.host),
                "protocol.allow=never".to_string(),
                "protocol.file.allow=never".to_string(),
                "protocol.ssh.allow=never".to_string(),
                "protocol.git.allow=never".to_string(),
                "protocol.http.allow=never".to_string(),
                "protocol.ext.allow=never".to_string(),
                "protocol.https.allow=always".to_string(),
                "http.sslVerify=true".to_string(),
            ];
            for item in overrides {
                args.push("-c".into());
                args.push(item);
            }
            args.extend(git_args.iter().copied().map(str::to_string));

            let mut env = askpass.env_vars_for_host(creds.helper_exe, creds.host);
            env.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
            env.push(("GIT_CONFIG_GLOBAL".into(), null_git_config().into()));

            Ok((GitCommandSpec { args, env }, Some(askpass)))
        }
        None => {
            let no_hooks = hooks_file_sentinel(None)?;
            let overrides = [
                format!("core.hooksPath={}", external_path(&no_hooks).display()),
                "core.fsmonitor=false".to_string(),
                "core.autocrlf=false".to_string(),
            ];
            for item in overrides {
                args.push("-c".into());
                args.push(item);
            }
            args.extend(git_args.iter().copied().map(str::to_string));
            let env = vec![
                ("GIT_TERMINAL_PROMPT".into(), "0".into()),
                ("GCM_INTERACTIVE".into(), "never".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ];
            Ok((GitCommandSpec { args, env }, None))
        }
    }
}

fn run_local(dir: &Path, git_args: &[&str]) -> Result<String, String> {
    let mut cmd = spawn::hidden_command("git");
    cmd.arg("-C")
        .arg(external_path(dir))
        .args(["-c", "core.fsmonitor=false", "-c", "core.autocrlf=false"])
        .args(git_args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let out = output_with_timeout(&mut cmd, GIT_LOCAL_TIMEOUT)
        .map_err(|e| format!("git {}: {e}", git_args.first().unwrap_or(&"")))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    Err(msg)
}

fn run_network(
    cwd: &Path,
    git_args: &[&str],
    auth: Option<RemoteCredentials<'_>>,
) -> Result<String, String> {
    let secret = auth.as_ref().map(|a| a.token.to_string());
    let (spec, _askpass) = build_network_git_spec(cwd, git_args, auth)?;
    let mut cmd = spawn::hidden_command("git");
    cmd.args(&spec.args);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    let out = output_with_timeout(&mut cmd, GIT_NETWORK_TIMEOUT).map_err(|e| {
        let raw = format!("git {}: {e}", git_args.first().unwrap_or(&""));
        match secret.as_deref() {
            Some(tok) => sanitize_error(&raw, &[tok]),
            None => raw,
        }
    })?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let raw = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    Err(match secret.as_deref() {
        Some(tok) => sanitize_error(&raw, &[tok]),
        None => raw,
    })
}

fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 200
        && !branch.starts_with('-')
        && !branch.contains("..")
        && !branch.contains('\\')
        && !branch.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn ensure_no_symlinks_on_prefix(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut cur = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                if seg == ".git" {
                    return Err("Caminho proibido no espelho (.git).".into());
                }
                cur.push(seg);
                if cur.is_symlink() {
                    return Err("O espelho de memória não segue symlinks.".into());
                }
            }
            _ => return Err(format!("Caminho inválido no espelho: {rel}")),
        }
    }
    Ok(cur)
}

fn clean_managed_prefix(dir: &Path, prefix: &str) -> Result<(), String> {
    let trimmed = prefix.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(());
    }
    let target = ensure_no_symlinks_on_prefix(dir, trimmed)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    } else if target.exists() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn apply_bundle(dir: &Path, bundle: &ExportBundle) -> Result<(), String> {
    if let Some(prefix) = &bundle.ai_memory_prefix {
        clean_managed_prefix(dir, prefix)?;
    }
    if let Some(prefix) = &bundle.sqlite_prefix {
        clean_managed_prefix(dir, prefix)?;
    }

    let readme = b"# ADE AGS Memory Backup (Private)\n\n\
This private repository receives a one-way, secret-filtered export of project memories from ADE AGS.\n\n\
- `ai-memory/` - scoped project pages exported from `ai-memory`.\n\
- `sqlite/` - read-only legacy SQLite approved memory history.\n";
    std::fs::write(dir.join("README.md"), readme).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join(".ade-memory-sync.json"),
        b"{\n  \"format\": 1,\n  \"oneWay\": true\n}\n",
    )
    .map_err(|e| e.to_string())?;

    for (rel, bytes) in &bundle.files {
        let target = ensure_no_symlinks_on_prefix(dir, rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn init_fresh_mirror(dir: &Path, remote_url: &str, branch: &str) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    run_local(dir, &["init", "-q"])?;
    run_local(dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
    run_local(dir, &["remote", "add", "origin", remote_url])?;
    Ok(())
}

fn local_head(dir: &Path) -> Option<String> {
    run_local(dir, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty())
}

fn clear_working_tree_for_orphan(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() && !path.is_symlink() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_non_fast_forward(err: &str) -> bool {
    err.contains("rejected") || err.contains("fetch first") || err.contains("non-fast-forward")
}

/// Atualiza o espelho local sob `<data_dir>/memory-sync/repo` e envia em mão única para o remoto.
pub(crate) fn push_bundle(
    data_dir: &Path,
    remote_url: &str,
    branch: &str,
    bundle: &ExportBundle,
    auth: Option<RemoteCredentials<'_>>,
) -> Result<PushOutcome, String> {
    if !valid_branch(branch) {
        return Err("Nome de branch remoto inválido.".into());
    }
    if remote_url.trim().is_empty() {
        return Err("URL do repositório remoto ausente.".into());
    }
    if data_dir.is_symlink() {
        return Err("Diretório de dados inválido (symlink).".into());
    }
    let sync_root = data_dir.join("memory-sync");
    if sync_root.is_symlink() {
        return Err("Diretório memory-sync não pode ser symlink.".into());
    }
    let dir = mirror_dir(data_dir);
    if dir.is_symlink() || dir.join(".git").is_symlink() {
        return Err("Repositório espelho de memória não pode ser symlink.".into());
    }

    if !dir.join(".git").exists() {
        init_fresh_mirror(&dir, remote_url, branch)?;
    } else {
        let current_url = run_local(&dir, &["remote", "get-url", "origin"]).ok();
        if current_url.as_deref() != Some(remote_url) {
            init_fresh_mirror(&dir, remote_url, branch)?;
        }
    }

    let no_hooks = hooks_file_sentinel(auth.as_ref().map(|a| a.helper_exe))?;
    let hooks_cfg = format!("core.hooksPath={}", external_path(&no_hooks).display());
    let refspec = format!("HEAD:refs/heads/{branch}");

    for attempt in 0..3 {
        let fetch_auth = auth.as_ref().map(|a| RemoteCredentials {
            host: a.host,
            git_user: a.git_user,
            token: a.token,
            helper_exe: a.helper_exe,
        });
        run_network(&dir, &["fetch", "-q", "origin"], fetch_auth)?;

        let remote_ref = format!("refs/remotes/origin/{branch}");
        let remote_rev = run_local(&dir, &["rev-parse", "--verify", "-q", &remote_ref])
            .ok()
            .filter(|s| !s.is_empty());

        match remote_rev {
            Some(rev) => {
                run_local(&dir, &["checkout", "-q", "-f", "-B", branch, &rev])?;
                run_local(&dir, &["clean", "-fdq"])?;
            }
            None => {
                if local_head(&dir).is_some() {
                    run_local(&dir, &["checkout", "--orphan", branch])?;
                    let _ = run_local(&dir, &["rm", "-rfq", "--ignore-unmatch", "."]);
                    clear_working_tree_for_orphan(&dir)?;
                } else {
                    run_local(&dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
                    clear_working_tree_for_orphan(&dir)?;
                }
            }
        }

        apply_bundle(&dir, bundle)?;
        run_local(&dir, &["add", "-A"])?;
        if run_local(&dir, &["status", "--porcelain"])?.trim().is_empty() {
            return Ok(PushOutcome {
                pushed: false,
                commit: local_head(&dir),
            });
        }

        run_local(
            &dir,
            &[
                "-c",
                "user.name=ADE AGS",
                "-c",
                "user.email=memory-sync@ags.local",
                "-c",
                &hooks_cfg,
                "commit",
                "-q",
                "--no-verify",
                "-m",
                "chore(memory-sync): backup filtrado de memórias",
            ],
        )?;
        let head = local_head(&dir);

        let push_auth = auth.as_ref().map(|a| RemoteCredentials {
            host: a.host,
            git_user: a.git_user,
            token: a.token,
            helper_exe: a.helper_exe,
        });
        match run_network(&dir, &["push", "-q", "origin", &refspec], push_auth) {
            Ok(_) => {
                return Ok(PushOutcome {
                    pushed: true,
                    commit: head,
                });
            }
            Err(err) if attempt < 2 && is_non_fast_forward(&err) => continue,
            Err(err) => return Err(err),
        }
    }

    Err("O repositório remoto recebeu outro envio simultâneo; tente novamente.".into())
}
