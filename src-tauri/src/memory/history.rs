use rusqlite::{Connection, params};
use serde::Serialize;

use super::MemoryRevision;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryValidityInterval {
    pub revision: i64,
    pub operation: String,
    pub kind: String,
    pub priority: i64,
    pub body: String,
    pub actor_kind: String,
    pub reason: Option<String>,
    pub valid_from: i64,
    pub valid_to: Option<i64>,
}

/// Derive validity intervals for one entry from its immutable revision history.
/// Revisions without a decision time cannot establish an interval boundary.
pub fn compute_validity(revisions: &[MemoryRevision]) -> Vec<MemoryValidityInterval> {
    let mut approved = revisions
        .iter()
        .filter(|revision| revision.status == "approved")
        .filter_map(|revision| revision.decided_at.map(|decided_at| (revision, decided_at)))
        .collect::<Vec<_>>();
    approved.sort_by(|(left, left_at), (right, right_at)| {
        left_at
            .cmp(right_at)
            .then_with(|| left.revision.cmp(&right.revision))
    });

    let mut intervals: Vec<MemoryValidityInterval> = Vec::new();
    let mut open_interval: Option<usize> = None;

    for (revision, decided_at) in approved {
        match revision.operation.as_str() {
            "create" | "update" => {
                if let Some(previous) = open_interval.take() {
                    intervals[previous].valid_to = Some(decided_at);
                }
                intervals.push(MemoryValidityInterval {
                    revision: revision.revision,
                    operation: revision.operation.clone(),
                    kind: revision.kind.clone(),
                    priority: revision.priority,
                    body: revision.body.clone(),
                    actor_kind: revision.actor_kind.clone(),
                    reason: revision.reason.clone(),
                    valid_from: decided_at,
                    valid_to: None,
                });
                open_interval = Some(intervals.len() - 1);
            }
            "delete" => {
                if let Some(previous) = open_interval.take() {
                    intervals[previous].valid_to = Some(decided_at);
                }
            }
            _ => {}
        }
    }

    intervals
}

/// Keep intervals valid at `at`; the start is inclusive and the end is exclusive.
pub fn intervals_at(
    intervals: &[MemoryValidityInterval],
    at: i64,
) -> Vec<MemoryValidityInterval> {
    intervals
        .iter()
        .filter(|interval| interval.valid_from <= at && interval.valid_to.is_none_or(|end| at < end))
        .cloned()
        .collect()
}

/// Approved history is available for workspace entries throughout the workspace and for
/// mission entries only while that exact mission is in scope.
pub fn history_for_entry(
    conn: &Connection,
    workspace_id: &str,
    mission_id: Option<&str>,
    entry_id: &str,
) -> Result<Vec<MemoryValidityInterval>, String> {
    let mut statement = conn
        .prepare(
            "SELECT r.entry_id,r.revision,r.status,r.operation,r.kind,r.priority,r.body,r.content_hash,r.actor_kind,r.source_run_id,r.source_task_id,r.source_fact_id,r.reason,r.expected_revision,r.created_at,r.decided_at
               FROM memory_entries e
               JOIN memory_revisions r ON r.entry_id=e.id
              WHERE e.id=?1 AND e.workspace_id=?2 AND r.status='approved'
                AND (e.scope='workspace' OR (e.scope='mission' AND ?3 IS NOT NULL AND e.mission_id=?3))
              ORDER BY r.decided_at ASC, r.revision ASC",
        )
        .map_err(|_| "could not read memory history".to_string())?;
    let revisions = statement
        .query_map(params![entry_id, workspace_id, mission_id], |row| {
            Ok(MemoryRevision {
                entry_id: row.get(0)?,
                revision: row.get(1)?,
                status: row.get(2)?,
                operation: row.get(3)?,
                kind: row.get(4)?,
                priority: row.get(5)?,
                body: row.get(6)?,
                content_hash: row.get(7)?,
                actor_kind: row.get(8)?,
                source_run_id: row.get(9)?,
                source_task_id: row.get(10)?,
                source_fact_id: row.get(11)?,
                reason: row.get(12)?,
                expected_revision: row.get(13)?,
                created_at: row.get(14)?,
                decided_at: row.get(15)?,
            })
        })
        .map_err(|_| "could not read memory history".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "could not read memory history".to_string())?;

    let mut intervals = compute_validity(&revisions);
    intervals.sort_by_key(|interval| interval.revision);
    Ok(intervals)
}

