use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use super::{
    CodexModelPage, collect_codex_pages, discover_codex, insert_claude_model,
    parse_claude_help_aliases, parse_codex_model_page,
};
use crate::runs::roster::{ModelAvailability, RosterModel};

fn page(data: serde_json::Value, cursor: serde_json::Value) -> String {
    serde_json::json!({ "data": data, "nextCursor": cursor }).to_string()
}

fn codex_model(id: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({ "id": id, "displayName": format!("Label {id}") });
    if let (Some(dst), Some(src)) = (value.as_object_mut(), extra.as_object()) {
        dst.extend(src.clone());
    }
    value
}

#[test]
fn codex_parses_visible_models_and_only_metadata_the_server_supplies() {
    let raw = page(
        serde_json::json!([
            codex_model(
                "gpt-test",
                serde_json::json!({
                    "contextWindow": 128000,
                    "supportedReasoningEfforts": ["low", {"reasoningEffort": "high"}],
                    "defaultReasoningEffort": "low",
                    "futureField": {"ignored": true}
                })
            ),
            codex_model("hidden-test", serde_json::json!({ "hidden": true }))
        ]),
        serde_json::Value::Null,
    );

    let parsed = parse_codex_model_page(&raw).unwrap();
    assert_eq!(parsed.next_cursor, None);
    assert_eq!(parsed.models.len(), 1);
    let model = &parsed.models[0];
    assert_eq!(model.id, "gpt-test");
    assert_eq!(model.label, "Label gpt-test");
    assert_eq!(model.context, Some(128000));
    assert_eq!(
        model.reasoning_levels.as_deref().unwrap(),
        ["low".to_string(), "high".to_string()]
    );
    assert_eq!(model.default_reasoning.as_deref(), Some("low"));
    assert_eq!(model.cost_in, None);
    assert_eq!(model.cost_out, None);
    assert_eq!(model.toolcall, None);
    assert_eq!(model.availability, ModelAvailability::Unknown);
}

#[test]
fn codex_follows_all_pages_deduplicates_models_and_passes_cursor() {
    let mut requested = Vec::new();
    let models = collect_codex_pages(|cursor| {
        requested.push(cursor.map(str::to_string));
        Ok(match cursor {
            None => page(
                serde_json::json!([codex_model("one", serde_json::json!({}))]),
                serde_json::json!("page-2"),
            ),
            Some("page-2") => page(
                serde_json::json!([
                    codex_model("one", serde_json::json!({ "displayName": "duplicate" })),
                    codex_model("two", serde_json::json!({}))
                ]),
                serde_json::Value::Null,
            ),
            _ => panic!("unexpected cursor"),
        })
    })
    .unwrap();

    assert_eq!(requested, vec![None, Some("page-2".into())]);
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["one", "two"]
    );
    assert_eq!(models[0].label, "Label one");
}

#[test]
fn codex_rejects_repeated_cursor_and_invalid_json() {
    let repeated =
        collect_codex_pages(|_| Ok(page(serde_json::json!([]), serde_json::json!("loop"))));
    assert!(repeated.unwrap_err().contains("repeated"));
    assert!(parse_codex_model_page("{").unwrap_err().contains("invalid"));
    assert!(
        parse_codex_model_page("{}")
            .unwrap_err()
            .contains("data array")
    );
}

#[test]
fn codex_unavailable_executable_returns_descriptive_error() {
    let error =
        discover_codex("ade-codex-binary-that-does-not-exist", &HashMap::new()).unwrap_err();
    assert!(error.contains("could not be started"));
}

#[test]
fn response_reader_reports_closed_process_and_timeout() {
    let (sender, receiver) = mpsc::channel();
    drop(sender);
    let closed =
        super::receive_response(&receiver, 1, "model/list", Duration::from_millis(50)).unwrap_err();
    assert!(closed.contains("closed"));

    let (_sender, receiver) = mpsc::channel();
    let timeout =
        super::receive_response(&receiver, 1, "model/list", Duration::from_millis(5)).unwrap_err();
    assert!(timeout.contains("Timed out"));
}

