//! Projeção comum do lineage do chat sobre o estado durável existente.
//!
//! Conversas estruturadas, turnos e tarefas headless mantêm suas tabelas e ciclos nativos. Este
//! módulo só lhes dá uma identidade de nó e relação de pai para que o harness consulte uma árvore.
//!
//! Na Fase 4, cada filho que é agente (conversa filha ou tarefa da Frota) também traz o que a pessoa
//! precisa ver: tipo, estado de execução, a entrega limitada e marcada como não confiável, o bloqueio
//! (pergunta ou aprovação pendente) e a origem. Tudo é lido na hora; nada disso é gravado aqui.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::Serialize;

use crate::conversa::store as chat;
use crate::harness::state::{self, NodeState};
use crate::harness::store as harness_store;
use super::execution_log::{self, HarnessEvent};
use super::types::status;

/// Quantos caracteres da resposta de um filho a projeção leva. O texto inteiro fica na conversa ou na tarefa.
const RESULT_PREVIEW_CHARS: usize = 500;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecutionNode {
    /// Identidade ADE com prefixo de tipo: `thread:`, `turn:`, `run:`, `task:` ou `attempt:`.
    pub id: String,
    pub parent_id: Option<String>,
    /// `thread`, `turn`, `fleetRun`, `fleetTask` ou `fleetAttempt`.
    pub kind: String,
    pub depth: i64,
    pub title: String,
    pub status: String,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub plan_key: Option<String>,
    pub attempt: Option<i64>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    /// Id estável do nó em `harness_node`, quando o turno já originou filhos. O `id` textual acima
    /// continua sendo a chave de UI e de eventos (é o `legacy_ref`).
    pub node_id: Option<String>,
    /// O `harness_run` a que o nó pertence.
    pub harness_run_id: Option<String>,
    /// Só no nó de turno: o id do `chat_run`. É o mesmo valor de `run_id` nesse nó, que guarda o
    /// turno e não o run da Frota; o nome claro vem aqui e `run_id` fica por compatibilidade.
    pub chat_run_id: Option<String>,
    /// Só no nó de turno: filhos diretos que ainda não terminaram (conversa filha ou run da Frota).
    /// Derivado na leitura; os outros nós omitem o campo. Ver contrato §3.3 regra 8.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_children: Option<i64>,
    /// Motivo persistido do evento `turn.interrupted`, quando houve sweep de boot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interruption_reason: Option<String>,
    /// Só nos agentes filhos: `provider_chat` (conversa filha) ou `fleet_task` (tarefa da Frota). O ADE
    /// não tem `connected_session`, então esse tipo não sai. Os outros nós omitem o campo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_type: Option<String>,
    /// Estado de execução (contrato §3.1) dos filhos: conversa, run e tarefa. Em conversa filha, `status`
    /// continua sendo `thread.state`; este campo é o estado do último turno, que é o que roda.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_status: Option<String>,
    /// A entrega do filho (a resposta do agente), limitada e sempre marcada como não confiável.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<HarnessNodeResult>,
    /// O bloqueio do próprio filho: pergunta ou aprovação que a pessoa precisa responder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<HarnessNodeBlock>,
    /// Só nos nós com filhos: quantos filhos diretos estão bloqueados ou têm um descendente bloqueado.
    /// O estado do pai não muda por causa disso (contrato §3.3 regra 6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_children: Option<i64>,
    /// Quem criou o filho e de qual turno.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<HarnessNodeOrigin>,
    /// O ADE não consegue provar como o nó terminou (status nativo desconhecido, tarefa sem resultado final).
    /// Só sai quando é verdadeiro; nunca é promovido a conclusão nem a falha conhecida.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_unknown: Option<bool>,
}

/// A entrega de um filho. `untrusted` é sempre verdadeiro: é o que um agente escreveu, dado e não instrução.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessNodeResult {
    pub text: String,
    pub truncated: bool,
    pub untrusted: bool,
}

/// O que um filho espera da pessoa. `kind` é `question` (o agente perguntou) ou `approval` (o agente pediu
/// permissão). `count` conta os pedidos pendentes desse filho.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessNodeBlock {
    pub kind: String,
    pub count: i64,
}

