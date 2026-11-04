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

#[test]
fn confirmacao_leva_o_dono_e_a_foto_e_o_texto_nao_vaza_none() {
    let p = ask_payload("q", &[ALLOW, DENY], "tab-1", 60, Some(json!({"kind": "computer_use"})));
    assert_eq!(p["owner"], json!({"kind": "tab", "id": "tab-1"}), "sem dono o diálogo diz «un agente»");
    assert_eq!(p["review"]["kind"], "computer_use");
    assert!(ask_payload("q", &[ALLOW, DENY], "t", 60, None)["review"].is_null());

    let sem_ponto = confirm_question("no seu Mac", "Rolar para baixo", "/f.png", None);
    assert!(!sem_ponto.contains("None") && !sem_ponto.contains("Ponto"), "{sem_ponto}");
    let com_ponto = confirm_question("no seu Mac", "x", "/f.png", Some((0.4711, 0.84)));
    assert!(com_ponto.contains("47% da largura, 84% da altura"), "{com_ponto}");

    let review = review("ios", "Tocar em «Geral»", std::path::Path::new("/nao/existe.png"), Some((0.5, 0.25)));
    assert!(review["image"].is_null(), "foto ilegível cai no texto, sem derrubar a pergunta");
    assert_eq!(review["point"], json!([0.5, 0.25]));
}

#[test]
fn gesto_diz_para_onde_vai() {
    let scroll = |t: &str| Action { operation: Operation::Scroll, target: Some(t.into()) };
    assert_eq!(describe(&scroll("swipe_left"), "", 0, "Tocar"), "Deslizar para a esquerda");
    assert_eq!(describe(&scroll("home"), "", 0, "Tocar"), "Ir para a tela inicial");
    assert_eq!(describe(&scroll("scroll_up"), "", 0, "Tocar"), "Rolar para baixo");
    let click = Action { operation: Operation::Click, target: Some("screen".into()) };
    assert_eq!(describe(&click, "Geral", 0, "Clicar"), "Clicar em «Geral»");
}
