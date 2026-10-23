//! O estado de cada mensagem entre agentes, no SQLite. Só SQL e regras puras: nada aqui digita
//! num terminal, espera um PTY ou fala com a janela.
//!
//! Ciclo de vida (ver [`State::can_become`]):
//!
//! ```text
//! queued ──► delivering ──► delivered
//!   │             └───────► unconfirmed ──┐
//!   ├──► cancelled  (o usuário cancelou)   │ reenvio com o mesmo id
//!   └──► expired    (aba fechada / velha) ─┴──► queued
//! ```
//!
//! A ordem da fila de um destino é a coluna `position` (menor primeiro). "Enviar agora" põe a
//! mensagem na frente e marca `force_now`: o entregador não espera o destino ficar quieto.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

/// Dentro desta janela, a mesma mensagem (sem id do chamador) para o mesmo destino é repetida.
pub const DUPLICATE_WINDOW_MS: i64 = 10 * 60 * 1000;
/// No arranque, o que esperava há mais que isto não é mais entregue: vira `expired`.
pub const RESUME_MAX_AGE_MS: i64 = 60 * 60 * 1000;
/// Registros já resolvidos (entregues, cancelados…) ficam este tempo e depois saem.
const KEEP_FINISHED_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Tamanho máximo de um id do chamador (`--id`).
const MAX_CLIENT_ID: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Delivering,
    Delivered,
    Unconfirmed,
    Cancelled,
    Expired,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Queued => "queued",
            State::Delivering => "delivering",
            State::Delivered => "delivered",
            State::Unconfirmed => "unconfirmed",
            State::Cancelled => "cancelled",
            State::Expired => "expired",
        }
    }

    pub fn parse(raw: &str) -> Option<State> {
        Some(match raw {
            "queued" => State::Queued,
            "delivering" => State::Delivering,
            "delivered" => State::Delivered,
            "unconfirmed" => State::Unconfirmed,
            "cancelled" => State::Cancelled,
            "expired" => State::Expired,
            _ => return None,
        })
    }

    /// As transições permitidas. `unconfirmed`/`expired` → `queued` só num reenvio com o mesmo id:
    /// o app disse ao remetente que a mensagem não chegou (ou nunca foi digitada).
    pub fn can_become(self, next: State) -> bool {
        use State::*;
        matches!(
            (self, next),
            (Queued, Delivering | Cancelled | Expired) | (Delivering, Delivered | Unconfirmed) | (Unconfirmed | Expired, Queued)
        )
    }

    /// Como o estado aparece numa mensagem de erro para o usuário ou o agente.
    pub fn label(self) -> &'static str {
        match self {
            State::Queued => "na fila",
            State::Delivering => "sendo entregue",
            State::Delivered => "já entregue",
            State::Unconfirmed => "entregue sem confirmação",
            State::Cancelled => "cancelada",
            State::Expired => "expirada",
        }
    }
}

/// Uma mensagem e o seu estado, como a lista da fila e a CLI mostram.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMessage {
    pub id: i64,
    pub client_id: Option<String>,
    /// `tell`, `ask`, `handoff` (a linha do `peer deliver`), `role` (o briefing do `peer role`) ou
    /// `notice` (aviso do próprio app, como o resultado do `ci watch`).
    pub kind: String,
    pub from_tab_id: String,
    pub from_name: String,
    pub to_tab_id: String,
    pub to_name: String,
    /// O texto que o remetente escreveu (sem o cabeçalho): é o que o usuário edita.
    pub text: String,
    /// `--raw`: vai sem cabeçalho.
    pub raw: bool,
    /// Cabeçalho de pergunta ("responda normalmente…"): só o `ask` direto.
    pub reply: bool,
    pub state: State,
    pub position: i64,
    pub force_now: bool,
    pub attempts: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub delivered_at: Option<i64>,
    pub edited_at: Option<i64>,
    /// Por que terminou assim (aba fechada, não apareceu na tela…).
    pub note: Option<String>,
}