/// Quem criou o filho e de qual turno. `created_by` é `turn` (o turno do pai criou), `task` (outra tarefa
/// da Frota delegou) ou `conversation` (a conversa, fora de turno: não há turno para pendurar).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessNodeOrigin {
    pub created_by: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_node_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecutionGraph {
    pub root_thread_id: String,
    /// Nós em ordem de pai antes de filho. `parent_id` é a relação autoritativa.
    pub nodes: Vec<HarnessExecutionNode>,
    /// Atividade semântica persistida da linhagem, em ordem cronológica. Com `reset`, a janela mais recente;
    /// sem `reset`, só o que veio depois do cursor pedido.
    pub events: Vec<HarnessEvent>,
    /// A sequência do último evento persistido da linhagem (0 sem eventos). O front guarda e devolve.
    pub cursor: i64,
    /// Verdadeiro quando `events` é a janela inteira e o front deve trocar o que tinha; falso quando é um delta.
    pub reset: bool,
}

struct ChatTurn {
    id: String,
    thread_id: String,
    status: String,
    started_at: Option<i64>,
    ended_at: Option<i64>,
}

struct FleetRun {
    id: String,
    thread_id: String,
    title: String,
    status: String,
    created_at: i64,
    ended_at: Option<i64>,
}

struct FleetTask {
    id: String,
    run_id: String,
    title: String,
    status: String,
    error: Option<String>,
    agent_id: String,
    model: Option<String>,
    plan_key: Option<String>,
    parent_id: Option<String>,
    depth: i64,
    created_at: i64,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    /// Os primeiros caracteres do `result` da tarefa (uma a mais que o limite, para saber se cortou).
    result_head: Option<String>,
}

struct FleetAttempt {
    id: String,
    task_id: String,
    run_id: String,
    attempt: i64,
    status: String,
    error: Option<String>,
    agent_id: String,
    model: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
}

/// Projeta conversas descendentes, turnos estruturados e runs/tarefas da Frota numa única árvore.
/// As relações vêm de `parent_ref`, `chat_run`, `runs.source_thread_id` e `tasks.parent_id`;
/// nenhuma nova cópia ou migração do estado é criada. As leituras usam lotes limitados para não
/// fazer uma ida ao banco por cada conversa ou agente descendente.
pub fn thread_execution_graph(
    conn: &Connection,
    root_thread_id: &str,
) -> Result<HarnessExecutionGraph, String> {
    thread_execution_graph_since(conn, root_thread_id, None)
}

