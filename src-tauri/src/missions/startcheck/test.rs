use super::*;

fn event(kind: &str, actor: &str, start: i64, end: i64) -> Span {
    Span { id: 1, kind: kind.into(), actor: actor.into(), target: String::new(), started_ms: start, ended_ms: end, detail: String::new() }
}

#[test]
fn all_agents_must_start_within_two_minutes_including_boot() {
    let names = vec!["A".into(), "B".into()];
    let mut spans = vec![event("boot", "A", 1000, 5000), event("boot", "B", 1000, 6000),
        event("start_activity", "A", 5000, 121000), event("start_activity", "B", 6000, 120000),
        event("start_retry", "A", 6000, 6000), event("start_stalled", "A", 30000, 30000)];
    let result = evaluate("m", &names, &spans, None, 200000);
    assert!(result.passed && result.all_working);
    assert_eq!(result.time_until_all_working_ms, Some(120000));
    assert_eq!(result.agents[0].submit_retries, 1);
    assert_eq!(result.agents[0].stalled_notifications, 1);
    spans[2].ended_ms += 1;
    let result = evaluate("m", &names, &spans, None, 200000);
    assert!(result.all_working && !result.passed && result.agents[0].exceeded_deadline);
}

#[test]
fn never_started_missing_briefing_and_empty_roster_cannot_pass() {
    let names = vec!["A".into(), "B".into()];
    let spans = vec![event("boot", "A", 1000, 5000), event("turn", "A", 5000, 10000),
        event("start_activity", "B", 5000, 10000)];
    let result = evaluate("m", &names, &spans, None, 121001);
    assert!(!result.passed && !result.all_working);
    assert!(result.agents.iter().all(|a| a.activity_ms.is_none() && a.exceeded_deadline));
    assert_eq!(result.time_until_all_working_ms, None);
    assert!(!evaluate("m", &[], &[], None, 200000).passed);
}

#[test]
fn activity_before_briefing_is_ignored_and_pending_is_not_overdue() {
    let spans = vec![event("start_briefing", "A", 1000, 5000), event("start_activity", "A", 1000, 4000)];
    let result = evaluate("m", &["A".into()], &spans, Some(1000), 120999);
    assert!(!result.passed && !result.agents[0].exceeded_deadline);
    assert_eq!(result.agents[0].time_until_start_ms, None);
}

#[test]
fn database_roster_keeps_agent_without_any_event_and_unknown_mission_fails() {
    let conn = crate::database::test_db();
    conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','W',0,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at,started_at) VALUES('m','w','T','O','/repo',1,1,1);
        INSERT INTO mission_team_workspaces(mission_id,name,cwd,root,branch) VALUES('m','A','/a','/a','a'),('m','B','/b','/b','b');").unwrap();
    super::super::timings::add(&conn, "m", &super::super::timings::NewSpan {
        kind: "start_briefing".into(), actor: "A".into(), target: String::new(), started_ms: 1000, ended_ms: 5000, detail: String::new()
    }).unwrap();
    let report = get(&conn, "m", 121001).unwrap();
    assert_eq!(report.agents.len(), 2);
    assert!(report.agents[1].briefing_sent_ms.is_none());
    assert!(report.agents[1].exceeded_deadline);
    assert!(get(&conn, "missing", 200000).is_err());
}
