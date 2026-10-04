use std::cmp::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use super::*;
use crate::agents::registry::AGENTS;
use crate::agents::AgentInfo;

/// (1) Teste da tabela pura:
/// - Cada agente de fábrica tem entrada na tabela com checar/atualizar oficiais quando aplicável.
/// - Comandos são estáticos (sem shell interpolado, sem argumentos vindos de usuário/rede).
/// - Agentes sem atualizador de fábrica (antigravity, kimi-code, bash) têm check/update como None.
/// - Política de não-npm: quando o agente não veio do npm, can_auto_update é negado com motivo "not_npm".
#[test]
fn test_update_table_factory_agents() {
    for agent in AGENTS {
        let def = update_def(agent.id);
        assert!(def.is_some(), "Agente {} deve ter entrada em UPDATE_TABLE", agent.id);
        let def = def.unwrap();

        match agent.id {
            "claude-code" => {
                assert_eq!(def.package, Some("@anthropic-ai/claude-code"));
                let check = def.check.expect("claude-code deve ter comando de check");
                assert_eq!(check.program, "npm");
                assert_eq!(check.args, &["view", "@anthropic-ai/claude-code", "version", "--json"]);

                let update = def.update.expect("claude-code deve ter comando de update");
                assert_eq!(update.program, "claude");
                assert_eq!(update.args, &["update"]);
            }
            "codex" => {
                assert_eq!(def.package, Some("@openai/codex"));
                let check = def.check.expect("codex deve ter comando de check");
                assert_eq!(check.program, "npm");
                assert_eq!(check.args, &["view", "@openai/codex", "version", "--json"]);

                let update = def.update.expect("codex deve ter comando de update");
                assert_eq!(update.program, "npm");
                assert_eq!(
                    update.args,
                    &["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "@openai/codex"]
                );
            }
            "gemini-cli" => {
                assert_eq!(def.package, Some("@google/gemini-cli"));
                let check = def.check.expect("gemini-cli deve ter comando de check");
                assert_eq!(check.program, "npm");
                assert_eq!(check.args, &["view", "@google/gemini-cli", "version", "--json"]);

                let update = def.update.expect("gemini-cli deve ter comando de update");
                assert_eq!(update.program, "npm");
                assert_eq!(
                    update.args,
                    &["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "@google/gemini-cli"]
                );
            }
            "opencode" | "antigravity" | "kimi-code" | "bash" => {
                assert_eq!(def.package, None);
                assert_eq!(def.check, None);
                assert_eq!(def.update, None);
            }
            _ => panic!("Agente inesperado na tabela AGENTS: {}", agent.id),
        }
    }
}

#[test]
fn test_policy_reasons_and_non_npm() {
    // Terminal aberto tem prioridade máxima
    assert_eq!(policy_reason(true, true, true, true), Some("busy_terminal"));
    assert_eq!(policy_reason(true, false, false, false), Some("busy_terminal"));

    // Missão em andamento
    assert_eq!(policy_reason(false, true, true, true), Some("busy_mission"));
    assert_eq!(policy_reason(false, true, false, false), Some("busy_mission"));

    // Sem atualizador conhecido
    assert_eq!(policy_reason(false, false, true, false), Some("no_updater"));

    // Instalado fora do npm (não atualiza sozinho, só avisa)
    assert_eq!(policy_reason(false, false, false, true), Some("not_npm"));

    // Tudo elegível
    assert_eq!(policy_reason(false, false, true, true), None);
}

#[test]
fn test_npm_install_matches_fails_closed() {
    let def = update_def("codex").unwrap();
    let agent_non_npm = AgentInfo {
        id: "codex".into(),
        label: "Codex".into(),
        command: "codex".into(),
        launch_args: None,
        available: true,
        version: Some("0.159.3".into()),
        path: Some("C:/tools/custom/codex.exe".into()),
        resume: None,
        skills_dir: None,
    };

    // Raiz arbitrária inexistente ou sem package.json válido do pacote não dá match
    assert!(!npm_install_matches(&agent_non_npm, def, "C:/does/not/exist"));

    // Agente sem pacote oficial (ex: antigravity) sempre retorna false
    let agy_def = update_def("antigravity").unwrap();
    assert!(!npm_install_matches(&agent_non_npm, agy_def, "C:/does/not/exist"));
}

/// (2) Teste de comparação de versões (semver com sufixos e prefixos):
#[test]
fn test_semver_comparisons() {
    // Comparações regulares
    assert_eq!(version_cmp("0.159.3", "0.160.0"), Some(Ordering::Less));
    assert_eq!(version_cmp("0.160.0", "0.159.3"), Some(Ordering::Greater));
    assert_eq!(version_cmp("0.160.0", "0.160.0"), Some(Ordering::Equal));
    assert_eq!(version_cmp("2.1.280", "2.1.281"), Some(Ordering::Less));
    assert_eq!(version_cmp("1.0.0", "0.9.9"), Some(Ordering::Greater));

    // Prefixos típicos de CLIs (v, texto antes da versão)
    assert_eq!(version_cmp("v0.159.3", "0.160.0"), Some(Ordering::Less));
    assert_eq!(version_cmp("Claude Code v2.1.280", "2.1.281"), Some(Ordering::Less));
    assert_eq!(version_cmp("codex 0.159.3", "0.160.0"), Some(Ordering::Less));
    assert_eq!(version_cmp("opencode 1.0.0", "v1.0.0"), Some(Ordering::Equal));

    // Sufixos pré-lançamento: release > prerelease
    assert_eq!(version_cmp("1.0.0-alpha", "1.0.0"), Some(Ordering::Less));
    assert_eq!(version_cmp("1.0.0", "1.0.0-alpha"), Some(Ordering::Greater));
    assert_eq!(version_cmp("1.0.0-alpha.1", "1.0.0-alpha.2"), Some(Ordering::Less));
    assert_eq!(version_cmp("1.0.0-alpha", "1.0.0-beta"), Some(Ordering::Less));
    assert_eq!(version_cmp("1.0.0-beta.2", "1.0.0-beta.10"), Some(Ordering::Less));

    // Metadados de build (+...) são ignorados na precedência
    assert_eq!(version_cmp("1.0.0+2020", "1.0.0"), Some(Ordering::Equal));
    assert_eq!(version_cmp("1.0.0+build.1", "1.0.0+build.2"), Some(Ordering::Equal));

    // Entrada inválida
    assert_eq!(version_cmp("invalid", "1.0.0"), None);
    assert_eq!(version_cmp("1.0.0", "invalid"), None);
}

/// (3) Teste de segurança: regra de não atualizar com terminal aberto ou missão em andamento
#[test]
fn test_busy_reason_blocks_terminal_and_mission() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE windows (id TEXT PRIMARY KEY, is_open INTEGER NOT NULL);
         CREATE TABLE tabs (id TEXT PRIMARY KEY, window_id TEXT, agent_id TEXT NOT NULL);
         CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT NOT NULL, lead_agent_id TEXT, squad_id TEXT);
         CREATE TABLE squads (id TEXT PRIMARY KEY, lead_agent_id TEXT);
         CREATE TABLE squad_members (squad_id TEXT NOT NULL, agent_id TEXT NOT NULL);
         CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
         CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL);
         CREATE TABLE run_squad_members (run_id TEXT NOT NULL, agent_id TEXT NOT NULL);",
    )
    .unwrap();

    // Sem terminais nem missões: agente ocioso
    assert_eq!(busy_reason(&conn, "codex").unwrap(), None);

    // Terminal aberto com codex: bloqueia
    conn.execute("INSERT INTO windows (id, is_open) VALUES ('w1', 1)", []).unwrap();
    conn.execute("INSERT INTO tabs (id, window_id, agent_id) VALUES ('t1', 'w1', 'codex')", []).unwrap();
    assert_eq!(busy_reason(&conn, "codex").unwrap(), Some("busy_terminal"));
    // Janela fechada: a aba salva nao bloqueia
    conn.execute("UPDATE windows SET is_open = 0", []).unwrap();
    assert_eq!(busy_reason(&conn, "codex").unwrap(), None);
    conn.execute("UPDATE windows SET is_open = 1", []).unwrap();
    assert_eq!(busy_reason(&conn, "codex").unwrap(), Some("busy_terminal"));
    // Outro agente continua desimpedido
    assert_eq!(busy_reason(&conn, "claude-code").unwrap(), None);

    // Fecha terminal
    conn.execute("DELETE FROM tabs", []).unwrap();
    assert_eq!(busy_reason(&conn, "codex").unwrap(), None);

    // Missão rodando com claude-code: bloqueia
    conn.execute(
        "INSERT INTO missions (id, status, lead_agent_id, squad_id) VALUES ('m1', 'running', 'claude-code', NULL)",
        [],
    )
    .unwrap();
    assert_eq!(busy_reason(&conn, "claude-code").unwrap(), Some("busy_mission"));
    // Codex não é afetado
    assert_eq!(busy_reason(&conn, "codex").unwrap(), None);

    // Missão concluída: libera
    conn.execute("UPDATE missions SET status = 'done' WHERE id = 'm1'", []).unwrap();
    assert_eq!(busy_reason(&conn, "claude-code").unwrap(), None);
}