/// A mesma projeção, com os eventos por cursor (Fase 6). Os nós voltam sempre atuais: o estado deles vem das
/// tabelas nativas, não do log. Os eventos voltam como delta quando `after` bate com o banco, e como a janela
/// inteira (`reset`) quando não há cursor, quando o cursor está à frente do banco ou quando o delta passa da janela.
pub fn thread_execution_graph_since(
    conn: &Connection,
    root_thread_id: &str,
    after: Option<i64>,
) -> Result<HarnessExecutionGraph, String> {
    let all_threads = chat::threads(conn).map_err(|error| error.to_string())?;
    let root = all_threads
        .iter()
        .find(|thread| thread.id == root_thread_id)
        .cloned()
        .ok_or_else(|| "a conversa do grafo não existe".to_string())?;

    let mut children: HashMap<String, Vec<chat::ThreadRow>> = HashMap::new();
    for thread in all_threads {
        if !thread.is_side_chat {
            continue;
        }
        if let Some(parent_ref) = thread.parent_ref.as_deref() {
            children
                .entry(parent_ref.to_string())
                .or_default()
                .push(thread);
        }
    }
    for rows in children.values_mut() {
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }

    let mut lineage = vec![(root, None::<String>, 0_i64)];
    let mut seen = HashSet::from([root_thread_id.to_string()]);
    let mut cursor = 0;
    while cursor < lineage.len() {
        let parent_id = lineage[cursor].0.id.clone();
        let parent_ref = format!("thread:{parent_id}");
        let next_depth = lineage[cursor].2 + 1;
        if let Some(rows) = children.get(&parent_ref) {
            for child in rows {
                if !seen.insert(child.id.clone()) {
                    continue;
                }
                let child_depth = next_depth + if child.parent_turn_id.is_some() { 1 } else { 0 };
                lineage.push((child.clone(), Some(parent_id.clone()), child_depth));
            }
        }
        cursor += 1;
    }

    let thread_ids = lineage
        .iter()
        .map(|(thread, _, _)| thread.id.clone())
        .collect::<Vec<_>>();
    let turns_by_thread = load_chat_turns(conn, &thread_ids)?;
    let runs_by_thread = load_fleet_runs(conn, &thread_ids)?;
    let run_ids = runs_by_thread
        .values()
        .flatten()
        .map(|run| run.id.clone())
        .collect::<Vec<_>>();
    let tasks_by_run = load_fleet_tasks(conn, &run_ids)?;
    let task_ids = tasks_by_run
        .values()
        .flatten()
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    let attempts_by_task = load_fleet_attempts(conn, &task_ids)?;
    let cursor = execution_log::lineage_cursor(conn, &thread_ids)?;
    let delta = match after {
        Some(after) if after <= cursor => {
            execution_log::list_since(conn, &thread_ids, after, execution_log::EVENT_WINDOW)?
        }
        _ => None,
    };
    let reset = delta.is_none();
    let events = match delta {
        Some(events) => events,
        None => execution_log::list_for_threads(conn, &thread_ids, execution_log::EVENT_WINDOW)?,
    };
    let interruption_reasons = execution_log::interruption_reasons(conn, &thread_ids)?;
    // Bloqueios e entregas (Fase 4): só o que um filho ainda precisa mostrar. Lidos em lote, como o resto.
    let chat_blocks = load_chat_blocks(conn, &thread_ids)?;
    let fleet_approvals = load_fleet_approvals(conn, &task_ids)?;
    let last_turns: Vec<(String, String)> = lineage
        .iter()
        .filter(|(_, parent, _)| parent.is_some())
        .filter_map(|(thread, _, _)| {
            turns_by_thread
                .get(&thread.id)
                .and_then(|turns| turns.last())
                .map(|turn| (thread.id.clone(), turn.id.clone()))
        })
        .collect();
    let chat_results = load_chat_results(conn, &last_turns)?;
    // Nós com linha (`harness_node`): ganham o id estável e, no run da Frota, o pai durável. Quem não
    // tem linha (run sem turno ativo, conversa filha com o pai ocioso, dados anteriores à Fase 1)
    // segue só pela derivação acima. Nó cujo registro nativo sumiu nunca aparece: a árvore parte
    // sempre do registro nativo, e o `legacy_ref` só decora o que já existe.
    let links: HashMap<String, harness_store::NodeLink> =
        harness_store::nodes_for_threads(conn, &thread_ids)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|link| (link.legacy_ref.clone(), link))
            .collect();
    let turn_node_ids: HashSet<String> = turns_by_thread
        .values()
        .flatten()
        .map(|turn| format!("turn:{}:{}", turn.thread_id, turn.id))
        .collect();

    let mut nodes = Vec::new();
    for (thread, parent_thread_id, depth) in &lineage {
        let thread_node_id = format!("thread:{}", thread.id);
        let is_child = parent_thread_id.is_some();
        let last_turn = turns_by_thread.get(&thread.id).and_then(|turns| turns.last());
        // Só um turno ainda em andamento pode estar esperando a pessoa. Pedido que sobrou de turno
        // terminado não bloqueia: não há o que responder.
        let blocked = chat_blocks
            .get(&thread.id)
            .filter(|_| is_child && last_turn.is_some_and(|turn| turn.status == "inProgress"))
            .cloned();
        // O turno do pai que originou esta conversa (`parent_turn_id`), quando havia um só em curso.
        let origin_turn = thread
            .parent_turn_id
            .as_ref()
            .zip(parent_thread_id.as_ref())
            .map(|(turn_id, parent_id)| format!("turn:{parent_id}:{turn_id}"));
        let thread_unknown = is_child
            && last_turn.is_some_and(|turn| state::from_chat_run(&turn.status, false).outcome_unknown);
        let execution = is_child.then(|| match last_turn {
            Some(turn) => state::from_chat_run(&turn.status, blocked.is_some()).state.as_str().to_string(),
            None => NodeState::Pending.as_str().to_string(),
        });
        let result = if is_child {
            chat_results.get(&thread.id).map(|head| result_of(head))
        } else {
            None
        };
        nodes.push(HarnessExecutionNode {
            id: thread_node_id.clone(),
            parent_id: parent_thread_id
                .as_ref()
                .map(|parent_id| origin_turn.clone().unwrap_or_else(|| format!("thread:{parent_id}"))),
            kind: "thread".into(),
            depth: *depth,
            title: if thread.title.trim().is_empty() {
                thread.agent_id.clone()
            } else {
                thread.title.clone()
            },
            status: thread.state.clone(),
            thread_id: Some(thread.id.clone()),
            agent_id: Some(thread.agent_id.clone()),
            model: thread.model.clone(),
            created_at: thread.created_at,
            ended_at: (thread.state == "settled").then_some(thread.updated_at),
            child_type: is_child.then(|| "provider_chat".to_string()),
            execution_status: execution,
            result,
            blocked,
            origin: is_child.then(|| origin_of(origin_turn, None)),
            outcome_unknown: thread_unknown.then_some(true),
            ..Default::default()
        });

        for turn in turns_by_thread.get(&thread.id).into_iter().flatten() {
            nodes.push(HarnessExecutionNode {
                id: format!("turn:{}:{}", turn.thread_id, turn.id),
                parent_id: Some(thread_node_id.clone()),
                kind: "turn".into(),
                depth: depth + 1,
                title: "Turno do agente".into(),
                status: turn.status.clone(),
                thread_id: Some(thread.id.clone()),
                run_id: Some(turn.id.clone()),
                agent_id: Some(thread.agent_id.clone()),
                model: thread.model.clone(),
                chat_run_id: Some(turn.id.clone()),
                outcome_unknown: state::from_chat_run(&turn.status, false).outcome_unknown.then_some(true),
                created_at: turn.started_at.unwrap_or(thread.created_at),
                started_at: turn.started_at,
                ended_at: turn.ended_at,
                interruption_reason: state::chat_interruption_reason(
                    &turn.status,
                    interruption_reasons
                        .get(&format!("turn:{}:{}", turn.thread_id, turn.id))
                        .map(String::as_str),
                ),
                ..Default::default()
            });
        }

        for run in runs_by_thread.get(&thread.id).into_iter().flatten() {
            let run_node_id = format!("run:{}", run.id);
            // Run ligado a um turno desta mesma conversa aparece sob ele; os demais, sob a conversa.
            let turn_parent = links
                .get(&run_node_id)
                .and_then(|link| link.parent_legacy_ref.as_deref())
                .filter(|parent| {
                    parent.starts_with(&format!("turn:{}:", thread.id))
                        && turn_node_ids.contains(*parent)
                })
                .map(str::to_string);
            let under_turn = i64::from(turn_parent.is_some());
            nodes.push(HarnessExecutionNode {
                id: run_node_id.clone(),
                parent_id: Some(turn_parent.clone().unwrap_or_else(|| thread_node_id.clone())),
                kind: "fleetRun".into(),
                depth: depth + 1 + under_turn,
                title: run.title.clone(),
                status: run.status.clone(),
                thread_id: Some(thread.id.clone()),
                run_id: Some(run.id.clone()),
                created_at: run.created_at,
                started_at: Some(run.created_at),
                ended_at: run.ended_at,
                execution_status: Some(state::from_fleet_run(&run.status).state.as_str().to_string()),
                outcome_unknown: state::from_fleet_run(&run.status).outcome_unknown.then_some(true),
                origin: Some(origin_of(turn_parent.clone(), None)),
                ..Default::default()
            });
            for task in tasks_by_run.get(&run.id).into_iter().flatten() {
                let derived = state::from_task(&task.status, task.error.as_deref());
                // Aprovação só bloqueia tarefa que está rodando: sobra de um estado anterior não conta.
                let blocked = fleet_approvals
                    .get(&task.id)
                    .copied()
                    .filter(|count| *count > 0 && task.status == status::RUNNING)
                    .map(|count| HarnessNodeBlock { kind: "approval".into(), count });
                let execution = if blocked.is_some() && derived.state == NodeState::Running {
                    NodeState::Waiting
                } else {
                    derived.state
                };
                nodes.push(HarnessExecutionNode {
                    id: format!("task:{}", task.id),
                    parent_id: task
                        .parent_id
                        .as_ref()
                        .map(|id| format!("task:{id}"))
                        .or_else(|| Some(run_node_id.clone())),
                    kind: "fleetTask".into(),
                    depth: depth + 2 + under_turn + task.depth,
                    title: task.title.clone(),
                    status: if task.error.as_deref() == Some(super::store::SWEPT_RUNNING_ERROR) {
                        "interrupted".into()
                    } else {
                        task.status.clone()
                    },
                    thread_id: Some(thread.id.clone()),
                    run_id: Some(run.id.clone()),
                    agent_id: Some(task.agent_id.clone()),
                    model: task.model.clone(),
                    plan_key: task.plan_key.clone(),
                    created_at: task.created_at,
                    started_at: task.started_at,
                    ended_at: task.ended_at,
                    child_type: Some("fleet_task".into()),
                    execution_status: Some(execution.as_str().to_string()),
                    outcome_unknown: (derived.outcome_unknown
                        || task.error.as_deref() == Some(super::types::MISSING_FINAL_RESULT))
                    .then_some(true),
                    result: task
                        .result_head
                        .as_deref()
                        .filter(|head| !head.is_empty())
                        .map(result_of),
                    blocked,
                    origin: Some(origin_of(
                        turn_parent.clone(),
                        task.parent_id.as_ref().map(|id| format!("task:{id}")),
                    )),
                    ..Default::default()
                });
                for attempt in attempts_by_task.get(&task.id).into_iter().flatten() {
                    nodes.push(HarnessExecutionNode {
                        id: format!("attempt:{}", attempt.id),
                        parent_id: Some(format!("task:{}", attempt.task_id)),
                        kind: "fleetAttempt".into(),
                        depth: depth + 3 + under_turn + task.depth,
                        title: attempt.attempt.to_string(),
                        status: if attempt.error.as_deref()
                            == Some(super::store::SWEPT_RUNNING_ERROR)
                        {
                            "interrupted".into()
                        } else {
                            attempt.status.clone()
                        },
                        thread_id: Some(thread.id.clone()),
                        run_id: Some(attempt.run_id.clone()),
                        agent_id: Some(attempt.agent_id.clone()),
                        model: attempt.model.clone(),
                        attempt: Some(attempt.attempt),
                        outcome_unknown: (state::from_task(&attempt.status, attempt.error.as_deref()).outcome_unknown
                            || attempt.error.as_deref() == Some(super::types::MISSING_FINAL_RESULT))
                        .then_some(true),
                        created_at: attempt.started_at,
                        started_at: Some(attempt.started_at),
                        ended_at: attempt.ended_at,
                        ..Default::default()
                    });
                }
            }
        }
    }

    for node in &mut nodes {
        if let Some(link) = links.get(&node.id) {
            node.node_id = Some(link.node_id.clone());
            node.harness_run_id = Some(link.harness_run_id.clone());
        }
    }

    // As contagens olham a árvore já montada: o pai do run da Frota só existe depois do vínculo com o turno.
    let counts = active_child_counts(&nodes);
    let blocked = blocked_children_counts(&nodes);
    for node in &mut nodes {
        if node.kind == "turn" {
            node.active_children = Some(counts.get(&node.id).copied().unwrap_or(0));
        }
        node.blocked_children = blocked.get(&node.id).copied();
    }

    Ok(HarnessExecutionGraph {
        root_thread_id: root_thread_id.to_string(),
        nodes,
        events,
        cursor,
        reset,
    })
}

