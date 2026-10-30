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
