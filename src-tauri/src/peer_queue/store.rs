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
//! refused  (recusa de política: teto, duplicada, destino errado — só auditoria, nunca vai)
//! ```
//!
//! Falha definitiva: a mensagem do entregador (ou do arranque) que termina `unconfirmed` ou
//! `expired` volta ao remetente como aviso (`notice`, ver [`failure_notice`]). O relógio de todo
//! prazo é o do SQLite ([`db_now`]).
//!
//! A ordem da fila de um destino é a coluna `position` (menor primeiro). "Enviar agora" põe a
//! mensagem na frente e marca `force_now`: o entregador não espera o destino ficar quieto.
//!
//! Tetos (ver [`admit`]): cada mensagem `tell`/`ask` grava a sua `depth`, lida do SQLite (a
//! "mensagem em tratamento" de quem envia, ver [`in_treatment`]), e quem envia tem um número
//! máximo de pedidos novos por janela. Passou de um teto, a mensagem é recusada ANTES de qualquer
//! coisa ser digitada, e a recusa fica gravada com o motivo.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::chat_team::model::THREAD_PREFIX;

/// Dentro desta janela, a mesma mensagem (sem id do chamador) para o mesmo destino é repetida.
pub const DUPLICATE_WINDOW_MS: i64 = 10 * 60 * 1000;
/// No arranque, o que esperava há mais que isto não é mais entregue: vira `expired`.
pub const RESUME_MAX_AGE_MS: i64 = 60 * 60 * 1000;
/// Registros já resolvidos (entregues, cancelados…) ficam este tempo e depois saem.
const KEEP_FINISHED_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A chave (`--id`) de um registro que saiu continua valendo este tempo (tombstone): o mesmo id
/// não roda de novo depois da limpeza de 7 dias.
pub const KEEP_KEYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Tamanho máximo de um id do chamador (`--id`).
const MAX_CLIENT_ID: usize = 128;

/// Profundidade máxima de uma mensagem: sem mensagem em tratamento é 0; quem trata uma de
/// profundidade `d` e pede algo a um terceiro manda `d + 1`. Acima disto, recusa.
pub const MAX_PEER_DEPTH: i64 = 2;
/// A janela da contagem de pedidos novos de uma aba (fan-out).
pub const FANOUT_WINDOW_MS: i64 = 10 * 60 * 1000;
/// Quantos pedidos novos (respostas não contam) uma aba manda na janela.
pub const MAX_FANOUT: i64 = 5;
/// O mesmo para o orquestrador: ele distribui o trabalho da equipe inteira (abrir uma missão de 6
/// integrantes já são 6 pedidos), então o teto dele é maior.
pub const LEAD_MAX_FANOUT: i64 = 15;
/// Uma mensagem recebida e não respondida há mais que isto não está mais "em tratamento".
pub const TREATMENT_WINDOW_MS: i64 = 30 * 60 * 1000;

/// O começo do texto de uma mensagem que já foi tentada antes (ver `attempts`): o destino pode já ter
/// recebido e agido na primeira vez.
pub const RETRY_MARK: &str = "[reenvio; pode já ter sido recebida]";

/// O relógio do SQLite, em ms desde a época. Todo prazo da fila (dedupe, tetos, expiração, limpeza,
/// tombstone) é comparado com colunas gravadas no banco; em produção quem chama o store passa ESTE
/// relógio (ver `ipc/commands/peer_queue.rs::with_db_now`), não o do processo: dois processos que
/// escrevem no mesmo banco (app e CLI) nunca discordam de "agora". Os testes injetam o `now` direto
/// em cada função.
pub fn db_now(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Delivering,
    Delivered,
    Unconfirmed,
    Cancelled,
    Expired,
    Refused,
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
            State::Refused => "refused",
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
            "refused" => State::Refused,
            _ => return None,
        })
    }

    /// As transições permitidas. `unconfirmed`/`expired` → `queued` só num reenvio com o mesmo id:
    /// o app disse ao remetente que a mensagem não chegou (ou nunca foi digitada). `refused` é final.
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
            State::Refused => "recusada",
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
    /// Por que terminou assim (aba fechada, não apareceu na tela, a frase da recusa…).
    pub note: Option<String>,
    /// Quantos repasses entre agentes vieram antes deste (ver [`MAX_PEER_DEPTH`]).
    pub depth: i64,
    /// A mensagem que quem enviou estava tratando quando mandou esta.
    pub parent_id: Option<i64>,
    /// Esta é a resposta (ao remetente) da mensagem `answer_of`: não é um pedido novo.
    pub answer_of: Option<i64>,
    /// O motivo de uma recusa (`depth`, `fanout`, `duplicate`, `unknown_target`…) ou de uma falha de
    /// entrega (`delivery_failed`).
    pub reason: Option<String>,
    /// Só o consumidor de uma conversa (`thread:`): a mensagem não vai antes disto (backoff do retry).
    pub available_at: Option<i64>,
    /// Só o consumidor de uma conversa: até quando a posse dele vale enquanto a mensagem está `delivering`.
    pub lease_until: Option<i64>,
    /// `queue_after_active` ou `steer_active`: como a mensagem foi (ou vai ser) entregue a uma conversa.
    pub delivery_mode: Option<String>,
    /// `ask`: a espera pela resposta acabou (resposta, motivo ou prazo).
    pub settled_at: Option<i64>,
    /// Só conversas: o instante em que o envio à conversa COMEÇOU (gravado ANTES de `session.send`). Sem ele, uma
    /// mensagem `delivering` que o app perdeu de vista provadamente não saiu e pode voltar à fila; com ele e sem o
    /// marcador na timeline, não dá para saber (o motor pode ter escrito e caído antes de gravar o item).
    pub sending_at: Option<i64>,
}

