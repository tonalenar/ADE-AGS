//! Read-only structured plan limits. No TUI scraping, login, API requests or credentials.
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    pub label: String,
    pub used_pct: Option<f64>,
    pub resets_at: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub provider: String,
    pub account_id: Option<String>,
    pub measured: bool,
    pub windows: Vec<PlanWindow>,
    pub observed_at: Option<i64>,
}

fn files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(t) = e.file_type() else { continue };
        if crate::skills::is_mount(&e.path()) || t.is_symlink() {
            continue;
        }
        if t.is_dir() {
            files(&e.path(), out)
        } else if e.path().extension().is_some_and(|s| s == "jsonl") {
            out.push(e.path())
        }
    }
}

pub fn parse_windows(rate: &serde_json::Value, now: i64) -> Vec<PlanWindow> {
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| {
            let v = &rate[key];
            let used = v["used_percent"]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 100.0)?;
            let minutes = v["window_minutes"].as_u64()?;
            let reset = v["resets_at"].as_i64()?;
            if reset <= now {
                return None;
            }
            let label = match minutes {
                10080 => "weekly".into(),
                300 => "5h".into(),
                n => format!("{n}m"),
            };
            let resets_at = chrono::DateTime::from_timestamp(reset, 0).map(|d| d.to_rfc3339());
            Some(PlanWindow {
                label,
                used_pct: Some(used),
                resets_at,
            })
        })
        .collect()
}

fn codex(root: &Path, account: Option<String>) -> PlanLimits {
    let mut list = vec![];
    files(&root.join("sessions"), &mut list);
    list.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let mut latest: Option<(i64, serde_json::Value)> = None;
    for path in list.into_iter().rev().take(32) {
        let Ok(f) = std::fs::File::open(path) else {
            continue;
        };
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            if !line.contains("rate_limits") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" {
                continue;
            }
            let Some(at) = v["timestamp"].as_str().and_then(super::claude::parse_ts) else {
                continue;
            };
            let rate = &v["payload"]["rate_limits"];
            // Model-specific quotas cannot be relabelled as the user's Codex plan.
            if rate["limit_id"].as_str().is_some_and(|id| id != "codex") || rate.is_null() {
                continue;
            }
            if latest.as_ref().is_none_or(|(old, _)| at > *old) {
                latest = Some((at, rate.clone()))
            }
        }
    }
    let windows = latest
        .as_ref()
        .map(|(_, v)| parse_windows(v, crate::util::now_ts()))
        .unwrap_or_default();
    PlanLimits {
        provider: "codex".into(),
        account_id: account,
        measured: !windows.is_empty(),
        windows,
        observed_at: latest.map(|(at, _)| at),
    }
}

pub fn for_conn(conn: &rusqlite::Connection) -> Result<Vec<PlanLimits>, String> {
    let home = dirs::home_dir().ok_or("Home indisponível")?;
    let mut out = vec![
        PlanLimits {
            provider: "claude".into(),
            account_id: None,
            measured: false,
            windows: vec![],
            observed_at: None,
        },
        codex(&home.join(".codex"), None),
    ];
    let mut stmt = conn
        .prepare(
            "SELECT id,agent_id,dir FROM agent_accounts WHERE agent_id IN ('claude-code','codex')",
        )
        .map_err(|e| e.to_string())?;
    for row in stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (id, agent, dir) = row.map_err(|e| e.to_string())?;
        out.push(if agent == "codex" {
            codex(Path::new(&dir), Some(id))
        } else {
            PlanLimits {
                provider: "claude".into(),
                account_id: Some(id),
                measured: false,
                windows: vec![],
                observed_at: None,
            }
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn plan_limits(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<Vec<PlanLimits>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move|| {
        let c=db.lock().map_err(|e|e.to_string())?;
        super::capture_mission_tabs(&c,&crate::canvas::load_boards())?;
        let limits=for_conn(&c)?;
        for limit in &limits {
            let agent=if limit.provider=="codex" {"codex"} else {"claude-code"};
            for window in limit.windows.iter().filter(|w|w.used_pct.is_some_and(|p|p>=80.0)) {
                let mut stmt=c.prepare("SELECT DISTINCT u.mission_id FROM mission_usage_tabs u JOIN missions m ON m.id=u.mission_id JOIN tabs t ON t.id=u.tab_id WHERE u.agent_id=?1 AND u.account_id IS ?2 AND m.status NOT IN ('done','cancelled','failed')").map_err(|e|e.to_string())?;
                for row in stmt.query_map(rusqlite::params![agent,limit.account_id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())? {
                    let mission=row.map_err(|e|e.to_string())?;
                    let key=format!("mission.plan.warning.{mission}.{agent}.{:?}.{}.{:?}",limit.account_id,window.label,window.resets_at);
                    if c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES (?1,'1')",[key]).map_err(|e|e.to_string())?>0 {
                        super::warn_lead(&app,&mission,&format!("[AGS] {agent}: janela {} a {:.0}% do limite do plano (conta {:?}).",window.label,window.used_pct.unwrap_or(0.0),limit.account_id));
                    }
                }
            }
        }
        Ok(limits)
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structured_limits_expire_and_invalid_values_are_unknown() {
        let v = serde_json::json!({"primary":{"used_percent":80,"window_minutes":300,"resets_at":200},"secondary":{"used_percent":95,"window_minutes":10080,"resets_at":300}});
        let w = parse_windows(&v, 100);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1].label, "weekly");
        assert_eq!(w[0].used_pct, Some(80.0));
        assert_eq!(parse_windows(&v, 200).len(), 1);
        assert!(parse_windows(&v, 300).is_empty());
        assert!(
            parse_windows(&serde_json::json!({"primary":{"used_percent":999}}), 100).is_empty()
        );
    }
}
