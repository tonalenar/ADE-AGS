//! O estado de cada integrante de uma missão em terminais: `provisioning` → `active` ou `failed`.
//!
//! O integrante é gravado como `provisioning` ANTES de o worktree ser criado e de a aba abrir. Se o app
//! cair nessa janela, o próximo boot decide pelo estado real ([`reconcile`]): há aba aberta na pasta dele
//! ou um span de início com o nome dele → `active`; não há → `failed`, com o motivo. Nada é apagado: o
//! worktree que sobrou fica no disco para a pessoa ver (`ags worktrees list`).
//!
//! Nomes nunca são reutilizados numa missão ([`begin_recruit`]): recrutar "Ana" de novo depois que a
//! primeira "Ana" saiu abriria um agente novo no worktree e na branch da antiga.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const PROVISIONING: &str = "provisioning";
pub const ACTIVE: &str = "active";
pub const FAILED: &str = "failed";

/// Os spans que provam que o agente chegou a abrir (ver `startcheck`).
const START_KINDS: [&str; 3] = ["boot", "start_briefing", "start_activity"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberState {
    pub name: String,
    pub state: String,
    pub failure: Option<String>,
    pub updated_at: i64,
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn state_of(conn: &Connection, mission_id: &str, name: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT state FROM mission_member_state WHERE mission_id = ?1 AND name = ?2", params![mission_id, name], |r| r.get(0))
        .optional()
        .map_err(err)
}

/// Um integrante da equipe inicial vai ser preparado. Idempotente: a mesma equipe preparada de novo (um
/// retry da missão) volta a `provisioning` só quem tinha falhado; quem está ativo fica ativo.
pub fn begin(conn: &Connection, mission_id: &str, name: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mission_member_state (mission_id, name, state, created_at, updated_at) VALUES (?1, ?2, 'provisioning', ?3, ?3)
         ON CONFLICT(mission_id, name) DO UPDATE SET state = 'provisioning', failure = NULL, updated_at = excluded.updated_at
         WHERE mission_member_state.state = 'failed'",
        params![mission_id, name, now],
    )
    .map_err(err)?;
    stamp_owner(conn, mission_id, name)
}

/// O nome já foi usado nesta missão (por alguém da equipe, ativo, falho ou que saiu)? Sem distinguir
/// maiúsculas, como o `peer` procura os nomes.
pub fn name_taken(conn: &Connection, mission_id: &str, name: &str) -> Result<bool, String> {
    let wanted = name.trim().to_lowercase();
    let mut stmt = conn
        .prepare("SELECT name FROM mission_member_state WHERE mission_id = ?1 UNION SELECT name FROM mission_team_workspaces WHERE mission_id = ?1")
        .map_err(err)?;
    let names = stmt.query_map([mission_id], |r| r.get::<_, String>(0)).map_err(err)?;
    for used in names {
        if used.map_err(err)?.trim().to_lowercase() == wanted {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Um recrutado vai ser preparado. Recusa um nome que a missão já usou.
pub fn begin_recruit(conn: &Connection, mission_id: &str, name: &str, now: i64) -> Result<(), String> {
    if name_taken(conn, mission_id, name)? {
        return Err(format!(
            "O nome '{name}' já foi usado nesta missão. Nomes não se reutilizam (o worktree e a branch dele continuam no disco): escolha outro, como '{name} 2'."
        ));
    }
    conn.execute(
        "INSERT INTO mission_member_state (mission_id, name, state, created_at, updated_at) VALUES (?1, ?2, 'provisioning', ?3, ?3)",
        params![mission_id, name, now],
    )
    .map_err(err)?;
    stamp_owner(conn, mission_id, name)
}

fn stamp_owner(conn: &Connection, mission_id: &str, name: &str) -> Result<(), String> {
    let Some(owner) = crate::harness::presence::current_id() else { return Ok(()) };
    conn.execute(
        "UPDATE mission_member_state SET owner_instance = ?3
         WHERE mission_id = ?1 AND name = ?2 AND state = 'provisioning' AND owner_instance IS NULL",
        params![mission_id, name, owner],
    )
    .map_err(err)?;
    Ok(())
}

/// A preparação falhou (worktree, setup): fica `failed`, com o motivo.
pub fn fail(conn: &Connection, mission_id: &str, name: &str, failure: &str, now: i64) -> Result<(), String> {
    let failure: String = failure.chars().take(500).collect();
    conn.execute(
        "UPDATE mission_member_state SET state = 'failed', failure = ?3, updated_at = ?4 WHERE mission_id = ?1 AND name = ?2 AND state = 'provisioning'",
        params![mission_id, name, failure, now],
    )
    .map_err(err)?;
    Ok(())
}

/// O agente deu sinal de vida (um span de início com o nome dele): `provisioning` → `active`.
pub fn activate(conn: &Connection, mission_id: &str, name: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE mission_member_state SET state = 'active', failure = NULL, updated_at = ?3 WHERE mission_id = ?1 AND name = ?2 AND state = 'provisioning'",
        params![mission_id, name, now],
    )
    .map_err(err)?;
    Ok(())
}

/// Chamado ao gravar um span: os de início ativam o integrante.
pub fn on_span(conn: &Connection, mission_id: &str, kind: &str, actor: &str, now: i64) -> Result<(), String> {
    if START_KINDS.contains(&kind) && !actor.is_empty() {
        activate(conn, mission_id, actor, now)?;
    }
    Ok(())
}

/// O que se sabe de um integrante em `provisioning` para decidir o estado. Puro sobre isto.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Evidence {
    /// O worktree dele foi gravado e existe no disco.
    pub worktree: bool,
    /// Há uma aba (aberta ou guardada) na pasta dele.
    pub tab: bool,
    /// Há um span de início com o nome dele.
    pub started: bool,
}

/// `Some(estado, motivo)` = muda; `None` = continua `provisioning`. No boot (`boot = true`) nada continua
/// `provisioning`: quem não deu sinal de vida falhou. Fora do boot, só a evidência ativa. Pura.
pub fn decide(evidence: &Evidence, boot: bool) -> Option<(&'static str, Option<&'static str>)> {
    if evidence.tab || evidence.started {
        return Some((ACTIVE, None));
    }
    if !boot {
        return None;
    }
    Some((
        FAILED,
        Some(if evidence.worktree {
            "o app fechou depois de criar o worktree e antes de o agente abrir"
        } else {
            "o app fechou antes de o worktree ficar pronto"
        }),
    ))
}

fn evidence(conn: &Connection, mission_id: &str, name: &str) -> Result<Evidence, String> {
    let place: Option<(String, String)> = conn
        .query_row("SELECT cwd, root FROM mission_team_workspaces WHERE mission_id = ?1 AND name = ?2", params![mission_id, name], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(err)?;
    let worktree = place.as_ref().is_some_and(|(_, root)| Path::new(root).join(".git").exists());
    let tab = match &place {
        Some((cwd, _)) => {
            let in_tabs: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tabs WHERE cwd = ?1)", [cwd], |r| r.get(0)).map_err(err)?;
            let in_usage: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM mission_usage_tabs WHERE mission_id = ?1 AND cwd = ?2)", params![mission_id, cwd], |r| r.get(0))
                .map_err(err)?;
            in_tabs || in_usage
        }
        None => false,
    };
    let started: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mission_timings WHERE mission_id = ?1 AND actor = ?2 AND kind IN ('boot', 'start_briefing', 'start_activity'))",
            params![mission_id, name],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok(Evidence { worktree, tab, started })
}

