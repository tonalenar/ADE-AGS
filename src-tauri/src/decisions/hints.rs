//! O que o Jev achou de cada proposta de memória, para a tela "Sugestões de memória" MOSTRAR (nunca aprovar).
//!
//! Só lê `decision_shadow_log`: a consulta ao provedor já foi feita em segundo plano quando a revisão
//! abriu. Aqui não há chamada de rede. A pessoa continua clicando em Aprovar/Rejeitar.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::log;
use super::points::{memory_state_hash, POINT_MEMORY};

/// Uma proposta como a tela a conhece. `operation` é a da revisão (`create`, `update`, `delete`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HintInput {
    pub key: String,
    pub kind: String,
    pub operation: String,
    pub body: String,
}

/// A resposta do provedor para uma proposta. `action` é `aprovar`, `rejeitar` ou `revisar`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub index: usize,
    pub provider: String,
    pub action: String,
    pub secret: Option<bool>,
    pub confidence: Option<f64>,
}

/// `acao=aprovar;segredo=nao` → ("aprovar", Some(false)). Pura.
pub(super) fn parse_answer(canonical: &str) -> (Option<String>, Option<bool>) {
    let mut action = None;
    let mut secret = None;
    for pair in canonical.split(';') {
        match pair.split_once('=') {
            Some(("acao", value)) if matches!(value, "aprovar" | "rejeitar" | "revisar") => action = Some(value.to_string()),
            Some(("segredo", value)) => secret = Some(value == "sim"),
            _ => {}
        }
    }
    (action, secret)
}

/// A última resposta SEM erro de um provedor para esta proposta. O Jev tem preferência; se só outro
/// provedor respondeu, vale o dele. A revisão de uma missão rotula a operação como `proposta`, a do
/// workspace usa a da revisão: procura as duas. Pura sobre a conexão.
pub fn memory_hints(conn: &Connection, items: &[HintInput]) -> Result<Vec<Hint>, String> {
    log::migrate(conn).map_err(|e| e.to_string())?;
    let mut hints = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let hashes = [
            memory_state_hash(&item.key, &item.kind, "proposta", &item.body),
            memory_state_hash(&item.key, &item.kind, &item.operation, &item.body),
        ];
        let mut best: Option<(String, String, Option<f64>)> = None;
        for hash in hashes {
            let row: Option<(String, String, Option<f64>)> = conn
                .query_row(
                    "SELECT provider, provider_decision, confidence FROM decision_shadow_log \
                     WHERE point = ?1 AND state_hash = ?2 AND error IS NULL AND provider_decision IS NOT NULL \
                     ORDER BY (provider = 'jev') DESC, ts DESC LIMIT 1",
                    params![POINT_MEMORY, hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(found) = row {
                best = Some(found);
                break;
            }
        }
        if let Some((provider, decision, confidence)) = best {
            let (action, secret) = parse_answer(&decision);
            if let Some(action) = action {
                hints.push(Hint { index, provider, action, secret, confidence });
            }
        }
    }
    Ok(hints)
}

#[tauri::command]
pub fn decision_memory_hints(
    db: tauri::State<crate::database::DbConnection>,
    items: Vec<HintInput>,
) -> Result<Vec<Hint>, String> {
    let conn = db.lock().map_err(|_| "o banco de dados não está disponível".to_string())?;
    memory_hints(&conn, &items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decisions::log::{record, LogRow};

    fn put(conn: &Connection, provider: &str, hash: &str, decision: Option<&str>, error: Option<&str>, ts: i64, confidence: Option<f64>) {
        record(
            conn,
            &LogRow {
                ts,
                point: POINT_MEMORY.into(),
                provider: provider.into(),
                model: "m".into(),
                state_hash: hash.into(),
                heuristic: "acao=revisar;segredo=nao".into(),
                provider_decision: decision.map(str::to_string),
                probability: None,
                confidence,
                latency_ms: Some(10),
                error: error.map(str::to_string),
                input_tokens: Some(1),
                output_tokens: Some(0),
            },
        )
        .unwrap();
    }

    fn item(key: &str, operation: &str) -> HintInput {
        HintInput { key: key.into(), kind: "note".into(), operation: operation.into(), body: "corpo".into() }
    }

    #[test]
    fn le_a_resposta_ignora_erro_e_prefere_o_jev() {
        let conn = Connection::open_in_memory().unwrap();
        log::migrate(&conn).unwrap();
        let hash = memory_state_hash("k1", "note", "proposta", "corpo");
        put(&conn, "laya_local", &hash, Some("acao=rejeitar;segredo=sim"), None, 100, None);
        put(&conn, "jev", &hash, Some("acao=aprovar;segredo=nao"), None, 90, Some(0.93));
        put(&conn, "jev", &hash, None, Some("timeout"), 200, None);
        let hints = memory_hints(&conn, &[item("k1", "create")]).unwrap();
        assert_eq!(hints, vec![Hint { index: 0, provider: "jev".into(), action: "aprovar".into(), secret: Some(false), confidence: Some(0.93) }]);
    }

    #[test]
    fn acha_pela_operacao_da_revisao_e_nao_inventa_o_que_nao_foi_consultado() {
        let conn = Connection::open_in_memory().unwrap();
        log::migrate(&conn).unwrap();
        let hash = memory_state_hash("k2", "note", "update", "corpo");
        put(&conn, "jev", &hash, Some("acao=revisar;segredo=nao"), None, 100, None);
        let hints = memory_hints(&conn, &[item("k1", "create"), item("k2", "update")]).unwrap();
        assert_eq!(hints.len(), 1);
        assert_eq!((hints[0].index, hints[0].action.as_str()), (1, "revisar"));
    }

    #[test]
    fn resposta_fora_do_vocabulario_nao_vira_dica() {
        assert_eq!(parse_answer("acao=explodir;segredo=nao"), (None, Some(false)));
        assert_eq!(parse_answer("lixo"), (None, None));
    }
}