/// Filhos diretos não terminais de cada turno. Conversa filha: estado do último turno (§3.2),
/// nunca `chat_thread.state`. Run da Frota: uma vez, pelo `runs.status`. Tarefa, tentativa e run
/// legado (pai é a conversa, não o turno) ficam de fora.
fn active_child_counts(nodes: &[HarnessExecutionNode]) -> HashMap<String, i64> {
    let turns: HashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind == "turn")
        .map(|node| node.id.as_str())
        .collect();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for child in nodes {
        let Some(parent_id) = child.parent_id.as_deref() else {
            continue;
        };
        if !turns.contains(parent_id) || !direct_child_is_active(nodes, child) {
            continue;
        }
        *counts.entry(parent_id.to_string()).or_default() += 1;
    }
    counts
}

/// Por pai, quantos filhos diretos estão bloqueados ou têm um descendente bloqueado. É só leitura: o pai
/// mantém o estado que tinha (contrato §3.3 regra 6), e a pessoa vê o bloqueio descendo a árvore.
fn blocked_children_counts(nodes: &[HarnessExecutionNode]) -> HashMap<String, i64> {
    let parent_of: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|node| node.parent_id.as_deref().map(|parent| (node.id.as_str(), parent)))
        .collect();
    // Cada nó bloqueado e todos os seus ancestrais: o caminho de cada bloqueio até a raiz.
    let mut branch: HashSet<&str> = HashSet::new();
    for node in nodes.iter().filter(|node| node.blocked.is_some()) {
        let mut current = Some(node.id.as_str());
        while let Some(id) = current {
            if !branch.insert(id) {
                break;
            }
            current = parent_of.get(id).copied();
        }
    }
    let mut counts: HashMap<String, i64> = HashMap::new();
    for id in &branch {
        if let Some(parent) = parent_of.get(*id) {
            *counts.entry((*parent).to_string()).or_default() += 1;
        }
    }
    counts
}