/// Os campos do envelope tipado (`--task`, `--constraints`, `--expecting`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Envelope {
    pub task: Option<String>,
    pub constraints: Option<String>,
    pub expecting: Option<String>,
}

impl Envelope {
    /// Algum campo veio?
    pub fn is_present(&self) -> bool {
        self.task.is_some() || self.constraints.is_some() || self.expecting.is_some()
    }

    /// O bloco fixo que o destino lê. `free` (o texto livre, se veio junto) vira contexto; sem
    /// `--task`, o texto livre é a tarefa. `None` se não há tarefa nenhuma. Pura.
    pub fn text(&self, from_name: &str, free: Option<&str>) -> Option<String> {
        let free = free.map(str::trim).filter(|f| !f.is_empty());
        let (task, context) = match self.task.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(task) => (task, free),
            None => (free?, None),
        };
        let or = |v: &Option<String>, empty: &'static str| v.as_deref().map(str::trim).filter(|v| !v.is_empty()).unwrap_or(empty).to_string();
        let mut out = format!("{from_name} pediu sua ajuda nisto.\nTarefa: {task}\n");
        if let Some(context) = context {
            out.push_str(&format!("Contexto: {context}\n"));
        }
        out.push_str(&format!(
            "Restrições: {}\nComo é uma boa resposta: {}\nResponda como você mesmo.",
            or(&self.constraints, "nenhuma além das suas instruções"),
            or(&self.expecting, "não especificado")
        ));
        Some(out)
    }

    /// Os campos, numa linha, para a chave de idempotência. Pura.
    fn key_part(&self) -> String {
        let n = |v: &Option<String>| normalize(v.as_deref().unwrap_or(""));
        format!("{}\u{1f}{}\u{1f}{}", n(&self.task), n(&self.constraints), n(&self.expecting))
    }
}

/// Os tetos que valem para uma mensagem (`None` = mensagem do próprio app, sem teto).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_depth: i64,
    pub max_fanout: i64,
}

impl Limits {
    /// Os tetos padrão; o orquestrador tem o fan-out maior.
    pub fn for_sender(orchestrator: bool) -> Limits {
        Limits { max_depth: MAX_PEER_DEPTH, max_fanout: if orchestrator { LEAD_MAX_FANOUT } else { MAX_FANOUT } }
    }
}

/// O que chega para entrar na fila.
#[derive(Clone, Debug, Default)]
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
    /// Os campos do envelope (entram na chave de idempotência).
    pub envelope: Option<&'a Envelope>,
    /// Os tetos de profundidade e fan-out. `None` = sem teto.
    pub limits: Option<Limits>,
}

/// Uma recusa de política: o motivo, a frase para quem enviou e a linha gravada.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub reason: &'static str,
    pub message: String,
    pub record: PeerMessage,
}

/// O que `admit` fez com a mensagem.
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    /// Nova (ou um reenvio com o mesmo id de uma que não chegou): vai ser entregue.
    New(PeerMessage),
    /// O mesmo id do chamador já existe: é a MESMA mensagem, e não vai de novo.
    Repeat(PeerMessage),
    /// Sem id, a mesma mensagem já foi (ou está indo) para o mesmo destino há pouco. A recusa
    /// também fica gravada (motivo `duplicate`).
    Duplicate(PeerMessage),
    /// Um `ask` a uma conversa idêntico a outro do mesmo remetente que ainda espera a resposta: não é uma
    /// recusa nem uma pergunta nova, é a MESMA espera. Nada é gravado; quem pergunta espera a mensagem devolvida.
    Joined(PeerMessage),
    /// Um teto (profundidade ou fan-out) recusou a mensagem: nada vai ser digitado.
    Refused(Refusal),
}

/// A tabela inteira, com o nome dado (a migração reconstrói numa tabela nova quando precisa).
fn table_sql(name: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {name} (
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
            state TEXT NOT NULL CHECK(state IN ('queued','delivering','delivered','unconfirmed','cancelled','expired','refused')),
            position INTEGER NOT NULL DEFAULT 0,
            force_now INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            delivered_at INTEGER,
            edited_at INTEGER,
            note TEXT,
            depth INTEGER NOT NULL DEFAULT 0,
            parent_id INTEGER,
            answer_of INTEGER,
            reason TEXT,
            dedupe_key TEXT
        );"
    )
}

/// As colunas da primeira versão da tabela: são as que a reconstrução copia.
const BASE_COLUMNS: &str = "id, client_id, kind, from_tab_id, from_name, to_tab_id, to_name, text, raw, reply, state, \
    position, force_now, attempts, created_at, updated_at, delivered_at, edited_at, note";

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|n| n == column))
}

