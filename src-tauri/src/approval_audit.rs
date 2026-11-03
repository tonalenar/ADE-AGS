//! A auditoria das aprovações, com um vocabulário só para a frota e o chat.
//!
//! Antes eram dois caminhos: a frota anotava em `task_approvals` (`allowed`/`denied`, `decided_by` =
//! `user`/`rule`/`timeout`/`cancelled`/`policy`) e o chat em `chat_request` (`answered`/`expired`, a
//! escolha crua do motor). Para responder "o que foi liberado, por quem, e o que ficou sem resposta"
//! era preciso juntar os dois. As tabelas de origem continuam como estão; esta é o registro comum.
//!
//! Cada pedido gera um par de eventos:
//! - `asked`: id próprio, a origem (`fleet`/`chat`), o pedido (`call_id`: o id em `task_approvals` ou
//!   `chat_request`), o dono (tarefa ou conversa) e o NOME da ferramenta. Os argumentos não são
//!   copiados: ficam no pedido, e um comando pode levar um segredo.
//! - `decided`: id próprio, apontando para o `asked` (`asked_id`) e o mesmo `call_id`, com um
//!   resultado FECHADO ([`Outcome`]). Só `allowed-once` libera a ferramenta.
//!
//! Um pedido tem no máximo um `decided`: o índice único faz a primeira decisão valer, como no agente,
//! que só lê a primeira resposta. Gravar aqui é best-effort: uma falha do registro nunca muda a
//! resposta ao agente.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    // Tabela nova e aditiva, sem subir `user_version` (ver o fim de `database/schema.rs`).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS approval_events (
            id         TEXT PRIMARY KEY,
            phase      TEXT NOT NULL CHECK(phase IN ('asked','decided')),
            source     TEXT NOT NULL CHECK(source IN ('fleet','chat')),
            call_id    TEXT NOT NULL,
            -- No `decided`: o id do `asked` deste pedido.
            asked_id   TEXT,
            -- A tarefa (frota) ou a conversa (chat).
            owner      TEXT,
            -- No `asked`: o nome da ferramenta ou o tipo do pedido. Nunca os argumentos.
            tool       TEXT,
            outcome    TEXT CHECK(outcome IS NULL OR outcome IN ('allowed-once','rejected','cancelled','unavailable')),
            -- No `allowed-once`: `session` quando a pessoa liberou também o resto da conversa.
            scope      TEXT,
            -- Quem decidiu: `user`/`person`, `rule`/`rule:<id>`, `policy`, `timeout`, `expired`, `app-closed`.
            decided_by TEXT,
            at         INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_events_call ON approval_events(source, call_id, phase);",
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// A frota headless (`runs/broker.rs`).
    Fleet,
    /// As conversas por protocolo (`conversa/`), decididas pela pessoa, pela política ou por regra.
    Chat,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Fleet => "fleet",
            Source::Chat => "chat",
        }
    }
}

/// O resultado fechado de um pedido. Só [`Outcome::AllowedOnce`] libera.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Liberado para ESTA chamada (uma regra que libera também conta como uma vez por chamada).
    AllowedOnce,
    /// Negado: pela pessoa, por uma regra ou pela política do papel.
    Rejected,
    /// O pedido deixou de existir antes da decisão: a tarefa foi cancelada, o turno acabou, o app fechou.
    Cancelled,
    /// Não havia quem decidisse a tempo (o prazo venceu). Nega, mas não é decisão de ninguém.
    Unavailable,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::AllowedOnce => "allowed-once",
            Outcome::Rejected => "rejected",
            Outcome::Cancelled => "cancelled",
            Outcome::Unavailable => "unavailable",
        }
    }

    pub fn parse(value: &str) -> Option<Outcome> {
        [Outcome::AllowedOnce, Outcome::Rejected, Outcome::Cancelled, Outcome::Unavailable]
            .into_iter()
            .find(|o| o.as_str() == value)
    }

    /// Se a ferramenta pode rodar. É a única pergunta que importa para o agente.
    pub fn releases(self) -> bool {
        self == Outcome::AllowedOnce
    }
}

