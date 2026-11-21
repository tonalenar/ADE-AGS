//! Confirmação pela pessoa de ações perigosas pedidas por clientes remotos.
//!
//! Mesmo no preset `all`, ações destrutivas, push/merge em `dev`/`master`, digitar em terminal
//! que o cliente não abriu, `secret_run`/`vault_run`/`browser_fill_login` no primeiro uso e
//! gasto acima do teto exigem confirmação explícita da pessoa pelo fluxo `user.ask`.

use serde_json::{Value, json};

/// Teto padrão de orçamento (em USD) acima do qual uma delegação remota pede confirmação.
pub const DEFAULT_BUDGET_CAP_USD: f64 = 5.0;

const PROTECTED_BRANCHES: &[&str] = &["dev", "master", "origin/dev", "origin/master"];

/// Diz se a chamada de tool remota exige confirmação explícita da pessoa.
pub fn needs_approval(tool: &str, args: &Value) -> bool {
    needs_approval_with(tool, args, None, &|_| None)
}

/// Versão com identidade do cliente e tabela de abas abertas (para dispensar confirmação
/// apenas em terminais abertos pelo próprio cliente).
pub fn needs_approval_for_client(
    tool: &str,
    args: &Value,
    client_id: &str,
    opened_by: &dyn Fn(&str) -> Option<String>,
) -> bool {
    needs_approval_with(tool, args, Some(client_id), opened_by)
}

fn needs_approval_with(
    tool: &str,
    args: &Value,
    client_id: Option<&str>,
    opened_by: &dyn Fn(&str) -> Option<String>,
) -> bool {
    // 1. Segredos e cofre: secret_run, vault_run e browser_fill_login no primeiro uso.
    if matches!(tool, "secret_run" | "vault_run") {
        return true;
    }
    if tool == "browser_fill_login" {
        let already_allowed = args
            .get("_vaultAllowed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return !already_allowed;
    }

    // 2. Push, merge, tags/releases, apagar arquivos e andares.
    if matches!(
        tool,
        "git_push"
            | "git_merge"
            | "git_tag"
            | "git_release_create"
            | "floor_delete"
            | "floor.delete"
            | "file_delete"
            | "explorer_trash"
            | "worktrees_prune"
            | "worktrees.prune"
            | "design_delete"
            | "design_page_delete"
            | "design_artboard_delete"
    ) {
        return true;
    }
    if tool.contains("merge") || tool.ends_with("_delete") || tool.ends_with(".delete") {
        return true;
    }

    // Qualquer operação git de escrita tocando `dev` ou `master`.
    if tool.starts_with("git_") && !is_git_read_only(tool) && targets_protected_branch(args) {
        return true;
    }

    // 3. Digitar em terminal que o cliente não abriu.
    if matches!(tool, "tab_send" | "tab_type" | "tab.send") {
        let target_tab = args
            .get("tab")
            .or_else(|| args.get("tabId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let opened_by_client = match (client_id, target_tab) {
            (Some(cid), Some(tab)) => {
                let actor = format!("remote:{cid}");
                opened_by(tab).as_deref() == Some(actor.as_str())
            }
            _ => false,
        };
        if !opened_by_client {
            return true;
        }
    }

    // 4. Gasto acima do teto.
    if budget_exceeds_cap(args, DEFAULT_BUDGET_CAP_USD) {
        return true;
    }

    false
}

fn is_git_read_only(tool: &str) -> bool {
    matches!(
        tool,
        "git_account"
            | "git_repos"
            | "git_pr_list"
            | "git_pr_view"
            | "git_checks"
            | "git_pr_files"
            | "git_issue_list"
            | "git_issue_view"
            | "git_fetch"
            | "git_release_list"
    )
}

fn targets_protected_branch(args: &Value) -> bool {
    for key in ["base", "branch", "target", "ref", "head"] {
        if let Some(val) = args.get(key).and_then(Value::as_str) {
            let trimmed = val.trim();
            if PROTECTED_BRANCHES
                .iter()
                .any(|branch| trimmed.eq_ignore_ascii_case(branch))
            {
                return true;
            }
        }
    }
    false
}

fn budget_exceeds_cap(args: &Value, cap: f64) -> bool {
    for key in ["budget_usd", "budgetUsd"] {
        if let Some(val) = args.get(key).and_then(Value::as_f64)
            && val > cap
        {
            return true;
        }
    }
    if let Some(tasks) = args.get("tasks").and_then(Value::as_array) {
        let mut total = 0.0;
        for task in tasks {
            if let Some(val) = task
                .get("budget_usd")
                .or_else(|| task.get("budgetUsd"))
                .and_then(Value::as_f64)
            {
                if val > cap {
                    return true;
                }
                total += val;
            }
        }
        if total > cap {
            return true;
        }
    }
    false
}

/// Resumo seguro dos argumentos para exibir no cartão de confirmação (sem valores sensíveis).
fn format_safe_args(args: &Value) -> String {
    let redacted = redact_sensitive_keys(args);
    let raw = serde_json::to_string(&redacted).unwrap_or_else(|_| "{}".into());
    if raw.chars().count() > 500 {
        let head: String = raw.chars().take(500).collect();
        format!("{head}…")
    } else {
        raw
    }
}

fn redact_sensitive_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                if lower.contains("password")
                    || lower.contains("secret")
                    || lower.contains("token")
                    || lower.contains("authorization")
                {
                    out.insert(k.clone(), Value::String("***".into()));
                } else {
                    out.insert(k.clone(), redact_sensitive_keys(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_sensitive_keys).collect()),
        other => other.clone(),
    }
}

/// Solicita confirmação explícita à pessoa usando o fluxo `user.ask` (cartões existentes).
/// Só devolve `Ok(())` quando a pessoa escolhe explicitamente "Permitir".
pub fn request_confirmation<F>(
    client: &str,
    cwd: &str,
    tool: &str,
    args: &Value,
    send: &mut F,
) -> Result<(), String>
where
    F: FnMut(&str, Value) -> Result<Value, String>,
{
    let safe_args = format_safe_args(args);
    let question = format!(
        "O cliente remoto `{client}` quer executar uma ação perigosa.\n\
         Ferramenta: `{tool}`\n\
         Argumentos: {safe_args}\n\n\
         Você permite executar esta ação?"
    );
    let payload = json!({
        "question": question,
        "options": ["Permitir", "Recusar"],
        "tabId": format!("remote:{client}"),
        "cwd": cwd,
        "timeout_s": 300,
    });
    match send("user.ask", payload) {
        Ok(data) => {
            if data.get("status").and_then(Value::as_str) == Some("pending") {
                return Err(format!(
                    "A ação `{tool}` está pendente de confirmação da pessoa e não foi executada."
                ));
            }
            let answer = data
                .get("text")
                .or_else(|| data.get("answer"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if answer.eq_ignore_ascii_case("permitir")
                || answer.eq_ignore_ascii_case("allow")
                || answer.eq_ignore_ascii_case("sim")
            {
                Ok(())
            } else {
                Err(format!("A ação `{tool}` foi recusada pela pessoa."))
            }
        }
        Err(error) => Err(format!(
            "A ação `{tool}` foi recusada porque não houve confirmação da pessoa: {error}"
        )),
    }
}
