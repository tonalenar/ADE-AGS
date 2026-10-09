use super::*;

#[test]
fn reconhece_credenciais_sem_confundir_texto_normal() {
    assert!(looks_like_secret("use a chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz para chamar"));
    assert!(looks_like_secret("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(looks_like_secret("AKIAIOSFODNN7EXAMPLE1"));
    assert!(looks_like_secret("-----BEGIN PRIVATE KEY-----"));
    assert!(looks_like_secret("export API_KEY=abc"));
    assert!(looks_like_secret("Authorization: Bearer abc.def"));
    assert!(looks_like_secret("senha: password=hunter2"));
    // Texto de projeto normal passa, inclusive falando DE credenciais sem trazer uma.
    assert!(!looks_like_secret("Cada conta tem perfil isolado; nunca copiar credenciais entre contas."));
    assert!(!looks_like_secret("O prefixo sk- aparece nas chaves da Anthropic, mas aqui não há valor."));
    assert!(!looks_like_secret("rodar tauri dev --no-watch para não reiniciar o app"));
    // Frase de política só passa no detector do usuário. Agente continua rígido.
    for phrase in [
        "senha: mínimo 12 caracteres",
        "senha: minimo 12 caracteres",
        "política de senha: mínimo 12 caracteres, com letra e número",
        "password: use uma senha forte",
        "token: não compartilhe com terceiros",
        "secret: nunca grave segredos na memória do projeto",
    ] {
        assert!(!looks_like_user_secret(phrase), "{phrase}");
        assert!(looks_like_secret(phrase), "{phrase}");
    }
    assert!(!looks_like_secret("A senha deve ter no mínimo 12 caracteres"));
    assert!(!looks_like_user_secret("A senha deve ter no mínimo 12 caracteres"));
    assert!(!looks_like_secret("O token de acesso expira em 12 horas"));
    assert!(!looks_like_user_secret("O token de acesso expira em 12 horas"));
    // Valor seguido de prosa continua credencial para o agente.
    assert!(looks_like_secret("senha: primavera do servidor"));
    assert!(looks_like_secret("senha: Açaí2024! do servidor"));
    assert!(!looks_like_user_secret("senha: primavera do servidor"));
    assert!(!looks_like_user_secret("senha: Açaí2024! do servidor"));
    assert!(looks_like_secret("password: hunter2"));
    assert!(looks_like_secret(&format!("{}{}", "sk_", "live_abcdefghijklmnopqrstuvwxyz")));
    assert!(looks_like_secret("glpat-abcdefghijklmnopqrstuvwxyz"));
    assert!(looks_like_secret("npm_abcdefghijklmnopqrstuvwxyz"));
    assert!(looks_like_secret("xoxb-abcdefghijklmnopqrstuvwxyz"));
    assert!(looks_like_secret("xoxp-abcdefghijklmnopqrstuvwxyz"));
    assert!(looks_like_secret("https://admin:s3cret@example.com/db"));
    assert!(looks_like_secret("AKIAIOSFODNN7EXAMPLE"));
}

fn setup() -> Connection {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'W', 0, 0)", []).unwrap();
    for id in ["m", "outra"] {
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at) VALUES (?1,'w','t','o','/x',1,1)",
            [id],
        )
        .unwrap();
    }
    conn
}

fn proposal<'a>(scope: &'a str, key: &'a str, body: &'a str, priority: i64) -> AgentProposal<'a> {
    AgentProposal { mission_id: "m", scope, key, kind: "finding", body, priority, author: Author::Worker, author_name: "Backend" }
}

