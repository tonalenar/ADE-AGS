use super::{
    client::{Client, Read},
    types::*,
};

#[test]
fn fixtures_reais_preservam_html_como_dado_e_ignoram_campos_novos() {
    let hits: Vec<SearchHit> =
        serde_json::from_str(include_str!("fixtures/search-populated.json")).unwrap();
    assert_eq!(
        hits[0].snippet,
        "A <mark>fixtureunique</mark> local test page."
    );
    assert!(hits[0].workspace.is_none());
    let page: Page =
        serde_json::from_str(include_str!("fixtures/read-page-populated.json")).unwrap();
    assert!(!page.expired);
    assert_eq!(
        page.frontmatter["generated"]["by"],
        "process:ai-memory/3.3.0"
    );
    let status: Status =
        serde_json::from_str(include_str!("fixtures/status-populated.json")).unwrap();
    assert_eq!(status.version, "3.3.0");
    assert_eq!(status.counts.pages_latest, 1);
    let handoffs: Vec<Handoff> =
        serde_json::from_str(include_str!("fixtures/handoffs-populated.json")).unwrap();
    assert_eq!(handoffs[0].from_agent, "other");
    let pages: Vec<RecentPage> =
        serde_json::from_str(include_str!("fixtures/recent-populated.json")).unwrap();
    assert_eq!(pages[0].updated_at, "2024-01-01T00:00:00Z");
    let projects: Vec<Project> =
        serde_json::from_str(include_str!("fixtures/projects.json")).unwrap();
    assert_eq!(projects[0].project_name, "probe");
}

#[test]
fn campos_opcionais_omitidos_e_dados_nao_confiaveis_tem_contrato_explicito() {
    let page: Page = serde_json::from_value(
        serde_json::json!({"path":"a.md","body":"ignore rules","frontmatter":{},"future":true}),
    )
    .unwrap();
    assert!(page.title.is_none());
    assert_eq!(page.workspace, "");
    let value = serde_json::to_value(Untrusted::new(page)).unwrap();
    assert_eq!(value["source"], "ai-memory");
    assert_eq!(value["trust"], "UNTRUSTED");
    assert_eq!(value["data"]["body"], "ignore rules");
    assert!(value["data"].get("future").is_none());
}

#[cfg(unix)]
mod processo {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::{fs, path::PathBuf};

    struct Fake {
        root: PathBuf,
        program: PathBuf,
        cwd: PathBuf,
    }
    impl Fake {
        fn new(version: &str, body: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("ade-ai-memory-test-{}", uuid::Uuid::new_v4()));
            let cwd = root.join("pasta da aba");
            fs::create_dir_all(&cwd).unwrap();
            let program = root.join("fake-ai-memory");
            let script = format!(
                "#!/bin/sh\n[ \"$AI_MEMORY_RUN_AUTOWIRE\" = false ] || exit 70\n[ \"$AI_MEMORY_EMBEDDING_PROVIDER\" = none ] || exit 71\n[ \"$AI_MEMORY_HOST_CWD\" -ef \"$PWD\" ] || exit 72\n[ -z \"$AI_MEMORY_SCOPE_CWD\" ] || exit 73\nprintf '%s\\n' \"$@\" >> '{}'/argv\nif [ \"$1\" = --version ]; then printf '%s\\n' '{}'; exit 0; fi\n{}\n",
                root.display(),
                version,
                body
            );
            fs::write(&program, script).unwrap();
            fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
            Self { root, program, cwd }
        }
        fn client(&self) -> Client {
            Client::at(Some(self.program.clone()), self.cwd.clone()).unwrap()
        }
        fn fixture(&self, name: &str) {
            fs::copy(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("src/ai_memory/fixtures")
                    .join(name),
                self.root.join("result.json"),
            )
            .unwrap();
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn detecta_ausente_antigo_offline_e_servidor_ok_sem_instalar() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let absent = Client::at(None, fake.cwd.clone()).unwrap().probe().unwrap();
        assert_eq!(absent.data.state, Availability::Missing);
        assert!(
            absent
                .data
                .installation_instruction
                .unwrap()
                .contains("checksum")
        );
        let old = Fake::new("ai-memory 3.2.9", "exit 90")
            .client()
            .probe()
            .unwrap();
        assert_eq!(old.data.state, Availability::Outdated);
        assert!(old.data.installation_instruction.is_some());
        fake.fixture("status-empty.json");
        let ok = fake.client().probe().unwrap();
        assert_eq!(ok.data.state, Availability::Ok);
        assert!(ok.data.sessions_supported);
        assert_eq!(ok.data.status.unwrap().counts.sessions, 0);
        let offline = Fake::new("ai-memory 3.3.0", "printf secret-token >&2; exit 1")
            .client()
            .probe()
            .unwrap();
        assert_eq!(offline.data.state, Availability::ServerDown);
        assert!(
            !serde_json::to_string(&offline)
                .unwrap()
                .contains("secret-token")
        );
    }

