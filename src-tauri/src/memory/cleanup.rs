//! Limpeza da memória aprovada de um workspace.
//!
//! `memory_cleanup_candidates` só lê: aponta duplicatas, chaves de teste e o que o Jev rejeitaria.
//! `memory_cleanup_apply` apaga as entradas que a pessoa escolheu pelo MESMO caminho da tela:
//! uma proposta de exclusão feita pelo usuário (`propose` com `operation=delete` e `expectedRevision`
//! igual à revisão corrente) aprovada em seguida (`decide_and_schedule`). A entrada vira tombstone e o
//! histórico de revisões continua. Nada aqui apaga fisicamente.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::repo_sync::{self, RepoSync};
use super::{ProposalActor, ProposalInput};
use crate::database::DbConnection;
use crate::decisions::hints::{memory_hints, HintInput};

/// Limite de ids por chamada de apply.
pub const APPLY_MAX_IDS: usize = 100;
const PREVIEW_CHARS: usize = 200;
/// Só conta a rejeição do Jev quando a probabilidade dele chega a este valor (se ela existir).
const JEV_MIN_PROBABILITY: f64 = 0.45;
const TEST_KEY_PREFIXES: &[&str] = &["neg-", "test-", "tmp-", "teste-"];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub entry_id: String,
    pub scope: String,
    pub mission_id: Option<String>,
    pub key: String,
    pub kind: String,
    pub body_preview: String,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFailure {
    pub entry_id: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub deleted: u32,
    pub failed: Vec<CleanupFailure>,
}

/// Entrada ativa com a revisão corrente aprovada.
struct ActiveRow {
    id: String,
    scope: String,
    mission_id: Option<String>,
    key: String,
    kind: String,
    body: String,
}

fn normalize_body(body: &str) -> String {
    body.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn active_rows(conn: &Connection, workspace_id: &str) -> Result<Vec<ActiveRow>, String> {
    // Mais antiga primeiro: a duplicata que fica é sempre a primeira deste laço.
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.scope, e.mission_id, e.key, e.kind, r.body \
             FROM memory_entries e \
             JOIN memory_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision AND r.status = 'approved' \
             WHERE e.workspace_id = ?1 AND e.status = 'active' AND e.current_revision IS NOT NULL \
             ORDER BY e.created_at, e.rowid",
        )
        .map_err(|_| "could not read memory entries".to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            Ok(ActiveRow {
                id: r.get(0)?,
                scope: r.get(1)?,
                mission_id: r.get(2)?,
                key: r.get(3)?,
                kind: r.get(4)?,
                body: r.get(5)?,
            })
        })
        .map_err(|_| "could not read memory entries".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "could not read memory entries".to_string())?;
    Ok(rows)
}

/// Candidatas da limpeza de um workspace. Pura sobre a conexão: não grava nada.
pub fn candidates_for(conn: &Connection, workspace_id: &str) -> Result<Vec<Candidate>, String> {
    let rows = active_rows(conn, workspace_id)?;
    let mut reasons: Vec<Vec<String>> = vec![Vec::new(); rows.len()];

    // (a) Duplicatas: mesmo corpo normalizado no mesmo escopo (workspace, ou uma mission). A primeira
    // (mais antiga) fica sem marca; as seguintes apontam para ela.
    let mut first_by_body: HashMap<(String, String, String), usize> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        let group = (
            row.scope.clone(),
            row.mission_id.clone().unwrap_or_default(),
            normalize_body(&row.body),
        );
        match first_by_body.get(&group) {
            Some(&first) => reasons[i].push(format!("duplicada de {}", rows[first].key)),
            None => {
                first_by_body.insert(group, i);
            }
        }
    }

    // (b) Chaves de teste.
    for (i, row) in rows.iter().enumerate() {
        let key = row.key.to_lowercase();
        if TEST_KEY_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) {
            reasons[i].push("chave de teste".to_string());
        }
    }

    // (c) O Jev rejeitaria: o log de decisões tem `rejeitar` para (key, kind, proposta, body).
    let inputs: Vec<HintInput> = rows
        .iter()
        .map(|row| HintInput {
            key: row.key.clone(),
            kind: row.kind.clone(),
            operation: "proposta".to_string(),
            body: row.body.clone(),
        })
        .collect();
    for hint in memory_hints(conn, &inputs)? {
        let confident = hint.probability.is_none_or(|p| p >= JEV_MIN_PROBABILITY);
        if hint.action == "rejeitar" && hint.secret != Some(true) && confident {
            reasons[hint.index].push("o Jev rejeitaria".to_string());
        }
    }

    let mut out: Vec<Candidate> = rows
        .into_iter()
        .zip(reasons)
        .filter(|(_, reasons)| !reasons.is_empty())
        .map(|(row, reasons)| Candidate {
            entry_id: row.id,
            scope: row.scope,
            mission_id: row.mission_id,
            key: row.key,
            kind: row.kind,
            body_preview: row.body.chars().take(PREVIEW_CHARS).collect(),
            reasons,
        })
        .collect();
    out.sort_by(|a, b| b.reasons.len().cmp(&a.reasons.len()).then_with(|| a.key.cmp(&b.key)));
    Ok(out)
}

