use super::*;
use crate::accounts::pools::{Pool, PoolSpec, Strategy};
use crate::database::DbConnection;
use crate::runs::failure::{classify, FailureKind};
use crate::runs::roster::{ModelDiscoveryState, Roster, RosterAccount, RosterAgent};
use crate::runs::routing;

lazy_static::lazy_static! {
    static ref TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

fn test_db() -> DbConnection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .unwrap();
    std::sync::Arc::new(std::sync::Mutex::new(conn))
}

fn mock_account(id: Option<&str>, name: &str, key: &str) -> RosterAccount {
    RosterAccount {
        account_id: id.map(str::to_string),
        key: key.into(),
        name: name.into(),
        label: None,
        logged_in: true,
        quota: None,
        running: 0,
        models: vec![],
        model_discovery: ModelDiscoveryState::Unsupported,
        limit: None,
        at_capacity: false,
    }
}

fn mock_roster_con_cuentas(accounts: Vec<RosterAccount>) -> Roster {
    Roster {
        agents: vec![RosterAgent {
            capabilities: crate::agents::adapter_for("claude-code").unwrap().capabilities(),
            agent_id: "claude-code".into(),
            label: "Claude Code".into(),
            installed: true,
            launchable: true,
            unavailable: None,
            models: vec![],
            model_discovery: ModelDiscoveryState::Unsupported,
            accounts,
        }],
    }
}

/// 1. No máximo 1 failover por tarefa (segunda tentativa de failover na mesma tarefa é recusada).
#[test]
fn limite_1_maximo_un_failover_por_tarea() {
    let db = test_db();
    let now = 1_000_000;
    let task_id = "task-uuid-123";
    let pool_id = "pool-abc";

    assert!(!task_already_failed_over(&db, task_id));

    // Primeira reserva de failover na tarefa: DEVE ser aprovada
    let first = reserve_failover(&db, task_id, pool_id, now).expect("primeira reserva");
    assert!(first, "a primeira reserva de failover deve ser aprovada");
    assert!(task_already_failed_over(&db, task_id));

    // Segunda tentativa de failover na MESMA tarefa: DEBE ser recusada
    let second = reserve_failover(&db, task_id, pool_id, now + 10).expect("segunda reserva");
    assert!(!second, "a segunda tentativa de failover na mesma tarefa deve ser recusada");

    // failure_eligible também deve retornar false se already_failed_over for true
    assert!(!failure_eligible(FailureKind::RateLimited, true, true));
    assert!(failure_eligible(FailureKind::RateLimited, true, false));
}

/// 2. No máximo 3 failovers por pool por hora, janela deslizante
/// (o 4º na mesma hora é recusado; depois de passar 1h, libera de novo).
#[test]
fn limite_2_maximo_tres_failovers_por_pool_por_hora_janela_deslizante() {
    let db = test_db();
    let pool_id = "pool-limit-hour";
    let t0 = 10_000;

    // Três failovers no mesmo pool dentro da mesma hora em tarefas distintas:
    assert!(reserve_failover(&db, "t1", pool_id, t0).unwrap());
    assert!(reserve_failover(&db, "t2", pool_id, t0 + 600).unwrap());
    assert!(reserve_failover(&db, "t3", pool_id, t0 + 1200).unwrap());

    // O 4º failover dentro da mesma hora (ex. em t0 + 1800, aos 30 min): DEVE ser recusado
    let fourth = reserve_failover(&db, "t4", pool_id, t0 + 1800).unwrap();
    assert!(!fourth, "o 4º failover dentro da mesma hora deve ser recusado");

    // Checagem das funções puras de janela deslizante
    let history = vec![t0, t0 + 600, t0 + 1200];
    assert!(!pool_hourly_limit_available(&history, t0 + 1800));

    // Após 1 hora desde o primeiro evento: t0 + 3601
    // t0 cai fora da janela deslizante de 3600s, restando 2 eventos e liberando espaço
    let pruned = prune_hour_window(&history, t0 + 3601);
    assert_eq!(pruned.len(), 2);
    assert!(pool_hourly_limit_available(&pruned, t0 + 3601));

    // O 4º failover agora é aprovado porque a janela deslizante liberou
    let after_hour = reserve_failover(&db, "t4", pool_id, t0 + 3601).unwrap();
    assert!(after_hour, "após 1h a janela deslizante libera novo failover");
}

