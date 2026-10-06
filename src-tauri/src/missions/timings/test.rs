use super::*;

#[test]
fn test_spans_measure_executed_cached_and_affected_commands() {
    let make = |id: i64, elapsed: i64, detail: &str| Span {id,kind:"test".into(),actor:"Backend".into(),target:"rust".into(),started_ms:1000,ended_ms:1000+elapsed,detail:detail.into()};
    let spans = vec![make(1,200,r#"{"command":"cargo test","cacheHit":false}"#),
        make(2,0,r#"{"command":"cargo test","cacheHit":true}"#),
        make(3,0,r#"{"command":"","skippedAffected":3}"#)];
    let report = summarize(&spans,5);
    assert_eq!(report.test_metrics,TestMetrics {time_ms:200,commands:2,skipped_cache:1,skipped_affected:3});
    assert_eq!(report.by_kind[0].kind,"test");
}

#[test]
fn long_test_command_detail_remains_valid_json_after_persisting() {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('test-w','W',0,0)",[]).unwrap();
    conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('test-m','test-w','T','O','/tmp',0,0)",[]).unwrap();
    let detail=serde_json::json!({"command":"x".repeat(500),"cacheHit":true}).to_string();
    add(&conn,"test-m",&NewSpan {kind:"test".into(),actor:"Backend".into(),target:"frontend".into(),started_ms:1000,ended_ms:1000,detail:detail.clone()}).unwrap();
    let spans=list(&conn,"test-m").unwrap();
    assert_eq!(spans[0].detail,detail);
    assert_eq!(test_metrics(&spans).skipped_cache,1);
}

#[test]
fn reliability_spans_persist_and_wait_snapshots_do_not_double_count() {
    let conn = crate::database::test_db();
    conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','W',0,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m','w','T','O','/repo',1,1);").unwrap();
    for (kind, end, detail) in [("orchestrator_stall", 61000, "alerted:peer_ask"),
        ("orchestrator_stall", 91000, "answered:peer_ask"), ("start_all_working", 10000, "")] {
        let mut span = new_span(kind, "A", 1000, end);
        span.target = "Orquestrador".into(); span.detail = detail.into();
        add(&conn, "m", &span).unwrap();
    }
    let spans = list(&conn, "m").unwrap();
    assert_eq!(orchestrator_waits(&spans), (1, 90000, 90000));
    let report = crate::missions::timings_of(&conn, "m").unwrap();
    assert_eq!(report.orchestrator_stall_count, 1);
    assert_eq!(report.orchestrator_wait_ms, 90000);
    assert_eq!(report.orchestrator_max_wait_ms, 90000);
    assert_eq!(report.time_until_all_working_ms, Some(9000));
    assert!(summarize(&spans, 5).by_kind.iter().any(|k| k.kind == "start_all_working"));
}

#[test]
fn delegation_uses_real_lead_send_and_preserves_missing_measurements() {
    assert_eq!(first_delegation(&[], None), (None, None));
    assert_eq!(first_delegation(&[], Some(1)), (None, None));
    let boot = span(1, "boot", 1_000, 8_000);
    let mut member_ask = span(2, "peer_ask", 9_000, 10_000);
    member_ask.actor = "QA".into(); member_ask.target = "Orquestrador".into();
    assert_eq!(first_delegation(&[boot.clone(), member_ask], None), (None, None));
    let mut ask = span(3, "peer_ask", 702_000, 800_000);
    ask.actor = "Orquestrador".into(); ask.target = "Backend".into();
    assert_eq!(first_delegation(&[boot.clone(), ask.clone()], None), (Some(701_000), Some("span")));
    let mut tell = span(4, "peer_message", 90_000, 90_000);
    tell.detail = "delegation".into();
    assert_eq!(first_delegation(&[ask, tell.clone(), boot], None), (Some(89_000), Some("peer_message")));
    assert_eq!(first_delegation(&[tell.clone()], Some(1)), (Some(89_000), Some("peer_message")));
    assert_eq!(first_delegation(&[tell], Some(100)), (None, None));
}

#[test]
fn real_send_persists_only_lead_to_member_in_the_same_mission() {
    let conn = crate::database::test_db();
    conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','W',0,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m','w','T','O','/repo',1,1);").unwrap();
    let boards = crate::canvas::Boards::from([
        ("main|/repo#m:m".into(), crate::canvas::Board { orchestrators: vec!["lead".into()], nodes: serde_json::json!({"lead": {}, "member": {}}), ..Default::default() }),
        ("main|/else#m:other".into(), crate::canvas::Board { nodes: serde_json::json!({"stranger": {}}), ..Default::default() }),
    ]);
    for (kind, from, to) in [("tell", "member", "lead"), ("tell", "lead", "stranger"), ("tell", "lead", "lead"), ("check", "lead", "member")] {
        record_delegation(&conn, &boards, kind, from, to, 8_000).unwrap();
    }
    assert!(list(&conn, "m").unwrap().is_empty());
    record_delegation(&conn, &boards, "tell", "lead", "member", 90_000).unwrap();
    record_delegation(&conn, &boards, "ask", "lead", "member", 100_000).unwrap();
    let events = list(&conn, "m").unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(first_delegation(&events, Some(1)), (Some(89_000), Some("peer_message")));
}

fn new_span(kind: &str, actor: &str, start: i64, end: i64) -> NewSpan {
    NewSpan { kind: kind.into(), actor: actor.into(), target: String::new(), started_ms: start, ended_ms: end, detail: String::new() }
}

fn span(id: i64, kind: &str, start: i64, end: i64) -> Span {
    Span { id, kind: kind.into(), actor: "x".into(), target: String::new(), started_ms: start, ended_ms: end, detail: String::new() }
}

#[test]
fn rechaza_tipos_desconhecidos_e_relogios_invertidos() {
    assert!(validate(&new_span("boot", "A", 1_000, 2_000)).is_ok());
    assert!(validate(&new_span("café", "A", 1_000, 2_000)).unwrap_err().contains("desconhecido"));
    assert!(validate(&new_span("turn", "A", 2_000, 1_000)).is_err());
    assert!(validate(&new_span("turn", "A", 0, 1_000)).is_err());
    assert!(validate(&new_span("turn", "A", 1, 1 + 25 * 60 * 60 * 1000)).is_err());
}

#[test]
fn o_resumo_agrupa_por_tipo_e_acha_a_etapa_mais_lenta() {
    let spans = vec![
        span(1, "boot", 1_000, 4_000),
        span(2, "boot", 1_000, 6_000),
        span(3, "turn", 6_000, 66_000),
        span(4, "peer_ask", 10_000, 40_000),
    ];
    let s = summarize(&spans, 2);
    assert_eq!(s.wall_ms, 65_000);
    let boot = s.by_kind.iter().find(|k| k.kind == "boot").unwrap();
    assert_eq!((boot.count, boot.total_ms, boot.max_ms), (2, 8_000, 5_000));
    // Na ordem fixa dos tipos, e só os que aparecem.
    assert_eq!(s.by_kind.iter().map(|k| k.kind.as_str()).collect::<Vec<_>>(), vec!["boot", "turn", "peer_ask"]);
    assert_eq!(s.slowest.iter().map(|x| x.id).collect::<Vec<_>>(), vec![3, 4]);
}

#[test]
fn sem_tempos_o_resumo_e_vazio() {
    let s = summarize(&[], 3);
    assert_eq!(s.wall_ms, 0);
    assert!(s.by_kind.is_empty() && s.slowest.is_empty());
}

#[test]
fn ranks_blocked_callers_and_correlates_turns_without_double_counting() {
    let mut a = span(1, "peer_ask", 1_000, 6_000);
    a.actor = "Lead".into(); a.target = "Backend".into(); a.detail = "timeout".into();
    let mut b = span(2, "peer_ask", 2_000, 5_000);
    b.actor = "QA".into(); b.target = "Backend".into();
    let mut c = span(3, "peer_ask", 7_000, 9_000);
    c.actor = "Lead".into(); c.target = "Backend".into();
    let mut turn = span(4, "turn", 1_000, 8_000); turn.actor = "Backend".into();
    let mut other = span(5, "peer_ask", 1_000, 3_000); other.target = "Frontend".into();
    let rows = summarize(&[a, b, c, turn, other, span(6, "peer_ask", 1_000, 90_000)], 3).bottlenecks;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], Bottleneck { agent: "Backend".into(), asks: 3, blocked_callers: 2,
        waiting_ms: 10_000, max_wait_ms: 5_000, timeouts: 1, turn_ms: 7_000 });
    assert_eq!(rows[1].agent, "Frontend");
    assert!(summarize(&[], 0).bottlenecks.is_empty());
}

#[test]
fn grava_e_lista_na_ordem_do_inicio_e_respeita_o_limite() {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'W', 0, 0)", []).unwrap();
    conn.execute(
        "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at) VALUES ('m','w','t','o','/x',1,1)",
        [],
    )
    .unwrap();
    add(&conn, "m", &new_span("turn", "Backend", 5_000, 9_000)).unwrap();
    add(&conn, "m", &new_span("boot", "Backend", 1_000, 4_000)).unwrap();
    let all = list(&conn, "m").unwrap();
    assert_eq!(all.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), vec!["boot", "turn"]);
    assert_eq!(all[0].duration_ms(), 3_000);
    // Uma missão que não existe não deixa tempos órfãos: a FK recusa.
    assert!(add(&conn, "nao-existe", &new_span("boot", "A", 1_000, 2_000)).is_err());
}
