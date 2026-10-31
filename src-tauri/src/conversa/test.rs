use serde_json::json;

use crate::canal::timeline::{ItemKind, ToolKind, ToolStatus};

use super::codex_map::{access_policy, answer_of, ask_of, delta_of, items_of, plan_item, turn_end, usage_item, DeltaKind, TurnTokens};
use super::store::{self, RequestRow, Tuning};

fn thread(conn: &rusqlite::Connection, id: &str) {
    store::insert_thread(conn, id, "codex", "/tmp/p", "Título", &Tuning { model: Some("gpt-6.1-sol".into()), effort: None, access: "ask".into() }, None, 1).unwrap();
}

#[test]
fn a_migracao_roda_duas_vezes_sem_erro() {
    let conn = crate::database::test_db();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
}

#[test]
fn um_item_novo_vai_para_o_fim_e_o_atualizado_fica_no_lugar() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    let mut cmd = items_of(&json!({ "type": "commandExecution", "id": "c1", "command": "ls", "status": "inProgress" }), Some(1)).remove(0);
    store::upsert_item(&conn, "t1", Some("r1"), &items_of(&json!({ "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": "oi" }] }), None)[0]).unwrap();
    store::upsert_item(&conn, "t1", Some("r1"), &cmd).unwrap();
    store::upsert_item(&conn, "t1", Some("r1"), &items_of(&json!({ "type": "agentMessage", "id": "a1", "text": "pronto" }), None)[0]).unwrap();
    cmd.status = Some(ToolStatus::Done);
    store::upsert_item(&conn, "t1", Some("r1"), &cmd).unwrap();
    let items = store::items(&conn, "t1").unwrap();
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["u1", "c1", "a1"]);
    assert_eq!(items[1].status, Some(ToolStatus::Done));
}

#[test]
fn a_conversa_guarda_o_id_do_codex_e_a_troca_de_acesso() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    store::set_remote_id(&conn, "t1", "thr_9").unwrap();
    store::set_tuning(&conn, "t1", &Tuning { model: None, effort: Some("high".into()), access: "full".into() }, 5).unwrap();
    let row = store::thread(&conn, "t1").unwrap().unwrap();
    assert_eq!(row.remote_id.as_deref(), Some("thr_9"));
    assert_eq!((row.model, row.effort.as_deref(), row.access.as_str()), (None, Some("high"), "full"));
}

#[test]
fn os_pedidos_pendentes_expiram_e_nao_se_respondem_duas_vezes() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    let row = |id: &str| RequestRow {
        id: id.into(), thread_id: "t1".into(), rpc_id: "7".into(), kind: "command".into(), item_id: None,
        title: "rm -rf build".into(), detail: String::new(), options: json!([]), state: "pending".into(), created_at: 1,
    };
    store::insert_request(&conn, &row("q1")).unwrap();
    store::insert_request(&conn, &row("q2")).unwrap();
    assert!(store::answer_request(&conn, "q1", "allow", 2).unwrap());
    assert!(!store::answer_request(&conn, "q1", "deny", 3).unwrap());
    assert_eq!(store::expire_requests(&conn, "t1").unwrap(), ["q2"]);
    assert!(store::pending_requests(&conn, "t1").unwrap().is_empty());
}

#[test]
fn apagar_a_conversa_leva_os_itens_junto() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    store::upsert_item(&conn, "t1", None, &items_of(&json!({ "type": "agentMessage", "id": "a1", "text": "x" }), None)[0]).unwrap();
    conn.execute("DELETE FROM chat_thread WHERE id = 't1'", []).unwrap();
    assert!(store::items(&conn, "t1").unwrap().is_empty());
}

#[test]
fn a_mensagem_do_usuario_junta_os_textos_e_ignora_imagens() {
    let item = &items_of(&json!({ "type": "userMessage", "id": "u", "content": [
        { "type": "text", "text": "a" }, { "type": "localImage", "path": "/x.png" }, { "type": "text", "text": "b" }
    ] }), None)[0];
    assert_eq!((item.kind, item.text.as_deref()), (ItemKind::User, Some("a\n\nb")));
}

#[test]
fn o_comando_com_saida_diferente_de_zero_vira_erro() {
    let item = &items_of(&json!({ "type": "commandExecution", "id": "c", "command": "cargo test\n--lib", "status": "completed",
        "exitCode": 101, "aggregatedOutput": "falhou", "durationMs": 1200 }), None)[0];
    assert_eq!(item.tool, Some(ToolKind::Command));
    assert_eq!(item.status, Some(ToolStatus::Error));
    assert_eq!(item.label.as_deref(), Some("cargo test"));
    assert_eq!((item.output.as_deref(), item.duration_ms), (Some("falhou"), Some(1200)));
}

#[test]
fn a_edicao_vira_um_item_por_arquivo_com_as_linhas() {
    let items = items_of(&json!({ "type": "fileChange", "id": "f", "status": "completed", "changes": [
        { "path": "src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z" },
        { "path": "src/novo.rs", "kind": { "type": "add" }, "diff": "linha 1\nlinha 2\nlinha 3" },
    ] }), None);
    assert_eq!(items.len(), 2);
    assert_eq!((items[0].id.as_str(), items[0].tool, items[0].added, items[0].removed), ("f#0", Some(ToolKind::Edit), Some(2), Some(1)));
    assert_eq!((items[1].tool, items[1].path.as_deref(), items[1].added), (Some(ToolKind::Write), Some("src/novo.rs"), Some(3)));
}

#[test]
fn o_que_a_timeline_nao_mostra_nao_vira_item() {
    assert!(items_of(&json!({ "type": "reasoning", "id": "r", "summary": [], "content": [] }), None).is_empty());
    assert!(items_of(&json!({ "type": "agentMessage", "id": "a", "text": "  " }), None).is_empty());
    assert!(items_of(&json!({ "type": "agentMessage", "text": "sem id" }), None).is_empty());
}

#[test]
fn o_fim_do_turno_diz_se_foi_interrompido() {
    assert!(turn_end(&json!({ "id": "t", "status": "inProgress" }), None).is_none());
    let end = turn_end(&json!({ "id": "t", "status": "interrupted", "durationMs": 900 }), None).unwrap();
    assert_eq!((end.kind, end.id.as_str(), end.interrupted, end.duration_ms), (ItemKind::TurnEnd, "end:t", Some(true), Some(900)));
    let failed = turn_end(&json!({ "id": "t", "status": "failed", "error": { "message": "sem cota" } }), None).unwrap();
    assert_eq!(failed.text.as_deref(), Some("sem cota"));
}

#[test]
fn o_acesso_vira_politica_e_sandbox_do_codex() {
    assert_eq!(access_policy("ask"), ("untrusted", "workspace-write"));
    assert_eq!(access_policy("safe"), ("on-request", "workspace-write"));
    assert_eq!(access_policy("full"), ("never", "danger-full-access"));
    assert_eq!(access_policy("lixo"), ("untrusted", "workspace-write"));
}

#[test]
fn os_pedidos_de_aprovacao_e_pergunta_viram_o_que_mostrar() {
    let cmd = ask_of("item/commandExecution/requestApproval", &json!({ "itemId": "c", "command": "rm -rf build", "reason": "limpar" })).unwrap();
    assert_eq!((cmd.kind, cmd.title.as_str(), cmd.detail.as_str()), ("command", "rm -rf build", "limpar"));
    let q = ask_of("item/tool/requestUserInput", &json!({ "itemId": "q", "questions": [
        { "id": "q1", "header": "", "question": "Qual banco?", "isOther": false, "isSecret": false, "options": [{ "label": "SQLite", "description": "" }] }
    ] })).unwrap();
    assert_eq!((q.kind, q.title.as_str()), ("question", "Qual banco?"));
    assert_eq!(q.options, json!([{ "id": "q1", "question": "Qual banco?", "options": ["SQLite"] }]));
    assert!(ask_of("attestation/generate", &json!({})).is_none());
}

