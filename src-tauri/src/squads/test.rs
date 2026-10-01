use rusqlite::Connection;

use crate::{
    database::test_db,
    missions::{self, MissionInput},
    runs::{self},
};

use super::{
    store,
    types::{AssignmentAvailability, SquadInput, SquadLeadInput, SquadMemberInput},
};

fn member(role_id: &str, agent_id: &str) -> SquadMemberInput {
    SquadMemberInput {
        reasoning_effort: None,
        role_id: role_id.into(),
        agent_id: agent_id.into(),
        model: None,
        account_id: None,
        auto_account: true,
        complexity: None,
        isolate_default: true,
    }
}

fn input(name: &str) -> SquadInput {
    SquadInput {
        name: name.into(),
        description: "Reusable test team".into(),
        lead: SquadLeadInput {
            reasoning_effort: None,
            agent_id: "claude-code".into(),
            model: Some("unvalidated/model-id".into()),
            account_id: None,
            auto_account: true,
            complexity: None,
        },
        members: vec![member("backend", "codex")],
    }
}

fn create(conn: &Connection, name: &str) -> super::Squad {
    let input = input(name);
    let valid = store::validate(conn, &input).unwrap();
    store::create(conn, &valid).unwrap()
}

fn workspace(conn: &Connection) {
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'Workspace', 0, 0)",
        [],
    )
    .unwrap();
}

fn add_account(conn: &Connection, id: &str, agent_id: &str) {
    conn.execute(
        "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at) VALUES (?1, ?2, ?3, '/tmp/account', 0)",
        rusqlite::params![id, agent_id, id],
    )
    .unwrap();
}

#[test]
fn squad_crud_persists_roles_and_allows_unconfigured_builtin_roles() {
    let conn = test_db();
    let created = create(&conn, "Feature Squad");
    assert_eq!(created.name, "Feature Squad");
    assert_eq!(
        created
            .members
            .iter()
            .map(|member| member.role_id.as_str())
            .collect::<Vec<_>>(),
        ["backend"]
    );
    assert_eq!(
        store::get(&conn, &created.id).unwrap(),
        Some(created.clone())
    );
    assert_eq!(store::list(&conn).unwrap().len(), 1);

    let mut changed = input("Updated Squad");
    changed.members = vec![member("frontend", "opencode"), member("qa", "codex")];
    let valid = store::validate(&conn, &changed).unwrap();
    let updated = store::update(&conn, &created.id, &valid).unwrap();
    assert_eq!(updated.name, "Updated Squad");
    assert_eq!(
        updated
            .members
            .iter()
            .map(|member| member.role_id.as_str())
            .collect::<Vec<_>>(),
        ["frontend", "qa"]
    );
    assert_eq!(store::list(&conn).unwrap()[0].id, created.id);

    store::delete(&conn, &created.id).unwrap();
    assert_eq!(store::get(&conn, &created.id).unwrap(), None);
    assert!(
        store::delete(&conn, &created.id)
            .unwrap_err()
            .contains("no squad")
    );
}

#[test]
fn squad_validation_rejects_invalid_names_roles_providers_and_accounts() {
    let conn = test_db();

    let mut invalid = input("   ");
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("name is required")
    );

    invalid = input("Duplicate role");
    invalid.members.push(member("backend", "opencode"));
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("configured more than once")
    );

    invalid = input("Unknown role");
    invalid.members[0].role_id = "mobile".into();
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("functional role 'mobile' does not exist")
    );

    invalid = input("Unknown provider");
    invalid.members[0].agent_id = "provider-removed-from-build".into();
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("no es un provider conocido")
    );

    invalid = input("Terminal provider");
    invalid.members[0].agent_id = crate::agents::SHELL_AGENT_ID.into();
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("no se puede correr sin terminal")
    );

    invalid = input("Missing account");
    invalid.members[0].auto_account = false;
    invalid.members[0].account_id = Some("missing-account".into());
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("does not exist")
    );

    add_account(&conn, "codex-account", "codex");
    invalid = input("Wrong owner");
    invalid.members[0].auto_account = false;
    invalid.members[0].account_id = Some("codex-account".into());
    invalid.members[0].agent_id = "opencode".into();
    assert!(
        store::validate(&conn, &invalid)
            .unwrap_err()
            .contains("belongs to 'codex', not 'opencode'")
    );

    invalid = input("Correct owner");
    invalid.members[0].auto_account = false;
    invalid.members[0].account_id = Some("codex-account".into());
    assert!(store::validate(&conn, &invalid).is_ok());

    let columns: Vec<String> = {
        let mut statement = conn.prepare("PRAGMA table_info(agent_accounts)").unwrap();
        statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert!(
        !columns
            .iter()
            .any(|column| ["token", "secret", "environment", "env"].contains(&column.as_str()))
    );
}

