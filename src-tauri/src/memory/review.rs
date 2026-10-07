//! Resumo de revisão das memórias sugeridas ao concluir uma missão.
//! Só classifica e ordena; aprovar ou rejeitar continua sendo decisão explícita do usuário.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::database::DbConnection;

pub const HIGH_VALUE_SCORE: i64 = 70;
pub const NEAR_DUPLICATE_SIMILARITY: f64 = 0.85;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub fact_id: Option<String>,
    pub actor_kind: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRef {
    pub entry_id: String,
    pub key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub entry_id: String,
    pub revision: i64,
    pub key: String,
    pub kind: String,
    pub body: String,
    pub priority: i64,
    pub evidence: ReviewEvidence,
    pub duplicate_of: Option<ReviewRef>,
    pub contradicts: Option<ReviewRef>,
    pub high_value: bool,
    pub score: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCounts {
    pub total: i64,
    pub duplicates: i64,
    pub contradictions: i64,
    pub high_value: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReviewSummary {
    pub mission_id: String,
    pub items: Vec<ReviewItem>,
    pub counts: ReviewCounts,
}

struct Approved {
    entry_id: String,
    key: String,
    body: String,
}

fn norm_key(key: &str) -> String {
    key.trim().to_lowercase()
}

fn norm_body(body: &str) -> String {
    body.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn words(body: &str) -> HashSet<String> {
    body.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() > 2)
        .map(str::to_string)
        .collect()
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    let union = wa.union(&wb).count();
    if union == 0 {
        return 0.0;
    }
    wa.intersection(&wb).count() as f64 / union as f64
}

fn kind_weight(kind: &str) -> i64 {
    match kind {
        "constraint" => 20,
        "decision" => 15,
        "finding" => 10,
        "file" => 5,
        _ => 0,
    }
}

fn score(item: &ReviewItem) -> i64 {
    let user_priority = if item.evidence.actor_kind == "user" { item.priority.clamp(-10, 10) * 2 } else { 0 };
    let mut s = 40 + kind_weight(&item.kind) + user_priority;
    if item.evidence.run_id.is_some() || item.evidence.task_id.is_some() {
        s += 10;
    }
    if item.evidence.fact_id.is_some() {
        s += 10;
    }
    if item.contradicts.is_some() {
        s -= 15;
    }
    if item.duplicate_of.is_some() {
        s = s.min(10);
    }
    s.clamp(0, 100)
}

/// Memórias aprovadas (ativas) que valem para a missão: as da própria missão e as do workspace.
fn approved_for(conn: &Connection, workspace_id: &str, mission_id: &str) -> Result<Vec<Approved>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id,e.key,r.body FROM memory_entries e JOIN memory_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision AND r.status='approved' WHERE e.status='active' AND e.workspace_id=?1 AND (e.scope='workspace' OR (e.scope='mission' AND e.mission_id=?2))",
        )
        .map_err(|_| "could not read approved memories".to_string())?;
    let rows = stmt
        .query_map(params![workspace_id, mission_id], |r| {
            Ok(Approved { entry_id: r.get(0)?, key: r.get(1)?, body: r.get(2)? })
        })
        .map_err(|_| "could not read approved memories".to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "could not read approved memories".to_string())
}

