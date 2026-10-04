//! Consumo de Claude Code atribuible a una misión.
//!
//! Se leen solo los transcripts JSONL del proyecto (cwd) y se suman las cifras de `usage`
//! dentro del intervalo real de la misión. Para los demás agentes no hay lector de
//! transcripts: sus tokens no se deducen del ledger.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

use super::claude::{UsageRecord, parse_ts};

const USAGE_MARK: &str = "\"output_tokens\"";

/// Totais exatos que aparecem no `usage` de um transcript.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct UsageTotals {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

/// Soma os registros cujos timestamps estão dentro do intervalo fechado `[start, end]`.
/// `cache_read` continua separado e nunca é contado como entrada.
pub(crate) fn sum_usage_in_range(records: &[UsageRecord], start: i64, end: i64) -> UsageTotals {
    let mut totals = UsageTotals::default();
    for record in records {
        if record.at < start || record.at > end {
            continue;
        }
        totals.input = totals.input.saturating_add(record.input);
        totals.output = totals.output.saturating_add(record.output);
        totals.cache_write = totals.cache_write.saturating_add(record.cache_write);
        totals.cache_read = totals.cache_read.saturating_add(record.cache_read);
    }
    totals
}

/// Converte um cwd no nome de projeto que Claude Code usa em `projects/`.
/// Cada caractere fora de ASCII alfanumérico e `-` vira um hífen, sem colapsar hífens.
pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

/// Lista apenas os transcripts JSONL diretamente no projeto que corresponde ao cwd.
pub(crate) fn mission_transcripts(config_dir: &Path, cwd: &str) -> Vec<PathBuf> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let project_dir = config_dir.join("projects").join(project_slug(cwd));
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };

    let mut transcripts = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_jsonl = path
                .extension()
                .is_some_and(|extension| extension == "jsonl");
            let is_file = entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false);
            (is_jsonl && is_file).then_some(path)
        })
        .collect::<Vec<_>>();
    transcripts.sort_unstable();
    transcripts
}

#[derive(Deserialize)]
struct TranscriptLine {
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    message: Option<TranscriptMessage>,
}

#[derive(Deserialize)]
struct TranscriptMessage {
    usage: Option<TranscriptUsage>,
}