/// Return the interval(s) valid at `at` after enforcing workspace and mission ownership.
pub fn validity_at(
    conn: &Connection,
    workspace_id: &str,
    mission_id: Option<&str>,
    entry_id: &str,
    at: i64,
) -> Result<Vec<MemoryValidityInterval>, String> {
    Ok(intervals_at(
        &history_for_entry(conn, workspace_id, mission_id, entry_id)?,
        at,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{ProposalActor, ProposalInput, decide, propose};

    fn revision(
        revision: i64,
        status: &str,
        operation: &str,
        decided_at: Option<i64>,
    ) -> MemoryRevision {
        MemoryRevision {
            entry_id: "e1".into(),
            revision,
            status: status.into(),
            operation: operation.into(),
            kind: "note".into(),
            priority: revision,
            body: format!("body {revision}"),
            content_hash: format!("hash {revision}"),
            actor_kind: "worker".into(),
            source_run_id: None,
            source_task_id: None,
            source_fact_id: None,
            reason: Some(format!("reason {revision}")),
            expected_revision: None,
            created_at: decided_at.unwrap_or_default(),
            decided_at,
        }
    }

    fn seed_workspace(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO workspaces(id,name,created_at,last_active) VALUES(?1,?2,0,0)",
            params![id, format!("Workspace {id}")],
        )
        .unwrap();
    }

    fn seed_mission(conn: &Connection, id: &str, workspace_id: &str) {
        conn.execute(
            "INSERT INTO missions(id,workspace_id,title,objective,cwd,status,max_parallel,auto_account,created_at,updated_at) VALUES(?1,?2,?3,'objective','/repo','draft',2,1,0,0)",
            params![id, workspace_id, format!("Mission {id}")],
        )
        .unwrap();
    }

    fn approve_create(
        conn: &Connection,
        workspace_id: &str,
        mission_id: Option<&str>,
        scope: &str,
        key: &str,
    ) -> String {
        let input = ProposalInput {
            scope: scope.into(),
            key: key.into(),
            kind: "note".into(),
            body: format!("body for {key}"),
            priority: 0,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
        };
        let proposal = propose(
            conn,
            scope,
            workspace_id,
            mission_id,
            &input,
            ProposalActor {
                kind: "user",
                run_id: None,
                task_id: None,
                fact_id: None,
            },
        )
        .unwrap();
        decide(conn, &proposal.entry_id, proposal.revision, true).unwrap();
        proposal.entry_id
    }

    #[test]
    fn create_update_and_delete_form_half_open_intervals() {
        let revisions = [
            revision(3, "approved", "delete", Some(30)),
            revision(2, "approved", "update", Some(20)),
            revision(1, "approved", "create", Some(10)),
        ];

        let intervals = compute_validity(&revisions);
        assert_eq!(intervals.len(), 2);
        assert_eq!(intervals[0].revision, 1);
        assert_eq!(intervals[0].operation, "create");
        assert_eq!(intervals[0].valid_from, 10);
        assert_eq!(intervals[0].valid_to, Some(20));
        assert_eq!(intervals[1].revision, 2);
        assert_eq!(intervals[1].operation, "update");
        assert_eq!(intervals[1].valid_from, 20);
        assert_eq!(intervals[1].valid_to, Some(30));
        assert_eq!(intervals[1].kind, "note");
        assert_eq!(intervals[1].priority, 2);
        assert_eq!(intervals[1].body, "body 2");
        assert_eq!(intervals[1].actor_kind, "worker");
        assert_eq!(intervals[1].reason.as_deref(), Some("reason 2"));
    }

    #[test]
    fn ignores_rejected_pending_and_undated_approved_revisions() {
        let revisions = [
            revision(1, "approved", "create", Some(10)),
            revision(2, "proposed", "update", Some(20)),
            revision(3, "rejected", "delete", Some(30)),
            revision(4, "approved", "update", None),
        ];

        let intervals = compute_validity(&revisions);
        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].valid_from, 10);
        assert_eq!(intervals[0].valid_to, None);
    }

    #[test]
    fn exact_validity_start_is_included_and_end_is_excluded() {
        let history = compute_validity(&[
            revision(1, "approved", "create", Some(10)),
            revision(2, "approved", "update", Some(20)),
            revision(3, "approved", "delete", Some(30)),
        ]);

        assert_eq!(intervals_at(&history, 10)[0].revision, 1);
        assert_eq!(intervals_at(&history, 20).len(), 1);
        assert_eq!(intervals_at(&history, 20)[0].revision, 2);
        assert!(intervals_at(&history, 30).is_empty());
    }

    #[test]
    fn mission_history_is_isolated_and_workspace_history_is_always_visible() {
        let conn = crate::database::test_db();
        seed_workspace(&conn, "w1");
        seed_mission(&conn, "m1", "w1");
        seed_mission(&conn, "m2", "w1");
        let workspace_entry = approve_create(&conn, "w1", None, "workspace", "shared");
        let mission_entry = approve_create(&conn, "w1", Some("m1"), "mission", "private");

        assert_eq!(
            history_for_entry(&conn, "w1", Some("m2"), &workspace_entry)
                .unwrap()
                .len(),
            1
        );
        assert!(history_for_entry(&conn, "w1", Some("m2"), &mission_entry)
            .unwrap()
            .is_empty());
        assert_eq!(
            history_for_entry(&conn, "w1", Some("m1"), &mission_entry)
                .unwrap()
                .len(),
            1
        );
        assert!(history_for_entry(&conn, "w2", Some("m1"), &mission_entry)
            .unwrap()
            .is_empty());
    }
}