#[test]
fn response_reader_skips_invalid_and_unrelated_notifications() {
    let (sender, receiver) = mpsc::channel();
    sender.send("not json".to_string()).unwrap();
    sender
        .send(serde_json::json!({ "method": "server/notification" }).to_string())
        .unwrap();
    sender
        .send(serde_json::json!({ "id": 9, "result": {} }).to_string())
        .unwrap();
    sender
        .send(serde_json::json!({ "id": 1, "result": { "ok": true } }).to_string())
        .unwrap();

    let result =
        super::receive_response(&receiver, 1, "initialize", Duration::from_millis(50)).unwrap();
    assert_eq!(result["ok"], true);
}

#[test]
fn claude_help_parser_reads_aliases_from_model_option_and_deduplicates() {
    let help =
        "--model <model> alias for latest (e.g. 'fable', 'opus', or 'sonnet')\n  --other <value>";
    assert_eq!(
        parse_claude_help_aliases(help),
        vec!["fable", "opus", "sonnet"]
    );
}

#[test]
fn claude_catalog_merge_keeps_aliases_and_full_model_ids_separate() {
    let mut models = HashMap::<String, (u8, RosterModel)>::new();
    insert_claude_model(&mut models, "sonnet".into(), "Sonnet".into(), "cli", 1);
    insert_claude_model(
        &mut models,
        "claude-sonnet-5".into(),
        "Claude Sonnet 5".into(),
        "gateway",
        3,
    );
    insert_claude_model(
        &mut models,
        "claude-sonnet-5".into(),
        "old label".into(),
        "legacy",
        0,
    );
    assert_eq!(models.len(), 2);
    assert_eq!(models["claude-sonnet-5"].1.label, "Claude Sonnet 5");
    assert_eq!(models["sonnet"].1.availability, ModelAvailability::Unknown);
}

#[test]
fn codex_page_type_keeps_empty_final_page_valid() {
    let parsed =
        parse_codex_model_page(&page(serde_json::json!([]), serde_json::Value::Null)).unwrap();
    let expected = CodexModelPage {
        models: Vec::new(),
        next_cursor: None,
    };
    assert_eq!(parsed, expected);
}

