//! O fork da pergunta lateral: ela nasce como **cópia** da conversa de origem num ponto estável, em vez de levar um
//! recorte do histórico no primeiro envio (como o `forkSideChat` do T3 Code).
//!
//! - Claude Code: `--resume <sessão> --fork-session --session-id <nova>` (`claude_map::Start::Fork`);
//! - Codex: `thread/fork` com `lastTurnId` (`codex::fork_params`);
//! - os outros motores (e a origem que não é conversa por protocolo): sem fork, **recorte** do histórico. A tela
//!   avisa o motivo (`Reason::code`, traduzido no front), nunca cai no recorte em silêncio.
//!
//! O fork nunca altera nem interrompe a conversa de origem: só lê o que ela já gravou (o banco e a sessão do agente)
//! e abre outro processo com outra sessão. **Ponto estável** = o último turno terminado: o Codex recebe o id dele;
//! o Claude só forka com a origem ociosa (o ADE não guarda o uuid do último turno concluído do Claude para truncar a
//! transcrição no meio de um turno, então a origem trabalhando cai no recorte, com o motivo `origin-working`).
//!
//! `plan` e `origin_of` são puras (sem processo); `apply` é quem abre o processo; `record` grava o desfecho.

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::database::DbConnection;

use super::api::Engine;
use super::store;

/// Por que a pergunta lateral caiu no recorte do histórico. O código é o que a tela traduz.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// O motor da pergunta não tem fork nativo no ADE.
    Unsupported,
    /// A origem é um terminal (aba TUI): não há sessão de protocolo para copiar.
    OriginTerminal,
    /// A origem ainda não tem sessão do agente (nenhuma mensagem enviada).
    OriginNoSession,
    /// A pergunta usa outro agente que o da origem: a sessão de um provedor não abre em outro.
    OtherAgent,
    /// A pergunta usa outra conta que a da origem: a sessão vive no perfil de uma conta.
    OtherAccount,
    /// A origem está no meio de um turno e o motor só forka com ela ociosa (Claude).
    OriginWorking,
    /// A origem está no meio do primeiro turno: não há turno terminado para forkar.
    NoStableTurn,
    /// O motor tentou o fork e falhou (processo, sessão sumida, prazo).
    Failed,
}

impl Reason {
    pub const fn code(self) -> &'static str {
        match self {
            Reason::Unsupported => "unsupported",
            Reason::OriginTerminal => "origin-terminal",
            Reason::OriginNoSession => "origin-no-session",
            Reason::OtherAgent => "other-agent",
            Reason::OtherAccount => "other-account",
            Reason::OriginWorking => "origin-working",
            Reason::NoStableTurn => "no-stable-turn",
            Reason::Failed => "failed",
        }
    }
}

/// O que a conversa de origem mostra ao fork: lido do banco, sem tocar nela.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub agent_id: String,
    pub account_id: Option<String>,
    /// O id da sessão da origem no agente (`remote_id`).
    pub remote_id: Option<String>,
    /// Há um turno em andamento.
    pub working: bool,
    /// O último turno terminado (concluído, interrompido ou com erro): o ponto estável.
    pub last_stable_turn: Option<String>,
}

/// O que fazer com a pergunta lateral que acabou de nascer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Claude: `--resume <from> --fork-session`.
    Claude { from: String },
    /// Codex: `thread/fork` até `last_turn_id` (inclusivo; `None` = o fim da thread).
    Codex { from: String, last_turn_id: Option<String> },
    /// Sem fork: recorte do histórico no primeiro envio.
    Excerpt(Reason),
}

/// Como a pergunta nasceu, para a tela.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// `native` (cópia da sessão da origem) ou `excerpt` (recorte do histórico).
    pub mode: String,
    /// Só em `excerpt`: o código do motivo (`Reason::code`).
    pub reason: Option<String>,
}

impl Outcome {
    pub fn native() -> Outcome {
        Outcome { mode: "native".into(), reason: None }
    }

    pub fn excerpt(reason: Reason) -> Outcome {
        Outcome { mode: "excerpt".into(), reason: Some(reason.code().into()) }
    }
}