/// Decide quem está em `provisioning` (de uma missão ou de todas). Devolve quantos mudaram.
pub fn reconcile(conn: &Connection, mission_id: Option<&str>, boot: bool, now: i64) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("SELECT mission_id, name, owner_instance FROM mission_member_state WHERE state = 'provisioning' AND (?1 IS NULL OR mission_id = ?1)")
        .map_err(err)?;
    let pending = stmt
        .query_map([mission_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut changed = 0;
    for (mission, name, owner) in pending {
        if crate::harness::presence::owner_is_protected(conn, owner.as_deref(), now).unwrap_or(false) {
            continue;
        }
        let Some((state, failure)) = decide(&evidence(conn, &mission, &name)?, boot) else { continue };
        changed += conn
            .execute(
                "UPDATE mission_member_state SET state = ?3, failure = ?4, updated_at = ?5 WHERE mission_id = ?1 AND name = ?2 AND state = 'provisioning'",
                params![mission, name, state, failure, now],
            )
            .map_err(err)?;
    }
    Ok(changed)
}

/// O estado de cada integrante da missão, por nome.
pub fn states(conn: &Connection, mission_id: &str) -> Result<BTreeMap<String, MemberState>, String> {
    let mut stmt = conn
        .prepare("SELECT name, state, failure, updated_at FROM mission_member_state WHERE mission_id = ?1 ORDER BY name")
        .map_err(err)?;
    let rows = stmt
        .query_map([mission_id], |r| Ok(MemberState { name: r.get(0)?, state: r.get(1)?, failure: r.get(2)?, updated_at: r.get(3)? }))
        .map_err(err)?;
    rows.map(|r| r.map(|m| (m.name.clone(), m))).collect::<Result<_, _>>().map_err(err)
}

/// O estado atual de um nome, para os testes e a tela.
pub fn state(conn: &Connection, mission_id: &str, name: &str) -> Result<Option<String>, String> {
    state_of(conn, mission_id, name)
}

#[cfg(test)]
mod test {
    use super::*;

    fn db() -> Connection {
        let conn = crate::database::test_db();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'w', 0, 0);
             INSERT INTO missions (id, workspace_id, title, objective, cwd, status, created_at, updated_at) VALUES ('m', 'w', 'M', 'o', '/p', 'running', 1, 1);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn decide_pelo_estado_real_e_no_boot_nada_fica_provisionando() {
        let none = Evidence::default();
        assert_eq!(decide(&none, false), None, "fora do boot, sem evidência, espera");
        assert_eq!(decide(&none, true).map(|d| d.0), Some(FAILED));
        assert!(decide(&Evidence { worktree: true, ..Default::default() }, true).unwrap().1.unwrap().contains("depois de criar o worktree"));
        assert_eq!(decide(&Evidence { tab: true, ..Default::default() }, true), Some((ACTIVE, None)));
        assert_eq!(decide(&Evidence { started: true, ..Default::default() }, false), Some((ACTIVE, None)));
    }

    #[test]
    fn o_boot_reconcilia_quem_caiu_entre_gravar_e_abrir() {
        let conn = db();
        begin(&conn, "m", "Ana", 10).unwrap();
        begin(&conn, "m", "Bia", 10).unwrap();
        begin(&conn, "m", "Caio", 10).unwrap();
        // Ana abriu (span de início); Bia tem worktree e aba guardada; Caio não chegou a nada.
        crate::missions::timings::add(&conn, "m", &crate::missions::timings::NewSpan { kind: "start_briefing".into(), actor: "Ana".into(), target: String::new(), started_ms: 5, ended_ms: 6, detail: String::new() }).unwrap();
        assert_eq!(state(&conn, "m", "Ana").unwrap().as_deref(), Some(ACTIVE), "o span ativa na hora");
        conn.execute("INSERT INTO mission_team_workspaces (mission_id, name, cwd, root, branch) VALUES ('m', 'Bia', '/wt/bia', '/wt/bia', 'cc/bia')", []).unwrap();
        conn.execute("INSERT INTO mission_usage_tabs (mission_id, tab_id, agent_id, label, kind, cwd, opened_at) VALUES ('m', 't1', 'codex', 'Bia', 'member', '/wt/bia', 7)", []).unwrap();
        assert_eq!(reconcile(&conn, Some("m"), false, 20).unwrap(), 1, "fora do boot só ativa Bia");
        assert_eq!(state(&conn, "m", "Caio").unwrap().as_deref(), Some(PROVISIONING));
        assert_eq!(reconcile(&conn, None, true, 30).unwrap(), 1);
        let all = states(&conn, "m").unwrap();
        assert_eq!(all["Bia"].state, ACTIVE);
        assert_eq!(all["Caio"].state, FAILED);
        assert!(all["Caio"].failure.as_deref().unwrap().contains("antes de o worktree"));
        assert_eq!(reconcile(&conn, None, true, 40).unwrap(), 0, "idempotente");
    }

    #[test]
    fn o_retry_da_equipe_reabre_so_quem_falhou() {
        let conn = db();
        begin(&conn, "m", "Ana", 10).unwrap();
        activate(&conn, "m", "Ana", 11).unwrap();
        begin(&conn, "m", "Bia", 10).unwrap();
        fail(&conn, "m", "Bia", "git lock", 12).unwrap();
        begin(&conn, "m", "Ana", 20).unwrap();
        begin(&conn, "m", "Bia", 20).unwrap();
        assert_eq!(state(&conn, "m", "Ana").unwrap().as_deref(), Some(ACTIVE));
        assert_eq!(state(&conn, "m", "Bia").unwrap().as_deref(), Some(PROVISIONING));
        assert_eq!(states(&conn, "m").unwrap()["Bia"].failure, None);
    }

    #[test]
    fn um_nome_nunca_e_reutilizado_no_recrutamento() {
        let conn = db();
        begin_recruit(&conn, "m", "Ana", 10).unwrap();
        fail(&conn, "m", "Ana", "worktree", 11).unwrap();
        let error = begin_recruit(&conn, "m", "ana", 12).unwrap_err();
        assert!(error.contains("já foi usado"), "{error}");
        // Missão antiga, sem a tabela de estado: o worktree gravado também reserva o nome.
        conn.execute("INSERT INTO mission_team_workspaces (mission_id, name, cwd, root, branch) VALUES ('m', 'Leo', '/wt/leo', '/wt/leo', 'cc/leo')", []).unwrap();
        assert!(begin_recruit(&conn, "m", "Leo", 13).is_err());
        begin_recruit(&conn, "m", "Ana 2", 14).unwrap();
    }
}
