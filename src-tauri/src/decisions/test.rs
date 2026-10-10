use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use crate::database::DbConnection;
use crate::missions::delivery::{CiStatus, MissionDelivery, TestResult, mission_status};
use crate::runs::types::{Run, Task, role, status};

use super::commands;
use super::config::{self, ProviderKind, Settings};
use super::http::{DecisionProvider, HeuristicProvider, SystemOneHttpProvider};
use super::log::{self, LogRow, PairCount};
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
    serve_times(status, body, delay, 1)
}

fn serve_times(status: u16, body: &str, delay: Duration, times: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_string();
    std::thread::spawn(move || {
        for _ in 0..times {
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
        }
    });
    format!("http://{address}")
}

/// Devolve a URL e o pedido HTTP cru, para ver o `model` e o `state` que saíram.
fn serve_capture(status: u16, body: &str) -> (String, Arc<Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_string();
    let captured = Arc::new(Mutex::new(String::new()));
    let slot = Arc::clone(&captured);
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8_192];
        let mut header_end: Option<usize> = None;
        let mut need: Option<usize> = None;
        loop {
            match stream.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if header_end.is_none()
                        && let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        header_end = Some(pos);
                        let headers = String::from_utf8_lossy(&buf[..pos]);
                        need = headers.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            if key.eq_ignore_ascii_case("content-length") {
                                value.trim().parse().ok()
                            } else {
                                None
                            }
                        });
                    }
                    if let (Some(pos), Some(len)) = (header_end, need)
                        && buf.len() >= pos + 4 + len
                    {
                        break;
                    }
                    if buf.len() > 2_000_000 {
                        break;
                    }
                }
            }
        }
        *slot.lock().unwrap() = String::from_utf8_lossy(&buf).into_owned();
        let header = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body.as_bytes());
    });
    (format!("http://{address}"), captured)
}