/// 3. Cooldown de 30 min: a conta que estourou não é escolhida de novo dentro desse tempo,
/// mesmo sendo a única com cupo "de verdade". Se só sobrar ela, não faz failover.
#[test]
fn limite_3_cooldown_30_minutos_conta_nao_e_escolhida() {
    let _lock = TEST_LOCK.lock().unwrap();
    let acc_key = "claude-code:acc-cooldown-3";
    let now = 50_000;

    cool_down_account(acc_key, now);
    assert!(account_in_cooldown(acc_key, now + 1));
    assert!(account_in_cooldown(acc_key, now + 15 * 60)); // 15 minutos
    assert!(account_in_cooldown(acc_key, now + 29 * 60 + 59)); // 29 min 59 s

    // Passados os 30 minutos (COOLDOWN_SECS = 1800s):
    assert!(!account_in_cooldown(acc_key, now + 1801));

    // Integração com routing::pick_in_pool:
    let acc1 = mock_account(Some("acc-3a"), "Principal", "claude-code:acc-3a");
    let acc2 = mock_account(Some("acc-3b"), "Reserva", "claude-code:acc-3b");
    let roster = mock_roster_con_cuentas(vec![acc1, acc2]);

    // acc-3a entra em cooldown
    cool_down_account("claude-code:acc-3a", now);

    let spec = PoolSpec {
        id: "pool-cd".into(),
        name: "Pool CD".into(),
        agent_id: "claude-code".into(),
        members: vec![Some("acc-3a".into()), Some("acc-3b".into())],
        strategy: Strategy::Sticky,
        start: 0,
        failover: true,
    };

    let (chosen, notes) = routing::pick_in_pool(&roster.agents[0], &spec, now + 60).unwrap();
    assert_eq!(chosen.as_deref(), Some("acc-3b"), "deve ignorar a conta em cooldown");
    assert!(notes.iter().any(|n| n.contains("cooldown")));

    // Se só sobrar a mesma conta (todas em cooldown), falha sem escolher nenhuma
    cool_down_account("claude-code:acc-3b", now);
    let err = routing::pick_in_pool(&roster.agents[0], &spec, now + 60).unwrap_err();
    assert!(err.contains("ninguna cuenta del pool") && err.contains("cooldown"), "{err}");
}

/// 4. Access/limit failures are eligible; code, timeout and filesystem errors are not.
#[test]
fn limite_4_so_acesso_ou_limite_dispara_failover() {
    // 1. Elegibilidade direta:
    assert!(failure_eligible(FailureKind::RateLimited, true, false));
    assert!(failure_eligible(FailureKind::AuthExpired, true, false));
    assert!(!failure_eligible(FailureKind::Other, true, false));

    // 2. Classificação de strings reais:
    // Rate limit / Cupo -> RateLimited (ELEGÍVEL)
    assert_eq!(classify("429 Too Many Requests"), FailureKind::RateLimited);
    assert_eq!(classify("5-hour limit reached"), FailureKind::RateLimited);
    assert_eq!(classify("usage limit exceeded"), FailureKind::RateLimited);
    assert_eq!(classify("quota exceeded"), FailureKind::RateLimited);
    assert_eq!(classify("ratelimit error"), FailureKind::RateLimited);
    assert!(failure_eligible(classify("429 Too Many Requests"), true, false));
    assert!(failure_eligible(classify("5-hour limit reached"), true, false));

    // Login expirado / Auth / Credencial -> AuthExpired (com opt-in)
    assert_eq!(classify("Invalid API key · Please run /login"), FailureKind::AuthExpired);
    assert_eq!(classify("OAuth token has expired"), FailureKind::AuthExpired);
    assert_eq!(classify("401 Unauthorized"), FailureKind::AuthExpired);
    assert_eq!(classify("Not logged in"), FailureKind::AuthExpired);
    assert!(failure_eligible(classify("Invalid API key"), true, false));
    assert!(failure_eligible(classify("token has expired"), true, false));

    // Erro de código / Timeout / Permissão negada -> Other (NUNCA elegível)
    assert_eq!(classify("Command timed out after 300 seconds"), FailureKind::Other);
    assert_eq!(classify("Permission denied (os error 13)"), FailureKind::Other);
    assert_eq!(classify("SyntaxError: Unexpected identifier"), FailureKind::Other);
    assert_eq!(classify("process exited with code 1"), FailureKind::Other);
    assert!(!failure_eligible(classify("Command timed out"), true, false));
    assert!(!failure_eligible(classify("Permission denied"), true, false));
    assert!(!failure_eligible(classify("SyntaxError"), true, false));
}

