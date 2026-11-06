//! As tarefas em segundo plano (`tarefas`): as linhas do Claude Code 2.1.318 e os itens do Codex
//! (`collabAgentToolCall`, `subAgentActivity`) virando os eventos `task` do painel.
//!
//! As linhas do Claude saíram de uma conversa de verdade (haiku, um `sleep` em segundo plano e um
//! subagente), com caminhos e ids trocados.

use serde_json::{json, Value};

use super::claude_map::{Mapper, Out};
use super::tarefas::{claude_task, codex_tasks};

fn started_shell() -> Value {
    json!({ "type": "system", "subtype": "task_started", "task_id": "bbd2yxr1n", "run_id": "r-1",
        "tool_use_id": "toolu_bash", "description": "Rodar um sleep e ecoar pronto", "is_backgrounded": true,
        "task_type": "local_bash", "uuid": "u", "session_id": "s" })
}

#[test]
fn o_inicio_de_um_shell_em_segundo_plano_vira_tarefa_que_se_para() {
    let task = claude_task(&started_shell(), 10).expect("tarefa");
    assert_eq!(task["op"], "started");
    assert_eq!(task["taskId"], "bbd2yxr1n");
    assert_eq!(task["toolUseId"], "toolu_bash");
    assert_eq!(task["kind"], "shell");
    assert_eq!(task["title"], "Rodar um sleep e ecoar pronto");
    assert_eq!(task["status"], "running");
    assert_eq!(task["background"], true);
    assert_eq!(task["stoppable"], true);
    assert_eq!(task["at"], 10);
}

#[test]
fn o_subagente_aninhado_leva_o_pai_e_o_prompt() {
    let line = json!({ "type": "system", "subtype": "task_started", "task_id": "af9", "tool_use_id": "toolu_agent",
        "description": "Responder com ok", "subagent_type": "general-purpose", "is_backgrounded": false, "spawn_depth": 2,
        "parent_task_id": "a00", "task_type": "local_agent", "prompt": "Responda só ok." });
    let task = claude_task(&line, 1).expect("tarefa");
    assert_eq!(task["kind"], "agent");
    assert_eq!(task["parentTaskId"], "a00");
    assert_eq!(task["subagent"], "general-purpose");
    assert_eq!(task["prompt"], "Responda só ok.");
    assert_eq!(task["background"], false);
}

#[test]
fn a_tarefa_de_bastidor_nao_entra_no_painel() {
    let mut line = started_shell();
    line["ambient"] = json!(true);
    assert!(claude_task(&line, 1).is_none());
}

#[test]
fn o_aviso_de_fim_diz_o_status_o_resumo_e_a_duracao() {
    let line = json!({ "type": "system", "subtype": "task_notification", "task_id": "af9", "tool_use_id": "toolu_agent",
        "status": "completed", "output_file": "/tmp/x.output", "summary": "ok",
        "usage": { "total_tokens": 35044, "tool_uses": 0, "duration_ms": 2563 } });
    let task = claude_task(&line, 99).expect("tarefa");
    assert_eq!(task["op"], "ended");
    assert_eq!(task["status"], "completed");
    assert_eq!(task["summary"], "ok");
    assert_eq!(task["durationMs"], 2563);
    assert_eq!(task["tokens"], 35044);
    // O caminho do arquivo de saída nunca vai à janela.
    assert!(task.get("outputFile").is_none());
    let stopped = claude_task(&json!({ "type": "system", "subtype": "task_notification", "task_id": "k", "status": "stopped", "output_file": "", "summary": "" }), 1).unwrap();
    assert_eq!(stopped["status"], "stopped");
}