/// Apaga uma entrada ativa pelo caminho do usuário: proposta de exclusão + aprovação imediata.
fn delete_as_user(conn: &Connection, sync: &RepoSync, workspace_id: &str, entry_id: &str) -> Result<(), String> {
    let row: Option<(String, String, Option<String>, String, String, i64, String, Option<i64>, Option<String>)> = conn
        .query_row(
            "SELECT e.scope, e.workspace_id, e.mission_id, e.key, e.kind, e.priority, e.status, e.current_revision, r.body \
             FROM memory_entries e \
             LEFT JOIN memory_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision AND r.status = 'approved' \
             WHERE e.id = ?1",
            [entry_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )
        .optional()
        .map_err(|_| "could not read memory entry".to_string())?;
    let Some((scope, owner, mission_id, key, kind, priority, status, current, body)) = row else {
        return Err("memória não encontrada neste workspace".into());
    };
    if owner != workspace_id {
        return Err("memória não encontrada neste workspace".into());
    }
    let (Some(revision), Some(body), "active") = (current, body, status.as_str()) else {
        return Err("memória não está ativa".into());
    };
    let input = ProposalInput {
        scope: scope.clone(),
        key: key.clone(),
        kind: kind.clone(),
        body: body.clone(),
        priority,
        operation: "delete".into(),
        expected_revision: Some(revision),
        source_fact_id: None,
        reason: None,
        acknowledge_secret: false,
    };
    let proposal = super::propose(
        conn,
        &scope,
        workspace_id,
        mission_id.as_deref(),
        &input,
        ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None },
    )?;
    repo_sync::decide_and_schedule(conn, sync, &proposal.entry_id, proposal.revision, true)?;
    // Apagar pela limpeza é a rejeição humana da proposta (origem `limpeza`), não uma aprovação.
    // Falha ao gravar o rótulo nunca derruba a exclusão, que já aconteceu.
    if let Err(error) = crate::decisions::scorecard::record_cleanup_rejection(conn, &key, &kind, &body) {
        eprintln!("limpeza de memória: rótulo do gabarito não gravado: {error}");
    }
    Ok(())
}

