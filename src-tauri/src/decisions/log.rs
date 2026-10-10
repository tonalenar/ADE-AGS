//! Comparação da sombra. O texto do state não entra na tabela: só o hash.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};

use crate::util::now_ts;

use super::points::blind_labels;

pub const RETAIN_DAYS: i64 = 30;
pub const RETAIN_ROWS: i64 = 50_000;
pub const DEDUPE_SECS: i64 = 3_600;
/// Abaixo disso, a concordância de um ponto ainda não diz nada.
pub const MIN_SAMPLE: i64 = 30;
const MAX_PAIRS: usize = 12;

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
    pub provider: String,
    pub total: i64,
    /// Respostas sem erro: o denominador da concordância.
    pub compared: i64,
    pub low_sample: bool,
    pub agreement_rate: f64,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub error_rate: f64,
    pub timeout_rate: f64,
    pub questions: Vec<QuestionReport>,
}

/// O que a heurística escolheu e o que o provedor escolheu, contados (`count` vezes).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCount {
    pub heuristic: String,
    pub provider: String,
    pub count: i64,
}

/// A concordância de uma pergunta, separada das outras do mesmo ponto. `blind_rate` é a
/// parcela em que o provedor escolheu um rótulo que a heurística daquele ponto nunca devolve:
/// ali o "desacordo" é informação nova, não erro.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionReport {
    pub question: String,
    pub compared: i64,
    pub agreement_rate: f64,
    pub blind_rate: f64,
    pub blind_labels: Vec<String>,
    pub pairs: Vec<PairCount>,
}

/// Quem chegou mais perto da decisão da pessoa. `correct`: disse o mesmo (aprovar ou rejeitar);
/// `wrong`: disse o contrário; `abstained`: pediu revisão, que não é nem um nem outro.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Judged {
    pub provider: String,
    pub decided: i64,
    pub correct: i64,
    pub wrong: i64,
    pub abstained: i64,
}

/// Dois provedores diante das mesmas propostas. Nos `pairs` de cada pergunta, `heuristic` é o
/// que o provedor A disse e `provider` o que o B disse.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub point: String,
    pub provider_a: String,
    pub provider_b: String,
    pub compared: i64,
    pub agreement_rate: f64,
    pub questions: Vec<QuestionReport>,
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
    pub min_sample: i64,
    pub points: Vec<PointReport>,
    pub comparisons: Vec<Comparison>,
    /// Cada provedor (e a heurística do app) contra a decisão da pessoa nas propostas de memória.
    pub judged: Vec<Judged>,
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
        CREATE INDEX IF NOT EXISTS idx_decision_shadow_log_point ON decision_shadow_log(point, state_hash, ts);
        CREATE TABLE IF NOT EXISTS decision_human_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            point TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            decision TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decision_human_log_hash ON decision_human_log(point, state_hash);",
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

