use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use crate::database::DbConnection;
use crate::missions::delivery::{CiStatus, MissionDelivery, TestResult, mission_status};

use super::config::{self, ProviderKind, Settings};
use super::http::{DecisionProvider, HeuristicProvider, SystemOneHttpProvider};
use super::log::{self, LogRow};
use super::points::{
    self, dream_choice, fleet_label, memory_choice, memory_secret, mission_choice,
};
use super::protocol::{self, DecisionError, DecisionRequest, Question, parse_response};
use super::shadow::{self, ShadowJob, evaluate, redact};

fn memory_db() -> DbConnection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    log::migrate(&conn).unwrap();
    Arc::new(Mutex::new(conn))
}

fn serve(status: u16, body: &str, delay: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_string();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = [0u8; 16_384];
        let _ = stream.read(&mut buf);
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        let header = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body.as_bytes());
    });
    format!("http://{address}")
}

fn provider(base_url: &str, key: Option<&str>, timeout_ms: u64) -> SystemOneHttpProvider {
    SystemOneHttpProvider {
        base_url: base_url.into(),
        api_key: key.map(str::to_string),
        timeout: Duration::from_millis(timeout_ms),
        model: "multilingual".into(),
    }
}

fn sample_request() -> DecisionRequest {
    let mut questions = BTreeMap::new();
    questions.insert(
        "acao".into(),
        Question::choice(
            "O que sugerir?",
            &[
                ("aprovar", "entra"),
                ("rejeitar", "fica de fora"),
                ("revisar", "olhar"),
            ],
        ),
    );
    questions.insert(
        "segredo".into(),
        Question::noul("contém segredo ou dado sensível?"),
    );
    let mut heuristic = BTreeMap::new();
    heuristic.insert("acao".into(), "revisar".into());
    heuristic.insert("segredo".into(), "nao".into());
    DecisionRequest {
        state: "texto da proposta".into(),
        questions,
        model: "multilingual".into(),
        heuristic,
    }
}

fn job_from(request: DecisionRequest) -> ShadowJob {
    ShadowJob {
        point: points::POINT_MEMORY,
        state: request.state.clone(),
        request,
    }
}

const SUCCESS: &str = r#"{
  "model": "laya-rl-agent",
  "answers": {
    "acao": {"type": "choice", "choice": "aprovar", "probabilities": {"aprovar": 0.8, "rejeitar": 0.1, "revisar": 0.1}, "confidence": 0.62},
    "segredo": {"type": "noul", "noul": 0.91, "confidence": 0.91}
  },
  "usage": {"input_tokens": 12, "output_tokens": 0}
}"#;

#[test]
fn cliente_le_sucesso_com_probabilidade_confidence_e_tokens() {
    let url = serve(200, SUCCESS, Duration::ZERO);
    let response = provider(&url, None, 1_000)
        .decide(&sample_request())
        .unwrap();
    assert_eq!(response.answers["acao"].label, "aprovar");
    assert_eq!(response.answers["acao"].probability, Some(0.8));
    assert_eq!(response.answers["acao"].confidence, Some(0.62));
    assert_eq!(response.answers["segredo"].label, "sim");
    assert_eq!(response.answers["segredo"].probability, Some(0.91));
    assert_eq!(response.input_tokens, 12);
    assert_eq!(response.output_tokens, 0);
}

#[test]
fn cliente_estoura_o_tempo_sem_retry() {
    let url = serve(200, SUCCESS, Duration::from_millis(800));
    let error = provider(&url, None, 80)
        .decide(&sample_request())
        .unwrap_err();
    assert!(matches!(error, DecisionError::Timeout), "{error}");
}

#[test]
fn cliente_trata_401_422_e_json_quebrado() {
    let key = "super-secret-key-xyz";
    let leaked = format!("{{\"error\":\"{key}\"}}");
    let url = serve(401, &leaked, Duration::ZERO);
    let error = provider(&url, Some(key), 1_000)
        .decide(&sample_request())
        .unwrap_err();
    assert!(matches!(error, DecisionError::Unauthorized));
    assert!(!error.code().contains(key), "{}", error.code());

    let url = serve(422, &leaked, Duration::ZERO);
    let error = provider(&url, Some(key), 1_000)
        .decide(&sample_request())
        .unwrap_err();
    match error {
        DecisionError::Unprocessable(message) => assert!(!message.contains(key), "{message}"),
        other => panic!("esperado 422, veio {other}"),
    }

    let url = serve(200, "{", Duration::ZERO);
    let error = provider(&url, None, 1_000)
        .decide(&sample_request())
        .unwrap_err();
    assert!(matches!(error, DecisionError::Malformed(_)), "{error}");
}