#[test]
#[ignore = "requires an installed Codex login; read-only app-server model/list probe"]
fn codex_real_app_server_model_list() {
    let started = std::time::Instant::now();
    let mut command = crate::util::program("codex");
    command.args(["app-server", "--listen", "stdio://"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut server = super::CodexServer::new(command.spawn().unwrap()).unwrap();
    server.initialize().unwrap();
    let mut pages = 0;
    let mut hidden = 0;
    let mut next_cursors = 0;
    let models = super::collect_codex_pages(|cursor| {
        pages += 1;
        let raw = server.model_list(cursor)?;
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        hidden += value["data"].as_array().unwrap().iter()
            .filter(|model| model["hidden"].as_bool() == Some(true)).count();
        next_cursors += usize::from(value["nextCursor"].as_str().is_some());
        Ok(raw)
    }).unwrap();
    drop(server);
    eprintln!("Codex pages: {pages}; probe duration: {:?}", started.elapsed());
    eprintln!("Codex nextCursor responses: {next_cursors}; hidden entries filtered: {hidden}; includeHidden=false");
    eprintln!("Codex visible model count: {}", models.len());
    for model in models {
        eprintln!("{}\t{}", model.id, model.label);
    }
}

#[test]
fn codex_limits_broken_pagination() {
    let mut page = 0;
    let result = collect_codex_pages(|_| { page += 1; Ok(serde_json::json!({"data": [], "nextCursor": page.to_string()}).to_string()) });
    assert!(result.unwrap_err().contains("100-page"));
    assert_eq!(page, 100);
}

#[test]
fn claude_config_and_gateway_metadata_do_not_leak_secrets() {
    let config = serde_json::json!({"model": "custom/model", "availableModels": ["one"], "modelPicker": {"options": [{"id": "two", "label": "Two", "apiKey": "fixture-secret"}]}, "env": {"ANTHROPIC_API_KEY": "fixture-secret", "ANTHROPIC_MODEL": "three"}, "modelAliases": {"fast": "one"}});
    let mut catalog = HashMap::new();
    super::collect_claude_config_models(&config, &mut catalog);
    for id in ["custom/model", "one", "two", "three", "fast"] { assert!(catalog.contains_key(id), "{id}"); }
    let dto = serde_json::to_string(&catalog.into_values().map(|(_, model)| model).collect::<Vec<_>>()).unwrap();
    assert!(!dto.contains("fixture-secret"));
    let gateway = super::parse_gateway_models(br#"{"data":[{"id":"two","display_name":"Gateway Two","apiKey":"fixture-secret"}]}"#).unwrap();
    assert_eq!(gateway[0].label, "Gateway Two");
    assert_eq!(gateway[0].availability, ModelAvailability::Unknown);
    assert!(!serde_json::to_string(&gateway).unwrap().contains("fixture-secret"));
}

#[test]
fn claude_config_ignores_unrelated_options_and_sensitive_model_metadata() {
    let config = serde_json::json!({
        "model": "valid-model",
        "options": ["unrelated-option"],
        "metadata": {"model": "unrelated-model", "options": ["fixture-secret"]},
        "env": {"ANTHROPIC_MODEL_API_KEY": "fixture-secret", "ANTHROPIC_BASE_URL": "https://example.test"},
        "availableModels": ["sk-fixture-secret", "https://example.test", "user@example.test", "/tmp/profile", "C:\\profile", "future/model[1m]"],
        "modelPicker": {"options": [
            {"id": "safe-model", "label": "user@example.test", "headers": {"options": ["fixture-secret"]}},
            {"apiKey": "fixture-secret", "metadata": {"id": "unrelated-model"}}
        ]}
    });
    let mut catalog = HashMap::new();
    super::collect_claude_config_models(&config, &mut catalog);
    let mut ids: Vec<_> = catalog.keys().map(String::as_str).collect();
    ids.sort();
    assert_eq!(ids, ["future/model[1m]", "safe-model", "valid-model"]);
    assert_eq!(catalog["safe-model"].1.label, "safe-model");
    let dto = serde_json::to_string(&catalog).unwrap();
    for sensitive in ["fixture-secret", "example.test", "profile", "unrelated"] {
        assert!(!dto.contains(sensitive), "{sensitive}");
    }
}

#[test]
fn claude_help_handles_apostrophes_and_next_short_option() {
    let help = "--model <model> alias (e.g. 'sonnet') or a model's full name ('claude-custom-5')\n  -n, --name <name> 'not-model'";
    assert_eq!(parse_claude_help_aliases(help), ["claude-custom-5", "sonnet"]);
}

#[test]
fn claude_global_gateway_enriches_known_ids_without_becoming_the_catalog() {
    let mut catalog = HashMap::new();
    for id in super::parse_claude_help_aliases("--model <model> alias 'sonnet' or 'claude-fable-5'\n  --next") {
        insert_claude_model(&mut catalog, id.clone(), id, "claude_cli_help", 1);
    }
    super::collect_claude_config_models(&serde_json::json!({
        "model": "claude-code/spacexai/grok-build-0.1",
        "availableModels": ["minimax-m2.5-free"]
    }), &mut catalog);
    let gateway = super::parse_gateway_models(br#"{"data":[
        {"id":"gemini-2.5","name":"Gemini"},
        {"id":"deepseek","name":"DeepSeek"},
        {"id":"glm","name":"GLM"},
        {"id":"seed","name":"ByteDance Seed"},
        {"id":"claude-new","name":"Claude"},
        {"id":"minimax-m2.5-free","name":"MiniMax M2.5 Free","apiKey":"fixture-secret"},
        {"id":"claude-code/spacexai/grok-build-0.1","name":"Grok Build 0.1"},
        {"id":"sk-fixture-secret","name":"secret"}
    ]}"#).unwrap();
    super::enrich_claude_models(&mut catalog, gateway);
    assert_eq!(catalog.len(), 4);
    assert!(catalog.contains_key("sonnet"));
    assert!(catalog.contains_key("claude-fable-5"));
    assert_eq!(catalog["minimax-m2.5-free"].1.label, "MiniMax M2.5 Free");
    assert_eq!(catalog["minimax-m2.5-free"].1.source.as_deref(), Some("claude_config"));
    assert_eq!(catalog["minimax-m2.5-free"].1.availability, ModelAvailability::Unknown);
    assert_eq!(catalog["claude-code/spacexai/grok-build-0.1"].1.label, "Grok Build 0.1");
    assert!(!serde_json::to_string(&catalog).unwrap().contains("fixture-secret"));
}

#[test]
fn gateway_alone_cannot_create_claude_models() {
    let mut catalog = HashMap::new();
    let gateway = super::parse_gateway_models(br#"{"data":[{"id":"claude-new"},{"id":"gemini"}]}"#).unwrap();
    super::enrich_claude_models(&mut catalog, gateway);
    assert!(catalog.is_empty());
}

#[test]
#[ignore = "requires installed Claude Code; read-only help/config/gateway discovery"]
fn claude_real_model_discovery() {
    let env = HashMap::new();
    let help = super::run_read_only("claude", &["--help"], &env).unwrap();
    eprintln!("CLI model IDs/aliases: {:?}", super::parse_claude_help_aliases(&help));
    eprintln!("Gateway configured: {}", super::claude_gateway_base_url(&env).is_some());
    let mut configured = HashMap::new();
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".claude"));
    for path in super::claude_config_paths(&dir) {
        if let Ok(raw) = std::fs::read_to_string(path)
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            super::collect_claude_config_models(&value, &mut configured);
        }
    }
    let mut configured_ids: Vec<_> = configured.keys().collect();
    configured_ids.sort();
    eprintln!("Claude configured model IDs: {configured_ids:?}");
    let catalog = super::discover_claude("claude", &env).unwrap();
    eprintln!("Claude catalog count: {}", catalog.len());
    for model in catalog { eprintln!("{}\t{}\t{}", model.id, model.label, model.source.as_deref().unwrap_or("unknown")); }
}

