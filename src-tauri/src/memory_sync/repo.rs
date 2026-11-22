use std::path::{Path, PathBuf};

use super::credentials::EphemeralAskpass;
use super::export::ExportBundle;

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

pub(crate) fn build_network_git_spec(
    _cwd: &Path,
    _git_args: &[&str],
    _auth: Option<RemoteCredentials<'_>>,
) -> Result<(GitCommandSpec, Option<EphemeralAskpass>), String> {
    Err("não implementado".into())
}

pub(crate) fn push_bundle(
    _data_dir: &Path,
    _remote_url: &str,
    _branch: &str,
    _bundle: &ExportBundle,
    _auth: Option<RemoteCredentials<'_>>,
) -> Result<PushOutcome, String> {
    Err("não implementado".into())
}
