//! Trocar de agente (e de modelo) na MESMA conversa, como o T3 Code: a conversa continua (mesmo id, pasta, título,
//! linha do tempo, fila e time); muda quem responde. Desenho em `.plans/troca-agente/DESENHO.md`; decisões em
//! `docs/ade-ags/MODO_CHAT.md`.
//!
//! - **Só entre turnos** e sem pedido do agente esperando resposta.
//! - O processo do agente de antes fecha; a sessão nativa dele fica GUARDADA (`chat_thread_native`, aditiva): voltar a
//!   esse agente retoma a sessão e leva só o resumo do que rolou fora (delta); um agente novo recebe o resumo completo.
//! - O resumo (`handoff.rs`) é determinístico e DADO não confiável. Vai junto da PRÓXIMA mensagem da pessoa
//!   (`before_send`), não como turno à parte: não gasta um turno nem cota.
//! - A conta de um agente não vale em outro: a conversa passa à conta pedida (ou à principal). A sessão de outra conta
//!   não volta (ela mora no perfil da conta).
//! - O time acompanha: o agente do integrante/orquestrador e o nome dele (`Agente · Papel`) são atualizados.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::database::DbConnection;

use super::handoff::{self, Strategy};
use super::store::{self, ThreadRow};
use super::{agy, api, claude, codex, opencode, turn};

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_thread_native (
            thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            account_id TEXT,
            remote_id TEXT,
            until_ms INTEGER NOT NULL,
            PRIMARY KEY (thread_id, agent_id)
        );",
    )
}

/// O que a pessoa escolheu no seletor.
#[derive(Clone, Debug)]
pub struct Switch {
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: String,
    pub account_id: Option<String>,
}

/// O que a troca fez no banco.
#[derive(Debug)]
pub struct Applied {
    pub row: ThreadRow,
    pub strategy: Strategy,
    pub from_agent: String,
    pub to_agent: String,
    /// O acesso pedido não existe no agente novo (o Plano no Codex) e virou Supervisionado.
    pub access_changed: bool,
    /// O agente novo não tem tela de aprovação (o Antigravity em `-p`) e o acesso é Supervisionado: ele nega o que
    /// pediria aprovação. A tela avisa para a pessoa trocar o acesso.
    pub no_approval: bool,
}

fn db_err(e: impl ToString) -> String {
    e.to_string()
}

