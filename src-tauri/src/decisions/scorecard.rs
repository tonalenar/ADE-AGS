//! Gabarito da limpeza para medir o Jev.
//!
//! Quando a pessoa apaga memórias pelo diálogo de limpeza, isso é uma rejeição humana da proposta
//! (o corpo que existia antes da exclusão). Essa decisão vai para `decision_human_log` com o ponto
//! `CLEANUP_POINT`: não há coluna de origem, então o ponto é o rótulo. Assim ela não se mistura com
//! as aprovações e rejeições da tela normal (que usam `POINT_MEMORY`). Só hashes são guardados.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::hints::parse_answer;
use super::log;
use super::points::{memory_state_hash, POINT_MEMORY};
use crate::database::DbConnection;

/// Ponto da decisão humana que veio da limpeza. É o rótulo de origem `limpeza`.
pub const CLEANUP_POINT: &str = "memory_approval:limpeza";
const APPROVE: &str = "aprovar";
const REJECT: &str = "rejeitar";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Missed {
    /// Hash do texto da proposta. O texto e a chave não saem daqui.
    pub state_hash: String,
    /// `aprovar` ou `revisar`; `None` quando o Jev não respondeu.
    pub jev_action: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scorecard {
    /// Propostas que a limpeza rotulou como rejeitadas (uma vez por hash).
    pub labeled: u32,
    /// Rótulos que têm resposta válida do Jev.
    pub answered: u32,
    pub jev_reject: u32,
    pub jev_approve: u32,
    pub jev_review: u32,
    /// Respostas do Jev (entre as rotuladas) que marcaram segredo.
    pub secret_flagged: u32,
    /// Rótulos em que o Jev não disse `rejeitar`: aprovou, pediu revisão ou não respondeu.
    pub missed: Vec<Missed>,
    /// jevReject / answered.
    pub reject_recall: Option<f64>,
    /// Propostas que a pessoa aprovou na tela normal (sem origem limpeza).
    pub approved_by_human: u32,
    /// Entre essas, as que o Jev rejeitaria.
    pub jev_rejected_those_approved: u32,
    /// jevRejectedThoseApproved / approvedByHuman.
    pub false_alarm_rate: Option<f64>,
}

/// Grava a rejeição humana de uma proposta pela limpeza (`corpo` ANTES da exclusão). Idempotente:
/// devolve `false` quando a mesma rejeição já estava gravada.
pub(crate) fn record_cleanup_rejection(conn: &Connection, key: &str, kind: &str, body: &str) -> Result<bool, String> {
    log::migrate(conn).map_err(|error| error.to_string())?;
    let hash = memory_state_hash(key, kind, "proposta", body);
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM decision_human_log WHERE point = ?1 AND state_hash = ?2 AND decision = ?3 LIMIT 1",
            params![CLEANUP_POINT, hash, REJECT],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_some() {
        return Ok(false);
    }
    log::record_human(conn, CLEANUP_POINT, &hash, REJECT)?;
    Ok(true)
}

/// A resposta mais recente e válida do Jev para UMA proposta de memória, que pode ter mais de um hash (a mesma
/// proposta é consultada e decidida sob `proposta` e sob a operação da revisão).
fn latest_jev(conn: &Connection, hashes: &[String]) -> Result<Option<(String, Option<bool>)>, String> {
    let mut best: Option<(i64, i64, String)> = None;
    for hash in hashes {
        let row: Option<(i64, i64, String)> = conn
            .query_row(
                "SELECT ts, id, provider_decision FROM decision_shadow_log \
                 WHERE point = ?1 AND state_hash = ?2 AND provider = 'jev' AND error IS NULL AND provider_decision IS NOT NULL \
                 ORDER BY ts DESC, id DESC LIMIT 1",
                params![POINT_MEMORY, hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(found) = row {
            if best.as_ref().is_none_or(|current| (found.0, found.1) > (current.0, current.1)) {
                best = Some(found);
            }
        }
    }
    Ok(best.and_then(|(_, _, canonical)| {
        let (action, secret) = parse_answer(&canonical);
        action.map(|action| (action, secret))
    }))
}

/// Agrupa os hashes por proposta: cada revisão guardada tem dois (`proposta` e a operação dela). Um hash que
/// não bate com nenhuma revisão (a entrada foi expurgada) fica sozinho. Devolve hash → os hashes da proposta.
fn proposal_groups(conn: &Connection) -> BTreeMap<String, Vec<String>> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT e.key, r.kind, r.operation, r.body FROM memory_revisions r JOIN memory_entries e ON e.id = r.entry_id",
    ) else {
        return groups;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    }) else {
        return groups;
    };
    for (key, kind, operation, body) in rows.flatten() {
        let mut hashes = vec![memory_state_hash(&key, &kind, "proposta", &body)];
        let own = memory_state_hash(&key, &kind, &operation, &body);
        if own != hashes[0] {
            hashes.push(own);
        }
        for hash in &hashes {
            groups.insert(hash.clone(), hashes.clone());
        }
    }
    groups
}

