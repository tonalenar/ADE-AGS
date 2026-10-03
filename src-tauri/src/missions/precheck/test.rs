use super::*;

const OBJECTIVE: &str = "Melhoria pequena no próprio ADE AGS (só frontend): em src/features/missions/MissionsSection.tsx, \
o botão 'Concluir' de uma missão sem run conclui direto. Faça pedir confirmação com dois cliques, \
como o botão de apagar pool em src/features/accounts/PoolsSection.tsx. Use confirmFinishId e a chave missions.sidebar.finishConfirm.";

#[test]
fn extrai_os_caminhos_citados_sem_repetir_nem_pegar_urls() {
    // Dependências e artefatos não são o produto.
    assert!(extract_paths("rode node_modules/typescript/bin/tsc e olhe target/debug/app.exe").is_empty());
    let paths = extract_paths(OBJECTIVE);
    assert_eq!(paths, vec!["src/features/missions/MissionsSection.tsx", "src/features/accounts/PoolsSection.tsx"]);
    assert!(extract_paths("veja https://exemplo.com/a/b e nada mais").is_empty());
    assert_eq!(extract_paths("edite `src/a.rs` e src/a.rs de novo"), vec!["src/a.rs"]);
    // Pontuação final não entra no caminho.
    assert_eq!(extract_paths("abra Cargo.toml."), vec!["Cargo.toml"]);
}

#[test]
fn extrai_so_termos_que_nomeiam_algo() {
    let terms = extract_terms(OBJECTIVE);
    assert!(terms.contains(&"Concluir".to_string()), "{terms:?}");
    assert!(terms.contains(&"confirmFinishId".to_string()), "{terms:?}");
    // Palavras comuns e o apóstrofo do meio de uma palavra não viram termo.
    assert!(!terms.iter().any(|t| t == "pequena" || t == "melhoria"), "{terms:?}");
    assert!(extract_terms("o cão d'água corre").is_empty());
    // Nunca passa do limite.
    let many = (0..30).map(|i| format!("campo_numero_{i}")).collect::<Vec<_>>().join(" ");
    assert_eq!(extract_terms(&many).len(), MAX_TERMS);
}

#[test]
fn a_parecenca_vai_de_zero_a_um() {
    assert!(similarity("confirmar ao concluir missão", "confirmar ao concluir missão") > 0.99);
    assert!(similarity("confirmar ao concluir missão", "prévia do terminal afastado") < 0.2);
    assert_eq!(similarity("", "algo qualquer"), 0.0);
}

fn conn_with_missions() -> Connection {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'W', 0, 0)", []).unwrap();
    let insert = |id: &str, title: &str, objective: &str, cwd: &str, status: &str| {
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, created_at, updated_at) VALUES (?1,'w',?2,?3,?4,?5,1,1)",
            rusqlite::params![id, title, objective, cwd, status],
        )
        .unwrap();
    };
    insert("antiga-feita", "Melhoria: confirmar ao concluir missão", OBJECTIVE, "/p", "done");
    insert("outra-pasta", "Melhoria: confirmar ao concluir missão", OBJECTIVE, "/outra", "done");
    insert("sem-relacao", "Prévia do terminal", "Filtrar caracteres de animação do Codex na prévia", "/p", "done");
    insert("rascunho", "Melhoria: confirmar ao concluir missão", OBJECTIVE, "/p", "draft");
    insert("atual", "Melhoria: confirmar ao concluir missão", OBJECTIVE, "/p", "draft");
    conn
}

#[test]
fn acha_missoes_parecidas_da_mesma_pasta_sem_contar_rascunhos_nem_a_si_mesma() {
    let conn = conn_with_missions();
    let found = similar_missions(&conn, "atual", "/p", OBJECTIVE);
    assert_eq!(found.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["antiga-feita"]);
    assert!(found[0].score > 0.9);
}

