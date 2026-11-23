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

#[test]
fn caminho_de_gravacao_separa_missoes_e_preserva_workspace() {
    use sha2::{Digest, Sha256};
    let tags = Vec::new();
    let workspace = super::commands::prepare_agent_write("mesma chave", None, "note", "corpo", &tags, None).unwrap();
    let mission_a = super::commands::prepare_agent_write("mesma chave", Some("1234567890-abcdef"), "note", "corpo", &tags, None).unwrap();
    let mission_b = super::commands::prepare_agent_write("mesma chave", Some("abcdef0123456789"), "note", "corpo", &tags, None).unwrap();

    let digest = Sha256::digest("mesma chave");
    let suffix = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    assert_eq!(workspace.path, format!("ade-ags/mesma-chave-{suffix}.md"));
    assert!(mission_a.path.starts_with("ade-ags/mission-1234567890-abcdef-"));
    assert!(mission_b.path.starts_with("ade-ags/mission-abcdef0123456789-"));
    assert_ne!(mission_a.path, mission_b.path);
    assert_ne!(workspace.path, mission_a.path);
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
                "#!/bin/sh\nROOT='{}'\nexport ROOT\n[ \"$AI_MEMORY_RUN_AUTOWIRE\" = false ] || exit 70\n[ \"$AI_MEMORY_EMBEDDING_PROVIDER\" = none ] || exit 71\n[ \"$AI_MEMORY_HOST_CWD\" -ef \"$PWD\" ] || exit 72\n[ -z \"$AI_MEMORY_SCOPE_CWD\" ] || exit 73\nprintf '%s\\n' \"$@\" >> '{}'/argv\nif [ \"$1\" = --version ]; then printf '%s\\n' '{}'; exit 0; fi\n{}\n",
                root.display(),
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
        fake.fixture("search-populated.json");
        assert_eq!(
            client.read::<Vec<SearchHit>>(Read::SearchScoped {
                query: "consulta".into(),
                workspace: "ade-test".into(),
                project: "probe".into(),
            }).unwrap().data[0].path,
            "notes/probe.md"
        );
        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.contains("--workspace=ade-test"));
        assert!(argv.contains("--project=probe"));
        fake.fixture("read-page-populated.json");
        assert_eq!(
            client.read::<Page>(Read::PageScoped {
                path: "notes/probe.md".into(),
                workspace: "ade-test".into(),
                project: "probe".into(),
            }).unwrap().data.path,
            "notes/probe.md"
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
        let ags = fake.root.join("ags");
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
            &ags,
            &fake.program,
            &dir,
            "abc",
            (&fake.cwd, "w", "p"),
            &argv,
            &[],
        )
        .unwrap();
        assert!(!plan.args.contains(&"--mcp-config".to_string()));
        let config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["ags"]["command"], "ags");
        assert_eq!(
            config["mcpServers"]["ai-memory"]["command"],
            ags.to_string_lossy().as_ref()
        );
        assert_eq!(
            config["mcpServers"]["ai-memory"]["args"],
            serde_json::json!([
                "ai-memory-bridge",
                "--cwd",
                fake.cwd.to_string_lossy(),
                "--workspace",
                "w",
                "--project",
                "p"
            ])
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
        let ags = fake.root.join("ags");
        let settings = fake.root.join("settings.json");
        let bytes = r#"{"hooks":{"SessionStart":[{"hooks":[{"command":"ai-memory hook --event session-start --agent claude-code"}]}]}}"#;
        fs::write(&settings, bytes).unwrap();
        let plan = crate::ai_memory::tabs::prepare(
            &ags,
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            (&fake.cwd, "w", "p"),
            &[],
            &[settings.clone()],
        )
        .unwrap();
        assert!(plan.settings_file.is_none());
        assert_eq!(fs::read_to_string(settings).unwrap(), bytes);
        let plan = crate::ai_memory::tabs::prepare(
            &ags,
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            (&fake.cwd, "w", "p"),
            &["--settings".into(), "user.json".into()],
            &[],
        )
        .unwrap();
        assert!(plan.settings_file.is_none());
    }

    #[test]
    fn contexto_ai_memory_filtra_escopo_envelopa_dados_e_respeita_limites() {
        let fake = Fake::new(
            "ai-memory 3.3.0",
            r#"if [ "$1" = search ]; then cat "$ROOT/search.json"; elif [ "$1" = read-page ]; then cat "$ROOT/page.json"; else exit 8; fi"#,
        );
        fs::write(fake.root.join("search.json"), r#"[
          {"path":"notes/ok.md","title":"OK","snippet":"x","rank":1,"workspace":"team","project":"ADE-AGS"},
          {"path":"notes/out.md","title":"OUT","snippet":"x","rank":1,"workspace":"other","project":"ADE-AGS"}
        ]"#).unwrap();
        fs::write(fake.root.join("page.json"), r#"{"path":"notes/ok.md","workspace":"team","project":"ADE-AGS","title":"OK","body":"conteúdo ``` <instrução>","frontmatter":{}}"#).unwrap();

        let context = fake.client().project_context("objetivo", "team", "ADE-AGS").unwrap();

        assert!(context.contains("UNTRUSTED DATA"));
        assert!(context.contains("conteúdo"));
        assert!(context.contains("\\u0060"));
        assert!(context.contains("\\u003c"));
        assert!(!context.contains("notes/out.md"));
        assert!(context.len() <= 6 * 1024);
        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.contains("--workspace=team"));
        assert!(argv.contains("--project=ADE-AGS"));
        assert_eq!(argv.matches("--workspace=team").count(), 2, "busca e leitura da página usam o escopo explícito");
    }

    #[test]
    fn contexto_ai_memory_limita_a_dez_paginas() {
        let fake = Fake::new(
            "ai-memory 3.3.0",
            r#"if [ "$1" = search ]; then cat "$ROOT/search.json"; elif [ "$1" = read-page ]; then cat "$ROOT/page.json"; else exit 8; fi"#,
        );
        let hits = (0..12).map(|i| serde_json::json!({
            "path":"notes/same.md", "title":format!("Página {i}"), "snippet":"x", "rank":i,
            "workspace":"team", "project":"ADE-AGS"
        })).collect::<Vec<_>>();
        fs::write(fake.root.join("search.json"), serde_json::to_vec(&hits).unwrap()).unwrap();
        fs::write(fake.root.join("page.json"), serde_json::to_vec(&serde_json::json!({
            "path":"notes/same.md", "workspace":"team", "project":"ADE-AGS", "title":"OK", "body":"curto", "frontmatter":{}
        })).unwrap()).unwrap();

        let context = fake.client().project_context("objetivo", "team", "ADE-AGS").unwrap();

        assert_eq!(context.matches("\"path\":\"notes/same.md\"").count(), 10);
    }

    #[test]
    fn contexto_ai_memory_corta_corpo_multibyte_no_limite_de_seis_kib() {
        let fake = Fake::new(
            "ai-memory 3.3.0",
            r#"if [ "$1" = search ]; then cat "$ROOT/search.json"; elif [ "$1" = read-page ]; then cat "$ROOT/page.json"; else exit 8; fi"#,
        );
        fs::write(fake.root.join("search.json"), r#"[{"path":"notes/large.md","title":"Grande","snippet":"x","rank":1,"workspace":"team","project":"ADE-AGS"}]"#).unwrap();
        fs::write(fake.root.join("page.json"), serde_json::to_vec(&serde_json::json!({
            "path":"notes/large.md", "workspace":"team", "project":"ADE-AGS", "title":"Grande",
            "body":"é".repeat(5000), "frontmatter":{}
        })).unwrap()).unwrap();

        let context = fake.client().project_context("objetivo", "team", "ADE-AGS").unwrap();
        let row = context.lines().find(|line| line.starts_with("- ")).unwrap();
        let page: serde_json::Value = serde_json::from_str(&row[2..]).unwrap();
        let body = page["body"].as_str().unwrap();

        assert!(context.len() <= 6 * 1024);
        assert!(body.len() < "é".repeat(5000).len());
        assert!(body.is_char_boundary(body.len()));
    }

    #[test]
    fn escrita_de_agente_envia_pagina_pelo_client_com_escopo_explicito() {
        let fake = Fake::new("ai-memory 3.3.0", "cat > \"$ROOT/body\"");
        let tags = vec!["ade-ags".to_string()];

        super::super::commands::write_agent_memory_with_scope(
            &fake.client(), "team", "ADE-AGS", "retry-policy", "finding",
            "bounded retries", &tags, Some("the backoff is capped"),
        ).unwrap();

        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.contains("write-page"));
        assert!(argv.contains("--path=ade-ags/retry-policy-"));
        assert!(argv.contains("--title=retry-policy"));
        assert!(argv.contains("--kind=fact"));
        assert!(argv.contains("--tag=ade-ags"));
        assert!(argv.contains("--workspace=team"));
        assert!(argv.contains("--project=ADE-AGS"));
        assert_eq!(fs::read_to_string(fake.root.join("body")).unwrap(), "bounded retries\n\nMotivo: the backoff is capped");
    }

    #[test]
    fn escrita_de_agente_aceita_chave_sem_slug_ascii() {
        let fake = Fake::new("ai-memory 3.3.0", "cat > \"$ROOT/body\"");

        super::super::commands::write_agent_memory_with_scope(
            &fake.client(), "team", "ADE-AGS", "日本語", "note", "conteúdo", &[], None,
        ).unwrap();

        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv.lines().any(|arg| arg.starts_with("--path=ade-ags/memory-")));
    }

    #[test]
    fn escrita_de_agente_recusa_segredos_e_motivos_fora_do_limite() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let secret = super::super::commands::write_agent_memory_with_scope(
            &fake.client(), "team", "ADE-AGS",
            "credential-note",
            "note",
            "password: private-value",
            &[],
            None,
        ).unwrap_err();
        assert!(secret.contains(crate::memory::agent::SECRET_CONFIRMATION_CODE));
        assert!(!secret.contains("private-value"));
        assert!(!fake.root.join("argv").exists(), "a recusa por segredo acontece antes do subprocesso");

        let secret_tag = super::super::commands::write_agent_memory_with_scope(
            &fake.client(), "team", "ADE-AGS",
            "ordinary-note",
            "note",
            "safe body",
            &["token=private-value".into()],
            None,
        ).unwrap_err();
        assert!(secret_tag.contains(crate::memory::agent::SECRET_CONFIRMATION_CODE));
        assert!(!secret_tag.contains("private-value"));
        assert!(!fake.root.join("argv").exists(), "uma tag com segredo também é recusada antes do subprocesso");

        let long_reason = "x".repeat(crate::memory::REASON_MAX_BYTES + 1);
        let reason = super::super::commands::write_agent_memory_with_scope(
            &fake.client(), "team", "ADE-AGS",
            "ordinary-note",
            "note",
            "safe body",
            &[],
            Some(&long_reason),
        ).unwrap_err();
        assert!(reason.contains("até 512 bytes"));
    }

    #[test]
    fn bridges_estaticos_nao_recebem_mcp_automatico_sem_escopo_imposto() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        fs::write(fake.root.join("result.json"), "[]").unwrap();
        let ags = fake.root.join("ags");
        let env = std::collections::HashMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"mcp":{"ags":{"command":["ags"]}},"permission":{"bash":"ask"}}"#.into(),
        )]);
        let before = env.clone();
        let dir = fake.root.join("mcp");
        for agent in ["opencode", "codex"] {
            let new_tab = crate::ai_memory::tabs::prepare_new_tab_with_ags(
                Some(fake.program.clone()),
                Some(ags.clone()),
                "abc",
                agent,
                &dir,
                &fake.root,
                &fake.cwd,
                &[],
                &env,
            );
            assert!(new_tab.plan.args.is_empty());
            assert!(new_tab.plan.env.is_empty());
            assert!(new_tab.plan.settings_file.is_none());
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
        command.env("AI_MEMORY_SCOPE_CWD", "/outro");
        crate::ai_memory::tabs::protect_pty_env(&mut command);
        assert_eq!(
            command.get_env("AI_MEMORY_RUN_AUTOWIRE"),
            Some(std::ffi::OsStr::new("false"))
        );
        assert!(command.get_env("AI_MEMORY_SCOPE_CWD").is_none());
        let mut std_cmd = std::process::Command::new("fake");
        std_cmd.env("AI_MEMORY_RUN_AUTOWIRE", "true");
        std_cmd.env("AI_MEMORY_SCOPE_CWD", "/outro");
        crate::ai_memory::tabs::protect_command_env(&mut std_cmd);
        let std_envs: std::collections::HashMap<_, _> = std_cmd.get_envs().collect();
        assert_eq!(
            std_envs.get(std::ffi::OsStr::new("AI_MEMORY_RUN_AUTOWIRE")),
            Some(&Some(std::ffi::OsStr::new("false")))
        );
        assert_eq!(
            std_envs.get(std::ffi::OsStr::new("AI_MEMORY_SCOPE_CWD")),
            Some(&None)
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
        assert_eq!(crate::ai_memory::tabs::agent_from_program("codex"), Some("codex"));
        assert_eq!(crate::ai_memory::tabs::agent_from_program("opencode"), Some("opencode"));
    }

    #[test]
    fn falha_passageira_da_versao_nao_fica_em_cache() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let marker = fake.root.join("ja-falhou");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then\n  if [ -e '{m}' ]; then echo 'ai-memory 3.3.0'; exit 0; fi\n  : > '{m}'; exit 1\nfi\nexit 99\n",
            m = marker.display()
        );
        fs::write(&fake.program, script).unwrap();
        assert!(!crate::ai_memory::tabs::supported_program(&fake.program, &fake.cwd));
        assert!(
            crate::ai_memory::tabs::supported_program(&fake.program, &fake.cwd),
            "o erro passageiro não pode desligar o ai-memory até reiniciar o app"
        );
    }

    #[test]
    fn leituras_seguidas_checam_a_versao_uma_vez() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let client = fake.client();
        fake.fixture("handoffs-empty.json");
        client.read::<Vec<Handoff>>(Read::Handoffs).unwrap();
        fake.fixture("recent-empty.json");
        client.read::<Vec<RecentPage>>(Read::Recent).unwrap();
        fake.fixture("projects.json");
        client.read::<Vec<Project>>(Read::Projects).unwrap();
        let argv = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert_eq!(argv.matches("--version\n").count(), 1, "{argv}");
    }

    #[test]
    fn hooks_do_usuario_so_em_parte_ganham_so_os_eventos_que_faltam() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let ags = fake.root.join("ags");
        let settings = fake.root.join("settings.json");
        fs::write(&settings, r#"{"hooks":{"Stop":[{"hooks":[{"command":"ai-memory hook --event stop --agent claude-code"}]}]}}"#).unwrap();
        assert!(!crate::ai_memory::tabs::configured_hooks(std::slice::from_ref(&settings)));
        let plan = crate::ai_memory::tabs::prepare(
            &ags,
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            (&fake.cwd, "w", "p"),
            &[],
            std::slice::from_ref(&settings),
        )
        .unwrap();
        let file = plan.settings_file.clone().expect("falta SessionStart: o arquivo da aba completa os hooks");
        let hooks: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let events = hooks["hooks"].as_object().unwrap();
        assert!(events.contains_key("SessionStart"));
        assert!(!events.contains_key("Stop"), "o Stop do usuário não pode ser duplicado");
        assert_eq!(events.len(), 8);
    }

    #[test]
    fn config_do_usuario_invalida_continua_sem_hooks_da_aba() {
        let fake = Fake::new("ai-memory 3.3.0", "exit 99");
        let ags = fake.root.join("ags");
        let settings = fake.root.join("settings.json");
        fs::write(&settings, "invalid").unwrap();
        let plan = crate::ai_memory::tabs::prepare(
            &ags,
            &fake.program,
            &fake.root.join("mcp"),
            "abc",
            (&fake.cwd, "w", "p"),
            &[],
            &[settings],
        )
        .unwrap();
        assert!(plan.settings_file.is_none());
    }

    #[test]
    fn pagina_ausente_e_reconhecida_sem_depender_de_maiusculas_ou_do_prefixo() {
        use crate::ai_memory::client::is_missing_page;
        assert!(is_missing_page("Error: GET /admin/read-page: server returned 404 Not Found: {}"));
        assert!(is_missing_page("error: http status 404 not found"));
        assert!(!is_missing_page("connection refused"));
        assert!(!is_missing_page("500 Internal Server Error"));
        assert!(!is_missing_page(""));
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
    #[test]
    fn continuidade_preserva_args_nativos_e_injeta_hooks_uma_vez() {
        let fake = Fake::new("unused", "exit 99");
        let ags = fake.root.join("ags");
        let native = vec!["claude".into(), "--model".into(), "modelo-do-perfil".into()];
        let plan = crate::ai_memory::tabs::prepare(
            &ags,
            &fake.program,
            &fake.root,
            "continuity",
            (&fake.cwd, "w", "p"),
            &native,
            &[],
        )
        .unwrap();
        let exe = fake.root.join("claude nativo");
        let args =
            crate::ai_memory::continuation::argv(&fake.program, &exe, &native, &plan.args).unwrap();
        assert_eq!(
            &args[1..6],
            &[
                "run",
                "--no-autowire",
                "--no-exit-prompt",
                "--require-server",
                "--executable"
            ]
        );
        assert_eq!(args[6], exe.to_string_lossy());
        assert_eq!(&args[7..10], &["claude", "--model", "modelo-do-perfil"]);
        for flag in ["--settings", "--mcp-config"] {
            assert_eq!(args.iter().filter(|a| a.as_str() == flag).count(), 1);
        }
        assert!(
            !args
                .iter()
                .any(|a| ["accept", "--yolo", "--fresh", "--session-id"].contains(&a.as_str()))
        );
        let settings = plan.settings_file.as_ref().unwrap();
        let data: serde_json::Value = serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
        assert!(
            data["hooks"]["SessionStart"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("hook --event session-start")
        );
        drop(plan);
    }

    #[test]
    fn continuidade_recusa_destinos_sem_escopo_e_nao_confunde_config_invalida_com_hook() {
        let fake = Fake::new("unused", "exit 99");
        for name in ["codex", "opencode", "bash"] {
            assert!(
                crate::ai_memory::continuation::argv(&fake.program, &fake.program, &[name.into()], &[])
                    .is_err()
            );
        }
        let settings = fake.root.join("settings.json");
        fs::write(&settings, "invalid").unwrap();
        assert!(!crate::ai_memory::tabs::configured_hooks(
            std::slice::from_ref(&settings)
        ));
        fs::write(&settings, r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"ai-memory hook --event session-start"}]}]}}"#).unwrap();
        assert!(crate::ai_memory::tabs::configured_hooks(&[settings]));
    }

    #[test]
    fn claude_sem_escopo_ou_com_projeto_reservado_nao_recebe_mcp_direto_nem_hooks() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let dir = fake.root.join("mcp");
        let home = fake.root.join("home");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        let config_path = dir.join("tab-abc.json");
        fs::write(&config_path, r#"{"mcpServers":{"ags":{"command":"ags"}}}"#).unwrap();
        let argv = vec!["claude".into(), "--mcp-config".into(), config_path.to_string_lossy().into_owned()];

        // 1) Sem marcador e sem projeto único em list-projects.
        fs::write(fake.root.join("result.json"), "[]").unwrap();
        let empty = crate::ai_memory::tabs::prepare_new_tab_with(
            Some(fake.program.clone()),
            "abc",
            "claude",
            &dir,
            &home,
            &fake.cwd,
            &argv,
            &Default::default(),
        );
        assert!(empty.plan.args.is_empty(), "{:?}", empty.plan.args);
        assert!(empty.plan.settings_file.is_none());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("ai-memory").is_none(), "{saved}");
        assert!(saved["mcpServers"].get("ags").is_some());

        // 2) Marcador apontando para projeto reservado (_global), mesmo com match em list-projects.
        fs::write(
            fake.root.join("result.json"),
            r#"[{"workspace_name":"default","project_name":"pasta da aba","page_count":0}]"#,
        )
        .unwrap();
        fs::write(fake.cwd.join(".ai-memory.toml"), "workspace = \"default\"\nproject = \"_global\"\n").unwrap();
        let ags = fake.root.join("ags");
        let reserved = crate::ai_memory::tabs::prepare_new_tab_with_ags(
            Some(fake.program.clone()),
            Some(ags.clone()),
            "abc",
            "claude",
            &dir,
            &home,
            &fake.cwd,
            &argv,
            &Default::default(),
        );
        assert!(reserved.plan.args.is_empty(), "{:?}", reserved.plan.args);
        assert!(reserved.plan.settings_file.is_none());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("ai-memory").is_none(), "{saved}");

        // 3) Com escopo válido, sem binário `ags` não cai no `ai-memory mcp-bridge` direto.
        fs::write(fake.cwd.join(".ai-memory.toml"), "workspace = \"team\"\nproject = \"repo\"\n").unwrap();
        let without_ags = crate::ai_memory::tabs::prepare_new_tab_with_ags(
            Some(fake.program.clone()),
            None,
            "abc",
            "claude",
            &dir,
            &home,
            &fake.cwd,
            &argv,
            &Default::default(),
        );
        assert!(without_ags.plan.args.is_empty(), "{:?}", without_ags.plan.args);
        assert!(without_ags.plan.settings_file.is_none());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("ai-memory").is_none(), "{saved}");
    }

    #[test]
    fn claude_com_escopo_usa_proxy_ags_e_mesmo_projeto_do_codex_e_opencode() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let dir = fake.root.join("mcp");
        let home = fake.root.join("home");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        let ags = fake.root.join("ags");
        fs::write(&ags, "").unwrap();
        let config_path = dir.join("tab-abc.json");
        fs::write(&config_path, r#"{"mcpServers":{"ags":{"command":"ags"}}}"#).unwrap();
        let argv = vec!["claude".into(), "--mcp-config".into(), config_path.to_string_lossy().into_owned()];

        // 1) Marcador explícito.
        fs::write(fake.cwd.join(".ai-memory.toml"), "workspace = \"team\"\nproject = \"meu-proj\"\n").unwrap();
        let by_marker = crate::ai_memory::tabs::prepare_new_tab_with_ags(
            Some(fake.program.clone()),
            Some(ags.clone()),
            "abc",
            "claude",
            &dir,
            &home,
            &fake.cwd,
            &argv,
            &Default::default(),
        );
        assert!(by_marker.plan.settings_file.is_some());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"]["ai-memory"]["command"], ags.to_string_lossy().as_ref());
        assert_eq!(
            saved["mcpServers"]["ai-memory"]["args"],
            serde_json::json!([
                "ai-memory-bridge",
                "--cwd",
                fake.cwd.to_string_lossy(),
                "--workspace",
                "team",
                "--project",
                "meu-proj"
            ])
        );

        // 2) Fallback por projeto único de `list-projects --json`.
        fs::remove_file(fake.cwd.join(".ai-memory.toml")).unwrap();
        fs::write(
            fake.root.join("result.json"),
            r#"[{"workspace_name":"ws-auto","project_name":"pasta da aba","page_count":3}]"#,
        )
        .unwrap();
        let by_unique = crate::ai_memory::tabs::prepare_new_tab_with_ags(
            Some(fake.program.clone()),
            Some(ags.clone()),
            "abc",
            "claude",
            &dir,
            &home,
            &fake.cwd,
            &argv,
            &Default::default(),
        );
        assert!(by_unique.plan.settings_file.is_some());
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(
            saved["mcpServers"]["ai-memory"]["args"],
            serde_json::json!([
                "ai-memory-bridge",
                "--cwd",
                fake.cwd.to_string_lossy(),
                "--workspace",
                "ws-auto",
                "--project",
                "pasta da aba"
            ])
        );
    }

    #[test]
    fn recent_page_e_page_trazem_campos_de_vencimento() {
        let recent: Vec<RecentPage> = serde_json::from_value(serde_json::json!([
            {
                "path": "notes/expiring.md",
                "title": "Expiring",
                "snippet": "vai vencer",
                "updated_at": "2026-11-20T00:00:00Z",
                "expired": true,
                "expires_at": "2026-11-25T00:00:00Z",
                "pinned": false
            },
            {
                "path": "notes/legacy.md",
                "title": "Legacy",
                "snippet": "sem campos extras",
                "updated_at": "2026-11-20T00:00:00Z"
            }
        ]))
        .unwrap();
        assert!(recent[0].expired);
        assert_eq!(recent[0].expires_at.as_deref(), Some("2026-11-25T00:00:00Z"));
        assert!(!recent[0].pinned);
        assert!(!recent[1].expired);
        assert!(recent[1].expires_at.is_none());
        assert!(!recent[1].pinned);

        let page: Page = serde_json::from_value(serde_json::json!({
            "path": "notes/expiring.md",
            "body": "corpo",
            "frontmatter": {},
            "expired": false,
            "expires_at": "2026-11-25T00:00:00Z",
            "pinned": true
        }))
        .unwrap();
        assert_eq!(page.expires_at.as_deref(), Some("2026-11-25T00:00:00Z"));
        assert!(page.pinned);
    }

    #[test]
    fn probe_detecta_forget_sweep_e_desliga_preservando_config_toml() {
        let fake = Fake::new("ai-memory 3.3.0", "cat \"$(dirname \"$0\")/result.json\"");
        let data_dir = fake.root.join("aim-data");
        fs::create_dir_all(&data_dir).unwrap();
        let status_json = serde_json::json!({
            "version": "3.3.0",
            "data_dir": data_dir.to_string_lossy(),
            "counts": { "pages_latest": 1, "pages_all": 1, "sessions": 0, "observations": 0 }
        });
        fs::write(
            fake.root.join("result.json"),
            serde_json::to_vec(&status_json).unwrap(),
        )
        .unwrap();

        // Sem config.toml: padrão do ai-memory é ligado (24 h).
        let probe_default = fake.client().probe().unwrap();
        let sweep = probe_default.data.forget_sweep.unwrap();
        assert!(sweep.enabled);
        assert!(sweep.interval_secs.is_none());
        assert!(!sweep.config_exists);

        // Com config.toml existente contendo comentários e outras seções.
        let cfg_path = data_dir.join("config.toml");
        let original = "# comentário do usuário\n[server]\nbind = \"127.0.0.1:49374\"\n\n[maintenance]\n# comentário interno\nforget_sweep_interval_secs = 86400\nother_opt = true\n";
        fs::write(&cfg_path, original).unwrap();

        let probe_on = fake.client().probe().unwrap();
        let sweep_on = probe_on.data.forget_sweep.unwrap();
        assert!(sweep_on.enabled);
        assert_eq!(sweep_on.interval_secs, Some(86400));
        assert!(sweep_on.config_exists);

        // Desligar explicitamente deve alterar apenas forget_sweep_interval_secs para 0 e preservar o resto.
        let disabled = fake.client().disable_forget_sweep().unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.interval_secs, Some(0));
        let updated_raw = fs::read_to_string(&cfg_path).unwrap();
        assert!(updated_raw.contains("# comentário do usuário"));
        assert!(updated_raw.contains("bind = \"127.0.0.1:49374\""));
        assert!(updated_raw.contains("# comentário interno"));
        assert!(updated_raw.contains("other_opt = true"));
        assert!(updated_raw.contains("forget_sweep_interval_secs = 0"));

        let probe_off = fake.client().probe().unwrap();
        let sweep_off = probe_off.data.forget_sweep.unwrap();
        assert!(!sweep_off.enabled);
        assert_eq!(sweep_off.interval_secs, Some(0));
    }

    #[test]
    fn renovar_e_fixar_pagina_chamam_write_page_com_corpo_no_stdin() {
        let script = r#"
case "$1" in
  read-page)
    cat "$(dirname "$0")/page.json"
    ;;
  write-page)
    cat > "$(dirname "$0")/written-body.txt"
    printf '{"ok":true}\n'
    ;;
  *)
    exit 42
    ;;