/// A origem de um filho: quem o criou. Sem turno nem tarefa que delegou, quem criou foi a conversa.
fn origin_of(turn_node_id: Option<String>, task_node_id: Option<String>) -> HarnessNodeOrigin {
    let created_by = match (&task_node_id, &turn_node_id) {
        (Some(_), _) => "task",
        (None, Some(_)) => "turn",
        (None, None) => "conversation",
    };
    HarnessNodeOrigin { created_by, turn_node_id, task_node_id }
}

/// A entrega limitada: até 500 caracteres, sempre marcada como não confiável.
fn result_of(head: &str) -> HarnessNodeResult {
    HarnessNodeResult {
        text: head.chars().take(RESULT_PREVIEW_CHARS).collect(),
        truncated: head.chars().count() > RESULT_PREVIEW_CHARS,
        untrusted: true,
    }
}

/// O último turno da conversa, na ordem da projeção (`started_at`, depois `id`).
fn last_turn<'a>(nodes: &'a [HarnessExecutionNode], thread_id: &str) -> Option<&'a HarnessExecutionNode> {
    nodes.iter().rev().find(|node| node.kind == "turn" && node.thread_id.as_deref() == Some(thread_id))
}

fn direct_child_is_active(nodes: &[HarnessExecutionNode], child: &HarnessExecutionNode) -> bool {
    match child.kind.as_str() {
        // Sem turno a filha nunca rodou (ex.: conversa lateral aberta e não usada): contar deixaria
        // "1 filho ativo" para sempre. `inProgress` com pedido pendente vira `waiting`, que também
        // não é terminal: a contagem não precisa ler `chat_request`.
        "thread" => child
            .thread_id
            .as_deref()
            .and_then(|id| last_turn(nodes, id))
            .is_some_and(|turn| !state::from_chat_run(&turn.status, false).state.is_terminal()),
        "fleetRun" => !state::from_fleet_run(&child.status).state.is_terminal(),
        _ => false,
    }
}