#[test]
fn resposta_sem_answers_e_pergunta_demais_sao_erro() {
    let error = parse_response("{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}").unwrap_err();
    assert!(matches!(error, DecisionError::Malformed(_)));
    let mut request = sample_request();
    if let Question::Choice { criteria, .. } = request.questions.get_mut("acao").unwrap() {
        for index in 0..20 {
            criteria.insert(format!("op{index}"), "x".into());
        }
    }
    let error = request.wire().unwrap_err();
    assert!(matches!(error, DecisionError::Unprocessable(_)), "{error}");
}

#[test]
fn sombra_devolve_a_heuristica_se_o_provedor_falha_demora_ou_discorda() {
    let job = job_from(sample_request());
    let heuristic = HeuristicProvider.decide(&job.request).unwrap();
    let expected = protocol::canonical(&heuristic.answers);
    assert_eq!(expected, "acao=revisar;segredo=nao");

    let slow = serve(200, SUCCESS, Duration::from_millis(800));
    let timeout = provider(&slow, None, 80).decide(&job.request);
    assert!(matches!(
        timeout.as_ref().unwrap_err(),
        DecisionError::Timeout
    ));
    assert_eq!(evaluate(&job, timeout, 80).returned, expected);

    let denied = provider(
        &serve(401, "{\"error\":\"no\"}", Duration::ZERO),
        None,
        1_000,
    )
    .decide(&job.request);
    assert!(matches!(denied, Err(DecisionError::Unauthorized)));
    assert_eq!(evaluate(&job, denied, 4).returned, expected);

    let other = provider(&serve(200, SUCCESS, Duration::ZERO), None, 1_000)
        .decide(&job.request)
        .unwrap();
    assert_eq!(other.answers["acao"].label, "aprovar");
    let outcome = evaluate(&job, Ok(other), 5);
    assert_eq!(outcome.returned, expected);
    assert_eq!(
        outcome.provider_decision.as_deref(),
        Some("acao=aprovar;segredo=sim")
    );
    assert_eq!(outcome.probability, Some(0.8));
}

