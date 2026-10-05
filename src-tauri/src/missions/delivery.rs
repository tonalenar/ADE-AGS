//! Evidence used when an interactive terminal mission is marked finished.
//!
//! Tests are reported by the user because the terminal runs outside the mission
//! supervisor. When a PR is supplied, `gh` reads its check rollup; it never writes to
//! GitHub.

use std::{
    path::Path,
    process::{Command, Stdio},
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
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::NotRun => "not_run",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "passed" => Self::Passed,
            "failed" => Self::Failed,
            _ => Self::NotRun,
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
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
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Pending => "pending",
            Self::Unavailable => "unavailable",
            Self::NotChecked => "not_checked",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
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

fn normalize_pr_reference(value: &str) -> Result<String, String> {
    if let Ok(number) = value.parse::<u64>() {
        if number > 0 {
            return Ok(number.to_string());
        }
    }

    let without_query = value.split(['?', '#']).next().unwrap_or(value).trim_end_matches('/');
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

fn origin_repo(cwd: &Path) -> Option<String> {
    let out = Command::new("git").args(["remote", "get-url", "origin"]).current_dir(cwd).output().ok()?;
    out.status.success().then(|| repo_from_remote(&String::from_utf8_lossy(&out.stdout))).flatten()
}

fn check_pr_ci(cwd: &Path, reference: &str) -> CiStatus {
    let mut args: Vec<String> = ["pr", "view", reference, "--json", "statusCheckRollup"].map(String::from).into();
    // Un número solo no dice de qué repositorio es: se usa el del remoto de la misión.
    if !reference.starts_with("https://") {
        if let Some(repo) = origin_repo(cwd) {
            args.extend(["--repo".to_string(), repo]);
        }
    }
    let mut child = match Command::new("gh")
        .args(&args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return CiStatus::Unavailable,
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return CiStatus::Unavailable;
                }
                let Ok(output) = child.wait_with_output() else {
                    return CiStatus::Unavailable;
                };
                return parse_ci_status(&output.stdout);
            }
            Ok(None) if started.elapsed() < GH_CHECK_TIMEOUT => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return CiStatus::Unavailable;
            }
            Err(_) => return CiStatus::Unavailable,
        }
    }
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
}
