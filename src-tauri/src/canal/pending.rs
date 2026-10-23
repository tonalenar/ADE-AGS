//! Pendências de um integrante: aprovações e perguntas que esperam resposta, guardadas no SQLite
//! para o orquestrador ver (`ags peer pending`) e responder (`ags peer answer`).
//!
//! De onde vem cada uma (ver [`signals`]):
//! - `question`: o transcript diz que o agente fez uma pergunta com opções e espera
//!   (`AskUserQuestion` do Claude Code). Firme.
//! - `approval`: uma ferramenta pendente no transcript **e** o diálogo de permissão na tela.
//!   Nenhum dos dois transcripts grava o pedido de aprovação enquanto ele está aberto (o Claude
//!   só grava a decisão, depois; o Codex 0.163 não grava nada), então a tela confirma o diálogo e
//!   o transcript diz QUAL ferramenta e com que comando.
//! - `turn_question`: o turno acabou e a última linha da fala é uma pergunta. Heurística: fica
//!   listada, mas não vira aviso ao orquestrador (o detector de "orquestrador parado" já cuida).
//!
//! Ciclo de vida: `pending → answered | expired`. Uma linha por (aba, chave): a mesma pendência
//! nunca é registrada duas vezes, nem reaberta depois de respondida.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::state::{Phase, TabState};

/// A ferramenta precisa estar pendente há pelo menos isto para o diálogo na tela contar como dela.
pub const APPROVAL_GRACE_MS: i64 = 2_000;
/// Uma pendência sem resposta há mais que isto expira.
pub const EXPIRE_AFTER_MS: i64 = 2 * 60 * 60 * 1000;
/// Resolvidas ficam este tempo para consulta e depois saem.
const KEEP_RESOLVED_MS: i64 = 3 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Approval,
    Question,
    TurnQuestion,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Approval => "approval",
            Kind::Question => "question",
            Kind::TurnQuestion => "turn_question",
        }
    }

    pub fn parse(raw: &str) -> Option<Kind> {
        Some(match raw {
            "approval" => Kind::Approval,
            "question" => Kind::Question,
            "turn_question" => Kind::TurnQuestion,
            _ => return None,
        })
    }

    /// Vira aviso no terminal do orquestrador? A heurística de fim de turno, não.
    pub fn notifies(self) -> bool {
        !matches!(self, Kind::TurnQuestion)
    }

    /// Quanto esperar antes de avisar o orquestrador: a pessoa pode estar olhando e responder já.
    pub fn notify_after_ms(self) -> i64 {
        match self {
            Kind::Approval => 15_000,
            Kind::Question => 10_000,
            Kind::TurnQuestion => i64::MAX,
        }
    }
}

/// O que o estado da aba diz que está pendente agora.
#[derive(Clone, Debug, PartialEq)]
pub struct Signal {
    pub kind: Kind,
    /// Identifica a pendência dentro da aba (id da ferramenta, ou o fim do turno).
    pub key: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<String>,
}

/// Pura: as pendências que o estado (e o diálogo na tela, se alguém olhou) mostram agora.
/// `dialog`: `Some(true)` = a tela mostra um diálogo de permissão; `None` = ninguém olhou.
pub fn signals(state: &TabState, dialog: Option<bool>, now: i64) -> Vec<Signal> {
    let mut out = Vec::new();
    if let Some(q) = &state.question {
        out.push(Signal {
            kind: Kind::Question,
            key: q.id.clone(),
            title: q.text.clone(),
            detail: String::new(),
            options: q.options.clone(),
        });
    }
    if let Some(a) = &state.approval {
        out.push(Signal { kind: Kind::Approval, key: a.id.clone(), title: "aprovação".into(), detail: a.summary.clone(), options: vec![] });
    } else if dialog == Some(true) {
        // O diálogo é da ferramenta pendente mais recente que não é a própria pergunta.
        let question = state.question.as_ref().map(|q| q.id.as_str());
        if let Some(tool) = state
            .tools
            .iter()
            .filter(|t| Some(t.id.as_str()) != question && now - t.since_ms >= APPROVAL_GRACE_MS)
            .max_by_key(|t| t.since_ms)
        {
            out.push(Signal { kind: Kind::Approval, key: tool.id.clone(), title: tool.name.clone(), detail: tool.summary.clone(), options: vec![] });
        }
    }
    if state.phase == Phase::Idle && state.ends_with_question {
        let at = state.turn_ended_at.unwrap_or(0);
        let text = state.last_text.as_deref().unwrap_or("");
        let last = text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        out.push(Signal {
            kind: Kind::TurnQuestion,
            key: format!("turn:{}:{at}", state.turns),
            title: super::event::clip(last, 300),
            detail: String::new(),
            options: vec![],
        });
    }
    out
}

