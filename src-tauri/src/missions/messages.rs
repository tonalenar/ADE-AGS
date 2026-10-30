//! O texto das mensagens entre os agentes de uma missão, para o chat unificado da equipe.
//!
//! Só se grava o que um agente de uma missão manda a outro da MESMA missão (`peer tell`/`ask`);
//! fora de missão nada é guardado. A tabela é criada sob demanda, como a de Decisões, e cada
//! missão guarda no máximo `KEEP` mensagens (as mais novas).

use rusqlite::{params, Connection};

use crate::canvas::{team_scope_of_tab, Boards};

/// Quantas mensagens ficam por missão.
const KEEP: i64 = 2_000;
/// O texto de uma mensagem passa disto e é cortado: o chat mostra um resumo, o terminal tem o resto.
const MAX_TEXT: usize = 6_000;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionMessage {
    pub id: i64,
    pub mission_id: String,
    pub at_ms: i64,
    /// `tell` (aviso/tarefa), `ask` (pergunta que espera resposta) ou `handoff` (entrega
    /// estruturada; o JSON inteiro fica em `mission_handoffs`).
    pub kind: String,
    pub from_tab_id: String,
    pub from_name: String,
    pub to_tab_id: String,
    pub to_name: String,
    pub text: String,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mission_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mission_id TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            from_tab_id TEXT NOT NULL,
            from_name TEXT NOT NULL,
            to_tab_id TEXT NOT NULL,
            to_name TEXT NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mission_messages_mission ON mission_messages(mission_id, id);
        CREATE TABLE IF NOT EXISTS mission_handoffs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mission_id TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            from_name TEXT NOT NULL,
            to_name TEXT NOT NULL,
            payload TEXT NOT NULL
        );",
    )
}

fn clip(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    // O reticências entra DENTRO do limite: o texto guardado nunca passa de MAX_TEXT.
    let mut out: String = text.chars().take(MAX_TEXT - 1).collect();
    out.push('…');
    out
}

/// Guarda a mensagem se os dois lados são da mesma missão. Devolve `true` se gravou.
#[allow(clippy::too_many_arguments)]
pub fn record(
    conn: &Connection,
    boards: &Boards,
    kind: &str,
    from: (&str, &str),
    to: (&str, &str),
    text: &str,
    at_ms: i64,
) -> Result<bool, String> {
    record_inner(conn, boards, kind, from, to, text, at_ms, false)
}

/// Aviso do Vigia à missão da aba: o destino é o Orquestrador, sem inventar um peer.
pub fn record_vigia(conn: &Connection, boards: &Boards, lead: (&str, &str), text: &str, at_ms: i64) -> Result<bool, String> {
    record_inner(conn, boards, "tell", (lead.0, "Vigia"), lead, text, at_ms, true)
}

/// O chat da equipe de uma aba (ou de uma conversa por protocolo, `thread:<id>`): o do time do modo
/// chat, se ela está num (`t:<id>`, ver `crate::chat_team`); senão o da missão ou da conversa de projeto
/// do canvas. O time vem primeiro porque uma conversa por protocolo não é nó de nenhum canvas.
pub fn scope_of(conn: &Connection, boards: &Boards, tab: &str) -> Option<String> {
    crate::chat_team::api::scope_of(conn, tab).or_else(|| team_scope_of_tab(boards, tab))
}