/// O que chega para entrar na fila.
#[derive(Clone, Debug)]
pub struct NewMessage<'a> {
    pub client_id: Option<&'a str>,
    pub kind: &'a str,
    pub from_tab_id: &'a str,
    pub from_name: &'a str,
    pub to_tab_id: &'a str,
    pub to_name: &'a str,
    pub text: &'a str,
    pub raw: bool,
    pub reply: bool,
}

/// O que `admit` fez com a mensagem.
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    /// Nova (ou um reenvio com o mesmo id de uma que não chegou): vai ser entregue.
    New(PeerMessage),
    /// O mesmo id do chamador já existe: é a MESMA mensagem, e não vai de novo.
    Repeat(PeerMessage),
    /// Sem id, o mesmo texto já foi (ou está indo) para o mesmo destino há pouco.
    Duplicate(PeerMessage),
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS peer_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id TEXT,
            kind TEXT NOT NULL,
            from_tab_id TEXT NOT NULL,
            from_name TEXT NOT NULL,
            to_tab_id TEXT NOT NULL,
            to_name TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            raw INTEGER NOT NULL DEFAULT 0,
            reply INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK(state IN ('queued','delivering','delivered','unconfirmed','cancelled','expired')),
            position INTEGER NOT NULL DEFAULT 0,
            force_now INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            delivered_at INTEGER,
            edited_at INTEGER,
            note TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_messages_client
            ON peer_messages(from_tab_id, client_id) WHERE client_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_peer_messages_queue
            ON peer_messages(to_tab_id, state, position);",
    )
}

const COLUMNS: &str = "id, client_id, kind, from_tab_id, from_name, to_tab_id, to_name, text, raw, reply, state, \
    position, force_now, attempts, created_at, updated_at, delivered_at, edited_at, note";

fn row(r: &Row<'_>) -> rusqlite::Result<PeerMessage> {
    let state: String = r.get(10)?;
    Ok(PeerMessage {
        id: r.get(0)?,
        client_id: r.get(1)?,
        kind: r.get(2)?,
        from_tab_id: r.get(3)?,
        from_name: r.get(4)?,
        to_tab_id: r.get(5)?,
        to_name: r.get(6)?,
        text: r.get(7)?,
        raw: r.get::<_, i64>(8)? != 0,
        reply: r.get::<_, i64>(9)? != 0,
        // O CHECK da tabela só deixa os seis; um valor estranho não derruba a lista.
        state: State::parse(&state).unwrap_or(State::Expired),
        position: r.get(11)?,
        force_now: r.get::<_, i64>(12)? != 0,
        attempts: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        delivered_at: r.get(16)?,
        edited_at: r.get(17)?,
        note: r.get(18)?,
    })
}

fn query(conn: &Connection, sql_tail: &str, args: impl rusqlite::Params) -> Result<Vec<PeerMessage>, String> {
    let sql = format!("SELECT {COLUMNS} FROM peer_messages {sql_tail}");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(args, row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<PeerMessage>, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM peer_messages WHERE id = ?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())
}

/// O id do chamador, limpo. Vazio = sem id. Pura.
pub fn clean_client_id(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = raw.map(str::trim).filter(|id| !id.is_empty()) else { return Ok(None) };
    if id.chars().count() > MAX_CLIENT_ID || id.chars().any(char::is_control) {
        return Err(format!("--id tem que ser um texto curto (até {MAX_CLIENT_ID} caracteres), sem quebras de linha."));
    }
    Ok(Some(id.to_string()))
}

