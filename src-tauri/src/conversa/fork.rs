//! O fork da pergunta lateral: ela nasce como **cópia** da conversa de origem num ponto estável, em vez de levar um
//! recorte do histórico no primeiro envio (como o `forkSideChat` do T3 Code).
//!
//! - Claude Code: `--resume <sessão> --fork-session --session-id <nova>` (`claude_map::Start::Fork`); com a origem no
//!   meio de um turno, `--resume-session-at <uuid>` corta a cópia na última mensagem do último turno **concluído**
//!   (o uuid fica em `chat_run.end_uuid`, gravado no fim de cada turno);
//! - Codex: `thread/fork` com `lastTurnId` (`codex::fork_params`);
//! - **portátil** (`fork_mode = portable`): quando a sessão da origem não abre na pergunta (outro agente, outra conta,
//!   motor sem fork, sem ponto estável, falha do fork), ela leva o histórico da origem como contexto (`fork_portatil`,
//!   o formato do T3: falas, resumo das ferramentas, arquivos, teto de tamanho, sem segredos). O motivo fica gravado;
//! - **recorte** (`excerpt`): só quando a origem não é uma conversa por protocolo (aba de terminal, sem sessão nem
//!   falas): a tela manda o recorte que ela mesma monta. A tela avisa o motivo (`Reason::code`), nunca em silêncio.
//!
//! O fork nunca altera nem interrompe a conversa de origem: só lê o que ela já gravou (o banco e a sessão do agente)
//! e abre outro processo com outra sessão. **Ponto estável** = o último turno terminado: o Codex recebe o id dele; o
//! Claude, o uuid do último turno concluído.
//!
//! `plan` e `origin_of` são puras (sem processo); `apply` é quem abre o processo; `record` grava o desfecho.

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::database::DbConnection;

use super::api::Engine;
use super::fork_portatil::{self, Kind, Pending};
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
    /// A origem está no meio de um turno e a conversa não guardou o ponto estável dele (Claude, turnos anteriores a
    /// este recurso): a cópia não sabe onde cortar.
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
    /// Claude: o uuid da última mensagem do agente no último turno **concluído** (`--resume-session-at`).
    pub last_end_uuid: Option<String>,
}

/// O que fazer com a pergunta lateral que acabou de nascer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Claude: `--resume <from> --fork-session`, cortado em `at` (o uuid do último turno concluído) quando a origem
    /// está no meio de um turno; `None` = a sessão inteira (origem ociosa).
    Claude { from: String, at: Option<String> },
    /// Codex: `thread/fork` até `last_turn_id` (inclusivo; `None` = o fim da thread).
    Codex { from: String, last_turn_id: Option<String> },
    /// A sessão não abre na pergunta: ela leva o histórico da origem como contexto portátil (`fork_portatil`).
    Portable(Reason),
    /// Sem origem por protocolo: recorte do histórico no primeiro envio, montado pela tela.
    Excerpt(Reason),
}

/// Como a pergunta nasceu, para a tela.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// `native` (cópia da sessão da origem), `portable` (histórico como contexto portátil) ou `excerpt` (recorte).
    pub mode: String,
    /// Só em `portable` e `excerpt`: o código do motivo (`Reason::code`).
    pub reason: Option<String>,
}

impl Outcome {
    pub fn native() -> Outcome {
        Outcome { mode: "native".into(), reason: None }
    }

    pub fn portable(reason: Reason) -> Outcome {
        Outcome { mode: "portable".into(), reason: Some(reason.code().into()) }
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
        last_end_uuid: store::last_end_uuid(conn, parent_id)?,
    }))
}

/// Pura: o plano do fork para uma pergunta lateral do agente `agent_id` (e conta `account_id`) sobre `origin`.
/// O motor só forka se a matriz diz (`Engine::capabilities().session_fork`); a sessão só abre no mesmo agente e na
/// mesma conta da origem. O resto leva o histórico como contexto portátil, com o motivo.
pub fn plan(agent_id: &str, account_id: Option<&str>, origin: Option<&Origin>) -> Plan {
    let Some(engine) = Engine::of(agent_id) else { return Plan::Excerpt(Reason::Unsupported) };
    let Some(origin) = origin else {
        return Plan::Excerpt(if engine.capabilities().session_fork { Reason::OriginTerminal } else { Reason::Unsupported });
    };
    if origin.agent_id != agent_id {
        return Plan::Portable(Reason::OtherAgent);
    }
    if origin.account_id.as_deref() != account_id {
        return Plan::Portable(Reason::OtherAccount);
    }
    if !engine.capabilities().session_fork {
        return Plan::Portable(Reason::Unsupported);
    }
    let Some(from) = origin.remote_id.clone().filter(|id| !id.is_empty()) else {
        return Plan::Portable(Reason::OriginNoSession);
    };
    match engine {
        Engine::Claude if !origin.working => Plan::Claude { from, at: None },
        // No meio de um turno a cópia termina no último turno concluído; sem o uuid dele, não há onde cortar.
        Engine::Claude => match origin.last_end_uuid.clone().filter(|uuid| !uuid.is_empty()) {
            Some(at) => Plan::Claude { from, at: Some(at) },
            None if origin.last_stable_turn.is_none() => Plan::Portable(Reason::NoStableTurn),
            None => Plan::Portable(Reason::OriginWorking),
        },
        Engine::Codex if origin.working && origin.last_stable_turn.is_none() => Plan::Portable(Reason::NoStableTurn),
        Engine::Codex => Plan::Codex { from, last_turn_id: origin.last_stable_turn.clone() },
        _ => Plan::Portable(Reason::Unsupported),
    }
}