/// 5. Nunca failover pra conta de outra TUI nem pra fora do pool.
#[test]
fn limite_5_nunca_failover_outra_tui_nem_fora_do_pool() {
    let _lock = TEST_LOCK.lock().unwrap();
    let acc1 = mock_account(Some("acc-5a"), "A1", "claude-code:acc-5a");
    let acc2 = mock_account(Some("acc-5b"), "A2", "claude-code:acc-5b");
    let roster = mock_roster_con_cuentas(vec![acc1, acc2]);
    let now = 100_000;

    // Spec pertencente a outra TUI ("codex" vs "claude-code")
    let spec_outra_tui = PoolSpec {
        id: "pool-claude".into(),
        name: "Pool Claude".into(),
        agent_id: "codex".into(), // Outra TUI
        members: vec![Some("acc-5a".into()), Some("acc-5b".into())],
        strategy: Strategy::LeastUsed,
        start: 0,
        failover: true,
    };
    let err = routing::pick_in_pool(&roster.agents[0], &spec_outra_tui, now).unwrap_err();
    assert!(err.contains("é de 'codex', não de Claude Code"), "{err}");

    // Conta fora do pool nunca é selecionada
    let spec_acotado = PoolSpec {
        id: "pool-acotado".into(),
        name: "Pool Acotado".into(),
        agent_id: "claude-code".into(),
        members: vec![Some("acc-5a".into())], // acc-5b está fora
        strategy: Strategy::Sticky,
        start: 0,
        failover: true,
    };
    cool_down_account("claude-code:acc-5a", now);
    let err_fora = routing::pick_in_pool(&roster.agents[0], &spec_acotado, now + 10).unwrap_err();
    assert!(
        err_fora.contains("ninguna cuenta del pool 'Pool Acotado' se puede usar"),
        "{err_fora}"
    );
}

/// 6. Conta bloqueada/sem login é recusada como destino do failover.
#[test]
fn limite_6_conta_bloqueada_ou_sem_login_recusada() {
    let _lock = TEST_LOCK.lock().unwrap();
    let acc1 = mock_account(Some("acc-6a"), "A1", "claude-code:acc-6a");
    let mut acc2 = mock_account(Some("acc-6b"), "A2", "claude-code:acc-6b");
    // acc-2 sem login iniciado
    acc2.logged_in = false;
    let mut roster = mock_roster_con_cuentas(vec![acc1, acc2]);
    let now = 200_000;

    // acc-1 entra em cooldown
    cool_down_account("claude-code:acc-6a", now);

    let spec = PoolSpec {
        id: "pool-target".into(),
        name: "Pool Target".into(),
        agent_id: "claude-code".into(),
        members: vec![Some("acc-6a".into()), Some("acc-6b".into())],
        strategy: Strategy::Sticky,
        start: 0,
        failover: true,
    };

    let err = routing::pick_in_pool(&roster.agents[0], &spec, now + 10).unwrap_err();
    assert!(err.contains("no tiene sesión iniciada") || err.contains("sin sesión"), "{err}");

    // Caso conta bloqueada/ban/verificação pendente (limit != None)
    roster.agents[0].accounts[1].logged_in = true;
    roster.agents[0].accounts[1].limit = Some("cuenta bloqueada por verificación pendiente".into());

    let err2 = routing::pick_in_pool(&roster.agents[0], &spec, now + 10).unwrap_err();
    assert!(err2.contains("cuenta bloqueada por verificación pendiente"), "{err2}");
}

