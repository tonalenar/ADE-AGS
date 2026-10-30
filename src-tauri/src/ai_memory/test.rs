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
}