/// Aditiva e idempotente; não sobe `user_version`. O CHECK do estado não se altera no SQLite: uma
/// tabela antiga (sem `refused`) é reconstruída uma vez, copiando todas as linhas.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&table_sql("peer_messages"))?;
    let sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'peer_messages'",
        [],
        |r| r.get(0),
    )?;
    if !sql.contains("'refused'") {
        conn.execute_batch(&format!(
            "SAVEPOINT peer_messages_v2;
             DROP TABLE IF EXISTS peer_messages_v2;
             {}
             INSERT INTO peer_messages_v2 ({BASE_COLUMNS}) SELECT {BASE_COLUMNS} FROM peer_messages;
             DROP TABLE peer_messages;
             ALTER TABLE peer_messages_v2 RENAME TO peer_messages;
             RELEASE peer_messages_v2;",
            table_sql("peer_messages_v2")
        ))?;
    }
    for (column, ddl) in [
        ("depth", "INTEGER NOT NULL DEFAULT 0"),
        ("parent_id", "INTEGER"),
        ("answer_of", "INTEGER"),
        ("reason", "TEXT"),
        ("dedupe_key", "TEXT"),
        // Etapa 2 (entrega a conversas `thread:`): só o consumidor delas usa.
        ("available_at", "INTEGER"),
        ("lease_until", "INTEGER"),
        ("delivery_mode", "TEXT"),
        ("settled_at", "INTEGER"),
        ("sending_at", "INTEGER"),
    ] {
        if !has_column(conn, "peer_messages", column)? {
            conn.execute_batch(&format!("ALTER TABLE peer_messages ADD COLUMN {column} {ddl};"))?;
        }
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_messages_client
            ON peer_messages(from_tab_id, client_id) WHERE client_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_peer_messages_queue
            ON peer_messages(to_tab_id, state, position);
        CREATE INDEX IF NOT EXISTS idx_peer_messages_from
            ON peer_messages(from_tab_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_peer_messages_dedupe
            ON peer_messages(dedupe_key, created_at) WHERE dedupe_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_peer_messages_ready
            ON peer_messages(to_tab_id, state, available_at, position);
        CREATE TABLE IF NOT EXISTS peer_message_keys (
            from_tab_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            to_tab_id TEXT NOT NULL,
            to_name TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            done_at INTEGER NOT NULL,
            PRIMARY KEY (from_tab_id, client_id)
        );",
    )
}

const COLUMNS: &str = "id, client_id, kind, from_tab_id, from_name, to_tab_id, to_name, text, raw, reply, state, \
    position, force_now, attempts, created_at, updated_at, delivered_at, edited_at, note, depth, parent_id, answer_of, reason, \
    available_at, lease_until, delivery_mode, settled_at, sending_at";

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
        // O CHECK da tabela só deixa os sete; um valor estranho não derruba a lista.
        state: State::parse(&state).unwrap_or(State::Expired),
        position: r.get(11)?,
        force_now: r.get::<_, i64>(12)? != 0,
        attempts: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        delivered_at: r.get(16)?,
        edited_at: r.get(17)?,
        note: r.get(18)?,
        depth: r.get(19)?,
        parent_id: r.get(20)?,
        answer_of: r.get(21)?,
        reason: r.get(22)?,
        available_at: r.get(23)?,
        lease_until: r.get(24)?,
        delivery_mode: r.get(25)?,
        settled_at: r.get(26)?,
        sending_at: r.get(27)?,
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

/// O texto como entra na chave: sem espaços nas pontas e com os brancos de dentro juntados. Pura.
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A chave de idempotência derivada no servidor: hash de remetente, destino, texto normalizado e
/// campos do envelope. Com `--raw` (um comando da TUI) o remetente não entra: o mesmo `/compact` de
/// qualquer um é repetido. Pura.
pub fn dedupe_key(new: &NewMessage<'_>) -> String {
    use sha2::Digest;
    let from = if new.raw { "*" } else { new.from_tab_id };
    let envelope = new.envelope.map(Envelope::key_part).unwrap_or_default();
    let input = format!(
        "v1\u{1e}{}\u{1e}{from}\u{1e}{}\u{1e}{}\u{1e}{envelope}",
        new.raw as u8,
        new.to_tab_id,
        normalize(new.text)
    );
    format!("{:x}", sha2::Sha256::digest(input.as_bytes()))
}

/// Roda `f` numa transação `BEGIN IMMEDIATE` (o lock de escrita é pego já, antes da contagem dos
/// tetos): contar e gravar acontecem juntos, sem outro processo no meio. Dentro de uma transação
/// que já existe, vira um SAVEPOINT.
fn immediate<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let (begin, commit, rollback) = if conn.is_autocommit() {
        ("BEGIN IMMEDIATE", "COMMIT", "ROLLBACK")
    } else {
        ("SAVEPOINT peer_admit", "RELEASE peer_admit", "ROLLBACK TO peer_admit; RELEASE peer_admit")
    };
    conn.execute_batch(begin).map_err(|e| e.to_string())?;
    match f(conn) {
        Ok(value) => {
            if let Err(error) = conn.execute_batch(commit) {
                let _ = conn.execute_batch(rollback);
                return Err(error.to_string());
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch(rollback);
            Err(error)
        }
    }
}

