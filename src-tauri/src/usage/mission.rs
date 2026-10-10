//! Consumo de Claude Code atribuible a una misión.
//!
//! Se leen solo los transcripts JSONL del proyecto (cwd) y se suman las cifras de `usage`
//! dentro del intervalo real de la misión. Para los demás agentes no hay lector de
//! transcripts: sus tokens no se deducen del ledger.

use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::DbConnection;

use super::claude::{parse_ts, UsageRecord};
use super::pricing;
use super::terminal::{mission_tokens_for_conn, MissionTabTokens};

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
    id: Option<String>,
    usage: Option<TranscriptUsage>,
    model: Option<String>,
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
#[cfg(test)]
pub(crate) fn read_transcript_usage(path: &Path, cwd: &str) -> Vec<UsageRecord> {
    read_transcript_priced(path, cwd)
        .into_iter()
        .map(|(record, _)| record)
        .collect()
}

/// Igual que `read_transcript_usage`, pero cada registro trae el modelo que lo generó.
pub(crate) fn read_transcript_priced(path: &Path, cwd: &str) -> Vec<(UsageRecord, Option<String>)> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut records = Vec::new();
    let mut seen = HashSet::new();

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
        if parsed.cwd.as_deref().is_some_and(|line_cwd| {
            super::terminal::path_key(line_cwd) != super::terminal::path_key(cwd)
        }) {
            continue;
        }
        let Some(at) = parsed.timestamp.as_deref().and_then(parse_ts) else {
            continue;
        };
        let Some(message) = parsed.message else {
            continue;
        };
        // Replayed transcript entries must not produce a second charge.
        if let Some(id) = message.id.as_ref() {
            if !seen.insert((parsed.session_id.clone(), id.clone())) {
                continue;
            }
        }
        let model = message.model;
        let Some(usage) = message.usage else {
            continue;
        };
        records.push((
            UsageRecord {
                at,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_write: usage.cache_creation_input_tokens,
                cache_read: usage.cache_read_input_tokens,
                session: parsed.session_id.map(Arc::from),
            },
            model,
        ));
    }
    records
}

/// Costo ESTIMADO con precio de lista y ahorro del caché, de los tokens medidos. No es un cobro.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub cost_usd: f64,
    /// Lo que se ahorró leyendo del caché en vez de pagar esos tokens como entrada normal.
    pub saved_usd: f64,
    /// Modelos que la tabla de precios no conoce: sus tokens no entran en el costo.
    pub unpriced_models: Vec<String>,
}

