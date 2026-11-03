use super::*;

#[test]
fn bounds_so_aceita_quatro_numeros_positivos() {
    assert_eq!(parse_bounds("0.0 0.0 1470.0 956.0\n"), Some((1470., 956.)));
    for bad in ["", "1 2 3", "0 0 0 10", "0 0 -5 10", "a b c d", "0 0 inf 10", "0 0 nan 1"] {
        assert_eq!(parse_bounds(bad), None, "{bad}");
    }
}

#[test]
fn rolagem_segue_a_mesma_semantica_do_ios_e_ponto_fora_da_foto_nao_existe() {
    assert!(scroll_delta(Some("scroll_up")) < 0, "revelar o que está abaixo = roda para baixo");
    assert!(scroll_delta(Some("scroll_down")) > 0);
    assert_eq!(to_points((0.5, 0.25), 1000., 800.), Some((500., 200.)));
    for p in [(-0.1, 0.5), (0.5, 1.01), (f64::NAN, 0.5)] {
        assert_eq!(to_points(p, 1000., 800.), None, "{p:?}");
    }
}

#[test]
fn a_pergunta_de_consentimento_limita_o_objetivo_e_nao_leva_controles() {
    let goal = format!("abrir o Mail\n\u{7}{}", "x".repeat(900));
    let q = consent_question(&goal, 8);
    assert!(q.contains("abrir o Mail"));
    assert!(!q.contains('\u{7}') && !q.contains("abrir o Mail\n"));
    assert!(q.chars().count() < 800, "{}", q.chars().count());
    assert!(q.contains("8 passos") && q.contains("confirmação"));
}

#[test]
fn cada_pergunta_gera_asked_e_decided_na_auditoria_comum_sem_o_conteudo() {
    let db = std::sync::Arc::new(std::sync::Mutex::new(crate::database::test_db()));
    audit_asked(&db, "c1", "thread:abc", "computer_use:click");
    audit_decided(&db, "c1", Outcome::Rejected, "user");
    // Só a primeira decisão vale.
    audit_decided(&db, "c1", Outcome::AllowedOnce, "user");
    let conn = db.lock().unwrap();
    let (asked, decided) = approval_audit::pair(&conn, Source::Chat, "c1").unwrap();
    let (asked, decided) = (asked.unwrap(), decided.unwrap());
    assert_eq!(asked.tool.as_deref(), Some("computer_use:click"));
    assert_eq!(asked.owner.as_deref(), Some("thread:abc"));
    assert_eq!(decided.outcome.as_deref(), Some("rejected"));
    assert!(!Outcome::parse(decided.outcome.as_deref().unwrap()).unwrap().releases());
}

#[test]
fn o_script_de_entrada_so_conhece_comandos_fechados() {
    for cmd in ["check", "bounds", "click", "scroll", "type"] {
        assert!(INPUT.contains(&format!("case \"{cmd}\"")), "{cmd}");
    }
    assert!(!INPUT.contains("Process()") && !INPUT.contains("NSTask") && !INPUT.contains("URLSession"));
}