#[derive(Deserialize, Default)]
struct TranscriptUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// Lê um transcript sem falhar por linhas vazias, truncadas ou corrompidas.
/// Quando a linha declara um cwd, ela precisa corresponder ao da missão.
pub(crate) fn read_transcript_usage(path: &Path, cwd: &str) -> Vec<UsageRecord> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut records = Vec::new();

    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&bytes);
        if !line.contains(USAGE_MARK) {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<TranscriptLine>(&line) else {
            continue;
        };
        if parsed
            .cwd
            .as_deref()
            .is_some_and(|line_cwd| Path::new(line_cwd) != Path::new(cwd))
        {
            continue;
        }
        let Some(at) = parsed.timestamp.as_deref().and_then(parse_ts) else {
            continue;
        };
        let Some(usage) = parsed.message.and_then(|message| message.usage) else {
            continue;
        };
        records.push(UsageRecord {
            at,
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_write: usage.cache_creation_input_tokens,
            cache_read: usage.cache_read_input_tokens,
            session: parsed.session_id.map(Arc::from),
        });
    }
    records
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionAgentTokens {
    pub agent_id: String,
    /// True apenas quando existe ao menos uma mensagem de uso de Claude Code no intervalo.
    pub measured: bool,
    /// Ausente quando este agente não tem leitor de tokens ou não há transcript observado.
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_write: Option<u64>,
    pub cache_read: Option<u64>,
    /// Custo reportado pelo ledger; pode estar ausente mesmo para um agente conhecido.
    pub cost_usd: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTokenTotals {
    pub measured: bool,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_write: Option<u64>,
    pub cache_read: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTokens {
    pub mission_id: String,
    pub agents: Vec<MissionAgentTokens>,
    pub totals: MissionTokenTotals,
}

struct MissionSnapshot {
    cwd: String,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    lead_agent_id: Option<String>,
}

fn mission_snapshot(conn: &Connection, mission_id: &str) -> Result<MissionSnapshot, String> {
    conn.query_row(
        "SELECT cwd, started_at, ended_at, lead_agent_id FROM missions WHERE id = ?1",
        [mission_id],
        |row| {
            Ok(MissionSnapshot {
                cwd: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
                lead_agent_id: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("mission not found: {mission_id}"))
}

fn mission_agents(conn: &Connection, mission_id: &str) -> Result<BTreeSet<String>, String> {
    let mut agents = BTreeSet::new();
    let mut tasks = conn
        .prepare(
            "SELECT DISTINCT tasks.agent_id
             FROM tasks JOIN runs ON runs.id = tasks.run_id
             WHERE runs.mission_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = tasks
        .query_map([mission_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        agents.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(agents)
}

fn claude_config_dirs(conn: &Connection) -> Result<Vec<PathBuf>, String> {
    let mut dirs = dirs::home_dir()
        .map(|home| vec![home.join(".claude")])
        .unwrap_or_default();
    let mut stmt = conn
        .prepare("SELECT dir FROM agent_accounts WHERE agent_id = 'claude-code'")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        dirs.push(PathBuf::from(row.map_err(|error| error.to_string())?));
    }

    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    Ok(dirs)
}

fn mission_costs(
    conn: &Connection,
    mission_id: &str,
) -> Result<BTreeMap<String, Option<f64>>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT agent_id, SUM(cost_usd)
             FROM usage_events
             WHERE run_id IN (SELECT id FROM runs WHERE mission_id = ?1)
             GROUP BY agent_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([mission_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut costs = BTreeMap::new();
    for row in rows {
        let (agent_id, cost) = row.map_err(|error| error.to_string())?;
        costs.insert(agent_id, cost);
    }
    Ok(costs)
}

fn total_for_agents(agents: &[MissionAgentTokens]) -> MissionTokenTotals {
    let measured = agents.iter().any(|agent| agent.measured);
    let token_totals = agents.iter().filter(|agent| agent.measured).fold(
        UsageTotals::default(),
        |mut totals, agent| {
            totals.input = totals.input.saturating_add(agent.input.unwrap_or_default());
            totals.output = totals
                .output
                .saturating_add(agent.output.unwrap_or_default());
            totals.cache_write = totals
                .cache_write
                .saturating_add(agent.cache_write.unwrap_or_default());
            totals.cache_read = totals
                .cache_read
                .saturating_add(agent.cache_read.unwrap_or_default());
            totals
        },
    );
    let known_costs = agents
        .iter()
        .filter_map(|agent| agent.cost_usd)
        .collect::<Vec<_>>();
    MissionTokenTotals {
        measured,
        input: measured.then_some(token_totals.input),
        output: measured.then_some(token_totals.output),
        cache_write: measured.then_some(token_totals.cache_write),
        cache_read: measured.then_some(token_totals.cache_read),
        cost_usd: (!known_costs.is_empty()).then(|| known_costs.into_iter().sum()),
    }
}

/// Tokens medidos e custo reportado pelo ledger para uma missão.
#[tauri::command]
pub async fn mission_tokens(
    mission_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<MissionTokens, String> {
    let (mission, mut agent_ids, config_dirs, costs) = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        let mission = mission_snapshot(&conn, &mission_id)?;
        let mut agent_ids = mission_agents(&conn, &mission_id)?;
        if let Some(lead) = mission.lead_agent_id.as_ref() {
            agent_ids.insert(lead.clone());
        }
        let config_dirs = claude_config_dirs(&conn)?;
        let costs = mission_costs(&conn, &mission_id)?;
        for agent_id in costs.keys() {
            agent_ids.insert(agent_id.clone());
        }
        (mission, agent_ids, config_dirs, costs)
    };

    let end = mission.ended_at.unwrap_or_else(now_ts);
    let start = mission.started_at;
    let cwd = mission.cwd;

    tauri::async_runtime::spawn_blocking(move || {
        let mut records = Vec::new();
        if start.is_some() {
            for config_dir in &config_dirs {
                for transcript in mission_transcripts(config_dir, &cwd) {
                    records.extend(read_transcript_usage(&transcript, &cwd));
                }
            }
        }

        let totals = start
            .map(|start| sum_usage_in_range(&records, start, end))
            .unwrap_or_default();
        let measured = start.is_some_and(|start| {
            records
                .iter()
                .any(|record| record.at >= start && record.at <= end)
        });
        if measured {
            agent_ids.insert("claude-code".to_string());
        }

        let agents = agent_ids
            .into_iter()
            .map(|agent_id| {
                let is_measured = agent_id == "claude-code" && measured;
                MissionAgentTokens {
                    cost_usd: costs.get(&agent_id).copied().flatten(),
                    agent_id,
                    measured: is_measured,
                    input: is_measured.then_some(totals.input),
                    output: is_measured.then_some(totals.output),
                    cache_write: is_measured.then_some(totals.cache_write),
                    cache_read: is_measured.then_some(totals.cache_read),
                }
            })
            .collect::<Vec<_>>();
        let totals = total_for_agents(&agents);
        Ok(MissionTokens {
            mission_id,
            agents,
            totals,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
