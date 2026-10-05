//! Regressão do contrato compartilhado pela lista/QG e pelo IPC da CLI.
use super::{efficiency, store, timings, timings_of};
use crate::database::test_db;
use rusqlite::params;

fn assert_consistent(
    recorded_ms: Option<i64>,
    with_spans: bool,
    started_at: Option<i64>,
    expected_ms: Option<i64>,
    expected_source: Option<&str>,
) {
    let conn = test_db();
    conn.execute("INSERT INTO workspaces(id, name, created_at, last_active) VALUES('active-w', 'Active consistency', 0, 0)", []).unwrap();
    conn.execute(
        "INSERT INTO missions(id, workspace_id, title, objective, cwd, status, max_parallel,
                              auto_account, created_at, updated_at, started_at, ended_at)
         VALUES('active-m', 'active-w', 'Active', 'Same mission', '/repo', 'done', 2, 1, 10, 70, ?1, 70)",
        [started_at],
    ).unwrap();
    if let Some(ms) = recorded_ms {
        conn.execute(
            "INSERT INTO mission_active(mission_id, active_ms) VALUES('active-m', ?1)",
            params![ms],
        )
        .unwrap();
    }
    if with_spans {
        // União de 4.500 ms, incluindo sobreposição entre turno e espera.
        for (kind, start, end) in [("turn", 1_000, 4_000), ("peer_ask", 3_000, 5_500)] {
            timings::add(
                &conn,
                "active-m",
                &timings::NewSpan {
                    kind: kind.into(),
                    actor: "Lead".into(),
                    target: "Worker".into(),
                    started_ms: start,
                    ended_ms: end,
                    detail: String::new(),
                },
            )
            .unwrap();
        }
    }

    let rows = store::list(&conn, "active-w").unwrap();
    let summary = rows
        .iter()
        .find(|row| row.mission.id == "active-m")
        .unwrap();
    let efficiency = efficiency::get(&conn, "active-m").unwrap();
    let timings = timings_of(&conn, "active-m").unwrap();
    assert_eq!(summary.active_seconds, expected_ms.map(|ms| ms / 1000));
    assert_eq!(summary.active_source.as_deref(), expected_source);
    assert_eq!(efficiency.active_ms, expected_ms);
    assert_eq!(efficiency.active_source.as_deref(), expected_source);
    assert_eq!(timings.active.ms, expected_ms);
    assert_eq!(timings.active.source, expected_source);
    assert_eq!(efficiency.turn_ms, with_spans.then_some(4_500));
    assert_eq!(timings.turn_ms, efficiency.turn_ms);

    // A CLI serializa os mesmos resultados via IPC: verifica nomes, valores e nulls.
    let list_json = serde_json::to_value(summary).unwrap();
    let efficiency_json = serde_json::to_value(&efficiency).unwrap();
    let timings_json = serde_json::to_value(&timings).unwrap();
    assert_eq!(
        list_json["activeSeconds"],
        serde_json::json!(expected_ms.map(|ms| ms / 1000))
    );
    assert_eq!(
        list_json["activeSource"],
        serde_json::json!(expected_source)
    );
    assert_eq!(efficiency_json["activeMs"], timings_json["active"]["ms"]);
    assert_eq!(
        efficiency_json["activeSource"],
        timings_json["active"]["source"]
    );
    assert_eq!(efficiency_json["activeMs"], serde_json::json!(expected_ms));
    assert_eq!(
        efficiency_json["activeSource"],
        serde_json::json!(expected_source)
    );
}

#[test]
fn lista_qg_cli_priorizam_mission_active_sobre_spans_e_relogio() {
    assert_consistent(
        Some(12_500),
        true,
        Some(10),
        Some(12_500),
        Some("mission_active"),
    );
}

#[test]
fn lista_qg_cli_usam_uniao_de_spans_sem_mission_active() {
    assert_consistent(None, true, Some(10), Some(4_500), Some("spans"));
}

#[test]
fn lista_qg_cli_usam_relogio_sem_mission_active_nem_spans() {
    assert_consistent(None, false, Some(10), Some(60_000), Some("wall"));
}

#[test]
fn lista_qg_cli_preservam_nao_medido_sem_inicio_nem_medicoes() {
    assert_consistent(None, false, None, None, None);
}

#[test]
fn qg_and_cli_expose_the_same_persisted_delegation_contract() {
    let conn = test_db();
    conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('dw','W',0,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,started_at,created_at,updated_at) VALUES('dm','dw','T','O','/repo',1,1,1);").unwrap();
    for (kind, start, end, detail) in [("boot", 1_000, 6_000, ""), ("peer_message", 90_000, 90_000, "delegation")] {
        timings::add(&conn, "dm", &timings::NewSpan { kind: kind.into(), actor: "Orquestrador".into(), target: "Backend".into(), started_ms: start, ended_ms: end, detail: detail.into() }).unwrap();
    }
    let cli = timings_of(&conn, "dm").unwrap();
    let qg = efficiency::get(&conn, "dm").unwrap();
    assert_eq!(cli.first_delegation_ms, Some(89_000));
    assert_eq!(cli.first_delegation_ms, qg.first_delegation_ms);
    assert_eq!(cli.first_delegation_source, qg.first_delegation_source);
    let json = serde_json::to_value(cli).unwrap();
    assert_eq!(json["firstDelegationMs"], 89_000);
    assert_eq!(json["firstDelegationSource"], "peer_message");
}