/// Os pedidos do chat que a pessoa ainda precisa responder, por conversa. Pergunta tem precedência sobre
/// aprovação: quando o agente pergunta, é a resposta que ele espera.
fn load_chat_blocks(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<HashMap<String, HarnessNodeBlock>, String> {
    let mut blocks: HashMap<String, HarnessNodeBlock> = HashMap::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT thread_id, kind, COUNT(*) FROM chat_request
             WHERE state = 'pending' AND thread_id IN ({placeholders})
             GROUP BY thread_id, kind"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (thread_id, kind, count) = row.map_err(|error| error.to_string())?;
            let block = blocks
                .entry(thread_id)
                .or_insert_with(|| HarnessNodeBlock { kind: "approval".into(), count: 0 });
            block.count += count;
            if kind == "question" {
                block.kind = "question".into();
            }
        }
    }
    Ok(blocks)
}

/// As aprovações que cada tarefa da Frota está esperando (`task_approvals` ainda `pending`).
fn load_fleet_approvals(conn: &Connection, task_ids: &[String]) -> Result<HashMap<String, i64>, String> {
    let mut pending = HashMap::new();
    for ids in task_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT task_id, COUNT(*) FROM task_approvals
             WHERE status = 'pending' AND task_id IN ({placeholders})
             GROUP BY task_id"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (task_id, count) = row.map_err(|error| error.to_string())?;
            pending.insert(task_id, count);
        }
    }
    Ok(pending)
}