/// Com o clique do usuário em "Atualizar" a tela fecha os processos do agente e libera as abas
/// guardadas; mas uma missão em curso com esse agente continua bloqueando.
#[test]
fn test_busy_reason_with_terminals_released_ignores_saved_tabs_but_not_missions() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE windows (id TEXT PRIMARY KEY, is_open INTEGER NOT NULL);
         CREATE TABLE tabs (id TEXT PRIMARY KEY, window_id TEXT, agent_id TEXT NOT NULL);
         CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT NOT NULL, lead_agent_id TEXT, squad_id TEXT);
         CREATE TABLE squads (id TEXT PRIMARY KEY, lead_agent_id TEXT);
         CREATE TABLE squad_members (squad_id TEXT NOT NULL, agent_id TEXT NOT NULL);
         CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
         CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL);
         CREATE TABLE run_squad_members (run_id TEXT NOT NULL, agent_id TEXT NOT NULL);",
    )
    .unwrap();
    conn.execute("INSERT INTO windows (id, is_open) VALUES ('w1', 1)", []).unwrap();
    conn.execute("INSERT INTO tabs (id, window_id, agent_id) VALUES ('t1', 'w1', 'codex')", []).unwrap();

    // Sem liberar: a aba aberta bloqueia (como antes).
    assert_eq!(busy_reason_with(&conn, "codex", false).unwrap(), Some("busy_terminal"));
    // Liberadas pela tela: a aba guardada deixa de bloquear.
    assert_eq!(busy_reason_with(&conn, "codex", true).unwrap(), None);
    // O atalho antigo continua sem liberar.
    assert_eq!(busy_reason(&conn, "codex").unwrap(), Some("busy_terminal"));

    // Missão rodando com esse agente: bloqueia mesmo com os terminais liberados.
    conn.execute(
        "INSERT INTO missions (id, status, lead_agent_id, squad_id) VALUES ('m1', 'running', 'codex', NULL)",
        [],
    )
    .unwrap();
    assert_eq!(busy_reason_with(&conn, "codex", true).unwrap(), Some("busy_mission"));
}

