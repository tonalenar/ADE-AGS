//! Helper único para executar comandos `git -C <dir>` sem janela, sem prompt de terminal e com prazo.

use std::path::Path;
use std::time::Duration;

/// Roda `git -C <dir> <args>` com `GIT_TERMINAL_PROMPT=0` e prazo explícito.
/// Devolve o stdout sem `\r`/`\n` no fim; em erro devolve stderr aparado (ou fallback com os args).
pub fn run(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    run_with_env(dir, args, &[], limit)
}

/// Como [`run`], permitindo variáveis de ambiente extras (ex.: autor/committer em checkpoints).
pub fn run_with_env(
    dir: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    limit: Duration,
) -> Result<String, String> {
    let dir = crate::util::external_path(dir);
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.arg("-C")
        .arg(&dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = crate::util::output_with_timeout(&mut cmd, limit)
        .map_err(|e| format!("não foi possível rodar o git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout)
            .trim_end_matches(['\n', '\r'])
            .to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("git {} falhou", args.join(" "))
        } else {
            err
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn run_retorna_stdout_e_falha_em_diretorio_fora_de_repo() {
        let tmp = std::env::temp_dir().join(format!(
            "ade-ags-util-git-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let ver = run(&tmp, &["--version"], Duration::from_secs(5)).expect("git --version");
        assert!(ver.to_ascii_lowercase().contains("git version"), "{ver}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