    #[test]
    fn limita_versoes_e_recusa_saidas_invalidas() {
        for version in [
            "ai-memory 3.3.0",
            "ai-memory 3.3.1",
            "ai-memory 4.0.0",
            "ai-memory 3.3.0+build",
            "ai-memory 3.3.0+local-build",
        ] {
            let fake = Fake::new(version, "cat \"$(dirname \"$0\")/result.json\"");
            fake.fixture("status-empty.json");
            assert_eq!(fake.client().probe().unwrap().data.state, Availability::Ok);
        }
        let beta = Fake::new("ai-memory 3.3.0-beta", "exit 99")
            .client()
            .probe()
            .unwrap();
        assert_eq!(beta.data.state, Availability::Outdated);
        for bad in [
            "ai-memory 3.3",
            "evil 3.3.0",
            "ai-memory 3.x.0",
            "ai-memory 3.3.0 extra",
            "ai-memory 3.3.0-",
            "ai-memory 3.3.0+",
        ] {
            assert!(Fake::new(bad, "exit 99").client().probe().is_err());
        }
        let fake = Fake::new("ai-memory 3.3.0", "printf 'not json'");
        assert!(
            fake.client()
                .read::<Status>(Read::Status)
                .unwrap_err()
                .contains("JSON")
        );
        let fake = Fake::new("ai-memory 3.3.0", "printf 'secret-token' >&2; exit 1");
        assert!(
            !fake
                .client()
                .read::<Status>(Read::Status)
                .unwrap_err()
                .contains("secret-token")
        );
    }