fn provider(base_url: &str, key: Option<&str>, timeout_ms: u64) -> SystemOneHttpProvider {
    SystemOneHttpProvider {
        base_url: base_url.into(),
        api_key: key.map(str::to_string),
        timeout: Duration::from_millis(timeout_ms),
        model: "multilingual".into(),
        provider: ProviderKind::LayaLocal,
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
        sensitive: false,
        identity: None,
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
    let long = "á".repeat(40_000);
    let laya = protocol::truncate_state(&long);
    assert!(laya.len() <= protocol::STATE_CHAR_BUDGET);
    assert!(laya.is_char_boundary(laya.len()));
    let jev = protocol::truncate_chars(&long, protocol::JEV_STATE_CHAR_BUDGET);
    assert!(jev.len() <= protocol::JEV_STATE_CHAR_BUDGET);
    assert!(jev.len() > laya.len());
    assert!(jev.is_char_boundary(jev.len()));
    assert_eq!(protocol::state_hash(&long), protocol::state_hash(&jev));
    assert_ne!(
        protocol::state_hash(&long),
        protocol::state_hash(&laya),
        "o que passa do corte da Laya ainda distingue a amostra do Jev"
    );
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

fn log_rows(db: &DbConnection) -> i64 {
    db.lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn local_settings(base_url: String) -> Settings {
    Settings {
        enabled: true,
        provider: ProviderKind::LayaLocal,
        base_url,
        model: "multilingual".into(),
        timeout_ms: 1_000,
        memory_approval: true,
        dream_triage: true,
        fleet_gate: true,
        mission_gate: true,
        secondary: None,
    }
}

// ── 1. O que o app marca como segredo não sai da máquina ────────────────

#[test]
fn o_endereco_decide_se_o_texto_sai_da_maquina() {
    let off = |url: &str| {
        Settings {
            base_url: url.into(),
            ..Settings::default()
        }
        .sends_off_machine()
    };
    assert!(!off("http://localhost:8000"));
    assert!(!off("http://127.0.0.1:8000"));
    assert!(!off("http://[::1]:8000"));
    assert!(off("https://api.laya.studio"));
    assert!(off("https://api.typesafe.ai"));
    assert!(off("https://laya.interno.exemplo"));
    assert!(off("isto não é uma url"), "na dúvida, conta como fora");
}

#[test]
fn texto_marcado_como_segredo_nao_sai_para_um_endereco_de_fora() {
    let db = memory_db();
    let remote = Settings {
        provider: ProviderKind::LayaStudio,
        base_url: "https://api.laya.studio".into(),
        ..local_settings(String::new())
    };
    let mut secret = job_from(sample_request());
    secret.sensitive = true;
    // Qualquer tentativa de envio gravaria ao menos uma linha (de erro). Nenhuma linha
    // quer dizer que nem tentou.
    shadow::run_jobs_with(db.clone(), vec![secret.clone()], &remote, None);
    assert_eq!(log_rows(&db), 0);

    // O mesmo texto, com o servidor na própria máquina, segue o fluxo de sempre.
    let local = local_settings(serve(200, SUCCESS, Duration::ZERO));
    shadow::run_jobs_with(db.clone(), vec![secret], &local, None);
    assert_eq!(log_rows(&db), 1);
}

#[test]
fn memoria_e_sonho_levam_a_marca_de_segredo_para_o_envio() {
    let signals = || points::MemorySignals {
        duplicate: false,
        contradiction: false,
        deletion: false,
    };
    let secret = points::memory_job(
        points::POINT_MEMORY,
        "senha",
        "fact",
        "proposta",
        "password: hunter2",
        None,
        signals(),
    );
    assert!(secret.sensitive);
    let plain = points::memory_job(
        points::POINT_MEMORY,
        "limite",
        "fact",
        "proposta",
        "o pool aceita 20 conexoes",
        None,
        signals(),
    );
    assert!(!plain.sensitive);

    let dream = points::dream_job("senha", "fact", "add", "token: abc123", None, false);
    assert!(dream.sensitive);
    let dream = points::dream_job("limite", "fact", "add", "o pool aceita 20", None, false);
    assert!(!dream.sensitive);
}

// ── 2. O teste de conexão não pode prender a janela ─────────────────────

#[test]
fn o_teste_de_conexao_diz_o_que_falta_e_conecta_quando_ha_servidor() {
    let none = commands::ping(&Settings::default(), None);
    assert!(!none.ok);
    assert!(none.error.unwrap().contains("provedor"));

    let clef = Settings {
        provider: ProviderKind::Clef,
        ..Settings::default()
    };
    assert!(!commands::ping(&clef, None).ok);

    let settings = local_settings(serve(200, SUCCESS, Duration::ZERO));
    let result = commands::ping(&settings, None);
    assert!(result.ok, "{:?}", result.error);
    assert!(result.error.is_none());
}

// ── 3. O relatório separa as perguntas e o que só o provedor diz ────────

fn insert(conn: &Connection, index: i64, point: &str, heuristic: &str, provider: &str) {
    log::record(
        conn,
        &LogRow {
            ts: 100 + index,
            point: point.into(),
            provider: "laya_local".into(),
            model: "multilingual".into(),
            state_hash: format!("h{index}"),
            heuristic: heuristic.into(),
            provider_decision: Some(provider.into()),
            probability: None,
            confidence: None,
            latency_ms: Some(10),
            error: None,
            input_tokens: Some(1),
            output_tokens: Some(0),
        },
    )
    .unwrap();
}

#[test]
fn o_relatorio_separa_as_perguntas_e_o_que_so_o_provedor_diz() {
    let conn = Connection::open_in_memory().unwrap();
    log::migrate(&conn).unwrap();
    let heuristic = "acao=revisar;segredo=nao";
    for (index, provider) in [
        "acao=revisar;segredo=nao",
        "acao=aprovar;segredo=nao",
        "acao=aprovar;segredo=sim",
        "acao=rejeitar;segredo=nao",
    ]
    .into_iter()
    .enumerate()
    {
        insert(&conn, index as i64, "memory_approval", heuristic, provider);
    }
    let report = log::report(&conn).unwrap();
    assert_eq!(report.min_sample, log::MIN_SAMPLE);
    let point = &report.points[0];
    assert_eq!(point.compared, 4);
    assert!(point.low_sample, "4 comparações ainda é amostra pequena");
    assert!(
        (point.agreement_rate - 0.25).abs() < 1e-9,
        "a decisão inteira só bate em 1 de 4"
    );

    let action = point
        .questions
        .iter()
        .find(|q| q.question == "acao")
        .unwrap();
    assert_eq!(action.compared, 4);
    assert!((action.agreement_rate - 0.25).abs() < 1e-9);
    assert!(
        (action.blind_rate - 0.5).abs() < 1e-9,
        "o provedor aprovou 2 de 4, e a heurística nunca aprova"
    );
    assert_eq!(action.blind_labels, vec!["aprovar".to_string()]);
    assert_eq!(
        action.pairs[0],
        PairCount {
            heuristic: "revisar".into(),
            provider: "aprovar".into(),
            count: 2
        }
    );

    let secret = point
        .questions
        .iter()
        .find(|q| q.question == "segredo")
        .unwrap();
    assert!(
        (secret.agreement_rate - 0.75).abs() < 1e-9,
        "o detector do app e o provedor concordam em 3 de 4"
    );
    assert!(secret.blind_rate.abs() < f64::EPSILON);
    assert!(secret.blind_labels.is_empty());

    let csv = log::export_csv(&conn).unwrap();
    assert!(
        csv.contains("par,memory_approval,acao,revisar,aprovar,2"),
        "{csv}"
    );
    assert!(
        csv.contains(",4,true\n"),
        "comparadas e amostra_pequena no resumo: {csv}"
    );
}

#[test]
fn a_amostra_deixa_de_ser_pequena_na_trigesima_comparacao() {
    let conn = Connection::open_in_memory().unwrap();
    log::migrate(&conn).unwrap();
    for index in 0..log::MIN_SAMPLE {
        insert(
            &conn,
            index,
            "fleet_gate",
            "despacho=lancar",
            "despacho=lancar",
        );
    }
    let report = log::report(&conn).unwrap();
    assert!(!report.points[0].low_sample);
    assert!((report.points[0].agreement_rate - 1.0).abs() < f64::EPSILON);
}

// ── 4. A frota não consulta além do que mudou ───────────────────────────

fn fleet_run(budget: Option<f64>, spent: f64) -> Run {
    Run {
        id: "r".into(),
        workspace_id: "w".into(),
        objective: "o".into(),
        cwd: "/p".into(),
        status: "running".into(),
        max_parallel: 2,
        budget_usd: budget,
        spent_usd: spent,
        created_at: 0,
        ended_at: None,
        mission_id: None,
        squad_id: None,
        squad_name: None,
        squad_members: Vec::new(),
    }
}

fn fleet_task(id: &str, state: &str, deps: &[&str]) -> Task {
    Task {
        reasoning_effort: None,
        id: id.into(),
        run_id: "r".into(),
        title: id.into(),
        prompt: "p".into(),
        agent_id: "claude-code".into(),
        account_id: None,
        model: None,
        cwd: "/p".into(),
        budget_usd: None,
        status: state.into(),
        session_id: None,
        attempt: 0,
        result: None,
        error: None,
        cost_usd: None,
        tokens_in: None,
        tokens_out: None,
        events_path: None,
        worktree_path: None,
        branch: None,
        worktree_removed: false,
        complexity: None,
        routed_by: None,
        route_note: None,
        role: Some(role::WORKER.into()),
        functional_role: None,
        plan_key: Some(id.into()),
        parent_id: None,
        depth: 1,
        isolate: false,
        result_schema: None,
        last_error: None,
        handoff: None,
        structured_handoff: None,
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        auto_account: true,
        work_key: String::new(),
        fix_round: 0,
        full_gate: false,
        fix_status: String::new(),
        started_at: None,
        ended_at: None,
        created_at: 0,
    }
}

fn fleet_hash(db: &DbConnection, run: &Run, running: i64) -> (String, String) {
    let tasks = vec![
        fleet_task("a", status::DONE, &[]),
        fleet_task("b", status::PENDING, &["a"]),
    ];
    let conn = db.lock().unwrap();
    let jobs = points::fleet_jobs(&conn, run, &tasks, running, &[], &[]);
    assert_eq!(jobs.len(), 1, "só a tarefa pendente entra");
    (jobs[0].hash(), jobs[0].state.clone())
}

#[test]
fn o_estado_da_frota_so_muda_quando_a_decisao_pode_mudar() {
    let db = memory_db();
    config::persist(
        &db.lock().unwrap(),
        &local_settings("http://localhost:8000".into()),
    )
    .unwrap();

    let (base, state) = fleet_hash(&db, &fleet_run(Some(10.0), 0.10), 1);
    assert!(!state.contains("gasto"), "{state}");
    assert!(state.contains("orcamento: dentro"), "{state}");
    assert!(state.contains("em_execucao: 1"), "{state}");

    // O gasto sobe a cada tick, mas dentro do orçamento a decisão do agendador é a mesma.
    assert_eq!(fleet_hash(&db, &fleet_run(Some(10.0), 4.75), 1).0, base);
    // Estourar o orçamento e mudar as vagas ocupadas mudam a decisão: aí o hash muda.
    let (over, state) = fleet_hash(&db, &fleet_run(Some(10.0), 10.0), 1);
    assert_ne!(over, base);
    assert!(state.contains("orcamento: estourado"), "{state}");
    assert_ne!(fleet_hash(&db, &fleet_run(Some(10.0), 0.10), 2).0, base);
    assert!(
        fleet_hash(&db, &fleet_run(None, 3.0), 1)
            .1
            .contains("orcamento: sem limite")
    );
}

#[test]
fn a_frota_so_monta_trabalho_com_o_ponto_ligado() {
    let db = memory_db();
    let run = fleet_run(None, 0.0);
    let tasks = vec![fleet_task("b", status::PENDING, &[])];
    let conn = db.lock().unwrap();
    assert!(points::fleet_jobs(&conn, &run, &tasks, 0, &[], &[]).is_empty());

    let only_memory = Settings {
        fleet_gate: false,
        ..local_settings("http://localhost:8000".into())
    };
    config::persist(&conn, &only_memory).unwrap();
    assert!(
        points::fleet_jobs(&conn, &run, &tasks, 0, &[], &[]).is_empty(),
        "outro ponto ligado não liga este"
    );
    config::persist(&conn, &local_settings("http://localhost:8000".into())).unwrap();
    assert_eq!(
        points::fleet_jobs(&conn, &run, &tasks, 0, &[], &[]).len(),
        1
    );
}

#[test]
fn ler_se_o_ponto_esta_ligado_respeita_a_chave_geral_e_o_provedor() {
    let db = memory_db();
    let conn = db.lock().unwrap();
    assert!(!config::point_active(&conn, points::POINT_FLEET));
    let mut settings = local_settings("http://localhost:8000".into());
    config::persist(&conn, &settings).unwrap();
    assert!(config::point_active(&conn, points::POINT_FLEET));
    assert!(!config::point_active(&conn, "ponto_que_nao_existe"));
    settings.provider = ProviderKind::None;
    config::persist(&conn, &settings).unwrap();
    assert!(!config::point_active(&conn, points::POINT_FLEET));
    settings.provider = ProviderKind::LayaLocal;
    settings.enabled = false;
    config::persist(&conn, &settings).unwrap();
    assert!(!config::point_active(&conn, points::POINT_FLEET));
}

#[test]
fn a_fila_e_uma_so_sem_repetir_e_com_teto() {
    let db = memory_db();
    let other = memory_db();
    let job = |state: &str| {
        let mut job = job_from(sample_request());
        job.state = state.into();
        job
    };
    let mut queue = shadow::Queue::new();
    assert!(
        queue.push(&db, vec![job("a"), job("a"), job("b")], 10),
        "a primeira entrada pede o trabalhador"
    );
    assert_eq!(queue.len(), 2, "o gêmeo não entra");
    assert!(
        !queue.push(&db, vec![job("c"), job("a")], 10),
        "já há trabalhador"
    );
    assert_eq!(queue.len(), 3);
    queue.push(&other, vec![job("a")], 10);
    assert_eq!(
        queue.len(),
        4,
        "o mesmo texto em outro banco é outra amostra"
    );

    let mut small = shadow::Queue::new();
    small.push(&db, vec![job("1"), job("2"), job("3")], 2);
    assert_eq!(small.len(), 2, "o que passa do teto é descartado");

    assert_eq!(queue.take().len(), 4, "o trabalhador leva tudo de uma vez");
    assert!(
        queue.take().is_empty(),
        "e a vez seguinte, vazia, o encerra"
    );
    assert!(
        queue.push(&db, vec![job("z")], 10),
        "livre para outro começar"
    );
}

// ── Missão: cada uma vale uma amostra ───────────────────────────────────

#[test]
fn cada_missao_vale_uma_amostra_mesmo_com_o_mesmo_resultado() {
    let state = "testes: passed\nci: success";
    let make = |identity: Option<&str>| ShadowJob {
        point: points::POINT_MISSION,
        state: state.into(),
        sensitive: false,
        identity: identity.map(str::to_string),
        request: sample_request(),
    };
    assert_ne!(make(Some("m1")).hash(), make(Some("m2")).hash());
    assert_eq!(make(Some("m1")).hash(), make(Some("m1")).hash());
    assert_eq!(make(None).hash(), protocol::state_hash(state));

    // No worker: duas missões com o mesmo resultado viram duas linhas; a mesma missão de novo, não.
    let db = memory_db();
    let settings = local_settings(serve_times(200, SUCCESS, Duration::ZERO, 2));
    shadow::run_jobs_with(
        db.clone(),
        vec![make(Some("m1")), make(Some("m2"))],
        &settings,
        None,
    );
    assert_eq!(log_rows(&db), 2);
    shadow::run_jobs_with(db.clone(), vec![make(Some("m1"))], &settings, None);
    assert_eq!(log_rows(&db), 2);
}

/// Resposta capturada de um `laya-serve` real (2026-10-10, modelo multilingual): traz campos além
/// dos que o cliente usa (`answer_confidence`, `action`, `routing`, `state_tokens`...).
const LAYA_SERVE_REAL: &str = r#"{"model":"laya-rl-agent","answers":{"acao":{"type":"choice","choice":"revisar","probabilities":{"aprovar":0.1463,"rejeitar":0.2555,"revisar":0.5982},"confidence":0.1469,"answer_confidence":0.5982,"action":{"act_probability":1.0}},"segredo":{"type":"noul","noul":0.0142,"confidence":0.9858,"answer_confidence":0.9858,"action":{"act_probability":1.0}}},"usage":{"input_tokens":176,"output_tokens":0,"state_tokens":47,"state_tokens_dropped":0,"truncated":false,"truncated_questions":[]},"routing":{"model":"multilingual","repo":"convaiinnovations/laya/multilingual","reason":"explicit model='multilingual'","detection":null,"workflow":null}}"#;

#[test]
fn a_resposta_real_do_laya_serve_e_lida() {
    let response = parse_response(LAYA_SERVE_REAL).unwrap();
    assert_eq!(response.answers["acao"].label, "revisar");
    assert_eq!(response.answers["acao"].probability, Some(0.5982));
    assert_eq!(response.answers["segredo"].label, "nao");
    assert_eq!(response.input_tokens, 176);
    let url = serve(200, LAYA_SERVE_REAL, Duration::ZERO);
    let outcome = evaluate(
        &job_from(sample_request()),
        provider(&url, None, 1_000).decide(&sample_request()),
        7,
    );
    assert_eq!(
        outcome.provider_decision.as_deref(),
        Some("acao=revisar;segredo=nao")
    );
    assert_eq!(
        outcome.returned, "acao=revisar;segredo=nao",
        "a heurística de exemplo também diz revisar/nao"
    );
}

fn settings_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    conn
}

fn put_setting(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)",
        [key, value],
    )
    .unwrap();
}