#[test]
#[cfg(windows)]
fn codex_server_drop_terminates_owned_process() {
    let mut command = crate::util::program("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"])
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let child = command.spawn().unwrap();
    let pid = child.id();
    drop(super::CodexServer::new(child).unwrap());
    let output = crate::util::program("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &format!("Get-Process -Id {pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id")]).output().unwrap();
    assert!(output.stdout.is_empty(), "owned process survived cleanup");
}

#[test]
fn claude_native_catalog_separates_main_more_and_model_specific_effort() {
    let document = serde_json::json!({ "surfaces": { "cc": { "model_selector_config": [{
        "id": "cc", "models": [
            {"id":"claude-opus-5-5", "name":"Opus 5.5", "section":"main", "min_claude_code_version":"2.1.280",
             "thinking":{"effort_options":[{"id":"low"},{"id":"medium"},{"id":"high"},{"id":"xhigh"},{"id":"max"},{"id":"unsafe"}]},
             "runtime":{"default_effort":"high", "max_input_tokens":1000000}},
            {"id":"claude-haiku-4-5", "name":"Haiku 4.5", "section":"main", "thinking":{"type":"none"}},
            {"id":"old-native", "name":"Old native", "section":"overflow"},
            {"id":"future-native", "name":"Future", "section":"main", "min_claude_code_version":"2.1.300"}
        ]
    }] } } });
    let models = super::parse_claude_native_catalog(&document, "2.1.280 (Claude Code)");
    assert_eq!(models.len(), 3);
    let opus = models.iter().find(|m| m.id == "claude-opus-5-5").unwrap();
    assert_eq!(opus.label, "Opus 5.5");
    assert_eq!(opus.source.as_deref(), Some("native"));
    assert_eq!(opus.reasoning_levels.as_ref().unwrap(), &["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(opus.default_reasoning.as_deref(), Some("high"));
    assert!(models.iter().find(|m| m.id == "claude-haiku-4-5").unwrap().reasoning_levels.as_ref().unwrap().is_empty());
    assert_eq!(models.iter().find(|m| m.id == "old-native").unwrap().source.as_deref(), Some("native_more"));
    let mut catalog: HashMap<_, _> = models.into_iter().map(|m| (m.id.clone(), (4, m))).collect();
    super::collect_claude_config_models(&serde_json::json!({"model":"minimax-m2.5-free"}), &mut catalog);
    super::enrich_claude_models(&mut catalog, super::parse_gateway_models(br#"{"data":[{"id":"gemini"},{"id":"claude-opus-5-5","name":"Gateway label"},{"id":"minimax-m2.5-free","name":"MiniMax"}]}"#).unwrap());
    assert_eq!(catalog.len(), 4);
    assert_eq!(catalog["claude-opus-5-5"].1.label, "Opus 5.5");
    assert_eq!(catalog["minimax-m2.5-free"].1.source.as_deref(), Some("claude_config"));
    assert_eq!(catalog["minimax-m2.5-free"].1.label, "MiniMax");
    assert!(super::parse_claude_native_catalog(&document, "unknown").is_empty());
    assert!(super::parse_claude_native_catalog(&serde_json::json!({}), "2.1.280").is_empty());
}
