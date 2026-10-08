//! Evidence used when an interactive terminal mission is marked finished.
//!
//! Tests are reported by the user because the terminal runs outside the mission
//! supervisor. When a PR is supplied, `gh` reads its check rollup; it never writes to
//! GitHub.

use std::{
    path::Path,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::now_ts;

const GH_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestResult {
    Passed,
    Failed,
    NotRun,
}

impl TestResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::NotRun => "not_run",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "passed" => Self::Passed,
            "failed" => Self::Failed,
            _ => Self::NotRun,
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CiStatus {
    NotApplicable,
    Success,
    Failure,
    Pending,
    Unavailable,
    NotChecked,
}

impl CiStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Pending => "pending",
            Self::Unavailable => "unavailable",
            Self::NotChecked => "not_checked",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "not_applicable" => Self::NotApplicable,
            "success" => Self::Success,
            "failure" => Self::Failure,
            "pending" => Self::Pending,
            "not_checked" => Self::NotChecked,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDeliveryInput {
    pub test_result: TestResult,
    pub pull_request: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissionDelivery {
    pub test_result: TestResult,
    pub pull_request: Option<String>,
    pub ci_status: CiStatus,
    pub checked_at: i64,
}

pub(crate) fn assess(input: TerminalDeliveryInput, cwd: &Path) -> Result<MissionDelivery, String> {
    let pull_request = input
        .pull_request
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_pr_reference)
        .transpose()?;

    let ci_status = match (&input.test_result, pull_request.as_deref()) {
        (TestResult::Passed, Some(reference)) => check_pr_ci(cwd, reference),
        (_, Some(_)) => CiStatus::NotChecked,
        (_, None) => CiStatus::NotApplicable,
    };

    Ok(MissionDelivery {
        test_result: input.test_result,
        pull_request,
        ci_status,
        checked_at: now_ts(),
    })
}

pub(crate) fn mission_status(delivery: &MissionDelivery) -> &'static str {
    if delivery.test_result == TestResult::Passed
        && matches!(delivery.ci_status, CiStatus::NotApplicable | CiStatus::Success)
    {
        super::types::status::DONE
    } else {
        super::types::status::DONE_WITHOUT_DELIVERY
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Merged,
    Open,
    Closed,
    Unknown,
}

impl PrState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "MERGED" => Self::Merged,
            "OPEN" => Self::Open,
            "CLOSED" => Self::Closed,
            _ => Self::Unknown,
        }
    }
}

pub(crate) fn normalize_pr_reference(value: &str) -> Result<String, String> {
    let clean = value.trim().trim_start_matches('#');
    if let Ok(number) = clean.parse::<u64>() {
        if number > 0 {
            return Ok(number.to_string());
        }
    }

    let without_query = clean.split(['?', '#']).next().unwrap_or(clean).trim_end_matches('/');
    let Some(path) = without_query.strip_prefix("https://github.com/") else {
        return Err("Informe o número do PR ou uma URL https://github.com/<owner>/<repo>/pull/<número>.".into());
    };
    let parts = path.split('/').collect::<Vec<_>>();
    let valid_slug = |part: &str| {
        !part.is_empty()
            && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
            && part != "."
            && part != ".."
    };
    if parts.len() < 4 || !valid_slug(parts[0]) || !valid_slug(parts[1]) || parts[2] != "pull" {
        return Err("A URL do PR precisa ter o formato https://github.com/<owner>/<repo>/pull/<número>.".into());
    }
    let Ok(number) = parts[3].parse::<u64>() else {
        return Err("A URL do PR não contém um número válido.".into());
    };
    if number == 0 {
        return Err("O número do PR precisa ser maior que zero.".into());
    }
    Ok(format!("https://github.com/{}/{}/pull/{number}", parts[0], parts[1]))
}

