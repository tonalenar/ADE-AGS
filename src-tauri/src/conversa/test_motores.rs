//! Os motores de protocolo do OpenCode (ACP) e do Antigravity (`agy` em stream-json): o
//! mapeamento puro e o fluxo até o banco, sem processo real. As linhas são as do protocolo
//! conferido (ver `opencode_map` e `agy_map`); os campos das ferramentas do agy vêm do changelog
//! e do parser das tarefas, não de um turno real.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::canal::timeline::{Item, ItemKind, ToolKind, ToolStatus};

use super::api::{self, Engine, NewThread};
use super::codex_map::DeltaKind;
use super::store::{self, RequestRow, ThreadRow};

fn row(agent: &str, access: &str) -> ThreadRow {
    ThreadRow {
        id: "t".into(), agent_id: agent.into(), remote_id: None, cwd: "/p".into(), title: String::new(),
        model: Some("anthropic/claude-sonnet-5-5".into()), effort: Some("high".into()), access: access.into(), account_id: None, memory: None,
        state: "active".into(), created_at: 1, updated_at: 1,
    }
}

mod opencode {
    use super::*;
    use crate::conversa::opencode_map::{access_of_mode, answer_of, ask_of, config_option, launch_env, mode_of, permission_config, prompt_params, turn_result, usage_item, Mapper, Out};

    fn items(outs: Vec<Out>) -> Vec<Item> {
        outs.into_iter().filter_map(|o| if let Out::Item(i) = o { Some(*i) } else { None }).collect()
    }