/// A decisão que a PESSOA tomou numa proposta (`aprovar` ou `rejeitar`), pelo hash do texto, sem o
/// texto: é a referência para dizer quem acertou. Guarda 30 dias, como o resto.
pub fn record_human(conn: &Connection, point: &str, state_hash: &str, decision: &str) -> Result<(), String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let now = now_ts();
    conn.execute(
        "INSERT INTO decision_human_log (ts, point, state_hash, decision) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![now, point, state_hash, decision],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM decision_human_log WHERE ts <= ?1",
        [now.saturating_sub(RETAIN_DAYS * 86_400)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn recent(
    conn: &Connection,
    point: &str,
    state_hash: &str,
    provider: &str,
    now: i64,
) -> Result<bool, String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM decision_shadow_log WHERE point = ?1 AND state_hash = ?2 AND provider = ?3 AND ts >= ?4 LIMIT 1",
            rusqlite::params![point, state_hash, provider, now.saturating_sub(DEDUPE_SECS)],
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

struct Row {
    point: String,
    provider: String,
    heuristic: String,
    provider_decision: Option<String>,
    latency_ms: Option<i64>,
    error: Option<String>,
    state_hash: String,
}

pub fn report(conn: &Connection) -> Result<ShadowReport, String> {
    migrate(conn).map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare("SELECT point, heuristic, provider_decision, latency_ms, error, state_hash, provider FROM decision_shadow_log ORDER BY ts ASC, id ASC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Row {
                point: row.get(0)?,
                heuristic: row.get(1)?,
                provider_decision: row.get(2)?,
                latency_ms: row.get(3)?,
                error: row.get(4)?,
                state_hash: row.get(5)?,
                provider: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut by_point: BTreeMap<(&str, &str), Vec<&Row>> = BTreeMap::new();
    for row in &rows {
        by_point
            .entry((row.point.as_str(), row.provider.as_str()))
            .or_default()
            .push(row);
    }
    let points = by_point
        .into_iter()
        .map(|((point, provider), mine)| point_report(point, provider, &mine))
        .collect();
    let comparisons = comparisons(&rows);
    let judged = judged(&rows, &human_decisions(conn)?);

    let mut disagreements = Vec::new();
    for row in rows.iter().rev() {
        if row.error.is_some() {
            continue;
        }
        let Some(provider_decision) = &row.provider_decision else {
            continue;
        };
        if *provider_decision == row.heuristic {
            continue;
        }
        disagreements.push(Disagreement {
            point: row.point.clone(),
            state_hash: row.state_hash.clone(),
            heuristic: row.heuristic.clone(),
            provider_decision: provider_decision.clone(),
        });
        if disagreements.len() == 50 {
            break;
        }
    }
    Ok(ShadowReport {
        generated_at: now_ts(),
        min_sample: MIN_SAMPLE,
        points,
        comparisons,
        judged,
        disagreements,
    })
}

/// A última decisão da pessoa por (ponto, hash).
fn human_decisions(conn: &Connection) -> Result<BTreeMap<(String, String), String>, String> {
    let mut stmt = conn
        .prepare("SELECT point, state_hash, decision FROM decision_human_log ORDER BY ts ASC, id ASC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(((row.get::<_, String>(0)?, row.get::<_, String>(1)?), row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows.into_iter().collect())
}

/// Confronta o `acao` de cada provedor (e o da heurística, contado uma vez por proposta) com o que a
/// pessoa decidiu. Só as propostas que ela decidiu e que o provedor respondeu sem erro. Pura.
fn judged(rows: &[Row], human: &BTreeMap<(String, String), String>) -> Vec<Judged> {
    let mut tallies: BTreeMap<String, Judged> = BTreeMap::new();
    let mut heuristic_seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    let mut tally = |provider: &str, label: Option<&str>, decision: &str| {
        let slot = tallies.entry(provider.to_string()).or_insert_with(|| Judged {
            provider: provider.to_string(),
            decided: 0,
            correct: 0,
            wrong: 0,
            abstained: 0,
        });
        slot.decided += 1;
        match label {
            Some(label @ ("aprovar" | "rejeitar")) if label == decision => slot.correct += 1,
            Some("aprovar" | "rejeitar") => slot.wrong += 1,
            _ => slot.abstained += 1,
        }
    };
    for row in rows
        .iter()
        .filter(|row| row.error.is_none() && row.point == super::points::POINT_MEMORY)
    {
        let Some(decision) = human.get(&(row.point.clone(), row.state_hash.clone())) else {
            continue;
        };
        if let Some(provider_decision) = row.provider_decision.as_deref() {
            tally(&row.provider, answers(provider_decision).get("acao").copied(), decision);
        }
        if heuristic_seen.insert(row.state_hash.as_str()) {
            tally("heuristic", answers(&row.heuristic).get("acao").copied(), decision);
        }
    }
    tallies.into_values().collect()
}

fn rate(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

fn point_report(point: &str, provider: &str, mine: &[&Row]) -> PointReport {
    let errors = mine.iter().filter(|row| row.error.is_some()).count();
    let timeouts = mine
        .iter()
        .filter(|row| {
            row.error
                .as_deref()
                .is_some_and(|error| error.starts_with("timeout"))
        })
        .count();
    let compared: Vec<&Row> = mine
        .iter()
        .copied()
        .filter(|row| row.error.is_none())
        .collect();
    let agreed = compared
        .iter()
        .filter(|row| row.provider_decision.as_deref() == Some(row.heuristic.as_str()))
        .count();
    let mut latencies: Vec<i64> = mine.iter().filter_map(|row| row.latency_ms).collect();
    latencies.sort_unstable();
    PointReport {
        point: point.to_string(),
        provider: provider.to_string(),
        total: mine.len() as i64,
        compared: compared.len() as i64,
        low_sample: (compared.len() as i64) < MIN_SAMPLE,
        agreement_rate: rate(agreed, compared.len()),
        p50_ms: percentile(&latencies, 0.50),
        p95_ms: percentile(&latencies, 0.95),
        error_rate: rate(errors, mine.len()),
        timeout_rate: rate(timeouts, mine.len()),
        questions: question_reports(point, &compared),
    }
}

/// `acao=revisar;segredo=nao` vira `{acao: revisar, segredo: nao}`.
fn answers(canonical: &str) -> BTreeMap<&str, &str> {
    canonical
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .collect()
}

fn question_reports(point: &str, compared: &[&Row]) -> Vec<QuestionReport> {
    let pairs: Vec<(String, String)> = compared
        .iter()
        .map(|row| (row.heuristic.clone(), row.provider_decision.clone().unwrap_or_default()))
        .collect();
    tally_questions(point, &pairs)
}

/// Concordância por pergunta de uma lista de pares (esquerda, direita) em texto canônico. Com a
/// heurística à esquerda e o provedor à direita (`point` dá os rótulos que a heurística não diz),
/// ou, na comparação, um provedor contra o outro (`point` vazio).
fn tally_questions(point: &str, pairs: &[(String, String)]) -> Vec<QuestionReport> {
    #[derive(Default)]
    struct Tally {
        compared: i64,
        agreed: i64,
        blind: i64,
        pairs: BTreeMap<(String, String), i64>,
    }
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    for (left, right) in pairs {
        let right = answers(right);
        for (question, left_label) in answers(left) {
            let chosen = right.get(question).copied().unwrap_or("-");
            let tally = tallies.entry(question.to_string()).or_default();
            tally.compared += 1;
            if chosen == left_label {
                tally.agreed += 1;
            }
            if blind_labels(point, question)
                .iter()
                .any(|label| *label == chosen)
            {
                tally.blind += 1;
            }
            *tally
                .pairs
                .entry((left_label.to_string(), chosen.to_string()))
                .or_default() += 1;
        }
    }
    tallies
        .into_iter()
        .map(|(question, tally)| {
            let mut pairs: Vec<PairCount> = tally
                .pairs
                .into_iter()
                .map(|((heuristic, provider), count)| PairCount {
                    heuristic,
                    provider,
                    count,
                })
                .collect();
            pairs.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then_with(|| a.heuristic.cmp(&b.heuristic))
                    .then_with(|| a.provider.cmp(&b.provider))
            });
            pairs.truncate(MAX_PAIRS);
            let whole = tally.compared as f64;
            QuestionReport {
                blind_labels: blind_labels(point, &question)
                    .iter()
                    .map(|label| label.to_string())
                    .collect(),
                question,
                compared: tally.compared,
                agreement_rate: tally.agreed as f64 / whole,
                blind_rate: tally.blind as f64 / whole,
                pairs,
            }
        })
        .collect()
}

/// Dois provedores respondendo a MESMA proposta (mesmo ponto e mesmo hash do texto): quantas vezes
/// decidiram igual e, por pergunta, o que um disse contra o que o outro disse. Em cada par, o
/// `heuristic` dos contadores é o provedor A e o `provider` é o B. Pura.
fn comparisons(rows: &[Row]) -> Vec<Comparison> {
    // ponto -> hash -> provedor -> última decisão sem erro
    let mut seen: BTreeMap<&str, BTreeMap<&str, BTreeMap<&str, &str>>> = BTreeMap::new();
    for row in rows.iter().filter(|row| row.error.is_none()) {
        if let Some(decision) = row.provider_decision.as_deref() {
            seen.entry(row.point.as_str())
                .or_default()
                .entry(row.state_hash.as_str())
                .or_default()
                .insert(row.provider.as_str(), decision);
        }
    }
    let mut out = Vec::new();
    for (point, hashes) in seen {
        let mut by_pair: BTreeMap<(&str, &str), Vec<(String, String)>> = BTreeMap::new();
        for providers in hashes.values().filter(|providers| providers.len() >= 2) {
            let mut it = providers.iter();
            if let (Some((a, left)), Some((b, right))) = (it.next(), it.next()) {
                by_pair
                    .entry((*a, *b))
                    .or_default()
                    .push((left.to_string(), right.to_string()));
            }
        }
        for ((a, b), pairs) in by_pair {
            let agreed = pairs.iter().filter(|(left, right)| left == right).count();
            out.push(Comparison {
                point: point.to_string(),
                provider_a: a.to_string(),
                provider_b: b.to_string(),
                compared: pairs.len() as i64,
                agreement_rate: rate(agreed, pairs.len()),
                questions: tally_questions("", &pairs),
            });
        }
    }
    out
}

pub fn export_csv(conn: &Connection) -> Result<String, String> {
    let report = report(conn)?;
    let mut csv = String::from(
        "tipo,ponto,provedor,total,concordancia,p50_ms,p95_ms,taxa_erro,taxa_timeout,comparadas,amostra_pequena\n",
    );
    for point in &report.points {
        csv.push_str(&format!(
            "resumo,{},{},{},{:.4},{},{},{:.4},{:.4},{},{}\n",
            cell(&point.point),
            cell(&point.provider),
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
            point.compared,
            point.low_sample,
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
    csv.push_str("tipo,ponto,pergunta,heuristica,provedor,contagem\n");
    for point in &report.points {
        for question in &point.questions {
            for pair in &question.pairs {
                csv.push_str(&format!(
                    "par,{},{},{},{},{},{}\n",
                    cell(&point.point),
                    cell(&question.question),
                    cell(&pair.heuristic),
                    cell(&pair.provider),
                    pair.count,
                    cell(&point.provider),
                ));
            }
        }
    }
    csv.push_str("tipo,ponto,provedor_a,provedor_b,comparadas,concordancia\n");
    for comparison in &report.comparisons {
        csv.push_str(&format!(
            "comparacao,{},{},{},{},{:.4}\n",
            cell(&comparison.point),
            cell(&comparison.provider_a),
            cell(&comparison.provider_b),
            comparison.compared,
            comparison.agreement_rate,
        ));
    }
    csv.push_str("tipo,provedor,decididas,acertou,errou,absteve\n");
    for judged in &report.judged {
        csv.push_str(&format!(
            "juiz,{},{},{},{},{}\n",
            cell(&judged.provider),
            judged.decided,
            judged.correct,
            judged.wrong,
            judged.abstained,
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