#[test]
fn chave_nao_entra_no_sqlite_nem_no_texto_do_log() {
    let key = "super-secret-key-xyz";
    let db = memory_db();
    let conn = db.lock().unwrap();
    let settings = Settings {
        enabled: true,
        provider: ProviderKind::LayaLocal,
        base_url: "http://localhost:8000".into(),
        memory_approval: true,
        ..Settings::default()
    };
    config::persist(&conn, &settings).unwrap();
    let stored: Vec<String> = {
        let mut stmt = conn.prepare("SELECT key, value FROM settings").unwrap();
        stmt.query_map([], |row| {
            Ok(format!(
                "{}={}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })
        .unwrap()
        .map(|item| item.unwrap())
        .collect()
    };
    let blob = stored.join("\n");
    assert!(!blob.contains(key), "{blob}");
    assert!(!blob.contains("api-key"));

    let marker = "proposta-secreta-unica-que-nao-pode-vazar";
    let row = LogRow {
        ts: 1_700_000_000,
        point: points::POINT_MEMORY.into(),
        provider: "laya_local".into(),
        model: "multilingual".into(),
        state_hash: protocol::state_hash(marker),
        heuristic: redact("acao=revisar", Some(key)),
        provider_decision: Some(redact(&format!("acao={key}"), Some(key))),
        probability: Some(0.2),
        confidence: Some(0.2),
        latency_ms: Some(10),
        error: Some(redact(&format!("422: {key}"), Some(key))),
        input_tokens: Some(3),
        output_tokens: Some(0),
    };
    log::record(&conn, &row).unwrap();
    let dump = conn
        .query_row("SELECT group_concat(state_hash || heuristic || ifnull(provider_decision,'') || ifnull(error,'')) FROM decision_shadow_log", [], |r| r.get::<_, String>(0))
        .unwrap();
    assert!(!dump.contains(key), "{dump}");
    assert!(!dump.contains(marker), "{dump}");
    assert!(dump.contains("[redacted]"), "{dump}");
}

#[test]
fn retencao_apaga_o_que_passou_do_prazo_e_do_teto() {
    let conn = Connection::open_in_memory().unwrap();
    log::migrate(&conn).unwrap();
    for index in 0..5 {
        log::record(
            &conn,
            &LogRow {
                ts: 1_000 + index,
                point: "memory_approval".into(),
                provider: "laya_local".into(),
                model: "multilingual".into(),
                state_hash: format!("hash-{index}"),
                heuristic: "acao=revisar".into(),
                provider_decision: None,
                probability: None,
                confidence: None,
                latency_ms: Some(index),
                error: None,
                input_tokens: Some(1),
                output_tokens: Some(0),
            },
        )
        .unwrap();
    }
    log::retain_with(&conn, 1_004, 3, 100).unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 3, "ts 1000 e 1001 ficaram com mais de 3 segundos");
    log::retain_with(&conn, 1_004, 10_000, 2).unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 2);
    let oldest: i64 = conn
        .query_row("SELECT MIN(ts) FROM decision_shadow_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(oldest, 1_003);
}

#[test]
fn relatorio_separa_concordancia_erro_timeout_e_discordancia() {
    let conn = Connection::open_in_memory().unwrap();
    log::migrate(&conn).unwrap();
    let rows = [
        ("acao=revisar", Some("acao=revisar".into()), Some(10), None),
        ("acao=revisar", Some("acao=aprovar".into()), Some(40), None),
        ("acao=revisar", None, Some(80), Some("timeout".into())),
        ("acao=revisar", None, Some(5), Some("401".into())),
    ];
    for (index, (heuristic, provider_decision, latency, error)) in rows.into_iter().enumerate() {
        log::record(
            &conn,
            &LogRow {
                ts: 10 + index as i64,
                point: "memory_approval".into(),
                provider: "laya_local".into(),
                model: "multilingual".into(),
                state_hash: format!("h{index}"),
                heuristic: heuristic.into(),
                provider_decision,
                probability: None,
                confidence: None,
                latency_ms: latency,
                error,
                input_tokens: Some(1),
                output_tokens: Some(0),
            },
        )
        .unwrap();
    }
    let report = log::report(&conn).unwrap();
    let point = &report.points[0];
    assert_eq!(point.total, 4);
    assert!(
        (point.agreement_rate - 0.5).abs() < f64::EPSILON,
        "{}",
        point.agreement_rate
    );
    assert!((point.error_rate - 0.5).abs() < f64::EPSILON);
    assert!((point.timeout_rate - 0.25).abs() < f64::EPSILON);
    assert_eq!(point.p50_ms, Some(10));
    assert_eq!(report.disagreements.len(), 1);
    assert_eq!(report.disagreements[0].state_hash, "h1");
    assert_eq!(report.disagreements[0].heuristic, "acao=revisar");
    assert_eq!(report.disagreements[0].provider_decision, "acao=aprovar");
    let csv = log::export_csv(&conn).unwrap();
    assert!(csv.contains("discordancia,memory_approval,h1,acao=revisar,acao=aprovar"));
    assert!(!csv.contains("texto da proposta"));
}

#[test]
fn worker_grava_a_heuristica_mesmo_quando_o_provedor_discorda() {
    let url = serve(200, SUCCESS, Duration::ZERO);
    let db = memory_db();
    let mut settings = Settings {
        enabled: true,
        provider: ProviderKind::LayaLocal,
        base_url: url,
        model: "multilingual".into(),
        timeout_ms: 1_000,
        memory_approval: true,
        ..Settings::default()
    };
    {
        let conn = db.lock().unwrap();
        config::persist(&conn, &settings).unwrap();
    }
    settings.base_url = config::load(&db.lock().unwrap()).unwrap().base_url;
    let marker = "corpo que nao pode ir para o sqlite";
    let mut request = sample_request();
    request.state = marker.into();
    shadow::run_jobs_with(
        db.clone(),
        vec![job_from(request)],
        &settings,
        Some("super-secret-key-xyz".into()),
    );
    let conn = db.lock().unwrap();
    let (heuristic, provider_decision, error, dump): (String, String, Option<String>, String) = conn.query_row(
        "SELECT heuristic, provider_decision, error, state_hash || heuristic || provider_decision || ifnull(error,'') FROM decision_shadow_log",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    assert_eq!(heuristic, "acao=revisar;segredo=nao");
    assert_eq!(provider_decision, "acao=aprovar;segredo=sim");
    assert!(error.is_none());
    assert!(!dump.contains("super-secret-key-xyz"), "{dump}");
    assert!(!dump.contains(marker), "{dump}");
}

#[test]
fn a_mesma_proposta_nao_e_consultada_de_novo_na_janela() {
    let url = serve(200, SUCCESS, Duration::ZERO);
    let db = memory_db();
    let settings = Settings {
        enabled: true,
        provider: ProviderKind::LayaLocal,
        base_url: url,
        model: "multilingual".into(),
        timeout_ms: 1_000,
        memory_approval: true,
        ..Settings::default()
    };
    let job = job_from(sample_request());
    shadow::run_jobs_with(db.clone(), vec![job.clone()], &settings, None);
    shadow::run_jobs_with(db.clone(), vec![job], &settings, None);
    let count: i64 = db
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn heuristica_dos_pontos_segue_as_funcoes_que_ja_decidem() {
    assert_eq!(memory_choice(true, false, false, false), "rejeitar");
    assert_eq!(memory_choice(false, true, false, false), "revisar");
    assert_eq!(memory_choice(false, false, true, false), "revisar");
    assert_eq!(memory_choice(false, false, false, true), "revisar");
    assert_eq!(memory_choice(false, false, false, false), "revisar");
    assert!(memory_secret("senha", "password: hunter2", None));
    assert!(!memory_secret("limite", "o pool aceita 20 conexoes", None));
    assert_eq!(dream_choice(true), "juntar");
    assert_eq!(dream_choice(false), "manter");
    assert_ne!(dream_choice(false), "descartar");

    let launch = vec!["b".to_string()];
    let skip = vec![("c".to_string(), "depende".to_string())];
    assert_eq!(fleet_label("b", &launch, &skip), "lancar");
    assert_eq!(fleet_label("c", &launch, &skip), "pular");
    assert_eq!(fleet_label("d", &launch, &skip), "esperar");

    let delivered = MissionDelivery {
        test_result: TestResult::Passed,
        pull_request: None,
        ci_status: CiStatus::Success,
        checked_at: 0,
    };
    assert_eq!(mission_status(&delivered), "done");
    assert_eq!(mission_choice(&delivered), "entregar");
    let held = MissionDelivery {
        test_result: TestResult::Failed,
        pull_request: None,
        ci_status: CiStatus::NotApplicable,
        checked_at: 0,
    };
    assert_eq!(mission_status(&held), "done_without_delivery");
    assert_eq!(mission_choice(&held), "reter");
}

#[test]
fn state_longo_e_cortado_antes_do_hash() {
    let long = "á".repeat(5_000);
    let cut = protocol::truncate_state(&long);
    assert!(cut.len() <= protocol::STATE_CHAR_BUDGET);
    assert!(cut.is_char_boundary(cut.len()));
    assert_eq!(protocol::state_hash(&long), protocol::state_hash(&cut));
}

#[test]
fn ajustes_padrao_ficam_desligados_e_a_url_rejeita_segredo_na_propria_url() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    let settings = config::load(&conn).unwrap();
    assert!(!settings.enabled);
    assert_eq!(settings.provider, ProviderKind::None);
    assert_eq!(settings.model, "multilingual");
    assert_eq!(settings.timeout_ms, 800);
    assert!(
        !settings.memory_approval
            && !settings.dream_triage
            && !settings.fleet_gate
            && !settings.mission_gate
    );
    assert!(config::normalize_base_url("http://example.com").is_err());
    assert!(config::normalize_base_url("https://user:secret@api.laya.studio").is_err());
    assert_eq!(
        config::normalize_base_url("http://localhost:8000/").unwrap(),
        "http://localhost:8000"
    );
    assert_eq!(ProviderKind::Clef.as_str(), "clef");
    assert_eq!(
        ProviderKind::Jev.default_base_url(),
        "https://api.typesafe.ai"
    );
    assert_eq!(
        ProviderKind::LayaStudio.default_base_url(),
        "https://api.laya.studio"
    );
}