    fn chunk(kind: &str, text: &str) -> Value {
        json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } })
    }

    #[test]
    fn o_acesso_vira_politica_de_permissoes_e_modo() {
        assert_eq!(permission_config("ask")["permission"]["bash"], "ask");
        assert_eq!(permission_config("edits")["permission"], json!({ "edit": "allow", "bash": "ask", "webfetch": "ask", "external_directory": "ask" }));
        assert_eq!(permission_config("safe")["permission"]["webfetch"], "allow");
        assert_eq!(permission_config("safe")["permission"]["bash"], "ask");
        assert_eq!(permission_config("full")["permission"]["bash"], "allow");
        // O Plano não libera nada além do Supervisionado.
        assert_eq!(permission_config("plan"), permission_config("ask"));
        assert_eq!((mode_of("plan"), mode_of("safe"), mode_of("ask")), ("plan", "build", "build"));
        assert_eq!((access_of_mode("plan"), access_of_mode("build")), (Some("plan"), None));
    }

    #[test]
    fn o_ambiente_do_processo_leva_a_politica_do_acesso() {
        let env = launch_env(&row("opencode", "edits"));
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, "OPENCODE_CONFIG_CONTENT");
        let config: Value = serde_json::from_str(&env[0].1).unwrap();
        assert_eq!(config["permission"]["edit"], "allow");
    }

    #[test]
    fn as_opcoes_da_sessao_trazem_o_valor_atual_e_os_aceitos() {
        // Resposta de `session/new` do OpenCode 2.2.1 (encurtada).
        let result = json!({ "sessionId": "ses_1", "configOptions": [
            { "id": "model", "currentValue": "opencode/flint-40b-free", "options": [{ "value": "opencode/flint-40b-free" }, { "value": "anthropic/claude-sonnet-5-5" }] },
            { "id": "effort", "currentValue": "default", "options": [{ "value": "low" }, { "value": "default" }] },
            { "id": "mode", "currentValue": "build", "options": [{ "value": "build" }, { "value": "plan" }] },
        ] });
        let (current, values) = config_option(&result, "model").unwrap();
        assert_eq!(current.as_deref(), Some("opencode/flint-40b-free"));
        assert!(values.contains(&"anthropic/claude-sonnet-5-5".to_string()));
        assert!(config_option(&result, "variant").is_none());
        assert_eq!(prompt_params("ses_1", "oi")["prompt"][0]["text"], "oi");
    }

    #[test]
    fn a_fala_chega_em_pedacos_e_fecha_com_o_mesmo_id() {
        let mut mapper = Mapper::new("turno1");
        let a = mapper.feed(&chunk("agent_message_chunk", "Olá, "), 1);
        let b = mapper.feed(&chunk("agent_message_chunk", "mundo"), 2);
        let (Out::Delta { item_id: first, kind, .. }, Out::Delta { item_id: second, delta, .. }) = (&a[0], &b[0]) else { panic!("{a:?} {b:?}") };
        assert_eq!((first, *kind, delta.as_str()), (second, DeltaKind::Assistant, "mundo"));
        // Uma ferramenta fecha o texto que vinha chegando.
        let closed = items(mapper.feed(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "bash", "kind": "execute", "status": "pending", "rawInput": { "command": "ls" } }), 3));
        assert_eq!(closed[0].kind, ItemKind::Assistant);
        assert_eq!((closed[0].id.as_str(), closed[0].text.as_deref()), (first.as_str(), Some("Olá, mundo")));
        assert_eq!(closed[1].tool, Some(ToolKind::Command));
        assert_eq!(closed[1].label.as_deref(), Some("ls"));
    }

    #[test]
    fn o_raciocinio_fecha_quando_a_fala_comeca() {
        let mut mapper = Mapper::new("t");
        mapper.feed(&chunk("agent_thought_chunk", "Vou ler o arquivo."), 1);
        let outs = mapper.feed(&chunk("agent_message_chunk", "Pronto."), 2);
        let closed = items(outs);
        assert_eq!((closed[0].kind, closed[0].text.as_deref()), (ItemKind::Reasoning, Some("Vou ler o arquivo.")));
        let rest = items(mapper.flush(Some(3)));
        assert_eq!((rest[0].kind, rest[0].text.as_deref()), (ItemKind::Assistant, Some("Pronto.")));
        assert_ne!(closed[0].id, rest[0].id);
    }

    #[test]
    fn dois_turnos_nao_se_sobrescrevem() {
        let mut mapper = Mapper::new("a");
        mapper.feed(&chunk("agent_message_chunk", "um"), 1);
        let one = items(mapper.flush(None));
        mapper.begin("b");
        mapper.feed(&chunk("agent_message_chunk", "dois"), 2);
        let two = items(mapper.flush(None));
        assert_ne!(one[0].id, two[0].id);
    }

    #[test]
    fn a_ferramenta_abre_rodando_e_fecha_com_a_saida() {
        let mut mapper = Mapper::new("t");
        mapper.feed(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "bash", "kind": "execute", "status": "in_progress", "rawInput": {} }), 1);
        let done = items(mapper.feed(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed",
            "rawInput": { "command": "cargo test" }, "content": [{ "type": "content", "content": { "type": "text", "text": "ok. 3 passed" } }],
        }), 2));
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].status, done[0].label.as_deref(), done[0].output.as_deref()), (Some(ToolStatus::Done), Some("cargo test"), Some("ok. 3 passed")));
        // Fechou: uma atualização atrasada não reabre.
        let late = items(mapper.feed(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }), 3));
        assert_eq!(late[0].status, Some(ToolStatus::Done));
    }

    #[test]
    fn a_edicao_traz_o_arquivo_e_o_mais_menos_do_diff() {
        let mut mapper = Mapper::new("t");
        let edit = items(mapper.feed(&json!({
            "sessionUpdate": "tool_call", "toolCallId": "e1", "title": "edit", "kind": "edit", "status": "completed",
            "locations": [{ "path": "/p/a.rs" }],
            "content": [{ "type": "diff", "path": "/p/a.rs", "oldText": "um\ndois\n", "newText": "um\ntrês\nquatro\n" }],
        }), 1));
        assert_eq!((edit[0].tool, edit[0].path.as_deref(), edit[0].added, edit[0].removed), (Some(ToolKind::Edit), Some("/p/a.rs"), Some(3), Some(2)));
        let new = items(mapper.feed(&json!({
            "sessionUpdate": "tool_call", "toolCallId": "e2", "title": "write", "kind": "edit", "status": "completed",
            "content": [{ "type": "diff", "path": "/p/b.rs", "oldText": null, "newText": "fn main() {}\n" }],
        }), 2));
        assert_eq!((new[0].tool, new[0].path.as_deref()), (Some(ToolKind::Write), Some("/p/b.rs")));
    }

    #[test]
    fn a_ferramenta_negada_aparece_negada() {
        let mut mapper = Mapper::new("t");
        mapper.feed(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c9", "title": "bash", "kind": "execute", "status": "pending", "rawInput": { "command": "rm -rf build" } }), 1);
        mapper.deny("c9");
        let out = items(mapper.feed(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c9", "status": "failed" }), 2));
        assert_eq!(out[0].status, Some(ToolStatus::Denied));
        // Uma falha que a pessoa não negou continua erro.
        mapper.feed(&json!({ "sessionUpdate": "tool_call", "toolCallId": "c10", "title": "bash", "kind": "execute", "status": "pending" }), 3);
        let failed = items(mapper.feed(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c10", "status": "failed" }), 4));
        assert_eq!(failed[0].status, Some(ToolStatus::Error));
    }

    #[test]
    fn o_plano_vira_a_lista_de_passos() {
        let mut mapper = Mapper::new("t");
        let plan = items(mapper.feed(&json!({ "sessionUpdate": "plan", "entries": [
            { "content": "Ler o código", "priority": "high", "status": "completed" },
            { "content": "Escrever o teste", "priority": "medium", "status": "in_progress" },
        ] }), 1));
        let steps = plan[0].plan.as_ref().unwrap();
        assert_eq!((plan[0].tool, steps.len(), steps[0].text.as_str()), (Some(ToolKind::Todo), 2, "Ler o código"));
        // Outra atualização do plano substitui o item (mesmo id).
        let again = items(mapper.feed(&json!({ "sessionUpdate": "plan", "entries": [{ "content": "Só um", "status": "pending" }] }), 2));
        assert_eq!(again[0].id, plan[0].id);
    }

    #[test]
    fn a_troca_de_modo_e_o_que_nao_importa() {
        let mut mapper = Mapper::new("t");
        assert_eq!(mapper.feed(&json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" }), 1), vec![Out::Mode("plan".into())]);
        for ignored in ["available_commands_update", "user_message_chunk", "usage_update", "session_info_update"] {
            assert!(mapper.feed(&json!({ "sessionUpdate": ignored }), 1).is_empty(), "{ignored}");
        }
    }

    #[test]
    fn o_pedido_de_permissao_vira_aprovacao_e_a_resposta_escolhe_a_opcao() {
        let options = json!([
            { "optionId": "once", "kind": "allow_once", "name": "Allow once" },
            { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
            { "optionId": "reject", "kind": "reject_once", "name": "Reject" },
        ]);
        let ask = ask_of(&json!({ "sessionId": "s", "toolCall": { "toolCallId": "c1", "title": "bash", "kind": "execute", "rawInput": { "command": "git push\nsegunda", "description": "Sobe" } }, "options": options })).unwrap();
        assert_eq!((ask.kind, ask.title.as_str(), ask.detail.as_str(), ask.item_id.as_deref()), ("command", "git push", "Sobe", Some("c1")));
        // `options` é um objeto: a tela não o confunde com uma pergunta nem com a saída do Plano.
        assert!(ask.options.is_object() && ask.options["acp"].as_array().unwrap().len() == 3);
        let outcome = |choice: &str| answer_of(&ask.options, choice)["outcome"].clone();
        assert_eq!(outcome("allow"), json!({ "outcome": "selected", "optionId": "once" }));
        assert_eq!(outcome("allowSession"), json!({ "outcome": "selected", "optionId": "always" }));
        assert_eq!(outcome("deny"), json!({ "outcome": "selected", "optionId": "reject" }));
        assert_eq!(outcome("cancel"), json!({ "outcome": "cancelled" }));

        let edit = ask_of(&json!({ "toolCall": { "toolCallId": "c2", "title": "edit", "kind": "edit", "locations": [{ "path": "/p/a.rs" }] }, "options": options })).unwrap();
        assert_eq!((edit.kind, edit.title.as_str()), ("fileChange", "/p/a.rs"));
        assert!(ask_of(&json!({ "toolCall": {}, "options": [] })).is_none());
    }

    #[test]
    fn sem_a_opcao_pedida_nunca_da_mais_permissao() {
        let only_once = json!({ "acp": [{ "optionId": "once", "kind": "allow_once" }] });
        // Sem "sempre", `allowSession` cai em "só desta vez"; sem recusar, negar cancela.
        assert_eq!(answer_of(&only_once, "allowSession")["outcome"]["optionId"], "once");
        assert_eq!(answer_of(&only_once, "deny")["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn o_fim_do_turno_vem_do_motivo_de_parada() {
        assert!(!turn_result(&json!({ "stopReason": "end_turn" }), Some(5)).interrupted);
        assert!(turn_result(&json!({ "stopReason": "cancelled" }), None).interrupted);
        assert!(turn_result(&json!({ "stopReason": "refusal" }), None).error.is_some());
        assert!(turn_result(&json!({ "stopReason": "max_tokens" }), None).error.is_some());
        let usage = usage_item("t", &json!({ "stopReason": "end_turn", "usage": { "inputTokens": 100, "outputTokens": 20, "thoughtTokens": 5 } }), Some(1)).unwrap();
        assert_eq!((usage.kind, usage.tokens), (ItemKind::Usage, Some(125)));
        assert!(usage_item("t", &json!({ "stopReason": "end_turn" }), None).is_none());
    }

    #[test]
    fn o_turno_inteiro_vai_ao_banco_e_a_aprovacao_expira_com_ele() {
        let conn = crate::database::test_db();
        store::insert_thread(&conn, "t", "opencode", "/p", "T", &store::Tuning { model: None, effort: None, access: "ask".into() }, None, 1).unwrap();
        let mut mapper = Mapper::new("run1");
        let mut saved = Vec::new();
        for update in [
            chunk("agent_thought_chunk", "Penso."),
            json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "bash", "kind": "execute", "status": "pending", "rawInput": { "command": "ls" } }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }),
            chunk("agent_message_chunk", "Feito."),
        ] {
            saved.extend(items(mapper.feed(&update, 1)));
        }
        saved.extend(items(mapper.flush(Some(2))));
        for item in &saved {
            store::upsert_item(&conn, "t", Some("run1"), item).unwrap();
        }
        let stored = store::items(&conn, "t").unwrap();
        // O raciocínio, a ferramenta (uma linha, atualizada no lugar) e a fala, na ordem.
        assert_eq!(stored.iter().map(|i| i.kind).collect::<Vec<_>>(), [ItemKind::Reasoning, ItemKind::Tool, ItemKind::Assistant]);
        assert_eq!(stored[1].status, Some(ToolStatus::Done));
        let ask = ask_of(&json!({ "toolCall": { "toolCallId": "c2", "title": "bash", "kind": "execute" }, "options": [{ "optionId": "o", "kind": "allow_once" }] })).unwrap();
        let request = RequestRow {
            id: "q".into(), thread_id: "t".into(), rpc_id: "3".into(), kind: ask.kind.into(), item_id: ask.item_id, title: ask.title,
            detail: ask.detail, options: ask.options, state: "pending".into(), created_at: 1,
        };
        store::insert_request(&conn, &request).unwrap();
        assert_eq!(store::request(&conn, "q").unwrap().unwrap().options["acp"][0]["optionId"], "o");
        assert_eq!(store::expire_requests(&conn, "t").unwrap(), ["q"]);
    }

    /// Uso real: abre um `opencode acp`, manda um prompt de verdade e confere o turno. Gasta cota do
    /// modelo escolhido; só roda com `CC_E2E_OPENCODE_MODEL=<provedor/modelo>`.
    #[test]
    #[ignore = "gasta cota do modelo: rode a mão com CC_E2E_OPENCODE_MODEL=provedor/modelo"]
    fn e2e_opencode_acp_um_turno_real() {
        let Ok(model) = std::env::var("CC_E2E_OPENCODE_MODEL") else { return };
        let program = crate::util::find_program("opencode").expect("opencode no PATH");
        let mut child = crate::util::external_command(&program, &["acp"]).unwrap()
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().expect("opencode abriu");
        use std::io::{BufRead, Write};
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let mut send = |value: Value| writeln!(stdin, "{value}").unwrap();
        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": crate::conversa::opencode_map::initialize_params() }));
        send(json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": crate::conversa::opencode_map::new_session_params(&cwd) }));
        let mut session = String::new();
        while session.is_empty() {
            let msg: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            if msg["id"] == 2 {
                session = msg["result"]["sessionId"].as_str().unwrap().to_string();
            }
        }
        send(json!({ "jsonrpc": "2.0", "id": 3, "method": "session/set_config_option", "params": crate::conversa::opencode_map::set_option_params(&session, "model", &model) }));
        send(json!({ "jsonrpc": "2.0", "id": 4, "method": "session/prompt", "params": prompt_params(&session, "Responda apenas: OK") }));
        let mut mapper = Mapper::new("e2e");
        let mut said = String::new();
        loop {
            let msg: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            if msg["method"] == "session/update" {
                for item in items(mapper.feed(&msg["params"]["update"], 0)) {
                    if item.kind == ItemKind::Assistant { said.push_str(item.text.as_deref().unwrap_or("")); }
                }
            } else if msg["id"] == 4 {
                for item in items(mapper.flush(None)) { said.push_str(item.text.as_deref().unwrap_or("")); }
                assert!(!turn_result(&msg["result"], None).interrupted);
                break;
            }
        }
        let _ = child.kill();
        assert!(said.contains("OK"), "resposta: {said}");
    }
}

mod agy {
    use super::*;
    use crate::conversa::agy_map::{access_flags, error_from_stderr, launch_args, tool_item, Mapper, Out};
    use crate::conversa::claude_map::TurnResult;

    fn items(outs: &[Out]) -> Vec<&Item> {
        outs.iter().filter_map(|o| if let Out::Item(i) = o { Some(&**i) } else { None }).collect()
    }

    fn step(index: i64, state: &str, step_type: &str, extra: Value) -> Value {
        let mut s = json!({ "step_index": index, "state": state, "step_type": step_type });
        s.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        json!({ "event": "step_update", "step_update": s })
    }

    #[test]
    fn o_acesso_vira_flags_do_agy() {
        assert!(access_flags("ask").is_empty());
        assert_eq!(access_flags("edits"), ["--mode", "accept-edits"]);
        assert_eq!(access_flags("safe"), ["--mode", "auto"]);
        assert_eq!(access_flags("plan"), ["--mode", "plan"]);
        assert_eq!(access_flags("full"), ["--dangerously-skip-permissions"]);
    }

    #[test]
    fn os_argumentos_levam_a_mensagem_o_modelo_e_a_conversa() {
        let fresh = launch_args(&row("antigravity", "edits"), "olá", None);
        assert_eq!(&fresh[..2], ["--print", "olá"]);
        let joined = fresh.join(" ");
        for flag in ["--output-format stream-json", "--disable-slash-commands", "--mode accept-edits", "--model anthropic/claude-sonnet-5-5", "--effort high"] {
            assert!(joined.contains(flag), "{flag} em {joined}");
        }
        assert!(!joined.contains("--conversation"));
        let resumed = launch_args(&ThreadRow { model: None, effort: None, ..row("antigravity", "ask") }, "e agora?", Some("cv-1")).join(" ");
        assert!(resumed.contains("--conversation cv-1") && !resumed.contains("--model") && !resumed.contains("--mode"), "{resumed}");
        // Uma mensagem que começa com "-" é o valor de --print, não uma flag.
        assert_eq!(&launch_args(&row("antigravity", "ask"), "--help", None)[..2], ["--print", "--help"]);
    }

    #[test]
    fn um_turno_com_fala_em_pedacos_ferramenta_e_resultado() {
        let mut mapper = Mapper::new("run1");
        let mut all: Vec<Out> = Vec::new();
        for line in [
            json!({ "event": "init", "conversation_id": "cv-9", "init": { "tools": [] } }),
            step(1, "ACTIVE", "agent_response", json!({ "conversation_id": "cv-9", "text_delta": "Vou " })),
            step(1, "DONE", "agent_response", json!({ "text_delta": "listar." })),
            step(2, "ACTIVE", "run_command", json!({ "tool_info": { "name": "run_command", "parameters": { "CommandLine": "ls -la" } } })),
            step(2, "DONE", "run_command", json!({ "tool_info": { "name": "run_command", "parameters": { "CommandLine": "ls -la" }, "output": "a.txt\nb.txt" } })),
            step(3, "DONE", "agent_response", json!({ "text_delta": "Há dois arquivos." })),
            json!({ "event": "result", "result": { "conversation_id": "cv-9", "status": "SUCCESS", "response": "Há dois arquivos.", "duration_seconds": 2.5,
                "usage": { "input_tokens": 100, "output_tokens": 20, "thinking_tokens": 10, "cache_read_tokens": 50, "total_tokens": 130 } } }),
        ] {
            all.extend(mapper.feed(&line, 1));
        }
        let sessions: Vec<_> = all.iter().filter_map(|o| if let Out::Session(s) = o { Some(s.as_str()) } else { None }).collect();
        assert_eq!(sessions, ["cv-9"], "o id da conversa sai uma vez só");
        let deltas: Vec<_> = all.iter().filter_map(|o| if let Out::Delta { delta, item_id, .. } = o { Some((item_id.as_str(), delta.as_str())) } else { None }).collect();
        assert_eq!(deltas[..2], [("agy:run1:1", "Vou "), ("agy:run1:1", "listar.")]);
        let made = items(&all);
        let speech: Vec<_> = made.iter().filter(|i| i.kind == ItemKind::Assistant).map(|i| (i.id.as_str(), i.text.as_deref().unwrap())).collect();
        assert_eq!(speech, [("agy:run1:1", "Vou listar."), ("agy:run1:3", "Há dois arquivos.")]);
        let tools: Vec<_> = made.iter().filter(|i| i.kind == ItemKind::Tool).collect();
        assert_eq!(tools.len(), 2, "rodando e depois pronta, no mesmo id");
        assert_eq!((tools[0].status, tools[1].status, tools[1].tool, tools[1].label.as_deref(), tools[1].output.as_deref()),
            (Some(ToolStatus::Running), Some(ToolStatus::Done), Some(ToolKind::Command), Some("ls -la"), Some("a.txt\nb.txt")));
        assert_eq!(tools[0].id, tools[1].id);
        assert_eq!(made.iter().find(|i| i.kind == ItemKind::Usage).and_then(|i| i.tokens), Some(130));
        // A resposta final repete a última fala: não vira uma fala a mais.
        assert_eq!(speech.len(), 2);
        let Some(Out::Done(done)) = all.last() else { panic!("sem fim") };
        assert_eq!((done.interrupted, done.error.as_deref(), done.duration_ms), (false, None, Some(2500)));
    }

    #[test]
    fn sem_pedacos_a_resposta_final_e_a_fala() {
        let mut mapper = Mapper::new("r");
        let outs = mapper.feed(&json!({ "event": "result", "result": { "status": "SUCCESS", "response": "Tudo certo." } }), 1);
        let said: Vec<_> = items(&outs).iter().filter(|i| i.kind == ItemKind::Assistant).map(|i| i.text.clone().unwrap()).collect();
        assert_eq!(said, ["Tudo certo."]);
    }

    #[test]
    fn a_fala_que_nao_fechou_fecha_no_resultado() {
        let mut mapper = Mapper::new("r");
        mapper.feed(&step(1, "ACTIVE", "agent_response", json!({ "text_delta": "meio" })), 1);
        let outs = mapper.feed(&json!({ "event": "result", "result": { "status": "SUCCESS", "response": "meio" } }), 2);
        let speech: Vec<_> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(speech.len(), 1);
        assert_eq!(speech[0].text.as_deref(), Some("meio"));
    }

    #[test]
    fn falha_e_interrupcao_acabam_diferente() {
        let done = |result: Value| -> TurnResult {
            let outs = Mapper::new("r").feed(&json!({ "event": "result", "result": result }), 1);
            match outs.into_iter().last() { Some(Out::Done(d)) => d, other => panic!("{other:?}") }
        };
        let failed = done(json!({ "status": "ERROR", "error": "cota esgotada" }));
        assert_eq!((failed.interrupted, failed.error.as_deref()), (false, Some("cota esgotada")));
        assert!(done(json!({ "status": "ERROR" })).error.unwrap().contains("ERROR"));
        let stopped = done(json!({ "status": "ERROR", "finished_reason": "interrupted" }));
        assert_eq!((stopped.interrupted, stopped.error), (true, None));
        assert!(done(json!({ "status": "SUCCESS", "finished_reason": "print_timeout" })).error.is_some());
        assert_eq!(done(json!({ "status": "SUCCESS" })).error, None);
    }

    #[test]
    fn o_que_precisava_de_aprovacao_aparece_negado() {
        let outs = Mapper::new("r").feed(&json!({ "event": "result", "result": { "status": "SUCCESS", "denied_actions": [
            "git push origin main", { "command": "rm -rf build", "reason": "fora do sandbox" },
        ] } }), 1);
        let denied: Vec<_> = items(&outs).into_iter().filter(|i| i.status == Some(ToolStatus::Denied)).collect();
        assert_eq!(denied.iter().map(|i| i.label.as_deref().unwrap()).collect::<Vec<_>>(), ["git push origin main", "rm -rf build"]);
        assert_ne!(denied[0].id, denied[1].id);
    }

    #[test]
    fn passos_que_nao_sao_ferramenta_nem_fala_ficam_de_fora() {
        let mut mapper = Mapper::new("r");
        for kind in ["user_input", "conversation_history", "checkpoint", "ephemeral_message"] {
            assert!(mapper.feed(&step(1, "DONE", kind, json!({ "text_delta": "x" })), 1).is_empty(), "{kind}");
        }
        assert!(mapper.feed(&json!({ "event": "command_result", "command": { "name": "usage" } }), 1).is_empty());
        let thought = mapper.feed(&step(4, "DONE", "agent_thought", json!({ "text_delta": "pensando" })), 1);
        let reasoning = items(&thought);
        assert_eq!((reasoning[0].kind, reasoning[0].text.as_deref()), (ItemKind::Reasoning, Some("pensando")));
    }

    #[test]
    fn as_ferramentas_conhecidas_viram_o_que_a_tela_desenha() {
        let read = tool_item("a", "view_file", &json!({ "AbsolutePath": "/p/a.rs" }), None);
        assert_eq!((read.tool, read.path.as_deref()), (Some(ToolKind::Read), Some("/p/a.rs")));
        let write = tool_item("b", "write_to_file", &json!({ "TargetFile": "/p/b.rs", "CodeContent": "a\nb\n" }), None);
        assert_eq!((write.tool, write.path.as_deref(), write.added), (Some(ToolKind::Write), Some("/p/b.rs"), Some(2)));
        let edit = tool_item("c", "replace_file_content", &json!({ "TargetFile": "/p/c.rs", "TargetContent": "x", "ReplacementContent": "y\nz" }), None);
        assert_eq!((edit.tool, edit.added, edit.removed), (Some(ToolKind::Edit), Some(2), Some(1)));
        let grep = tool_item("d", "grep_search", &json!({ "Query": "TODO", "SearchPath": "/p" }), None);
        assert_eq!((grep.tool, grep.label.as_deref()), (Some(ToolKind::Search), Some("TODO")));
        let web = tool_item("e", "read_url_content", &json!({ "Url": "https://exemplo.com" }), None);
        assert_eq!((web.tool, web.label.as_deref()), (Some(ToolKind::Web), Some("https://exemplo.com")));
        let mcp = tool_item("f", "call_mcp_tool", &json!({ "ServerName": "ags", "ToolName": "task_status" }), None);
        assert_eq!((mcp.tool, mcp.label.as_deref()), (Some(ToolKind::Other), Some("ags: task_status")));
        // O que não conheço aparece com o próprio nome.
        let other = tool_item("g", "xyzzy", &Value::Null, None);
        assert_eq!((other.tool, other.label.as_deref()), (Some(ToolKind::Other), Some("xyzzy")));
    }

    #[test]
    fn o_erro_sem_resultado_vem_do_stderr() {
        let tail = vec!["aviso qualquer".to_string(), "AGY_ERROR: {\"status\":\"RESOURCE_EXHAUSTED\",\"message\":\"Cota esgotada\",\"retryable\":false}".to_string()];
        assert_eq!(error_from_stderr(&tail), "Cota esgotada");
        assert_eq!(error_from_stderr(&["error: sem login".to_string(), String::new()]), "error: sem login");
        assert!(error_from_stderr(&[]).contains("sem responder"));
    }

    #[test]
    fn o_turno_vai_ao_banco_na_ordem() {
        let conn = crate::database::test_db();
        store::insert_thread(&conn, "t", "antigravity", "/p", "T", &store::Tuning { model: None, effort: None, access: "ask".into() }, None, 1).unwrap();
        let mut mapper = Mapper::new("run1");
        let mut lines = vec![
            step(1, "DONE", "agent_response", json!({ "text_delta": "Oi" })),
            step(2, "ACTIVE", "run_command", json!({ "parameters": { "command": "ls" } })),
            step(2, "DONE", "run_command", json!({ "parameters": { "command": "ls" } })),
        ];
        lines.push(json!({ "event": "result", "result": { "status": "SUCCESS", "response": "Oi" } }));
        for line in lines {
            for out in mapper.feed(&line, 1) {
                if let Out::Item(item) = out {
                    store::upsert_item(&conn, "t", Some("run1"), &item).unwrap();
                }
            }
        }
        let stored = store::items(&conn, "t").unwrap();
        assert_eq!(stored.iter().map(|i| i.kind).collect::<Vec<_>>(), [ItemKind::Assistant, ItemKind::Tool]);
        assert_eq!(stored[1].status, Some(ToolStatus::Done));
    }

    /// Uso real: um turno de verdade com `agy`, que confere os campos que o changelog só descreve
    /// (`tool_info`, `step_type`). Gasta cota; só roda com `CC_E2E_AGY=1`.
    #[test]
    #[ignore = "gasta cota do modelo: rode a mão com CC_E2E_AGY=1"]
    fn e2e_agy_um_turno_real() {
        if std::env::var("CC_E2E_AGY").is_err() {
            return;
        }
        let args = launch_args(&row("antigravity", "ask"), "Responda apenas: OK", None);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let program = crate::util::find_program("agy").expect("agy no PATH");
        let out = crate::util::external_command(&program, &args).unwrap().current_dir(std::env::temp_dir()).output().expect("agy rodou");
        let mut mapper = Mapper::new("e2e");
        let mut said = String::new();
        let mut done = false;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
            for o in mapper.feed(&value, 0) {
                match o {
                    Out::Item(i) if i.kind == ItemKind::Assistant => said.push_str(i.text.as_deref().unwrap_or("")),
                    Out::Done(d) => { assert!(d.error.is_none(), "{d:?}"); done = true; }
                    _ => {}
                }
            }
        }
        assert!(done && said.contains("OK"), "resposta: {said}");
    }
}

#[test]
fn o_roteamento_aceita_os_quatro_agentes() {
    assert_eq!(Engine::of("opencode"), Some(Engine::OpenCode));
    assert_eq!(Engine::of("antigravity"), Some(Engine::Antigravity));
    assert!(["codex", "claude-code", "opencode", "antigravity"].iter().all(|a| api::structured_agent(a)));
    assert!(!api::structured_agent("gemini-cli") && !api::structured_agent("kimi-code"));
    // O Plano é de todos menos do Codex; os quatro acessos do chat são de todos.
    assert!(Engine::OpenCode.accepts("plan") && Engine::Antigravity.accepts("plan") && !Engine::Codex.accepts("plan"));
    assert!(["ask", "edits", "safe", "full"].iter().all(|a| Engine::OpenCode.accepts(a) && Engine::Antigravity.accepts(a)));
    assert!(!Engine::OpenCode.accepts("lixo") && !Engine::Antigravity.accepts("lixo"));
}

#[test]
fn criar_e_trocar_com_os_agentes_novos() {
    let db = Arc::new(Mutex::new(crate::database::test_db()));
    let input = |agent: &str, access: &str| NewThread {
        agent_id: agent.into(), cwd: "/p".into(), title: "T".into(), model: Some("m".into()), effort: None, access: access.into(), account_id: None,
    };
    let opencode = api::create(&db, input("opencode", "plan")).unwrap();
    assert_eq!((opencode.agent_id.as_str(), opencode.access.as_str()), ("opencode", "plan"));
    let agy = api::create(&db, input("antigravity", "safe")).unwrap();
    assert!(api::create(&db, input("antigravity", "lixo")).is_err());
    // Sem processo aberto, trocar só grava, e o status diz que não há agente vivo nem trabalhando.
    let row = api::retune(&db, &agy.id, Some("gemini-4-argon-high".into()), Some("high".into()), "full".into()).unwrap();
    assert_eq!((row.model.as_deref(), row.effort.as_deref(), row.access.as_str()), (Some("gemini-4-argon-high"), Some("high"), "full"));
    assert_eq!(api::status(&agy.id), api::ThreadStatus { alive: false, working: false });
    assert_eq!(api::status(&opencode.id), api::ThreadStatus { alive: false, working: false });
}