fn status_of(conn: &Connection, entry_id: &str) -> (String, String) {
    conn.query_row(
        "SELECT e.status, (SELECT status FROM memory_revisions r WHERE r.entry_id = e.id ORDER BY revision DESC LIMIT 1) FROM memory_entries e WHERE e.id = ?1",
        [entry_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

#[test]
fn a_proposta_de_um_agente_fica_pendente_e_nunca_aprovada() {
    let conn = setup();
    let result = propose_for_mission(&conn, &proposal("workspace", "padrao-de-teste", "Os testes ficam em tests/ ao lado do módulo.", 2)).unwrap();
    // A proposta existe, mas a revisão está pendente: só o usuário a aprova.
    assert_eq!(status_of(&conn, &result.entry_id).1, "proposed");
    let active: i64 = conn.query_row("SELECT COUNT(*) FROM memory_revisions WHERE status = 'approved'", [], |r| r.get(0)).unwrap();
    assert_eq!(active, 0);
    // E o motivo diz de onde veio.
    let reason: String = conn.query_row("SELECT reason FROM memory_revisions WHERE entry_id = ?1", [&result.entry_id], |r| r.get(0)).unwrap();
    assert!(reason.contains("Backend") && reason.contains("missão m"), "{reason}");
    // Quem propôs fica registrado como integrante.
    let actor: String = conn.query_row("SELECT actor_kind FROM memory_revisions WHERE entry_id = ?1", [&result.entry_id], |r| r.get(0)).unwrap();
    assert_eq!(actor, "worker");
}

#[test]
fn a_prioridade_pedida_por_um_agente_tem_teto() {
    let conn = setup();
    let result = propose_for_mission(&conn, &proposal("mission", "k1", "texto qualquer", 10)).unwrap();
    let p: i64 = conn.query_row("SELECT priority FROM memory_revisions WHERE entry_id = ?1", [&result.entry_id], |r| r.get(0)).unwrap();
    assert_eq!(p, MAX_AGENT_PRIORITY);
    let result = propose_for_mission(&conn, &proposal("mission", "k2", "outro texto", -7)).unwrap();
    let p: i64 = conn.query_row("SELECT priority FROM memory_revisions WHERE entry_id = ?1", [&result.entry_id], |r| r.get(0)).unwrap();
    assert_eq!(p, 0);
}

#[test]
fn recusa_segredo_escopo_desconhecido_e_missao_inexistente() {
    let conn = setup();
    let err = propose_for_mission(&conn, &proposal("workspace", "k", "a chave é sk-ant-api03-abcdefghijklmnopqrstuvwxyz", 1)).unwrap_err();
    assert!(err.contains("credencial"), "{err}");
    assert!(propose_for_mission(&conn, &proposal("global", "k", "texto", 1)).unwrap_err().contains("escopo"));
    let mut lost = proposal("workspace", "k", "texto", 1);
    lost.mission_id = "nao-existe";
    assert!(propose_for_mission(&conn, &lost).unwrap_err().contains("Não existe a missão"));
    // Nada foi gravado pelas tentativas recusadas.
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn a_memoria_da_missao_so_pertence_a_ela() {
    let conn = setup();
    propose_for_mission(&conn, &proposal("mission", "so-da-m", "vale só para esta missão", 1)).unwrap();
    let owner: Option<String> = conn.query_row("SELECT mission_id FROM memory_entries WHERE key = 'so-da-m'", [], |r| r.get(0)).unwrap();
    assert_eq!(owner.as_deref(), Some("m"));
    let w: Option<String> = {
        propose_for_mission(&conn, &proposal("workspace", "do-projeto", "vale para o projeto", 1)).unwrap();
        conn.query_row("SELECT mission_id FROM memory_entries WHERE key = 'do-projeto'", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(w, None, "uma memória do workspace não leva o id da missão");
}

#[test]
fn o_orquestrador_se_reconhece_pelo_nome_da_aba() {
    assert_eq!(author_of("Orquestrador"), Author::Lead);
    assert_eq!(author_of("  orquestrador "), Author::Lead);
    assert_eq!(author_of("Backend"), Author::Worker);
    assert_eq!(author_of("agente"), Author::Worker);
    assert_eq!(author_of(""), Author::Worker);
}

#[test]
fn worker_lead_e_swarm_recusam_senha_seguida_de_prosa_e_o_usuario_guarda_politica() {
    let conn = setup();
    let secrets = ["senha: primavera do servidor", "senha: Açaí2024! do servidor"];
    for (i, secret) in secrets.iter().enumerate() {
        let worker_key = format!("worker-{i}");
        let err = propose_for_mission(&conn, &proposal("workspace", &worker_key, secret, 1)).unwrap_err();
        assert!(err.contains("credencial"), "{err}");
        let lead_key = format!("lead-{i}");
        let mut lead = proposal("workspace", &lead_key, secret, 1);
        lead.author = Author::Lead;
        lead.author_name = "Orquestrador";
        let err = propose_for_mission(&conn, &lead).unwrap_err();
        assert!(err.contains("credencial"), "{err}");
        let forced = crate::memory::ProposalInput {
            scope: "workspace".into(),
            key: format!("forcado-{i}"),
            kind: "note".into(),
            body: (*secret).into(),
            priority: 0,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
            acknowledge_secret: true,
        };
        for kind in ["worker", "lead"] {
            let err = crate::memory::propose(
                &conn,
                "workspace",
                "w",
                None,
                &forced,
                crate::memory::ProposalActor { kind, run_id: None, task_id: None, fact_id: None },
            )
            .unwrap_err();
            assert_eq!(err, "memory cannot contain credentials", "{kind} {secret}");
        }
        let err = crate::memory::lifecycle::swarm_write(&conn, "w", "m", "note", secret).unwrap_err();
        assert!(err.contains("credentials"), "{err}");
    }
    for (i, phrase) in [
        "senha: mínimo 12 caracteres",
        "senha: minimo 12 caracteres",
        "password: use uma senha forte",
        "token: não compartilhe com terceiros",
    ]
    .iter()
    .enumerate()
    {
        let input = crate::memory::ProposalInput {
            scope: "workspace".into(),
            key: format!("politica-{i}"),
            kind: "note".into(),
            body: (*phrase).into(),
            priority: 0,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
            acknowledge_secret: false,
        };
        let saved = crate::memory::propose(
            &conn,
            "workspace",
            "w",
            None,
            &input,
            crate::memory::ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None },
        )
        .unwrap();
        assert_eq!(saved.status, "proposed", "{phrase}");
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 4, "só as frases de política do usuário foram gravadas");
}

#[test]
fn quoted_credentials_and_entropy_are_detected_but_evidence_ids_are_safe() {
    assert!(looks_like_secret(r#"{"password": "hunter2"}"#));
    assert!(looks_like_secret("aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgH"));
    assert!(!looks_like_secret("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"));
    assert!(!looks_like_secret("43529552-1fb2-4994-8f51-473f6546eac4"));
}

#[test]
fn a_mesma_chave_ja_aprovada_vira_proposta_de_correcao() {
    let conn = setup();
    let first = propose_for_mission(&conn, &proposal("workspace", "porta-do-dev", "O dev server usa a porta 1420.", 1)).unwrap();
    crate::memory::decide(&conn, &first.entry_id, first.revision, true).unwrap();
    // Antes: erro "a chave já existe". Agora: uma revisão nova, pendente, sobre a atual.
    let fix = propose_for_mission(&conn, &proposal("workspace", "porta-do-dev", "O dev server usa a porta 1421.", 1)).unwrap();
    assert_eq!(fix.entry_id, first.entry_id);
    assert!(fix.revision > first.revision);
    let (operation, status): (String, String) = conn
        .query_row("SELECT operation, status FROM memory_revisions WHERE entry_id=?1 AND revision=?2", rusqlite::params![fix.entry_id, fix.revision], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((operation.as_str(), status.as_str()), ("update", "proposed"));
}
