//! Uma chamada headless de UMA vez, sem fila, sem worktree e sem processo vivo depois.
//!
//! É o mesmo lançamento da frota (o [`HeadlessAgent`] de cada TUI monta o argv e lê o
//! stream; a conta entra pelo ambiente; o sandbox embrulha), só que esperado ali mesmo e
//! sempre **somente leitura**: serve para quem precisa de uma resposta de um modelo sobre
//! dados que já estão no prompt (o guia de revisão de um PR, ver `forge::guide`), não para
//! trabalho que mexe no workspace.
//!
//! Só roda com uma TUI que faz cumprir o somente leitura (`enforces_read_only`): uma que
//! aprova tudo sozinha sem terminal não entra, igual a um lead.

use std::time::Duration;

use super::agents::{adapter_for, LaunchCtx};
use super::types::{AgentEvent, TaskOutcome};
use crate::database::DbConnection;

/// As TUIs que sabem rodar uma chamada destas. A ordem é a da escolha automática quando o
/// ruteo não decide.
pub const READ_ONLY_AGENTS: &[&str] = &["claude-code", "codex", "gemini-cli", "opencode"];

/// Acima disto a linha de comando do Windows recusa o lançamento (limite de ~32 mil).
const ARGV_LIMIT: usize = 24_000;

pub struct OneShot<'a> {
    pub agent_id: &'a str,
    /// `None` = a conta do sistema.
    pub account_id: Option<&'a str>,
    /// `None` = o modelo padrão da TUI.
    pub model: Option<&'a str>,
    pub cwd: &'a str,
    pub prompt: &'a str,
    pub timeout: Duration,
}

/// Tira o prompt do argv para mandá-lo pela entrada padrão, nas CLIs que leem dela.
/// `true` = quem lança escreve o prompt no stdin. Pura.
///
/// - Claude Code: `claude -p` sem prompt o lê do stdin (o mesmo que `supervisor` faz).
/// - Codex: `codex exec -` lê as instruções do stdin.
pub(crate) fn prompt_via_stdin(agent_id: &str, args: &mut Vec<String>, prompt: &str) -> bool {
    match agent_id {
        "claude-code" => match args.iter().position(|a| a == "-p") {
            Some(i) if args.get(i + 1).is_some_and(|a| a == prompt) => {
                args.remove(i + 1);
                true
            }
            _ => false,
        },
        "codex" => match args.last_mut() {
            Some(last) if last == prompt => {
                *last = "-".into();
                true
            }
            _ => false,
        },
        _ => false,
    }
}

/// Lê o stdout inteiro da CLI com o tradutor dela e devolve o veredicto. Pura (fora o
/// tradutor, que guarda estado entre linhas).
pub(crate) fn outcome_of(
    adapter: &(dyn super::HeadlessAgent + Send + Sync),
    stdout: &str,
    stderr: &str,
    code: i32,
) -> TaskOutcome {
    let mut emitted: Option<TaskOutcome> = None;
    for line in stdout.lines() {
        for event in adapter.parse_line(line) {
            if let AgentEvent::Finished { outcome } = event {
                emitted = Some(outcome);
            }
        }
    }
    // Sem evento de cierre, o motivo de verdade costuma estar no stderr ("not logged in"), não
    // no "terminou com código 1" genérico.
    let silent = emitted.is_none();
    let mut outcome = adapter.finish(emitted, code);
    if !outcome.ok && (silent || outcome.error.is_none()) && !stderr.trim().is_empty() {
        let tail: String = stderr.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        outcome.error = Some(tail);
    }
    outcome
}

