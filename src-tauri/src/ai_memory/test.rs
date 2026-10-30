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
        assert!(!ok.data.sessions_supported);
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
}