/// 7. Pool SEM o opt-in (failover=false, que é o padrão) não muda nada (comportamento idêntico ao de hoje).
#[test]
fn limite_7_pool_sem_optin_nao_muda_nada() {
    // failure_eligible retorna false quando opted_in = false
    assert!(!failure_eligible(FailureKind::RateLimited, false, false));
    assert!(!failure_eligible(FailureKind::RateLimited, false, true));

    // PoolSpec default tem failover = false
    let spec = PoolSpec {
        id: "pool-no-optin".into(),
        name: "No Optin".into(),
        agent_id: "claude-code".into(),
        members: vec![Some("acc-1".into()), Some("acc-2".into())],
        strategy: Strategy::LeastUsed,
        start: 0,
        failover: false,
    };
    assert!(!spec.failover);

    let p = Pool {
        id: "p-def".into(),
        name: "Default Pool".into(),
        agent_id: "claude-code".into(),
        members: vec![None, Some("a".into())],
        strategy: Strategy::LeastUsed,
        failover: false,
    };
    assert!(!p.failover, "padrão de failover deve ser false");
}

/// 8. Pool salvo ANTES dessa mudança (JSON sem o campo "failover") continua carregando igual,
/// com failover=false por default.
#[test]
fn limite_8_pool_salvo_antigo_sem_campo_failover_continua_carregando() {
    // JSON de um pool salvo em versões anteriores (sem o campo failover):
    let json_antigo = r#"{
        "id": "pool-antigo-123",
        "name": "Trabalho",
        "agentId": "claude-code",
        "members": [null, "acc-trabalho"],
        "strategy": "sticky"
    }"#;

    let pool: Pool = serde_json::from_str(json_antigo).expect("desserializar pool salvo antigo");
    assert_eq!(pool.id, "pool-antigo-123");
    assert_eq!(pool.name, "Trabalho");
    assert_eq!(pool.agent_id, "claude-code");
    assert_eq!(pool.strategy, Strategy::Sticky);
    assert_eq!(pool.members, vec![None, Some("acc-trabalho".into())]);
    assert!(!pool.failover, "pool salvo antigo deve ter failover == false por default");

    // Validação com save e load de settings:
    let db = test_db();
    crate::database::set_setting(&db, "accounts.pools", &format!("[{json_antigo}]")).unwrap();
    let loaded = crate::accounts::pools::load(&db);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].name, "Trabalho");
    assert!(!loaded[0].failover);
}

#[test]
fn access_model_and_billing_errors_are_classified_without_false_http_line_numbers() {
    for (text, expected) in [
        ("HTTP 403 Forbidden", FailureKind::AuthExpired),
        ("Your model 'x5' is not supported when using Codex with a ChatGPT account", FailureKind::ModelUnavailable),
        ("The requested model 'missing' does not exist", FailureKind::ModelUnavailable),
        ("model_not_found: you do not have access", FailureKind::ModelUnavailable),
        ("Your credit balance is too low", FailureKind::InsufficientBalance),
        ("insufficient_quota", FailureKind::InsufficientBalance),
        ("HTTP 402 Payment Required", FailureKind::InsufficientBalance),
        ("subscription has expired", FailureKind::InsufficientBalance),
        ("src/main.rs:403:5 permission denied", FailureKind::Other),
        ("model parser at src/main.rs:402:5", FailureKind::Other),
        ("503 service unavailable", FailureKind::Other),
    ] {
        assert_eq!(classify(text), expected, "{text}");
        assert_eq!(failure_eligible(expected, true, false), expected != FailureKind::Other);
        assert!(!failure_eligible(expected, false, false));
        assert!(!failure_eligible(expected, true, true));
    }
}