fn group_of(groups: &BTreeMap<String, Vec<String>>, hash: &str) -> Vec<String> {
    groups.get(hash).cloned().unwrap_or_else(|| vec![hash.to_string()])
}

fn human_hashes(conn: &Connection, point: &str, decision: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT state_hash FROM decision_human_log WHERE point = ?1 AND decision = ?2 ORDER BY state_hash")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![point, decision], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

/// Aprovações da tela normal: a ÚLTIMA decisão de cada hash em `POINT_MEMORY` é `aprovar`.
fn human_approved(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT state_hash, decision FROM decision_human_log WHERE point = ?1 ORDER BY ts ASC, id ASC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![POINT_MEMORY], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    for (hash, decision) in rows {
        last.insert(hash, decision);
    }
    Ok(last
        .into_iter()
        .filter(|(_, decision)| decision == APPROVE)
        .map(|(hash, _)| hash)
        .collect())
}

fn ratio(part: u32, whole: u32) -> Option<f64> {
    (whole > 0).then(|| part as f64 / whole as f64)
}

/// Cruza o gabarito da limpeza com o que o Jev respondeu. Não grava nada.
pub fn scorecard(conn: &Connection) -> Result<Scorecard, String> {
    log::migrate(conn).map_err(|error| error.to_string())?;
    let mut card = Scorecard {
        labeled: 0,
        answered: 0,
        jev_reject: 0,
        jev_approve: 0,
        jev_review: 0,
        secret_flagged: 0,
        missed: Vec::new(),
        reject_recall: None,
        approved_by_human: 0,
        jev_rejected_those_approved: 0,
        false_alarm_rate: None,
    };
    let groups = proposal_groups(conn);
    // Uma proposta conta uma vez, qualquer que seja o hash sob o qual foi rotulada ou decidida.
    let mut labeled_groups: BTreeSet<String> = BTreeSet::new();
    let mut labeled: Vec<Vec<String>> = Vec::new();
    for hash in human_hashes(conn, CLEANUP_POINT, REJECT)? {
        let group = group_of(&groups, &hash);
        if labeled_groups.insert(group[0].clone()) {
            labeled.push(group);
        }
    }
    for group in &labeled {
        let hash = group[0].clone();
        card.labeled += 1;
        let Some((action, secret)) = latest_jev(conn, group)? else {
            card.missed.push(Missed { state_hash: hash, jev_action: None });
            continue;
        };
        card.answered += 1;
        if secret == Some(true) {
            card.secret_flagged += 1;
        }
        match action.as_str() {
            REJECT => card.jev_reject += 1,
            APPROVE => {
                card.jev_approve += 1;
                card.missed.push(Missed { state_hash: hash, jev_action: Some(action) });
            }
            _ => {
                card.jev_review += 1;
                card.missed.push(Missed { state_hash: hash, jev_action: Some(action) });
            }
        }
    }
    card.reject_recall = ratio(card.jev_reject, card.answered);

    // Aprovações da tela normal, uma por proposta; o que a pessoa depois apagou na limpeza não é mais aprovação.
    let mut approved_groups: BTreeSet<String> = BTreeSet::new();
    for hash in human_approved(conn)? {
        let group = group_of(&groups, &hash);
        if labeled_groups.contains(&group[0]) || !approved_groups.insert(group[0].clone()) {
            continue;
        }
        card.approved_by_human += 1;
        if matches!(latest_jev(conn, &group)?, Some((action, _)) if action == REJECT) {
            card.jev_rejected_those_approved += 1;
        }
    }
    card.false_alarm_rate = ratio(card.jev_rejected_those_approved, card.approved_by_human);
    Ok(card)
}

#[tauri::command]
pub fn decision_jev_scorecard(db: tauri::State<DbConnection>) -> Result<Scorecard, String> {
    let conn = db.lock().map_err(|_| "o banco de dados não está disponível".to_string())?;
    scorecard(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_db;
    use crate::decisions::log::{record, LogRow};

    fn jev(conn: &Connection, key: &str, body: &str, provider: &str, decision: Option<&str>, error: Option<&str>) {
        record(
            conn,
            &LogRow {
                ts: 100,
                point: POINT_MEMORY.into(),
                provider: provider.into(),
                model: "m".into(),
                state_hash: memory_state_hash(key, "note", "proposta", body),
                heuristic: "acao=revisar;segredo=nao".into(),
                provider_decision: decision.map(str::to_string),
                probability: None,
                confidence: None,
                latency_ms: Some(1),
                error: error.map(str::to_string),
                input_tokens: None,
                output_tokens: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn rotulo_da_limpeza_grava_uma_vez_e_nao_vira_aprovacao() {
        let conn = test_db();
        assert!(record_cleanup_rejection(&conn, "k", "note", "corpo").unwrap());
        assert!(!record_cleanup_rejection(&conn, "k", "note", "corpo").unwrap());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM decision_human_log WHERE point = ?1", [CLEANUP_POINT], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert!(human_approved(&conn).unwrap().is_empty());
    }

    #[test]
    fn scorecard_cruza_o_gabarito_com_o_jev() {
        let conn = test_db();
        // Gabarito da limpeza: 4 propostas apagadas.
        for (key, body) in [("k1", "c1"), ("k2", "c2"), ("k3", "c3"), ("k4", "c4")] {
            record_cleanup_rejection(&conn, key, "note", body).unwrap();
        }
        jev(&conn, "k1", "c1", "jev", Some("acao=rejeitar;segredo=nao"), None);
        jev(&conn, "k2", "c2", "jev", Some("acao=aprovar;segredo=nao"), None);
        jev(&conn, "k3", "c3", "jev", Some("acao=revisar;segredo=sim"), None);
        // k4: o Jev deu erro, e outro provedor rejeitou: nenhum dos dois conta.
        jev(&conn, "k4", "c4", "jev", None, Some("timeout"));
        jev(&conn, "k4", "c4", "laya_local", Some("acao=rejeitar;segredo=nao"), None);
        // Aprovações da tela normal: a1 o Jev rejeitaria, a2 ele aprovaria, a3 não foi consultado.
        for (key, body) in [("a1", "x1"), ("a2", "x2"), ("a3", "x3")] {
            log::record_human(&conn, POINT_MEMORY, &memory_state_hash(key, "note", "proposta", body), APPROVE).unwrap();
        }
        jev(&conn, "a1", "x1", "jev", Some("acao=rejeitar;segredo=nao"), None);
        jev(&conn, "a2", "x2", "jev", Some("acao=aprovar;segredo=nao"), None);

        let card = scorecard(&conn).unwrap();
        assert_eq!(card.labeled, 4);
        assert_eq!(card.answered, 3);
        assert_eq!((card.jev_reject, card.jev_approve, card.jev_review), (1, 1, 1));
        assert_eq!(card.secret_flagged, 1);
        assert_eq!(card.missed.len(), 3);
        assert_eq!(card.missed.iter().filter(|m| m.jev_action.is_none()).count(), 1);
        assert!((card.reject_recall.unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(card.approved_by_human, 3);
        assert_eq!(card.jev_rejected_those_approved, 1);
        assert!((card.false_alarm_rate.unwrap() - 1.0 / 3.0).abs() < 1e-9);

        // Só chaves e contagens: nenhum texto de corpo aparece na resposta.
        let json = serde_json::to_string(&card).unwrap();
        assert!(!json.contains("\"c1\"") && !json.contains("\"x1\"") && !json.contains("\"k1\""));
        assert!(json.contains("\"jevReject\":1") && json.contains("\"falseAlarmRate\""));
    }

    #[test]
    fn a_mesma_proposta_sob_dois_hashes_conta_uma_vez_e_o_apagado_deixa_de_ser_aprovacao() {
        use crate::memory::{decide, propose, ProposalActor, ProposalInput};
        let conn = test_db();
        conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w1','W1',0,0);").unwrap();
        let add = |key: &str, body: &str| {
            let input = ProposalInput {
                scope: "workspace".into(), key: key.into(), kind: "note".into(), body: body.into(), priority: 0,
                operation: "create".into(), expected_revision: None, source_fact_id: None, reason: None, acknowledge_secret: false,
            };
            let actor = ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None };
            let made = propose(&conn, "workspace", "w1", None, &input, actor).unwrap();
            decide(&conn, &made.entry_id, made.revision, true).unwrap();
        };
        add("lixo", "ok");
        add("boa", "A regra do projeto é X");
        // A tela aprovou as duas sob DOIS hashes cada (proposta + create).
        for (key, body) in [("lixo", "ok"), ("boa", "A regra do projeto é X")] {
            for op in ["proposta", "create"] {
                log::record_human(&conn, POINT_MEMORY, &memory_state_hash(key, "note", op, body), APPROVE).unwrap();
            }
        }
        let row = |key: &str, body: &str, op: &str, decision: &str| {
            record(&conn, &LogRow {
                ts: 100, point: POINT_MEMORY.into(), provider: "jev".into(), model: "m".into(),
                state_hash: memory_state_hash(key, "note", op, body), heuristic: "acao=revisar;segredo=nao".into(),
                provider_decision: Some(decision.into()), probability: None, confidence: None, latency_ms: Some(1),
                error: None, input_tokens: None, output_tokens: None,
            }).unwrap();
        };
        // O Jev respondeu à "lixo" sob o hash create; o rótulo da limpeza só tem o hash proposta.
        row("lixo", "ok", "create", "acao=rejeitar;segredo=nao");
        row("boa", "A regra do projeto é X", "proposta", "acao=aprovar;segredo=nao");
        record_cleanup_rejection(&conn, "lixo", "note", "ok").unwrap();

        let card = scorecard(&conn).unwrap();
        assert_eq!((card.labeled, card.answered, card.jev_reject), (1, 1, 1), "o rótulo acha a resposta do Jev sob o outro hash");
        // Só a "boa" segue aprovada, contada uma vez (não duas), e o Jev não a rejeitaria.
        assert_eq!((card.approved_by_human, card.jev_rejected_those_approved), (1, 0));
        assert_eq!(card.false_alarm_rate, Some(0.0));
    }

    #[test]
    fn sem_dados_devolve_zeros_e_none() {
        let conn = test_db();
        let card = scorecard(&conn).unwrap();
        assert_eq!(card, Scorecard {
            labeled: 0,
            answered: 0,
            jev_reject: 0,
            jev_approve: 0,
            jev_review: 0,
            secret_flagged: 0,
            missed: Vec::new(),
            reject_recall: None,
            approved_by_human: 0,
            jev_rejected_those_approved: 0,
            false_alarm_rate: None,
        });
    }

    #[test]
    fn rotulo_sem_resposta_do_jev_conta_mas_nao_responde() {
        let conn = test_db();
        record_cleanup_rejection(&conn, "solo", "note", "corpo").unwrap();
        let card = scorecard(&conn).unwrap();
        assert_eq!((card.labeled, card.answered), (1, 0));
        assert_eq!(card.reject_recall, None);
        assert_eq!(card.missed, vec![Missed { state_hash: memory_state_hash("solo", "note", "proposta", "corpo"), jev_action: None }]);
    }
}