/// A mensagem que `tab` está tratando: a última `tell`/`ask` recebida (entregue, não `--raw`, não
/// uma resposta) há menos de [`TREATMENT_WINDOW_MS`] e que ela ainda não respondeu (não mandou nada
/// ao remetente dela depois). Vem do banco, nunca de uma variável de ambiente que o processo forja.
pub fn in_treatment(conn: &Connection, tab: &str, now: i64) -> Result<Option<PeerMessage>, String> {
    Ok(query(
        conn,
        "AS m WHERE m.to_tab_id = ?1 AND m.from_tab_id != ?1 AND m.kind IN ('tell', 'ask') AND m.raw = 0
           AND m.state = 'delivered' AND m.answer_of IS NULL
           AND COALESCE(m.delivered_at, m.created_at) >= ?2
           AND NOT EXISTS (
             SELECT 1 FROM peer_messages AS r
              WHERE r.from_tab_id = ?1 AND r.to_tab_id = m.from_tab_id AND r.state != 'refused'
                AND r.created_at >= COALESCE(m.delivered_at, m.created_at))
         ORDER BY COALESCE(m.delivered_at, m.created_at) DESC, m.id DESC LIMIT 1",
        params![tab, now - TREATMENT_WINDOW_MS],
    )?
    .into_iter()
    .next())
}

/// De onde vem uma mensagem: profundidade, a mensagem em tratamento e se esta a responde.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Lineage {
    pub depth: i64,
    pub parent_id: Option<i64>,
    pub answer_of: Option<i64>,
}

/// Pura: a linhagem dada a mensagem em tratamento. Responder a quem pediu mantém a profundidade
/// (um vai e volta entre dois agentes nunca cresce); pedir a um terceiro soma um.
pub fn lineage_from(parent: Option<&PeerMessage>, to_tab_id: &str) -> Lineage {
    match parent {
        None => Lineage::default(),
        Some(p) if p.from_tab_id == to_tab_id => Lineage { depth: p.depth, parent_id: Some(p.id), answer_of: Some(p.id) },
        Some(p) => Lineage { depth: p.depth + 1, parent_id: Some(p.id), answer_of: None },
    }
}

fn lineage(conn: &Connection, new: &NewMessage<'_>, now: i64) -> Result<Lineage, String> {
    if new.raw || !matches!(new.kind, "tell" | "ask") {
        return Ok(Lineage::default());
    }
    Ok(lineage_from(in_treatment(conn, new.from_tab_id, now)?.as_ref(), new.to_tab_id))
}

