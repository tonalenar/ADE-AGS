//! Native Antigravity print mode. Task configs are isolated; OAuth stays in the OS keyring.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};

use super::agents::{HeadlessAgent, Launch, LaunchCtx};
use super::types::{AgentEvent, TaskOutcome};

const SERVER_ENV: &str = "ADE_ANTIGRAVITY_MCP_SERVER";

/// Owns only a newly created temporary directory, never a user profile or workspace.
pub(super) struct TaskProfile {
    root: PathBuf,
    server_name: String,
}

impl TaskProfile {
    pub(super) fn prepare(
        mcp_config: Option<&Path>, allowed_tools: &[String], read_only: bool, cwd: &str,
    ) -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!("ade-antigravity-{}", uuid::Uuid::new_v4()));
        // create_dir fails rather than reusing or deleting an existing directory.
        std::fs::create_dir(&root).map_err(|e| format!("Antigravity task profile: {e}"))?;
        let profile = Self {
            root,
            server_name: format!("ade_task_{}", uuid::Uuid::new_v4().simple()),
        };
        profile.write(mcp_config, allowed_tools, read_only, cwd)?;
        Ok(profile)
    }

    fn write(&self, mcp_config: Option<&Path>, allowed: &[String], read_only: bool, cwd: &str) -> Result<(), String> {
        let workspace = Path::new(cwd);
        if !workspace.is_absolute() || !workspace.is_dir() {
            return Err("Antigravity task workspace must be an existing absolute directory".into());
        }
        let tools: Vec<&str> = allowed.iter().map(|name| {
            let bare = name.strip_prefix("mcp__ags__")
                .filter(|name| crate::ipc::mcp::tool_names().contains(name))
                .ok_or_else(|| format!("Invalid ADE MCP tool: {name}"))?;
            if read_only && !super::policy::lead_may_use(name) {
                return Err(format!("Antigravity Lead cannot use {bare}"));
            }
            Ok(bare)
        }).collect::<Result<_, String>>()?;

        let mut servers = serde_json::Map::new();
        if let Some(path) = mcp_config {
            let raw = std::fs::read(path).map_err(|e| format!("Antigravity task MCP config: {e}"))?;
            let config: Value = serde_json::from_slice(&raw).map_err(|e| format!("Antigravity task MCP config: {e}"))?;
            let server = config.pointer("/mcpServers/ags")
                .ok_or("Antigravity task MCP server is missing")?;
            let command = server.get("command").and_then(Value::as_str)
                .filter(|s| !s.is_empty()).ok_or("Antigravity task MCP command is missing")?;
            let args = server.get("args").and_then(Value::as_array)
                .filter(|a| a.iter().all(Value::is_string)).ok_or("Antigravity task MCP args are invalid")?;
            let task_arg = args.windows(2).find(|pair| pair[0].as_str() == Some("--task"))
                .and_then(|pair| pair[1].as_str()).filter(|s| !s.is_empty());
            if task_arg.is_none() { return Err("Antigravity MCP requires a Task identity".into()); }
            // The MCP bridge must still find the original ADE instance and OS home.
            let mut bridge_env = HashMap::new();
            for key in ["HOME", "USERPROFILE"] {
                if let Ok(value) = std::env::var(key) { bridge_env.insert(key.to_string(), value); }
            }
            if let Some(home) = dirs::home_dir() {
                bridge_env.entry("HOME".into()).or_insert_with(|| home.to_string_lossy().into_owned());
                bridge_env.entry("USERPROFILE".into()).or_insert_with(|| home.to_string_lossy().into_owned());
            }
            bridge_env.insert(crate::ipc::protocol::HANDSHAKE_ENV.into(),
                crate::ipc::protocol::client_handshake_path().to_string_lossy().into_owned());
            let disabled: Vec<_> = crate::ipc::mcp::tool_names().into_iter()
                .filter(|name| !tools.contains(name)).collect();
            servers.insert(self.server_name.clone(), json!({
                "command": command, "args": args, "env": bridge_env,
                "cwd": cwd, "disabledTools": disabled,
            }));
        } else if !tools.is_empty() || read_only {
            return Err("Antigravity orchestration requires the ADE Task MCP config".into());
        }

        let mut deny = vec!["command(*)".to_string(), "unsandboxed(*)".into(), "execute_url(*)".into()];
        if read_only {
            deny.push("write_file(*)".into());
        } else {
            // Workers cannot change the policy or Task identity they were launched with.
            deny.push(format!("write_file({})", self.root.to_string_lossy()));
        }
        let permissions: Vec<_> = tools.iter().map(|tool| format!("mcp({}/{tool})", self.server_name)).collect();
        let settings = json!({
            "toolPermission": "request-review",
            "allowNonWorkspaceAccess": false,
            "permissions": { "allow": permissions, "deny": deny, "ask": [] },
        });
        let config_dir = self.root.join(".gemini").join("config");
        let settings_dir = self.root.join(".gemini").join("antigravity-cli");
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir(self.workspace()).map_err(|e| e.to_string())?;
        std::fs::write(config_dir.join("mcp_config.json"), json!({"mcpServers": servers}).to_string())
            .map_err(|e| e.to_string())?;
        std::fs::write(settings_dir.join("settings.json"), settings.to_string()).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(super) fn workspace(&self) -> PathBuf { self.root.join("workspace") }

    pub(super) fn env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("HOME".into(), self.root.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), self.root.to_string_lossy().into_owned()),
            (SERVER_ENV.into(), self.server_name.clone()),
        ])
    }
}