/// Roda a chamada e espera. Bloqueia: chame de `spawn_blocking`.
pub fn run_read_only(db: &DbConnection, req: &OneShot) -> Result<TaskOutcome, String> {
    if !READ_ONLY_AGENTS.contains(&req.agent_id) {
        return Err(format!("'{}' não roda uma chamada somente leitura sem terminal", req.agent_id));
    }
    let adapter = adapter_for(req.agent_id)
        .ok_or_else(|| format!("ainda não sabemos rodar '{}' sem terminal", req.agent_id))?;
    if !adapter.enforces_read_only() {
        return Err(format!("'{}' não garante somente leitura sem terminal", req.agent_id));
    }
    // Igual à frota: uma conta que sumiu aborta, não cai na do sistema (gastaria cota alheia).
    let account_env = match req.account_id {
        Some(id) => crate::accounts::env_for_account(db, id).ok_or_else(|| format!("a conta '{id}' não existe mais"))?,
        None => Default::default(),
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let ctx = LaunchCtx {
        cwd: req.cwd,
        session_id: &session_id,
        account_env,
        mcp_config: None,
        system_prompt: None,
        allowed_tools: Vec::new(),
        json_schema: None,
        read_only: true,
        reasoning_effort: None,
        fast_mode: false,
    };
    let mut launch = adapter.launch(req.prompt, req.model, None, &ctx);
    let via_stdin = prompt_via_stdin(req.agent_id, &mut launch.args, req.prompt);
    if !via_stdin && launch.args.iter().map(|a| a.len() + 1).sum::<usize>() > ARGV_LIMIT {
        return Err(format!("o pedido é grande demais para '{}': use Claude Code ou Codex", req.agent_id));
    }

    let program = crate::util::find_program(&launch.program).unwrap_or_else(|| std::path::PathBuf::from(&launch.program));
    let cwd = std::path::Path::new(req.cwd);
    let mode = super::sandbox::Mode::from_db(db);
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
    let policy = super::sandbox::Policy::for_task(cwd, true, &launch.env, home.as_deref());
    let wrapped = super::sandbox::wrap(mode, &program, &launch.args, &policy)?;
    let mut command = crate::util::external_command(&wrapped.program, &wrapped.args)
        .map_err(|e| format!("não foi possível iniciar '{}': {e}", launch.program))?;
    if mode != super::sandbox::Mode::Off {
        super::sandbox::scrub_env(&mut command);
    }
    crate::agents::apply_account_env(&mut command, &launch.env);
    command.current_dir(cwd);
    let input = via_stdin.then(|| req.prompt.as_bytes().to_vec());
    let out = crate::util::spawn::output_with_input(&mut command, input, req.timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            format!("o agente não respondeu em {} s", req.timeout.as_secs())
        } else {
            format!("não foi possível iniciar '{}': {e}", launch.program)
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(outcome_of(adapter.as_ref(), &stdout, &stderr, out.status.code().unwrap_or(-1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn o_prompt_do_claude_sai_do_argv_e_vai_pelo_stdin() {
        let mut args: Vec<String> = ["-p", "PEDIDO", "--output-format", "stream-json"].map(String::from).to_vec();
        assert!(prompt_via_stdin("claude-code", &mut args, "PEDIDO"));
        assert_eq!(args, ["-p", "--output-format", "stream-json"]);
    }

    #[test]
    fn o_prompt_do_codex_vira_hifen() {
        let mut args: Vec<String> = ["exec", "--json", "--", "PEDIDO"].map(String::from).to_vec();
        assert!(prompt_via_stdin("codex", &mut args, "PEDIDO"));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn outras_tuis_ficam_com_o_prompt_no_argv() {
        let mut args: Vec<String> = ["run", "--", "PEDIDO"].map(String::from).to_vec();
        assert!(!prompt_via_stdin("opencode", &mut args, "PEDIDO"));
        assert_eq!(args.len(), 3);
    }

    #[test]
    fn o_resultado_sai_do_evento_de_cierre_do_claude() {
        let adapter = adapter_for("claude-code").expect("claude");
        let stdout = [
            r#"{"type":"system","subtype":"init","session_id":"s"}"#,
            r#"{"type":"result","is_error":false,"result":"{\"ok\":1}","total_cost_usd":0.01}"#,
        ]
        .join("\n");
        let outcome = outcome_of(adapter.as_ref(), &stdout, "", 0);
        assert!(outcome.ok);
        assert_eq!(outcome.result.as_deref(), Some("{\"ok\":1}"));
        assert_eq!(outcome.cost_usd, Some(0.01));
    }

    #[test]
    fn sem_cierre_e_com_erro_vale_o_stderr() {
        let adapter = adapter_for("claude-code").expect("claude");
        let outcome = outcome_of(adapter.as_ref(), "", "not logged in", 1);
        assert!(!outcome.ok);
        assert_eq!(outcome.error.as_deref(), Some("not logged in"));
    }

    #[test]
    fn so_tuis_que_garantem_somente_leitura() {
        for id in READ_ONLY_AGENTS {
            let adapter = adapter_for(id).unwrap_or_else(|| panic!("{id} sem adaptador headless"));
            assert!(adapter.enforces_read_only(), "{id}");
        }
    }
}