#[test]
fn configuracao_antiga_do_jev_com_multilingual_e_corrigida_ao_carregar() {
    let conn = settings_db();
    put_setting(&conn, config::KEY_PROVIDER, "jev");
    put_setting(&conn, config::KEY_MODEL, "multilingual");
    put_setting(&conn, config::KEY_BASE_URL, "https://api.typesafe.ai");

    let settings = config::load(&conn).unwrap();
    assert_eq!(settings.provider, ProviderKind::Jev);
    assert_eq!(settings.model, "jev-latest");
    let stored: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [config::KEY_MODEL],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "jev-latest");

    // Um nome válido do provedor fica. A Laya não é reescrita para o Jev.
    let conn = settings_db();
    put_setting(&conn, config::KEY_PROVIDER, "jev");
    put_setting(&conn, config::KEY_MODEL, "jev-preview");
    assert_eq!(config::load(&conn).unwrap().model, "jev-preview");

    let conn = settings_db();
    put_setting(&conn, config::KEY_PROVIDER, "laya_studio");
    put_setting(&conn, config::KEY_MODEL, "english");
    assert_eq!(config::load(&conn).unwrap().model, "english");

    let conn = settings_db();
    put_setting(&conn, config::KEY_PROVIDER, "laya_local");
    put_setting(&conn, config::KEY_MODEL, "jev-latest");
    assert_eq!(config::load(&conn).unwrap().model, "multilingual");
}