esac
"#;
        let fake = Fake::new("ai-memory 3.3.0", script);
        let page_json = serde_json::json!({
            "path": "notes/regra.md",
            "workspace": "default",
            "project": "ADE-AGS",
            "title": "Regra importante",
            "body": "Corpo preservado da memória.",
            "frontmatter": {
                "title": "Regra importante",
                "tier": "semantic",
                "kind": "rule",
                "tags": ["arquitetura"]
            },
            "expired": true,
            "pinned": false
        });
        fs::write(
            fake.root.join("page.json"),
            serde_json::to_vec(&page_json).unwrap(),
        )
        .unwrap();

        let renewed = fake.client().renew_page("notes/regra.md", false).unwrap();
        assert_eq!(renewed.data.path, "notes/regra.md");
        assert_eq!(
            fs::read_to_string(fake.root.join("written-body.txt")).unwrap(),
            "Corpo preservado da memória."
        );
        let argv_renew = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv_renew.contains("write-page"));
        assert!(argv_renew.contains("--path=notes/regra.md"));
        // Sem o escopo explícito o ai-memory deduz o projeto pela pasta do processo e a página
        // renovada poderia mudar de projeto.
        assert!(argv_renew.contains("--workspace=default"));
        assert!(argv_renew.contains("--project=ADE-AGS"));
        assert!(!argv_renew.contains("--pinned"));

        let _pinned = fake.client().renew_page("notes/regra.md", true).unwrap();
        let argv_pin = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv_pin.contains("--pinned"));

        // Entrada de perfil: `applies-to` e `enforced-by` sobrevivem à renovação.
        let profile_json = serde_json::json!({
            "path": "profile/estilo.md",
            "workspace": "default",
            "project": "ADE-AGS",
            "body": "Prefira funções pequenas.",
            "frontmatter": {
                "tier": "procedural",
                "applies_to": ["rust", "typescript"],
                "enforced_by": "pre-push hook"
            }
        });
        fs::write(fake.root.join("page.json"), serde_json::to_vec(&profile_json).unwrap()).unwrap();
        fake.client().renew_page("profile/estilo.md", false).unwrap();
        let argv_profile = fs::read_to_string(fake.root.join("argv")).unwrap();
        assert!(argv_profile.contains("--applies-to=rust"));
        assert!(argv_profile.contains("--applies-to=typescript"));
        assert!(argv_profile.contains("--enforced-by=pre-push hook"));
        assert!(argv_profile.contains("--tier=procedural"));
    }
}
