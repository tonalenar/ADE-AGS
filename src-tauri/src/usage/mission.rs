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

#[cfg(test)]
mod test {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("ags-test-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sum_usage_in_range_fronteiras_exatas() {
        let records = vec![
            UsageRecord {
                at: 99, // imediatamente antes do início: excluído
                input: 1,
                output: 1,
                cache_write: 1,
                cache_read: 1,
                session: None,
            },
            UsageRecord {
                at: 100, // fronteira exata de início: incluído
                input: 10,
                output: 20,
                cache_write: 30,
                cache_read: 40,
                session: None,
            },
            UsageRecord {
                at: 150, // meio do intervalo: incluído
                input: 100,
                output: 200,
                cache_write: 300,
                cache_read: 400,
                session: None,
            },
            UsageRecord {
                at: 200, // fronteira exata de fim: incluído
                input: 1000,
                output: 2000,
                cache_write: 3000,
                cache_read: 4000,
                session: None,
            },
            UsageRecord {
                at: 201, // imediatamente depois do fim: excluído
                input: 10000,
                output: 20000,
                cache_write: 30000,
                cache_read: 40000,
                session: None,
            },
        ];

        let totals = sum_usage_in_range(&records, 100, 200);
        assert_eq!(totals.input, 10 + 100 + 1000);
        assert_eq!(totals.output, 20 + 200 + 2000);
        assert_eq!(totals.cache_write, 30 + 300 + 3000);
        assert_eq!(totals.cache_read, 40 + 400 + 4000);
    }

    #[test]
    fn sum_usage_in_range_vazio_devolve_zeros() {
        let totals = sum_usage_in_range(&[], 100, 200);
        assert_eq!(totals, UsageTotals::default());
        assert_eq!(totals.input, 0);
        assert_eq!(totals.output, 0);
        assert_eq!(totals.cache_write, 0);
        assert_eq!(totals.cache_read, 0);
    }

    #[test]
    fn sum_usage_cache_read_nunca_soma_em_entrada() {
        let records = vec![UsageRecord {
            at: 150,
            input: 10,
            output: 5,
            cache_write: 20,
            cache_read: 80_000,
            session: None,
        }];

        let totals = sum_usage_in_range(&records, 100, 200);
        assert_eq!(totals.input, 10, "cache_read nunca pode somar em input");
        assert_eq!(totals.cache_read, 80_000);
        assert_eq!(totals.cache_write, 20);
        assert_eq!(totals.output, 5);
    }

    #[test]
    fn project_slug_substitui_caracteres_especiais_e_separadores() {
        // Caminho Windows com barras invertidas e dois-pontos
        assert_eq!(project_slug(r"C:\Users\x\proj"), "C--Users-x-proj");
        // Caminho Linux
        assert_eq!(project_slug("/home/x/proj"), "-home-x-proj");
        // Caminho com espaços, underline e hífens já existentes (não colapsa)
        assert_eq!(project_slug("/home/user/my project_v1"), "-home-user-my-project-v1");
        assert_eq!(project_slug("/a--b"), "-a--b");
    }

    #[test]
    fn mission_transcripts_lista_somente_jsonl_e_ignora_pasta_inexistente() {
        let temp = TempDir::new("mission-transcripts");
        let root = temp.path();

        let cwd = "/home/x/proj";
        let slug = project_slug(cwd);
        let project_dir = root.join("projects").join(slug);
        fs::create_dir_all(&project_dir).expect("create project dir");

        let f1 = project_dir.join("a-session.jsonl");
        let f2 = project_dir.join("b-session.jsonl");
        let f3 = project_dir.join("notes.txt");
        let sub = project_dir.join("nested.jsonl");
        fs::write(&f1, "{}").expect("write f1");
        fs::write(&f2, "{}").expect("write f2");
        fs::write(&f3, "note").expect("write f3");
        fs::create_dir(&sub).expect("create subdir");

        let found = mission_transcripts(root, cwd);
        assert_eq!(found, vec![f1, f2]);

        // Pasta de projeto inexistente devolve vazio sem erro
        let empty = mission_transcripts(root, "/nonexistent/path");
        assert!(empty.is_empty());

        // Cwd vazio devolve vazio
        let empty_cwd = mission_transcripts(root, "");
        assert!(empty_cwd.is_empty());
    }

