//! Proven terminal ownership and transcript readers. Unsupported dialects stay unmeasured.
use super::claude::{parse_ts, UsageRecord};
use super::mission::{
    estimate_in_range, mission_snapshot, mission_transcripts, read_transcript_priced,
    sum_usage_in_range, total_for_agents, CostEstimate, MissionAgentTokens, MissionTokens,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTabTokens {
    pub tab_id: String,
    pub agent_id: String,
    pub label: String,
    pub kind: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub source: Option<String>,
    pub measured: bool,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_write: Option<u64>,
    pub cache_read: Option<u64>,
    pub cost_usd: Option<f64>,
    pub estimate: Option<CostEstimate>,
}

pub(crate) fn path_key(path: &str) -> String {
    // Windows paths must compare identically even in Linux CI; Unix remains case sensitive.
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_string();
    if normalized.as_bytes().get(1) == Some(&b':') {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// Snapshot identity while tabs exist, including recruited/custom terminals, before deletion.
pub fn capture_mission_tabs(
    conn: &Connection,
    boards: &crate::canvas::Boards,
) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT id,agent_id,COALESCE(title,agent_label),cwd,session_id,account_id,opened_at FROM tabs").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, agent, label, cwd, session, account, opened) = row.map_err(|e| e.to_string())?;
        let workspace: Option<(String, String)> = conn
            .query_row(
                "SELECT mission_id,name FROM mission_team_workspaces WHERE cwd=?1",
                [&cwd],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mission = crate::canvas::mission_of_tab(boards, &id)
            .or_else(|| workspace.as_ref().map(|w| w.0.clone()));
        let Some(mission) = mission else { continue };
        let kind = if crate::agents::find(conn, &agent).is_some() {
            "custom"
        } else if workspace.as_ref().is_some_and(|w| w.0 == mission) {
            "member"
        } else if boards.values().any(|b| b.roles.contains_key(&id)) {
            "recruit"
        } else {
            "loose"
        };
        let previous: Option<String> = conn
            .query_row(
                "SELECT session_ids FROM mission_usage_tabs WHERE mission_id=?1 AND tab_id=?2",
                rusqlite::params![mission, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut sessions: Vec<String> = previous
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if let Some(s) = session.as_ref() {
            if !sessions.contains(s) {
                sessions.push(s.clone());
            }
        }
        let sessions = serde_json::to_string(&sessions).map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO mission_usage_tabs(mission_id,tab_id,agent_id,label,kind,cwd,session_id,account_id,opened_at,session_ids) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(mission_id,tab_id) DO UPDATE SET label=excluded.label,session_id=COALESCE(excluded.session_id,mission_usage_tabs.session_id),account_id=excluded.account_id,session_ids=excluded.session_ids", rusqlite::params![mission,id,agent,label,kind,cwd,session,account,opened,sessions]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn jsonls(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            jsonls(&entry.path(), out);
        } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "jsonl") {
            out.push(entry.path());
        }
    }
}

/// Codex token_count reports cumulative totals repeatedly. Attribute only positive deltas.
fn codex_records(path: &Path, cwd: &str) -> Vec<(UsageRecord, Option<String>)> {
    let Ok(file) = File::open(path) else {
        return vec![];
    };
    let mut session = None;
    let mut model = None;
    let mut matching = false;
    let mut previous = [0u64; 3];
    let mut out = vec![];
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v["type"] == "session_meta" {
            matching = v
                .pointer("/payload/cwd")
                .and_then(|v| v.as_str())
                .is_some_and(|p| path_key(p) == path_key(cwd));
            session = v
                .pointer("/payload/id")
                .and_then(|v| v.as_str())
                .map(Arc::from);
            if !matching {
                return vec![];
            }
        }
        if v["type"] == "turn_context" {
            model = v
                .pointer("/payload/model")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
        }
        if !matching || v.pointer("/payload/type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(at) = v["timestamp"].as_str().and_then(parse_ts) else {
            continue;
        };
        let Some(usage) = v.pointer("/payload/info/total_token_usage") else {
            continue;
        };
        let Some(input) = usage["input_tokens"].as_u64() else {
            continue;
        };
        let Some(output) = usage["output_tokens"].as_u64() else {
            continue;
        };
        let current = [
            input,
            output,
            usage["cached_input_tokens"].as_u64().unwrap_or(0),
        ];
        // A reset cannot be safely interpreted as new usage. Keep the high-water mark.
        let delta = [
            current[0].saturating_sub(previous[0]),
            current[1].saturating_sub(previous[1]),
            current[2].saturating_sub(previous[2]),
        ];
        for i in 0..3 {
            previous[i] = previous[i].max(current[i]);
        }
        if delta == [0; 3] {
            continue;
        }
        out.push((
            UsageRecord {
                at,
                input: delta[0].saturating_sub(delta[2]),
                output: delta[1],
                cache_write: 0,
                cache_read: delta[2],
                session: session.clone(),
            },
            model.clone(),
        ));
    }
    out
}

pub fn mission_tokens_for_conn(
    conn: &Connection,
    mission_id: &str,
) -> Result<MissionTokens, String> {
    let mission = mission_snapshot(conn, mission_id)?;
    capture_mission_tabs(conn, &crate::canvas::load_boards())?;
    let mut stmt = conn.prepare("SELECT tab_id,agent_id,label,kind,cwd,session_id,account_id,opened_at,closed_at,session_ids FROM mission_usage_tabs WHERE mission_id=?1 ORDER BY opened_at,tab_id").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([mission_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut groups: BTreeMap<String, Vec<MissionTabTokens>> = BTreeMap::new();
    let mut owned_records = HashSet::new();
    for (id, agent, label, kind, cwd, session, account, opened, closed, sessions) in &rows {
        let mut tab = MissionTabTokens {
            tab_id: id.clone(),
            agent_id: agent.clone(),
            label: label.clone(),
            kind: kind.clone(),
            cwd: cwd.clone(),
            session_id: session.clone(),
            source: None,
            measured: false,
            input: None,
            output: None,
            cache_write: None,
            cache_read: None,
            cost_usd: None,
            estimate: None,
        };
        let start = mission.started_at.map(|s| s.max(*opened));
        let end = mission
            .ended_at
            .unwrap_or_else(crate::util::now_ts)
            .min(closed.unwrap_or(i64::MAX));
        let sessions: Vec<String> = serde_json::from_str(sessions).unwrap_or_default();
        // Cwd fallback is allowed only for a proven worktree and no competing terminal.
        let isolated = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_team_workspaces WHERE mission_id=?1 AND cwd=?2",
                rusqlite::params![mission_id, cwd],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            == 1
            && rows
                .iter()
                .filter(|r| path_key(&r.4) == path_key(cwd))
                .count()
                == 1
            && conn
                .query_row(
                    "SELECT COUNT(*) FROM tabs WHERE cwd=?1 AND id<>?2",
                    rusqlite::params![cwd, id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1)
                == 0;
        if start.is_some() && (session.is_some() || isolated) {
            let home = dirs::home_dir().unwrap_or_default();
            let profile = account
                .as_deref()
                .and_then(|a| crate::accounts::dir_for_conn(conn, a))
                .map(PathBuf::from);
            let custom = crate::agents::find(conn, agent);
            let roots = if agent == "claude-code" {
                vec![profile.unwrap_or_else(|| home.join(".claude"))]
            } else if agent == "codex" {
                vec![profile
                    .unwrap_or_else(|| home.join(".codex"))
                    .join("sessions")]
            } else if agent == "opencode" {
                let data = profile.unwrap_or_else(|| {
                    std::env::var_os("XDG_DATA_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".local/share"))
                });
                vec![data.join("opencode/opencode.db")]
            } else {
                custom
                    .as_ref()
                    .and_then(|c| c.resolved_sessions_dir())
                    .into_iter()
                    .collect()
            };
            let mut priced = vec![];
            let mut files = vec![];
            for root in roots {
                if agent == "opencode" {
                    files.push(root);
                } else if agent == "claude-code" {
                    files.extend(mission_transcripts(&root, cwd))
                } else {
                    jsonls(&root, &mut files)
                }
            }
            files.sort();
            files.dedup();
            for file in files {
                let records = if agent == "opencode" {
                    super::opencode::records(&file, cwd)
                } else if agent == "codex" {
                    codex_records(&file, cwd)
                } else {
                    let records = read_transcript_priced(&file, cwd);
                    if records.is_empty() && custom.is_some() {
                        codex_records(&file, cwd)
                    } else {
                        records
                    }
                };
                let file_identity = std::fs::canonicalize(&file).unwrap_or_else(|_| file.clone());
                priced.extend(
                    records
                        .into_iter()
                        .enumerate()
                        .filter_map(|(index, (r, model))| {
                            let matches_session = isolated
                                || session.is_none()
                                || sessions.iter().any(|s| {
                                    r.session.as_deref() == Some(s.as_str())
                                        || (r.session.is_none()
                                            && file.file_stem().is_some_and(|f| f == s.as_str()))
                                });
                            (matches_session
                                && r.at >= start.unwrap()
                                && r.at <= end
                                && owned_records.insert((file_identity.clone(), index)))
                            .then_some((r, model))
                        }),
                );
            }
            let start = start.unwrap();
            let records: Vec<_> = priced.iter().map(|(r, _)| r.clone()).collect();
            tab.measured = records.iter().any(|r| r.at >= start && r.at <= end);
            if tab.measured {
                let total = sum_usage_in_range(&records, start, end);
                tab.input = Some(total.input);
                tab.output = Some(total.output);
                tab.cache_write = Some(total.cache_write);
                tab.cache_read = Some(total.cache_read);
                tab.source = Some(
                    if session.is_some()
                        && priced.iter().all(|(r, _)| {
                            r.session
                                .as_deref()
                                .is_some_and(|s| sessions.iter().any(|known| known == s))
                        })
                    {
                        "session"
                    } else {
                        "isolated_cwd"
                    }
                    .into(),
                );
                // No known Codex prices: preserve measured tokens without inventing a charge.
                tab.estimate = Some(estimate_in_range(&priced, start, end));
            }
        }
        groups.entry(agent.clone()).or_default().push(tab);
    }
    // Headless ledger rows are already task/session scoped. Never also read their transcripts.
    let mut stmt=conn.prepare("SELECT t.id,t.agent_id,t.title,t.cwd,t.session_id,t.tokens_in,t.tokens_out,t.cost_usd,t.model FROM tasks t JOIN runs r ON r.id=t.run_id WHERE r.mission_id=?1 ORDER BY t.id").map_err(|e|e.to_string())?;
    let ledger = stmt
        .query_map([mission_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, Option<f64>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in ledger {
        let (id, agent, label, cwd, session, input, output, cost, model) =
            row.map_err(|e| e.to_string())?;
        // A task reopened as a terminal is a single session, not a second bill.
        if let Some(tab) = groups.get_mut(&agent).and_then(|tabs| {
            tabs.iter_mut()
                .find(|t| session.is_some() && t.session_id == session)
        }) {
            tab.cost_usd = cost;
            if !tab.measured && input.is_some() && output.is_some() {
                tab.measured = true;
                tab.input = input.and_then(|v| u64::try_from(v).ok());
                tab.output = output.and_then(|v| u64::try_from(v).ok());
                tab.source = Some("ledger".into());
                tab.estimate = ledger_estimate(input, output, model.as_deref());
            }
            continue;
        }
        let measured = input.is_some() && output.is_some();
        groups
            .entry(agent.clone())
            .or_default()
            .push(MissionTabTokens {
                tab_id: format!("task:{id}"),
                agent_id: agent,
                label,
                kind: "member".into(),
                cwd,
                session_id: session,
                source: (measured || cost.is_some()).then(|| "ledger".into()),
                measured,
                input: input.and_then(|v| u64::try_from(v).ok()),
                output: output.and_then(|v| u64::try_from(v).ok()),
                cache_write: None,
                cache_read: None,
                cost_usd: cost,
                estimate: ledger_estimate(input, output, model.as_deref()),
            });
    }
    Ok(aggregate_tabs(mission_id, groups))
}

fn ledger_estimate(
    input: Option<i64>,
    output: Option<i64>,
    model: Option<&str>,
) -> Option<CostEstimate> {
    let input = u64::try_from(input?).ok()?;
    let output = u64::try_from(output?).ok()?;
    let model = model.unwrap_or("unknown");
    Some(match super::pricing::price_for(model) {
        Some(p) => CostEstimate {
            cost_usd: super::pricing::cost_usd(p, input, output, 0, 0),
            saved_usd: 0.0,
            unpriced_models: vec![],
        },
        None => CostEstimate {
            cost_usd: 0.0,
            saved_usd: 0.0,
            unpriced_models: vec![model.into()],
        },
    })
}

fn aggregate_tabs(
    mission_id: &str,
    groups: BTreeMap<String, Vec<MissionTabTokens>>,
) -> MissionTokens {
    let agents = groups
        .into_iter()
        .map(|(agent_id, tabs)| {
            let rows: Vec<_> = tabs
                .iter()
                .map(|t| MissionAgentTokens {
                    agent_id: agent_id.clone(),
                    measured: t.measured,
                    input: t.input,
                    output: t.output,
                    cache_write: t.cache_write,
                    cache_read: t.cache_read,
                    cost_usd: t.cost_usd,
                    estimate: t.estimate.clone(),
                    tabs: vec![],
                })
                .collect();
            let t = total_for_agents(&rows);
            MissionAgentTokens {
                agent_id,
                measured: t.measured,
                input: t.input,
                output: t.output,
                cache_write: t.cache_write,
                cache_read: t.cache_read,
                cost_usd: t.cost_usd,
                estimate: t.estimate,
                tabs,
            }
        })
        .collect::<Vec<_>>();
    let totals = total_for_agents(&agents);
    MissionTokens {
        mission_id: mission_id.into(),
        agents,
        totals,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ags-tab-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn db() -> Connection {
        let c = crate::database::test_db();
        c.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('ws','WS',0,0);
        INSERT INTO windows(id,label,workspace_id,is_open,last_active) VALUES('w','main','ws',1,0);
        INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at,started_at,ended_at) VALUES('m','ws','M','O','/repo',0,0,1,2000000000);").unwrap();
        c
    }
    fn add_tab(c: &Connection, id: &str, agent: &str, cwd: &str, session: Option<&str>) {
        c.execute("INSERT INTO tabs(id,window_id,agent_id,agent_label,command,cwd,session_id,opened_at,created_at,last_active) VALUES(?1,'w',?2,?2,?2,?3,?4,0,0,0)",rusqlite::params![id,agent,cwd,session]).unwrap();
    }
    fn board(ids: &[&str]) -> crate::canvas::Boards {
        let mut b = crate::canvas::Board::default();
        b.nodes = serde_json::Value::Object(
            ids.iter()
                .map(|id| (id.to_string(), serde_json::json!({})))
                .collect(),
        );
        crate::canvas::Boards::from([("main|/repo#m:m".into(), b)])
    }
    #[test]
    fn closed_tabs_keep_identity_and_unknown_usage_is_null() {
        let c = db();
        add_tab(&c, "custom", "unknown", "/repo", Some("s"));
        capture_mission_tabs(&c, &board(&["custom"])).unwrap();
        c.execute("DELETE FROM tabs WHERE id='custom'", []).unwrap();
        let result = mission_tokens_for_conn(&c, "m").unwrap();
        let t = &result.agents[0].tabs[0];
        assert_eq!(t.tab_id, "custom");
        assert_eq!(t.session_id.as_deref(), Some("s"));
        assert!(!t.measured);
        assert_eq!(t.input, None);
        assert_eq!(t.estimate, None);
        assert_eq!(result.totals.input, None);
        crate::database::migrate_for_tests(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM mission_usage_tabs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn separate_sessions_same_cwd_and_reopened_session_count_once() {
        let c = db();
        let temp = Temp::new();
        let cwd = temp.0.to_string_lossy().to_string();
        let project = temp
            .0
            .join("projects")
            .join(super::super::mission::project_slug(&cwd));
        std::fs::create_dir_all(&project).unwrap();
        c.execute("INSERT INTO agent_accounts(id,agent_id,name,dir,created_at) VALUES('a','claude-code','Test',?1,0)",[temp.0.to_string_lossy().as_ref()]).unwrap();
        for (id, session, n) in [("one", "s1", 10), ("two", "s2", 20), ("reopen", "s1", 0)] {
            add_tab(&c, id, "claude-code", &cwd, Some(session));
            c.execute("UPDATE tabs SET account_id='a' WHERE id=?1", [id])
                .unwrap();
            if n > 0 {
                let line=serde_json::json!({"timestamp":"2026-08-21T20:29:09.363Z","cwd":cwd,"sessionId":session,"message":{"id":session,"model":"claude-sonnet-4-5","usage":{"input_tokens":n,"output_tokens":n*2,"cache_creation_input_tokens":0,"cache_read_input_tokens":n*3}}}).to_string();
                std::fs::write(
                    project.join(format!("{session}.jsonl")),
                    format!("{line}\n{line}\n"),
                )
                .unwrap();
            }
        }
        capture_mission_tabs(&c, &board(&["one", "two", "reopen"])).unwrap();
        let result = mission_tokens_for_conn(&c, "m").unwrap();
        let a = &result.agents[0];
        assert_eq!(a.tabs.len(), 3);
        assert_eq!(a.tabs.iter().filter(|t| t.measured).count(), 2);
        assert_eq!(a.input, Some(30));
        assert_eq!(a.output, Some(60));
        assert_eq!(a.cache_read, Some(90));
        assert_eq!(a.input, Some(a.tabs.iter().filter_map(|t| t.input).sum()));
        assert_eq!(
            a.estimate.as_ref().unwrap().cost_usd,
            a.tabs
                .iter()
                .filter_map(|t| t.estimate.as_ref())
                .map(|e| e.cost_usd)
                .sum::<f64>()
        );
        assert_eq!(result.totals.input, a.input);
        assert_eq!(result.totals.estimate, a.estimate);
        // Restarting a terminal changes session ID without losing its earlier usage.
        c.execute("UPDATE tabs SET session_id='s3' WHERE id='one'", [])
            .unwrap();
        let line=serde_json::json!({"timestamp":"2026-08-21T20:29:09.363Z","cwd":cwd,"sessionId":"s3","message":{"id":"s3","model":"claude-sonnet-4-5","usage":{"input_tokens":30,"output_tokens":60,"cache_creation_input_tokens":0,"cache_read_input_tokens":90}}}).to_string();
        std::fs::write(project.join("s3.jsonl"), format!("{line}\n")).unwrap();
        capture_mission_tabs(&c, &board(&["one", "two", "reopen"])).unwrap();
        let r = mission_tokens_for_conn(&c, "m").unwrap();
        assert_eq!(r.totals.input, Some(60));
        assert_eq!(
            r.agents[0]
                .tabs
                .iter()
                .find(|t| t.tab_id == "one")
                .unwrap()
                .input,
            Some(40)
        );
        // A later reopen of the same session owns only its later interval.
        let at = parse_ts("2026-08-21T20:29:09.363Z").unwrap();
        c.execute(
            "UPDATE mission_usage_tabs SET closed_at=?1 WHERE tab_id='one'",
            [at + 1],
        )
        .unwrap();
        c.execute(
            "UPDATE mission_usage_tabs SET opened_at=?1 WHERE tab_id='reopen'",
            [at + 2],
        )
        .unwrap();
        let later=serde_json::json!({"timestamp":"2026-08-21T20:31:09.363Z","cwd":cwd,"sessionId":"s1","message":{"id":"later","model":"claude-sonnet-4-5","usage":{"input_tokens":5,"output_tokens":10}}}).to_string();
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(project.join("s1.jsonl"))
                .unwrap(),
            "{later}"
        )
        .unwrap();
        let r = mission_tokens_for_conn(&c, "m").unwrap();
        assert_eq!(r.totals.input, Some(65));
        assert_eq!(
            r.agents[0]
                .tabs
                .iter()
                .find(|t| t.tab_id == "reopen")
                .unwrap()
                .input,
            Some(5)
        );
    }
    #[test]
    fn shared_cwd_without_session_never_assigns_usage_by_guess() {
        let c = db();
        add_tab(&c, "one", "claude-code", "/repo", None);
        add_tab(&c, "two", "claude-code", "/repo", None);
        capture_mission_tabs(&c, &board(&["one", "two"])).unwrap();
        let r = mission_tokens_for_conn(&c, "m").unwrap();
        assert!(r.agents[0]
            .tabs
            .iter()
            .all(|t| !t.measured && t.input.is_none()));
    }
    #[test]
    fn isolated_worktree_can_recover_from_missing_session_discovery() {
        let c = db();
        let temp = Temp::new();
        let cwd = temp.0.to_string_lossy().to_string();
        c.execute(
            "INSERT INTO mission_team_workspaces VALUES('m','Backend',?1,?1,'cc/test')",
            [&cwd],
        )
        .unwrap();
        c.execute("INSERT INTO agent_accounts(id,agent_id,name,dir,created_at) VALUES('a','claude-code','Test',?1,0)",[&cwd]).unwrap();
        add_tab(
            &c,
            "owned",
            "claude-code",
            &cwd,
            Some("incorrect-discovery"),
        );
        add_tab(&c, "unowned", "codex", "/repo", None);
        c.execute("UPDATE tabs SET account_id='a' WHERE id='owned'", [])
            .unwrap();
        let project = temp
            .0
            .join("projects")
            .join(super::super::mission::project_slug(&cwd));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("actual.jsonl"),serde_json::json!({"timestamp":"2026-08-21T20:29:09.363Z","cwd":cwd,"sessionId":"actual","message":{"model":"unknown-model","usage":{"input_tokens":10,"output_tokens":20}}}).to_string()).unwrap();
        let r = mission_tokens_for_conn(&c, "m").unwrap();
        let t = &r.agents[0].tabs[0];
        assert_eq!(t.source.as_deref(), Some("isolated_cwd"));
        assert_eq!(t.input, Some(10));
        assert_eq!(t.estimate.as_ref().unwrap().cost_usd, 0.0);
        assert_eq!(
            t.estimate.as_ref().unwrap().unpriced_models,
            vec!["unknown-model"]
        );
        assert_eq!(r.agents.len(), 1);
        assert_eq!(r.totals.input, Some(10));
    }
    #[test]
    fn ledger_reopened_as_tab_preserves_one_cost_and_unknown_cache() {
        let c = db();
        add_tab(&c, "terminal", "unknown", "/repo", Some("same"));
        capture_mission_tabs(&c, &board(&["terminal"])).unwrap();
        c.execute_batch("INSERT INTO runs(id,workspace_id,objective,cwd,status,created_at,mission_id) VALUES('run','ws','O','/repo','done',0,'m');
        INSERT INTO tasks(id,run_id,title,prompt,agent_id,cwd,status,created_at,session_id,tokens_in,tokens_out,cost_usd) VALUES('task','run','T','P','unknown','/repo','done',0,'same',100,200,1.5);").unwrap();
        let r = mission_tokens_for_conn(&c, "m").unwrap();
        let a = &r.agents[0];
        assert_eq!(a.tabs.len(), 1);
        assert_eq!(a.input, Some(100));
        assert_eq!(a.output, Some(200));
        assert_eq!(a.cost_usd, Some(1.5));
        assert_eq!(r.totals.cost_usd, Some(1.5));
        assert_eq!(a.cache_read, None);
        assert_eq!(a.cache_write, None);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["agents"][0]["tabs"][0]["tabId"], "terminal");
        assert_eq!(json["agents"][0]["tabs"][0]["agentId"], "unknown");
    }
    #[test]
    fn codex_cumulative_events_deduplicate_and_separate_cached_input() {
        let temp = Temp::new();
        let path = temp.0.join("s.jsonl");
        let meta =
            serde_json::json!({"type":"session_meta","payload":{"id":"s","cwd":"C:\\Work\\repo"}});
        let count = |n| serde_json::json!({"type":"event_msg","timestamp":"2026-08-21T20:29:09.363Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":n,"output_tokens":n/2,"cached_input_tokens":n/4}}}});
        std::fs::write(
            &path,
            [meta, count(100), count(100), count(120), count(90)]
                .iter()
                .map(|v| format!("{v}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let r = codex_records(&path, "c:/work/repo/");
        assert_eq!(r.len(), 2);
        let t = sum_usage_in_range(
            &r.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>(),
            0,
            i64::MAX,
        );
        assert_eq!(t.input, 90);
        assert_eq!(t.cache_read, 30);
        assert_eq!(t.output, 60);
        assert!(codex_records(&path, "/other").is_empty());
    }
}