/// A escolha que uma conversa manda ao motor (`allow`, `allowSession`, `deny`, `cancel`), no vocabulário
/// comum. `allowSession` libera esta chamada (e o motor lembra o resto da sessão: `scope = session`).
pub fn outcome_of_choice(choice: &str) -> (Outcome, Option<&'static str>) {
    match choice {
        "allow" => (Outcome::AllowedOnce, None),
        "allowSession" => (Outcome::AllowedOnce, Some("session")),
        // `resolved`: o próprio motor desistiu do pedido (turno interrompido, cancelado pelo agente).
        "cancel" | "resolved" => (Outcome::Cancelled, None),
        // `deny`, `decline` e qualquer coisa que não seja liberar: falha fechada.
        _ => (Outcome::Rejected, None),
    }
}

/// Anota o `asked`. Idempotente: um segundo `asked` do mesmo pedido devolve o id do primeiro.
pub fn asked(conn: &Connection, source: Source, call_id: &str, owner: &str, tool: &str, at: i64) -> rusqlite::Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO approval_events (id, phase, source, call_id, owner, tool, at)
         VALUES (?1, 'asked', ?2, ?3, ?4, ?5, ?6)",
        params![id, source.as_str(), call_id, owner, tool, at],
    )?;
    conn.query_row(
        "SELECT id FROM approval_events WHERE source = ?1 AND call_id = ?2 AND phase = 'asked'",
        params![source.as_str(), call_id],
        |r| r.get(0),
    )
}

/// Anota o `decided`. `true` = esta foi a decisão do pedido; `false` = já havia uma (vale a primeira) ou o
/// pedido nunca foi anotado como `asked` (uma pergunta do chat, que não é aprovação).
pub fn decided(
    conn: &Connection,
    source: Source,
    call_id: &str,
    outcome: Outcome,
    scope: Option<&str>,
    by: &str,
    at: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO approval_events (id, phase, source, call_id, asked_id, owner, outcome, scope, decided_by, at)
         SELECT ?1, 'decided', source, call_id, id, owner, ?4, ?5, ?6, ?7
           FROM approval_events WHERE source = ?2 AND call_id = ?3 AND phase = 'asked'",
        params![Uuid::new_v4().to_string(), source.as_str(), call_id, outcome.as_str(), scope, by, at],
    )?;
    Ok(n == 1)
}

/// Um evento lido de volta (para a tela e os testes).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub phase: String,
    pub call_id: String,
    pub asked_id: Option<String>,
    pub owner: Option<String>,
    pub tool: Option<String>,
    pub outcome: Option<String>,
    pub scope: Option<String>,
    pub decided_by: Option<String>,
    pub at: i64,
}

/// O par de um pedido: `(asked, decided)`.
pub fn pair(conn: &Connection, source: Source, call_id: &str) -> rusqlite::Result<(Option<Event>, Option<Event>)> {
    let read = |phase: &str| {
        conn.query_row(
            "SELECT id, phase, call_id, asked_id, owner, tool, outcome, scope, decided_by, at
               FROM approval_events WHERE source = ?1 AND call_id = ?2 AND phase = ?3",
            params![source.as_str(), call_id, phase],
            |r| {
                Ok(Event {
                    id: r.get(0)?,
                    phase: r.get(1)?,
                    call_id: r.get(2)?,
                    asked_id: r.get(3)?,
                    owner: r.get(4)?,
                    tool: r.get(5)?,
                    outcome: r.get(6)?,
                    scope: r.get(7)?,
                    decided_by: r.get(8)?,
                    at: r.get(9)?,
                })
            },
        )
        .optional()
    };
    Ok((read("asked")?, read("decided")?))
}

#[cfg(test)]
mod test;
