//! O vigia do chat lendo o banco: monta o [`Input`] de cada time vigiado. SQL puro sobre `&Connection`, sem
//! `AppHandle` nem relógio (o "agora" vem de quem chama), então os testes usam um banco em memória.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use super::model;
use super::store::{self, MemberRow, TeamRow};
use super::watch::{Flags, Input, Member, Req, ReqState, Sent, Turn, TurnStatus, KEY_PREFIX};
use crate::canal::timeline::{Item, ItemKind};
use crate::conversa::store as chat;
use crate::peer_queue::store::{admit, Admission, NewMessage, PeerMessage, State};

/// Um aviso de mais de tanto tempo já não decide nada: a chave some da conta (a fila apaga as mensagens velhas).
const SENT_HISTORY_MS: i64 = 7 * 24 * 3_600_000;
/// Quantos itens da ponta da conversa o vigia lê para achar a fala que fechou o turno.
const TAIL_ITEMS: i64 = 40;

/// Um time vigiado: o time, o nome com que o orquestrador é chamado no `ags peer` e o que se sabe agora.
pub struct Watched {
    pub team: TeamRow,
    pub orchestrator_name: String,
    pub input: Input,
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Os times que o vigia olha agora: com algum interruptor ligado, com o orquestrador aberto e ao menos um
/// integrante que é uma conversa por protocolo aberta.
pub fn gather(conn: &Connection, now: i64) -> Result<Vec<Watched>, String> {
    let mut out = Vec::new();
    for team in store::teams(conn)? {
        if !team.watch && !team.watch_stall {
            continue;
        }
        let orchestrator_open = match model::thread_id_of(&team.orchestrator) {
            Some(thread) => chat::thread(conn, thread).map_err(err)?.is_some_and(|row| row.state == "active"),
            None => true,
        };
        if !orchestrator_open {
            continue;
        }
        let sent = sent_keys(conn, &team.orchestrator, now)?;
        let keys: HashSet<&str> = sent.iter().map(|s| s.key.as_str()).collect();
        let mut members = Vec::new();
        for m in store::members(conn, &team.id)? {
            if let Some(view) = member_view(conn, &m, &keys)? {
                members.push(view);
            }
        }
        if members.is_empty() {
            continue;
        }
        let input = Input { flags: Flags { blocks: team.watch, stall: team.watch_stall }, members, sent };
        out.push(Watched { orchestrator_name: super::api::orchestrator_peer_name(conn, &team), team, input });
    }
    Ok(out)
}

/// As chaves do vigia já enviadas ao orquestrador (as da fila e as que ela já recolheu), com a hora.
fn sent_keys(conn: &Connection, orchestrator: &str, now: i64) -> Result<Vec<Sent>, String> {
    let since = now - SENT_HISTORY_MS;
    let like = format!("{KEY_PREFIX}%");
    let mut found: HashMap<String, i64> = HashMap::new();
    for sql in [
        "SELECT client_id, created_at FROM peer_messages WHERE from_tab_id = ?1 AND client_id LIKE ?2 AND created_at >= ?3",
        "SELECT client_id, created_at FROM peer_message_keys WHERE from_tab_id = ?1 AND client_id LIKE ?2 AND created_at >= ?3",
    ] {
        let mut stmt = conn.prepare(sql).map_err(err)?;
        let rows = stmt.query_map(params![orchestrator, like, since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(err)?;
        for row in rows {
            let (key, at) = row.map_err(err)?;
            found.entry(key).and_modify(|old| *old = (*old).max(at)).or_insert(at);
        }
    }
    let mut list: Vec<Sent> = found.into_iter().map(|(key, at)| Sent { key, at }).collect();
    list.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));
    Ok(list)
}

fn member_view(conn: &Connection, m: &MemberRow, sent: &HashSet<&str>) -> Result<Option<Member>, String> {
    let Some(thread_id) = model::thread_id_of(&m.member) else { return Ok(None) };
    let Some(thread) = chat::thread(conn, thread_id).map_err(err)?.filter(|t| t.state == "active") else { return Ok(None) };
    let label = if m.label.trim().is_empty() { thread.title.clone() } else { m.label.clone() };
    let working = conn
        .prepare("SELECT id, COALESCE(started_at, 0) FROM chat_run WHERE thread_id = ?1 AND status = 'inProgress' ORDER BY started_at DESC LIMIT 1")
        .and_then(|mut s| s.query_row([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map(Some).or_else(none_if_empty))
        .map_err(err)?;
    let items = tail_items(conn, thread_id)?;
    // A atividade é a mais recente entre o carimbo da conversa (`touch` a cada item gravado) e o do último item.
    let last_activity = items.iter().filter_map(|i| i.at).fold(thread.updated_at, i64::max);
    Ok(Some(Member {
        id: m.member.clone(),
        label,
        role: super::commands::role_info(&m.role).0,
        working,
        last_activity,
        requests: requests(conn, thread_id, sent)?,
        last_turn: last_turn(conn, thread_id, &items)?,
    }))
}

fn none_if_empty<T>(e: rusqlite::Error) -> rusqlite::Result<Option<T>> {
    match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    }
}

/// Os pedidos pendentes e os já avisados que a pessoa resolveu (para virar «destravou»).
fn requests(conn: &Connection, thread_id: &str, sent: &HashSet<&str>) -> Result<Vec<Req>, String> {
    let mut rows = chat::pending_requests(conn, thread_id).map_err(err)?;
    let mut stmt = conn.prepare("SELECT id FROM chat_request WHERE thread_id = ?1 AND state IN ('answered', 'expired')").map_err(err)?;
    let resolved: Vec<String> = stmt.query_map([thread_id], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    for id in resolved {
        if sent.contains(format!("{KEY_PREFIX}req-{id}").as_str()) && !sent.contains(format!("{KEY_PREFIX}ok-{id}").as_str()) {
            rows.extend(chat::request(conn, &id).map_err(err)?);
        }
    }
    Ok(rows
        .into_iter()
        .map(|r| Req {
            options: question_options(&r.options),
            state: match r.state.as_str() {
                "pending" => ReqState::Pending,
                "answered" => ReqState::Answered,
                _ => ReqState::Expired,
            },
            id: r.id,
            kind: r.kind,
            title: r.title,
            created_at: r.created_at,
        })
        .collect())
}

/// As opções da primeira pergunta (`[{id, question, options: [...]}]`); nas aprovações a coluna é outra coisa e sai vazia.
fn question_options(options: &serde_json::Value) -> Vec<String> {
    options
        .as_array()
        .and_then(|questions| questions.first())
        .and_then(|q| q.get("options"))
        .and_then(|o| o.as_array())
        .map(|list| list.iter().filter_map(|o| o.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// O turno que terminou por último, com o erro, a última fala do agente e se alguém falou depois.
fn last_turn(conn: &Connection, thread_id: &str, items: &[Item]) -> Result<Option<Turn>, String> {
    let run = conn
        .prepare(
            "SELECT id, status, COALESCE(completed_at, started_at, 0) FROM chat_run
              WHERE thread_id = ?1 AND status IN ('completed', 'failed', 'interrupted')
              ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC LIMIT 1",
        )
        .and_then(|mut s| s.query_row([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map(Some).or_else(none_if_empty))
        .map_err(err)?;
    let Some((run_id, status, completed_at)) = run else { return Ok(None) };
    let end_id = format!("end:{run_id}");
    let end = items.iter().position(|i| i.kind == ItemKind::TurnEnd && i.id == end_id);
    let status = match status.as_str() {
        "failed" => TurnStatus::Failed,
        "interrupted" => TurnStatus::Interrupted,
        _ => TurnStatus::Completed,
    };
    let error = end.and_then(|p| items[p].text.clone()).filter(|t| !t.trim().is_empty());
    let final_text = end.and_then(|p| {
        items[..p].iter().rev().take_while(|i| !matches!(i.kind, ItemKind::TurnEnd | ItemKind::User)).find(|i| i.kind == ItemKind::Assistant).and_then(|i| i.text.clone())
    });
    let replied_after = end.is_some_and(|p| items[p + 1..].iter().any(|i| i.kind == ItemKind::User));
    Ok(Some(Turn { run_id, status, completed_at, error, final_text, replied_after }))
}

/// Os últimos itens da conversa, do mais velho para o mais novo. Um corpo ilegível (de uma versão futura) fica de fora.
fn tail_items(conn: &Connection, thread_id: &str) -> Result<Vec<Item>, String> {
    let mut stmt = conn.prepare("SELECT body FROM chat_item WHERE thread_id = ?1 ORDER BY seq DESC LIMIT ?2").map_err(err)?;
    let bodies: Vec<String> = stmt.query_map(params![thread_id, TAIL_ITEMS], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let mut items: Vec<Item> = bodies.iter().filter_map(|b| serde_json::from_str(b).ok()).collect();
    items.reverse();
    Ok(items)
}

/// Põe os avisos do plano na fila durável do orquestrador (`peer_messages`), um por chave: a mesma chave nunca entra
/// duas vezes (a fila a reconhece), e o vigia ainda confere as já usadas antes de planejar. Devolve só os novos.
/// O aviso vai DO orquestrador PARA ele mesmo, como o aviso de falha da fila: se não chegar, o aviso de falha não
/// acorda ninguém (nunca o integrante). `raw`: chega com o cabeçalho mínimo `[Mensagem #n de Vigia do chat]`.
pub fn queue(conn: &Connection, watched: &Watched, plan: &super::watch::Plan, now: i64) -> Result<Vec<PeerMessage>, String> {
    let orchestrator = watched.team.orchestrator.as_str();
    let mut queued = Vec::new();
    for notice in &plan.notices {
        let new = NewMessage {
            client_id: Some(&notice.key),
            kind: "notice",
            from_tab_id: orchestrator,
            from_name: "Vigia do chat",
            to_tab_id: orchestrator,
            to_name: &watched.orchestrator_name,
            text: &notice.text,
            raw: true,
            reply: false,
            envelope: None,
            limits: None,
        };
        if let Admission::New(msg) = admit(conn, &new, State::Queued, now)? {
            queued.push(msg);
        }
    }
    Ok(queued)
}