pub(crate) fn repo_from_reference(reference: &str) -> Option<String> {
    let without_query = reference.split(['?', '#']).next().unwrap_or(reference).trim_end_matches('/');
    let path = without_query.strip_prefix("https://github.com/")?;
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

/// `owner/repo` del remoto `origin` de la carpeta (https o ssh). `gh` sin `--repo` usa el repositorio
/// por defecto del usuario, que puede ser otro (p. ej. el upstream del fork) y hacía fallar el chequeo.
pub(crate) fn repo_from_remote(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    (parts.next().is_none() && !owner.is_empty() && !repo.is_empty()).then(|| format!("{owner}/{repo}"))
}

fn git_origin_url(cwd: &Path) -> Option<String> {
    let mut cmd = crate::util::spawn::hidden_command("git");
    cmd.args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid é async-signal-safe. Sem tty, o git não pergunta passphrase.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let out = crate::util::spawn::output(&mut cmd, std::time::Duration::from_secs(20)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(crate) fn origin_repo(cwd: &Path) -> Option<String> {
    if let Some(url) = git_origin_url(cwd) {
        if let Some(repo) = repo_from_remote(&url) {
            return Some(repo);
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        if current_dir != cwd {
            if let Some(url) = git_origin_url(&current_dir) {
                if let Some(repo) = repo_from_remote(&url) {
                    return Some(repo);
                }
            }
        }
    }
    None
}

pub(crate) fn parse_pr_status(stdout: &[u8]) -> (PrState, CiStatus) {
    let Ok(json) = serde_json::from_slice::<Value>(stdout) else {
        return (PrState::Unknown, CiStatus::Unavailable);
    };
    let pr_state = match json.get("state").and_then(Value::as_str) {
        Some(s) => PrState::parse(s),
        None => PrState::Unknown,
    };
    let ci_status = parse_ci_status(stdout);
    (pr_state, ci_status)
}

pub(crate) fn check_pr_status(cwd: &Path, reference: &str) -> (PrState, CiStatus) {
    let mut args: Vec<String> = ["pr", "view", reference, "--json", "state,statusCheckRollup"].map(String::from).into();
    let repo = origin_repo(cwd).or_else(|| repo_from_reference(reference));
    if let Some(repo) = repo {
        args.extend(["--repo".to_string(), repo]);
    }
    let mut child = match crate::util::spawn::hidden_command("gh")
        .args(&args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return (PrState::Unknown, CiStatus::Unavailable),
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return (PrState::Unknown, CiStatus::Unavailable);
                }
                let Ok(output) = child.wait_with_output() else {
                    return (PrState::Unknown, CiStatus::Unavailable);
                };
                return parse_pr_status(&output.stdout);
            }
            Ok(None) if started.elapsed() < GH_CHECK_TIMEOUT => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return (PrState::Unknown, CiStatus::Unavailable);
            }
            Err(_) => return (PrState::Unknown, CiStatus::Unavailable),
        }
    }
}

fn check_pr_ci(cwd: &Path, reference: &str) -> CiStatus {
    check_pr_status(cwd, reference).1
}

fn parse_ci_status(stdout: &[u8]) -> CiStatus {
    let Ok(json) = serde_json::from_slice::<Value>(stdout) else {
        return CiStatus::Unavailable;
    };
    let Some(checks) = json.get("statusCheckRollup").and_then(Value::as_array) else {
        return CiStatus::Unavailable;
    };
    if checks.is_empty() {
        return CiStatus::Pending;
    }

    let mut pending = false;
    for check in checks {
        let state = check
            .get("conclusion")
            .and_then(Value::as_str)
            .or_else(|| check.get("state").and_then(Value::as_str))
            .or_else(|| check.get("status").and_then(Value::as_str))
            .unwrap_or("")
            .to_ascii_uppercase();
        match state.as_str() {
            "SUCCESS" | "NEUTRAL" => {}
            "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "REQUESTED" | "WAITING" => pending = true,
            _ => return CiStatus::Failure,
        }
    }
    if pending { CiStatus::Pending } else { CiStatus::Success }
}