    #[test]
    fn read_transcript_usage_ignora_linha_sem_usage_ou_de_outro_cwd() {
        let temp = TempDir::new("read-transcript-usage");
        let file_path = temp.path().join("session.jsonl");

        let target_cwd = "/home/x/proj";

        // Linha 1: válida para target_cwd
        let line_valid = r#"{"timestamp":"2026-08-21T20:29:09.363Z","cwd":"/home/x/proj","sessionId":"s1","message":{"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}}}"#;
        // Linha 2: usage válido porém de OUTRO cwd -> ignorada
        let line_other_cwd = r#"{"timestamp":"2026-08-21T20:30:00.000Z","cwd":"/home/x/other","sessionId":"s2","message":{"usage":{"input_tokens":50,"output_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}}}"#;
        // Linha 3: mensagem de usuário sem usage (sem marca output_tokens) -> ignorada
        let line_no_usage = r#"{"timestamp":"2026-08-21T20:31:00.000Z","cwd":"/home/x/proj","sessionId":"s1","type":"user","message":{"content":"hello"}}"#;
        // Linha 4: linha com output_tokens no texto porém sem estrutura de usage -> ignorada
        let line_fake_tokens = r#"{"timestamp":"2026-08-21T20:32:00.000Z","cwd":"/home/x/proj","message":{"content":"mentions output_tokens text"}}"#;
        // Linha 5: usage válido sem campo cwd -> aceita
        let line_no_cwd_field = r#"{"timestamp":"2026-08-21T20:33:00.000Z","sessionId":"s1","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":20,"cache_read_input_tokens":10}}}"#;

        let content = format!("{line_valid}\n{line_other_cwd}\n{line_no_usage}\n{line_fake_tokens}\n{line_no_cwd_field}\n");
        fs::write(&file_path, content).expect("write file");

        let records = read_transcript_usage(&file_path, target_cwd);
        assert_eq!(records.len(), 2, "deve ler apenas a linha do target_cwd e a linha sem cwd");

        assert_eq!(records[0].at, parse_ts("2026-08-21T20:29:09.363Z").unwrap());
        assert_eq!(records[0].input, 10);
        assert_eq!(records[0].output, 5);
        assert_eq!(records[0].cache_write, 2);
        assert_eq!(records[0].cache_read, 1);
        assert_eq!(records[0].session.as_deref(), Some("s1"));

        assert_eq!(records[1].at, parse_ts("2026-08-21T20:33:00.000Z").unwrap());
        assert_eq!(records[1].input, 100);
        assert_eq!(records[1].output, 50);
        assert_eq!(records[1].cache_write, 20);
        assert_eq!(records[1].cache_read, 10);
    }

    #[test]
    fn read_transcript_usage_arquivo_vazio_ou_inexistente() {
        let temp = TempDir::new("read-transcript-empty");
        let empty_path = temp.path().join("empty.jsonl");
        fs::write(&empty_path, "").expect("write empty file");

        let records = read_transcript_usage(&empty_path, "/some/cwd");
        assert!(records.is_empty(), "transcript vazio deve devolver Vec vazio");

        let nonexistent = temp.path().join("does_not_exist.jsonl");
        let records_nonexistent = read_transcript_usage(&nonexistent, "/some/cwd");
        assert!(records_nonexistent.is_empty(), "arquivo inexistente deve devolver Vec vazio");
    }

    #[test]
    fn read_transcript_usage_linha_corrompida_nao_quebra() {
        let temp = TempDir::new("read-transcript-corrupt");
        let file_path = temp.path().join("corrupted.jsonl");

        let line_before = r#"{"timestamp":"2026-08-21T20:20:00.000Z","cwd":"/cwd","sessionId":"s1","message":{"usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;
        let line_corrupted = r#"{"timestamp":"2026-08-21T20:21:00.000Z","output_tokens":MALFORMED_JSON"#;
        let line_after = r#"{"timestamp":"2026-08-21T20:22:00.000Z","cwd":"/cwd","sessionId":"s1","message":{"usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;

        let content = format!("{line_before}\n{line_corrupted}\n{line_after}\n");
        fs::write(&file_path, content).expect("write corrupted file");

        let records = read_transcript_usage(&file_path, "/cwd");
        assert_eq!(records.len(), 2, "deve ignorar a linha corrompida e continuar com as linhas validas");
        assert_eq!(records[0].input, 1);
        assert_eq!(records[1].input, 3);
    }
}
