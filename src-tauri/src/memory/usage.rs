//! Registro de uso da memória: quem leu o quê, e quais memórias nunca foram lidas.
//!
//! Sem isto não há como saber se os agentes usam a memória. Cada injeção do índice, busca,
//! abertura de página e leitura do índice vira uma linha em `memory_usage`. Gravar nunca falha a
//! chamada original: um erro vira só `eprintln!`.
//!
//! O relatório (`report`) lê essas linhas e as memórias ativas. "Nunca lida" quer dizer: a chave
//! não aparece em nenhuma busca nem abertura no período.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::database::DbConnection;

const QUERY_CHARS: usize = 200;
const ENTRY_KEYS_MAX: usize = 40;
const RETAIN_PER_WORKSPACE: i64 = 5000;
const TOP_READ_LIMIT: usize = 10;
const MISSIONS_LIMIT: usize = 20;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS memory_usage(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    mission_id TEXT,
    tab_id TEXT,
    action TEXT NOT NULL CHECK(action IN ('injected','search','open','index')),
    query TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    entry_keys TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_memory_usage_workspace_ts ON memory_usage(workspace_id, ts);";

/// Uma leitura a ser registrada. `tab_id` é quem leu: a aba do agente, ou a tarefa quando a
/// leitura veio pela orquestração de runs.
pub struct UsageRow<'a> {
    pub ts: i64,
    pub workspace_id: &'a str,
    pub mission_id: Option<&'a str>,
    pub tab_id: Option<&'a str>,
    pub action: &'a str,
    pub query: Option<&'a str>,
    pub hits: u32,
    pub entry_keys: &'a [String],
}

/// Segundos Unix agora.
pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Registra uma leitura. Nunca falha: qualquer erro só vai para o log.
pub fn record(conn: &Connection, row: &UsageRow) {
    if let Err(error) = try_record(conn, row) {
        eprintln!("[memory] não foi possível registrar o uso da memória: {error}");
    }
}

