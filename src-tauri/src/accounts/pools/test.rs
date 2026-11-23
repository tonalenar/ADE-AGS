use super::*;

fn pool(name: &str, members: &[Option<&str>], strategy: Strategy) -> Pool {
    Pool {
        id: format!("id-{name}"),
        name: name.into(),
        agent_id: "claude-code".into(),
        members: members.iter().map(|m| m.map(String::from)).collect(),
        strategy,
        failover: false,
        paused: false,
    }
}

fn accounts() -> Vec<(String, String)> {
    vec![("a".into(), "claude-code".into()), ("b".into(), "claude-code".into()), ("c".into(), "codex".into())]
}

#[test]
fn pool_ref_solo_reconoce_el_prefijo() {
    assert_eq!(pool_ref("pool:Trabajo"), Some("Trabajo"));
    assert_eq!(pool_ref("  POOL: Dos palabras "), Some("Dos palabras"));
    assert_eq!(pool_ref("pool:"), None);
    assert_eq!(pool_ref("trabajo"), None);
    assert_eq!(pool_ref("pools:x"), None);
}

#[test]
fn las_estrategias_se_leen_con_guion_o_guion_bajo() {
    assert_eq!(Strategy::parse("least-used").unwrap(), Strategy::LeastUsed);
    assert_eq!(Strategy::parse("ROUND_ROBIN").unwrap(), Strategy::RoundRobin);
    assert_eq!(Strategy::parse("sticky").unwrap(), Strategy::Sticky);
    assert!(Strategy::parse("al-azar").unwrap_err().contains("não existe"));
    assert_eq!(Strategy::default(), Strategy::LeastUsed);
}

#[test]
fn un_pool_valido_necesita_dos_cuentas_distintas_de_la_misma_tui() {
    let ok = validate(&[], "  Trabajo ", "claude-code", &[Some("a".into()), Some("b".into())], &accounts());
    assert_eq!(ok.unwrap(), "Trabajo");
    // La cuenta del sistema vale para cualquier TUI.
    assert!(validate(&[], "P", "claude-code", &[None, Some("a".into())], &accounts()).is_ok());
    assert!(validate(&[], "P", "claude-code", &[Some("a".into())], &accounts()).unwrap_err().contains("pelo menos 2"));
    assert!(validate(&[], "P", "claude-code", &[Some("a".into()), Some("a".into())], &accounts()).unwrap_err().contains("duas vezes"));
    assert!(validate(&[], "P", "claude-code", &[Some("a".into()), Some("c".into())], &accounts()).unwrap_err().contains("uma TUI só"));
    assert!(validate(&[], "P", "claude-code", &[Some("a".into()), Some("zz".into())], &accounts()).unwrap_err().contains("não existe"));
}

#[test]
fn el_nombre_se_limpia_y_no_se_repite() {
    assert!(clean_name("   ").is_err());
    assert!(clean_name("a:b").is_err());
    assert!(clean_name(&"x".repeat(31)).is_err());
    let existing = vec![pool("Trabajo", &[None, Some("a")], Strategy::Sticky)];
    assert!(validate(&existing, "trabajo", "claude-code", &[Some("a".into()), Some("b".into())], &accounts()).unwrap_err().contains("Já existe"));
}

#[test]
fn se_encuentra_por_nombre_o_id_y_el_error_lista_los_que_hay() {
    let pools = vec![pool("Trabajo", &[None, Some("a")], Strategy::Sticky), pool("Casa", &[None, Some("b")], Strategy::LeastUsed)];
    assert_eq!(find(&pools, "casa").unwrap().name, "Casa");
    assert_eq!(find(&pools, "id-Trabajo").unwrap().name, "Trabajo");
    let err = find(&pools, "nada").unwrap_err();
    assert!(err.contains("Trabajo") && err.contains("Casa"), "{err}");
    assert!(find(&[], "x").unwrap_err().contains("ags pool create"));
}