/// Pura: precisa olhar a tela? Só com uma ferramenta pendente há tempo bastante e sem pedido de
/// aprovação já dito pelo transcript (olhar a tela de todas as abas a cada segundo seria à toa).
pub fn needs_dialog_check(state: &TabState, now: i64) -> bool {
    state.phase == Phase::Working
        && state.approval.is_none()
        && state.tools.iter().any(|t| now - t.since_ms >= APPROVAL_GRACE_MS && state.question.as_ref().is_none_or(|q| q.id != t.id))
}

/// Pura: o fim da tela (sem escapes) mostra um diálogo de permissão? Os mesmos sinais de
/// `isWaitingForUser` (`missions/stalled.ts`), mais os do Codex.
pub fn dialog_on_screen(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(14)..].join("\n").to_lowercase();
    const NEEDLES: [&str; 12] = [
        "do you want to proceed",
        "do you want to make this edit",
        "do you want to create",
        "do you want to allow",
        "do you want to run",
        "would you like to run the following command",
        "would you like to make the following edits",
        "allow command?",
        "yes, proceed",
        "press enter to confirm",
        "esc to cancel",
        "(y/n)",
    ];
    NEEDLES.iter().any(|n| tail.contains(n))
        || tail.lines().any(|l| {
            let l = l.trim_start_matches(['❯', '>', '›', '│', ' ']);
            l.starts_with("1. yes") || l.starts_with("1. sim")
        })
}

// ── SQLite ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Pending,
    Answered,
    Expired,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Pending => "pending",
            State::Answered => "answered",
            State::Expired => "expired",
        }
    }

    fn parse(raw: &str) -> State {
        match raw {
            "answered" => State::Answered,
            "expired" => State::Expired,
            _ => State::Pending,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub tab_id: String,
    pub tab_name: String,
    pub agent_id: String,
    pub kind: Kind,
    pub item_key: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<String>,
    pub state: State,
    pub notified_at: Option<i64>,
    pub answer: Option<String>,
    pub answered_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub answered_at: Option<i64>,
}

/// Aditiva e idempotente; não sobe `user_version` (como `peer_queue::migrate`).
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_pending (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tab_id TEXT NOT NULL,
            tab_name TEXT NOT NULL DEFAULT '',
            agent_id TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL CHECK(kind IN ('approval','question','turn_question')),
            item_key TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            options TEXT NOT NULL DEFAULT '[]',
            state TEXT NOT NULL CHECK(state IN ('pending','answered','expired')),
            notified_at INTEGER,
            answer TEXT,
            answered_by TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            answered_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_pending_key ON agent_pending(tab_id, item_key);
        CREATE INDEX IF NOT EXISTS idx_agent_pending_state ON agent_pending(state, tab_id);",
    )
}

const COLUMNS: &str = "id, tab_id, tab_name, agent_id, kind, item_key, title, detail, options, state, notified_at, answer, answered_by, created_at, updated_at, answered_at";

fn row(r: &Row<'_>) -> rusqlite::Result<Item> {
    let options: String = r.get(8)?;
    Ok(Item {
        id: r.get(0)?,
        tab_id: r.get(1)?,
        tab_name: r.get(2)?,
        agent_id: r.get(3)?,
        kind: Kind::parse(&r.get::<_, String>(4)?).unwrap_or(Kind::Question),
        item_key: r.get(5)?,
        title: r.get(6)?,
        detail: r.get(7)?,
        options: serde_json::from_str(&options).unwrap_or_default(),
        state: State::parse(&r.get::<_, String>(9)?),
        notified_at: r.get(10)?,
        answer: r.get(11)?,
        answered_by: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
        answered_at: r.get(15)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Item>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM agent_pending WHERE id = ?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())
}

/// Quem é a aba, para gravar junto.
#[derive(Clone, Debug, Default)]
pub struct Owner<'a> {
    pub tab_id: &'a str,
    pub tab_name: &'a str,
    pub agent_id: &'a str,
    pub session_id: &'a str,
}

/// Esconde o que parece segredo (um token num comando, por exemplo): a pendência vai para o
/// terminal de outro agente.
fn redact(text: &str) -> String {
    if crate::memory::agent::looks_like_secret(text) {
        "(oculto: parece conter um segredo; veja na tela do integrante)".into()
    } else {
        text.to_string()
    }
}

