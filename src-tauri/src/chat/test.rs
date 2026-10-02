use super::*;

fn say(c: &mut Conversation, thread: &str, kind: Kind, text: &str, at: i64) -> Message {
    push(c, thread, kind, text.into(), at)
}

#[test]
fn los_siete_hilos_se_dicen_en_ingles_o_en_portugues() {
    assert_eq!(parse_thread("blue").unwrap(), "blue");
    assert_eq!(parse_thread(" Azul ").unwrap(), "blue");
    assert_eq!(parse_thread("VERDE").unwrap(), "green");
    assert_eq!(parse_thread("laranja").unwrap(), "orange");
    for t in THREADS {
        assert_eq!(parse_thread(t).unwrap(), t);
    }
    let err = parse_thread("marrom").unwrap_err();
    assert!(err.contains("blue") && err.contains("green"), "{err}");
}

#[test]
fn el_texto_se_limpia_y_se_limita() {
    assert_eq!(clean_text("  oi\r\n\r\ntudo bem \x1b[31m ").unwrap(), "oi\n\ntudo bem [31m");
    assert_eq!(clean_text("a\tb").unwrap(), "a\tb");
    assert!(clean_text(" \n\x07 ").is_err());
    assert!(clean_text(&"a".repeat(MAX_TEXT + 1)).unwrap_err().contains("nota"));
    assert!(clean_text(&"a".repeat(MAX_TEXT)).is_ok());
}

#[test]
fn hablar_el_usuario_fija_el_hilo_actual_y_hablar_el_agente_no_lo_cambia() {
    let mut c = Conversation::default();
    say(&mut c, "green", Kind::User, "oi", 1);
    assert_eq!(c.current_thread, "green");
    say(&mut c, "green", Kind::Say, "olá", 2);
    say(&mut c, "red", Kind::Progress, "ainda", 3);
    assert_eq!(c.current_thread, "green", "un aviso del agente no cambia dónde contesta");
}

#[test]
fn el_agente_contesta_en_el_hilo_del_ultimo_mensaje_salvo_que_diga_otro() {
    let mut c = Conversation::default();
    assert_eq!(reply_thread(&c, None).unwrap(), "blue", "sin nadie que haya hablado, el primero");
    say(&mut c, "purple", Kind::User, "oi", 1);
    assert_eq!(reply_thread(&c, None).unwrap(), "purple");
    assert_eq!(reply_thread(&c, Some("")).unwrap(), "purple");
    assert_eq!(reply_thread(&c, Some("verde")).unwrap(), "green");
    assert!(reply_thread(&c, Some("marrom")).is_err());
}

#[test]
fn se_guardan_como_mucho_los_ultimos_mensajes() {
    let mut c = Conversation::default();
    for i in 0..(MAX_MESSAGES + 25) {
        say(&mut c, "blue", Kind::User, &format!("m{i}"), i as i64);
    }
    assert_eq!(c.messages.len(), MAX_MESSAGES);
    assert_eq!(c.messages[0].text, "m25");
    assert_eq!(c.messages.last().unwrap().text, format!("m{}", MAX_MESSAGES + 24));
}

#[test]
fn recordar_devuelve_los_ultimos_turnos_de_un_solo_hilo() {
    let mut c = Conversation::default();
    say(&mut c, "blue", Kind::User, "u1", 1);
    say(&mut c, "blue", Kind::Say, "a1", 2);
    say(&mut c, "red", Kind::User, "otro hilo", 3);
    say(&mut c, "blue", Kind::User, "u2", 4);
    say(&mut c, "blue", Kind::Progress, "p2", 5);
    say(&mut c, "blue", Kind::Say, "a2", 6);

    let texts = |turns| recall(&c, "blue", turns).iter().map(|m| m.text.clone()).collect::<Vec<_>>();
    assert_eq!(texts(Some(1)), vec!["u2", "p2", "a2"]);
    assert_eq!(texts(Some(2)), vec!["u1", "a1", "u2", "p2", "a2"]);
    assert_eq!(texts(Some(9)), vec!["u1", "a1", "u2", "p2", "a2"], "pedir más de los que hay devuelve todos");
    assert_eq!(texts(None), vec!["u1", "a1", "u2", "p2", "a2"]);
    assert_eq!(recall(&c, "red", Some(1)).len(), 1);
    assert!(recall(&c, "green", Some(3)).is_empty());
}

#[test]
fn el_mensaje_al_agente_dice_el_hilo_y_como_contestar() {
    let text = framed("green", "¿cómo va?");
    assert!(text.starts_with("[Chat do usuário · thread: green] ¿cómo va?"), "{text}");
    assert!(text.contains("ccode say") && text.contains("--progress"), "{text}");
}

#[test]
fn la_conversacion_conserva_su_forma_en_el_archivo() {
    let mut c = Conversation::default();
    say(&mut c, "pink", Kind::User, "oi", 7);
    let json = serde_json::to_string(&c).unwrap();
    assert!(json.contains("currentThread") && json.contains("\"kind\":\"user\""), "{json}");
    let back: Conversation = serde_json::from_str(&json).unwrap();
    assert_eq!(back, c);
}