/// O que a origem de uma pergunta lateral mostra ao fork. `None` = a origem não é uma conversa por protocolo
/// (aba de terminal, ou conversa que sumiu). Só lê o banco.
pub fn origin_of(conn: &Connection, parent_ref: &str) -> rusqlite::Result<Option<Origin>> {
    let Some(parent_id) = parent_ref.strip_prefix("thread:") else { return Ok(None) };
    let Some(parent) = store::thread(conn, parent_id)? else { return Ok(None) };
    let working = conn
        .prepare("SELECT 1 FROM chat_run WHERE thread_id = ?1 AND status = 'inProgress' LIMIT 1")?
        .exists([parent_id])?;
    Ok(Some(Origin {
        agent_id: parent.agent_id,
        account_id: parent.account_id,
        remote_id: parent.remote_id,
        working,
        last_stable_turn: store::last_stable_turn(conn, parent_id)?,
    }))
}

/// Pura: o plano do fork para uma pergunta lateral do agente `agent_id` (e conta `account_id`) sobre `origin`.
/// O motor só forka se a matriz diz (`Engine::capabilities().session_fork`); o resto cai no recorte, com o motivo.
pub fn plan(agent_id: &str, account_id: Option<&str>, origin: Option<&Origin>) -> Plan {
    let Some(engine) = Engine::of(agent_id).filter(|engine| engine.capabilities().session_fork) else {
        return Plan::Excerpt(Reason::Unsupported);
    };
    let Some(origin) = origin else { return Plan::Excerpt(Reason::OriginTerminal) };
    if origin.agent_id != agent_id {
        return Plan::Excerpt(Reason::OtherAgent);
    }
    if origin.account_id.as_deref() != account_id {
        return Plan::Excerpt(Reason::OtherAccount);
    }
    let Some(from) = origin.remote_id.clone().filter(|id| !id.is_empty()) else {
        return Plan::Excerpt(Reason::OriginNoSession);
    };
    match engine {
        Engine::Claude if origin.working => Plan::Excerpt(Reason::OriginWorking),
        Engine::Claude => Plan::Claude { from },
        Engine::Codex if origin.working && origin.last_stable_turn.is_none() => Plan::Excerpt(Reason::NoStableTurn),
        Engine::Codex => Plan::Codex { from, last_turn_id: origin.last_stable_turn.clone() },
        _ => Plan::Excerpt(Reason::Unsupported),
    }
}

/// Grava como a pergunta nasceu e devolve o desfecho. `opened`: o resultado de abrir o fork (`Ok` = a sessão nasceu
/// como cópia); um erro vira o recorte com o motivo `failed` (a conversa segue sem sessão, e abre uma nova no envio).
/// Só toca a conversa **da pergunta**: a origem fica como estava.
pub fn record(conn: &Connection, child_id: &str, plan: &Plan, opened: Result<(), String>) -> rusqlite::Result<Outcome> {
    let outcome = match (plan, opened) {
        (Plan::Excerpt(reason), _) => Outcome::excerpt(*reason),
        (_, Ok(())) => Outcome::native(),
        (_, Err(_)) => Outcome::excerpt(Reason::Failed),
    };
    store::set_fork(conn, child_id, &outcome.mode, outcome.reason.as_deref())?;
    Ok(outcome)
}

/// Abre o fork da pergunta lateral `child_id` e grava o desfecho. Chamada antes da primeira mensagem: com `native` a
/// pergunta vai sozinha (o agente já sabe a conversa); com `excerpt` a tela manda o recorte do histórico. Idempotente:
/// uma pergunta já decidida devolve o que foi gravado.
pub async fn fork_side_chat(app: &AppHandle, db: &DbConnection, child_id: &str) -> Result<Outcome, String> {
    let (child, origin) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let child = store::thread(&conn, child_id).map_err(|e| e.to_string())?.ok_or("Conversa não encontrada")?;
        let origin = match child.parent_ref.as_deref() {
            Some(parent) => origin_of(&conn, parent).map_err(|e| e.to_string())?,
            None => return Err("Só uma pergunta lateral tem origem para forkar".into()),
        };
        (child, origin)
    };
    if let Some(mode) = child.fork_mode.as_deref() {
        return Ok(Outcome { mode: mode.into(), reason: child.fork_reason.clone() });
    }
    // Uma pergunta que já tem sessão (anterior a este recurso, ou já enviada) não troca de sessão por baixo.
    if child.remote_id.is_some() {
        return Ok(Outcome { mode: "excerpt".into(), reason: None });
    }
    let plan = plan(&child.agent_id, child.account_id.as_deref(), origin.as_ref());
    let opened = match &plan {
        Plan::Claude { from } => super::claude::open_forked(app, db, child_id, from).await,
        Plan::Codex { from, last_turn_id } => super::codex::open_forked(app, db, child_id, from, last_turn_id.as_deref()).await,
        Plan::Excerpt(_) => Ok(()),
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    record(&conn, child_id, &plan, opened).map_err(|e| e.to_string())
}
