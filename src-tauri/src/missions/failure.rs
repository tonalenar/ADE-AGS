//! Classify mission failures for display. Rate limit and credential heuristics are shared
//! with runs::failure, which also drives account failover.

use super::types::{FailureActionKey, FailureCategory, FailureClassification};

const MAX_FAILURE_DETAIL_CHARS: usize = 600;

lazy_static::lazy_static! {
    static ref HTTP_403: regex::Regex =
        regex::Regex::new(r"\b(?:status|http|code|error)\b\D{0,12}403\b").unwrap();
    static ref HTTP_503: regex::Regex =
        regex::Regex::new(r"\b(?:status|http|code|error)\b\D{0,12}503\b").unwrap();
    static ref HTTP_504: regex::Regex =
        regex::Regex::new(r"\b(?:status|http|code|error)\b\D{0,12}504\b").unwrap();
}

pub(crate) fn classify(error: &str) -> Option<FailureClassification> {
    use crate::runs::failure::FailureKind;

    let error = error.trim();
    if error.is_empty() {
        return None;
    }
    let text = error.to_lowercase();

    // Preserve the failover classifier's precedence: quota beats auth when a provider
    // mentions both in the same message.
    match crate::runs::failure::classify(error) {
        FailureKind::RateLimited => {
            return Some(classification(
                FailureCategory::Limit,
                FailureActionKey::WaitForQuotaReset,
            ));
        }
        FailureKind::AuthExpired => {
            return Some(classification(
                FailureCategory::Access,
                if is_balance_error(&text) {
                    FailureActionKey::CheckPlanOrBalance
                } else if is_plan_access_error(&text) {
                    FailureActionKey::CheckPlanAccess
                } else {
                    FailureActionKey::LoginAgain
                },
            ));
        }
        FailureKind::Other => {}
    }

    if is_timeout(&text) {
        Some(classification(
            FailureCategory::Timeout,
            FailureActionKey::RetryAfterTimeout,
        ))
    } else if HTTP_503.is_match(&text) || text.contains("503 service unavailable") {
        Some(classification(
            FailureCategory::Access,
            FailureActionKey::CheckServiceStatus,
        ))
    } else if HTTP_403.is_match(&text) || text.trim() == "403" {
        Some(classification(
            FailureCategory::Access,
            if is_balance_error(&text) {
                FailureActionKey::CheckPlanOrBalance
            } else {
                FailureActionKey::CheckPlanAccess
            },
        ))
    } else if is_model_error(&text) {
        Some(classification(
            FailureCategory::Model,
            FailureActionKey::ChooseAvailableModel,
        ))
    } else if is_access_error(&text) || is_plan_access_error(&text) {
        Some(classification(
            FailureCategory::Access,
            if is_balance_error(&text) {
                FailureActionKey::CheckPlanOrBalance
            } else if is_plan_access_error(&text) {
                FailureActionKey::CheckPlanAccess
            } else {
                FailureActionKey::LoginAgain
            },
        ))
    } else if is_crash(&text) {
        Some(classification(
            FailureCategory::Crash,
            FailureActionKey::RestartAgent,
        ))
    } else {
        None
    }
}

fn classification(category: FailureCategory, action_key: FailureActionKey) -> FailureClassification {
    FailureClassification { category, action_key }
}

pub(crate) fn detail(error: &str) -> String {
    error.trim().chars().take(MAX_FAILURE_DETAIL_CHARS).collect()
}