/// A parte de banco da troca (pura de processo e de janela): valida, guarda a sessão de quem sai, escolhe retomar a
/// do agente que volta (ou começar do zero) e troca a linha da conversa.
pub fn apply_switch(conn: &Connection, thread_id: &str, new: &Switch, now: i64) -> Result<Applied, String> {
    let row = store::thread(conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    if row.agent_id == new.agent_id {
        return Err("Já é o mesmo agente: troque só o modelo.".into());
    }
    let engine = api::Engine::of(&new.agent_id).ok_or_else(|| format!("{} não conversa por protocolo: abra uma conversa nova.", new.agent_id))?;
    if !store::pending_requests(conn, thread_id).map_err(db_err)?.is_empty() {
        return Err("Responda ao pedido do agente antes de trocar de agente.".into());
    }
    let (access, access_changed) = if engine.accepts(&new.access) { (new.access.clone(), false) } else { ("ask".to_string(), true) };

    conn.execute(
        "INSERT INTO chat_thread_native (thread_id, agent_id, account_id, remote_id, until_ms) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(thread_id, agent_id) DO UPDATE SET account_id = excluded.account_id, remote_id = excluded.remote_id, until_ms = excluded.until_ms",
        params![thread_id, row.agent_id, row.account_id, row.remote_id, now],
    )
    .map_err(db_err)?;

    // O agente que volta retoma a sessão dele se foi na mesma conta (a sessão mora no perfil dela).
    let earlier: Option<(Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT account_id, remote_id, until_ms FROM chat_thread_native WHERE thread_id = ?1 AND agent_id = ?2",
            params![thread_id, new.agent_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (remote, strategy) = match earlier {
        Some((account, Some(remote), until)) if account == new.account_id => (Some(remote), Strategy::Delta { since_ms: until }),
        _ => (None, Strategy::Full),
    };

    conn.execute(
        "UPDATE chat_thread SET agent_id = ?2, remote_id = ?3, model = ?4, effort = ?5, access = ?6, account_id = ?7, memory = NULL, updated_at = ?8 WHERE id = ?1",
        params![thread_id, new.agent_id, remote, new.model, new.effort, access, new.account_id, now],
    )
    .map_err(db_err)?;
    let updated = store::thread(conn, thread_id).map_err(db_err)?.ok_or("Conversa não encontrada")?;
    let no_approval = new.agent_id == "antigravity" && access == "ask";
    Ok(Applied { row: updated, strategy, from_agent: row.agent_id, to_agent: new.agent_id.clone(), access_changed, no_approval })
}

/// O time acompanha a troca: o agente do integrante (ou do orquestrador) e o nome dele, no formato `Agente · Papel`,
/// onde só a parte do agente muda. Devolve os times alterados (a tela os relê).
pub fn switch_team_member(conn: &Connection, thread_ref: &str, from_agent: &str, to_agent: &str, now: i64) -> Result<Vec<String>, String> {
    let label_of = |id: &str| crate::agents::agent_def(id).map(|d| d.label.to_string()).unwrap_or_else(|| id.to_string());
    let (from_label, to_label) = (label_of(from_agent), label_of(to_agent));
    let mut changed: Vec<String> = Vec::new();
    // Orquestrador: o rótulo do time é o nome do agente.
    let mut stmt = conn.prepare("SELECT id, label FROM chat_team WHERE orchestrator = ?1").map_err(db_err)?;
    let teams: Vec<(String, String)> = stmt.query_map(params![thread_ref], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?.flatten().collect();
    for (id, label) in teams {
        let label = if label == from_label { to_label.clone() } else { label.replacen(&from_label, &to_label, 1) };
        conn.execute("UPDATE chat_team SET agent_id = ?2, label = ?3, updated_at = ?4 WHERE id = ?1", params![id, to_agent, label, now]).map_err(db_err)?;
        changed.push(id);
    }
    // Integrante: "Claude Code · Revisor" vira "Codex · Revisor".
    let mut stmt = conn.prepare("SELECT team_id, label FROM chat_team_member WHERE member = ?1").map_err(db_err)?;
    let members: Vec<(String, String)> = stmt.query_map(params![thread_ref], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?.flatten().collect();
    for (team, label) in members {
        let label = if label == from_label { to_label.clone() } else { label.replacen(&from_label, &to_label, 1) };
        conn.execute("UPDATE chat_team_member SET agent_id = ?2, label = ?3, updated_at = ?4 WHERE member = ?1", params![thread_ref, to_agent, label, now]).map_err(db_err)?;
        if !changed.contains(&team) {
            changed.push(team);
        }
    }
    Ok(changed)
}

// ── O resumo que acompanha a próxima mensagem ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Pending {
    from_label: String,
    to_label: String,
    /// `None` = completo; `Some(t)` = só o que passou de `t` (ms).
    since_ms: Option<i64>,
}

fn pending_of(applied: &Applied) -> Pending {
    Pending {
        from_label: label_of(&applied.from_agent),
        to_label: label_of(&applied.to_agent),
        since_ms: match applied.strategy { Strategy::Full => None, Strategy::Delta { since_ms } => Some(since_ms) },
    }
}

#[cfg(test)]
pub(super) fn set_pending_for_test(db: &DbConnection, thread_id: &str, applied: &Applied) {
    save_pending(db, thread_id, Some(&pending_of(applied)));
}

fn pending_key(thread_id: &str) -> String {
    format!("chat.switch.pending.{thread_id}")
}

fn save_pending(db: &DbConnection, thread_id: &str, pending: Option<&Pending>) {
    let raw = pending.and_then(|p| serde_json::to_string(p).ok()).unwrap_or_default();
    let _ = crate::database::set_setting(db, &pending_key(thread_id), &raw);
}

fn load_pending(db: &DbConnection, thread_id: &str) -> Option<Pending> {
    let raw = crate::database::get_setting(db, &pending_key(thread_id)).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

/// Antes de enviar uma mensagem da pessoa: se a conversa acabou de trocar de agente, o resumo vai na frente dela (uma
/// vez só), separado por uma linha em branco; a tela esconde o bloco e mostra só a fala da pessoa. O segundo valor diz
/// se o resumo foi junto (quem enviou o confirma com [`summary_sent`] depois de enviar de fato).
pub fn before_send(db: &DbConnection, thread_id: &str, text: &str) -> (String, bool) {
    let Some(pending) = load_pending(db, thread_id) else { return (text.to_string(), false) };
    let items = api::items(db, thread_id).unwrap_or_default();
    let strategy = pending.since_ms.map_or(Strategy::Full, |since_ms| Strategy::Delta { since_ms });
    let summary = handoff::resumo(handoff::Input {
        items: &items,
        from_label: &pending.from_label,
        to_label: &pending.to_label,
        strategy,
        pending_request: None,
        budget_chars: handoff::DEFAULT_BUDGET,
    });
    (format!("{summary}\n\n{text}"), true)
}

/// A mensagem com o resumo foi enviada: ele não vai de novo.
pub fn summary_sent(db: &DbConnection, thread_id: &str) {
    save_pending(db, thread_id, None);
}

// ── A troca de verdade ────────────────────────────────────────────────────────────────────────────────────────

fn close_processes(thread_id: &str) {
    codex::close(thread_id);
    claude::close(thread_id);
    opencode::close(thread_id);
    agy::close(thread_id);
}

fn label_of(agent_id: &str) -> String {
    crate::agents::agent_def(agent_id).map(|d| d.label.to_string()).unwrap_or_else(|| agent_id.to_string())
}

/// O aviso na timeline: o código `agentSwitch` e, no texto, o JSON que a tela traduz («agora com Codex»).
pub fn notice_text(applied: &Applied) -> String {
    json!({
        "from": applied.from_agent,
        "to": applied.to_agent,
        "fromLabel": label_of(&applied.from_agent),
        "toLabel": label_of(&applied.to_agent),
        "model": applied.row.model,
        "strategy": if matches!(applied.strategy, Strategy::Full) { "full" } else { "delta" },
        "accessChanged": applied.access_changed,
        "noApproval": applied.no_approval,
    })
    .to_string()
}

pub async fn switch_agent(app: &AppHandle, db: &DbConnection, thread_id: &str, new: Switch) -> Result<ThreadRow, String> {
    if api::status(thread_id).working {
        return Err("Espere o agente terminar o turno para trocar de agente.".into());
    }
    let now = crate::util::now_ts_ms();
    let (applied, teams) = {
        let conn = db.lock().map_err(db_err)?;
        let applied = apply_switch(&conn, thread_id, &new, now)?;
        let teams = switch_team_member(&conn, &format!("thread:{thread_id}"), &applied.from_agent, &applied.to_agent, now).unwrap_or_default();
        (applied, teams)
    };
    // O processo do agente de antes fecha; o novo sobe na primeira mensagem (como numa conversa nova).
    close_processes(thread_id);
    save_pending(db, thread_id, Some(&pending_of(&applied)));
    turn::save_notice(app, db, thread_id, "agentSwitch", &notice_text(&applied));
    api::announce(app, &applied.row);
    for team in teams {
        crate::chat_team::commands::announce(app, &team);
    }
    Ok(applied.row)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn chat_thread_switch_agent(
    app: AppHandle,
    db: State<'_, DbConnection>,
    thread_id: String,
    agent_id: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    account_id: Option<String>,
) -> Result<ThreadRow, String> {
    let db = db.inner().clone();
    switch_agent(&app, &db, &thread_id, Switch { agent_id, model, effort, access, account_id }).await
}