#[test]
fn a_resposta_sai_no_formato_do_protocolo() {
    assert_eq!(answer_of("command", "allow", &json!([])), json!({ "decision": "accept" }));
    assert_eq!(answer_of("fileChange", "allowSession", &json!([])), json!({ "decision": "acceptForSession" }));
    assert_eq!(answer_of("command", "deny", &json!([])), json!({ "decision": "decline" }));
    assert_eq!(answer_of("question", "SQLite", &json!([{ "id": "q1" }])), json!({ "answers": { "q1": { "answers": ["SQLite"] } } }));
}

#[test]
fn o_raciocinio_do_codex_vira_item_com_o_resumo_ou_o_texto() {
    let r = items_of(&json!({ "type": "reasoning", "id": "r1", "summary": ["Lendo o código", "Planejando"], "content": ["cru"] }), Some(3));
    assert_eq!((r[0].kind, r[0].text.as_deref()), (ItemKind::Reasoning, Some("Lendo o código\n\nPlanejando")));
    let c = items_of(&json!({ "type": "reasoning", "id": "r2", "summary": [], "content": ["só o texto"] }), None);
    assert_eq!(c[0].text.as_deref(), Some("só o texto"));
}

#[test]
fn o_plano_do_turno_vira_um_item_trocado_no_lugar() {
    let params = json!({ "threadId": "x", "turnId": "turn_1", "explanation": "por partes",
        "plan": [{ "step": "Ler", "status": "completed" }, { "step": "Testar", "status": "inProgress" }, { "step": "Entregar", "status": "pending" }] });
    let it = plan_item(&params, Some(9)).unwrap();
    assert_eq!((it.id.as_str(), it.tool, it.label.as_deref(), it.output.as_deref()), ("plan:turn_1", Some(ToolKind::Todo), Some("3"), Some("por partes")));
    let plan = it.plan.unwrap();
    assert_eq!(plan[1].status, crate::canal::timeline::StepStatus::InProgress);
    assert!(plan_item(&json!({ "plan": [] }), None).is_none(), "sem turno, nada");
}

#[test]
fn os_tokens_do_turno_contam_desde_a_primeira_chamada_dele() {
    let mut tokens = TurnTokens::default();
    // Primeiro aviso do turno: a base é o total antes desta chamada.
    assert_eq!(tokens.update("t1", 5_000, 1_200), 1_200);
    assert_eq!(tokens.update("t1", 7_000, 2_000), 3_200);
    // Turno novo: recomeça.
    assert_eq!(tokens.update("t2", 7_500, 500), 500);
    let params = |turn: &str, total: u64, last: u64| json!({ "turnId": turn, "tokenUsage": { "total": { "totalTokens": total }, "last": { "totalTokens": last } } });
    let mut fresh = TurnTokens::default();
    let it = usage_item(&mut fresh, &params("t9", 900, 900), Some(1)).unwrap();
    assert_eq!((it.kind, it.id.as_str(), it.tokens), (ItemKind::Usage, "usage:t9", Some(900)));
    assert!(usage_item(&mut fresh, &json!({ "turnId": "t9" }), None).is_none(), "sem total, nada");
}

// ── Claude Code por protocolo (`claude_map`) e roteamento (`api`) ─────────────

#[test]
fn os_pedacos_do_codex_dizem_o_item_e_se_sao_resposta_ou_raciocinio() {
    // Os parâmetros como nos bindings do app-server (`AgentMessageDeltaNotification`,
    // `ReasoningSummaryTextDeltaNotification`, `ReasoningSummaryPartAddedNotification`).
    let p = |extra: serde_json::Value| {
        let mut base = json!({ "threadId": "th", "turnId": "tu", "itemId": "it" });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base
    };
    assert_eq!(delta_of("item/agentMessage/delta", &p(json!({ "delta": "Ol" }))), Some(("it".into(), "Ol".into(), DeltaKind::Assistant)));
    assert_eq!(
        delta_of("item/reasoning/summaryTextDelta", &p(json!({ "delta": "Lendo", "summaryIndex": 0 }))),
        Some(("it".into(), "Lendo".into(), DeltaKind::Reasoning))
    );
    // A segunda parte do resumo começa com a linha em branco que o item final põe entre as partes.
    assert_eq!(delta_of("item/reasoning/summaryPartAdded", &p(json!({ "summaryIndex": 0 }))), None);
    assert_eq!(
        delta_of("item/reasoning/summaryPartAdded", &p(json!({ "summaryIndex": 1 }))),
        Some(("it".into(), "\n\n".into(), DeltaKind::Reasoning))
    );
    // O raciocínio cru, pedaço vazio ou sem item: nada.
    assert_eq!(delta_of("item/reasoning/textDelta", &p(json!({ "delta": "x", "contentIndex": 0 }))), None);
    assert_eq!(delta_of("item/agentMessage/delta", &p(json!({ "delta": "" }))), None);
    assert_eq!(delta_of("item/agentMessage/delta", &json!({ "delta": "x" })), None);
    assert_eq!((DeltaKind::Assistant.as_str(), DeltaKind::Reasoning.as_str()), ("assistant", "reasoning"));
}

mod claude {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use crate::canal::timeline::{ItemKind, ToolKind, ToolStatus};
    use crate::conversa::api::{self, Engine, NewThread};
    use crate::conversa::codex_map::DeltaKind;
    use crate::conversa::claude_map::{access_of_mode, answer_of, ask_of, launch_args, permission_mode, Mapper, Out, Pending, Start, TurnResult};
    use crate::conversa::store::ThreadRow;

    fn row(access: &str) -> ThreadRow {
        ThreadRow {
            id: "t".into(), agent_id: "claude-code".into(), remote_id: None, cwd: "/p".into(), title: String::new(),
            model: Some("haiku".into()), effort: Some("low".into()), access: access.into(), account_id: None,
            state: "active".into(), created_at: 1, updated_at: 1,
        }
    }

    fn items(outs: Vec<Out>) -> Vec<crate::canal::timeline::Item> {
        outs.into_iter().filter_map(|o| if let Out::Item(i) = o { Some(*i) } else { None }).collect()
    }

    // Linhas como as do `claude -p --output-format stream-json --include-partial-messages` 2.1.312
    // (encurtadas de uma sessão real).
    fn assistant(message_id: &str, block: Value) -> Value {
        json!({ "type": "assistant", "message": { "id": message_id, "role": "assistant", "content": [block] },
            "parent_tool_use_id": null, "uuid": "u-1", "timestamp": "2026-10-30T00:56:27.889Z" })
    }

