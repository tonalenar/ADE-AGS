use super::*;

#[test]
fn o_par_asked_decided_referencia_o_pedido_sem_copiar_os_argumentos() {
    let conn = crate::database::test_db();
    let asked_id = asked(&conn, Source::Fleet, "call-1", "task-1", "Bash", 10).unwrap();
    assert!(decided(&conn, Source::Fleet, "call-1", Outcome::AllowedOnce, None, "user", 11).unwrap());

    let (a, d) = pair(&conn, Source::Fleet, "call-1").unwrap();
    let (a, d) = (a.unwrap(), d.unwrap());
    assert_eq!(a.id, asked_id);
    assert_ne!(d.id, a.id, "cada evento tem id próprio");
    assert_eq!(d.asked_id.as_deref(), Some(asked_id.as_str()));
    assert_eq!((d.call_id.as_str(), d.owner.as_deref()), ("call-1", Some("task-1")));
    assert_eq!(a.tool.as_deref(), Some("Bash"));
    assert_eq!(d.outcome.as_deref(), Some("allowed-once"));
    // A tabela não tem onde guardar o comando: só o nome da ferramenta.
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('approval_events')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!cols.iter().any(|c| c.contains("input") || c.contains("args") || c.contains("detail")), "{cols:?}");
}

#[test]
fn vale_a_primeira_decisao() {
    let conn = crate::database::test_db();
    asked(&conn, Source::Chat, "r1", "thread-1", "command", 1).unwrap();
    assert!(decided(&conn, Source::Chat, "r1", Outcome::Rejected, None, "person", 2).unwrap());
    assert!(!decided(&conn, Source::Chat, "r1", Outcome::AllowedOnce, None, "rule:x", 3).unwrap());
    let (_, d) = pair(&conn, Source::Chat, "r1").unwrap();
    assert_eq!(d.unwrap().outcome.as_deref(), Some("rejected"));
}

#[test]
fn sem_asked_nao_ha_decided_e_o_asked_repetido_e_o_mesmo() {
    let conn = crate::database::test_db();
    // Uma pergunta do chat não é aprovação: nunca teve `asked`.
    assert!(!decided(&conn, Source::Chat, "pergunta", Outcome::AllowedOnce, None, "person", 1).unwrap());
    let a = asked(&conn, Source::Chat, "r2", "t", "command", 1).unwrap();
    let b = asked(&conn, Source::Chat, "r2", "t", "command", 2).unwrap();
    assert_eq!(a, b);
    // O mesmo id de pedido em outra origem é outro pedido.
    assert_ne!(asked(&conn, Source::Fleet, "r2", "t", "Bash", 3).unwrap(), a);
}

#[test]
fn o_resultado_e_fechado_e_so_allowed_once_libera() {
    let all = [Outcome::AllowedOnce, Outcome::Rejected, Outcome::Cancelled, Outcome::Unavailable];
    assert_eq!(all.iter().filter(|o| o.releases()).collect::<Vec<_>>(), [&Outcome::AllowedOnce]);
    for o in all {
        assert_eq!(Outcome::parse(o.as_str()), Some(o));
    }
    assert_eq!(Outcome::parse("allowed"), None);
    let conn = crate::database::test_db();
    asked(&conn, Source::Fleet, "c", "t", "Bash", 1).unwrap();
    let bad = conn.execute(
        "INSERT INTO approval_events (id, phase, source, call_id, outcome, at) VALUES ('x', 'decided', 'fleet', 'c2', 'allowed', 1)",
        [],
    );
    assert!(bad.is_err(), "o CHECK recusa um resultado fora do vocabulário");
}

#[test]
fn as_escolhas_do_chat_viram_o_vocabulario_comum() {
    assert_eq!(outcome_of_choice("allow"), (Outcome::AllowedOnce, None));
    assert_eq!(outcome_of_choice("allowSession"), (Outcome::AllowedOnce, Some("session")));
    assert_eq!(outcome_of_choice("deny"), (Outcome::Rejected, None));
    assert_eq!(outcome_of_choice("decline"), (Outcome::Rejected, None));
    assert_eq!(outcome_of_choice("cancel"), (Outcome::Cancelled, None));
    assert_eq!(outcome_of_choice("resolved"), (Outcome::Cancelled, None));
    // Qualquer coisa desconhecida falha fechada.
    assert_eq!(outcome_of_choice("sim, claro"), (Outcome::Rejected, None));
}

#[test]
fn a_migracao_roda_duas_vezes() {
    let conn = crate::database::test_db();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap();
}