fn available_model(id: &str) -> crate::runs::roster::RosterModel {
    crate::runs::roster::RosterModel { id: id.into(), label: id.into(), toolcall: Some(true), local: false,
        cost_in: None, cost_out: None, context: None, source: Some("fixture".into()),
        availability: crate::runs::roster::ModelAvailability::Available, reasoning_levels: None,
        default_reasoning: None, unavailable: None }
}

#[test]
fn replacement_preserves_pool_and_account_catalog_and_changes_model_only_for_model_errors() {
    let _lock = TEST_LOCK.lock().unwrap();
    let original = Some("replacement-a".into());
    let a = mock_account(Some("replacement-a"), "A", "replacement-a");
    let mut b = mock_account(Some("replacement-b"), "B", "replacement-b");
    b.model_discovery = ModelDiscoveryState::Available;
    b.models = vec![available_model("accessible")];
    let mut outside = mock_account(Some("replacement-outside"), "outside", "replacement-outside");
    outside.model_discovery = ModelDiscoveryState::Available;
    outside.models = vec![available_model("requested")];
    let mut roster = mock_roster_con_cuentas(vec![a, b, outside]);
    let spec = PoolSpec { id: "replacement-pool".into(), name: "pool".into(), agent_id: "claude-code".into(),
        members: vec![original.clone(), Some("replacement-b".into())], strategy: Strategy::Sticky, start: 0, failover: true };
    let request = routing::RouteRequest { agent_id: Some("claude-code".into()), model: Some("requested".into()),
        complexity: None, account: routing::AccountChoice::Pool(spec.clone()) };
    let tiers = routing::Tiers::default();
    let assign = replacement(&roster, &tiers, &request, &original, FailureKind::ModelUnavailable, 900_000).unwrap();
    assert_eq!(assign.agent_id, "claude-code");
    assert_eq!(assign.account_id.as_deref(), Some("replacement-b"));
    assert_eq!(assign.model.as_deref(), Some("accessible"));
    assert_eq!(assign.pool_origin.unwrap().id, spec.id);
    // Neither auth nor billing silently changes an explicitly requested model.
    assert!(replacement(&roster, &tiers, &request, &original, FailureKind::AuthExpired, 900_000).is_err());
    assert!(replacement(&roster, &tiers, &request, &original, FailureKind::InsufficientBalance, 900_000).is_err());
    roster.agents[0].accounts[1].models.push(available_model("requested"));
    assert_eq!(replacement(&roster, &tiers, &request, &original, FailureKind::AuthExpired, 900_000).unwrap().model, request.model);
    roster.agents[0].accounts[1].logged_in = false;
    assert!(replacement(&roster, &tiers, &request, &original, FailureKind::ModelUnavailable, 900_000).is_err());
    roster.agents[0].accounts[1].logged_in = true;
    cool_down_account("replacement-b", 900_000);
    assert!(replacement(&roster, &tiers, &request, &original, FailureKind::ModelUnavailable, 900_001).is_err());
    assert!(replacement(&roster, &tiers, &request, &original, FailureKind::ModelUnavailable, 900_000 + COOLDOWN_SECS).is_ok());
    let mut disabled = request.clone();
    disabled.account = routing::AccountChoice::Pool(PoolSpec { failover: false, ..spec });
    assert!(replacement(&roster, &tiers, &disabled, &original, FailureKind::ModelUnavailable, 1_000_000).is_err());
    disabled.account = routing::AccountChoice::Fixed(original.clone());
    assert!(replacement(&roster, &tiers, &disabled, &original, FailureKind::ModelUnavailable, 1_000_000).is_err());
}