#[test]
fn persistir_jev_com_modelo_da_laya_grava_jev_latest() {
    let conn = settings_db();
    let settings = Settings {
        provider: ProviderKind::Jev,
        base_url: "https://api.typesafe.ai".into(),
        model: "multilingual".into(),
        ..Settings::default()
    };
    config::persist(&conn, &settings).unwrap();
    assert_eq!(config::load(&conn).unwrap().model, "jev-latest");

    let studio = Settings {
        provider: ProviderKind::LayaStudio,
        base_url: "https://api.laya.studio".into(),
        model: "typed-decisions".into(),
        ..Settings::default()
    };
    config::persist(&conn, &studio).unwrap();
    assert_eq!(config::load(&conn).unwrap().model, "typed-decisions");
}

#[test]
fn pedido_ao_jev_sai_com_jev_latest_e_state_acima_do_corte_da_laya() {
    let (url, captured) = serve_capture(200, SUCCESS);
    let conn = settings_db();
    put_setting(&conn, config::KEY_PROVIDER, "jev");
    put_setting(&conn, config::KEY_MODEL, "multilingual");
    put_setting(&conn, config::KEY_BASE_URL, &url);
    let settings = config::load(&conn).unwrap();
    assert_eq!(settings.model, "jev-latest");

    let mut request = sample_request();
    request.model = "multilingual".into();
    request.state = "á".repeat(8_000);
    super::http::execute(&settings, None, &request).unwrap();

    let raw = captured.lock().unwrap().clone();
    assert!(
        raw.contains("\"model\":\"jev-latest\""),
        "o fio não pode levar multilingual: {raw}"
    );
    assert!(
        !raw.contains("multilingual"),
        "sobrou nome da Laya no pedido: {raw}"
    );
    let sent = raw.chars().filter(|ch| *ch == 'á').count();
    assert_eq!(
        sent, 8_000,
        "o Jev recebe o state abaixo do teto de 16k tokens"
    );

    let (laya_url, laya_captured) = serve_capture(200, SUCCESS);
    let laya = local_settings(laya_url);
    super::http::execute(&laya, None, &request).unwrap();
    let laya_raw = laya_captured.lock().unwrap().clone();
    assert!(
        laya_raw.contains("\"model\":\"multilingual\""),
        "{laya_raw}"
    );
    let laya_sent = laya_raw.chars().filter(|ch| *ch == 'á').count();
    assert_eq!(
        laya_sent, 2_048,
        "a Laya continua no corte de ~1.024 tokens (4.096 bytes)"
    );
}