fn try_record(conn: &Connection, row: &UsageRow) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    let query: Option<String> = row.query.map(|q| q.chars().take(QUERY_CHARS).collect());
    let entry_keys = row.entry_keys.iter().take(ENTRY_KEYS_MAX).cloned().collect::<Vec<_>>().join("\n");
    conn.execute(
        "INSERT INTO memory_usage(ts,workspace_id,mission_id,tab_id,action,query,hits,entry_keys) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![row.ts, row.workspace_id, row.mission_id, row.tab_id, row.action, query, row.hits, entry_keys],
    )?;
    conn.execute(
        "DELETE FROM memory_usage WHERE workspace_id=?1 AND id NOT IN (SELECT id FROM memory_usage WHERE workspace_id=?1 ORDER BY id DESC LIMIT ?2)",
        params![row.workspace_id, RETAIN_PER_WORKSPACE],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub total: u32,
    pub injected: u32,
    pub searches: u32,
    pub searches_with_hits: u32,
    pub opens: u32,
    pub index_reads: u32,
    pub distinct_agents: u32,
    pub top_read: Vec<KeyCount>,
    pub never_read: u32,
    pub active_entries: u32,
    pub missions: Vec<MissionUsage>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyCount {
    pub key: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionUsage {
    pub mission_id: String,
    pub title: String,
    pub injected: u32,
    pub searches: u32,
    pub opens: u32,
    pub hits_total: u32,
}

struct Stored {
    ts: i64,
    action: String,
    tab_id: Option<String>,
    mission_id: Option<String>,
    hits: u32,
    entry_keys: String,
}

/// O relatório do workspace. `since_ts` limita às leituras a partir desse instante; `None` é
/// tudo que há.
pub fn report(conn: &Connection, workspace_id: &str, since_ts: Option<i64>) -> Result<UsageReport, String> {
    let read_err = |e: rusqlite::Error| format!("não foi possível ler o uso da memória: {e}");
    conn.execute_batch(SCHEMA).map_err(read_err)?;
    let since = since_ts.unwrap_or(i64::MIN);
    let stored: Vec<Stored> = {
        let mut stmt = conn
            .prepare("SELECT ts,action,tab_id,mission_id,hits,entry_keys FROM memory_usage WHERE workspace_id=?1 AND ts>=?2")
            .map_err(read_err)?;
        let rows = stmt
            .query_map(params![workspace_id, since], |r| {
                Ok(Stored {
                    ts: r.get(0)?,
                    action: r.get(1)?,
                    tab_id: r.get(2)?,
                    mission_id: r.get(3)?,
                    hits: r.get::<_, i64>(4)?.max(0) as u32,
                    entry_keys: r.get(5)?,
                })
            })
            .map_err(read_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(read_err)?
    };

    let mut report = UsageReport::default();
    let mut agents: HashSet<String> = HashSet::new();
    let mut reads: HashMap<String, u32> = HashMap::new();
    let mut missions: HashMap<String, (i64, MissionUsage)> = HashMap::new();
    for row in &stored {
        report.total += 1;
        match row.action.as_str() {
            "injected" => report.injected += 1,
            "search" => {
                report.searches += 1;
                if row.hits > 0 {
                    report.searches_with_hits += 1;
                }
            }
            "open" => report.opens += 1,
            "index" => report.index_reads += 1,
            _ => {}
        }
        if matches!(row.action.as_str(), "search" | "open" | "index") {
            if let Some(tab) = &row.tab_id {
                agents.insert(tab.clone());
            }
        }
        if matches!(row.action.as_str(), "search" | "open") {
            for key in row.entry_keys.split('\n').filter(|k| !k.is_empty()) {
                *reads.entry(key.to_string()).or_default() += 1;
            }
        }
        if let Some(mission) = &row.mission_id {
            let (last, usage) = missions.entry(mission.clone()).or_insert_with(|| {
                (
                    i64::MIN,
                    MissionUsage {
                        mission_id: mission.clone(),
                        title: String::new(),
                        injected: 0,
                        searches: 0,
                        opens: 0,
                        hits_total: 0,
                    },
                )
            });
            match row.action.as_str() {
                "injected" => usage.injected += 1,
                "search" => usage.searches += 1,
                "open" => usage.opens += 1,
                _ => {}
            }
            usage.hits_total += row.hits;
            *last = (*last).max(row.ts);
        }
    }
    report.distinct_agents = agents.len() as u32;

    let mut top: Vec<KeyCount> = reads.iter().map(|(key, count)| KeyCount { key: key.clone(), count: *count }).collect();
    top.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    top.truncate(TOP_READ_LIMIT);
    report.top_read = top;

    let active: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT key FROM memory_entries WHERE workspace_id=?1 AND status='active'")
            .map_err(read_err)?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0)).map_err(read_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(read_err)?
    };
    report.active_entries = active.len() as u32;
    report.never_read = active.iter().filter(|key| !reads.contains_key(key.as_str())).count() as u32;

    let titles: HashMap<String, String> = {
        let mut stmt = conn
            .prepare("SELECT id,title FROM missions WHERE workspace_id=?1")
            .map_err(read_err)?;
        let rows = stmt
            .query_map(params![workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(read_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(read_err)?
    };
    let mut ordered: Vec<(i64, MissionUsage)> = missions.into_values().collect();
    ordered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.mission_id.cmp(&b.1.mission_id)));
    report.missions = ordered
        .into_iter()
        .take(MISSIONS_LIMIT)
        .map(|(_, mut usage)| {
            usage.title = titles.get(&usage.mission_id).cloned().unwrap_or_default();
            usage
        })
        .collect();
    Ok(report)
}

/// `memory_usage_report`: o relatório de uso do workspace, para a interface.
#[tauri::command]
pub fn memory_usage_report(workspace_id: String, since_ts: Option<i64>, db: tauri::State<DbConnection>) -> Result<UsageReport, String> {
    let conn = db.lock().map_err(|_| "database unavailable")?;
    super::validate_owner(&conn, "workspace", &workspace_id, None)?;
    report(&conn, &workspace_id, since_ts)
}

#[cfg(test)]
mod test {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_entries(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL);
             CREATE TABLE missions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn row<'a>(ts: i64, action: &'a str, mission: Option<&'a str>, tab: Option<&'a str>, hits: u32, keys: &'a [String]) -> UsageRow<'a> {
        UsageRow { ts, workspace_id: "w1", mission_id: mission, tab_id: tab, action, query: None, hits, entry_keys: keys }
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn registra_e_aplica_retencao_por_workspace() {
        let conn = setup();
        let empty: Vec<String> = Vec::new();
        for i in 0..(RETAIN_PER_WORKSPACE + 5) {
            let query = format!("q{i}");
            record(
                &conn,
                &UsageRow { query: Some(query.as_str()), ..row(i, "search", None, Some("t1"), 1, &empty) },
            );
        }
        // Outro workspace não empurra as linhas do w1 para fora.
        record(&conn, &UsageRow { workspace_id: "w2", ..row(1, "index", None, None, 0, &empty) });
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_usage WHERE workspace_id='w1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, RETAIN_PER_WORKSPACE);
        let oldest: String = conn.query_row("SELECT query FROM memory_usage WHERE workspace_id='w1' ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(oldest, "q5", "as cinco primeiras saíram");
    }

    #[test]
    fn query_e_chaves_sao_limitadas() {
        let conn = setup();
        let long = "x".repeat(300);
        let many: Vec<String> = (0..50).map(|i| format!("k{i}")).collect();
        record(&conn, &UsageRow { query: Some(long.as_str()), ..row(1, "search", None, None, 0, &many) });
        let (query, stored): (String, String) = conn
            .query_row("SELECT query,entry_keys FROM memory_usage", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(query.chars().count(), QUERY_CHARS);
        assert_eq!(stored.split('\n').count(), ENTRY_KEYS_MAX);
    }

    #[test]
    fn record_nao_derruba_a_chamada_quando_a_gravacao_falha() {
        let conn = Connection::open_in_memory().unwrap();
        let empty: Vec<String> = Vec::new();
        // Ação fora do CHECK: a inserção falha, e o registro só loga.
        record(&conn, &row(1, "bogus", None, None, 0, &empty));
        // Sem memory_entries nem missions, gravar uma leitura ainda funciona.
        record(&conn, &row(2, "open", None, Some("t1"), 1, &keys(&["a"])));
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_usage", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn report_conta_as_leituras_e_os_agentes() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO memory_entries VALUES('ea','w1','a','active'),('eb','w1','b','active'),('ec','w1','c','active'),('ed','w1','d','deleted');
             INSERT INTO missions VALUES('m1','w1','Missão um');",
        )
        .unwrap();
        let ab = keys(&["a", "b"]);
        let none: Vec<String> = Vec::new();
        record(&conn, &row(10, "injected", Some("m1"), None, 3, &none));
        record(&conn, &row(11, "search", Some("m1"), Some("t1"), 2, &ab));
        record(&conn, &row(12, "search", Some("m1"), Some("t2"), 0, &none));
        record(&conn, &row(13, "open", Some("m1"), Some("t2"), 1, &keys(&["b"])));
        record(&conn, &row(14, "index", None, Some("t3"), 2, &none));

        let r = report(&conn, "w1", None).unwrap();
        assert_eq!(r.total, 5);
        assert_eq!(r.injected, 1);
        assert_eq!(r.searches, 2);
        assert_eq!(r.searches_with_hits, 1);
        assert_eq!(r.opens, 1);
        assert_eq!(r.index_reads, 1);
        assert_eq!(r.distinct_agents, 3);
        assert_eq!(r.active_entries, 3, "a memória apagada não conta");
        assert_eq!(r.never_read, 1, "só 'c' nunca foi lida");
        assert_eq!(
            r.missions,
            vec![MissionUsage { mission_id: "m1".into(), title: "Missão um".into(), injected: 1, searches: 2, opens: 1, hits_total: 6 }]
        );
    }

    #[test]
    fn report_ordena_os_mais_lidos_e_respeita_since() {
        let conn = setup();
        conn.execute_batch("INSERT INTO memory_entries VALUES('ea','w1','a','active'),('eb','w1','b','active');").unwrap();
        record(&conn, &row(100, "search", None, Some("t1"), 1, &keys(&["a"])));
        record(&conn, &row(200, "search", None, Some("t1"), 1, &keys(&["b", "a"])));
        record(&conn, &row(300, "open", None, Some("t2"), 1, &keys(&["b"])));

        let all = report(&conn, "w1", None).unwrap();
        // Empate de contagem: ordem alfabética.
        assert_eq!(
            all.top_read,
            vec![KeyCount { key: "a".into(), count: 2 }, KeyCount { key: "b".into(), count: 2 }]
        );
        assert_eq!(all.never_read, 0);

        let recent = report(&conn, "w1", Some(150)).unwrap();
        assert_eq!(recent.total, 2);
        assert_eq!(recent.top_read, vec![KeyCount { key: "b".into(), count: 2 }, KeyCount { key: "a".into(), count: 1 }]);
    }

    #[test]
    fn relatorio_sem_nenhuma_leitura_marca_todas_como_nunca_lidas() {
        let conn = setup();
        conn.execute_batch("INSERT INTO memory_entries VALUES('ea','w1','a','active');").unwrap();
        let r = report(&conn, "w1", None).unwrap();
        assert_eq!(r.total, 0);
        assert_eq!(r.never_read, 1);
        assert!(r.top_read.is_empty() && r.missions.is_empty());
    }
}