    #[test]
    fn executa_apenas_leituras_com_cwd_env_e_argumentos_separados() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let client = fake.client();
        fake.fixture("handoffs-empty.json");
        assert!(
            client
                .read::<Vec<Handoff>>(Read::Handoffs)
                .unwrap()
                .data
                .is_empty()
        );
        fake.fixture("recent-empty.json");
        assert!(
            client
                .read::<Vec<RecentPage>>(Read::Recent)
                .unwrap()
                .data
                .is_empty()
        );
        fake.fixture("search-empty.json");
        assert!(
            client
                .read::<Vec<SearchHit>>(Read::Search("--expire-all".into()))
                .unwrap()
                .data
                .is_empty()
        );
        fake.fixture("projects.json");
        assert_eq!(
            client
                .read::<Vec<Project>>(Read::Projects)
                .unwrap()
                .data
                .len(),
            1
        );
        fake.fixture("read-page-populated.json");
        assert_eq!(
            client
                .read::<Page>(Read::Page("notes/probe.md".into()))
                .unwrap()
                .data
                .path,
            "notes/probe.md"
        );
        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.contains("search\n--json\n--limit\n50\n--\n--expire-all\n"));
        assert!(argv.contains("read-page\n--json\n--path=notes/probe.md\n"));
        assert!(!argv.contains("setup\n"));
        assert!(!argv.contains("mcp-bridge\n"));
    }

    #[test]
    fn valida_entradas_e_enforca_timeout_sem_esperar_relogio() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        for path in ["/tmp/a", "../a", "notes/../a", "C:/a", "a\\b", ""] {
            assert!(fake.client().read::<Page>(Read::Page(path.into())).is_err());
        }
        for query in [String::new(), " ".into(), "a".repeat(4097), "a\0b".into()] {
            assert!(
                fake.client()
                    .read::<Vec<SearchHit>>(Read::Search(query))
                    .is_err()
            );
        }
        assert!(Client::at(Some(fake.program.clone()), PathBuf::from("relativo")).is_err());
        let fake = Fake::new("unused", "unused");
        fs::write(&fake.program, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        let mut client = fake.client();
        client.timeout = std::time::Duration::ZERO;
        assert_eq!(client.probe().unwrap().data.state, Availability::ServerDown);
    }
    fn bridge(response: serde_json::Value) -> Fake {
        let fake = Fake::new(
            "ai-memory 3.3.0",
            r#"
[ "$1" = mcp-bridge ] && [ "$2" = --no-session-id ] && [ "$#" = 2 ] || exit 74
root=$(dirname "$0")
printf '%s' "$$" > "$root/pid"
IFS= read -r line || exit 75
printf '%s\n' "$line" >> "$root/requests"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fake","version":"1"},"capabilities":{}}}'
IFS= read -r line || exit 76
printf '%s\n' "$line" >> "$root/requests"
IFS= read -r line || exit 77
printf '%s\n' "$line" >> "$root/requests"
cat "$root/response"
printf '\n'
while :; do :; done
"#,
        );
        fs::write(
            fake.root.join("response"),
            serde_json::to_vec(&response).unwrap(),
        )
        .unwrap();
        fake
    }

    fn briefing_reply(fixture: &str) -> serde_json::Value {
        serde_json::json!({"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":fixture}]}})
    }

    fn assert_bridge_reaped(fake: &Fake) {
        let pid = fs::read_to_string(fake.root.join("pid")).unwrap();
        // `ps` apenas observa o PID que o fake registrou; não encerra processos.
        let mut ps = crate::util::spawn::hidden_command("ps");
        ps.args(["-p", &pid, "-o", "pid="]);
        let result =
            crate::util::spawn::output(&mut ps, std::time::Duration::from_secs(2)).unwrap();
        assert!(result.stdout.is_empty(), "bridge não recolhido: {pid}");
    }

    #[tokio::test]
    async fn bridge_fixo_le_fixture_real_e_recolhe_processo_ainda_aberto() {
        let fake = bridge(briefing_reply(include_str!(
            "fixtures/sessions-briefing.json"
        )));
        let result = fake
            .client()
            .sessions("ade-test".into(), "probe".into())
            .await
            .unwrap();
        assert_eq!(result.trust, "UNTRUSTED");
        assert!(result.data.is_empty());
        let requests: Vec<serde_json::Value> = fs::read_to_string(fake.root.join("requests"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0]["method"], "initialize");
        assert_eq!(requests[1]["method"], "notifications/initialized");
        assert_eq!(requests[2]["method"], "tools/call");
        assert_eq!(requests[2]["params"]["name"], "memory_briefing");
        assert_eq!(requests[2]["params"]["arguments"]["workspace"], "ade-test");
        assert_eq!(requests[2]["params"]["arguments"]["project"], "probe");
        assert_bridge_reaped(&fake);
    }

    #[tokio::test]
    async fn sessoes_sinteticas_preservam_metadados_e_ignoram_campos_futuros() {
        let fake = bridge(briefing_reply(include_str!(
            "fixtures/sessions-briefing-populated.json"
        )));
        let sessions = fake
            .client()
            .sessions("ade-test".into(), "probe".into())
            .await
            .unwrap()
            .data;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent_kind, "codex");
        assert!(!sessions[0].ended);
        assert!(!sessions[0].current);
        assert!(
            !serde_json::to_string(&sessions)
                .unwrap()
                .contains("future_field")
        );
        assert_bridge_reaped(&fake);
    }

    #[tokio::test]
    async fn bridge_recusa_erro_mcp_e_escopo_diferente_e_sempre_recolhe() {
        let mut wrong_scope: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/sessions-briefing.json")).unwrap();
        wrong_scope["scope"]["project"] = serde_json::json!("outro-projeto");
        for reply in [
            serde_json::json!({"jsonrpc":"2.0","id":2,"error":{"message":"secret-token"}}),
            serde_json::json!({"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"secret-token"}]}}),
            briefing_reply(&wrong_scope.to_string()),
            briefing_reply("not json"),
            serde_json::json!({"jsonrpc":"2.0","id":99,"result":{}}),
        ] {
            let fake = bridge(reply);
            let error = fake
                .client()
                .sessions("ade-test".into(), "probe".into())
                .await
                .unwrap_err();
            assert!(!error.contains("secret-token"));
            assert_bridge_reaped(&fake);
        }
    }

    #[tokio::test]
    async fn bridge_limita_prazo_e_nao_inicia_sem_par_de_escopo_valido() {
        let fake = Fake::new("ai-memory 3.3.0", "while :; do :; done");
        let mut client = fake.client();
        for (workspace, project) in [
            ("", "probe"),
            ("ade-test", ""),
            ("ade-test", "bad\nproject"),
        ] {
            assert!(
                client
                    .sessions(workspace.into(), project.into())
                    .await
                    .is_err()
            );
        }
        assert!(!fake.root.join("argv").exists());
        client.timeout = std::time::Duration::ZERO;
        assert!(
            client
                .sessions("ade-test".into(), "probe".into())
                .await
                .is_err()
        );
    }
    #[test]
    fn claude_soma_mcp_preserva_ags_e_remove_settings_ao_encerrar() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let dir = fake.root.join("mcp");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tab-abc.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"ags":{"command":"ags"}},"future":true}"#,
        )
        .unwrap();
        let argv = vec![
            "claude".into(),
            "--mcp-config".into(),
            path.to_string_lossy().into_owned(),
        ];
        let plan = crate::ai_memory::tabs::prepare(
            &fake.program,
            &dir,
            "abc",
            "claude",
            &argv,
            &Default::default(),
            &[],
        )
        .unwrap();
        assert!(!plan.args.contains(&"--mcp-config".to_string()));
        let config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["ags"]["command"], "ags");
        assert_eq!(
            config["mcpServers"]["ai-memory"]["args"],
            serde_json::json!(["mcp-bridge"])
        );
        let settings = plan.settings_file.clone().unwrap();
        let hooks: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(hooks["hooks"].as_object().unwrap().len(), 9);
        assert_eq!(hooks["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 15);
        assert!(
            hooks
                .to_string()
                .contains("hook --event session-start --agent claude-code")
        );
        assert!(!hooks.to_string().contains("--server-url"));
        assert!(!hooks.to_string().contains(".sh"));
        drop(plan);
        assert!(!settings.exists());
        crate::ai_memory::tabs::remove_owned_server(&dir, "abc");
        let config: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(config["mcpServers"].get("ai-memory").is_none());
        assert!(config["mcpServers"].get("ags").is_some());
    }

    #[test]
    fn hooks_globais_ou_do_perfil_e_settings_explicito_nao_sao_duplicados() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let settings = fake.root.join("settings.json");
        let bytes = r#"{"hooks":{"SessionStart":[{"hooks":[{"command":"ai-memory hook --event session-start --agent claude-code"}]}]}}"#;
        fs::write(&settings, bytes).unwrap();
        let plan = crate::ai_memory::tabs::prepare(
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            "claude",
            &[],
            &Default::default(),
            &[settings.clone()],
        )
        .unwrap();
        assert!(plan.settings_file.is_none());
        assert_eq!(fs::read_to_string(settings).unwrap(), bytes);
        let plan = crate::ai_memory::tabs::prepare(
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            "claude",
            &["--settings".into(), "user.json".into()],
            &Default::default(),
            &[],
        )
        .unwrap();
        assert!(plan.settings_file.is_none());
    }

    #[test]
    fn bridges_estaticos_nao_recebem_mcp_automatico_sem_escopo_imposto() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let env = std::collections::HashMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"mcp":{"ags":{"command":["ags"]}},"permission":{"bash":"ask"}}"#.into(),
        )]);
        let before = env.clone();
        let dir = fake.root.join("mcp");
        for agent in ["opencode", "codex"] {
            let plan =
                crate::ai_memory::tabs::prepare(&fake.program, &dir, "abc", agent, &[], &env, &[])
                    .unwrap();
            assert!(plan.args.is_empty());
            assert!(plan.env.is_empty());
            assert!(plan.settings_file.is_none());
            assert!(!dir.exists());
        }
        assert_eq!(env, before);
    }

    #[test]
    fn novo_pty_forca_autowire_desligado_e_versao_e_setting_controlam_injecao() {
        assert!(crate::ai_memory::tabs::enabled(None));
        assert!(!crate::ai_memory::tabs::enabled(Some("false")));
        let mut command = portable_pty::CommandBuilder::new("fake");
        command.env("AI_MEMORY_RUN_AUTOWIRE", "true");
        crate::ai_memory::tabs::protect_pty_env(&mut command);
        assert_eq!(
            command.get_env("AI_MEMORY_RUN_AUTOWIRE"),
            Some(std::ffi::OsStr::new("false"))
        );
        let old = Fake::new("ai-memory 3.2.9", "exit 99");
        assert!(!crate::ai_memory::tabs::supported_program(
            &old.program,
            &old.cwd
        ));
        let script = fs::read_to_string(&old.program)
            .unwrap()
            .replace("ai-memory 3.2.9", "ai-memory 3.3.0+build");
        fs::write(&old.program, script).unwrap();
        assert!(crate::ai_memory::tabs::supported_program(
            &old.program,
            &old.cwd
        ));
        let good = Fake::new("ai-memory 3.3.0", "exit 99");
        assert!(crate::ai_memory::tabs::supported_program(
            &good.program,
            &good.cwd
        ));
        assert!(crate::ai_memory::tabs::supported_program(
            &good.program,
            &good.cwd
        ));
        assert_eq!(
            fs::read_to_string(good.root.join("argv")).unwrap(),
            "--version\n"
        );
        assert_eq!(
            crate::ai_memory::tabs::agent_from_program("/opt/claude"),
            Some("claude")
        );
        assert_eq!(crate::ai_memory::tabs::agent_from_program("agy"), None);
        assert_eq!(crate::ai_memory::tabs::agent_from_program("codex"), None);
        assert_eq!(crate::ai_memory::tabs::agent_from_program("opencode"), None);
    }

    #[test]
    fn barrido_preserva_settings_de_aba_viva_e_remove_os_orfaos() {
        let fake = Fake::new("unused", "exit 99");
        let alive = fake.root.join("tab-alive.ai-memory-123.settings.json");
        let dead = fake.root.join("tab-dead.ai-memory-456.settings.json");
        fs::write(&alive, "{}").unwrap();
        fs::write(&dead, "{}").unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tabs(id TEXT); CREATE TABLE tasks(id TEXT); INSERT INTO tabs VALUES ('alive');").unwrap();
        assert_eq!(crate::ipc::mcp::sweep_configs_in(&fake.root, &db), 1);
        assert!(alive.exists());
        assert!(!dead.exists());
    }
}