impl Drop for TaskProfile {
    fn drop(&mut self) {
        // root was exclusively created by prepare, outside all user workspaces.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct Stream {
    started: bool,
    text: String,
    tools: HashSet<i64>,
    result: Option<TaskOutcome>,
}

#[derive(Default)]
pub(crate) struct Antigravity(Mutex<Stream>);

impl HeadlessAgent for Antigravity {
    fn launch(&self, prompt: &str, model: Option<&str>, _budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        if !ctx.account_env.contains_key(SERVER_ENV)
            || !ctx.account_env.contains_key("HOME")
            || !ctx.account_env.contains_key("USERPROFILE")
        {
            // Never fall back to the system MCP configuration or permission policy.
            return Launch { program: "ADE-missing-Antigravity-task-profile".into(), args: vec![], env: HashMap::new() };
        }
        let mut args = vec![
            "--print".into(), "--output-format".into(), "stream-json".into(),
            "--disable-slash-commands".into(), "--mode".into(),
            // Lead read-only is enforced by deny rules, not the /plan prompt prefix.
            // Native planning mode can request writing plan artifacts; ADE owns the DAG.
            "accept-edits".into(),
            "--add-dir".into(), ctx.cwd.into(),
        ];
        if let Some(model) = model { args.extend(["--model".into(), model.into()]); }
        if let Some(effort) = ctx.reasoning_effort { args.extend(["--effort".into(), effort.into()]); }
        if let Some(schema) = &ctx.json_schema { args.extend(["--json-schema".into(), schema.clone()]); }
        let mut full = format!("Task workspace: {}\nUse this directory for all task files.\n", ctx.cwd);
        if let Some(server) = ctx.account_env.get(SERVER_ENV) {
            full.push_str(&format!("ADE orchestration tools are MCP tools on server `{server}`. \
                Use `call_mcp_tool` with this server and the bare tool name (for example task_status or task_handoff). \
                Coordinate through ADE, not native subagents.\n"));
        }
        if let Some(system) = &ctx.system_prompt { full.push_str(system); full.push_str("\n\n---\n\n"); }
        full.push_str(prompt);
        args.insert(1, full);
        Launch { program: "agy".into(), args, env: ctx.account_env.clone() }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![]; };
        let mut stream = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut events = Vec::new();
        let conversation = v.get("conversation_id").or_else(|| v.pointer("/step_update/conversation_id"))
            .or_else(|| v.pointer("/result/conversation_id")).and_then(Value::as_str);
        if !stream.started && let Some(id) = conversation.filter(|id| !id.is_empty()) {
            stream.started = true;
            events.push(AgentEvent::Started { session_id: Some(id.into()) });
        }
        match v.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                let step = &v["step_update"];
                if step["step_type"] == "agent_response" {
                    if let Some(delta) = step.get("text_delta").and_then(Value::as_str) {
                        stream.text.push_str(delta);
                        if let Some(text) = super::activity::text_line(delta) { events.push(AgentEvent::Text { text }); }
                    }
                } else if step["state"] == "ACTIVE"
                    && let Some(index) = step.get("step_index").and_then(Value::as_i64)
                    && stream.tools.insert(index)
                {
                    let name = step.get("tool_name").or_else(|| step.get("step_type")).and_then(Value::as_str).unwrap_or("tool");
                    let (canonical, input) = super::adapters::normalize_tool(name, step.get("parameters").unwrap_or(&Value::Null));
                    events.push(AgentEvent::Tool { label: super::activity::tool_label(&canonical, &input), name: canonical });
                }
            }
            Some("result") => {
                let result = &v["result"];
                let ok = result["status"] == "SUCCESS";
                let text = result.get("structured_output").filter(|value| !value.is_null())
                    .map(Value::to_string).or_else(|| result.get("response").and_then(Value::as_str).map(str::to_string));
                let outcome = TaskOutcome {
                    ok,
                    result: if ok { text.or_else(|| (!stream.text.is_empty()).then(|| stream.text.clone())) } else { None },
                    error: if ok { None } else { Some(result.get("error").and_then(Value::as_str)
                        .filter(|error| !error.is_empty()).map(str::to_string)
                        .unwrap_or_else(|| format!("Antigravity ended with status {}", result["status"]))) },
                    cost_usd: None,
                    tokens_in: result.pointer("/usage/input_tokens").and_then(Value::as_i64),
                    tokens_out: result.pointer("/usage/output_tokens").and_then(Value::as_i64),
                };
                stream.result = Some(outcome.clone());
                events.push(AgentEvent::Finished { outcome });
            }
            _ => {}
        }
        events
    }

    fn finish(&self, _emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        let result = self.0.lock().unwrap_or_else(|e| e.into_inner()).result.clone();
        match result {
            Some(mut outcome) => {
                if code != 0 && outcome.ok {
                    outcome.ok = false;
                    outcome.result = None;
                    outcome.error = Some(format!("Antigravity exited with code {code} after its result"));
                }
                outcome
            }
            None => TaskOutcome::failed(format!("Antigravity exited with code {code} without a terminal result")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        config: PathBuf,
    }

    impl Fixture {
        fn new(task: &str) -> Self {
            let root = std::env::temp_dir().join(format!("ade-antigravity-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let config = root.join("task.json");
            std::fs::write(&config, json!({"mcpServers": {"ags": {
                "command": "C:\\Program Files\\ADE\\ags.exe", "args": ["mcp", "--task", task],
            }}}).to_string()).unwrap();
            Self { root, config }
        }
        fn cwd(&self) -> &str { self.root.to_str().unwrap() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    fn tool(name: &str) -> String { format!("mcp__ags__{name}") }
    fn read(path: impl AsRef<Path>) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn concurrent_tasks_have_distinct_mcp_profiles_and_preserve_workspace_config() {
        let a = Fixture::new("task-a");
        let b = Fixture::new("task-b");
        let protected = a.root.join(".agents");
        std::fs::create_dir(&protected).unwrap();
        std::fs::write(protected.join("mcp_config.json"), b"workspace config remains unchanged").unwrap();
        let before = std::fs::read(&a.config).unwrap();
        let worker = TaskProfile::prepare(Some(&a.config), &[tool("task_handoff"), tool("fact_add")], false, a.cwd()).unwrap();
        let lead = TaskProfile::prepare(Some(&b.config), &[tool("run_plan"), tool("task_status")], true, a.cwd()).unwrap();
        assert_ne!(worker.root, lead.root);
        assert_ne!(worker.server_name, lead.server_name);
        for (profile, task, expected) in [(&worker, "task-a", "task_handoff"), (&lead, "task-b", "run_plan")] {
            let config = read(profile.root.join(".gemini/config/mcp_config.json"));
            let servers = config["mcpServers"].as_object().unwrap();
            assert_eq!(servers.len(), 1);
            let server = &servers[&profile.server_name];
            assert_eq!(server["command"], "C:\\Program Files\\ADE\\ags.exe");
            assert_eq!(server["args"], json!(["mcp", "--task", task]));
            assert_eq!(server["cwd"], a.cwd());
            assert!(!server["disabledTools"].as_array().unwrap().contains(&json!(expected)));
            assert!(server["disabledTools"].as_array().unwrap().contains(&json!(crate::ipc::mcp::TOOL_NAME)));
            assert_ne!(server["env"]["USERPROFILE"], profile.env()["USERPROFILE"]);
            assert_eq!(server["env"][crate::ipc::protocol::HANDSHAKE_ENV],
                crate::ipc::protocol::client_handshake_path().to_string_lossy().as_ref());
        }
        let policy = read(lead.root.join(".gemini/antigravity-cli/settings.json"));
        assert_eq!(policy["toolPermission"], "request-review");
        for deny in ["write_file(*)", "command(*)", "unsandboxed(*)", "execute_url(*)"] {
            assert!(policy["permissions"]["deny"].as_array().unwrap().contains(&json!(deny)));
        }
        assert!(policy["permissions"]["allow"].as_array().unwrap().iter().all(|v| {
            let value = v.as_str().unwrap();
            value.contains(&lead.server_name) && !value.contains("task_handoff")
        }));
        assert_eq!(std::fs::read(&a.config).unwrap(), before);
        assert_eq!(std::fs::read(protected.join("mcp_config.json")).unwrap(), b"workspace config remains unchanged");
        let owned = worker.root.clone();
        drop(worker);
        assert!(!owned.exists());
        assert!(a.root.exists());
        assert!(lead.root.exists());
    }

    #[test]
    fn invalid_task_mcp_and_mutating_lead_tools_are_rejected_before_launch() {
        let f = Fixture::new("task-a");
        assert!(TaskProfile::prepare(None, &[tool("run_plan")], true, f.cwd()).is_err());
        for tool_name in ["task_handoff", "unknown", "git_commit"] {
            assert!(TaskProfile::prepare(Some(&f.config), &[tool(tool_name)], true, f.cwd()).is_err());
        }
        std::fs::write(&f.config, "invalid json").unwrap();
        assert!(TaskProfile::prepare(Some(&f.config), &[], false, f.cwd()).is_err());
        std::fs::write(&f.config, json!({"mcpServers":{"ags":{"command":"ags", "args":["mcp"]}}}).to_string()).unwrap();
        assert!(TaskProfile::prepare(Some(&f.config), &[], false, f.cwd()).is_err());
        assert!(TaskProfile::prepare(None, &[], false, "relative/path").is_err());
    }

    #[test]
    fn launch_pins_model_effort_schema_and_real_workspace_without_bypassing_permissions() {
        let f = Fixture::new("task-a");
        let tools = [tool("task_status")];
        let profile = TaskProfile::prepare(Some(&f.config), &tools, true, f.cwd()).unwrap();
        let ctx = LaunchCtx {
            fast_mode: false,
            cwd: f.cwd(), session_id: "session", account_env: profile.env(),
            mcp_config: Some(f.config.clone()), system_prompt: Some("Lead delegates implementation".into()),
            allowed_tools: tools.to_vec(), json_schema: Some("{\"type\":\"object\"}".into()),
            read_only: true, reasoning_effort: Some("high"),
        };
        let launch = Antigravity::default().launch("User objective", Some("gemini-3.8-flash-high"), None, &ctx);
        assert_eq!(launch.program, "agy");
        for pair in [["--mode", "accept-edits"], ["--model", "gemini-3.8-flash-high"], ["--effort", "high"],
            ["--output-format", "stream-json"], ["--add-dir", f.cwd()], ["--json-schema", "{\"type\":\"object\"}"]] {
            assert!(launch.args.windows(2).any(|args| args == pair));
        }
        assert!(launch.args[1].contains(&profile.server_name));
        assert!(launch.args[1].contains("call_mcp_tool"));
        assert!(launch.args[1].contains("Lead delegates implementation"));
        assert!(launch.args[1].ends_with("User objective"));
        assert!(launch.args.contains(&"--disable-slash-commands".into()));
        assert!(!launch.args.iter().any(|arg| arg.contains("dangerously-skip") || arg == "--continue"));
    }

    #[test]
    fn native_stream_tracks_session_deltas_tools_result_and_usage_once() {
        let agent = Antigravity::default();
        let lines = [
            json!({"event":"init", "conversation_id":"native-session", "init":{"tools":[]}}),
            json!({"event":"step_update", "step_update":{"conversation_id":"native-session", "step_index":1, "state":"ACTIVE", "step_type":"agent_response", "text_delta":"hello "}}),
            json!({"event":"step_update", "step_update":{"step_index":1, "state":"DONE", "step_type":"agent_response", "text_delta":"world"}}),
            json!({"event":"step_update", "step_update":{"step_index":2, "state":"ACTIVE", "step_type":"call_mcp_tool"}}),
            json!({"event":"step_update", "step_update":{"step_index":2, "state":"ACTIVE", "step_type":"call_mcp_tool"}}),
            json!({"event":"result", "result":{"conversation_id":"native-session", "status":"SUCCESS", "response":"final answer", "usage":{"input_tokens":123,"output_tokens":7}}}),
        ];
        let events: Vec<_> = lines.iter().flat_map(|line| agent.parse_line(&line.to_string())).collect();
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Started {..})).count(), 1);
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Tool {..})).count(), 1);
        assert!(matches!(&events[0], AgentEvent::Started { session_id: Some(id) } if id == "native-session"));
        let outcome = agent.finish(None, 0);
        assert!(outcome.ok);
        assert_eq!(outcome.result.as_deref(), Some("final answer"));
        assert_eq!((outcome.tokens_in, outcome.tokens_out), (Some(123), Some(7)));
        assert!(!agent.finish(Some(outcome), 1).ok);
    }

    #[test]
    fn errors_cancellation_missing_result_and_schema_outputs_are_not_false_successes() {
        for status in ["ERROR", "CANCELED", "INTERRUPTED", "WAITING", "RUNNING", "INVALID"] {
            let agent = Antigravity::default();
            agent.parse_line(&json!({"event":"result", "result":{"status":status,"error":"native failure"}}).to_string());
            let outcome = agent.finish(None, 0);
            assert!(!outcome.ok, "{status}");
            assert_eq!(outcome.error.as_deref(), Some("native failure"));
        }
        let agent = Antigravity::default();
        assert!(agent.parse_line("not JSON").is_empty());
        assert!(!agent.finish(None, 0).ok);
        agent.parse_line(&json!({"event":"result","result":{"status":"SUCCESS","structured_output":{"summary":"done"}}}).to_string());
        let outcome = agent.finish(None, 0);
        assert!(outcome.ok);
        assert_eq!(outcome.result.as_deref(), Some("{\"summary\":\"done\"}"));
    }

    #[test]
    #[ignore = "requires native agy; metadata only, never submits a prompt"]
    fn native_cli_loads_task_mcp_and_lead_permissions_without_inference() {
        let f = Fixture::new("metadata-probe");
        let profile = TaskProfile::prepare(Some(&f.config), &[tool("task_status")], true, f.cwd()).unwrap();
        let program = crate::util::find_program("agy").expect("agy installed");
        for (args, expected) in [
            (vec!["mcp", "list"], profile.server_name.as_str()),
            (vec!["-p", "/permissions"], "deny\twrite_file(*)"),
        ] {
            let output = crate::util::external_command(&program, &args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
                .envs(profile.env()).current_dir(profile.workspace()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            assert!(String::from_utf8_lossy(&output.stdout).contains(expected));
        }
    }
}