/// Em que chat a mensagem entra. Na mesma missão ou conversa, nela; uma missão só fala dentro dela. Numa conversa
/// (`c:`), o que um agente diz a outro de outra conversa (ou sem conversa) entra no chat de quem fala, ou no de
/// quem recebe se quem fala não tem time: antes era descartada calada, e o chat ficava vazio com o orquestrador
/// e o subagente em canvases diferentes. Pura.
pub(crate) fn shared_scope(from: Option<String>, to: Option<String>) -> Option<String> {
    let open = |scope: &Option<String>| scope.as_deref().map_or(true, |s| s.starts_with("c:"));
    match (from, to) {
        (Some(a), Some(b)) if a == b => Some(a),
        (Some(a), to) if a.starts_with("c:") && open(&to) => Some(a),
        (None, Some(b)) if b.starts_with("c:") => Some(b),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn record_inner(
    conn: &Connection, boards: &Boards, kind: &str, from: (&str, &str), to: (&str, &str),
    text: &str, at_ms: i64, notice: bool,
) -> Result<bool, String> {
    if !matches!(kind, "tell" | "ask" | "handoff") || text.trim().is_empty() || (from.0 == to.0 && !notice) {
        return Ok(false);
    }
    // O chat da equipe vale para uma missão e também para uma conversa de projeto (`c:<id>`).
    let Some(mission) = shared_scope(scope_of(conn, boards, from.0), scope_of(conn, boards, to.0)) else {
        return Ok(false);
    };
    migrate(conn).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO mission_messages (mission_id, at_ms, kind, from_tab_id, from_name, to_tab_id, to_name, text) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![mission, at_ms, kind, from.0, from.1, to.0, to.1, clip(text)],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM mission_messages WHERE mission_id=?1 AND id <= (SELECT id FROM mission_messages WHERE mission_id=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
        params![mission, KEEP],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Guarda uma entrega estruturada: o JSON inteiro (já validado) em `mission_handoffs` e o texto
/// legível no chat da equipe. Devolve o id da entrega, ou `None` fora de missão.
pub fn record_handoff(
    conn: &Connection,
    boards: &Boards,
    from: (&str, &str),
    to: (&str, &str),
    readable: &str,
    payload: &str,
    at_ms: i64,
) -> Result<Option<i64>, String> {
    let Some(mission) = scope_of(conn, boards, from.0) else { return Ok(None) };
    if !record_inner(conn, boards, "handoff", from, to, readable, at_ms, false)? {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO mission_handoffs (mission_id, at_ms, from_name, to_name, payload) VALUES (?1,?2,?3,?4,?5)",
        params![mission, at_ms, from.1, to.1, payload],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(conn.last_insert_rowid()))
}

/// Uma entrega pelo id: (missão, de quem, JSON). Só leitura.
pub fn handoff(conn: &Connection, id: i64) -> Result<Option<(String, String, String)>, String> {
    migrate(conn).map_err(|e| e.to_string())?;
    match conn.query_row(
        "SELECT mission_id, from_name, payload FROM mission_handoffs WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// As mensagens da missão depois de `after_id`, da mais antiga à mais nova.
pub fn list(conn: &Connection, mission_id: &str, after_id: i64, limit: i64) -> Result<Vec<MissionMessage>, String> {
    migrate(conn).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, mission_id, at_ms, kind, from_tab_id, from_name, to_tab_id, to_name, text FROM mission_messages \
             WHERE mission_id=?1 AND id > ?2 ORDER BY id ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![mission_id, after_id, limit.clamp(1, 500)], |r| {
            Ok(MissionMessage {
                id: r.get(0)?,
                mission_id: r.get(1)?,
                at_ms: r.get(2)?,
                kind: r.get(3)?,
                from_tab_id: r.get(4)?,
                from_name: r.get(5)?,
                to_tab_id: r.get(6)?,
                to_name: r.get(7)?,
                text: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn mission_messages(
    db: tauri::State<crate::database::DbConnection>,
    mission_id: String,
    after_id: Option<i64>,
) -> Result<Vec<MissionMessage>, String> {
    let conn = db.lock().map_err(|_| "o banco de dados não está disponível".to_string())?;
    list(&conn, &mission_id, after_id.unwrap_or(0), 500)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::Board;
    use serde_json::json;

    fn boards() -> Boards {
        let mut boards = Boards::new();
        let mission = Board { nodes: json!({ "lead": {}, "back": {} }), orchestrators: vec!["lead".into()], ..Default::default() };
        boards.insert("C:/p#m:m1".into(), mission);
        let other = Board { nodes: json!({ "stranger": {} }), ..Default::default() };
        boards.insert("C:/p#m:m2".into(), other);
        boards
    }

    #[test]
    fn a_entrega_estruturada_fica_inteira_e_o_chat_mostra_o_texto() {
        let conn = Connection::open_in_memory().unwrap();
        let b = boards();
        let id = record_handoff(&conn, &b, ("back", "Backend"), ("lead", "Orquestrador"), "Entrega: X", r#"{"version":1}"#, 5).unwrap().unwrap();
        let (mission, from, payload) = handoff(&conn, id).unwrap().unwrap();
        assert_eq!((mission.as_str(), from.as_str(), payload.as_str()), ("m1", "Backend", r#"{"version":1}"#));
        let chat = list(&conn, "m1", 0, 10).unwrap();
        assert_eq!((chat[0].kind.as_str(), chat[0].text.as_str()), ("handoff", "Entrega: X"));
        // Fora da missão não grava nada.
        assert_eq!(record_handoff(&conn, &b, ("ghost", "G"), ("lead", "O"), "x", "{}", 6).unwrap(), None);
        assert_eq!(handoff(&conn, id + 1).unwrap(), None);
    }

    #[test]
    fn grava_so_entre_agentes_da_mesma_missao() {
        let conn = Connection::open_in_memory().unwrap();
        let b = boards();
        assert!(record(&conn, &b, "tell", ("lead", "Orquestrador"), ("back", "Backend"), "faça X", 10).unwrap());
        // de outra missão, de fora de missão, vazio ou para si mesmo: nada
        assert!(!record(&conn, &b, "tell", ("lead", "O"), ("stranger", "S"), "oi", 11).unwrap());
        assert!(!record(&conn, &b, "tell", ("ghost", "G"), ("back", "B"), "oi", 12).unwrap());
        assert!(!record(&conn, &b, "tell", ("lead", "O"), ("back", "B"), "   ", 13).unwrap());
        assert!(!record(&conn, &b, "tell", ("lead", "O"), ("lead", "O"), "eco", 14).unwrap());
        assert!(!record(&conn, &b, "say", ("lead", "O"), ("back", "B"), "x", 15).unwrap());
        let all = list(&conn, "m1", 0, 100).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].from_name.as_str(), all[0].to_name.as_str(), all[0].text.as_str()), ("Orquestrador", "Backend", "faça X"));
        assert!(list(&conn, "m2", 0, 100).unwrap().is_empty());
    }

    #[test]
    fn lista_depois_de_um_id_e_corta_texto_enorme_e_historico_antigo() {
        let conn = Connection::open_in_memory().unwrap();
        let b = boards();
        record(&conn, &b, "ask", ("lead", "O"), ("back", "B"), "um", 1).unwrap();
        record(&conn, &b, "tell", ("back", "B"), ("lead", "O"), "dois", 2).unwrap();
        let first = list(&conn, "m1", 0, 100).unwrap();
        assert_eq!(first.len(), 2);
        let after = list(&conn, "m1", first[0].id, 100).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].text, "dois");

        record(&conn, &b, "tell", ("lead", "O"), ("back", "B"), &"a".repeat(MAX_TEXT + 50), 3).unwrap();
        let big = list(&conn, "m1", 0, 100).unwrap().pop().unwrap();
        assert_eq!(big.text.chars().count(), MAX_TEXT);
        assert!(big.text.ends_with('…'));

        for n in 0..(KEEP + 10) {
            record(&conn, &b, "tell", ("lead", "O"), ("back", "B"), &format!("m{n}"), 100 + n).unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM mission_messages WHERE mission_id='m1'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, KEEP);
    }

    #[test]
    fn vigia_vai_uma_vez_ao_feed_da_missao_sem_liberar_peer_para_si_mesmo() {
        let conn = Connection::open_in_memory().unwrap();
        let b = boards();
        assert!(record_vigia(&conn, &b, ("lead", "Orquestrador"), "**Vigia** — aviso", 10).unwrap());
        assert!(!record_vigia(&conn, &b, ("ghost", "Fora"), "não guardar", 11).unwrap());
        assert!(!record(&conn, &b, "tell", ("lead", "Vigia"), ("lead", "Orquestrador"), "eco peer", 12).unwrap());
        let all = list(&conn, "m1", 0, 100).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].kind.as_str(), all[0].from_name.as_str(), all[0].to_name.as_str()), ("tell", "Vigia", "Orquestrador"));
        assert_eq!((all[0].from_tab_id.as_str(), all[0].to_tab_id.as_str()), ("lead", "lead"));
        assert_eq!(all[0].text, "**Vigia** — aviso");
        assert!(list(&conn, "m2", 0, 100).unwrap().is_empty());
    }
}

#[cfg(test)]
mod scope_tests {
    use super::shared_scope;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn conversa_aceita_quem_esta_fora_e_missao_nao() {
        assert_eq!(shared_scope(s("m:1"), s("m:1")), s("m:1"));
        assert_eq!(shared_scope(s("c:a"), s("c:a")), s("c:a"));
        // Orquestrador numa conversa, subagente noutra (ou sem): entra no chat de quem fala.
        assert_eq!(shared_scope(s("c:a"), s("c:b")), s("c:a"));
        assert_eq!(shared_scope(s("c:a"), None), s("c:a"));
        assert_eq!(shared_scope(None, s("c:b")), s("c:b"));
        // Missão só dentro dela.
        assert_eq!(shared_scope(s("m:1"), s("m:2")), None);
        assert_eq!(shared_scope(s("m:1"), s("c:a")), None);
        assert_eq!(shared_scope(s("c:a"), s("m:1")), None);
        assert_eq!(shared_scope(None, None), None);
    }
}