#[test]
fn o_briefing_diz_o_que_ja_existe_e_manda_conferir_antes_de_convocar() {
    let check = Precheck {
        paths: vec![PathFinding { path: "src/a.tsx".into(), exists: true, recent_commits: vec!["57a9cce 2026-10-02 feat: confirmar".into()] }],
        terms: vec![TermFinding { term: "Concluir".into(), commits: vec![], files: vec!["src/a.tsx".into()] }],
        similar_missions: vec![SimilarMission { id: "antiga-feita-123".into(), title: "Confirmar ao concluir".into(), status: "done".into(), score: 0.93 }],
    };
    assert!(check.has_leads());
    let text = render(&check);
    assert!(text.contains("57a9cce"), "{text}");
    assert!(text.contains("aparece em src/a.tsx"), "{text}");
    assert!(text.contains("missão parecida (93%, done)"), "{text}");
    assert!(text.contains("ANTES de convocar a equipe"), "{text}");
}

#[test]
fn sem_indicios_o_briefing_diz_para_seguir_o_plano_e_sem_nada_fica_vazio() {
    let only_missing = Precheck { paths: vec![PathFinding { path: "src/novo.ts".into(), exists: false, recent_commits: vec![] }], ..Default::default() };
    assert!(!only_missing.has_leads());
    assert!(render(&only_missing).contains("não existe neste projeto"));
    assert!(render(&only_missing).contains("siga com o plano normal"));
    assert_eq!(render(&Precheck::default()), "");
}

#[test]
fn o_briefing_tem_tamanho_limitado() {
    let many = Precheck {
        terms: (0..8)
            .map(|i| TermFinding { term: format!("termo{i}"), commits: vec!["x".repeat(500)], files: vec!["y".repeat(200)] })
            .collect(),
        ..Default::default()
    };
    assert!(render(&many).chars().count() <= MAX_RENDER + 1);
}

fn sh(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn num_repositorio_de_verdade_acha_o_arquivo_o_commit_e_o_termo() {
    let dir = std::env::temp_dir().join(format!("ags-precheck-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    sh(&dir, &["init", "-q"]);
    sh(&dir, &["config", "user.email", "t@t"]);
    sh(&dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("src/Botao.tsx"), "const confirmFinishId = 1;\n").unwrap();
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "feat: confirmar ao concluir (confirmFinishId)"]);

    // Un test que menciona el término no prueba que la funcionalidad exista: se ignora.
    std::fs::create_dir_all(dir.join("src/tests")).unwrap();
    std::fs::write(dir.join("src/tests/botao.test.ts"), "confirmFinishId
").unwrap();
    // Y un término que está en demasiados archivos no distingue nada.
    for i in 0..7 {
        std::fs::write(dir.join(format!("src/comum{i}.ts")), "palavracomum
").unwrap();
    }
    sh(&dir, &["add", "-A"]);
    sh(&dir, &["commit", "-q", "-m", "test: mais arquivos"]);

    let conn = crate::database::test_db();
    let check = run(&conn, "x", dir.to_str().unwrap(), "Ajuste src/Botao.tsx e src/Falta.tsx usando confirmFinishId e `palavracomum`");

    let botao = check.paths.iter().find(|p| p.path == "src/Botao.tsx").unwrap();
    assert!(botao.exists && botao.recent_commits.iter().any(|c| c.contains("confirmar ao concluir")), "{botao:?}");
    assert!(!check.paths.iter().find(|p| p.path == "src/Falta.tsx").unwrap().exists);
    let term = check.terms.iter().find(|t| t.term == "confirmFinishId").unwrap();
    assert_eq!(term.files, vec!["src/Botao.tsx".to_string()], "el archivo de prueba no cuenta");
    assert!(check.terms.iter().all(|t| t.term != "palavracomum"), "un término en 7 archivos se descarta");
    assert!(!term.commits.is_empty());
    assert!(check.has_leads());
    let _ = std::fs::remove_dir_all(&dir);
}
