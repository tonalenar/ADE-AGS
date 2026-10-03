use super::*;

fn new_span(kind: &str, actor: &str, start: i64, end: i64) -> NewSpan {
    NewSpan { kind: kind.into(), actor: actor.into(), target: String::new(), started_ms: start, ended_ms: end, detail: String::new() }
}

fn span(id: i64, kind: &str, start: i64, end: i64) -> Span {
    Span { id, kind: kind.into(), actor: "x".into(), target: String::new(), started_ms: start, ended_ms: end, detail: String::new() }
}

#[test]
fn rechaza_tipos_desconhecidos_e_relogios_invertidos() {
    assert!(validate(&new_span("boot", "A", 1_000, 2_000)).is_ok());
    assert!(validate(&new_span("café", "A", 1_000, 2_000)).unwrap_err().contains("desconhecido"));
    assert!(validate(&new_span("turn", "A", 2_000, 1_000)).is_err());
    assert!(validate(&new_span("turn", "A", 0, 1_000)).is_err());
    assert!(validate(&new_span("turn", "A", 1, 1 + 25 * 60 * 60 * 1000)).is_err());
}

#[test]
fn o_resumo_agrupa_por_tipo_e_acha_a_etapa_mais_lenta() {
    let spans = vec![
        span(1, "boot", 1_000, 4_000),
        span(2, "boot", 1_000, 6_000),
        span(3, "turn", 6_000, 66_000),
        span(4, "peer_ask", 10_000, 40_000),
    ];
    let s = summarize(&spans, 2);
    assert_eq!(s.wall_ms, 65_000);
    let boot = s.by_kind.iter().find(|k| k.kind == "boot").unwrap();
    assert_eq!((boot.count, boot.total_ms, boot.max_ms), (2, 8_000, 5_000));
    // Na ordem fixa dos tipos, e só os que aparecem.
    assert_eq!(s.by_kind.iter().map(|k| k.kind.as_str()).collect::<Vec<_>>(), vec!["boot", "turn", "peer_ask"]);
    assert_eq!(s.slowest.iter().map(|x| x.id).collect::<Vec<_>>(), vec![3, 4]);
}

#[test]
fn sem_tempos_o_resumo_e_vazio() {
    let s = summarize(&[], 3);
    assert_eq!(s.wall_ms, 0);
    assert!(s.by_kind.is_empty() && s.slowest.is_empty());
}

#[test]
fn grava_e_lista_na_ordem_do_inicio_e_respeita_o_limite() {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'W', 0, 0)", []).unwrap();
    conn.execute(
        "INSERT INTO missions (id, workspace_id, title, objective, cwd, created_at, updated_at) VALUES ('m','w','t','o','/x',1,1)",
        [],
    )
    .unwrap();
    add(&conn, "m", &new_span("turn", "Backend", 5_000, 9_000)).unwrap();
    add(&conn, "m", &new_span("boot", "Backend", 1_000, 4_000)).unwrap();
    let all = list(&conn, "m").unwrap();
    assert_eq!(all.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), vec!["boot", "turn"]);
    assert_eq!(all[0].duration_ms(), 3_000);
    // Uma missão que não existe não deixa tempos órfãos: a FK recusa.
    assert!(add(&conn, "nao-existe", &new_span("boot", "A", 1_000, 2_000)).is_err());
}
