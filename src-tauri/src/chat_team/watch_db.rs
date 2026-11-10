//! O vigia do chat lendo o banco: monta o [`Input`] de cada time vigiado. SQL puro sobre `&Connection`, sem
//! `AppHandle` nem relógio (o "agora" vem de quem chama), então os testes usam um banco em memória.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use super::model;
use super::store::{self, MemberRow, TeamRow};
use super::watch::{Flags, Input, Member, Req, ReqState, Sent, Turn, TurnStatus, KEY_PREFIX};
use crate::canal::context::{claude_window, pressure_of};
use crate::canal::repeat::{call_key, Call};
use crate::canal::timeline::{Item, ItemKind, ToolStatus};
use crate::conversa::store as chat;
use crate::peer_queue::store::{admit, Admission, NewMessage, PeerMessage, State};

/// Um aviso de mais de tanto tempo já não decide nada: a chave some da conta (a fila apaga as mensagens velhas).
const SENT_HISTORY_MS: i64 = 7 * 24 * 3_600_000;
/// Quantos itens da ponta da conversa o vigia lê: a fala que fechou o turno, as chamadas desde a última mensagem
/// da pessoa (a 8ª repetição precisa caber, com falas e uso no meio) e o último `usage`.
const TAIL_ITEMS: i64 = 160;
/// Uma tarefa entregue um pouco ANTES de o turno começar ainda é a que o abriu (a fila grava e depois envia).
const TASK_SLACK_MS: i64 = 10_000;

/// Um time vigiado: o time, o nome com que o orquestrador é chamado no `ags peer` e o que se sabe agora.
pub struct Watched {
    pub team: TeamRow,
    pub orchestrator_name: String,
    pub input: Input,
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Times do canvas e pais de conversas-filhas que o vigia olha agora. Filhos nativos do `chat_new` não precisam
/// entrar no cadastro de times: o `parent_ref` já fornece a relação de lineage.
pub fn gather(conn: &Connection, now: i64) -> Result<Vec<Watched>, String> {
    let mut out = Vec::new();
    let mut by_parent: HashMap<String, usize> = HashMap::new();
    let mut configured_parents = HashSet::new();
    for team in store::teams(conn)? {
        if team.led() && team.origin != store::ORIGIN_MISSION {
            // Um time existente é a autoridade para ligar/desligar os avisos do pai, inclusive quando ambos
            // os interruptores estão desligados.
            configured_parents.insert(team.orchestrator.clone());
        }
        // Sem orquestrador (a coroa saiu do canvas) não há a quem avisar; origem de missão é do Vigia da missão.
        if (!team.watch && !team.watch_stall) || !team.led() || team.origin == store::ORIGIN_MISSION {
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
            if let Some(view) = member_view(conn, &m, &team.orchestrator, &keys)? {
                members.push(view);
            }
        }
        let input = Input { flags: Flags { blocks: team.watch, stall: team.watch_stall }, members, sent };
        by_parent.insert(team.orchestrator.clone(), out.len());
        out.push(Watched { orchestrator_name: super::api::orchestrator_peer_name(conn, &team), team, input });
    }

    for child in chat::active_side_threads(conn).map_err(err)? {
        let Some(parent_ref) = child.parent_ref.as_deref() else { continue };
        let Some(parent) = parent_target(conn, parent_ref)? else { continue };
        let index = if let Some(index) = by_parent.get(&parent).copied() {
            index
        } else {
            // Um time explicitamente configurado controla o Vigia. Para uma delegação nativa fora de time,
            // os avisos de bloqueio seguem o padrão seguro já usado pelos times do chat: ligados; sem alerta
            // de estagnação, sem interrupção e sem resposta automática.
            if configured_parents.contains(&parent) {
                continue;
            }
            let watched = child_watcher(conn, &parent, &child, now)?;
            let index = out.len();
            by_parent.insert(parent.clone(), index);
            out.push(watched);
            index
        };
        let watched = &mut out[index];
        if !watched.input.flags.blocks {
            continue;
        }
        let member_ref = format!("thread:{}", child.id);
        if watched.input.members.iter().any(|member| member.id == member_ref) {
            continue;
        }
        let sent: HashSet<&str> = watched.input.sent.iter().map(|entry| entry.key.as_str()).collect();
        let row = MemberRow {
            team_id: watched.team.id.clone(),
            member: member_ref,
            agent_id: child.agent_id.clone(),
            label: child.title.clone(),
            role: "subagente".into(),
            model: child.model.clone(),
            policy: model::Policy::Ask,
            branch: None,
            worktree: None,
            origin: "new".into(),
            position: watched.input.members.len() as i64,
            created_at: child.created_at,
            updated_at: child.updated_at,
            subagent: true,
        };
        if let Some(view) = member_view(conn, &row, &parent, &sent)? {
            watched.input.members.push(view);
        }
    }
    Ok(out)
}

/// Normaliza a referência da UI para o destinatário real da fila e só vigia um pai que ainda existe.
fn parent_target(conn: &Connection, parent_ref: &str) -> Result<Option<String>, String> {
    if let Some(thread_id) = parent_ref.strip_prefix("thread:") {
        return Ok(chat::thread(conn, thread_id).map_err(err)?.filter(|row| row.state == "active").map(|_| parent_ref.to_string()));
    }
    if let Some(tab_id) = parent_ref.strip_prefix("tab:") {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tabs WHERE id = ?1)", [tab_id], |row| row.get(0)).map_err(err)?;
        return Ok(exists.then(|| tab_id.to_string()));
    }
    Ok(None)
}

