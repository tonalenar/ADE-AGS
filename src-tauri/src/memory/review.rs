//! Resumo de revisão das memórias sugeridas ao concluir uma missão.
//! Só classifica e ordena; aprovar ou rejeitar continua sendo decisão explícita do usuário.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::database::DbConnection;

pub const HIGH_VALUE_SCORE: i64 = 70;
const NEAR_DUPLICATE_SIMILARITY: f64 = 0.85;

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

fn similarity(a: &str, b: &str) -> f64 {
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
    let mut s = 40 + kind_weight(&item.kind) + item.priority.clamp(-10, 10) * 2;
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

    for item in &mut items {
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
    let counts = ReviewCounts {
        total: items.len() as i64,
        duplicates: items.iter().filter(|i| i.duplicate_of.is_some()).count() as i64,
        contradictions: items.iter().filter(|i| i.contradicts.is_some()).count() as i64,
        high_value: items.iter().filter(|i| i.high_value).count() as i64,
    };
    Ok(MemoryReviewSummary { mission_id: mission_id.to_string(), items, counts })
}

#[tauri::command]
pub fn memory_review_summary(
    mission_id: String,
    db: tauri::State<DbConnection>,
) -> Result<MemoryReviewSummary, String> {
    let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
    review_summary(&conn, &mission_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{ProposalActor, ProposalInput, decide, propose};

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
}