/// A última fala do agente no último turno de cada filho, cortada no limite mais um caractere (para
/// saber se cortou). Lê uma linha por filho, e só o começo do texto.
fn load_chat_results(
    conn: &Connection,
    last_turns: &[(String, String)],
) -> Result<HashMap<String, String>, String> {
    let mut results = HashMap::new();
    for (thread_id, turn_id) in last_turns {
        let head: Option<Option<String>> = conn
            .query_row(
                "SELECT substr(json_extract(body, '$.text'), 1, ?3) FROM chat_item
                 WHERE thread_id = ?1 AND run_id = ?2 AND json_extract(body, '$.kind') = 'assistant'
                   AND length(COALESCE(json_extract(body, '$.text'), '')) > 0
                 ORDER BY seq DESC LIMIT 1",
                rusqlite::params![thread_id, turn_id, (RESULT_PREVIEW_CHARS + 1) as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(Some(head)) = head {
            results.insert(thread_id.clone(), head);
        }
    }
    Ok(results)
}

fn load_chat_turns(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<HashMap<String, Vec<ChatTurn>>, String> {
    let mut turns_by_thread: HashMap<String, Vec<ChatTurn>> = HashMap::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT thread_id, id, status, started_at, completed_at FROM chat_run
             WHERE thread_id IN ({placeholders}) ORDER BY thread_id, COALESCE(started_at, 0), id"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok(ChatTurn {
                    thread_id: row.get(0)?,
                    id: row.get(1)?,
                    status: row.get(2)?,
                    started_at: row.get(3)?,
                    ended_at: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let turn = row.map_err(|error| error.to_string())?;
            turns_by_thread
                .entry(turn.thread_id.clone())
                .or_default()
                .push(turn);
        }
    }
    Ok(turns_by_thread)
}

fn load_fleet_runs(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<HashMap<String, Vec<FleetRun>>, String> {
    let mut runs_by_thread: HashMap<String, Vec<FleetRun>> = HashMap::new();
    for ids in thread_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT id, source_thread_id, objective, status, created_at, ended_at FROM runs
             WHERE source_thread_id IN ({placeholders}) ORDER BY source_thread_id, created_at DESC, rowid DESC"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok(FleetRun {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    ended_at: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let run = row.map_err(|error| error.to_string())?;
            runs_by_thread
                .entry(run.thread_id.clone())
                .or_default()
                .push(run);
        }
    }
    Ok(runs_by_thread)
}

fn load_fleet_tasks(
    conn: &Connection,
    run_ids: &[String],
) -> Result<HashMap<String, Vec<FleetTask>>, String> {
    let mut tasks_by_run: HashMap<String, Vec<FleetTask>> = HashMap::new();
    let head = RESULT_PREVIEW_CHARS + 1;
    for ids in run_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT id, run_id, title, status, agent_id, model, plan_key, parent_id, depth,
                    created_at, started_at, ended_at, error, substr(result, 1, {head})
             FROM tasks WHERE run_id IN ({placeholders}) ORDER BY run_id, created_at, rowid"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok(FleetTask {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    agent_id: row.get(4)?,
                    model: row.get(5)?,
                    plan_key: row.get(6)?,
                    parent_id: row.get(7)?,
                    depth: row.get(8)?,
                    created_at: row.get(9)?,
                    started_at: row.get(10)?,
                    ended_at: row.get(11)?,
                    error: row.get(12)?,
                    result_head: row.get(13)?,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let task = row.map_err(|error| error.to_string())?;
            tasks_by_run
                .entry(task.run_id.clone())
                .or_default()
                .push(task);
        }
    }
    Ok(tasks_by_run)
}

fn load_fleet_attempts(
    conn: &Connection,
    task_ids: &[String],
) -> Result<HashMap<String, Vec<FleetAttempt>>, String> {
    let mut attempts_by_task: HashMap<String, Vec<FleetAttempt>> = HashMap::new();
    for ids in task_ids.chunks(400) {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT id, task_id, run_id, attempt, status, agent_id, model, started_at, ended_at, error
             FROM run_attempts WHERE task_id IN ({placeholders}) ORDER BY task_id, attempt"
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter().map(String::as_str)), |row| {
                Ok(FleetAttempt {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    run_id: row.get(2)?,
                    attempt: row.get(3)?,
                    status: row.get(4)?,
                    agent_id: row.get(5)?,
                    model: row.get(6)?,
                    started_at: row.get(7)?,
                    ended_at: row.get(8)?,
                    error: row.get(9)?,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let attempt = row.map_err(|error| error.to_string())?;
            attempts_by_task
                .entry(attempt.task_id.clone())
                .or_default()
                .push(attempt);
        }
    }
    Ok(attempts_by_task)
}