#[test]
fn http_400_com_corpo_vira_mensagem_legivel_na_tela_e_no_log() {
    let key = "super-secret-key-xyz";
    let body = format!(
        r#"{{"detail":{{"error_type":"api_usage_error","message":"Unknown model: multilingual {key}"}}}}"#
    );
    let url = serve(400, &body, Duration::ZERO);
    let error = provider(&url, Some(key), 1_000)
        .decide(&sample_request())
        .unwrap_err();
    let shown = error.code();
    assert!(shown.contains("Unknown model: multilingual"), "{shown}");
    assert!(shown.starts_with("http 400"), "{shown}");
    assert!(!shown.contains(key), "{shown}");
    assert!(shown.contains("[redacted]"), "{shown}");

    let outcome = evaluate(&job_from(sample_request()), Err(error), 4);
    let logged = outcome.error.unwrap();
    assert!(logged.contains("Unknown model: multilingual"), "{logged}");
    assert!(!logged.contains(key), "{logged}");

    assert_eq!(
        protocol::client_error_message(r#"{"error":{"message":"chave recusada"}}"#),
        "chave recusada"
    );
    assert_eq!(
        protocol::client_error_message(r#"{"detail":"modelo invalido"}"#),
        "modelo invalido"
    );
    assert_eq!(
        protocol::client_error_message(
            r#"{"detail":[{"type":"missing","loc":["body","model"],"msg":"Field required"}]}"#
        ),
        "body.model: Field required"
    );
    let long = "x".repeat(500);
    assert!(protocol::client_error_message(&format!(r#"{{"message":"{long}"}}"#)).len() <= 300);

    let db = memory_db();
    let shadow_body = format!(r#"{{"error":{{"message":"Unknown model: multilingual ({key})"}}}}"#);
    let shadow_url = serve(400, &shadow_body, Duration::ZERO);
    let settings = Settings {
        provider: ProviderKind::Jev,
        model: "multilingual".into(),
        ..local_settings(shadow_url)
    };
    shadow::run_jobs_with(
        db.clone(),
        vec![job_from(sample_request())],
        &settings,
        Some(key.into()),
    );
    let (logged_error, logged_model): (String, String) = db
        .lock()
        .unwrap()
        .query_row("SELECT error, model FROM decision_shadow_log", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert!(
        logged_error.contains("Unknown model: multilingual"),
        "{logged_error}"
    );
    assert!(!logged_error.contains(key), "{logged_error}");
    assert_eq!(logged_model, "jev-latest");
}

// ── Dois provedores lado a lado ─────────────────────────────────────────

fn second_endpoint(url: String) -> config::Endpoint {
    config::Endpoint {
        provider: ProviderKind::Jev,
        base_url: url,
        model: "jev-latest".into(),
    }
}

#[test]
fn a_mesma_proposta_vai_aos_dois_provedores_e_cada_resposta_vira_uma_linha() {
    let second = SUCCESS.replace("\"choice\": \"aprovar\"", "\"choice\": \"revisar\"");
    let db = memory_db();
    let settings = Settings {
        secondary: Some(second_endpoint(serve(200, &second, Duration::ZERO))),
        ..local_settings(serve(200, SUCCESS, Duration::ZERO))
    };
    let job = job_from(sample_request());
    shadow::run_jobs_with_keys(db.clone(), vec![job.clone()], &settings, None, None);
    assert_eq!(log_rows(&db), 2);
    // Já consultados: repetir a proposta na janela não chama nenhum dos dois de novo.
    shadow::run_jobs_with_keys(db.clone(), vec![job], &settings, None, None);
    assert_eq!(log_rows(&db), 2);

    let conn = db.lock().unwrap();
    let report = log::report(&conn).unwrap();
    assert_eq!(report.points.len(), 2, "um cartão por (ponto, provedor)");
    assert!(report.points.iter().any(|p| p.provider == "laya_local"));
    assert!(report.points.iter().any(|p| p.provider == "jev"));
    assert_eq!(report.comparisons.len(), 1);
    let comparison = &report.comparisons[0];
    assert_eq!(comparison.compared, 1);
    assert!(comparison.agreement_rate.abs() < f64::EPSILON, "um aprovou e o outro revisou");
    let action = comparison.questions.iter().find(|q| q.question == "acao").unwrap();
    assert_eq!(action.pairs[0].heuristic, "revisar", "A: jev (ordem alfabética), B: laya_local");
    let secret = comparison.questions.iter().find(|q| q.question == "segredo").unwrap();
    assert!((secret.agreement_rate - 1.0).abs() < f64::EPSILON, "os dois acharam o mesmo sobre segredo");
    let csv = log::export_csv(&conn).unwrap();
    assert!(csv.contains("comparacao,memory_approval,jev,laya_local,1,0.0000"), "{csv}");
}

#[test]
fn o_segredo_so_deixa_de_ir_ao_destino_que_fica_fora_da_maquina() {
    let db = memory_db();
    let settings = Settings {
        secondary: Some(second_endpoint("https://api.typesafe.ai".into())),
        ..local_settings(serve(200, SUCCESS, Duration::ZERO))
    };
    let mut secret = job_from(sample_request());
    secret.sensitive = true;
    shadow::run_jobs_with_keys(db.clone(), vec![secret], &settings, None, None);
    // Só o local respondeu. Qualquer tentativa ao remoto gravaria uma linha (de erro).
    assert_eq!(log_rows(&db), 1);
    let provider: String = db
        .lock()
        .unwrap()
        .query_row("SELECT provider FROM decision_shadow_log", [], |row| row.get(0))
        .unwrap();
    assert_eq!(provider, "laya_local");
}

#[test]
fn o_segundo_provedor_vai_e_volta_da_configuracao() {
    let db = memory_db();
    let conn = db.lock().unwrap();
    let mut settings = local_settings("http://localhost:8000".into());
    settings.secondary = Some(config::Endpoint {
        provider: ProviderKind::Jev,
        base_url: "https://api.typesafe.ai".into(),
        model: "jev-latest".into(),
    });
    config::persist(&conn, &settings).unwrap();
    let loaded = config::load(&conn).unwrap();
    assert_eq!(loaded.secondary, settings.secondary);
    assert_eq!(loaded.endpoints().len(), 2);

    // Um modelo do outro provedor é corrigido; igual ao principal não vira um segundo destino.
    settings.secondary = Some(config::Endpoint {
        provider: ProviderKind::Jev,
        base_url: "https://api.typesafe.ai".into(),
        model: "multilingual".into(),
    });
    config::persist(&conn, &settings).unwrap();
    assert_eq!(config::load(&conn).unwrap().secondary.unwrap().model, "jev-latest");
    settings.secondary = Some(settings.primary());
    assert_eq!(settings.endpoints().len(), 1);

    // Desligar o segundo.
    settings.secondary = None;
    config::persist(&conn, &settings).unwrap();
    assert!(config::load(&conn).unwrap().secondary.is_none());
    assert_eq!(config::load(&conn).unwrap().endpoints().len(), 1);
}

// ── A decisão da pessoa como referência ─────────────────────────────────

#[test]
fn o_relatorio_diz_quem_chegou_mais_perto_da_decisao_da_pessoa() {
    let conn = Connection::open_in_memory().unwrap();
    log::migrate(&conn).unwrap();
    let hashes: Vec<String> = (0..4).map(|n| points::memory_state_hash(&format!("k{n}"), "fact", "proposta", "corpo")).collect();
    // A pessoa: aprovou 0 e 1, rejeitou 2 e 3.
    for (index, decision) in ["aprovar", "aprovar", "rejeitar", "rejeitar"].into_iter().enumerate() {
        log::record_human(&conn, "memory_approval", &hashes[index], decision).unwrap();
    }
    let say = |label: &str| format!("acao={label};segredo=nao");
    let put = |index: usize, provider: &str, answer: &str| {
        log::record(
            &conn,
            &LogRow {
                ts: 100 + index as i64,
                point: "memory_approval".into(),
                provider: provider.into(),
                model: "m".into(),
                state_hash: hashes[index].clone(),
                heuristic: say("revisar"),
                provider_decision: Some(say(answer)),
                probability: None,
                confidence: None,
                latency_ms: Some(10),
                error: None,
                input_tokens: Some(1),
                output_tokens: Some(0),
            },
        )
        .unwrap();
    };
    // Laya: acerta 0, erra 1, abstém-se na 2, acerta a 3. Jev: acerta as quatro.
    for (index, answer) in ["aprovar", "rejeitar", "revisar", "rejeitar"].into_iter().enumerate() {
        put(index, "laya_local", answer);
    }
    for (index, answer) in ["aprovar", "aprovar", "rejeitar", "rejeitar"].into_iter().enumerate() {
        put(index, "jev", answer);
    }
    let report = log::report(&conn).unwrap();
    let find = |provider: &str| report.judged.iter().find(|j| j.provider == provider).unwrap().clone();
    let laya = find("laya_local");
    assert_eq!((laya.decided, laya.correct, laya.wrong, laya.abstained), (4, 2, 1, 1));
    let jev = find("jev");
    assert_eq!((jev.decided, jev.correct, jev.wrong, jev.abstained), (4, 4, 0, 0));
    // A heurística do exemplo diz sempre "revisar": conta uma vez por proposta e nunca decide.
    let heuristic = find("heuristic");
    assert_eq!((heuristic.decided, heuristic.correct, heuristic.wrong, heuristic.abstained), (4, 0, 0, 4));
    assert!(log::export_csv(&conn).unwrap().contains("juiz,jev,4,4,0,0"));
}

#[test]
fn aprovar_ou_rejeitar_grava_so_o_hash_e_so_com_o_ponto_ligado() {
    let db = memory_db();
    let conn = db.lock().unwrap();
    // Desligado: nada é gravado.
    points::record_memory_decision(&conn, "chave", "fact", "create", "texto da proposta", true);
    let count = |conn: &Connection| -> i64 { conn.query_row("SELECT COUNT(*) FROM decision_human_log", [], |r| r.get(0)).unwrap() };
    assert_eq!(count(&conn), 0);

    config::persist(&conn, &local_settings("http://localhost:8000".into())).unwrap();
    points::record_memory_decision(&conn, "chave", "fact", "create", "texto da proposta", false);
    // As duas rotulagens possíveis da operação (missão: "proposta"; workspace: a da revisão).
    assert_eq!(count(&conn), 2);
    let dump: String = conn
        .query_row("SELECT group_concat(state_hash || decision) FROM decision_human_log", [], |r| r.get(0))
        .unwrap();
    assert!(!dump.contains("texto da proposta"), "{dump}");
    assert!(dump.contains("rejeitar"));
    let hash = points::memory_state_hash("chave", "fact", "proposta", "texto da proposta");
    assert!(dump.contains(&hash));
}