/// Grava como a pergunta nasceu e devolve o desfecho. `opened`: o resultado de abrir o fork (`Ok` = a sessão nasceu
/// como cópia); um erro vira o contexto portátil com o motivo `failed` (a conversa segue sem sessão, e abre uma nova no
/// envio).
/// Só toca a conversa **da pergunta**: a origem fica como estava.
pub fn record(conn: &Connection, child_id: &str, plan: &Plan, opened: Result<(), String>) -> rusqlite::Result<Outcome> {
    let outcome = match (plan, opened) {
        (Plan::Excerpt(reason), _) => Outcome::excerpt(*reason),
        (Plan::Portable(reason), _) => Outcome::portable(*reason),
        (_, Ok(())) => Outcome::native(),
        (_, Err(_)) => Outcome::portable(Reason::Failed),
    };
    store::set_fork(conn, child_id, &outcome.mode, outcome.reason.as_deref())?;
    Ok(outcome)
}

/// O rótulo do agente para o texto do contexto.
fn label_of(agent_id: &str) -> String {
    crate::agents::agent_def(agent_id).map(|def| def.label.to_string()).unwrap_or_else(|| agent_id.to_string())
}

/// Decide o contexto que a pergunta leva na primeira mensagem e devolve o desfecho final, **sem** guardá-lo (quem chama
/// o guarda com `fork_portatil::save` depois de soltar a trava do banco):
/// - `portable`: o histórico da origem como contexto portátil; origem sem falas não tem o que levar e cai no recorte
///   (com o mesmo motivo);
/// - `native` com a origem no meio de um turno: o digest do que ela fez depois do ponto da cópia.
///
/// Só lê a origem. `origin_working`: a origem tinha um turno em andamento quando o fork foi pedido.
pub fn prepare_context(
    conn: &Connection,
    child: &store::ThreadRow,
    parent_id: &str,
    origin_agent: &str,
    origin_working: bool,
    outcome: Outcome,
) -> rusqlite::Result<(Outcome, Option<Pending>)> {
    let (from, to) = (label_of(origin_agent), label_of(&child.agent_id));
    match outcome.mode.as_str() {
        "portable" => {
            let items = store::items(conn, parent_id)?;
            match fork_portatil::portable_context(&items, parent_id, &from, &to) {
                Some(text) => Ok((outcome, Some(Pending { kind: Kind::Portable, text }))),
                None => {
                    let reason = outcome.reason.as_deref().and_then(reason_of).unwrap_or(Reason::Failed);
                    let fallback = Outcome::excerpt(reason);
                    store::set_fork(conn, &child.id, &fallback.mode, fallback.reason.as_deref())?;
                    Ok((fallback, None))
                }
            }
        }
        "native" if origin_working => {
            let items = store::in_flight_items(conn, parent_id)?;
            let pending = fork_portatil::delta_context(&items, parent_id, &from).map(|text| Pending { kind: Kind::Delta, text });
            Ok((outcome, pending))
        }
        _ => Ok((outcome, None)),
    }
}

fn reason_of(code: &str) -> Option<Reason> {
    [
        Reason::Unsupported,
        Reason::OriginTerminal,
        Reason::OriginNoSession,
        Reason::OtherAgent,
        Reason::OtherAccount,
        Reason::OriginWorking,
        Reason::NoStableTurn,
        Reason::Failed,
    ]
    .into_iter()
    .find(|reason| reason.code() == code)
}

/// Abre o fork da pergunta lateral `child_id` e grava o desfecho. Chamada antes da primeira mensagem: com `native` a
/// pergunta vai sozinha (o agente já sabe a conversa); com `portable` o contexto fica guardado e o backend o põe na
/// frente da primeira mensagem; com `excerpt` a tela manda o recorte do histórico. Idempotente: uma pergunta já
/// decidida devolve o que foi gravado.
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
        Plan::Claude { from, at } => super::claude::open_forked(app, db, child_id, from, at.as_deref()).await,
        Plan::Codex { from, last_turn_id } => super::codex::open_forked(app, db, child_id, from, last_turn_id.as_deref()).await,
        Plan::Portable(_) | Plan::Excerpt(_) => Ok(()),
    };
    let (outcome, pending) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let outcome = record(&conn, child_id, &plan, opened).map_err(|e| e.to_string())?;
        let parent_id = child.parent_ref.as_deref().and_then(|parent| parent.strip_prefix("thread:"));
        match (origin.as_ref(), parent_id) {
            (Some(origin), Some(parent_id)) => prepare_context(&conn, &child, parent_id, &origin.agent_id, origin.working, outcome).map_err(|e| e.to_string())?,
            _ => (outcome, None),
        }
    };
    // O contexto é guardado fora da trava do banco (`set_setting` a toma de novo).
    if let Some(pending) = pending {
        fork_portatil::save(db, child_id, &pending);
    }
    Ok(outcome)
}