#[test]
fn a_atualizacao_que_encerra_vira_fim_e_a_que_nao_encerra_vira_atualizacao() {
    let killed = claude_task(&json!({ "type": "system", "subtype": "task_updated", "task_id": "k",
        "patch": { "status": "killed", "end_time": 1793896987460_i64 } }), 1).unwrap();
    assert_eq!((killed["op"].as_str(), killed["status"].as_str(), killed["at"].as_i64()), (Some("ended"), Some("stopped"), Some(1793896987460)));
    let failed = claude_task(&json!({ "type": "system", "subtype": "task_updated", "task_id": "k", "patch": { "status": "failed", "error": "saiu com 1" } }), 5).unwrap();
    assert_eq!((failed["status"].as_str(), failed["summary"].as_str(), failed["at"].as_i64()), (Some("failed"), Some("saiu com 1"), Some(5)));
    let renamed = claude_task(&json!({ "type": "system", "subtype": "task_updated", "task_id": "k", "patch": { "description": "Novo nome" } }), 5).unwrap();
    assert_eq!((renamed["op"].as_str(), renamed["title"].as_str()), (Some("updated"), Some("Novo nome")));
    assert!(renamed.get("status").is_none());
}

#[test]
fn o_progresso_traz_o_resumo_e_a_ultima_ferramenta() {
    let line = json!({ "type": "system", "subtype": "task_progress", "task_id": "af9", "description": "Ler o repo",
        "usage": { "total_tokens": 900, "tool_uses": 3, "duration_ms": 4000 }, "last_tool_name": "Read", "summary": "lendo src/" });
    let task = claude_task(&line, 1).unwrap();
    assert_eq!((task["op"].as_str(), task["lastTool"].as_str(), task["summary"].as_str(), task["toolUses"].as_i64()), (Some("updated"), Some("Read"), Some("lendo src/"), Some(3)));
}

#[test]
fn o_conjunto_vivo_vem_inteiro_e_sem_os_de_bastidor() {
    let line = json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [
        { "task_id": "a", "task_type": "local_bash", "description": "x" },
        { "task_id": "b", "task_type": "local_agent", "description": "y", "ambient": true },
    ] });
    let task = claude_task(&line, 1).unwrap();
    assert_eq!(task["op"], "live");
    assert_eq!(task["live"], json!(["a"]));
    assert_eq!(claude_task(&json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }), 1).unwrap()["live"], json!([]));
}

#[test]
fn o_resto_das_linhas_nao_e_tarefa() {
    assert!(claude_task(&json!({ "type": "system", "subtype": "init" }), 1).is_none());
    assert!(claude_task(&json!({ "type": "system", "subtype": "task_summary", "detail": "x" }), 1).is_none());
    assert!(claude_task(&json!({ "type": "assistant" }), 1).is_none());
    // Sem id não há o que mostrar.
    assert!(claude_task(&json!({ "type": "system", "subtype": "task_started", "description": "x" }), 1).is_none());
}

#[test]
fn o_mapeador_do_claude_entrega_as_tarefas_sem_abrir_turno() {
    let mut m = Mapper::default();
    let out = m.feed(&started_shell(), 7);
    assert!(matches!(out.as_slice(), [Out::Task(t)] if t["taskId"] == "bbd2yxr1n"));
}

