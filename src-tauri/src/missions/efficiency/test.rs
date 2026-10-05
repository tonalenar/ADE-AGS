use super::{HISTORY_LIMIT, active_time, get};
use crate::database::test_db;
use crate::missions::timings::{self, NewSpan, Span};
use rusqlite::Connection;

fn workspace(conn: &Connection) {
    conn.execute(
        "INSERT INTO workspaces(id, name, created_at, last_active) VALUES('eff-w', 'Efficiency', 0, 0)",
        [],
    )
    .unwrap();
}

fn mission(conn: &Connection, id: &str, start: i64, end: i64, status: &str, is_test: bool) {
    conn.execute(
        "INSERT INTO missions(id, workspace_id, title, objective, cwd, status, max_parallel,
                              auto_account, created_at, updated_at, started_at, ended_at, is_test)
         VALUES(?1, 'eff-w', ?1, 'same objective', '/repo', ?2, 2, 1, ?3, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, status, start, start, end, is_test as i64],
    )
    .unwrap();
}

fn run(conn: &Connection, id: &str, mission_id: &str, spent: f64, created: i64) {
    conn.execute(
        "INSERT INTO runs(id, workspace_id, objective, cwd, status, max_parallel, spent_usd,
                          created_at, ended_at, mission_id)
         VALUES(?1, 'eff-w', 'same objective', '/repo', 'done', 4, ?3, ?4, ?4, ?2)",
        rusqlite::params![id, mission_id, spent, created],
    )
    .unwrap();
}

fn task(conn: &Connection, id: &str, run_id: &str, agent_id: &str, cost: f64) {
    conn.execute(
        "INSERT INTO tasks(id, run_id, title, prompt, agent_id, cwd, created_at, cost_usd)
         VALUES(?1, ?2, ?1, 'prompt', ?3, '/repo', 1, ?4)",
        rusqlite::params![id, run_id, agent_id, cost],
    )
    .unwrap();
}

fn span(conn: &Connection, mission_id: &str, kind: &str, actor: &str, target: &str, start: i64, end: i64) {
    timings::add(
        conn,
        mission_id,
        &NewSpan {
            kind: kind.into(),
            actor: actor.into(),
            target: target.into(),
            started_ms: start,
            ended_ms: end,
            detail: String::new(),
        },
    )
    .unwrap();
}

#[test]
fn soma_turnos_e_peer_ask_unindo_intervalos_sobrepostos() {
    let spans = vec![
        Span { id: 1, kind: "turn".into(), actor: "A".into(), target: String::new(), started_ms: 1_000, ended_ms: 3_000, detail: String::new() },
        Span { id: 2, kind: "peer_ask".into(), actor: "A".into(), target: "B".into(), started_ms: 2_000, ended_ms: 4_000, detail: String::new() },
        Span { id: 3, kind: "briefing".into(), actor: "A".into(), target: String::new(), started_ms: 4_000, ended_ms: 9_000, detail: String::new() },
        Span { id: 4, kind: "turn".into(), actor: "B".into(), target: String::new(), started_ms: 6_000, ended_ms: 7_500, detail: String::new() },
    ];
    assert_eq!(active_time(&spans), Some(4_500));
    assert_eq!(active_time(&[]), None);
}

#[test]
fn mission_efficiency_exposes_metrics_and_historical_agent_bands() {
    let conn = test_db();
    workspace(&conn);

    mission(&conn, "solo", 10, 60, "done", false);
    run(&conn, "solo-run", "solo", 2.0, 60);
    task(&conn, "solo-task", "solo-run", "codex", 2.0);
    span(&conn, "solo", "turn", "Solo", "", 1_000, 6_000);

    mission(&conn, "parallel-old", 15, 45, "done", false);
    run(&conn, "old-run", "parallel-old", 3.0, 45);
    task(&conn, "old-a", "old-run", "codex", 1.0);
    task(&conn, "old-b", "old-run", "claude", 1.0);
    task(&conn, "old-c", "old-run", "gemini", 1.0);
    span(&conn, "parallel-old", "turn", "A", "", 1_000, 10_000);
    span(&conn, "parallel-old", "turn", "B", "", 1_000, 10_000);
    span(&conn, "parallel-old", "turn", "C", "", 1_000, 10_000);

    mission(&conn, "parallel-now", 70, 90, "done", false);
    run(&conn, "now-run", "parallel-now", 1.5, 90);
    task(&conn, "now-lead", "now-run", "codex", 0.5);
    task(&conn, "now-a", "now-run", "claude", 0.5);
    task(&conn, "now-b", "now-run", "gemini", 0.5);
    span(&conn, "parallel-now", "turn", "Lead", "", 1_000, 3_000);
    span(&conn, "parallel-now", "peer_ask", "Lead", "Worker B", 2_000, 4_000);
    span(&conn, "parallel-now", "briefing", "Worker A", "", 1_000, 1_500);
    span(&conn, "parallel-now", "turn", "Worker B", "", 6_000, 7_000);

    mission(&conn, "test-only", 1, 100, "done", true);
    span(&conn, "test-only", "turn", "test-a", "", 1_000, 2_000);
    mission(&conn, "failed", 1, 100, "failed", false);
    span(&conn, "failed", "turn", "failed-a", "", 1_000, 2_000);

    let result = get(&conn, "parallel-now").unwrap();
    assert_eq!(result.active_ms, Some(4_000));
    assert_eq!(result.wall_ms, Some(20_000));
    assert_eq!(result.cost_estimate, Some(1.5));
    assert_eq!(result.agents, 3);
    assert_eq!(result.history_limit, HISTORY_LIMIT);
    assert_eq!(result.history_size, 2, "failed and test missions are not benchmarks");
    assert!((result.time_gain_percent.unwrap() - 60.0).abs() < 0.001);
    assert!((result.cost_gain_percent.unwrap() - 25.0).abs() < 0.001);

    let parallel_band = result.by_agent_band.iter().find(|band| band.band == "3-4").unwrap();
    assert_eq!(parallel_band.sample_size, 1);
    assert_eq!(parallel_band.median_active_ms, Some(9_000));
    assert_eq!(parallel_band.median_wall_ms, Some(30_000));
    assert_eq!(parallel_band.median_cost_estimate, Some(3.0));
    assert!((parallel_band.time_gain_percent.unwrap() - 40.0).abs() < 0.001);
    assert!((parallel_band.cost_gain_percent.unwrap() + 50.0).abs() < 0.001);
}

#[test]
fn mission_without_runs_or_spans_marks_unmeasured_fields() {
    let conn = test_db();
    workspace(&conn);
    mission(&conn, "draft", 10, 0, "draft", false);
    conn.execute("UPDATE missions SET started_at=NULL, ended_at=NULL WHERE id='draft'", []).unwrap();

    let result = get(&conn, "draft").unwrap();
    assert_eq!(result.active_ms, None);
    assert_eq!(result.wall_ms, None);
    assert_eq!(result.cost_estimate, None);
    assert_eq!(result.agents, 0);
    assert!(result.by_agent_band.is_empty());
}
