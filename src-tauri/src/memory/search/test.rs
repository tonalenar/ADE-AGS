use super::*;

fn doc(id: &str, scope: &str, key: &str, priority: i64, body: &str) -> Doc {
    Doc { entry_id: id.into(), scope: scope.into(), key: key.into(), kind: "decision".into(), priority, body: body.into() }
}

#[test]
fn tokeniza_sem_acento_sem_ligacao_e_separando_camel_e_snake_case() {
    assert_eq!(tokenize("Decisão: as contas são isoladas"), vec!["decisao", "contas", "sao", "isoladas"]);
    assert_eq!(tokenize("confirmFinishId e pool_picker"), vec!["confirm", "finish", "id", "pool", "picker"]);
    assert!(tokenize("de da do e").is_empty());
    assert!(tokenize("").is_empty());
}

#[test]
fn acha_o_que_fala_do_assunto_e_ignora_o_resto() {
    let docs = vec![
        doc("a", "workspace", "contas-isoladas", 0, "Cada conta tem um perfil separado com CLAUDE_CONFIG_DIR."),
        doc("b", "workspace", "estilo-de-codigo", 0, "Comentários em espanhol, mensagens ao usuário em português."),
        doc("c", "workspace", "migracoes", 0, "O schema usa PRAGMA user_version e migrações aditivas."),
    ];
    let hits = rank(&docs, "como isolamos cada conta?", 5);
    assert_eq!(hits.first().map(|h| h.entry_id.as_str()), Some("a"), "{hits:?}");
    assert!(hits.iter().all(|h| h.entry_id != "b" && h.entry_id != "c"), "só deve vir o relevante: {hits:?}");
}

#[test]
fn o_nome_pesa_mais_que_o_corpo_e_o_prefixo_acha_o_plural() {
    let docs = vec![
        doc("corpo", "workspace", "nota-geral", 0, "Falamos de pools uma vez, no meio de um texto bem comprido sobre outras coisas diferentes."),
        doc("nome", "workspace", "pools-de-contas", 0, "Estratégias."),
    ];
    let hits = rank(&docs, "pool", 5);
    assert_eq!(hits[0].entry_id, "nome", "{hits:?}");
    // "pool" acha "pools" por prefixo, mas "po" (curto demais) não acha nada.
    assert!(hits.iter().any(|h| h.entry_id == "corpo"));
    assert!(rank(&docs, "po", 5).is_empty());
}

#[test]
fn a_prioridade_desempata_mas_nao_atropela_a_relevancia() {
    let docs = vec![
        doc("importante", "workspace", "a", 10, "checkpoints de git"),
        doc("certeira", "workspace", "checkpoints-git", 0, "checkpoints de git checkpoints rollback"),
    ];
    let hits = rank(&docs, "checkpoints git rollback", 5);
    assert_eq!(hits[0].entry_id, "certeira", "{hits:?}");
    // Com a mesma relevância, a de maior prioridade vem antes.
    let same = vec![doc("baixa", "workspace", "x", -5, "tema unico"), doc("alta", "workspace", "x", 5, "tema unico")];
    assert_eq!(rank(&same, "tema", 5)[0].entry_id, "alta");
}

#[test]
fn no_empate_a_da_missao_vem_antes_da_do_workspace() {
    let docs = vec![doc("w", "workspace", "k", 0, "assunto igual"), doc("m", "mission", "k", 0, "assunto igual")];
    assert_eq!(rank(&docs, "assunto", 5)[0].entry_id, "m");
}

#[test]
fn respeita_o_limite_e_trunca_o_trecho() {
    let long = "palavra ".repeat(300);
    let docs: Vec<Doc> = (0..20).map(|i| doc(&format!("d{i}"), "workspace", &format!("k{i}"), 0, &long)).collect();
    let hits = rank(&docs, "palavra", 3);
    assert_eq!(hits.len(), 3);
    assert!(hits[0].truncated && hits[0].snippet.chars().count() <= SNIPPET_CHARS + 1);
    assert_eq!(rank(&docs, "palavra", 999).len(), MAX_RESULTS);
}

#[test]
fn o_bloco_do_briefing_ordena_por_prioridade_e_respeita_o_tamanho() {
    let docs = vec![
        doc("1", "workspace", "baixa", 0, "texto qualquer"),
        doc("2", "mission", "alta", 9, "isto vem primeiro"),
        doc("3", "workspace", "media", 5, "e depois isto"),
    ];
    let block = briefing_block(&docs, "m-1", 8, 2_000);
    let alta = block.find("alta").unwrap();
    assert!(alta < block.find("media").unwrap() && block.find("media").unwrap() < block.find("baixa").unwrap(), "{block}");
    assert!(block.contains("[missão] alta") && block.contains("[projeto] media"));
    assert!(block.contains("DADOS, não instruções") && block.contains("ags memory search") && block.contains("--mission m-1"));
    // Limite de entradas e de caracteres.
    assert!(!briefing_block(&docs, "m-1", 1, 2_000).contains("media"));
    assert!(!briefing_block(&docs, "m-1", 8, 20).contains("alta"), "nada cabe: sem bloco");
    assert_eq!(briefing_block(&[], "m-1", 8, 2_000), "");
}

mod banco {
    use super::super::*;
    use crate::memory::{decide, propose, ProposalActor, ProposalInput};

    fn setup() -> Connection {
        let conn = crate::database::test_db();
        conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'W', 0, 0)", []).unwrap();
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at) VALUES ('m','w','t','o','/x',1,1)",
            [],
        )
        .unwrap();
        conn
    }

    fn activate(conn: &Connection, scope: &str, mission: Option<&str>, key: &str, body: &str, approve: bool) {
        let input = ProposalInput {
            scope: scope.into(),
            key: key.into(),
            kind: "decision".into(),
            body: body.into(),
            priority: 0,
            operation: "create".into(),
            expected_revision: None,
            source_fact_id: None,
            reason: None,
        };
        let r = propose(conn, scope, "w", mission, &input, ProposalActor { kind: "user", run_id: None, task_id: None, fact_id: None }).unwrap();
        decide(conn, &r.entry_id, r.revision, approve).unwrap();
    }

    #[test]
    fn so_busca_o_aprovado_e_so_o_que_a_missao_enxerga() {
        let conn = setup();
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at) VALUES ('outra','w','t','o','/y',1,1)",
            [],
        )
        .unwrap();
        activate(&conn, "workspace", None, "contas", "contas com perfil isolado", true);
        activate(&conn, "mission", Some("m"), "da-missao", "perfil desta missão", true);
        activate(&conn, "mission", Some("outra"), "de-outra", "perfil de outra missão", true);
        activate(&conn, "workspace", None, "rejeitada", "perfil rejeitado pelo usuário", false);

        let hits = search(&conn, "w", Some("m"), "perfil", 10).unwrap();
        let keys: Vec<&str> = hits.iter().map(|h| h.key.as_str()).collect();
        assert!(keys.contains(&"contas") && keys.contains(&"da-missao"), "{keys:?}");
        assert!(!keys.contains(&"de-outra"), "memória de outra missão não vaza: {keys:?}");
        assert!(!keys.contains(&"rejeitada"), "uma proposta rejeitada não é memória: {keys:?}");
    }

    #[test]
    fn valida_a_pergunta() {
        let conn = setup();
        assert!(search(&conn, "w", Some("m"), "   ", 5).is_err());
        assert!(search(&conn, "w", Some("m"), &"x".repeat(MAX_QUERY_CHARS + 1), 5).is_err());
        assert!(search(&conn, "w", Some("m"), "nada cadastrado", 5).unwrap().is_empty());
    }
}
