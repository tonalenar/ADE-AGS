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
fn quoted_credentials_and_entropy_are_detected_but_evidence_ids_are_safe() {
    assert!(looks_like_secret(r#"{"password": "hunter2"}"#));
    assert!(looks_like_secret("aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgH"));
    assert!(!looks_like_secret("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"));
    assert!(!looks_like_secret("43529552-1fb2-4994-8f51-473f6546eac4"));
}