#[test]
fn o_que_o_subagente_faz_vai_para_a_tarefa_dele_e_nao_para_a_timeline() {
    let mut m = Mapper::default();
    let text = json!({ "type": "assistant", "parent_tool_use_id": "toolu_agent",
        "message": { "id": "msg_sub", "content": [{ "type": "text", "text": "ok" }], "usage": { "input_tokens": 3, "output_tokens": 1 } } });
    let out = m.feed(&text, 1);
    assert_eq!(out.len(), 1, "o uso do subagente não vira item: {out:?}");
    let Out::SubItem { parent, item } = &out[0] else { panic!("esperava SubItem: {out:?}") };
    assert_eq!((parent.as_str(), item.text.as_deref()), ("toolu_agent", Some("ok")));
    // A ferramenta do subagente abre e fecha dentro da tarefa.
    let tool = json!({ "type": "assistant", "parent_tool_use_id": "toolu_agent",
        "message": { "id": "msg_sub2", "content": [{ "type": "tool_use", "id": "toolu_read", "name": "Read", "input": { "file_path": "/r/a.ts" } }] } });
    assert!(matches!(m.feed(&tool, 2).as_slice(), [Out::SubItem { .. }]));
    let result = json!({ "type": "user", "parent_tool_use_id": "toolu_agent",
        "message": { "content": [{ "type": "tool_result", "tool_use_id": "toolu_read", "content": "linha" }] } });
    let out = m.feed(&result, 3);
    let [Out::SubItem { item, .. }] = out.as_slice() else { panic!("esperava SubItem: {out:?}") };
    assert_eq!(item.id, "toolu_read");
    assert_eq!(item.status, Some(crate::canal::timeline::ToolStatus::Done));
    // O pedaço de texto do subagente não vira rascunho na conversa.
    let delta = json!({ "type": "stream_event", "parent_tool_use_id": "toolu_agent", "api_message_id": "msg_sub3",
        "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "o" } } });
    assert!(m.feed(&delta, 4).is_empty());
}

fn spawn(status: &str, states: Value) -> Value {
    json!({ "type": "collabAgentToolCall", "id": "call_1", "tool": "spawnAgent", "status": status,
        "senderThreadId": "th-main", "receiverThreadIds": ["th-sub"], "prompt": "Revise o diff\ne diga o que falta",
        "model": null, "reasoningEffort": null, "agentsStates": states })
}

#[test]
fn o_agente_que_o_codex_cria_vira_tarefa_que_nao_se_para_daqui() {
    let tasks = codex_tasks(&spawn("inProgress", json!({})), 3);
    assert_eq!(tasks.len(), 1);
    let t = &tasks[0];
    assert_eq!((t["op"].as_str(), t["taskId"].as_str(), t["toolUseId"].as_str()), (Some("started"), Some("th-sub"), Some("call_1")));
    assert_eq!((t["kind"].as_str(), t["title"].as_str(), t["status"].as_str()), (Some("agent"), Some("Revise o diff"), Some("running")));
    assert_eq!(t["stoppable"], false);
}

#[test]
fn os_estados_dos_agentes_do_codex_atualizam_as_tarefas() {
    let wait = json!({ "type": "collabAgentToolCall", "id": "call_2", "tool": "wait", "status": "completed", "senderThreadId": "th-main",
        "receiverThreadIds": ["th-sub", "th-2"], "prompt": null, "model": null, "reasoningEffort": null,
        "agentsStates": { "th-sub": { "status": "completed", "message": "Feito" }, "th-2": { "status": "errored", "message": "quebrou" }, "th-3": { "status": "notFound", "message": null } } });
    let mut tasks = codex_tasks(&wait, 9);
    tasks.sort_by(|a, b| a["taskId"].as_str().cmp(&b["taskId"].as_str()));
    assert_eq!(tasks.len(), 2, "o agente que não existe fica de fora: {tasks:?}");
    assert_eq!((tasks[0]["taskId"].as_str(), tasks[0]["op"].as_str(), tasks[0]["status"].as_str()), (Some("th-2"), Some("ended"), Some("failed")));
    assert_eq!((tasks[1]["taskId"].as_str(), tasks[1]["status"].as_str(), tasks[1]["summary"].as_str()), (Some("th-sub"), Some("completed"), Some("Feito")));
    // O spawn que já volta com o agente rodando continua rodando.
    let running = codex_tasks(&spawn("completed", json!({ "th-sub": { "status": "running", "message": null } })), 3);
    assert_eq!((running[0]["op"].as_str(), running[0]["status"].as_str()), (Some("started"), Some("running")));
}

#[test]
fn a_atividade_do_subagente_do_codex_abre_e_fecha_a_tarefa() {
    let item = |kind: &str| json!({ "type": "subAgentActivity", "id": "act", "kind": kind, "agentThreadId": "th-sub", "agentPath": "revisor", "model": null, "reasoningEffort": null });
    assert_eq!(codex_tasks(&item("started"), 1)[0]["op"], "started");
    assert_eq!(codex_tasks(&item("started"), 1)[0]["title"], "revisor");
    assert_eq!(codex_tasks(&item("completed"), 2)[0]["status"], "completed");
    assert_eq!(codex_tasks(&item("interrupted"), 2)[0]["status"], "stopped");
    assert!(codex_tasks(&item("interacted"), 2).is_empty());
    assert!(codex_tasks(&json!({ "type": "agentMessage", "id": "m", "text": "oi" }), 1).is_empty());
}