pub fn review_summary(conn: &Connection, mission_id: &str) -> Result<MemoryReviewSummary, String> {
    let workspace_id: String = conn
        .query_row("SELECT workspace_id FROM missions WHERE id=?1", [mission_id], |r| r.get(0))
        .optional()
        .map_err(|_| "could not read mission".to_string())?
        .ok_or_else(|| "mission not found".to_string())?;
    let approved = approved_for(conn, &workspace_id, mission_id)?;

    // Propostas pendentes da missão: escopo missão, ou escopo workspace vindas de runs da missão.
    let mut stmt = conn
        .prepare(
            "SELECT e.id,r.revision,e.key,r.kind,r.body,r.priority,r.actor_kind,r.source_run_id,r.source_task_id,r.source_fact_id,r.reason FROM memory_revisions r JOIN memory_entries e ON e.id=r.entry_id WHERE r.status='proposed' AND r.operation<>'delete' AND e.workspace_id=?1 AND ((e.scope='mission' AND e.mission_id=?2) OR (e.scope='workspace' AND r.source_run_id IN (SELECT id FROM runs WHERE mission_id=?2))) ORDER BY e.key,r.revision",
        )
        .map_err(|_| "could not read pending memories".to_string())?;
    let rows = stmt
        .query_map(params![workspace_id, mission_id], |r| {
            Ok(ReviewItem {
                entry_id: r.get(0)?,
                revision: r.get(1)?,
                key: r.get(2)?,
                kind: r.get(3)?,
                body: r.get(4)?,
                priority: r.get(5)?,
                evidence: ReviewEvidence {
                    actor_kind: r.get(6)?,
                    run_id: r.get(7)?,
                    task_id: r.get(8)?,
                    fact_id: r.get(9)?,
                    reason: r.get(10)?,
                },
                duplicate_of: None,
                contradicts: None,
                high_value: false,
                score: 0,
            })
        })
        .map_err(|_| "could not read pending memories".to_string())?;
    let mut items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "could not read pending memories".to_string())?;

    classify(&mut items, &approved);
    let counts = counts_for(items.iter());
    Ok(MemoryReviewSummary { mission_id: mission_id.to_string(), items, counts })
}

fn classify(items: &mut Vec<ReviewItem>, approved: &[Approved]) {
    for item in items.iter_mut() {
        let (key, body) = (norm_key(&item.key), norm_body(&item.body));
        for a in approved.iter().filter(|a| a.entry_id != item.entry_id) {
            let same_key = norm_key(&a.key) == key;
            let a_body = norm_body(&a.body);
            let r = || ReviewRef { entry_id: a.entry_id.clone(), key: a.key.clone() };
            if a_body == body || similarity(&a_body, &body) >= NEAR_DUPLICATE_SIMILARITY {
                item.duplicate_of = Some(r());
                break;
            }
            if same_key && item.contradicts.is_none() {
                item.contradicts = Some(r());
            }
        }
        item.score = score(item);
        item.high_value = item.score >= HIGH_VALUE_SCORE
            && item.duplicate_of.is_none()
            && item.contradicts.is_none();
    }
    items.sort_by(|a, b| {
        b.high_value
            .cmp(&a.high_value)
            .then(b.score.cmp(&a.score))
            .then(a.key.cmp(&b.key))
    });
}

fn counts_for<'a>(items: impl Iterator<Item = &'a ReviewItem>) -> ReviewCounts {
    items.fold(ReviewCounts::default(), |mut counts, item| {
        counts.total += 1;
        counts.duplicates += i64::from(item.duplicate_of.is_some());
        counts.contradictions += i64::from(item.contradicts.is_some());
        counts.high_value += i64::from(item.high_value);
        counts
    })
}