/// Quantos pedidos novos (`tell`/`ask`, sem `--raw`, que não são respostas nem recusas) `from`
/// mandou desde `since`.
pub fn fanout_since(conn: &Connection, from: &str, since: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM peer_messages WHERE from_tab_id = ?1 AND kind IN ('tell', 'ask') AND raw = 0
            AND answer_of IS NULL AND state != 'refused' AND created_at >= ?2",
        params![from, since],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// A frase que oferece saída, comum a toda recusa.
pub const REFUSAL_WAY_OUT: &str = "Responda com o que você tem ou pergunte à pessoa.";

/// Pura: a frase de uma recusa por teto.
pub fn limit_message(reason: &str, to_name: &str, value: i64, cap: i64) -> String {
    match reason {
        "depth" => format!(
            "Não enviei a {to_name}: este pedido já vem de uma cadeia de {value} repasses entre agentes (teto: {cap}). Não repasse de novo; {}",
            lower_first(REFUSAL_WAY_OUT)
        ),
        "fanout" => format!(
            "Não enviei a {to_name}: você já mandou {value} pedidos novos nos últimos {} min (teto: {cap}). Junte os pedidos num só ou espere as respostas; {}",
            FANOUT_WINDOW_MS / 60_000,
            lower_first(REFUSAL_WAY_OUT)
        ),
        _ => format!("Não enviei a {to_name}. {REFUSAL_WAY_OUT}"),
    }
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Pura: a frase da recusa de uma mensagem repetida.
pub fn duplicate_message(to_name: &str, earlier: &PeerMessage) -> String {
    format!(
        "Não enviei de novo a {to_name}: a mesma mensagem já foi há pouco (#{}, {}). {REFUSAL_WAY_OUT} Se é um pedido novo de verdade, mande com um --id novo.",
        earlier.id,
        earlier.state.label()
    )
}

/// Os tetos, só lendo: `Some((motivo, frase, linhagem))` se a mensagem seria recusada. O `peer ask`
/// chama antes de esperar o destino ficar quieto; `admit` repete dentro da transação.
pub fn check_limits(conn: &Connection, new: &NewMessage<'_>, now: i64) -> Result<Option<(&'static str, String, Lineage)>, String> {
    let Some(limits) = new.limits else { return Ok(None) };
    if new.raw || !matches!(new.kind, "tell" | "ask") {
        return Ok(None);
    }
    let lin = lineage(conn, new, now)?;
    let name = if new.to_name.is_empty() { new.to_tab_id } else { new.to_name };
    if lin.depth > limits.max_depth {
        return Ok(Some(("depth", limit_message("depth", name, lin.depth, limits.max_depth), lin)));
    }
    if lin.answer_of.is_none() {
        let sent = fanout_since(conn, new.from_tab_id, now - FANOUT_WINDOW_MS)?;
        if sent >= limits.max_fanout {
            return Ok(Some(("fanout", limit_message("fanout", name, sent, limits.max_fanout), lin)));
        }
    }
    Ok(None)
}

fn insert(conn: &Connection, new: &NewMessage<'_>, client_id: Option<&str>, state: State, lin: Lineage, refusal: Option<(&str, &str)>, now: i64) -> Result<PeerMessage, String> {
    let (position, key) = if state == State::Refused { (0, None) } else { (next_position(conn, new.to_tab_id)?, Some(dedupe_key(new))) };
    // Quem já nasce `delivering` (o `ask` direto) está na primeira tentativa: o reenvio dela conta 2.
    let attempts = (state == State::Delivering) as i64;
    conn.execute(
        "INSERT INTO peer_messages (client_id, kind, from_tab_id, from_name, to_tab_id, to_name, text, raw, reply,
             state, position, created_at, updated_at, depth, parent_id, answer_of, reason, note, dedupe_key, attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
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
            state.as_str(),
            position,
            now,
            lin.depth,
            lin.parent_id,
            lin.answer_of,
            refusal.map(|r| r.0),
            refusal.map(|r| r.1),
            key,
            attempts,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    get(conn, id)?.ok_or_else(|| "A mensagem não foi gravada.".to_string())
}

/// Grava a linha de auditoria de uma recusa de política decidida fora de `admit` (destino que não
/// existe ou é ambíguo, mandar para si mesmo, sem tarefa). Nada é digitado; a linha nunca vai.
pub fn record_refusal(conn: &Connection, new: &NewMessage<'_>, reason: &str, message: &str, now: i64) -> Result<PeerMessage, String> {
    let kind = if matches!(new.kind, "tell" | "ask" | "handoff" | "role" | "notice") { new.kind } else { "tell" };
    let text = if new.text.trim().is_empty() { "(sem texto)" } else { new.text };
    let new = NewMessage { kind, text, ..new.clone() };
    insert(conn, &new, None, State::Refused, Lineage::default(), Some((reason, message)), now)
}

/// A mensagem de um `--id` que não existe mais na tabela, refeita do tombstone.
fn from_tombstone(conn: &Connection, from: &str, cid: &str) -> Result<Option<PeerMessage>, String> {
    conn.query_row(
        "SELECT message_id, kind, to_tab_id, to_name, state, created_at, done_at FROM peer_message_keys
          WHERE from_tab_id = ?1 AND client_id = ?2",
        params![from, cid],
        |r| {
            let state: String = r.get(4)?;
            Ok(PeerMessage {
                id: r.get(0)?,
                client_id: Some(cid.to_string()),
                kind: r.get(1)?,
                from_tab_id: from.to_string(),
                from_name: String::new(),
                to_tab_id: r.get(2)?,
                to_name: r.get(3)?,
                // Nunca vazio: quem reenvia pelo mesmo id (o `peer deliver`) cai de novo no `admit`, que devolve `Repeat`.
                text: "(registro apagado na limpeza)".into(),
                raw: false,
                reply: false,
                state: State::parse(&state).unwrap_or(State::Delivered),
                position: 0,
                force_now: false,
                attempts: 0,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                delivered_at: None,
                edited_at: None,
                note: Some("O registro saiu na limpeza; a chave continua valendo e a mensagem não roda de novo.".into()),
                depth: 0,
                parent_id: None,
                answer_of: None,
                reason: None,
                available_at: None,
                lease_until: None,
                delivery_mode: None,
                settled_at: None,
                sending_at: None,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// A mensagem registrada com este id do chamador (ou o tombstone dela), se houver.
pub fn by_client_id(conn: &Connection, from: &str, client_id: Option<&str>) -> Result<Option<PeerMessage>, String> {
    let Some(cid) = clean_client_id(client_id)? else { return Ok(None) };
    if let Some(found) = query(conn, "WHERE from_tab_id = ?1 AND client_id = ?2", params![from, cid])?.into_iter().next() {
        return Ok(Some(found));
    }
    from_tombstone(conn, from, &cid)
}

/// Registra a mensagem e decide se ela vai: nova, a mesma de um id já usado, repetida ou recusada
/// por um teto. Tudo numa transação `BEGIN IMMEDIATE`: a contagem dos tetos e a gravação andam juntas.
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
    immediate(conn, |conn| admit_inner(conn, new, client_id.as_deref(), initial, now))
}

/// SQL: o destino (`m.to_tab_id`) NÃO mandou nada ao remetente (`m.from_tab_id`) depois de `m`. Usa os
/// parâmetros posicionais de quem o inclui: `NOT_ANSWERED` lê as colunas de `m`, sem parâmetros próprios.
const NOT_ANSWERED: &str = "NOT EXISTS (SELECT 1 FROM peer_messages r WHERE r.from_tab_id = m.to_tab_id AND r.to_tab_id = m.from_tab_id
        AND r.state != 'refused' AND r.created_at > m.created_at)";

/// Um `ask` a uma conversa por protocolo (o que entra na fila de `thread:`).
fn joins_ask(new: &NewMessage<'_>) -> bool {
    new.kind == "ask" && new.reply && new.to_tab_id.starts_with(THREAD_PREFIX)
}

fn admit_inner(conn: &Connection, new: &NewMessage<'_>, client_id: Option<&str>, initial: State, now: i64) -> Result<Admission, String> {
    prune(conn, now)?;

    if let Some(cid) = client_id {
        if let Some(existing) = by_client_id(conn, new.from_tab_id, Some(cid))? {
            if existing.to_tab_id != new.to_tab_id {
                return Err(format!(
                    "O id '{cid}' já foi usado na mensagem #{} para {}. Use outro id para outra mensagem.",
                    existing.id,
                    if existing.to_name.is_empty() { &existing.to_tab_id } else { &existing.to_name }
                ));
            }
            // Não chegou (ou nunca foi digitada): o reenvio com o mesmo id a põe de novo na fila.
            // (Um tombstone não tem linha para voltar: é sempre repetição.)
            if existing.state.can_become(State::Queued) && get(conn, existing.id)?.is_some() {
                let position = next_position(conn, new.to_tab_id)?;
                conn.execute(
                    // `attempts` fica (o `claim` soma): a que já foi tentada chega como reenvio. No direto
                    // (`delivering`) não há `claim`, então a tentativa conta aqui.
                    "UPDATE peer_messages SET state = ?1, position = ?2, force_now = 0, note = NULL, updated_at = ?3,
                        attempts = attempts + (CASE WHEN ?1 = 'delivering' THEN 1 ELSE 0 END) WHERE id = ?4",
                    params![initial.as_str(), position, now, existing.id],
                )
                .map_err(|e| e.to_string())?;
                let again = get(conn, existing.id)?.ok_or("A mensagem sumiu da fila.")?;
                return Ok(Admission::New(again));
            }
            return Ok(Admission::Repeat(existing));
        }
    } else if joins_ask(new) {
        // Um `ask` a uma conversa que ainda espera resposta: repeti-lo não faz outra pergunta nem outra
        // espera, devolve a mesma (a recusa por prazo, no `ask`, diz para não perguntar de novo).
        let found = query(
            conn,
            &format!("AS m WHERE m.kind = 'ask' AND m.reply = 1 AND m.from_tab_id = ?1 AND m.to_tab_id = ?2 AND m.dedupe_key = ?3
                AND m.settled_at IS NULL AND m.state IN ('queued', 'delivering', 'delivered') AND m.created_at >= ?4 AND {NOT_ANSWERED}
             ORDER BY m.id DESC LIMIT 1"),
            params![new.from_tab_id, new.to_tab_id, dedupe_key(new), now - DUPLICATE_WINDOW_MS],
        )?;
        if let Some(existing) = found.into_iter().next() {
            return Ok(Admission::Joined(existing));
        }
    } else if !new.reply {
        // Sem id, vale a chave derivada no servidor (sobrevive ao reinício): mesmo remetente (com
        // `--raw`, qualquer um), mesmo destino, mesmo texto normalizado e mesmo envelope, há menos de
        // 10 min. A que não se confirmou ou foi cancelada não conta: o reenvio dela passa. Também não
        // conta se o destino falou com o remetente depois (um «Concluído» de uma rodada nova): a conversa
        // andou e a repetição é uma mensagem nova (continua valendo o teto de fan-out).
        let found = query(
            conn,
            &format!("AS m WHERE m.dedupe_key = ?1 AND m.reply = 0 AND m.state IN ('queued', 'delivering', 'delivered') AND m.created_at >= ?2
                AND (?3 = 1 OR {NOT_ANSWERED})
             ORDER BY m.id DESC LIMIT 1"),
            params![dedupe_key(new), now - DUPLICATE_WINDOW_MS, new.raw as i64],
        )?;
        if let Some(existing) = found.into_iter().next() {
            let name = if new.to_name.is_empty() { new.to_tab_id } else { new.to_name };
            if matches!(new.kind, "tell" | "ask") {
                insert(conn, new, None, State::Refused, Lineage::default(), Some(("duplicate", &duplicate_message(name, &existing))), now)?;
            }
            return Ok(Admission::Duplicate(existing));
        }
    }

    if let Some((reason, message, lin)) = check_limits(conn, new, now)? {
        let record = insert(conn, new, None, State::Refused, lin, Some((reason, &message)), now)?;
        return Ok(Admission::Refused(Refusal { reason, message, record }));
    }
    let lin = lineage(conn, new, now)?;
    Ok(Admission::New(insert(conn, new, client_id, initial, lin, None, now)?))
}

/// Apaga os registros já resolvidos há mais de 7 dias. A fila em si nunca é apagada. A chave
/// (`--id`) de cada um que sai fica num tombstone por [`KEEP_KEYS_MS`]: apagar a linha devolvia a
/// chave, e o mesmo id rodava de novo.
pub fn prune(conn: &Connection, now: i64) -> Result<usize, String> {
    let cutoff = now - KEEP_FINISHED_MS;
    conn.execute(
        "INSERT OR IGNORE INTO peer_message_keys (from_tab_id, client_id, message_id, kind, to_tab_id, to_name, state, created_at, done_at)
         SELECT from_tab_id, client_id, id, kind, to_tab_id, to_name, state, created_at, updated_at FROM peer_messages
          WHERE client_id IS NOT NULL AND state IN ('delivered', 'unconfirmed', 'cancelled', 'expired') AND updated_at < ?1",
        [cutoff],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM peer_message_keys WHERE done_at < ?1", [now - KEEP_KEYS_MS]).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM peer_messages WHERE state IN ('delivered', 'unconfirmed', 'cancelled', 'expired', 'refused') AND updated_at < ?1",
        [cutoff],
    )
    .map_err(|e| e.to_string())
}

/// As recusas que um remetente recebeu (a auditoria), mais novas primeiro.
pub fn refusals_from(conn: &Connection, from: &str, limit: i64) -> Result<Vec<PeerMessage>, String> {
    query(conn, "WHERE from_tab_id = ?1 AND state = 'refused' ORDER BY id DESC LIMIT ?2", params![from, limit])
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
            "UPDATE peer_messages SET state = ?1, delivered_at = ?2, note = ?3, updated_at = ?4, lease_until = NULL WHERE id = ?5 AND state = 'delivering'",
            params![state.as_str(), confirmed.then_some(now), note, now, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

// ── Entrega a uma conversa por protocolo (`thread:`) ───────────────────
// O consumidor da conversa (`thread_outbox`) é o único que usa estas funções. A mensagem de um
// terminal segue `claim`/`finish`; aqui a diferença é poder VOLTAR à fila (`release`) quando o envio
// provadamente não aconteceu, e terminar como falha de entrega (`fail_delivery`).

/// O motivo gravado numa mensagem que esgotou as tentativas ou não tem mais para onde ir.
pub const DELIVERY_FAILED: &str = "delivery_failed";

/// Toma a mensagem para enviar a uma conversa: `queued` → `delivering` numa só escrita, com a posse
/// (`lease_until`) e o modo de entrega. `None` se ela saiu da fila nesse meio tempo.
pub fn claim_for_thread(conn: &Connection, id: i64, mode: &str, now: i64, lease_ms: i64) -> Result<Option<PeerMessage>, String> {
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = 'delivering', attempts = attempts + 1, updated_at = ?1, available_at = NULL, sending_at = NULL,
                lease_until = ?2, delivery_mode = ?3 WHERE id = ?4 AND state = 'queued'",
            params![now, now + lease_ms, mode, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, id)
}

/// As mensagens `delivering` de uma conversa (`thread:`) cuja posse não vale mais: `all` (no arranque, quando
/// nenhum consumidor está vivo) ou com o `lease_until` vencido. É o que a recuperação verifica.
pub fn delivering_for_threads(conn: &Connection, to: Option<&str>, all: bool, now: i64) -> Result<Vec<PeerMessage>, String> {
    query(
        conn,
        "WHERE state = 'delivering' AND to_tab_id LIKE 'thread:%' AND (?1 IS NULL OR to_tab_id = ?1)
           AND (?2 = 1 OR lease_until IS NULL OR lease_until < ?3) ORDER BY position, id",
        params![to, all as i64, now],
    )
}

/// A espera de um `ask` acabou com resposta, parada ou falha: ele deixa de valer como «em andamento». Um prazo
/// vencido NÃO encerra: o mesmo `ask` repetido continua juntando-se à mesma espera.
pub fn settle_ask(conn: &Connection, id: i64, now: i64) -> Result<bool, String> {
    let changed = conn
        .execute("UPDATE peer_messages SET settled_at = ?1 WHERE id = ?2 AND settled_at IS NULL", params![now, id])
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// Grava que o envio à conversa vai COMEÇAR (antes de `session.send`): é a prova, no banco, de que antes disto nada saiu.
pub fn mark_sending(conn: &Connection, id: i64, now: i64) -> Result<bool, String> {
    let changed = conn
        .execute("UPDATE peer_messages SET sending_at = ?1 WHERE id = ?2 AND state = 'delivering'", params![now, id])
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// O envio provadamente não aconteceu: a mensagem volta ao início da fila. `available_at` = quando pode
/// ir de novo (backoff; `None` = já). `refund`: a tentativa não conta (a conversa só estava ocupada).
pub fn release(conn: &Connection, id: i64, note: Option<&str>, available_at: Option<i64>, refund: bool, now: i64) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = 'queued', note = ?1, available_at = ?2, lease_until = NULL, sending_at = NULL, updated_at = ?3,
                attempts = attempts - ?4 WHERE id = ?5 AND state = 'delivering'",
            params![note, available_at, now, refund as i64, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// A entrega a uma conversa falhou de vez (tentativas esgotadas): `expired` com o motivo `delivery_failed`.
pub fn fail_delivery(conn: &Connection, id: i64, note: &str, now: i64) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE peer_messages SET state = 'expired', reason = ?1, note = ?2, lease_until = NULL, updated_at = ?3
              WHERE id = ?4 AND state = 'delivering'",
            params![DELIVERY_FAILED, note, now, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// Tudo o que esperava uma conversa que não existe mais (concluída, apagada) vira `expired` com o motivo
/// `delivery_failed`. Devolve as que expiraram (para o aviso ao remetente).
pub fn expire_undeliverable(conn: &Connection, to: &str, note: &str, now: i64) -> Result<Vec<PeerMessage>, String> {
    let expired = expire_queued_for(conn, to, note, now)?;
    for msg in &expired {
        conn.execute("UPDATE peer_messages SET reason = ?1 WHERE id = ?2", params![DELIVERY_FAILED, msg.id]).map_err(|e| e.to_string())?;
    }
    expired.iter().filter_map(|m| get(conn, m.id).transpose()).collect()
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

/// Tudo o que esperava um destino que não existe mais vira `expired`. Devolve as que expiraram (para
/// o aviso ao remetente, ver [`failure_notice`]).
pub fn expire_queued_for(conn: &Connection, to: &str, note: &str, now: i64) -> Result<Vec<PeerMessage>, String> {
    let waiting = query(conn, "WHERE to_tab_id = ?1 AND state = 'queued' ORDER BY position, id", [to])?;
    let mut out = Vec::new();
    for msg in waiting {
        let changed = conn
            .execute(
                "UPDATE peer_messages SET state = 'expired', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'queued'",
                params![note, now, msg.id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 1 {
            out.extend(get(conn, msg.id)?);
        }
    }
    Ok(out)
}

/// Pura: o começo do pedido, numa linha, para o aviso de falha. No envelope, a linha `Tarefa:`.
pub fn task_gist(text: &str) -> String {
    const MAX: usize = 120;
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let line = lines
        .iter()
        .find_map(|l| l.strip_prefix("Tarefa:").map(str::trim))
        .or_else(|| lines.iter().copied().find(|l| !l.ends_with("pediu sua ajuda nisto.")))
        .unwrap_or("");
    let flat = normalize(line);
    if flat.chars().count() <= MAX {
        return flat;
    }
    let cut: String = flat.chars().take(MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Pura: o aviso à aba que mandou uma mensagem que não chegou (`expired`) ou que foi digitada sem
/// aparecer na tela (`unconfirmed`).
pub fn failure_text(failed: &PeerMessage) -> String {
    let to = if failed.to_name.is_empty() { &failed.to_tab_id } else { &failed.to_name };
    let why = failed
        .note
        .as_deref()
        .map(|n| lower_first(n.trim().trim_end_matches('.')))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| failed.state.label().to_string());
    let outcome = if failed.state == State::Unconfirmed { "e não há confirmação de que chegou" } else { "e não chegou" };
    format!(
        "[AGS] Você pediu a {to}: \"{}\" {outcome} ({why}). Diga isso à pessoa e ofereça o que você mesmo pode fazer.",
        task_gist(&failed.text)
    )
}

/// A chave do aviso de falha: uma por mensagem e tentativa. Dois avisos para o mesmo destino (dois
/// pedidos diferentes) nunca colapsam; a mesma falha processada duas vezes é o mesmo aviso. Pura.
pub fn failure_key(failed: &PeerMessage) -> String {
    format!("falha-entrega-{}-{}", failed.id, failed.attempts)
}

/// Enfileira para o REMETENTE o aviso de que a mensagem dele terminou sem ser entregue
/// (`unconfirmed` ou `expired`). Nunca para um aviso (`notice` não gera `notice`, então um aviso que
/// falha não vira outro), nem para quem mandou a si mesmo. Sem teto (é do app: `limits: None`, e o
/// `notice` não conta no fan-out). Quem chama confere antes que o remetente ainda existe.
pub fn failure_notice(conn: &Connection, failed: &PeerMessage, now: i64) -> Result<Option<PeerMessage>, String> {
    if failed.kind == "notice" || failed.from_tab_id == failed.to_tab_id || failed.from_tab_id.is_empty() {
        return Ok(None);
    }
    if !matches!(failed.state, State::Unconfirmed | State::Expired) {
        return Ok(None);
    }
    let key = failure_key(failed);
    let text = failure_text(failed);
    let new = NewMessage {
        client_id: Some(&key),
        kind: "notice",
        from_tab_id: &failed.from_tab_id,
        from_name: "ADE AGS",
        to_tab_id: &failed.from_tab_id,
        to_name: &failed.from_name,
        text: &text,
        raw: true,
        reply: false,
        envelope: None,
        limits: None,
    };
    Ok(match admit(conn, &new, State::Queued, now)? {
        Admission::New(msg) => Some(msg),
        _ => None,
    })
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
/// fila deve voltar a andar. Cada mensagem que terminou ali (`expired`/`unconfirmed`) gera o aviso
/// ao remetente, se ele ainda está aberto (ver [`failure_notice`]); a aba dele entra nos destinos.
pub fn resume(conn: &Connection, live_tabs: &HashSet<String>, now: i64) -> Result<Vec<String>, String> {
    let pending = query(conn, "WHERE state IN ('queued', 'delivering') ORDER BY id", [])?;
    let mut targets: Vec<String> = Vec::new();
    let mut failed: Vec<i64> = Vec::new();
    for msg in pending {
        // Uma mensagem sendo enviada a uma CONVERSA não vira `unconfirmed` às cegas: a recuperação
        // (`thread_outbox::recover`) procura o marcador dela na timeline e decide se chegou.
        if msg.state == State::Delivering && msg.to_tab_id.starts_with(THREAD_PREFIX) {
            if !targets.contains(&msg.to_tab_id) {
                targets.push(msg.to_tab_id.clone());
            }
            continue;
        }
        let (sql, note) = match resume_decision(&msg, live_tabs, now) {
            Resume::Keep => {
                if !targets.contains(&msg.to_tab_id) {
                    targets.push(msg.to_tab_id.clone());
                }
                continue;
            }
            Resume::Expire(note) => ("UPDATE peer_messages SET state = 'expired', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'queued'", note),
            Resume::Unconfirm(note) => (
                "UPDATE peer_messages SET state = 'unconfirmed', note = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'delivering'",
                note,
            ),
        };
        if conn.execute(sql, params![note, now, msg.id]).map_err(|e| e.to_string())? == 1 {
            failed.push(msg.id);
        }
    }
    for id in failed {
        let Some(msg) = get(conn, id)? else { continue };
        if !live_tabs.contains(&msg.from_tab_id) {
            continue;
        }
        if let Some(notice) = failure_notice(conn, &msg, now)?
            && !targets.contains(&notice.to_tab_id)
        {
            targets.push(notice.to_tab_id);
        }
    }
    targets.sort();
    Ok(targets)
}
