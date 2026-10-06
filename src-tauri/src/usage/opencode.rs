//! OpenCode SQLite format verified against the installed CLI's real message rows.
use super::claude::UsageRecord;
use std::path::Path;
use std::sync::Arc;

pub(super) fn records(path: &Path, cwd: &str) -> Vec<(UsageRecord, Option<String>)> {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let _ = conn.busy_timeout(std::time::Duration::ZERO);
    let Ok(mut stmt)=conn.prepare("SELECT m.session_id,m.time_created,m.data,s.directory FROM message m JOIN session s ON s.id=m.session_id") else {return vec![]};
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    }) else {
        return vec![];
    };
    rows.flatten()
        .filter_map(|(session, at, data, directory)| {
            let v: serde_json::Value = serde_json::from_str(&data).ok()?;
            if v["role"] != "assistant" || v["time"]["completed"].as_i64().is_none() {
                return None;
            }
            let observed_cwd = v["path"]["cwd"].as_str().unwrap_or(&directory);
            if super::terminal::path_key(observed_cwd) != super::terminal::path_key(cwd) {
                return None;
            }
            let tokens = &v["tokens"];
            let input = tokens["input"].as_u64()?;
            let output = tokens["output"].as_u64()?;
            let cache_read = tokens["cache"]["read"].as_u64()?;
            let cache_write = tokens["cache"]["write"].as_u64()?;
            // A completed zero placeholder is not evidence that the CLI measured usage.
            if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
                return None;
            }
            Some((
                UsageRecord {
                    at: at / 1000,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    session: Some(Arc::from(session)),
                },
                v["modelID"].as_str().map(str::to_string),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_completed_owned_measured_messages() {
        let p = std::env::temp_dir().join(format!("ags-opencode-{}.db", uuid::Uuid::new_v4()));
        let c = rusqlite::Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('s','/repo')").unwrap();
        for (path, input) in [("/repo", 4), ("/other", 999)] {
            let data = serde_json::json!({"role":"assistant","path":{"cwd":path},"modelID":"unknown","time":{"completed":2000},"tokens":{"input":input,"output":2,"cache":{"read":3,"write":1}}});
            c.execute(
                "INSERT INTO message VALUES ('s',1000,?1)",
                [data.to_string()],
            )
            .unwrap();
        }
        drop(c);
        let r = records(&p, "/repo");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0.input, 4);
        assert_eq!(r[0].0.cache_read, 3);
        assert_eq!(r[0].0.session.as_deref(), Some("s"));
        std::fs::remove_file(p).unwrap();
    }
}