/// Apaga as entradas pedidas, uma a uma, sem parar na primeira falha. Ids repetidos contam uma vez.
pub fn apply_for(conn: &Connection, sync: &RepoSync, workspace_id: &str, entry_ids: &[String]) -> Result<CleanupResult, String> {
    if entry_ids.len() > APPLY_MAX_IDS {
        return Err(format!("no máximo {APPLY_MAX_IDS} memórias por chamada"));
    }
    let mut seen = HashSet::new();
    let mut result = CleanupResult { deleted: 0, failed: Vec::new() };
    for entry_id in entry_ids {
        if !seen.insert(entry_id.as_str()) {
            continue;
        }
        match delete_as_user(conn, sync, workspace_id, entry_id) {
            Ok(()) => result.deleted += 1,
            Err(error) => result.failed.push(CleanupFailure { entry_id: entry_id.clone(), error }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn memory_cleanup_candidates(workspace_id: String, db: tauri::State<DbConnection>) -> Result<Vec<Candidate>, String> {
    let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
    candidates_for(&conn, &workspace_id)
}

#[tauri::command]
pub fn memory_cleanup_apply(
    workspace_id: String,
    entry_ids: Vec<String>,
    app: tauri::AppHandle,
    db: tauri::State<DbConnection>,
    sync: tauri::State<RepoSync>,
) -> Result<CleanupResult, String> {
    let result = {
        let conn = db.lock().map_err(|_| "database unavailable".to_string())?;
        apply_for(&conn, &sync, &workspace_id, &entry_ids)
    };
    crate::memory::notify_changed(&app);
    result
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;
    use crate::decisions::log::{migrate as migrate_log, record, LogRow};
    use crate::decisions::{memory_state_hash, POINT_MEMORY};
    use crate::decisions::scorecard::CLEANUP_POINT;
    use crate::memory::{decide, propose, ProposalResult};

    fn db() -> Connection {
        crate::database::test_db()
    }

    fn sync() -> RepoSync {
        let shared: DbConnection = Arc::new(Mutex::new(crate::database::test_db()));
        let root = std::env::temp_dir().join(format!("ade-cleanup-{}", uuid::Uuid::new_v4()));
        RepoSync::with_runner(
            shared,
            root,
            Arc::new(|_: &std::path::Path, _: &[String]| Ok::<String, String>(String::new())),
            Arc::new(|_: u32| Duration::from_millis(1)),
        )
    }

    fn seed(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w1','W1',0,0);
             INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w2','W2',0,0);
             INSERT INTO missions(id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES('m1','w1','Mission','objective','/test',0,0);",
        )
        .unwrap();
    }

    fn add(conn: &Connection, scope: &str, workspace: &str, mission: Option<&str>, key: &str, body: &str) -> ProposalResult {
        let input = ProposalInput {
            scope: scope.into(),
            key: key.into(),
            kind: "note".into(),
            body: body.into(),
            priority: 0,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
            acknowledge_secret: false,
        };
        let actor = ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None };
        let created = propose(conn, scope, workspace, mission, &input, actor).unwrap();
        decide(conn, &created.entry_id, created.revision, true).unwrap();
        created
    }

    fn reasons_of(list: &[Candidate], key: &str) -> Option<Vec<String>> {
        list.iter().find(|c| c.key == key).map(|c| c.reasons.clone())
    }

    #[test]
    fn duplicatas_marcam_as_mais_novas_e_mantem_a_mais_antiga() {
        let conn = db();
        seed(&conn);
        add(&conn, "workspace", "w1", None, "dup-a", "Usar  SQLite\n local");
        add(&conn, "workspace", "w1", None, "dup-b", "usar sqlite local");
        add(&conn, "workspace", "w1", None, "dup-c", "USAR SQLITE LOCAL");
        add(&conn, "mission", "w1", Some("m1"), "dup-m", "usar sqlite local");
        let list = candidates_for(&conn, "w1").unwrap();
        assert_eq!(reasons_of(&list, "dup-a"), None);
        assert_eq!(reasons_of(&list, "dup-m"), None, "escopo de mission é outro grupo");
        assert_eq!(reasons_of(&list, "dup-b"), Some(vec!["duplicada de dup-a".to_string()]));
        assert_eq!(reasons_of(&list, "dup-c"), Some(vec!["duplicada de dup-a".to_string()]));
        assert!(list.iter().all(|c| c.body_preview.chars().count() <= PREVIEW_CHARS));
    }

    #[test]
    fn chave_de_teste_ignora_maiusculas_e_nao_pega_prefixo_sem_hifen() {
        let conn = db();
        seed(&conn);
        add(&conn, "workspace", "w1", None, "neg-x", "alfa");
        add(&conn, "workspace", "w1", None, "TEST-y", "beta");
        add(&conn, "workspace", "w1", None, "Teste-z", "gama");
        add(&conn, "workspace", "w1", None, "tmpfoo", "delta");
        let list = candidates_for(&conn, "w1").unwrap();
        for key in ["neg-x", "TEST-y", "Teste-z"] {
            assert_eq!(reasons_of(&list, key), Some(vec!["chave de teste".to_string()]), "{key}");
        }
        assert_eq!(reasons_of(&list, "tmpfoo"), None);
        // Ordenação: número de motivos desc, depois chave.
        assert_eq!(list.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), vec!["TEST-y", "Teste-z", "neg-x"]);
    }

    #[test]
    fn jev_rejeitaria_so_com_rejeitar_sem_segredo_e_probabilidade_suficiente() {
        let conn = db();
        seed(&conn);
        migrate_log(&conn).unwrap();
        add(&conn, "workspace", "w1", None, "jev-sim", "corpo jev");
        add(&conn, "workspace", "w1", None, "jev-baixo", "corpo baixo");
        add(&conn, "workspace", "w1", None, "jev-segredo", "corpo segredo");
        add(&conn, "workspace", "w1", None, "jev-aprova", "corpo aprova");
        let log = |key: &str, body: &str, decision: &str, probability: f64| {
            record(
                &conn,
                &LogRow {
                    ts: 1,
                    point: POINT_MEMORY.into(),
                    provider: "jev".into(),
                    model: "m".into(),
                    state_hash: memory_state_hash(key, "note", "proposta", body),
                    heuristic: "acao=revisar;segredo=nao".into(),
                    provider_decision: Some(decision.into()),
                    probability: Some(probability),
                    confidence: None,
                    latency_ms: Some(1),
                    error: None,
                    input_tokens: Some(1),
                    output_tokens: Some(0),
                },
            )
            .unwrap();
        };
        log("jev-sim", "corpo jev", "acao=rejeitar;segredo=nao", 0.9);
        log("jev-baixo", "corpo baixo", "acao=rejeitar;segredo=nao", 0.2);
        log("jev-segredo", "corpo segredo", "acao=rejeitar;segredo=sim", 0.9);
        log("jev-aprova", "corpo aprova", "acao=aprovar;segredo=nao", 0.9);
        let list = candidates_for(&conn, "w1").unwrap();
        assert_eq!(reasons_of(&list, "jev-sim"), Some(vec!["o Jev rejeitaria".to_string()]));
        assert_eq!(reasons_of(&list, "jev-baixo"), None);
        assert_eq!(reasons_of(&list, "jev-segredo"), None);
        assert_eq!(reasons_of(&list, "jev-aprova"), None);
    }

    #[test]
    fn apply_apaga_so_as_pedidas_com_historico_e_recusa_outro_workspace() {
        let conn = db();
        seed(&conn);
        let old = add(&conn, "workspace", "w1", None, "old-key", "para apagar");
        let keep = add(&conn, "workspace", "w1", None, "keep-key", "fica");
        let other = add(&conn, "workspace", "w2", None, "other-key", "de outro");
        let sync = sync();

        let result = apply_for(
            &conn,
            &sync,
            "w1",
            &[old.entry_id.clone(), other.entry_id.clone(), old.entry_id.clone()],
        )
        .unwrap();
        assert_eq!(result.deleted, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].entry_id, other.entry_id);

        let status = |id: &str| -> String {
            conn.query_row("SELECT status FROM memory_entries WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(status(&old.entry_id), "deleted");
        assert_eq!(status(&keep.entry_id), "active");
        assert_eq!(status(&other.entry_id), "active");

        // Tombstone: a revisão de exclusão fica aprovada e o histórico anterior continua.
        let (operation, decided): (String, String) = conn
            .query_row(
                "SELECT operation,status FROM memory_revisions WHERE entry_id=?1 ORDER BY revision DESC LIMIT 1",
                [&old.entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((operation.as_str(), decided.as_str()), ("delete", "approved"));
        let revisions: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_revisions WHERE entry_id=?1", [&old.entry_id], |r| r.get(0))
            .unwrap();
        assert_eq!(revisions, 2);

        // Idempotente: repetir não apaga de novo; a entrada já não está ativa.
        let again = apply_for(&conn, &sync, "w1", &[old.entry_id.clone()]).unwrap();
        assert_eq!(again.deleted, 0);
        assert_eq!(again.failed[0].error, "memória não está ativa");
        assert!(candidates_for(&conn, "w1").unwrap().iter().all(|c| c.entry_id != old.entry_id));
    }

    #[test]
    fn apply_grava_o_rotulo_de_limpeza_uma_vez_e_nao_grava_aprovacao() {
        let conn = db();
        seed(&conn);
        let old = add(&conn, "workspace", "w1", None, "rot-key", "para rotular");
        let other = add(&conn, "workspace", "w2", None, "rot-other", "de outro workspace");
        let sync = sync();
        let hash = memory_state_hash("rot-key", "note", "proposta", "para rotular");
        let count = |point: &str| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM decision_human_log WHERE point = ?1", [point], |r| r.get(0)).unwrap()
        };

        // Recusada (outro workspace): nada é rotulado.
        assert_eq!(apply_for(&conn, &sync, "w1", &[other.entry_id.clone()]).unwrap().deleted, 0);
        assert_eq!(count(CLEANUP_POINT), 0);

        assert_eq!(apply_for(&conn, &sync, "w1", &[old.entry_id.clone()]).unwrap().deleted, 1);
        assert_eq!(count(CLEANUP_POINT), 1);
        let (stored_hash, decision): (String, String) = conn
            .query_row("SELECT state_hash, decision FROM decision_human_log WHERE point = ?1", [CLEANUP_POINT], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((stored_hash.as_str(), decision.as_str()), (hash.as_str(), "rejeitar"));
        // A exclusão não entra como aprovação da tela normal.
        assert_eq!(count(POINT_MEMORY), 0);

        // Repetir o rótulo (mesma proposta) não duplica.
        assert!(!crate::decisions::scorecard::record_cleanup_rejection(&conn, "rot-key", "note", "para rotular").unwrap());
        assert_eq!(count(CLEANUP_POINT), 1);
    }

    #[test]
    fn apply_recusa_mais_de_cem_ids() {
        let conn = db();
        seed(&conn);
        let ids: Vec<String> = (0..=APPLY_MAX_IDS).map(|i| format!("id-{i}")).collect();
        assert!(apply_for(&conn, &sync(), "w1", &ids).is_err());
    }
}