#[tauri::command]
pub fn memory_review_summary(
    mission_id: String,
    db: tauri::State<DbConnection>,
) -> Result<MemoryReviewSummary, String> {
    let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
    review_summary(&conn, &mission_id)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewGroup {
    pub mission_id: Option<String>,
    pub mission_title: Option<String>,
    pub title: String,
    pub items: Vec<WorkspaceReviewItem>,
    pub counts: ReviewCounts,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewItem {
    #[serde(flatten)]
    pub item: ReviewItem,
    pub operation: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewSummary {
    pub workspace_id: String,
    pub groups: Vec<WorkspaceReviewGroup>,
    pub counts: ReviewCounts,
}

/// Read-only aggregation of ALL pending proposals. Unassigned workspace proposals
/// have mission_id=None. Deletions are explicit operations, never suggestions to add.
pub fn review_summary_workspace(conn: &Connection, workspace_id: &str) -> Result<WorkspaceReviewSummary, String> {
    review_workspace(conn,workspace_id,false)
}

pub(crate) fn review_summary_workspace_including_dreams(conn:&Connection,workspace_id:&str)->Result<WorkspaceReviewSummary,String> {
    review_workspace(conn,workspace_id,true)
}

fn review_workspace(conn:&Connection,workspace_id:&str,include_dreams:bool)->Result<WorkspaceReviewSummary,String> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?1)", [workspace_id], |r| r.get(0))
        .map_err(|_| "could not read workspace".to_string())?;
    if !exists { return Err("workspace not found".into()); }
    let mut stmt = conn.prepare(
        "SELECT e.id,r.revision,e.key,r.kind,r.body,r.priority,r.actor_kind,r.source_run_id,r.source_task_id,r.source_fact_id,r.reason,r.operation,m.id,m.title
         FROM memory_revisions r JOIN memory_entries e ON e.id=r.entry_id
         LEFT JOIN runs run ON run.id=r.source_run_id
         LEFT JOIN missions m ON m.workspace_id=e.workspace_id AND m.id=CASE WHEN e.scope='mission' THEN e.mission_id ELSE run.mission_id END
         WHERE r.status='proposed' AND e.workspace_id=?1 AND (?2 OR r.actor_kind<>'dreamer')
         ORDER BY m.title COLLATE NOCASE,m.id,e.key,r.revision"
    ).map_err(|_| "could not read pending workspace memories".to_string())?;
    let rows = stmt.query_map(params![workspace_id,include_dreams], |r| Ok((
        r.get::<_, Option<String>>(12)?, r.get::<_, Option<String>>(13)?,
        WorkspaceReviewItem {
            item: ReviewItem {
                entry_id: r.get(0)?, revision: r.get(1)?, key: r.get(2)?, kind: r.get(3)?, body: r.get(4)?, priority: r.get(5)?,
                evidence: ReviewEvidence { actor_kind: r.get(6)?, run_id: r.get(7)?, task_id: r.get(8)?, fact_id: r.get(9)?, reason: r.get(10)? },
                duplicate_of: None, contradicts: None, high_value: false, score: 0,
            },
            operation: r.get(11)?,
        }
    ))).map_err(|_| "could not read pending workspace memories".to_string())?;
    let mut groups: Vec<WorkspaceReviewGroup> = Vec::new();
    for row in rows {
        let (mission_id, mission_title, item) = row.map_err(|_| "could not read pending workspace memories".to_string())?;
        if let Some(group) = groups.iter_mut().find(|g| g.mission_id == mission_id) {
            group.items.push(item);
        } else {
            groups.push(WorkspaceReviewGroup { title: mission_title.clone().unwrap_or_default(), mission_id, mission_title, items: vec![item], counts: ReviewCounts::default() });
        }
    }
    for group in &mut groups {
        let classified: HashMap<(String, i64), ReviewItem> = if let Some(ref mission_id) = group.mission_id {
            review_summary(conn, mission_id)?.items.into_iter().map(|i| ((i.entry_id.clone(), i.revision), i)).collect()
        } else {
            let approved = approved_for(conn, workspace_id, "")?;
            let mut items = group.items.iter().filter(|i| i.operation != "delete").map(|i| i.item.clone()).collect();
            classify(&mut items, &approved);
            items.into_iter().map(|i| ((i.entry_id.clone(), i.revision), i)).collect()
        };
        for item in &mut group.items {
            if let Some(reviewed) = classified.get(&(item.item.entry_id.clone(), item.item.revision)) {
                item.item = reviewed.clone();
            }
        }
        group.items.sort_by(|a, b| b.item.high_value.cmp(&a.item.high_value).then(b.item.score.cmp(&a.item.score)).then(a.item.key.cmp(&b.item.key)));
        group.counts = counts_for(group.items.iter().map(|i| &i.item));
    }
    groups.sort_by(|a, b| a.mission_id.is_none().cmp(&b.mission_id.is_none())
        .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        .then(a.mission_id.cmp(&b.mission_id)));
    let counts = counts_for(groups.iter().flat_map(|g| g.items.iter().map(|i| &i.item)));
    Ok(WorkspaceReviewSummary { workspace_id: workspace_id.into(), groups, counts })
}

#[tauri::command]
pub fn memory_review_summary_workspace(workspace_id: String, db: tauri::State<DbConnection>) -> Result<WorkspaceReviewSummary, String> {
    let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
    review_summary_workspace(&conn, &workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{ProposalActor, ProposalInput, decide, propose};

    #[test]
    fn agent_priority_cannot_inflate_review_score() {
        let mut item = ReviewItem {
            entry_id: "entry".into(), revision: 1, key: "key".into(), kind: "constraint".into(), body: "evidence".into(), priority: 0,
            evidence: ReviewEvidence { run_id: Some("run".into()), task_id: None, fact_id: None, actor_kind: "worker".into(), reason: None },
            duplicate_of: None, contradicts: None, high_value: false, score: 0,
        };
        let base = score(&item);
        item.priority = 10;
        assert_eq!(score(&item), base);
        item.evidence.actor_kind = "lead".into();
        assert_eq!(score(&item), base);
        item.evidence.actor_kind = "user".into();
        assert!(score(&item) > base);
    }

    fn setup() -> Connection {
        let conn = crate::database::test_db();
        conn.execute("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','W',0,0)", []).unwrap();
        conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,status,max_parallel,auto_account,created_at,updated_at) VALUES('m','w','M','o','/repo','done',2,1,0,0)", []).unwrap();
        conn
    }

    fn put_in(conn: &Connection, mission: &str, scope: &str, key: &str, kind: &str, body: &str, priority: i64) -> (String, i64) {
        let input = ProposalInput {
            scope: scope.into(),
            key: key.into(),
            kind: kind.into(),
            body: body.into(),
            priority,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
        };
        let r = propose(
            conn,
            scope,
            "w",
            (scope == "mission").then_some(mission),
            &input,
            ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None },
        )
        .unwrap();
        (r.entry_id, r.revision)
    }

    fn put(conn: &Connection, scope: &str, key: &str, kind: &str, body: &str, priority: i64) -> (String, i64) {
        put_in(conn, "m", scope, key, kind, body, priority)
    }

    #[test]
    fn mission_without_pending_is_empty() {
        let s = review_summary(&setup(), "m").unwrap();
        assert!(s.items.is_empty());
        assert_eq!(s.counts, ReviewCounts::default());
    }

    #[test]
    fn unknown_mission_errors() {
        assert!(review_summary(&setup(), "nope").is_err());
    }

    #[test]
    fn flags_duplicates_and_contradictions_against_approved() {
        let conn = setup();
        let (e, r) = put(&conn, "workspace", "ci", "constraint", "CI roda em Linux ubuntu", 0);
        decide(&conn, &e, r, true).unwrap();
        put(&conn, "mission", "ci-copia", "note", "ci  RODA em linux Ubuntu", 0);
        put(&conn, "mission", "CI", "note", "CI roda no Windows", 0);
        put(&conn, "mission", "novo", "decision", "Usar worktrees por integrante", 5);
        let s = review_summary(&conn, "m").unwrap();
        assert_eq!(s.counts.total, 3);
        assert_eq!(s.counts.duplicates, 1);
        assert_eq!(s.counts.contradictions, 1);
        let dup = s.items.iter().find(|i| i.key == "ci-copia").unwrap();
        assert_eq!(dup.duplicate_of.as_ref().unwrap().entry_id, e);
        assert!(!dup.high_value && dup.score <= 10);
        let con = s.items.iter().find(|i| i.key == "CI").unwrap();
        assert!(con.contradicts.is_some() && !con.high_value);
    }

    #[test]
    fn highlights_high_value_first_and_never_decides() {
        let conn = setup();
        put(&conn, "mission", "nota", "note", "algo qualquer sem peso", 0);
        put(&conn, "mission", "regra", "constraint", "Nunca copiar credenciais entre contas", 8);
        let s = review_summary(&conn, "m").unwrap();
        assert_eq!(s.items[0].key, "regra");
        assert!(s.items[0].high_value);
        assert_eq!(s.counts.high_value, 1);
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_revisions WHERE status='proposed'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pending, 2);
    }

    #[test]
    fn ignores_other_missions_and_decided_proposals() {
        let conn = setup();
        conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,status,max_parallel,auto_account,created_at,updated_at) VALUES('m2','w','M2','o','/repo','done',2,1,0,0)", []).unwrap();
        put_in(&conn, "m2", "mission", "x", "note", "b", 0);
        let (e, r) = put(&conn, "mission", "y", "note", "decidida", 0);
        decide(&conn, &e, r, false).unwrap();
        assert!(review_summary(&conn, "m").unwrap().items.is_empty());
    }

    #[test]
    fn workspace_review_empty_and_unknown_workspace() {
        let conn = setup();
        assert!(review_summary_workspace(&conn, "w").unwrap().groups.is_empty());
        assert!(review_summary_workspace(&conn, "missing").is_err());
    }

    #[test]
    fn workspace_review_groups_missions_with_pending_and_never_decides() {
        let conn = setup();
        conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m2','w','Outra missão','o','/repo',0,0),('empty','w','Empty','o','/repo',0,0)", []).unwrap();
        put(&conn, "mission", "first", "note", "First mission evidence", 0);
        put_in(&conn, "m2", "mission", "second", "note", "Second mission evidence", 0);
        let (entry, revision) = put(&conn, "mission", "rejected", "note", "Rejected evidence", 0);
        decide(&conn, &entry, revision, false).unwrap();
        let groups = review_summary_workspace(&conn, "w").unwrap().groups;
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].mission_id.as_deref(), Some("m"));
        assert_eq!(groups[0].title, "M");
        assert_eq!(groups[1].mission_id.as_deref(), Some("m2"));
        assert_eq!(groups[1].title, "Outra missão");
        assert_eq!(groups.iter().map(|g| g.items.len()).sum::<usize>(), 2);
        let pending: i64 = conn.query_row("SELECT COUNT(*) FROM memory_revisions WHERE status='proposed'", [], |r| r.get(0)).unwrap();
        assert_eq!(pending, 2, "review never approves or rejects");
        let approved: i64 = conn.query_row("SELECT COUNT(*) FROM memory_revisions WHERE status='approved'", [], |r| r.get(0)).unwrap();
        assert_eq!(approved, 0);
    }

    #[test]
    fn workspace_review_preserves_classifications_and_run_evidence() {
        let conn = setup();
        let (approved, revision) = put(&conn, "workspace", "ci", "constraint", "CI roda em Linux ubuntu", 0);
        decide(&conn, &approved, revision, true).unwrap();
        put(&conn, "mission", "copy", "note", "CI roda em Linux ubuntu", 0);
        put(&conn, "mission", "ci", "note", "CI roda no Windows", 0);
        conn.execute("INSERT INTO runs(id,workspace_id,objective,cwd,created_at,mission_id) VALUES('run','w','o','/repo',0,'m')", []).unwrap();
        let input = ProposalInput {
            scope: "workspace".into(), key: "from-run".into(), kind: "note".into(),
            body: "A workspace finding from a mission run".into(), priority: 0,
            operation: "create".into(), expected_revision: None, source_fact_id: None,
            reason: Some("Terminal evidence".into()),
        };
        propose(&conn, "workspace", "w", None, &input,
            ProposalActor { kind: "worker", run_id: Some("run"), task_id: None, fact_id: None }).unwrap();
        let mission = review_summary(&conn, "m").unwrap();
        let groups = review_summary_workspace(&conn, "w").unwrap().groups;
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].items.iter().map(|i| i.item.clone()).collect::<Vec<_>>(), mission.items, "existing evidence, flags and ordering remain intact");
        assert_eq!(mission.counts.duplicates, 1);
        assert_eq!(mission.counts.contradictions, 1);
        let origin = groups[0].items.iter().find(|i| i.item.key == "from-run").unwrap();
        assert_eq!(origin.item.evidence.run_id.as_deref(), Some("run"));
        assert_eq!(origin.item.evidence.reason.as_deref(), Some("Terminal evidence"));
        let json = serde_json::to_value(&groups).unwrap();
        assert_eq!(json[0]["missionId"], "m");
        assert_eq!(json[0]["title"], "M");
        assert!(json[0]["items"][0].get("entryId").is_some());
    }

    #[test]
    fn workspace_review_isolates_other_workspaces() {
        let conn = setup();
        put(&conn, "mission", "local", "note", "Local evidence", 0);
        conn.execute("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('other','Other',0,0)", []).unwrap();
        conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('foreign','other','Other mission','o','/repo',0,0)", []).unwrap();
        let (other, _) = put(&conn, "mission", "foreign", "note", "Foreign evidence", 0);
        conn.execute("UPDATE memory_entries SET workspace_id='other', mission_id='foreign' WHERE id=?1", [&other]).unwrap();
        let groups = review_summary_workspace(&conn, "w").unwrap().groups;
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].items.len(), 1);
        assert_eq!(groups[0].items[0].item.key, "local");
        assert_eq!(review_summary_workspace(&conn, "other").unwrap().groups[0].mission_id.as_deref(), Some("foreign"));
    }

    #[test]
    fn workspace_review_includes_unassigned_and_deletions_and_matches_pending_count() {
        let conn = setup();
        put(&conn, "mission", "normal", "note", "Mission evidence", 0);
        put(&conn, "workspace", "unassigned", "note", "Workspace evidence without mission", 0);
        let (entry, revision) = put(&conn, "workspace", "obsolete", "note", "Old workspace evidence", 0);
        decide(&conn, &entry, revision, true).unwrap();
        let input = ProposalInput {
            scope: "workspace".into(), key: "obsolete".into(), kind: "note".into(), body: "Old workspace evidence".into(),
            priority: 0, operation: "delete".into(), expected_revision: Some(revision), source_fact_id: None, reason: Some("No longer applicable".into()),
        };
        propose(&conn, "workspace", "w", None, &input, ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None }).unwrap();
        let summary = review_summary_workspace(&conn, "w").unwrap();
        assert_eq!(summary.groups.len(), 2);
        let unassigned = summary.groups.last().unwrap();
        assert!(unassigned.mission_id.is_none());
        assert!(unassigned.mission_title.is_none());
        assert!(unassigned.title.is_empty());
        assert_eq!(unassigned.counts.total, 2);
        assert_eq!(unassigned.items.iter().find(|i| i.item.key == "obsolete").unwrap().operation, "delete");
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["workspaceId"], "w");
        assert!(json["groups"][1]["missionId"].is_null());
        assert!(json["groups"][1]["items"][0].get("entryId").is_some());
        let counts = crate::memory::pending_counts_for_workspace(&conn, "w").unwrap();
        let total = counts.workspace + counts.by_mission.values().sum::<i64>();
        assert_eq!(summary.counts.total, total);
        assert_eq!(total, 3);
        let status: String = conn.query_row("SELECT status FROM memory_entries WHERE id=?1", [&entry], |r| r.get(0)).unwrap();
        assert_eq!(status, "active", "review never executes deletions");
    }

    #[test]
    fn workspace_review_includes_deletions_in_mission_group() {
        let conn = setup();
        let (entry, revision) = put(&conn, "mission", "obsolete", "note", "Old mission evidence", 0);
        decide(&conn, &entry, revision, true).unwrap();
        let input = ProposalInput {
            scope: "mission".into(), key: "obsolete".into(), kind: "note".into(), body: "Old mission evidence".into(),
            priority: 0, operation: "delete".into(), expected_revision: Some(revision), source_fact_id: None, reason: None,
        };
        propose(&conn, "mission", "w", Some("m"), &input, ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None }).unwrap();
        let summary = review_summary_workspace(&conn, "w").unwrap();
        assert_eq!(summary.counts.total, 1);
        assert_eq!(summary.groups[0].mission_id.as_deref(), Some("m"));
        assert_eq!(summary.groups[0].items[0].operation, "delete");
        assert!(!summary.groups[0].items[0].item.high_value);
        assert_eq!(review_summary(&conn, "m").unwrap().counts.total, 0, "existing command retains its contract");
    }
}