#[test]
fn el_archivo_conserva_la_estrategia_con_su_forma() {
    let p = pool("Trabajo", &[None, Some("a")], Strategy::RoundRobin);
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains("\"round_robin\"") && json.contains("agentId"), "{json}");
    assert_eq!(serde_json::from_str::<Pool>(&json).unwrap(), p);
    // Un guardado viejo sin estrategia sigue entendiéndose.
    let old = r#"{"id":"1","name":"X","agentId":"codex","members":[null,"a"]}"#;
    let parsed = serde_json::from_str::<Pool>(old).unwrap();
    assert_eq!(parsed.strategy, Strategy::LeastUsed);
    assert!(!parsed.paused, "o default de paused na struct é false");
}

fn test_db_conn() -> crate::database::DbConnection {
    std::sync::Arc::new(std::sync::Mutex::new(crate::database::test_db()))
}

#[test]
fn pool_update_preserva_id_e_altera_nome_membros_ordem_e_estrategia() {
    let db = test_db_conn();
    let original = Pool {
        id: "pool-fixo-1".into(),
        name: "Trabalho".into(),
        agent_id: "claude-code".into(),
        members: vec![None, Some("a".into())],
        strategy: Strategy::LeastUsed,
        failover: true,
        paused: false,
    };
    save(&db, &[original]).unwrap();

    let updated = update(
        &db,
        "pool-fixo-1",
        "  Diário ",
        vec![Some("b".into()), None, Some("a".into())],
        Strategy::Sticky,
        &accounts(),
    )
    .unwrap();

    assert_eq!(updated.id, "pool-fixo-1");
    assert_eq!(updated.name, "Diário");
    assert_eq!(updated.agent_id, "claude-code");
    assert_eq!(updated.members, vec![Some("b".into()), None, Some("a".into())]);
    assert_eq!(updated.strategy, Strategy::Sticky);
    assert!(!updated.paused);

    // Manter o mesmo nome ao editar apenas ordem/regra é válido.
    let same_name = update(
        &db,
        "pool-fixo-1",
        "diário",
        vec![None, Some("b".into())],
        Strategy::RoundRobin,
        &accounts(),
    )
    .unwrap();
    assert_eq!(same_name.id, "pool-fixo-1");
    assert_eq!(same_name.strategy, Strategy::RoundRobin);

    // Renomear para nome de outro pool existente falha.
    let mut all = load(&db);
    all.push(pool("Outro", &[None, Some("a")], Strategy::Sticky));
    save(&db, &all).unwrap();
    assert!(update(&db, "pool-fixo-1", "outro", vec![None, Some("a".into())], Strategy::Sticky, &accounts())
        .unwrap_err()
        .contains("Já existe"));
}

#[test]
fn set_paused_alterna_pausa_sem_perder_dados_e_spec_preview_nao_avanca_cursor() {
    let db = test_db_conn();
    let p = Pool {
        id: "rr-1".into(),
        name: "Rodizio".into(),
        agent_id: "claude-code".into(),
        members: vec![None, Some("a".into()), Some("b".into())],
        strategy: Strategy::RoundRobin,
        failover: true,
        paused: false,
    };
    save(&db, &[p]).unwrap();

    let paused = set_paused(&db, "rr-1", true).unwrap();
    assert!(paused.paused);
    assert!(!paused.failover);
    assert_eq!(load(&db)[0].paused, true);

    let resumed = set_paused(&db, "rr-1", false).unwrap();
    assert!(!resumed.paused);
    assert!(resumed.failover);

    // Preview não altera o cursor de round_robin.
    let s1 = spec_preview(&db, "rr-1").unwrap();
    let s2 = spec_preview(&db, "rr-1").unwrap();
    assert_eq!(s1.start, 0);
    assert_eq!(s2.start, 0);

    // spec_for avança o cursor normalmente.
    let _ = spec_for(&db, "rr-1").unwrap();
    let s3 = spec_preview(&db, "rr-1").unwrap();
    assert_eq!(s3.start, 1);
}