fn next_position(conn: &Connection, to: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM peer_messages WHERE to_tab_id = ?1 AND state = 'queued'",
        [to],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Registra a mensagem e decide se ela vai: nova, a mesma de um id já usado, ou repetida.
///
/// `initial`: `Queued` (entra na fila e o entregador a leva) ou `Delivering` (quem chama já tem o
/// terminal do destino e digita agora, como o `peer ask` com o destino livre).
pub fn admit(conn: &Connection, new: &NewMessage<'_>, initial: State, now: i64) -> Result<Admission, String> {
    if !matches!(new.kind, "tell" | "ask" | "handoff" | "role" | "notice") {
        return Err(format!("Tipo de mensagem desconhecido: {}", new.kind));
    }
    if !matches!(initial, State::Queued | State::Delivering) {
        return Err("Uma mensagem nova começa na fila ou sendo entregue.".into());
    }
    if new.text.trim().is_empty() {
        return Err("A mensagem está vazia.".into());
    }
    let client_id = clean_client_id(new.client_id)?;
    prune(conn, now)?;

    if let Some(cid) = client_id.as_deref() {
        let found = query(conn, "WHERE from_tab_id = ?1 AND client_id = ?2", params![new.from_tab_id, cid])?;
        if let Some(existing) = found.into_iter().next() {
            if existing.to_tab_id != new.to_tab_id {
                return Err(format!(
                    "O id '{cid}' já foi usado na mensagem #{} para {}. Use outro id para outra mensagem.",
                    existing.id,
                    if existing.to_name.is_empty() { &existing.to_tab_id } else { &existing.to_name }
                ));
            }
            // Não chegou (ou nunca foi digitada): o reenvio com o mesmo id a põe de novo na fila.
            if existing.state.can_become(State::Queued) {
                let position = next_position(conn, new.to_tab_id)?;
                conn.execute(
                    "UPDATE peer_messages SET state = ?1, position = ?2, force_now = 0, note = NULL, updated_at = ?3 WHERE id = ?4",
                    params![initial.as_str(), position, now, existing.id],
                )
                .map_err(|e| e.to_string())?;
                let again = get(conn, existing.id)?.ok_or("A mensagem sumiu da fila.")?;
                return Ok(Admission::New(again));
            }
            return Ok(Admission::Repeat(existing));
        }
    } else if !new.reply {
        // Sem id, vale o dedupe de antes, agora no banco (sobrevive ao reinício): mesmo destino,
        // mesmo texto, do mesmo remetente (com `--raw`, de qualquer um), há menos de 10 min. A que
        // não se confirmou ou foi cancelada não conta: o reenvio dela passa.
        let found = query(
            conn,
            "WHERE to_tab_id = ?1 AND text = ?2 AND raw = ?3 AND reply = 0 AND (raw = 1 OR from_tab_id = ?4)
               AND state IN ('queued', 'delivering', 'delivered') AND created_at >= ?5
             ORDER BY id DESC LIMIT 1",
            params![new.to_tab_id, new.text, new.raw as i64, new.from_tab_id, now - DUPLICATE_WINDOW_MS],
        )?;
        if let Some(existing) = found.into_iter().next() {
            return Ok(Admission::Duplicate(existing));
        }
    }

    let position = next_position(conn, new.to_tab_id)?;
    conn.execute(
        "INSERT INTO peer_messages (client_id, kind, from_tab_id, from_name, to_tab_id, to_name, text, raw, reply,
             state, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            client_id,
            new.kind,
            new.from_tab_id,
            new.from_name,
            new.to_tab_id,
            new.to_name,
            new.text,
            new.raw as i64,
            new.reply as i64,
            initial.as_str(),
            position,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Admission::New(get(conn, id)?.ok_or("A mensagem não foi gravada.")?))
}

/// Apaga os registros já resolvidos há mais de 7 dias. A fila em si nunca é apagada.
pub fn prune(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM peer_messages WHERE state IN ('delivered', 'unconfirmed', 'cancelled', 'expired') AND updated_at < ?1",
        [now - KEEP_FINISHED_MS],
    )
    .map_err(|e| e.to_string())
}

/// A próxima da fila de um destino.
pub fn head(conn: &Connection, to: &str) -> Result<Option<PeerMessage>, String> {
    Ok(query(conn, "WHERE to_tab_id = ?1 AND state = 'queued' ORDER BY position, id LIMIT 1", [to])?.into_iter().next())
}

/// O que espera um destino, na ordem da entrega (a que está sendo digitada primeiro).
pub fn queued_for(conn: &Connection, to: &str) -> Result<Vec<PeerMessage>, String> {
    query(
        conn,
        "WHERE to_tab_id = ?1 AND state IN ('queued', 'delivering') ORDER BY state = 'delivering' DESC, position, id",
        [to],
    )
}