/// (4) Teste de timeout e executor:
/// NUNCA roda comandos reais nos testes. Usa executor mock injetado.
struct MockExecutor {
    result: Result<String, String>,
    executed: Mutex<Vec<FixedCommand>>,
}

impl MockExecutor {
    fn new(result: Result<String, String>) -> Self {
        Self { result, executed: Mutex::new(Vec::new()) }
    }
}

impl UpdateExecutor for MockExecutor {
    fn execute(&self, command: FixedCommand, _timeout: Duration) -> Result<String, String> {
        self.executed.lock().unwrap().push(command);
        self.result.clone()
    }
}

#[test]
fn test_update_with_executor_blocks_on_policy_reasons() {
    let mock = MockExecutor::new(Ok("updated 0.160.0".into()));

    // Agente bloqueado por terminal aberto
    let info_busy = AgentUpdateInfo {
        agent_id: "codex".into(),
        label: "Codex".into(),
        current_version: Some("0.159.3".into()),
        latest_version: Some("0.160.0".into()),
        update_available: true,
        can_auto_update: false,
        busy: true,
        reason: Some("busy_terminal".into()),
    };
    let res = update_with_executor("codex", &info_busy, &mock);
    assert!(!res.ok);
    assert_eq!(res.error, Some("busy_terminal".into()));
    assert!(mock.executed.lock().unwrap().is_empty(), "Não deve chamar executor quando ocupado!");

    // Agente instalado fora do npm
    let info_not_npm = AgentUpdateInfo {
        agent_id: "codex".into(),
        label: "Codex".into(),
        current_version: Some("0.159.3".into()),
        latest_version: Some("0.160.0".into()),
        update_available: true,
        can_auto_update: false,
        busy: false,
        reason: Some("not_npm".into()),
    };
    let res = update_with_executor("codex", &info_not_npm, &mock);
    assert!(!res.ok);
    assert_eq!(res.error, Some("not_npm".into()));
    assert!(mock.executed.lock().unwrap().is_empty(), "Não deve chamar executor quando not_npm!");
}

#[test]
fn test_update_with_executor_handles_timeout_and_constants() {
    // Timeout oficial é 5 minutos
    assert_eq!(UPDATE_TIMEOUT, Duration::from_secs(300));
    assert_eq!(CHECK_TIMEOUT, Duration::from_secs(20));

    // Simula falha por timeout
    let mock_timeout = MockExecutor::new(Err("timeout".into()));
    let info_ready = AgentUpdateInfo {
        agent_id: "codex".into(),
        label: "Codex".into(),
        current_version: Some("0.159.3".into()),
        latest_version: Some("0.160.0".into()),
        update_available: true,
        can_auto_update: true,
        busy: false,
        reason: None,
    };

    let res = update_with_executor("codex", &info_ready, &mock_timeout);
    assert!(!res.ok);
    assert_eq!(res.error, Some("timeout".into()));
    assert_eq!(mock_timeout.executed.lock().unwrap().len(), 1);

    // Simula sucesso
    let mock_ok = MockExecutor::new(Ok("+ @openai/codex@0.160.0".into()));
    let res_ok = update_with_executor("codex", &info_ready, &mock_ok);
    assert!(res_ok.ok);
    assert_eq!(res_ok.error, None);
    assert!(res_ok.output.contains("@openai/codex@0.160.0"));
}

#[test]
fn test_summarize_truncation_and_boundaries() {
    let short = "All good";
    assert_eq!(summarize(short), "All good");

    // Texto longo de 5000 bytes truncado para <= 2048 bytes
    let long = "a".repeat(5000);
    let sum = summarize(&long);
    assert_eq!(sum.len(), 2048);

    // Respeita limite UTF-8 de caracteres multi-byte
    let multibyte = "🦀".repeat(1000); // 4 bytes por emoji
    let sum_mb = summarize(&multibyte);
    assert!(sum_mb.len() <= 2048);
    assert!(sum_mb.is_char_boundary(sum_mb.len()));
}