/// Valora los registros dentro del intervalo con la tabla de precios. Pura.
pub(crate) fn estimate_in_range(
    records: &[(UsageRecord, Option<String>)],
    start: i64,
    end: i64,
) -> CostEstimate {
    let mut out = CostEstimate::default();
    let mut unpriced = BTreeSet::new();
    for (record, model) in records {
        if record.at < start || record.at > end {
            continue;
        }
        match model.as_deref().and_then(pricing::price_for) {
            Some(price) => {
                out.cost_usd += pricing::cost_usd(
                    price,
                    record.input,
                    record.output,
                    record.cache_write,
                    record.cache_read,
                );
                out.saved_usd += pricing::cache_saved_usd(price, record.cache_read);
            }
            None => {
                if let Some(model) = model.as_deref().filter(|m| !m.contains("synthetic")) {
                    unpriced.insert(model.to_string());
                } else if model.is_none() {
                    unpriced.insert("unknown".to_string());
                }
            }
        }
    }
    out.unpriced_models = unpriced.into_iter().collect();
    out
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
    /// Estimación con precio de lista; solo donde hay tokens medidos.
    pub estimate: Option<CostEstimate>,
    pub tabs: Vec<MissionTabTokens>,
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
    pub estimate: Option<CostEstimate>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTokens {
    pub mission_id: String,
    pub agents: Vec<MissionAgentTokens>,
    pub totals: MissionTokenTotals,
}

pub(super) struct MissionSnapshot {
    pub(super) started_at: Option<i64>,
    pub(super) ended_at: Option<i64>,
}

pub(super) fn mission_snapshot(
    conn: &Connection,
    mission_id: &str,
) -> Result<MissionSnapshot, String> {
    conn.query_row(
        "SELECT started_at, ended_at FROM missions WHERE id = ?1",
        [mission_id],
        |row| {
            Ok(MissionSnapshot {
                started_at: row.get(0)?,
                ended_at: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("mission not found: {mission_id}"))
}

fn sum_estimates(agents: &[MissionAgentTokens]) -> Option<CostEstimate> {
    let mut total: Option<CostEstimate> = None;
    for estimate in agents.iter().filter_map(|a| a.estimate.as_ref()) {
        let t = total.get_or_insert_with(CostEstimate::default);
        t.cost_usd += estimate.cost_usd;
        t.saved_usd += estimate.saved_usd;
        for m in &estimate.unpriced_models {
            if !t.unpriced_models.contains(m) {
                t.unpriced_models.push(m.clone());
            }
        }
    }
    total
}

pub(super) fn total_for_agents(agents: &[MissionAgentTokens]) -> MissionTokenTotals {
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
        cache_write: agents
            .iter()
            .any(|a| a.cache_write.is_some())
            .then_some(token_totals.cache_write),
        cache_read: agents
            .iter()
            .any(|a| a.cache_read.is_some())
            .then_some(token_totals.cache_read),
        cost_usd: (!known_costs.is_empty()).then(|| known_costs.into_iter().sum()),
        estimate: sum_estimates(agents),
    }
}

/// Tokens medidos e custo reportado pelo ledger para uma missão.
#[tauri::command]
pub async fn mission_tokens(
    mission_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<MissionTokens, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        mission_tokens_for_conn(&conn, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod test {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("ags-test-{name}-{}", uuid::Uuid::new_v4()));
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
        assert_eq!(
            project_slug("/home/user/my project_v1"),
            "-home-user-my-project-v1"
        );
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
        assert_eq!(
            records.len(),
            2,
            "deve ler apenas a linha do target_cwd e a linha sem cwd"
        );

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
        assert!(
            records.is_empty(),
            "transcript vazio deve devolver Vec vazio"
        );

        let nonexistent = temp.path().join("does_not_exist.jsonl");
        let records_nonexistent = read_transcript_usage(&nonexistent, "/some/cwd");
        assert!(
            records_nonexistent.is_empty(),
            "arquivo inexistente deve devolver Vec vazio"
        );
    }

    #[test]
    fn read_transcript_usage_linha_corrompida_nao_quebra() {
        let temp = TempDir::new("read-transcript-corrupt");
        let file_path = temp.path().join("corrupted.jsonl");

        let line_before = r#"{"timestamp":"2026-08-21T20:20:00.000Z","cwd":"/cwd","sessionId":"s1","message":{"usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;
        let line_corrupted =
            r#"{"timestamp":"2026-08-21T20:21:00.000Z","output_tokens":MALFORMED_JSON"#;
        let line_after = r#"{"timestamp":"2026-08-21T20:22:00.000Z","cwd":"/cwd","sessionId":"s1","message":{"usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;

        let content = format!("{line_before}\n{line_corrupted}\n{line_after}\n");
        fs::write(&file_path, content).expect("write corrupted file");

        let records = read_transcript_usage(&file_path, "/cwd");
        assert_eq!(
            records.len(),
            2,
            "deve ignorar a linha corrompida e continuar com as linhas validas"
        );
        assert_eq!(records[0].input, 1);
        assert_eq!(records[1].input, 3);
    }
}

#[cfg(test)]
mod estimate_tests {
    use super::*;

    fn rec(
        at: i64,
        input: u64,
        output: u64,
        cache_write: u64,
        cache_read: u64,
        model: &str,
    ) -> (UsageRecord, Option<String>) {
        (
            UsageRecord {
                at,
                input,
                output,
                cache_write,
                cache_read,
                session: None,
            },
            Some(model.to_string()),
        )
    }

    #[test]
    fn estima_costo_y_ahorro_solo_dentro_del_intervalo() {
        let records = vec![
            rec(10, 1_000_000, 0, 0, 1_000_000, "claude-sonnet-4-5"),
            rec(500, 9_999_999, 9_999_999, 0, 9_999_999, "claude-sonnet-4-5"),
        ];
        let e = estimate_in_range(&records, 0, 100);
        assert!((e.cost_usd - (3.0 + 0.30)).abs() < 1e-9);
        assert!((e.saved_usd - 2.70).abs() < 1e-9);
        assert!(e.unpriced_models.is_empty());
    }

    #[test]
    fn un_modelo_desconocido_no_se_valora_pero_se_avisa() {
        let records = vec![
            rec(10, 1_000_000, 0, 0, 0, "claude-sonnet-4-5"),
            rec(11, 5_000_000, 0, 0, 5_000_000, "claude-futuro-9"),
            rec(12, 5, 5, 0, 0, "<synthetic>"),
        ];
        let e = estimate_in_range(&records, 0, 100);
        assert!((e.cost_usd - 3.0).abs() < 1e-9);
        assert_eq!(e.saved_usd, 0.0);
        assert_eq!(e.unpriced_models, vec!["claude-futuro-9".to_string()]);
    }
}