/// O que um remetente mandou e ainda não foi entregue (`ags peer queue`).
pub fn pending_from(conn: &Connection, from: &str) -> Result<Vec<PeerMessage>, String> {
    query(conn, "WHERE from_tab_id = ?1 AND state IN ('queued', 'delivering') ORDER BY to_tab_id, position, id", [from])
}

/// Quantas esperam cada destino (o selo "N na fila").
pub fn pending_counts(conn: &Connection) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT to_tab_id, COUNT(*) FROM peer_messages WHERE state IN ('queued', 'delivering') GROUP BY to_tab_id ORDER BY to_tab_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Toma a mensagem para digitar: `queued` → `delivering`, numa só escrita. `None` se ela saiu da fila
/// nesse meio tempo (cancelada, ou já tomada).
pub fn claim(conn: &Connection, id: i64, now: i64) -> Result<Option<PeerMessage>, String> {
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = 'delivering', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2 AND state = 'queued'",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

/// Fecha a entrega: apareceu na tela (`delivered`) ou não (`unconfirmed`).
pub fn finish(conn: &Connection, id: i64, confirmed: bool, note: Option<&str>, now: i64) -> Result<bool, String> {
    let state = if confirmed { State::Delivered } else { State::Unconfirmed };
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = ?1, delivered_at = ?2, note = ?3, updated_at = ?4 WHERE id = ?5 AND state = 'delivering'",
            params![state.as_str(), confirmed.then_some(now), note, now, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// O erro de quem tentou mexer numa mensagem que não está mais na fila.
fn not_queued(conn: &Connection, id: i64) -> String {
    match get(conn, id) {
        Ok(Some(m)) => format!("A mensagem #{id} não está mais na fila ({}).", m.state.label()),
        _ => format!("A mensagem #{id} não existe."),
    }
}

fn queued(conn: &Connection, id: i64) -> Result<PeerMessage, String> {
    match get(conn, id)? {
        Some(m) if m.state == State::Queued => Ok(m),
        _ => Err(not_queued(conn, id)),
    }
}

/// O usuário reescreve uma mensagem que ainda espera. Vale o texto novo na hora da entrega.
pub fn edit(conn: &Connection, id: i64, text: &str, now: i64) -> Result<PeerMessage, String> {
    if text.trim().is_empty() {
        return Err("A mensagem não pode ficar vazia: para não mandá-la, cancele.".into());
    }
    let changed = conn
        .execute(
            "UPDATE peer_messages SET text = ?1, edited_at = ?2, updated_at = ?2 WHERE id = ?3 AND state = 'queued'",
            params![text, now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(not_queued(conn, id));
    }
    get(conn, id)?.ok_or_else(|| not_queued(conn, id))
}

/// A ordem nova depois de mover `id` `delta` casas (−1 sobe, +1 desce). `None` se já está na ponta
/// ou não está na lista. Pura.
pub fn reorder(order: &[i64], id: i64, delta: i64) -> Option<Vec<i64>> {
    let at = order.iter().position(|x| *x == id)?;
    let to = at as i64 + delta;
    if to < 0 || to >= order.len() as i64 {
        return None;
    }
    let mut out = order.to_vec();
    out.swap(at, to as usize);
    Some(out)
}

/// Sobe (`delta` −1) ou desce (+1) uma mensagem na fila do seu destino. As duas que trocam de lugar
/// perdem o "enviar agora": quem reordena está decidindo a ordem de novo.
pub fn move_by(conn: &Connection, id: i64, delta: i64, now: i64) -> Result<Vec<PeerMessage>, String> {
    let msg = queued(conn, id)?;
    let order: Vec<i64> = query(conn, "WHERE to_tab_id = ?1 AND state = 'queued' ORDER BY position, id", [&msg.to_tab_id])?
        .into_iter()
        .map(|m| m.id)
        .collect();
    let Some(next) = reorder(&order, id, delta) else { return queued_for(conn, &msg.to_tab_id) };
    let swapped = next[order.iter().position(|x| *x == id).unwrap_or(0)];
    for (index, mid) in next.iter().enumerate() {
        conn.execute(
            "UPDATE peer_messages SET position = ?1, force_now = CASE WHEN id IN (?2, ?3) THEN 0 ELSE force_now END, updated_at = ?4
             WHERE id = ?5 AND state = 'queued'",
            params![index as i64 + 1, id, swapped, now, mid],
        )
        .map_err(|e| e.to_string())?;
    }
    queued_for(conn, &msg.to_tab_id)
}

/// O usuário desiste de uma mensagem que ainda não foi digitada.
pub fn cancel(conn: &Connection, id: i64, note: &str, now: i64) -> Result<PeerMessage, String> {
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = 'cancelled', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'queued'",
            params![note, now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(not_queued(conn, id));
    }
    get(conn, id)?.ok_or_else(|| not_queued(conn, id))
}

/// "Enviar agora": vai para a frente da fila e o entregador não espera o destino ficar quieto.
pub fn send_now(conn: &Connection, id: i64, now: i64) -> Result<PeerMessage, String> {
    let msg = queued(conn, id)?;
    let first: i64 = conn
        .query_row(
            "SELECT COALESCE(MIN(position), 1) FROM peer_messages WHERE to_tab_id = ?1 AND state = 'queued'",
            [&msg.to_tab_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE peer_messages SET position = ?1, force_now = 1, updated_at = ?2 WHERE id = ?3 AND state = 'queued'",
        params![first - 1, now, id],
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)?.ok_or_else(|| not_queued(conn, id))
}

/// Tudo o que esperava um destino que não existe mais vira `expired`.
pub fn expire_queued_for(conn: &Connection, to: &str, note: &str, now: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE peer_messages SET state = 'expired', note = ?1, updated_at = ?2 WHERE to_tab_id = ?3 AND state = 'queued'",
        params![note, now, to],
    )
    .map_err(|e| e.to_string())
}

/// O que fazer, no arranque do app, com uma mensagem que estava pendente.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resume {
    /// Volta para a fila do destino (com o aviso de atraso, na entrega).
    Keep,
    /// Não vai mais: o destino sumiu ou ela ficou velha demais.
    Expire(&'static str),
    /// Estava sendo digitada quando o app fechou: não se sabe se chegou, e não se digita de novo.
    Unconfirm(&'static str),
}

/// Pura: a decisão do arranque para uma mensagem pendente.
pub fn resume_decision(msg: &PeerMessage, live_tabs: &HashSet<String>, now: i64) -> Resume {
    match msg.state {
        State::Delivering => Resume::Unconfirm("O app fechou enquanto a mensagem era digitada: não dá para saber se ela chegou."),
        State::Queued if !live_tabs.contains(&msg.to_tab_id) => Resume::Expire("A aba de destino não existe mais."),
        State::Queued if now - msg.created_at > RESUME_MAX_AGE_MS => Resume::Expire("Ficou na fila mais de 1 h e o app reiniciou."),
        _ => Resume::Keep,
    }
}

/// No arranque: aplica `resume_decision` a tudo o que estava pendente e devolve os destinos cuja
/// fila deve voltar a andar.
pub fn resume(conn: &Connection, live_tabs: &HashSet<String>, now: i64) -> Result<Vec<String>, String> {
    let pending = query(conn, "WHERE state IN ('queued', 'delivering') ORDER BY id", [])?;
    let mut targets: Vec<String> = Vec::new();
    for msg in pending {
        match resume_decision(&msg, live_tabs, now) {
            Resume::Keep => {
                if !targets.contains(&msg.to_tab_id) {
                    targets.push(msg.to_tab_id.clone());
                }
            }
            Resume::Expire(note) => {
                conn.execute(
                    "UPDATE peer_messages SET state = 'expired', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'queued'",
                    params![note, now, msg.id],
                )
                .map_err(|e| e.to_string())?;
            }
            Resume::Unconfirm(note) => {
                conn.execute(
                    "UPDATE peer_messages SET state = 'unconfirmed', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'delivering'",
                    params![note, now, msg.id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    targets.sort();
    Ok(targets)
}
