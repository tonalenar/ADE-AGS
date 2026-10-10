//! Comparação da sombra. O texto do state não entra na tabela: só o hash.

use rusqlite::{Connection, OptionalExtension};

use crate::util::now_ts;

pub const RETAIN_DAYS: i64 = 30;
pub const RETAIN_ROWS: i64 = 50_000;
pub const DEDUPE_SECS: i64 = 3_600;

#[derive(Clone, Debug, PartialEq)]
pub struct LogRow {
    pub ts: i64,
    pub point: String,
    pub provider: String,
    pub model: String,
    pub state_hash: String,
    pub heuristic: String,
    pub provider_decision: Option<String>,
    pub probability: Option<f64>,
    pub confidence: Option<f64>,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointReport {
    pub point: String,
    pub total: i64,
    pub agreement_rate: f64,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub error_rate: f64,
    pub timeout_rate: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disagreement {
    pub point: String,
    pub state_hash: String,
    pub heuristic: String,
    pub provider_decision: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReport {
    pub generated_at: i64,
    pub points: Vec<PointReport>,
    pub disagreements: Vec<Disagreement>,
}

/// Migração aditiva. Não sobe `user_version`: o backup por VACUUM continua só quando
/// a versão do schema muda, como as outras tabelas acrescentadas em cima da v41.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS decision_shadow_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            point TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            heuristic TEXT NOT NULL,
            provider_decision TEXT,
            probability REAL,
            confidence REAL,
            latency_ms INTEGER,
            error TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_decision_shadow_log_ts ON decision_shadow_log(ts);
        CREATE INDEX IF NOT EXISTS idx_decision_shadow_log_point ON decision_shadow_log(point, state_hash, ts);",
    )
}

pub fn record(conn: &Connection, row: &LogRow) -> Result<(), String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO decision_shadow_log (ts, point, provider, model, state_hash, heuristic, provider_decision, probability, confidence, latency_ms, error, input_tokens, output_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            row.ts,
            row.point,
            row.provider,
            row.model,
            row.state_hash,
            row.heuristic,
            row.provider_decision,
            row.probability,
            row.confidence,
            row.latency_ms,
            row.error,
            row.input_tokens,
            row.output_tokens,
        ],
    )
    .map_err(|error| error.to_string())?;
    retain_with(&tx, row.ts, RETAIN_DAYS * 86_400, RETAIN_ROWS)
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn recent(conn: &Connection, point: &str, state_hash: &str, now: i64) -> Result<bool, String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM decision_shadow_log WHERE point = ?1 AND state_hash = ?2 AND ts >= ?3 LIMIT 1",
            rusqlite::params![point, state_hash, now.saturating_sub(DEDUPE_SECS)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(found.is_some())
}

pub fn retain_with(
    conn: &Connection,
    now: i64,
    max_age_secs: i64,
    max_rows: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM decision_shadow_log WHERE ts <= ?1",
        [now.saturating_sub(max_age_secs)],
    )?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |row| {
        row.get(0)
    })?;
    if count > max_rows {
        let extra = count - max_rows;
        conn.execute(
            "DELETE FROM decision_shadow_log WHERE id IN (SELECT id FROM decision_shadow_log ORDER BY ts ASC, id ASC LIMIT ?1)",
            [extra],
        )?;
    }
    Ok(())
}

pub fn report(conn: &Connection) -> Result<ShadowReport, String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare("SELECT point, heuristic, provider_decision, latency_ms, error, state_hash FROM decision_shadow_log ORDER BY ts ASC, id ASC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut points: Vec<PointReport> = Vec::new();
    for (point, heuristic, provider_decision, latency, error, hash) in &rows {
        let slot = if let Some(found) = points.iter_mut().find(|item| &item.point == point) {
            found
        } else {
            points.push(PointReport {
                point: point.clone(),
                total: 0,
                agreement_rate: 0.0,
                p50_ms: None,
                p95_ms: None,
                error_rate: 0.0,
                timeout_rate: 0.0,
            });
            points.last_mut().expect("acabou de entrar")
        };
        slot.total += 1;
        let _ = (heuristic, provider_decision, latency, error, hash);
    }
    for slot in &mut points {
        let mine: Vec<_> = rows.iter().filter(|row| row.0 == slot.point).collect();
        let errors = mine.iter().filter(|row| row.4.is_some()).count();
        let timeouts = mine
            .iter()
            .filter(|row| {
                row.4
                    .as_deref()
                    .is_some_and(|error| error == "timeout" || error.starts_with("timeout"))
            })
            .count();
        let compared: Vec<_> = mine.iter().filter(|row| row.4.is_none()).collect();
        let agreed = compared
            .iter()
            .filter(|row| row.2.as_deref() == Some(row.1.as_str()))
            .count();
        slot.agreement_rate = if compared.is_empty() {
            0.0
        } else {
            agreed as f64 / compared.len() as f64
        };
        slot.error_rate = if slot.total == 0 {
            0.0
        } else {
            errors as f64 / slot.total as f64
        };
        slot.timeout_rate = if slot.total == 0 {
            0.0
        } else {
            timeouts as f64 / slot.total as f64
        };
        let mut latencies: Vec<i64> = mine.iter().filter_map(|row| row.3).collect();
        latencies.sort_unstable();
        slot.p50_ms = percentile(&latencies, 0.50);
        slot.p95_ms = percentile(&latencies, 0.95);
    }
    points.sort_by(|a, b| a.point.cmp(&b.point));

    let mut disagreements = Vec::new();
    for (point, heuristic, provider_decision, _, error, hash) in rows.into_iter().rev() {
        if error.is_some() {
            continue;
        }
        let Some(provider_decision) = provider_decision else {
            continue;
        };
        if provider_decision == heuristic {
            continue;
        }
        disagreements.push(Disagreement {
            point,
            state_hash: hash,
            heuristic,
            provider_decision,
        });
        if disagreements.len() == 50 {
            break;
        }
    }
    Ok(ShadowReport {
        generated_at: now_ts(),
        points,
        disagreements,
    })
}

pub fn export_csv(conn: &Connection) -> Result<String, String> {
    let report = report(conn)?;
    let mut csv =
        String::from("tipo,ponto,total,concordancia,p50_ms,p95_ms,taxa_erro,taxa_timeout\n");
    for point in &report.points {
        csv.push_str(&format!(
            "resumo,{},{},{:.4},{},{},{:.4},{:.4}\n",
            cell(&point.point),
            point.total,
            point.agreement_rate,
            point
                .p50_ms
                .map(|value| value.to_string())
                .unwrap_or_default(),
            point
                .p95_ms
                .map(|value| value.to_string())
                .unwrap_or_default(),
            point.error_rate,
            point.timeout_rate,
        ));
    }
    csv.push_str("tipo,ponto,state_hash,heuristica,provedor\n");
    for row in &report.disagreements {
        csv.push_str(&format!(
            "discordancia,{},{},{},{}\n",
            cell(&row.point),
            cell(&row.state_hash),
            cell(&row.heuristic),
            cell(&row.provider_decision),
        ));
    }
    Ok(csv)
}

/// Posto mais próximo: o índice é `ceil(p * n) - 1`.
fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted.get(index).copied()
}

fn cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}