#[test]
fn saved_provider_or_account_disappearing_is_reported_without_erasing_ids() {
    let conn = test_db();
    conn.execute(
        "INSERT INTO squads (id, name, description, lead_agent_id, lead_auto_account, created_at, updated_at)
         VALUES ('legacy', 'Legacy squad', '', 'provider-removed-from-build', 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO squad_members (squad_id, role_id, agent_id, account_id, auto_account)
         VALUES ('legacy', 'backend', 'codex', 'deleted-account', 0)",
        [],
    )
    .unwrap();

    let saved = store::get(&conn, "legacy").unwrap().unwrap();
    assert_eq!(saved.lead.agent_id, "provider-removed-from-build");
    assert_eq!(
        saved.lead.availability,
        AssignmentAvailability::ProviderMissing
    );
    assert!(!saved.available);
    assert_eq!(
        saved.members[0].account_id.as_deref(),
        Some("deleted-account")
    );
    assert_eq!(
        saved.members[0].availability,
        AssignmentAvailability::AccountMissing
    );
}

#[test]
fn delete_bloquea_squads_referenciados_por_mission_y_run() {
    let conn = test_db();
    workspace(&conn);

    let mission_squad = create(&conn, "Mission reference");
    let mission_input = MissionInput {
        title: "Mission using Squad".into(),
        objective: "Keep the Squad history".into(),
        cwd: "/tmp/project".into(),
        auto_account: true,
        squad_id: Some(mission_squad.id.clone()),
        ..Default::default()
    };
    let valid = missions::store::validate(&conn, &mission_input).unwrap();
    missions::store::create(&conn, "w1", &valid).unwrap();
    assert!(
        store::delete(&conn, &mission_squad.id)
            .unwrap_err()
            .contains("referenced by a Mission or Run")
    );

    let run_squad = create(&conn, "Run reference");
    let run = runs::store::create_run(&conn, "w1", "Historical Squad", "/tmp/project").unwrap();
    runs::store::set_run_squad_snapshot(&conn, &run.id, &run_squad).unwrap();
    assert!(
        store::delete(&conn, &run_squad.id)
            .unwrap_err()
            .contains("referenced by a Mission or Run")
    );
    assert_eq!(
        store::get(&conn, &run_squad.id).unwrap().unwrap().name,
        "Run reference"
    );
}

#[test]
fn all_registered_agent_providers_can_be_saved_as_lead() {
    let conn = test_db();
    let mut team = input("Capabilities");
    team.lead.agent_id = "opencode".into();
    let valid = store::validate(&conn, &team).unwrap();
    let saved = store::create(&conn, &valid).unwrap();
    assert_eq!(saved.members[0].agent_id, "codex");
    team.lead.agent_id = "codex".into();
    let codex = store::validate(&conn, &team).unwrap();
    assert_eq!(codex.lead.agent_id, "codex");
    team.lead.agent_id = "kimi-code".into();
    assert!(store::validate(&conn, &team).is_ok());
    assert_eq!(store::get(&conn, &saved.id).unwrap().unwrap().lead.agent_id, "opencode");
    conn.execute("UPDATE squads SET lead_agent_id = 'kimi-code' WHERE id = ?1", [&saved.id]).unwrap();
    let historical = store::get(&conn, &saved.id).unwrap().unwrap();
    assert_eq!(historical.lead.agent_id, "kimi-code");
    assert!(!historical.available);
    for provider in ["claude-code", "codex", "opencode", "gemini-cli", "kimi-code", "antigravity"] {
        let mut draft = input(&format!("Lead {provider}"));
        draft.lead.agent_id = provider.into();
        let valid = store::validate(&conn, &draft).unwrap();
        let saved = store::create(&conn, &valid).unwrap();
        assert_eq!(store::get(&conn, &saved.id).unwrap().unwrap().lead.agent_id, provider);
        if !crate::agents::adapter_for(provider).unwrap().supports_orchestration() {
            assert!(!saved.available, "unsupported execution must remain blocked: {provider}");
            assert!(crate::runs::ensure_orchestration(provider).is_err());
        }
    }
}

#[test]
fn reasoning_effort_survives_squad_edits_run_snapshots_and_task_history() {
    let conn = test_db();
    workspace(&conn);
    let mut team = input("Effort team");
    team.lead.reasoning_effort = Some("medium".into());
    team.members[0].model = Some("gpt-6-luna".into());
    team.members[0].reasoning_effort = Some("high".into());
    let saved = store::create(&conn, &store::validate(&conn, &team).unwrap()).unwrap();
    assert_eq!(saved.lead.reasoning_effort.as_deref(), Some("medium"));
    let run = runs::store::create_run(&conn, "w1", "Old run", "/p").unwrap();
    runs::store::set_run_squad_snapshot(&conn, &run.id, &saved).unwrap();
    let old_member = store::snapshot_members_of_run(&conn, &run.id).unwrap().remove(0);
    let task = runs::store::create_task(&conn, &runs::store::NewTask {
        run_id: &run.id, title: "Backend", prompt: "fixture", cwd: "/p", agent_id: &old_member.agent_id,
        model: old_member.model.as_deref(), reasoning_effort: old_member.reasoning_effort.as_deref(),
        functional_role: Some("backend"), role: Some("worker"), ..Default::default()
    }).unwrap();
    team.members[0].reasoning_effort = Some("low".into());
    let changed = store::update(&conn, &saved.id, &store::validate(&conn, &team).unwrap()).unwrap();
    let next_run = runs::store::create_run(&conn, "w1", "New run", "/p").unwrap();
    runs::store::set_run_squad_snapshot(&conn, &next_run.id, &changed).unwrap();
    assert_eq!(store::snapshot_members_of_run(&conn, &run.id).unwrap()[0].reasoning_effort.as_deref(), Some("high"));
    assert_eq!(store::snapshot_members_of_run(&conn, &next_run.id).unwrap()[0].reasoning_effort.as_deref(), Some("low"));
    let historical = runs::store::task_by_id(&conn, &task.id).unwrap().unwrap();
    assert_eq!(historical.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(historical.model.as_deref(), Some("gpt-6-luna"));
    team.members[0].complexity = Some(runs::Complexity::Hard);
    assert!(store::validate(&conn, &team).is_err());
    team.members[0].model = None;
    assert!(store::validate(&conn, &team).is_err());
}