#[test]
fn migracao_aditiva_respeita_failover_legado_e_modo_salvo_com_padrao_perguntar() {
    let db = test_db_conn();

    // Sem valor salvo, o padrão do modo unificado é "Perguntar" (Ask).
    assert_eq!(load_mode(&db), PoolMode::Ask);
    assert_eq!(PoolMode::parse_setting(None), PoolMode::Ask);
    assert_eq!(PoolMode::parse_setting(Some("")), PoolMode::Ask);

    // Valor salvo é respeitado.
    save_mode(&db, PoolMode::Off).unwrap();
    assert_eq!(load_mode(&db), PoolMode::Off);
    save_mode(&db, PoolMode::Auto).unwrap();
    assert_eq!(load_mode(&db), PoolMode::Auto);
    save_mode(&db, PoolMode::Ask).unwrap();
    assert_eq!(load_mode(&db), PoolMode::Ask);

    // Valor desconhecido falha fechado em Off.
    assert_eq!(PoolMode::parse_setting(Some("invalido")), PoolMode::Off);

    // Migração aditiva de pools legados (JSON sem o campo `paused`):
    // - `failover: false` (ou ausente) -> `paused: true` (continua sem troca automática nas tarefas)
    // - `failover: true` -> `paused: false` (segue ativo)
    // - pool com `paused` explícito -> respeita `paused`
    let legacy_json = r#"[
        {"id":"old-off","name":"SemFailover","agentId":"claude-code","members":[null,"a"],"strategy":"sticky","failover":false},
        {"id":"old-missing","name":"SemCampo","agentId":"claude-code","members":[null,"a"],"strategy":"least_used"},
        {"id":"old-on","name":"ComFailover","agentId":"claude-code","members":[null,"a"],"strategy":"least_used","failover":true},
        {"id":"new-active","name":"Novo","agentId":"claude-code","members":[null,"a"],"strategy":"least_used","failover":false,"paused":false}
    ]"#;
    crate::database::set_setting(&db, "accounts.pools", legacy_json).unwrap();

    let loaded = load(&db);
    assert_eq!(loaded.len(), 4);
    assert!(loaded[0].paused, "legado com failover=false deve carregar pausado");
    assert!(loaded[1].paused, "legado sem campo failover deve carregar pausado");
    assert!(!loaded[2].paused, "legado com failover=true continua sem pausa");
    assert!(!loaded[3].paused, "pool com paused=false explícito é respeitado");
}

#[test]
fn remove_account_from_pools_limpa_referencia_e_lista_afetados() {
    let db = test_db_conn();
    save(
        &db,
        &[
            pool("Trabalho", &[None, Some("a"), Some("b")], Strategy::RoundRobin),
            pool("Pessoal", &[None, Some("b")], Strategy::Sticky),
        ],
    )
    .unwrap();

    let affected = remove_account_from_pools(&db, "a").unwrap();
    assert_eq!(affected, vec!["Trabalho".to_string()]);
    let reloaded = load(&db);
    assert_eq!(reloaded[0].members, vec![None, Some("b".into())]);
    assert_eq!(reloaded[1].members, vec![None, Some("b".into())]);

    // Conta inexistente não altera nada.
    assert!(remove_account_from_pools(&db, "nao-existe").unwrap().is_empty());
}

#[test]
fn with_pool_pick_so_avanca_cursor_no_sucesso_e_sem_modulo_prematuro() {
    let db = test_db_conn();
    save(
        &db,
        &[pool("Rodizio", &[None, Some("a"), Some("apagada")], Strategy::RoundRobin)],
    )
    .unwrap();

    // Falha na escolha não avança o cursor (M-6).
    let err: Result<(), String> = with_pool_pick(&db, "Rodizio", |_| Err("sem conta livre".into()));
    assert!(err.is_err());
    assert_eq!(spec_preview(&db, "Rodizio").unwrap().start, 0);

    // Sucesso avança monotonicamente (0 -> 1 -> 2 -> 3 -> 4), sem módulo prematuro em members.len()=3.
    // Assim, com 2 contas existentes (None e "a"), start % 2 alterna 0,1,0,1 sem viés!
    let mut starts = Vec::new();
    for _ in 0..4 {
        let s = with_pool_pick(&db, "Rodizio", |spec| Ok(spec.start)).unwrap();
        starts.push(s);
    }
    assert_eq!(starts, vec![0, 1, 2, 3]);
    assert_eq!(starts.iter().map(|s| s % 2).collect::<Vec<_>>(), vec![0, 1, 0, 1]);
}

#[test]
fn with_pool_pick_serializa_concorrencia_sem_repetir_start() {
    let db = test_db_conn();
    save(
        &db,
        &[pool("Paralelo", &[None, Some("a"), Some("b")], Strategy::RoundRobin)],
    )
    .unwrap();

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let db = db.clone();
            std::thread::spawn(move || with_pool_pick(&db, "Paralelo", |spec| Ok(spec.start)).unwrap())
        })
        .collect();
    let mut got: Vec<usize> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    got.sort_unstable();
    assert_eq!(got, vec![0, 1, 2, 3, 4, 5, 6, 7]);
}