/// Acerta as pendências de uma aba com o que está pendente agora: registra as novas e dá por
/// respondidas (pela própria TUI) as que sumiram. Devolve as que acabaram de nascer.
pub fn sync(conn: &Connection, owner: &Owner<'_>, now_signals: &[Signal], now: i64) -> Result<Vec<Item>, String> {
    let mut created = Vec::new();
    for s in now_signals {
        let options = serde_json::to_string(&s.options).unwrap_or_else(|_| "[]".into());
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO agent_pending (tab_id, tab_name, agent_id, session_id, kind, item_key, title, detail, options, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)",
                params![owner.tab_id, owner.tab_name, owner.agent_id, owner.session_id, s.kind.as_str(), s.key, redact(&s.title), redact(&s.detail), options, now],
            )
            .map_err(|e| e.to_string())?;
        if inserted > 0 {
            if let Some(item) = get(conn, conn.last_insert_rowid())? {
                created.push(item);
            }
        }
    }
    // O que estava pendente e não aparece mais foi resolvido na própria TUI (a pessoa respondeu,
    // ou a ferramenta terminou). Uma resposta do orquestrador já gravada não é sobrescrita.
    let keys: Vec<&str> = now_signals.iter().map(|s| s.key.as_str()).collect();
    for item in pending_for(conn, owner.tab_id)? {
        if !keys.contains(&item.item_key.as_str()) {
            conn.execute(
                "UPDATE agent_pending SET state = 'answered', answered_by = COALESCE(answered_by, 'tui'),
                        answered_at = COALESCE(answered_at, ?2), updated_at = ?2
                 WHERE id = ?1 AND state = 'pending'",
                params![item.id, now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(created)
}

pub fn pending_for(conn: &Connection, tab_id: &str) -> Result<Vec<Item>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM agent_pending WHERE tab_id = ?1 AND state = 'pending' ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([tab_id], row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// As pendências destas abas: só as abertas, ou também as resolvidas nas últimas 24 h.
pub fn list(conn: &Connection, tabs: &[String], include_resolved: bool, now: i64) -> Result<Vec<Item>, String> {
    let since = now - 24 * 60 * 60 * 1000;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM agent_pending WHERE (state = 'pending' OR (?1 AND updated_at >= ?2)) ORDER BY id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![include_resolved, since], row).map_err(|e| e.to_string())?;
    let all = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(all.into_iter().filter(|i| tabs.contains(&i.tab_id)).collect())
}

/// As pendentes ainda sem aviso que já podem avisar.
pub fn due_notices(conn: &Connection, now: i64) -> Result<Vec<Item>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM agent_pending WHERE state = 'pending' AND notified_at IS NULL ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row).map_err(|e| e.to_string())?;
    let all = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(all.into_iter().filter(|i| i.kind.notifies() && now - i.created_at >= i.kind.notify_after_ms()).collect())
}

pub fn mark_notified(conn: &Connection, id: i64, now: i64) -> Result<(), String> {
    conn.execute("UPDATE agent_pending SET notified_at = ?2, updated_at = ?2 WHERE id = ?1", params![id, now])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// O orquestrador respondeu. Só uma pendente: `false` se ela já tinha sido resolvida.
pub fn record_answer(conn: &Connection, id: i64, answer: &str, by: &str, now: i64) -> Result<bool, String> {
    conn.execute(
        "UPDATE agent_pending SET state = 'answered', answer = ?2, answered_by = ?3, answered_at = ?4, updated_at = ?4
         WHERE id = ?1 AND state = 'pending'",
        params![id, answer, by, now],
    )
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

/// Expira o que é de aba fechada (ou não vale mais) e o que espera há tempo demais; apaga as
/// resolvidas antigas. `live` = as abas abertas agora.
pub fn housekeep(conn: &Connection, live: &[String], now: i64) -> Result<usize, String> {
    let mut changed = 0;
    let mut stmt = conn
        .prepare("SELECT id, tab_id, created_at FROM agent_pending WHERE state = 'pending'")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    for (id, tab, created) in rows {
        if !live.contains(&tab) || now - created > EXPIRE_AFTER_MS {
            changed += conn
                .execute("UPDATE agent_pending SET state = 'expired', updated_at = ?2 WHERE id = ?1 AND state = 'pending'", params![id, now])
                .map_err(|e| e.to_string())?;
        }
    }
    conn.execute("DELETE FROM agent_pending WHERE state != 'pending' AND updated_at < ?1", [now - KEEP_RESOLVED_MS])
        .map_err(|e| e.to_string())?;
    Ok(changed)
}