/// Um grupo transitório para o lineage de conversas nativas, sem gravar um time sintético no banco.
fn child_watcher(conn: &Connection, parent: &str, child: &chat::ThreadRow, now: i64) -> Result<Watched, String> {
    let (agent_id, label, cwd, title, created_at, updated_at) = if let Some(thread_id) = model::thread_id_of(parent) {
        let Some(row) = chat::thread(conn, thread_id).map_err(err)?.filter(|row| row.state == "active") else {
            return Err("A conversa de origem não está mais ativa".into());
        };
        let title = row.title.clone();
        (row.agent_id, title.clone(), row.cwd, title, row.created_at, row.updated_at)
    } else {
        let tab = conn.query_row("SELECT title, agent_label FROM tabs WHERE id = ?1", [parent], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(err)?;
        (tab.1.clone(), tab.1, child.cwd.clone(), tab.0, now, now)
    };
    let team = TeamRow {
        id: format!("chat-lineage:{parent}"),
        orchestrator: parent.to_string(),
        agent_id,
        label,
        cwd,
        title,
        created_at,
        updated_at,
        auto_decide: false,
        allow_tools: false,
        watch: true,
        watch_stall: false,
        origin: store::ORIGIN_CHAT.into(),
        board_key: None,
        mission_id: None,
    };
    let sent = sent_keys(conn, parent, now)?;
    Ok(Watched {
        orchestrator_name: super::api::orchestrator_peer_name(conn, &team),
        team,
        input: Input { flags: Flags { blocks: true, stall: false }, members: Vec::new(), sent },
    })
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

fn member_view(conn: &Connection, m: &MemberRow, orchestrator: &str, sent: &HashSet<&str>) -> Result<Option<Member>, String> {
    let Some(thread_id) = model::thread_id_of(&m.member) else { return Ok(None) };
    let Some(thread) = chat::thread(conn, thread_id).map_err(err)?.filter(|t| t.state == "active") else { return Ok(None) };
    let label = if m.label.trim().is_empty() { thread.title.clone() } else { m.label.clone() };
    let working = conn
        .prepare("SELECT id, COALESCE(started_at, 0) FROM chat_run WHERE thread_id = ?1 AND status = 'inProgress' ORDER BY started_at DESC LIMIT 1")
        .and_then(|mut s| s.query_row([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map(Some).or_else(none_if_empty))
        .map_err(err)?;
    let items = tail_items(conn, thread_id)?;
    // A atividade é a mais recente entre o carimbo da conversa (`touch` a cada item gravado) e o do último item.
    // Um aviso do próprio app (a marca de TIMEOUT, por exemplo) não é atividade do agente.
    let last_activity = items.iter().filter(|i| i.kind != ItemKind::Notice).filter_map(|i| i.at).fold(thread.updated_at, i64::max);
    let since_person = items.iter().rposition(|i| i.kind == ItemKind::User).map_or(0, |p| p + 1);
    let recent = &items[since_person..];
    let awaiting_model = working.is_some() && !recent.iter().any(|i| i.kind == ItemKind::Tool && i.status == Some(ToolStatus::Running));
    let timeout_marked = working.as_ref().is_some_and(|(run, _)| has_item(&items, &crate::conversa::turn::timeout_item_id(run)));
    let mut last_turn = last_turn(conn, thread_id, &items)?;
    if let Some(t) = last_turn.as_mut() {
        t.timed_out = has_item(&items, &crate::conversa::turn::timeout_item_id(&t.run_id));
        let (from_orchestrator, reported) = turn_messages(conn, &m.member, orchestrator, t)?;
        t.from_orchestrator = from_orchestrator;
        t.reported = reported;
    }
    Ok(Some(Member {
        id: m.member.clone(),
        label,
        role: super::commands::role_info(&m.role).0,
        working,
        last_activity,
        requests: requests(conn, thread_id, sent)?,
        last_turn,
        awaiting_model,
        timeout_marked,
        calls: calls_of(recent),
        context: context_of(&thread.agent_id, thread.model.as_deref(), &items),
    }))
}

fn has_item(items: &[Item], id: &str) -> bool {
    items.iter().any(|i| i.id == id)
}

/// As chamadas de ferramenta, com a chave de repetição. A conversa guarda o resumo da chamada (o comando, o
/// arquivo, o padrão), não os argumentos crus: a chave é o JSON canônico desse resumo. Pura.
pub fn calls_of(items: &[Item]) -> Vec<Call> {
    items
        .iter()
        .filter(|i| i.kind == ItemKind::Tool)
        .map(|i| {
            let name = i.name.clone().unwrap_or_default();
            let args = serde_json::json!({
                "label": i.label, "path": i.path, "added": i.added, "removed": i.removed,
                "question": i.question.as_ref().map(|q| q.text.clone()),
            });
            Call { key: call_key(&name, &args), summary: crate::conversa::turn::tool_call_label(i).trim_start_matches(name.as_str()).trim().to_string(), name }
        })
        .collect()
}

/// A pressão de contexto de uma conversa do Claude: o último `usage` real (o contexto da mensagem) mais a
/// estimativa do texto depois dele. Os outros motores gravam o uso por TURNO (não o tamanho do contexto):
/// `None` (não medido). Pura. O segundo campo é a chave da medida (o `usage` que a ancorou).
pub fn context_of(agent_id: &str, model: Option<&str>, items: &[Item]) -> Option<(f64, String)> {
    // Pressão de contexto exige o contador de janela do Claude. `Usage` cobre o uso por sessão,
    // não garante a mesma semântica de janela nas outras TUIs; a engine/adapter escolhe o parser.
    if crate::conversa::api::Engine::of(agent_id) != Some(crate::conversa::api::Engine::Claude) {
        return None;
    }
    let at = items.iter().rposition(|i| i.kind == ItemKind::Usage)?;
    let anchor = items[at].tokens?;
    let extra: u64 = items[at + 1..]
        .iter()
        .map(|i| i.text.as_deref().map_or(0, |t| t.chars().count()) + i.label.as_deref().map_or(0, |t| t.chars().count()))
        .sum::<usize>() as u64;
    Some((pressure_of(anchor, extra, claude_window(model, anchor)), items[at].id.clone()))
}

/// O turno foi aberto por uma tarefa do orquestrador (um `tell`, ou um `ask` sem resposta automática) e o
/// integrante mandou mensagem a ele durante o turno?
fn turn_messages(conn: &Connection, member: &str, orchestrator: &str, t: &Turn) -> Result<(bool, bool), String> {
    let Some(started) = t.started_at else { return Ok((false, false)) };
    let from: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM peer_messages WHERE from_tab_id = ?1 AND to_tab_id = ?2 AND kind IN ('tell', 'ask', 'handoff')
               AND NOT (kind = 'ask' AND reply = 1) AND COALESCE(delivered_at, created_at) BETWEEN ?3 AND ?4",
            params![orchestrator, member, started - TASK_SLACK_MS, t.completed_at],
            |r| r.get(0),
        )
        .map_err(err)?;
    let back: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM peer_messages WHERE from_tab_id = ?1 AND to_tab_id = ?2 AND kind IN ('tell', 'ask', 'handoff')
               AND created_at BETWEEN ?3 AND ?4",
            params![member, orchestrator, started, t.completed_at + TASK_SLACK_MS],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok((from > 0, back > 0))
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
            "SELECT id, status, COALESCE(completed_at, started_at, 0), started_at FROM chat_run
              WHERE thread_id = ?1 AND status IN ('completed', 'failed', 'interrupted')
              ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC LIMIT 1",
        )
        .and_then(|mut s| {
            s.query_row([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?)))
                .map(Some)
                .or_else(none_if_empty)
        })
        .map_err(err)?;
    let Some((run_id, status, completed_at, started_at)) = run else { return Ok(None) };
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
    Ok(Some(Turn { run_id, status, completed_at, started_at, error, final_text, replied_after, from_orchestrator: false, reported: false, timed_out: false }))
}

/// Os últimos itens da conversa, do mais velho para o mais novo. Um corpo ilegível (de uma versão futura) fica de fora.
fn tail_items(conn: &Connection, thread_id: &str) -> Result<Vec<Item>, String> {
    let mut stmt = conn.prepare("SELECT body FROM chat_item WHERE thread_id = ?1 ORDER BY seq DESC LIMIT ?2").map_err(err)?;
    let bodies: Vec<String> = stmt.query_map(params![thread_id, TAIL_ITEMS], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let mut items: Vec<Item> = bodies.iter().filter_map(|b| serde_json::from_str(b).ok()).collect();
    items.reverse();
    Ok(items)
}

/// Grava na timeline de cada integrante a marca de TIMEOUT do watchdog (id fixo por turno: gravar de novo não
/// duplica). Devolve o que gravou (conversa, item), para a janela. Não escreve nada ao agente.
pub fn mark_timeouts(conn: &Connection, plan: &super::watch::Plan, now: i64) -> Result<Vec<(String, Item)>, String> {
    let mut out = Vec::new();
    for t in &plan.timeouts {
        let Some(thread_id) = model::thread_id_of(&t.member) else { continue };
        let item = crate::conversa::turn::timeout_item(&t.run_id, t.idle_ms, now);
        chat::upsert_item(conn, thread_id, Some(&t.run_id), &item).map_err(err)?;
        out.push((thread_id.to_string(), item));
    }
    Ok(out)
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