#[test]
fn empty_pool_error_gera_payload_estruturado_e_remocao_da_ultima_conta_preserva_pool_vazio() {
    let db = test_db_conn();
    save(
        &db,
        &[pool("Solo", &[Some("a")], Strategy::Sticky)],
    )
    .unwrap();

    // Remover a última conta deixa o pool com 0 membros sem apagá-lo automaticamente.
    let affected = remove_account_from_pools(&db, "a").unwrap();
    assert_eq!(affected, vec!["Solo".to_string()]);
    let reloaded = load(&db);
    assert_eq!(reloaded.len(), 1);
    assert!(reloaded[0].members.is_empty());

    // O erro de pool vazio é um payload JSON estruturado traduzível.
    let raw = empty_pool_error("Solo");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("payload JSON válido");
    assert_eq!(parsed["code"], EMPTY_POOL_CODE);
    assert_eq!(parsed["pool"], "Solo");
}

fn pool_de(agent: &str, name: &str, members: &[Option<&str>], paused: bool) -> Pool {
    Pool { agent_id: agent.into(), paused, ..pool(name, members, Strategy::LeastUsed) }
}

#[test]
fn pool_implicito_da_conta_fixa_membro_de_pool_do_mesmo_agente() {
    let pools = [pool_de("claude-code", "Trabalho", &[Some("a"), Some("b")], false)];
    assert_eq!(implicit_pool(&pools, "claude-code", &Some("a".into())).map(|p| p.name.as_str()), Some("Trabalho"));
    assert!(implicit_pool(&pools, "codex", &Some("a".into())).is_none(), "outro agente");
    assert!(implicit_pool(&pools, "claude-code", &Some("z".into())).is_none(), "conta fora do pool");
}

#[test]
fn pool_implicito_ignora_pausado_e_pool_de_uma_conta_so() {
    let pools = [
        pool_de("claude-code", "Pausado", &[Some("a"), Some("b")], true),
        pool_de("claude-code", "Solo", &[Some("a")], false),
    ];
    assert!(implicit_pool(&pools, "claude-code", &Some("a".into())).is_none());
}

#[test]
fn pool_implicito_com_varios_pools_escolhe_por_nome_e_id_sempre_o_mesmo() {
    let a = pool_de("claude-code", "Zeta", &[Some("a"), Some("b")], false);
    let b = pool_de("claude-code", "alfa", &[Some("a"), Some("b")], false);
    let c = Pool { id: "id-0".into(), ..pool_de("claude-code", "Alfa", &[Some("a"), Some("b")], false) };
    for pools in [[a.clone(), b.clone(), c.clone()], [c.clone(), b.clone(), a.clone()], [b.clone(), a.clone(), c.clone()]] {
        assert_eq!(implicit_pool(&pools, "claude-code", &Some("a".into())).map(|p| p.id.as_str()), Some("id-0"));
    }
}

#[test]
fn pool_implicito_aceita_a_conta_principal_como_membro() {
    let pools = [pool_de("claude-code", "P", &[None, Some("b")], false)];
    assert_eq!(implicit_pool(&pools, "claude-code", &None).map(|p| p.name.as_str()), Some("P"));
}

#[test]
fn pool_padrao_do_agente_so_com_pool_ativo_de_duas_contas() {
    let pools = [
        pool_de("antigravity", "Pausado", &[Some("a"), Some("b")], true),
        pool_de("antigravity", "Solo", &[Some("a")], false),
        pool_de("antigravity", "Gemini", &[Some("a"), Some("b"), Some("c")], false),
        pool_de("codex", "Outro", &[Some("x"), Some("y")], false),
    ];
    assert_eq!(default_pool_for_agent(&pools, "antigravity").map(|p| p.name.as_str()), Some("Gemini"));
    assert_eq!(default_pool_for_agent(&pools, "codex").map(|p| p.name.as_str()), Some("Outro"));
    assert!(default_pool_for_agent(&pools, "claude-code").is_none());
}