fn is_timeout(text: &str) -> bool {
    HTTP_504.is_match(text)
        || [
            "timeout",
            "timed out",
            "deadline exceeded",
            "deadline has elapsed",
            "operation exceeded",
            "etimedout",
            "gateway timeout",
            "gateway time-out",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
}

fn is_balance_error(text: &str) -> bool {
    [
        "credit balance is too low",
        "insufficient credit",
        "insufficient funds",
        "insufficient balance",
        "out of credits",
        "no credits remaining",
        "billing is inactive",
        "add a payment method",
        "billing balance",
        "payment required",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

fn is_plan_access_error(text: &str) -> bool {
    [
        "plan does not include",
        "plan doesn't include",
        "not included in your plan",
        "subscription required",
        "subscription expired",
        "not available on your plan",
        "model access denied",
        "model is not enabled for",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

fn is_access_error(text: &str) -> bool {
    [
        "forbidden",
        "access denied",
        "permission denied",
        "not permitted to use",
        "does not have access",
        "don't have access",
        "do not have access",
        "insufficient credit",
        "service unavailable",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

fn is_model_error(text: &str) -> bool {
    [
        "model not found",
        "model_not_found",
        "no such model",
        "unknown model",
        "invalid model",
        "unsupported model",
        "model does not exist",
        "model doesn't exist",
        "model not available",
        "model unavailable",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

fn is_crash(text: &str) -> bool {
    [
        "crash",
        "segmentation fault",
        "process panic",
        "thread panicked",
        "terminated by signal",
        "killed by signal",
        "process was killed",
        "process exited unexpectedly",
        "unexpectedly exited",
        "failed to spawn",
        "could not spawn",
        "failed to launch",
        "could not launch",
        "could not be launched",
        "couldn't be launched",
        "couldn't launch",
        "unable to launch",
        "failed to start process",
        "could not start process",
        "failed to execute",
        "executable not found",
        "command not found",
        "no such file or directory",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

#[cfg(test)]
mod test {
    use super::*;

    fn expected(error: &str, category: FailureCategory, action_key: FailureActionKey) {
        assert_eq!(classify(error), Some(classification(category, action_key)));
    }

    #[test]
    fn reuses_pool_failover_limit_and_access_heuristics() {
        expected(
            "HTTP 429 Too Many Requests",
            FailureCategory::Limit,
            FailureActionKey::WaitForQuotaReset,
        );
        expected(
            "weekly usage limit reached",
            FailureCategory::Limit,
            FailureActionKey::WaitForQuotaReset,
        );
        expected(
            "Invalid API key. Please run /login",
            FailureCategory::Access,
            FailureActionKey::LoginAgain,
        );
        expected(
            "credit balance is too low",
            FailureCategory::Access,
            FailureActionKey::CheckPlanOrBalance,
        );
    }

    #[test]
    fn classifies_access_model_crash_and_timeout_errors() {
        expected(
            "HTTP 403: free plan cannot access this model",
            FailureCategory::Access,
            FailureActionKey::CheckPlanAccess,
        );
        expected(
            "subscription required to use this feature",
            FailureCategory::Access,
            FailureActionKey::CheckPlanAccess,
        );
        expected(
            "model_not_found: gpt-example",
            FailureCategory::Model,
            FailureActionKey::ChooseAvailableModel,
        );
        expected(
            "The agent process crashed unexpectedly",
            FailureCategory::Crash,
            FailureActionKey::RestartAgent,
        );
        expected(
            "Command timed out after 300 seconds",
            FailureCategory::Timeout,
            FailureActionKey::RetryAfterTimeout,
        );
        expected(
            "HTTP 504 Gateway Timeout",
            FailureCategory::Timeout,
            FailureActionKey::RetryAfterTimeout,
        );
        expected(
            "HTTP 503 Service Unavailable",
            FailureCategory::Access,
            FailureActionKey::CheckServiceStatus,
        );
    }

    #[test]
    fn leaves_unrecognized_failures_unclassified_and_bounds_details() {
        assert_eq!(classify("SyntaxError: unexpected token"), None);
        assert_eq!(classify(""), None);
        assert_eq!(
            detail(&"x".repeat(MAX_FAILURE_DETAIL_CHARS + 10)).chars().count(),
            MAX_FAILURE_DETAIL_CHARS
        );
        let serialized = serde_json::to_value(classification(
            FailureCategory::Access,
            FailureActionKey::LoginAgain,
        ))
        .unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({
                "category": "access",
                "actionKey": "missions.failure.action.loginAgain"
            })
        );
    }
}