    #[test]
    fn o_pensamento_vira_raciocinio_e_o_usage_vira_os_tokens_da_mensagem() {
        let mut m = Mapper::default();
        let line = json!({ "type": "assistant", "message": { "id": "msg_7", "role": "assistant",
            "usage": { "input_tokens": 4, "cache_read_input_tokens": 90, "output_tokens": 6 },
            "content": [{ "type": "thinking", "thinking": "conferir o snap" }] }, "parent_tool_use_id": null });
        let out = items(m.feed(&line, 1));
        assert_eq!(out.iter().map(|i| i.kind).collect::<Vec<_>>(), [ItemKind::Usage, ItemKind::Reasoning]);
        assert_eq!((out[0].id.as_str(), out[0].tokens), ("usage:msg_7", Some(100)));
        assert_eq!((out[1].id.as_str(), out[1].text.as_deref()), ("msg_7#0", Some("conferir o snap")));
        // O TodoWrite traz o plano.
        let todo = items(m.feed(&assistant("msg_8", json!({ "type": "tool_use", "id": "td", "name": "TodoWrite",
            "input": { "todos": [{ "content": "Ler", "status": "completed" }, { "content": "Testar", "status": "in_progress" }] } })), 2));
        assert_eq!(todo[0].plan.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn o_acesso_vira_o_modo_de_permissao_do_claude_e_volta() {
        let pairs = [("ask", "default"), ("edits", "acceptEdits"), ("safe", "auto"), ("full", "bypassPermissions"), ("plan", "plan")];
        for (access, mode) in pairs {
            assert_eq!(permission_mode(access), mode);
            assert_eq!(access_of_mode(mode), Some(access));
        }
        assert_eq!(permission_mode("lixo"), "default");
        assert_eq!(access_of_mode("manual"), Some("ask"));
        assert_eq!(access_of_mode("dontAsk"), None);
    }

    #[test]
    fn os_argumentos_abrem_ou_retomam_a_sessao_com_o_modo_modelo_e_esforco() {
        let new = launch_args(&row("plan"), Start::New("s-1"));
        let joined = new.join(" ");
        assert!(joined.starts_with("-p --input-format stream-json --output-format stream-json --verbose"));
        assert!(joined.contains("--permission-prompt-tool stdio --permission-mode plan --session-id s-1 --model haiku --effort low"));
        let resumed = launch_args(&ThreadRow { model: None, effort: None, ..row("safe") }, Start::Resume("s-1")).join(" ");
        assert!(resumed.ends_with("--permission-mode auto --resume s-1"));
    }

    #[test]
    fn a_ferramenta_abre_e_fecha_com_o_resultado() {
        let mut m = Mapper::default();
        let tool = items(m.feed(&assistant("msg_1", json!({ "type": "tool_use", "id": "toolu_1", "name": "Write",
            "input": { "file_path": "/p/ok.txt", "content": "OK" } })), 5));
        assert_eq!(tool.len(), 1);
        assert_eq!((tool[0].tool, tool[0].status, tool[0].path.as_deref(), tool[0].added), (Some(ToolKind::Write), Some(ToolStatus::Running), Some("/p/ok.txt"), Some(1)));
        assert!(tool[0].at.is_some_and(|at| at > 5));
        let done = items(m.feed(&json!({ "type": "user", "parent_tool_use_id": null, "message": { "role": "user", "content": [
            { "tool_use_id": "toolu_1", "type": "tool_result", "content": "File created successfully at: /p/ok.txt" }
        ] }, "tool_result_meta": [{ "id": "toolu_1", "permission_decision": { "decision": "accept", "source": "user_temporary" } }] }), 6));
        assert_eq!((done[0].id.as_str(), done[0].status), ("toolu_1", Some(ToolStatus::Done)));
        assert_eq!(done[0].output.as_deref(), Some("File created successfully at: /p/ok.txt"));
    }

    #[test]
    fn a_ferramenta_negada_aparece_como_negada() {
        let mut m = Mapper::default();
        m.feed(&assistant("msg_1", json!({ "type": "tool_use", "id": "toolu_2", "name": "Bash", "input": { "command": "rm -rf build" } })), 1);
        m.deny("toolu_2");
        let done = items(m.feed(&json!({ "type": "user", "message": { "content": [
            { "tool_use_id": "toolu_2", "type": "tool_result", "content": "negado", "is_error": true }
        ] } }), 2));
        assert_eq!(done[0].status, Some(ToolStatus::Denied));
    }

    #[test]
    fn o_texto_em_pedacos_tem_o_mesmo_id_do_item_final() {
        let mut m = Mapper::default();
        // Bloco 0 é o raciocínio (não aparece); o texto é o bloco 1, nos pedaços e na linha final.
        assert!(items(m.feed(&assistant("msg_9", json!({ "type": "thinking", "thinking": "" })), 1)).is_empty());
        let delta = m.feed(&json!({ "type": "stream_event", "parent_tool_use_id": null, "api_message_id": "msg_9",
            "event": { "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "O" } } }), 2);
        let Some(Out::Delta { item_id, delta, kind }) = delta.into_iter().next() else { panic!("sem delta") };
        let text = items(m.feed(&assistant("msg_9", json!({ "type": "text", "text": "OK" })), 3));
        assert_eq!((item_id.as_str(), delta.as_str(), kind), ("msg_9#1", "O", DeltaKind::Assistant));
        assert_eq!((text[0].kind, text[0].id.as_str(), text[0].text.as_deref()), (ItemKind::Assistant, "msg_9#1", Some("OK")));
        // Os outros eventos parciais (o JSON da ferramenta chegando) não viram nada.
        assert!(m.feed(&json!({ "type": "stream_event", "api_message_id": "msg_9",
            "event": { "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{" } } }), 4).is_empty());
    }

    #[test]
    fn o_raciocinio_em_pedacos_tem_o_mesmo_id_do_item_de_raciocinio() {
        let mut m = Mapper::default();
        let out = m.feed(&json!({ "type": "stream_event", "parent_tool_use_id": null, "api_message_id": "msg_7",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Vou ler" } } }), 1);
        assert_eq!(out, vec![Out::Delta { item_id: "msg_7#0".into(), delta: "Vou ler".into(), kind: DeltaKind::Reasoning }]);
        let final_item = items(m.feed(&assistant("msg_7", json!({ "type": "thinking", "thinking": "Vou ler o arquivo" })), 2));
        assert_eq!((final_item[0].kind, final_item[0].id.as_str()), (ItemKind::Reasoning, "msg_7#0"));
        // A assinatura do raciocínio e o pedaço vazio não viram nada.
        assert!(m.feed(&json!({ "type": "stream_event", "api_message_id": "msg_7",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "abc" } } }), 3).is_empty());
        assert!(m.feed(&json!({ "type": "stream_event", "api_message_id": "msg_7",
            "event": { "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "" } } }), 4).is_empty());
    }

    #[test]
    fn o_fim_do_turno_diz_se_foi_interrompido_ou_falhou() {
        let mut m = Mapper::default();
        m.feed(&json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] } }), 1);
        let out = m.feed(&json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "duration_ms": 1261,
            "terminal_reason": "aborted_streaming", "errors": ["[ede_diagnostic] result_type=user"] }), 2);
        assert_eq!(out, vec![Out::Done(TurnResult { interrupted: true, error: None, duration_ms: Some(1261) })]);
        let ok = m.feed(&json!({ "type": "result", "subtype": "success", "is_error": false, "duration_ms": 7181, "result": "OK", "terminal_reason": "completed" }), 3);
        assert_eq!(ok, vec![Out::Done(TurnResult { interrupted: false, error: None, duration_ms: Some(7181) })]);
        let failed = m.feed(&json!({ "type": "result", "subtype": "success", "is_error": true, "result": "Credit balance is too low" }), 4);
        assert_eq!(failed, vec![Out::Done(TurnResult { interrupted: false, error: Some("Credit balance is too low".into()), duration_ms: None })]);
    }

    #[test]
    fn o_inicio_e_o_status_dizem_a_sessao_e_o_modo() {
        let mut m = Mapper::default();
        assert_eq!(m.feed(&json!({ "type": "system", "subtype": "init", "session_id": "s-1", "permissionMode": "default" }), 1),
            vec![Out::Session("s-1".into()), Out::Mode("default".into())]);
        assert_eq!(m.feed(&json!({ "type": "system", "subtype": "status", "status": null, "permissionMode": "plan" }), 1), vec![Out::Mode("plan".into())]);
        assert!(m.feed(&json!({ "type": "system", "subtype": "thinking_tokens" }), 1).is_empty());
    }

    #[test]
    fn o_que_o_subagente_faz_nao_entra_na_timeline() {
        let mut m = Mapper::default();
        let mut line = assistant("msg_2", json!({ "type": "text", "text": "dentro do Task" }));
        line["parent_tool_use_id"] = json!("toolu_task");
        assert!(m.feed(&line, 1).is_empty());
    }

    #[test]
    fn a_saida_do_plano_vira_o_plano_na_timeline() {
        let mut m = Mapper::default();
        let plan = items(m.feed(&assistant("msg_3", json!({ "type": "tool_use", "id": "toolu_p", "name": "ExitPlanMode",
            "input": { "plan": "# Plano\n1. Ler\n2. Editar" } })), 1));
        assert_eq!((plan[0].tool, plan[0].label.as_deref()), (Some(ToolKind::Todo), Some("# Plano")));
        assert_eq!(plan[0].output.as_deref(), Some("# Plano\n1. Ler\n2. Editar"));
    }

    fn can_use_tool(tool: &str, input: Value) -> Value {
        json!({ "subtype": "can_use_tool", "tool_name": tool, "display_name": tool, "input": input, "tool_use_id": "toolu_x",
            "description": "ok.txt", "permission_suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }] })
    }

    #[test]
    fn os_pedidos_de_permissao_viram_o_que_mostrar() {
        let write = ask_of(&can_use_tool("Write", json!({ "file_path": "/p/ok.txt", "content": "OK" }))).unwrap();
        assert_eq!((write.kind, write.title.as_str(), write.item_id.as_deref()), ("fileChange", "/p/ok.txt", Some("toolu_x")));
        assert_eq!(write.options, json!({ "tool": "Write" }));
        let bash = ask_of(&can_use_tool("Bash", json!({ "command": "cargo test\n--lib", "description": "Roda os testes" }))).unwrap();
        assert_eq!((bash.kind, bash.title.as_str(), bash.detail.as_str()), ("command", "cargo test", "Roda os testes"));
        let fetch = ask_of(&can_use_tool("WebFetch", json!({ "url": "https://exemplo.dev" }))).unwrap();
        assert_eq!((fetch.kind, fetch.title.as_str(), fetch.detail.as_str()), ("command", "WebFetch: https://exemplo.dev", "ok.txt"));
        let plan = ask_of(&can_use_tool("ExitPlanMode", json!({ "plan": "1. Ler" }))).unwrap();
        assert_eq!((plan.kind, plan.title.as_str(), plan.detail.as_str()), ("command", "", "1. Ler"));
        assert_eq!(plan.options, json!({ "tool": "ExitPlanMode" }));
        let q = ask_of(&can_use_tool("AskUserQuestion", json!({ "questions": [
            { "question": "Qual banco?", "header": "Banco", "multiSelect": false, "options": [{ "label": "SQLite", "description": "" }, { "label": "Postgres", "description": "" }] }
        ] }))).unwrap();
        assert_eq!((q.kind, q.title.as_str()), ("question", "Qual banco?"));
        assert_eq!(q.options, json!([{ "id": "Qual banco?", "question": "Qual banco?", "options": ["SQLite", "Postgres"] }]));
        assert!(ask_of(&json!({ "subtype": "hook_callback" })).is_none());
    }

    #[test]
    fn a_resposta_sai_no_formato_do_can_use_tool() {
        let write = Pending::of(&can_use_tool("Write", json!({ "file_path": "/p/ok.txt" })));
        assert_eq!(answer_of(&write, "allow"), (json!({ "behavior": "allow", "updatedInput": { "file_path": "/p/ok.txt" } }), None));
        let (deny, _) = answer_of(&write, "deny");
        assert_eq!(deny["behavior"], "deny");
        assert!(deny.get("interrupt").is_none());
        assert_eq!(answer_of(&write, "cancel").0["interrupt"], true);
        // Na sessão: as sugestões do Claude, sempre só na sessão; aceitar edições muda o acesso.
        let (session, access) = answer_of(&write, "allowSession");
        assert_eq!(session["updatedPermissions"], json!([{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }]));
        assert_eq!(access, Some("edits"));
        let fetch = Pending { tool: "WebFetch".into(), input: json!({ "url": "u" }),
            suggestions: vec![json!({ "type": "addRules", "rules": [{ "toolName": "WebFetch" }], "behavior": "allow", "destination": "localSettings" })] };
        assert_eq!(answer_of(&fetch, "allowSession").0["updatedPermissions"][0]["destination"], "session");
        let bare = Pending { tool: "Bash".into(), input: json!({}), suggestions: Vec::new() };
        assert_eq!(answer_of(&bare, "allowSession").0["updatedPermissions"],
            json!([{ "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "session" }]));
    }

    #[test]
    fn a_pergunta_e_a_saida_do_plano_respondem_com_o_que_o_claude_espera() {
        let q = Pending { tool: "AskUserQuestion".into(), input: json!({ "questions": [{ "question": "Qual banco?" }] }), suggestions: Vec::new() };
        let (answer, _) = answer_of(&q, "SQLite");
        assert_eq!(answer["updatedInput"]["answers"], json!({ "Qual banco?": "SQLite" }));
        assert_eq!(answer["updatedInput"]["questions"][0]["question"], "Qual banco?");
        let plan = Pending { tool: "ExitPlanMode".into(), input: json!({ "plan": "1." }), suggestions: Vec::new() };
        let (approve, access) = answer_of(&plan, "allow");
        assert_eq!((approve["updatedPermissions"][0]["mode"].as_str(), access), (Some("default"), Some("ask")));
        assert_eq!(answer_of(&plan, "allowSession").1, Some("edits"));
        let (keep, access) = answer_of(&plan, "deny");
        assert_eq!((keep["behavior"].as_str(), access), (Some("deny"), None));
    }

    #[test]
    fn o_roteamento_aceita_o_claude_e_o_plano_so_nele() {
        assert_eq!(Engine::of("claude-code"), Some(Engine::Claude));
        assert_eq!(Engine::of("codex"), Some(Engine::Codex));
        assert_eq!(Engine::of("gemini-cli"), None);
        assert!(api::structured_agent("claude-code") && api::structured_agent("codex") && !api::structured_agent("gemini-cli"));
        assert!(Engine::Claude.accepts("plan") && !Engine::Codex.accepts("plan"));
        assert!(Engine::Codex.accepts("edits") && !Engine::Claude.accepts("lixo"));
    }

    #[test]
    fn criar_e_trocar_respeitam_o_que_cada_agente_aceita() {
        let db = Arc::new(Mutex::new(crate::database::test_db()));
        let input = |agent: &str, access: &str| NewThread {
            agent_id: agent.into(), cwd: "/p".into(), title: "T".into(), model: None, effort: None, access: access.into(), account_id: None,
        };
        let claude = api::create(&db, input("claude-code", "plan")).unwrap();
        assert_eq!((claude.agent_id.as_str(), claude.access.as_str()), ("claude-code", "plan"));
        assert!(api::create(&db, input("codex", "plan")).is_err());
        assert!(api::create(&db, input("gemini-cli", "ask")).is_err());
        let codex = api::create(&db, input("codex", "ask")).unwrap();
        assert!(api::retune(&db, &codex.id, None, None, "plan".into()).is_err());
        // Sem processo aberto, trocar só grava.
        let row = api::retune(&db, &claude.id, Some("haiku".into()), None, "edits".into()).unwrap();
        assert_eq!((row.model.as_deref(), row.access.as_str()), (Some("haiku"), "edits"));
        assert_eq!(api::status(&claude.id), api::ThreadStatus { alive: false, working: false });
    }
}

fn user_item(id: &str) -> crate::canal::timeline::Item {
    crate::canal::timeline::Item::new(ItemKind::User, id.to_string(), None)
}

fn pending_request(conn: &rusqlite::Connection, id: &str, thread_id: &str) {
    let row = RequestRow {
        id: id.into(), thread_id: thread_id.into(), rpc_id: "7".into(), kind: "command".into(), item_id: None,
        title: "ls".into(), detail: String::new(), options: json!([]), state: "pending".into(), created_at: 1,
    };
    store::insert_request(conn, &row).unwrap();
}

#[test]
fn processo_que_cai_no_turno_vira_erro_e_o_fechado_de_proposito_vira_interrompido() {
    // Fechado por nós (fechar a conversa, trocar o acesso): é interrupção, sem texto e sem aviso de erro.
    let (parado, aviso) = super::turn::dropped(true, None, "Codex");
    assert!(parado.interrupted && parado.error.is_none() && aviso.is_none());
    // Caiu sozinho: não é a pessoa que parou, é erro com o motivo.
    let (caiu, aviso) = super::turn::dropped(false, None, "Codex");
    assert!(!caiu.interrupted);
    assert_eq!(caiu.error.as_deref(), Some("O processo do Codex fechou no meio do turno"));
    assert_eq!(aviso, caiu.error);
    // Com o rabo do stderr, o motivo é ele.
    let (com_stderr, _) = super::turn::dropped(false, Some("  panic: sem memória  "), "Claude");
    assert_eq!(com_stderr.error.as_deref(), Some("panic: sem memória"));
}

#[test]
fn o_fim_do_turno_que_caiu_grava_o_erro_no_item_e_expira_os_pedidos() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    store::upsert_run(&conn, "t1", "r1", "inProgress", Some(1), None, None).unwrap();
    pending_request(&conn, "q1", "t1");
    let (result, _) = super::turn::dropped(false, None, "Codex");
    assert_eq!(super::turn::record_end(&conn, "t1", "r1", &result, 50), ["q1"]);
    assert_eq!(store::run_status(&conn, "t1", "r1").unwrap().as_deref(), Some("failed"), "o turno não fica inProgress");
    let end = store::items(&conn, "t1").unwrap().into_iter().find(|i| i.kind == ItemKind::TurnEnd).expect("o turnEnd é gravado");
    assert_eq!((end.id.as_str(), end.interrupted, end.text.as_deref()), ("end:r1", Some(false), Some("O processo do Codex fechou no meio do turno")));
    assert!(store::pending_requests(&conn, "t1").unwrap().is_empty());
}

#[test]
fn no_arranque_o_turno_e_os_pedidos_orfaos_expiram_sem_apagar_nada() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    thread(&conn, "t2");
    // t1: um turno concluído e um que o app deixou aberto (a queda do app mata o agente).
    store::upsert_run(&conn, "t1", "r1", "completed", Some(1), Some(2), Some(1)).unwrap();
    store::upsert_run(&conn, "t1", "r2", "inProgress", Some(3), None, None).unwrap();
    store::upsert_item(&conn, "t1", Some("r2"), &user_item("u2")).unwrap();
    pending_request(&conn, "q1", "t1");
    // t2: o turno aberto NÃO é o último da timeline (um mais novo já escreveu): não ganha turnEnd.
    store::upsert_run(&conn, "t2", "r3", "inProgress", Some(3), None, None).unwrap();
    store::upsert_item(&conn, "t2", Some("r3"), &user_item("u3")).unwrap();
    store::upsert_item(&conn, "t2", Some("r4"), &user_item("u4")).unwrap();

    let sweep = store::sweep_orphans(&conn, 100).unwrap();
    assert_eq!((sweep.runs, sweep.requests), (2, 1));
    assert_eq!(store::run_status(&conn, "t1", "r1").unwrap().as_deref(), Some("completed"), "o que acabou fica como estava");
    assert_eq!(store::run_status(&conn, "t1", "r2").unwrap().as_deref(), Some("interrupted"));
    assert!(store::pending_requests(&conn, "t1").unwrap().is_empty());
    let expired: String = conn.query_row("SELECT state FROM chat_request WHERE id = 'q1'", [], |r| r.get(0)).unwrap();
    assert_eq!(expired, "expired", "o pedido continua na tabela, só expirado");
    // O turno que ficou aberto na ponta ganha o turnEnd durável; o do meio, não.
    let end = store::items(&conn, "t1").unwrap().into_iter().find(|i| i.kind == ItemKind::TurnEnd).expect("turnEnd do app que fechou");
    assert_eq!((end.id.as_str(), end.interrupted), ("end:r2", Some(false)));
    assert!(end.text.as_deref().is_some_and(|t| t.contains("app foi fechado")), "{:?}", end.text);
    assert!(store::items(&conn, "t2").unwrap().iter().all(|i| i.kind != ItemKind::TurnEnd));
    assert_eq!(store::items(&conn, "t2").unwrap().len(), 2, "nenhuma linha apagada");
    // Rodar de novo não acha mais nada.
    let again = store::sweep_orphans(&conn, 200).unwrap();
    assert_eq!((again.runs, again.requests), (0, 0));
}

// ── Etapa 2: o envio a uma conversa (trava, modo, classe do erro) ────────

mod envio {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::super::api::{admits, codex_error, send_gate, steer_falls_back_to_start};
    use super::super::codex::{failure_of, RequestFailure};
    use super::super::envio::{SendError, SendMode};

    #[test]
    fn o_modo_fila_so_entra_com_a_conversa_livre_e_o_steer_sempre() {
        assert!(admits(SendMode::QueueAfterActive, false));
        assert!(!admits(SendMode::QueueAfterActive, true));
        assert!(admits(SendMode::SteerActive, true) && admits(SendMode::SteerActive, false));
    }

    #[test]
    fn o_steer_recusado_so_vira_turn_start_se_o_turno_ja_nao_e_o_mesmo() {
        assert!(steer_falls_back_to_start("t1", None), "o turno acabou entre a checagem e o pedido");
        assert!(steer_falls_back_to_start("t1", Some("t2")), "outro turno já começou");
        assert!(!steer_falls_back_to_start("t1", Some("t1")), "o turno segue: a recusa é de outro motivo");
    }

    #[test]
    fn so_o_pedido_que_saiu_e_perdeu_a_resposta_e_desconhecido() {
        assert_eq!(codex_error(RequestFailure::NotSent("fechou".into())), SendError::NotSent("fechou".into()));
        assert_eq!(codex_error(RequestFailure::Rejected("turno velho".into())), SendError::NotSent("turno velho".into()));
        assert!(matches!(codex_error(RequestFailure::Lost("sem resposta".into())), SendError::Unknown(m) if m.starts_with("sem resposta") && m.contains("confira a conversa antes de reenviar")));
    }

    #[test]
    fn a_mensagem_de_processo_fechado_e_perda_e_o_erro_do_servidor_e_recusa() {
        assert_eq!(failure_of(Err("O processo do Codex fechou".into())), Err(RequestFailure::Lost("O processo do Codex fechou".into())));
        assert_eq!(failure_of(Err("expectedTurnId não confere".into())), Err(RequestFailure::Rejected("expectedTurnId não confere".into())));
        assert!(failure_of(Ok(serde_json::json!({ "ok": true }))).is_ok());
    }

    #[test]
    fn o_erro_de_envio_vira_texto_para_quem_so_conhece_string() {
        assert_eq!(String::from(SendError::NotSent("x".into())), "x");
        assert!(String::from(SendError::Busy).contains("turno"));
    }

    #[test]
    fn a_trava_e_uma_por_conversa() {
        assert!(Arc::ptr_eq(&send_gate("gate-a"), &send_gate("gate-a")));
        assert!(!Arc::ptr_eq(&send_gate("gate-a"), &send_gate("gate-b")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dois_envios_a_mesma_conversa_nunca_entram_juntos() {
        let inside = Arc::new(AtomicUsize::new(0));
        let highest = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let (inside, highest) = (inside.clone(), highest.clone());
                tokio::spawn(async move {
                    let gate = send_gate("gate-corrida");
                    let _held = gate.lock().await;
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    highest.fetch_max(now, Ordering::SeqCst);
                    // Cede a vez no meio do "envio": sem a trava, outro entraria aqui.
                    tokio::task::yield_now().await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(highest.load(Ordering::SeqCst), 1);
    }
}

// ── Etapa 3 (A1): retomar a sessão sem esquecer em silêncio ─────────────

mod retomada {
    use std::cell::RefCell;
    use std::sync::Arc;
    use std::time::Duration;

    use super::super::resume::{classify, lost_notice, open_resuming, start_gate, Opened, ResumeFailure, RETRY_PAUSES};

    /// Roda `open_resuming` com as tentativas roteirizadas: o que cada `resume` devolve, em ordem, e o registro
    /// de quantas vezes abriu sessão nova e de quais pausas pediu (sem relógio).
    fn run(script: Vec<Result<&'static str, ResumeFailure>>) -> (Result<Opened<&'static str>, String>, usize, Vec<Duration>) {
        let script = RefCell::new(script.into_iter());
        let fresh_calls = RefCell::new(0usize);
        let pauses = RefCell::new(Vec::new());
        let out = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(open_resuming(
            || async { script.borrow_mut().next().expect("tentativa a mais") },
            || async { *fresh_calls.borrow_mut() += 1; Ok("nova") },
            |wait| { pauses.borrow_mut().push(wait); async {} },
        ));
        (out, *fresh_calls.borrow(), pauses.into_inner())
    }

    #[test]
    fn a_retomada_que_funciona_nao_abre_sessao_nova_nem_avisa() {
        let (out, fresh, pauses) = run(vec![Ok("retomada")]);
        assert_eq!(out, Ok(Opened { session: "retomada", lost: None }));
        assert_eq!((fresh, pauses.len()), (0, 0));
    }

    #[test]
    fn a_sessao_que_nao_existe_mais_abre_outra_e_diz_o_motivo() {
        let (out, fresh, pauses) = run(vec![Err(ResumeFailure::Gone("No conversation found".into()))]);
        assert_eq!(out, Ok(Opened { session: "nova", lost: Some("No conversation found".into()) }));
        assert_eq!((fresh, pauses.len()), (1, 0), "sem retentativa: ela não existe");
    }

    #[test]
    fn o_erro_transitorio_tenta_de_novo_com_pausa_curta_e_nao_esquece_se_voltar() {
        let (out, fresh, pauses) = run(vec![Err(ResumeFailure::Transient("fechou".into())), Ok("retomada")]);
        assert_eq!(out, Ok(Opened { session: "retomada", lost: None }));
        assert_eq!((fresh, pauses), (0, vec![RETRY_PAUSES[0]]));
    }

    #[test]
    fn o_erro_transitorio_que_persiste_abre_outra_mas_avisa() {
        let (out, fresh, pauses) = run(vec![Err(ResumeFailure::Transient("a".into())), Err(ResumeFailure::Transient("b".into())), Err(ResumeFailure::Transient("c".into()))]);
        assert_eq!(out, Ok(Opened { session: "nova", lost: Some("c".into()) }));
        assert_eq!((fresh, pauses), (1, RETRY_PAUSES.to_vec()), "duas retentativas e depois a nova, com o último motivo");
    }

    #[test]
    fn o_prazo_nao_abre_sessao_nova_e_o_erro_de_abrir_o_processo_tambem_nao() {
        let (out, fresh, _) = run(vec![Err(ResumeFailure::Timeout("O Claude não respondeu a initialize".into()))]);
        assert!(out.unwrap_err().contains("Ela foi mantida"));
        assert_eq!(fresh, 0, "a sessão pode existir: o id dela não é trocado");
        let (out, fresh, _) = run(vec![Err(ResumeFailure::Fatal("Não achei o Claude".into()))]);
        assert_eq!((out, fresh), (Err("Não achei o Claude".to_string()), 0));
    }

    #[test]
    fn os_textos_dos_motores_viram_a_classe_certa() {
        assert!(matches!(classify("Não achei o Claude Code (claude) no PATH"), ResumeFailure::Fatal(_)));
        assert!(matches!(classify("Não consegui abrir o Codex: boom"), ResumeFailure::Fatal(_)));
        assert!(matches!(classify("O Codex não respondeu a thread/resume"), ResumeFailure::Timeout(_)));
        assert!(matches!(classify("O Claude não respondeu a initialize"), ResumeFailure::Timeout(_)));
        assert!(matches!(classify("No conversation found with session ID: abc"), ResumeFailure::Gone(_)));
        assert!(matches!(classify("thread not found: thr_9"), ResumeFailure::Gone(_)));
        assert!(matches!(classify("O processo do Claude fechou"), ResumeFailure::Transient(_)));
        assert!(matches!(classify("erro do OpenCode"), ResumeFailure::Transient(_)));
    }

    #[test]
    fn o_aviso_da_timeline_diz_que_o_agente_recomecou_sem_historico() {
        assert!(lost_notice("").contains("recomeçou sem o histórico"));
        assert!(lost_notice("thread not found").ends_with("Motivo: thread not found"));
    }

    #[test]
    fn a_trava_de_abertura_e_por_conversa_e_por_motor() {
        assert!(Arc::ptr_eq(&start_gate("claude", "a"), &start_gate("claude", "a")));
        assert!(!Arc::ptr_eq(&start_gate("claude", "a"), &start_gate("claude", "b")), "um agente lento não trava as outras conversas");
        assert!(!Arc::ptr_eq(&start_gate("claude", "a"), &start_gate("codex", "a")));
    }
}

// ── Etapa 3 (A1): opções do OpenCode que não se engolem, e o item de aviso ──

mod opcoes {
    use serde_json::json;

    use super::super::opencode::{plan_option, OptionPlan};
    use super::super::turn::notice_item;
    use crate::canal::timeline::ItemKind;

    fn config() -> serde_json::Value {
        json!({ "configOptions": [
            { "id": "effort", "currentValue": "default", "options": [{ "value": "low" }, { "value": "default" }] },
            { "id": "mode", "currentValue": "build", "options": [{ "value": "build" }, { "value": "plan" }] },
        ] })
    }

    #[test]
    fn a_opcao_igual_nao_se_pede_a_ausente_se_marca_e_a_desconhecida_se_tenta() {
        assert_eq!(plan_option(&config(), "mode", "build"), OptionPlan::Same);
        assert_eq!(plan_option(&config(), "mode", "plan"), OptionPlan::Set);
        assert_eq!(plan_option(&config(), "effort", "ultra"), OptionPlan::Unavailable, "o modelo não tem esse esforço: aviso, nunca silêncio");
        assert_eq!(plan_option(&json!({}), "mode", "build"), OptionPlan::Set, "o OpenCode que não lista a opção: tenta mesmo assim");
    }

    #[test]
    fn o_aviso_e_um_item_proprio_com_o_codigo_no_label_e_id_unico() {
        let a = notice_item("resumeLost", "A sessão anterior não pôde ser retomada", 5);
        let b = notice_item("resumeLost", "A sessão anterior não pôde ser retomada", 5);
        assert_eq!((a.kind, a.label.as_deref(), a.at), (ItemKind::Notice, Some("resumeLost"), Some(5)));
        assert_ne!(a.id, b.id, "dois avisos iguais não colapsam");
        assert_eq!(serde_json::to_value(&a).unwrap()["kind"], "notice");
    }
}

// ── Etapa 3 (A2): a fila que não some mensagem ──────────────────────────

mod fila {
    use std::sync::{Arc, Barrier};

    use super::super::turn::{dropped_items, Admitted, Lane};
    use crate::canal::timeline::ItemKind;

    #[test]
    fn a_conversa_livre_comeca_o_turno_e_a_ocupada_enfileira_em_ordem() {
        let lane = Lane::default();
        let Admitted::Start(first) = lane.admit("um") else { panic!("livre: começa") };
        assert_eq!(lane.turn().as_deref(), Some(first.as_str()), "o turno já fica reservado");
        assert_eq!((lane.admit("dois"), lane.admit("tres")), (Admitted::Queued, Admitted::Queued));
        assert_eq!(lane.queued(), 2);
        assert_eq!(lane.take_turn().as_deref(), Some(first.as_str()));
        let (turn, text) = lane.advance().unwrap();
        assert_eq!(text, "dois", "FIFO");
        assert_eq!(lane.turn().as_deref(), Some(turn.as_str()));
        assert_eq!(lane.drain(), ["tres"]);
        lane.take_turn();
        assert!(lane.advance().is_none());
        assert!(matches!(lane.admit("quatro"), Admitted::Start(_)), "fila vazia e sem turno: a próxima começa");
    }

    /// A corrida que encalhava a mensagem: ela chega no instante em que o turno acaba. Com a decisão sob uma
    /// trava só, ou ela é vista pelo `advance` (estava na fila) ou acha o turno livre e começa. Nunca fica na
    /// fila com o turno livre.
    #[test]
    fn a_mensagem_que_chega_quando_o_turno_acaba_nunca_fica_encalhada() {
        for _ in 0..500 {
            let lane = Arc::new(Lane::default());
            assert!(matches!(lane.admit("em andamento"), Admitted::Start(_)));
            let barrier = Arc::new(Barrier::new(2));
            let ender = {
                let (lane, barrier) = (lane.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    lane.take_turn();
                    lane.advance()
                })
            };
            barrier.wait();
            let admitted = lane.admit("no instante");
            let advanced = ender.join().unwrap();
            let started = matches!(admitted, Admitted::Start(_));
            let popped = advanced.is_some();
            assert!(started ^ popped, "exatamente um dos dois a leva: {admitted:?} / {advanced:?}");
            assert!(lane.queued() == 0, "nada encalhado na fila");
        }
    }

    #[test]
    fn cada_mensagem_descartada_vira_um_aviso_nao_enviada_com_o_texto_dela() {
        let items = dropped_items(vec!["rode os testes".into(), "rode os testes".into(), "e o lint?".into()], 9);
        assert_eq!(items.len(), 3, "duas iguais são duas mensagens: nenhuma some");
        assert!(items.iter().all(|i| i.kind == ItemKind::Notice && i.label.as_deref() == Some("queueDropped") && i.at == Some(9)));
        assert_eq!(items.iter().map(|i| i.text.as_deref().unwrap()).collect::<Vec<_>>(), ["rode os testes", "rode os testes", "e o lint?"]);
        let ids: std::collections::HashSet<_> = items.iter().map(|i| i.id.clone()).collect();
        assert_eq!(ids.len(), 3);
        assert!(dropped_items(Vec::new(), 9).is_empty());
    }
}

// ── Etapa 3 (A4): o aviso no stderr não é o erro ────────────────────────

mod stderr {
    use super::super::turn::{dropped, stderr_reason};

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn o_aviso_depois_do_erro_nao_vira_o_motivo_da_queda() {
        let tail = lines(&["Error: sessão corrompida", "", "warning: update available", "  INFO  shutting down"]);
        assert_eq!(stderr_reason(tail.iter()).as_deref(), Some("Error: sessão corrompida"));
        // Antes (a última linha qualquer) o motivo mostrado era o aviso inofensivo.
        let before = tail.iter().rev().find(|l| !l.trim().is_empty()).cloned();
        assert_eq!(before.as_deref(), Some("  INFO  shutting down"));
    }

    #[test]
    fn so_aviso_no_stderr_cai_na_frase_generica() {
        let tail = lines(&["[WARN] node deprecation", "debug: closing"]);
        assert_eq!(stderr_reason(tail.iter()), None);
        let (result, message) = dropped(false, None, "Claude");
        assert_eq!(result.error.as_deref(), Some("O processo do Claude fechou no meio do turno"));
        assert_eq!(message, result.error);
    }
}

// ── Etapa 3 (B): a permissão decidida no backend ────────────────────────

mod permissao {
    use rusqlite::Connection;
    use serde_json::{json, Value};

    use super::super::codex_map::{ask_of, Ask};
    use super::super::permission::{draft_claude, draft_codex, draft_opencode, plan, plan_stored, Draft};
    use super::super::store::{self, RequestRow, Tuning};
    use crate::chat_team::model::{Policy, Verdict};
    use crate::chat_team::permission::{Kind, Subject};
    use crate::chat_team::store as team_store;
    use crate::chat_team::store::NewMember;

    fn db() -> Connection {
        crate::database::test_db()
    }

    /// Uma conversa `t1` no time `team1` (orquestrador `tab-lead`), com a política dada.
    fn member_with(conn: &Connection, policy: Policy) {
        store::insert_thread(conn, "t1", "codex", "/p", "T", &Tuning { model: None, effort: None, access: "ask".into() }, None, 1).unwrap();
        let row = team_store::TeamRow { id: "team1".into(), orchestrator: "tab-lead".into(), agent_id: "claude-code".into(), label: "L".into(), cwd: "/p".into(), title: "T".into(), created_at: 1, updated_at: 1, auto_decide: true };
        team_store::insert_team(conn, &row).unwrap();
        let new = NewMember { member: "thread:t1".into(), agent_id: "codex".into(), label: "Codex".into(), role: "backend".into(), origin: "existing".into(), ..Default::default() };
        team_store::insert_member(conn, "team1", &new, policy, 1).unwrap();
    }

    fn cmd(detail: &str) -> Subject {
        Subject::new(Kind::Command, detail.into(), vec![], Some("/p".into()), "codex")
    }

    fn request(id: &str, kind: &str) -> RequestRow {
        RequestRow { id: id.into(), thread_id: "t1".into(), rpc_id: "7".into(), kind: kind.into(), item_id: None, title: "ls".into(), detail: String::new(), options: json!([]), state: "pending".into(), created_at: 1 }
    }

    // ── o pedido inteiro, não o título truncado ──

    fn codex_ask(command: &str) -> (Value, Ask) {
        let params = json!({ "itemId": "i1", "command": command, "reason": "r" });
        let ask = ask_of("item/commandExecution/requestApproval", &params).unwrap();
        (params, ask)
    }

    #[test]
    fn o_codex_decide_sobre_o_comando_inteiro_e_nao_sobre_a_primeira_linha() {
        let (params, ask) = codex_ask("ls -la\nrm -rf ~");
        assert_eq!(ask.title, "ls -la", "o título guarda só a primeira linha");
        let draft = draft_codex("item/commandExecution/requestApproval", &params, &ask).unwrap();
        assert_eq!((draft.kind, draft.detail.as_str()), (Kind::Command, "ls -la\nrm -rf ~"));
    }

    #[test]
    fn o_claude_usa_o_comando_do_input_a_edicao_o_arquivo_a_rede_o_endereco_e_a_pergunta_fica_com_a_pessoa() {
        let bash = json!({ "subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "t", "input": { "command": "ls\nnode steal.js" } });
        let draft = draft_claude(&bash, &crate::conversa::claude_map::ask_of(&bash).unwrap()).unwrap();
        assert_eq!(draft.detail, "ls\nnode steal.js");
        let edit = json!({ "subtype": "can_use_tool", "tool_name": "Edit", "tool_use_id": "t", "input": { "file_path": "src/a.ts" } });
        let draft = draft_claude(&edit, &crate::conversa::claude_map::ask_of(&edit).unwrap()).unwrap();
        assert_eq!((draft.kind, draft.files), (Kind::Edit, vec!["src/a.ts".to_string()]));
        let web = json!({ "subtype": "can_use_tool", "tool_name": "WebFetch", "tool_use_id": "t", "input": { "url": "https://docs.rs/x" } });
        let draft = draft_claude(&web, &crate::conversa::claude_map::ask_of(&web).unwrap()).unwrap();
        assert_eq!(draft.kind, Kind::Network);
        let other = json!({ "subtype": "can_use_tool", "tool_name": "mcp__x__run", "tool_use_id": "t", "input": {} });
        let draft = draft_claude(&other, &crate::conversa::claude_map::ask_of(&other).unwrap()).unwrap();
        assert!(draft.kind == Kind::Command && draft.detail.starts_with("mcp__x__run"), "ferramenta de fora do shell: o nome fica no começo");
        let plan_exit = json!({ "subtype": "can_use_tool", "tool_name": "ExitPlanMode", "tool_use_id": "t", "input": { "plan": "p" } });
        assert_eq!(draft_claude(&plan_exit, &crate::conversa::claude_map::ask_of(&plan_exit).unwrap()), None);
        let question = json!({ "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": "t", "input": { "questions": [] } });
        assert_eq!(draft_claude(&question, &crate::conversa::claude_map::ask_of(&question).unwrap()), None);
    }

    #[test]
    fn o_opencode_usa_o_comando_do_raw_input() {
        let params = json!({
            "options": [{ "optionId": "o1", "kind": "allow_once", "name": "Allow" }],
            "toolCall": { "toolCallId": "c", "kind": "execute", "title": "bash", "rawInput": { "command": "ls\nrm -rf ~" } },
        });
        let ask = crate::conversa::opencode_map::ask_of(&params).unwrap();
        let draft = draft_opencode(&params, &ask).unwrap();
        assert_eq!(draft, Draft { kind: Kind::Command, detail: "ls\nrm -rf ~".into(), files: vec![] });
    }

    // ── quem decide ──

    #[test]
    fn o_integrante_com_acesso_total_e_liberado_pela_politica_e_o_so_leitura_e_negado() {
        let conn = db();
        member_with(&conn, Policy::Full);
        let d = plan(&conn, "t1", &cmd("bun add zod"));
        assert_eq!((d.verdict, d.by.as_str()), (Verdict::Allow, "policy"));
        assert_eq!(plan(&conn, "t1", &cmd("git push origin main")).verdict, Verdict::Ask, "risco alto vai à pessoa");
        team_store::patch_member(&conn, "thread:t1", &team_store::MemberPatch { policy: Some(Policy::Read), ..Default::default() }, 2).unwrap();
        assert_eq!(plan(&conn, "t1", &cmd("bun add zod")).verdict, Verdict::Deny);
    }

    #[test]
    fn a_regra_da_pessoa_libera_o_que_a_politica_pergunta() {
        let conn = db();
        member_with(&conn, Policy::Ask);
        assert_eq!(plan(&conn, "t1", &cmd("cargo build")).verdict, Verdict::Ask);
        let rule = team_store::add_rule(&conn, Kind::Command, "cargo build *", None, 5).unwrap();
        let d = plan(&conn, "t1", &cmd("cargo build --release"));
        assert_eq!((d.verdict, d.by), (Verdict::Allow, format!("rule:{}", rule.id)));
        assert_eq!(plan(&conn, "t1", &cmd("cargo build\nrm -rf ~")).verdict, Verdict::Ask, "o comando inteiro, não a primeira linha");
    }

    #[test]
    fn o_interruptor_do_time_manda_tudo_para_a_pessoa() {
        let conn = db();
        member_with(&conn, Policy::Full);
        team_store::add_rule(&conn, Kind::Command, "*", None, 5).unwrap();
        assert_eq!(plan(&conn, "t1", &cmd("ls")).verdict, Verdict::Allow);
        team_store::set_auto_decide(&conn, "team1", false).unwrap();
        assert_eq!(plan(&conn, "t1", &cmd("ls")).verdict, Verdict::Ask);
    }

    #[test]
    fn fora_de_time_so_as_regras_valem_e_sem_regra_pergunta() {
        let conn = db();
        store::insert_thread(&conn, "t1", "codex", "/p", "T", &Tuning { model: None, effort: None, access: "ask".into() }, None, 1).unwrap();
        assert_eq!(plan(&conn, "t1", &cmd("ls")).verdict, Verdict::Ask);
        team_store::add_rule(&conn, Kind::Command, "ls *", Some("codex"), 5).unwrap();
        assert_eq!(plan(&conn, "t1", &cmd("ls -la")).verdict, Verdict::Allow);
        let other = Subject::new(Kind::Command, "ls -la".into(), vec![], None, "claude-code");
        assert_eq!(plan(&conn, "t1", &other).verdict, Verdict::Ask, "a regra é do Codex");
    }

    #[test]
    fn o_orquestrador_nao_tem_politica_so_regras() {
        let conn = db();
        store::insert_thread(&conn, "lead", "claude-code", "/p", "T", &Tuning { model: None, effort: None, access: "ask".into() }, None, 1).unwrap();
        let row = team_store::TeamRow { id: "team1".into(), orchestrator: "thread:lead".into(), agent_id: "claude-code".into(), label: "L".into(), cwd: "/p".into(), title: "T".into(), created_at: 1, updated_at: 1, auto_decide: true };
        team_store::insert_team(&conn, &row).unwrap();
        assert_eq!(plan(&conn, "lead", &cmd("bun add zod")).verdict, Verdict::Ask, "sem política de integrante nem regra, a pessoa decide");
    }

    // ── a varredura ──

    #[test]
    fn a_varredura_decide_pelo_pedido_guardado_e_nunca_o_sem_subject_nem_a_pergunta() {
        let conn = db();
        member_with(&conn, Policy::Full);
        // Um pedido guardado com o subject inteiro: a política libera.
        store::insert_request(&conn, &request("q1", "command")).unwrap();
        store::set_subject(&conn, "q1", &serde_json::to_string(&cmd("bun add zod")).unwrap()).unwrap();
        // O mesmo pedido, de antes desta versão (sem subject): nunca é decidido sozinho.
        store::insert_request(&conn, &request("q2", "command")).unwrap();
        // Uma pergunta é sempre da pessoa, mesmo com subject.
        store::insert_request(&conn, &request("q3", "question")).unwrap();
        store::set_subject(&conn, "q3", &serde_json::to_string(&cmd("ls")).unwrap()).unwrap();
        // De risco alto.
        store::insert_request(&conn, &request("q4", "command")).unwrap();
        store::set_subject(&conn, "q4", &serde_json::to_string(&cmd("git push")).unwrap()).unwrap();
        let rows = store::pending_all(&conn).unwrap();
        let decided: Vec<(&str, Verdict)> = rows.iter().filter_map(|r| plan_stored(&conn, r).map(|d| (r.id.as_str(), d.verdict))).collect();
        assert_eq!(decided, [("q1", Verdict::Allow)]);
    }

    #[test]
    fn so_as_conversas_ativas_entram_na_varredura() {
        let conn = db();
        member_with(&conn, Policy::Full);
        store::insert_request(&conn, &request("q1", "command")).unwrap();
        assert_eq!(store::pending_all(&conn).unwrap().len(), 1);
        store::set_state(&conn, "t1", "settled", 5).unwrap();
        assert!(store::pending_all(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_resposta_grava_quem_decidiu_e_a_da_pessoa_diz_person() {
        let conn = db();
        member_with(&conn, Policy::Ask);
        store::insert_request(&conn, &request("q1", "command")).unwrap();
        store::insert_request(&conn, &request("q2", "command")).unwrap();
        assert!(store::answer_request_by(&conn, "q1", "allow", 5, "rule:r9", Some("Liberado pela regra")).unwrap());
        assert!(store::answer_request(&conn, "q2", "deny", 6).unwrap());
        assert!(!store::answer_request_by(&conn, "q1", "deny", 7, "policy", None).unwrap(), "responder duas vezes não muda quem decidiu");
        let decisions = store::recent_decisions(&conn, "t1", 10).unwrap();
        assert_eq!(decisions[0], ("q2".into(), "deny".into(), Some("person".into()), None));
        assert_eq!(decisions[1], ("q1".into(), "allow".into(), Some("rule:r9".into()), Some("Liberado pela regra".into())));
    }

    #[test]
    fn a_migracao_das_colunas_da_decisao_roda_duas_vezes_e_guarda_o_que_havia() {
        let conn = db();
        store::migrate(&conn).unwrap();
        store::migrate(&conn).unwrap();
        member_with(&conn, Policy::Ask);
        store::insert_request(&conn, &request("q1", "command")).unwrap();
        store::migrate(&conn).unwrap();
        assert_eq!(store::pending_all(&conn).unwrap().len(), 1, "migrar de novo não apaga nada");
    }
}
