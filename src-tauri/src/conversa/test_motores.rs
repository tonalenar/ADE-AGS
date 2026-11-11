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
        parent_ref: None, parent_turn_id: None, is_side_chat: false, fork_mode: None, fork_reason: None,
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

    /// «Trabalhou por 20h 21m» numa resposta de segundos: o `agy` informa `duration_seconds` da CONVERSA dele (que a
    /// troca de agente retoma no dia seguinte), não do turno. Vale o relógio do app; o do agy só se couber nele.
    #[test]
    fn a_duracao_do_turno_nunca_passa_do_relogio_do_app() {
        use crate::conversa::agy::pick_duration;
        let (twenty_hours, eight_s) = (73_260_000, 8_000);
        assert_eq!(pick_duration(Some(twenty_hours), eight_s), eight_s, "a duração da conversa inteira não é a do turno");
        assert_eq!(pick_duration(Some(7_200), eight_s), 7_200, "uma duração que cabe no turno é a do agente (só o modelo)");
        assert_eq!(pick_duration(Some(eight_s + 3_000), eight_s), eight_s + 3_000, "com folga de relógio");
        assert_eq!(pick_duration(None, eight_s), eight_s);
        assert_eq!(pick_duration(Some(-5), eight_s), eight_s);
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
    fn a_conversa_recusada_do_agy_so_vale_para_a_frase_de_conversa_inexistente() {
        use crate::conversa::agy_map::session_refused;
        let linhas = |ls: &[&str]| ls.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        for l in [
            "Error: conversation not found: abc",
            "no such conversation: abc",
            "Session not found",
            "AGY_ERROR: {\"status\":\"NOT_FOUND\",\"message\":\"conversation abc not found\",\"retryable\":false}",
            "AGY_ERROR: {\"status\":\"NOT_FOUND\",\"message\":\"Conversation does not exist\"}",
        ] {
            assert!(session_refused(&linhas(&["aviso qualquer", l])), "{l}");
        }
        for l in [
            "Error: file not found: src/main.rs",
            "ENOENT: no such file or directory, open 'a.txt'",
            "AGY_ERROR: {\"status\":\"NOT_FOUND\",\"message\":\"file x not found\"}",
            "AGY_ERROR: {\"status\":\"RESOURCE_EXHAUSTED\",\"message\":\"Cota esgotada\",\"retryable\":false}",
            "AGY_ERROR: {\"status\":\"UNAUTHENTICATED\",\"message\":\"conversation requires login\"}",
            "model not found: gemini",
        ] {
            assert!(!session_refused(&linhas(&[l])), "{l}");
        }
        assert!(!session_refused(&[]));
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
        agent_id: agent.into(), cwd: "/p".into(), workspace_id: None, title: "T".into(), model: Some("m".into()), effort: None, access: access.into(), account_id: None, parent_ref: None,
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

/// O Cursor (`cursor-agent -p --output-format stream-json`): o mapeamento puro, com as linhas do exemplo da documentação
/// oficial (`cursor.com/docs/cli/reference/output-format`). Nenhum turno real foi feito (gastaria a cota da pessoa): os
/// nomes das ferramentas que a doc não mostra são tratados de forma tolerante, e isso fica dito em `cursor_map`.
mod cursor {
    use super::*;
    use crate::conversa::cursor_map::{access_flags, error_from_stderr, launch_args, read_turn, Mapper, Out, Read, Source, QUIET_AFTER_FINAL, QUIET_AFTER_SPEECH, QUIET_MAX};

    fn items(outs: &[Out]) -> Vec<&Item> {
        outs.iter().filter_map(|o| if let Out::Item(i) = o { Some(&**i) } else { None }).collect()
    }
    fn deltas(outs: &[Out]) -> String {
        outs.iter().filter_map(|o| if let Out::Delta { delta, kind: DeltaKind::Assistant, .. } = o { Some(delta.as_str()) } else { None }).collect()
    }
    fn feed_all(mapper: &mut Mapper, lines: &[Value]) -> Vec<Out> {
        lines.iter().flat_map(|l| mapper.feed(l, 100)).collect()
    }

    const SID: &str = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
    fn init() -> Value { json!({ "type": "system", "subtype": "init", "apiKeySource": "login", "cwd": "/p", "session_id": SID, "model": "Claude 4 Sonnet", "permissionMode": "default" }) }
    fn delta(text: &str, ts: i64) -> Value { json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }, "session_id": SID, "timestamp_ms": ts }) }
    fn result_ok(text: &str) -> Value { json!({ "type": "result", "subtype": "success", "duration_ms": 5234, "duration_api_ms": 5234, "is_error": false, "result": text, "session_id": SID, "request_id": "r" }) }
    fn read_started() -> Value { json!({ "type": "tool_call", "subtype": "started", "call_id": "toolu_1", "tool_call": { "readToolCall": { "args": { "path": "README.md" } } }, "session_id": SID }) }
    fn read_done() -> Value {
        json!({ "type": "tool_call", "subtype": "completed", "call_id": "toolu_1", "session_id": SID, "tool_call": { "readToolCall": {
            "args": { "path": "README.md" }, "result": { "success": { "content": "# Project", "isEmpty": false, "exceededLimit": false, "totalLines": 54, "totalChars": 1254 } } } } })
    }

    #[test]
    fn o_acesso_vira_flags_e_so_ask_plan_e_full_sao_aceitos() {
        assert!(access_flags("ask").is_empty());
        assert_eq!(access_flags("plan"), ["--mode", "plan"]);
        assert_eq!(access_flags("full"), ["--force"]);
        // Aceitar edições e Auto não têm flag documentada: o motor não os aceita (nada de prometer o que não foi provado).
        assert!(!Engine::Cursor.accepts("edits") && !Engine::Cursor.accepts("safe"));
        assert!(Engine::Cursor.accepts("ask") && Engine::Cursor.accepts("plan") && Engine::Cursor.accepts("full"));
        assert_eq!(Engine::of("cursor"), Some(Engine::Cursor));
    }

    #[test]
    fn os_argumentos_do_turno_levam_pasta_modelo_conversa_e_a_mensagem_por_ultimo() {
        let fresh = launch_args(&row("cursor", "plan"), "olá", None);
        assert_eq!(fresh[..5], ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"]);
        assert!(fresh.windows(2).any(|w| w == ["--workspace", "/p"]), "{fresh:?}");
        assert!(fresh.windows(2).any(|w| w == ["--mode", "plan"]));
        assert!(fresh.windows(2).any(|w| w == ["--model", "anthropic/claude-sonnet-5-5"]), "o modelo é o id da variante (o esforço vai nele)");
        assert!(!fresh.iter().any(|a| a == "--resume" || a == "--effort"), "{fresh:?}");
        assert_eq!(fresh.last().unwrap(), "olá");
        let resumed = launch_args(&row("cursor", "full"), "mais", Some(SID));
        assert!(resumed.windows(2).any(|w| w == ["--resume", SID]));
        assert!(resumed.iter().any(|a| a == "--force"));
        // Uma mensagem que começa por «-» não vira flag do CLI.
        assert_eq!(launch_args(&row("cursor", "ask"), "-x marca", None).last().unwrap(), " -x marca");
    }

    #[test]
    fn o_init_guarda_a_conversa_uma_vez() {
        let mut mapper = Mapper::new("t1");
        let outs = feed_all(&mut mapper, &[init(), json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "oi" }] }, "session_id": SID }), delta("a", 1)]);
        assert_eq!(outs.iter().filter(|o| matches!(o, Out::Session(id) if id == SID)).count(), 1, "{outs:?}");
        assert!(mapper.feed(&result_ok("a"), 1).iter().all(|o| !matches!(o, Out::Session(_))), "não repete");
    }

    #[test]
    fn a_fala_vem_em_pedacos_sem_duplicar_o_texto_que_o_cursor_repete() {
        let mut mapper = Mapper::new("t1");
        let flush = json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Olá, mundo" }] }, "session_id": SID, "timestamp_ms": 9, "model_call_id": "mc1" });
        let final_msg = json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Olá, mundo" }] }, "session_id": SID });
        let outs = feed_all(&mut mapper, &[init(), delta("Olá, ", 1), delta("mundo", 2), flush, final_msg, result_ok("Olá, mundo")]);
        assert_eq!(deltas(&outs), "Olá, mundo", "só os pedaços (com carimbo e sem model_call_id) são fala");
        let said: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.len(), 1, "{said:?}");
        assert_eq!(said[0].text.as_deref(), Some("Olá, mundo"));
    }

    #[test]
    fn a_ferramenta_comeca_rodando_acaba_pronta_e_fecha_a_fala_antes_dela() {
        let mut mapper = Mapper::new("t1");
        let outs = feed_all(&mut mapper, &[init(), delta("Vou ler.", 1), read_started(), read_done(), delta("Pronto.", 2), result_ok("Pronto.")]);
        let all = items(&outs);
        let order: Vec<(ItemKind, Option<ToolStatus>)> = all.iter().map(|i| (i.kind, i.status)).collect();
        assert_eq!(order, [
            (ItemKind::Assistant, None),
            (ItemKind::Tool, Some(ToolStatus::Running)),
            (ItemKind::Tool, Some(ToolStatus::Done)),
            (ItemKind::Assistant, None),
        ], "{all:?}");
        assert_eq!(all[0].text.as_deref(), Some("Vou ler."));
        assert_eq!(all[1].id, all[2].id, "o mesmo item, atualizado");
        assert_eq!(all[2].tool, Some(ToolKind::Read));
        assert_eq!(all[2].path.as_deref(), Some("README.md"));
        assert_eq!(all[3].text.as_deref(), Some("Pronto."));
    }

    #[test]
    fn comando_edicao_e_busca_viram_as_ferramentas_da_timeline_e_nome_desconhecido_fica_generico() {
        let call = |id: &str, key: &str, args: Value| json!({ "type": "tool_call", "subtype": "started", "call_id": id, "tool_call": { key: { "args": args } }, "session_id": SID });
        let mut mapper = Mapper::new("t1");
        let outs = feed_all(&mut mapper, &[
            call("a", "shellToolCall", json!({ "command": "ls -la" })),
            call("b", "writeToolCall", json!({ "path": "summary.txt", "fileText": "linha 1\nlinha 2" })),
            call("c", "grepToolCall", json!({ "pattern": "TODO", "path": "src" })),
            call("d", "mcpToolCall", json!({ "name": "fetch", "toolName": "fetch" })),
            call("e", "cursorMagicToolCall", json!({ "x": 1 })),
        ]);
        let kinds: Vec<Option<ToolKind>> = items(&outs).iter().map(|i| i.tool).collect();
        assert_eq!(&kinds[..3], [Some(ToolKind::Command), Some(ToolKind::Write), Some(ToolKind::Search)], "{kinds:?}");
        assert_eq!(kinds.len(), 5, "uma ferramenta que não conheço não some");
    }

    #[test]
    fn campo_solto_ao_lado_da_ferramenta_nao_vira_o_nome_dela() {
        // Visto num turno real: `completedAtMs` (um número) vem antes de `shellToolCall` na ordem das chaves.
        let line = json!({ "type": "tool_call", "subtype": "completed", "call_id": "c1", "session_id": SID, "tool_call": {
            "completedAtMs": 1793708684633u64,
            "shellToolCall": { "args": { "command": "ls" }, "result": { "success": { "stdout": "a.txt" } } } } });
        let mut mapper = Mapper::new("t");
        let outs = feed_all(&mut mapper, &[line]);
        let got = items(&outs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name.as_deref(), Some("Bash"), "{:?}", got[0]);
        assert!(got[0].output.as_deref().unwrap_or("").contains("a.txt"), "{:?}", got[0]);
        // Sem `…ToolCall`, a primeira entrada que é objeto ainda vira a ferramenta.
        let odd = json!({ "type": "tool_call", "subtype": "started", "call_id": "c2", "session_id": SID, "tool_call": { "startedAtMs": 1, "fooBarCall": { "args": {} } } });
        let outs = feed_all(&mut Mapper::new("t"), &[odd]);
        assert_eq!(items(&outs)[0].name.as_deref(), Some("foobarcall"));
    }

    #[test]
    fn ferramenta_com_erro_ou_recusada_fica_marcada_e_a_recusa_diz_como_liberar() {
        let done = |result: Value| json!({ "type": "tool_call", "subtype": "completed", "call_id": "x", "tool_call": { "shellToolCall": { "args": { "command": "rm -rf dist" }, "result": result } }, "session_id": SID });
        let status = |result: Value| {
            let mut mapper = Mapper::new("t");
            let outs = feed_all(&mut mapper, &[done(result)]);
            let item = items(&outs).last().map(|i| (*i).clone()).unwrap();
            (item.status.unwrap(), item.output)
        };
        assert_eq!(status(json!({ "success": { "stdout": "ok", "exitCode": 0 } })), (ToolStatus::Done, Some("ok".into())));
        assert_eq!(status(json!({ "success": { "stdout": "", "stderr": "falhou", "exitCode": 2 } })).0, ToolStatus::Error);
        assert_eq!(status(json!({ "error": { "message": "sem permissão" } })), (ToolStatus::Error, Some("sem permissão".into())));
        let (st, output) = status(json!({ "rejected": { "reason": "needs approval" } }));
        assert_eq!(st, ToolStatus::Denied);
        assert!(output.unwrap().contains("Troque o acesso"), "diz como liberar");
    }

    #[test]
    fn o_raciocinio_vira_item_so_quando_fecha() {
        let mut mapper = Mapper::new("t1");
        let think = |sub: &str, text: &str| json!({ "type": "thinking", "subtype": sub, "text": text, "session_id": SID, "timestamp_ms": 1 });
        let outs = feed_all(&mut mapper, &[think("delta", "pensando "), think("delta", "mais"), think("completed", ""), result_ok("")]);
        assert!(outs.iter().any(|o| matches!(o, Out::Delta { kind: DeltaKind::Reasoning, .. })));
        let reasoning: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Reasoning).collect();
        assert_eq!(reasoning.len(), 1);
        assert_eq!(reasoning[0].text.as_deref(), Some("pensando mais"));
    }

    #[test]
    fn sem_pedacos_a_resposta_final_do_result_e_a_fala() {
        let mut mapper = Mapper::new("t1");
        let outs = feed_all(&mut mapper, &[init(), result_ok("Resposta inteira")]);
        let said: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].text.as_deref(), Some("Resposta inteira"));
        let Some(Out::Done(done)) = outs.last() else { panic!("{outs:?}") };
        assert!(done.error.is_none() && !done.interrupted);
        assert_eq!(done.duration_ms, Some(5234));
    }

    #[test]
    fn o_result_com_erro_encerra_o_turno_com_a_mensagem() {
        let mut mapper = Mapper::new("t1");
        let err = json!({ "type": "result", "subtype": "error", "is_error": true, "result": "Usage limit reached", "duration_ms": 10, "session_id": SID });
        let outs = feed_all(&mut mapper, &[init(), delta("meio", 1), err]);
        let Some(Out::Done(done)) = outs.last() else { panic!("{outs:?}") };
        assert_eq!(done.error.as_deref(), Some("Usage limit reached"));
        let said: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.len(), 1, "a fala parcial não se perde");
    }

    #[test]
    fn o_fluxo_que_acaba_sem_result_fecha_a_fala_aberta() {
        let mut mapper = Mapper::new("t1");
        let _ = feed_all(&mut mapper, &[init(), delta("quase", 1)]);
        let rest = mapper.finish(Some(100));
        let said: Vec<&Item> = items(&rest).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].text.as_deref(), Some("quase"));
        assert!(mapper.finish(Some(101)).is_empty(), "não fecha duas vezes");
    }

    /// A fonte de linhas dos testes: entrega a lista e depois, se `closed`, o EOF. Sem EOF, uma espera com prazo
    /// vence (`Quiet`); uma espera sem prazo é a conversa presa para sempre, e o teste falha.
    struct Fake {
        lines: std::collections::VecDeque<String>,
        closed: bool,
        waits: Vec<Option<std::time::Duration>>,
    }
    impl Fake {
        fn open(lines: &[Value]) -> Fake {
            Fake { lines: lines.iter().map(|l| l.to_string()).collect(), closed: false, waits: Vec::new() }
        }
    }
    impl Source for Fake {
        async fn next(&mut self, quiet: Option<std::time::Duration>) -> Read {
            if let Some(line) = self.lines.pop_front() {
                return Read::Line(line);
            }
            self.waits.push(quiet);
            if self.closed {
                return Read::Eof;
            }
            assert!(quiet.is_some(), "o turno ficaria em «Pensando…» para sempre: espera sem prazo, sem result e sem EOF");
            Read::Quiet
        }
    }
    fn run(mapper: &mut Mapper, fake: &mut Fake) -> (Option<crate::conversa::claude_map::TurnResult>, Vec<Out>) {
        let mut outs = Vec::new();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let done = rt.block_on(read_turn(mapper, fake, |o| outs.extend(o), || 100));
        (done, outs)
    }
    fn shell(sub: &str) -> Value {
        json!({ "type": "tool_call", "subtype": sub, "call_id": "sh1", "session_id": SID,
            "tool_call": { "shellToolCall": { "args": { "command": "npx expo start --port 8081" }, "result": { "success": { "stdout": "", "exitCode": 0 } } } } })
    }

    #[test]
    fn o_result_fecha_o_turno_mesmo_com_o_processo_vivo_segurando_o_stdout() {
        // Visto no app: um servidor em segundo plano mantém o `cursor-agent` vivo, e o EOF não chega.
        let mut mapper = Mapper::new("t1");
        let mut fake = Fake::open(&[init(), delta("Pronto.", 1), result_ok("Pronto.")]);
        let (done, outs) = run(&mut mapper, &mut fake);
        let done = done.expect("o result encerra o turno");
        assert!(done.error.is_none() && !done.interrupted);
        assert_eq!(items(&outs).iter().filter(|i| i.kind == ItemKind::Assistant).count(), 1);
        assert!(fake.waits.is_empty(), "não espera mais nada depois do result: {:?}", fake.waits);
    }

    #[test]
    fn fala_final_sem_result_e_sem_eof_fecha_o_turno_pelo_silencio() {
        // A conversa presa 9 h em «Pensando…»: o agente subiu o Metro, falou a resposta final e o `cursor-agent`
        // nunca mandou o `result` nem saiu.
        let mut mapper = Mapper::new("t1");
        let mut fake = Fake::open(&[init(), shell("started"), shell("completed"), delta("Quer que eu registre o resultado?", 1)]);
        let (done, outs) = run(&mut mapper, &mut fake);
        let done = done.expect("o silêncio depois da fala encerra o turno");
        assert!(done.error.is_none() && !done.interrupted, "a resposta veio: o turno acabou bem ({done:?})");
        let said: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.len(), 1, "a fala final é gravada, não fica só na janela");
        assert_eq!(said[0].text.as_deref(), Some("Quer que eu registre o resultado?"));
        assert_eq!(fake.waits, [Some(QUIET_AFTER_SPEECH)]);
    }

    #[test]
    fn silencio_sem_fala_fecha_com_erro_e_ferramenta_rodando_nao_tem_prazo() {
        let mut mapper = Mapper::new("t1");
        let mut fake = Fake::open(&[init(), shell("started"), shell("completed")]);
        let (done, _) = run(&mut mapper, &mut fake);
        let error = done.and_then(|d| d.error).expect("sem fala, o silêncio longo é erro");
        assert!(error.contains("sem dar sinal"), "{error}");
        assert_eq!(fake.waits, [Some(QUIET_MAX)]);
        // Uma ferramenta em andamento (um build longo) não tem prazo: o processo termina e o EOF fecha o turno.
        let mut mapper = Mapper::new("t2");
        let mut fake = Fake::open(&[init(), shell("started")]);
        fake.closed = true;
        let _ = run(&mut mapper, &mut fake);
        assert_eq!(fake.waits, [None]);
    }

    /// O fim de uma chamada do modelo (`--stream-partial-output`): o texto inteiro dela, com `model_call_id`, e o uso.
    fn call_end(text: &str, call: &str) -> [Value; 2] {
        [
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }, "session_id": SID, "model_call_id": call, "timestamp_ms": 9 }),
            json!({ "type": "usage", "subtype": "model_call", "model_call_id": call, "usage": { "inputTokens": 10, "outputTokens": 5 }, "session_id": SID, "timestamp_ms": 9 }),
        ]
    }
    fn shell_in(sub: &str, call: &str) -> Value {
        let mut line = shell(sub);
        line["model_call_id"] = json!(call);
        line
    }

    #[test]
    fn a_ultima_chamada_do_modelo_fecha_o_turno_em_segundos_com_shell_em_segundo_plano() {
        // A conversa do Ton presa em «Pensando…» a cada pergunta: o agente subiu o Metro (`npx expo start`, que o
        // Cursor manda para segundo plano), respondeu com uma pergunta, e o `cursor-agent -p` ficou esperando o shell
        // acabar antes do `result`. O fim da chamada sem ferramenta é o fim do turno: espera segundos, não minutos.
        let mut mapper = Mapper::new("t1");
        let pergunta = "Vale registrar isso no `docs/`?";
        let mut lines = vec![init(), delta("Vou subir o Metro.", 1)];
        lines.extend(call_end("Vou subir o Metro.", "m1").into_iter().take(1));
        lines.extend([shell_in("started", "m1"), shell_in("completed", "m1")]);
        lines.extend(call_end("Vou subir o Metro.", "m1").into_iter().skip(1));
        lines.push(delta(pergunta, 2));
        lines.extend(call_end(pergunta, "m2"));
        let mut fake = Fake::open(&lines);
        let (done, outs) = run(&mut mapper, &mut fake);
        let done = done.expect("o fim da última chamada encerra o turno");
        assert!(done.error.is_none() && !done.interrupted, "a resposta veio: o turno acabou bem ({done:?})");
        assert_eq!(fake.waits, [Some(QUIET_AFTER_FINAL)], "espera só a folga do result, não {QUIET_AFTER_SPEECH:?}");
        assert!(QUIET_AFTER_FINAL <= std::time::Duration::from_secs(15));
        let said: Vec<&Item> = items(&outs).into_iter().filter(|i| i.kind == ItemKind::Assistant).collect();
        assert_eq!(said.iter().map(|i| i.text.as_deref().unwrap_or("")).collect::<Vec<_>>(), ["Vou subir o Metro.", pergunta]);
    }

    #[test]
    fn a_chamada_que_pediu_ferramenta_nao_fecha_o_turno_e_qualquer_sinal_depois_cancela() {
        // A rodada de ferramenta: o modelo volta depois do resultado, e o turno continua.
        let mut mapper = Mapper::new("t1");
        let mut lines = vec![init(), delta("Vou rodar.", 1), shell_in("started", "m1"), shell_in("completed", "m1")];
        lines.extend(call_end("Vou rodar.", "m1"));
        feed_all(&mut mapper, &lines);
        assert_eq!(mapper.quiet_after(), Some(QUIET_MAX), "a chamada pediu ferramenta: não é o fim");
        // O uso chega com a ferramenta ainda rodando: sem prazo.
        let mut mapper = Mapper::new("t2");
        let mut lines = vec![init(), shell_in("started", "m1")];
        lines.extend(call_end("", "m1"));
        feed_all(&mut mapper, &lines);
        assert_eq!(mapper.quiet_after(), None);
        // Depois do fim, qualquer sinal (um shell que acabou e acorda o modelo de novo) desfaz o fim.
        let mut mapper = Mapper::new("t3");
        let mut lines = vec![init(), delta("Pronto?", 1)];
        lines.extend(call_end("Pronto?", "m1"));
        feed_all(&mut mapper, &lines);
        assert_eq!(mapper.quiet_after(), Some(QUIET_AFTER_FINAL));
        mapper.feed(&json!({ "type": "system", "subtype": "task_notification", "task_id": "k", "status": "completed", "session_id": SID }), 100);
        assert_ne!(mapper.quiet_after(), Some(QUIET_AFTER_FINAL));
    }

    #[test]
    fn o_erro_do_stderr_e_a_ultima_linha_com_texto() {
        let tail = vec!["aviso qualquer".to_string(), "Error: not logged in. Run `cursor-agent login`".to_string(), "  ".to_string()];
        assert_eq!(error_from_stderr(&tail), "Error: not logged in. Run `cursor-agent login`");
        assert_eq!(error_from_stderr(&[]), "O Cursor terminou sem responder");
    }

    #[test]
    fn a_sessao_recusada_do_cursor_so_vale_para_a_frase_de_sessao_inexistente() {
        use crate::conversa::cursor_map::session_refused;
        let linhas = |ls: &[&str]| ls.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        // Frases de sessão/conversa/chat inexistente (a frase exata do CLI não foi capturada: critério por subconjunto).
        for l in ["Error: chat not found: abc", "Session not found", "error: no conversation found with id abc", "No chat found for 7a1b", "invalid session id", "Could not find chat abc", "Error: SESSION_NOT_FOUND"] {
            assert!(session_refused(&linhas(&["aviso qualquer", l, ""])), "{l}");
        }
        // A frase do stderr é de outra coisa: não é prova de sessão recusada.
        for l in ["Error: file not found: src/main.rs", "ENOENT: no such file or directory, open 'a.txt'", "tool read failed: path not found", "Error: not logged in. Run `cursor-agent login`", "model not found: grok", "workspace not found", "chat message too long"] {
            assert!(!session_refused(&linhas(&[l])), "{l}");
        }
        assert!(!session_refused(&[]));
    }
}