#[cfg(test)]
mod tests {
    #[test]
    fn repo_from_remote_acepta_https_y_ssh() {
        use super::repo_from_remote;
        assert_eq!(repo_from_remote("https://github.com/tonalenar/ADE-AGS.git
").as_deref(), Some("tonalenar/ADE-AGS"));
        assert_eq!(repo_from_remote("git@github.com:tonalenar/ADE-AGS.git").as_deref(), Some("tonalenar/ADE-AGS"));
        assert_eq!(repo_from_remote("https://github.com/a/b").as_deref(), Some("a/b"));
        assert_eq!(repo_from_remote("https://gitlab.com/a/b.git"), None);
        assert_eq!(repo_from_remote("https://github.com/solo"), None);
    }

    use super::*;

    #[test]
    fn delivery_requires_passed_tests_and_green_checks_for_a_pr() {
        let make = |test_result, ci_status| MissionDelivery {
            test_result,
            pull_request: Some("https://github.com/acme/app/pull/4".into()),
            ci_status,
            checked_at: 1,
        };
        assert_eq!(mission_status(&make(TestResult::Passed, CiStatus::Success)), super::super::types::status::DONE);
        for delivery in [
            make(TestResult::Failed, CiStatus::Success),
            make(TestResult::NotRun, CiStatus::Success),
            make(TestResult::Passed, CiStatus::Failure),
            make(TestResult::Passed, CiStatus::Pending),
            make(TestResult::Passed, CiStatus::Unavailable),
        ] {
            assert_eq!(mission_status(&delivery), super::super::types::status::DONE_WITHOUT_DELIVERY);
        }
    }

    #[test]
    fn no_pr_only_requires_tests_and_pr_references_are_validated() {
        let no_pr = MissionDelivery {
            test_result: TestResult::Passed,
            pull_request: None,
            ci_status: CiStatus::NotApplicable,
            checked_at: 1,
        };
        assert_eq!(mission_status(&no_pr), super::super::types::status::DONE);
        assert_eq!(normalize_pr_reference("42").unwrap(), "42");
        assert_eq!(normalize_pr_reference("https://github.com/acme/app/pull/42/files").unwrap(), "https://github.com/acme/app/pull/42");
        assert!(normalize_pr_reference("https://example.com/acme/app/pull/42").is_err());
        assert!(normalize_pr_reference("0").is_err());
    }

    #[test]
    fn ci_rollup_requires_every_check_to_be_green() {
        assert_eq!(parse_ci_status(br#"{"statusCheckRollup":[{"conclusion":"SUCCESS"},{"state":"SUCCESS"}]}"#), CiStatus::Success);
        assert_eq!(parse_ci_status(br#"{"statusCheckRollup":[{"conclusion":"SUCCESS"},{"status":"IN_PROGRESS"}]}"#), CiStatus::Pending);
        assert_eq!(parse_ci_status(br#"{"statusCheckRollup":[{"conclusion":"SUCCESS"},{"conclusion":"FAILURE"}]}"#), CiStatus::Failure);
        assert_eq!(parse_ci_status(br#"{"statusCheckRollup":[]}"#), CiStatus::Pending);
    }

    #[test]
    fn parse_pr_status_extracts_state_and_ci() {
        let merged_green = br#"{"state":"MERGED","statusCheckRollup":[{"conclusion":"SUCCESS"}]}"#;
        assert_eq!(parse_pr_status(merged_green), (PrState::Merged, CiStatus::Success));

        let open_green = br#"{"state":"OPEN","statusCheckRollup":[{"conclusion":"SUCCESS"}]}"#;
        assert_eq!(parse_pr_status(open_green), (PrState::Open, CiStatus::Success));

        let closed_failed = br#"{"state":"CLOSED","statusCheckRollup":[{"conclusion":"FAILURE"}]}"#;
        assert_eq!(parse_pr_status(closed_failed), (PrState::Closed, CiStatus::Failure));

        let unknown_invalid = b"not json";
        assert_eq!(parse_pr_status(unknown_invalid), (PrState::Unknown, CiStatus::Unavailable));
    }

    #[test]
    fn repo_from_reference_extracts_owner_and_repo() {
        assert_eq!(repo_from_reference("https://github.com/tonalenar/ADE-AGS/pull/68").as_deref(), Some("tonalenar/ADE-AGS"));
        assert_eq!(repo_from_reference("68"), None);
        assert_eq!(repo_from_reference("https://github.com/a/b/pull/123?diff=unified#issuecomment-1"), Some("a/b".into()));
    }
}
