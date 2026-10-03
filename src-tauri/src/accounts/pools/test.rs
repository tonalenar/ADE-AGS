use super::*;

fn pool(name: &str, members: &[Option<&str>], strategy: Strategy) -> Pool {
    Pool {
        id: format!("id-{name}"),
        name: name.into(),
        agent_id: "claude-code".into(),
        members: members.iter().map(|m| m.map(String::from)).collect(),
        strategy,
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
    assert!(find(&[], "x").unwrap_err().contains("ccode pool create"));
}

#[test]
fn el_archivo_conserva_la_estrategia_con_su_forma() {
    let p = pool("Trabajo", &[None, Some("a")], Strategy::RoundRobin);
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains("\"round_robin\"") && json.contains("agentId"), "{json}");
    assert_eq!(serde_json::from_str::<Pool>(&json).unwrap(), p);
    // Un guardado viejo sin estrategia sigue entendiéndose.
    let old = r#"{"id":"1","name":"X","agentId":"codex","members":[null,"a"]}"#;
    assert_eq!(serde_json::from_str::<Pool>(old).unwrap().strategy, Strategy::LeastUsed);
}
