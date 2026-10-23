use std::collections::HashSet;

use super::store::*;

fn db() -> rusqlite::Connection {
    crate::database::test_db()
}

fn tell<'a>(from: &'a str, to: &'a str, text: &'a str) -> NewMessage<'a> {
    NewMessage { client_id: None, kind: "tell", from_tab_id: from, from_name: "Líder", to_tab_id: to, to_name: "QA", text, raw: false, reply: false }
}

fn new_id(a: Admission) -> i64 {
    match a {
        Admission::New(m) => m.id,
        other => panic!("esperava nova, veio {other:?}"),
    }
}

#[test]
fn as_transicoes_do_estado_so_andam_para_frente() {
    use State::*;
    assert!(Queued.can_become(Delivering) && Queued.can_become(Cancelled) && Queued.can_become(Expired));
    assert!(Delivering.can_become(Delivered) && Delivering.can_become(Unconfirmed));
    assert!(Unconfirmed.can_become(Queued) && Expired.can_become(Queued), "reenvio com o mesmo id");
    assert!(!Delivered.can_become(Queued), "entregue nunca volta para a fila");
    assert!(!Cancelled.can_become(Queued), "o cancelamento do usuário vence o reenvio");
    assert!(!Delivering.can_become(Queued), "o que estava sendo digitado não se digita de novo");
    for s in [Queued, Delivering, Delivered, Unconfirmed, Cancelled, Expired] {
        assert_eq!(State::parse(s.as_str()), Some(s));
    }
}

#[test]
fn a_mensagem_entra_na_fila_e_e_entregue_uma_vez() {
    let conn = db();
    let id = new_id(admit(&conn, &tell("a", "b", "rode os testes"), State::Queued, 1_000).unwrap());
    assert_eq!(head(&conn, "b").unwrap().unwrap().id, id);
    let claimed = claim(&conn, id, 2_000).unwrap().unwrap();
    assert_eq!((claimed.state, claimed.attempts), (State::Delivering, 1));
    assert!(claim(&conn, id, 2_001).unwrap().is_none(), "duas threads não tomam a mesma mensagem");
    assert!(finish(&conn, id, true, None, 3_000).unwrap());
    let done = get(&conn, id).unwrap().unwrap();
    assert_eq!((done.state, done.delivered_at), (State::Delivered, Some(3_000)));
    assert!(!finish(&conn, id, false, None, 3_001).unwrap(), "fechar duas vezes não muda nada");
    assert!(head(&conn, "b").unwrap().is_none());
}

#[test]
fn sem_id_o_mesmo_texto_ao_mesmo_destino_e_repetido_por_dez_minutos() {
    let conn = db();
    let first = new_id(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_000).unwrap());
    assert!(matches!(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 2_000).unwrap(), Admission::Duplicate(m) if m.id == first));
    // Outro destino, outro texto ou outro remetente seguem valendo.
    assert!(matches!(admit(&conn, &tell("a", "c", "tarefa X"), State::Queued, 2_000).unwrap(), Admission::New(_)));
    assert!(matches!(admit(&conn, &tell("a", "b", "tarefa Y"), State::Queued, 2_000).unwrap(), Admission::New(_)));
    assert!(matches!(admit(&conn, &tell("z", "b", "tarefa X"), State::Queued, 2_000).unwrap(), Admission::New(_)));
    // Passada a janela, vale de novo.
    assert!(matches!(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_000 + DUPLICATE_WINDOW_MS + 1).unwrap(), Admission::New(_)));
}

#[test]
fn a_entrega_sem_confirmacao_ou_cancelada_nao_bloqueia_o_reenvio_pelo_texto() {
    let conn = db();
    let id = new_id(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_000).unwrap());
    claim(&conn, id, 1_100).unwrap();
    finish(&conn, id, false, Some("não apareceu"), 1_200).unwrap();
    let again = new_id(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_300).unwrap());
    assert_ne!(again, id);
    cancel(&conn, again, "cancelada", 1_400).unwrap();
    assert!(matches!(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_500).unwrap(), Admission::New(_)));
}

#[test]
fn com_raw_o_mesmo_comando_de_qualquer_remetente_e_repetido() {
    let conn = db();
    let mut a = tell("a", "b", "/compact");
    a.raw = true;
    new_id(admit(&conn, &a, State::Queued, 1_000).unwrap());
    let mut z = tell("z", "b", "/compact");
    z.raw = true;
    assert!(matches!(admit(&conn, &z, State::Queued, 1_100).unwrap(), Admission::Duplicate(_)));
}

#[test]
fn o_mesmo_id_e_a_mesma_mensagem_e_nunca_e_digitada_duas_vezes() {
    let conn = db();
    let mut m = tell("a", "b", "tarefa X");
    m.client_id = Some("req-1");
    let id = new_id(admit(&conn, &m, State::Queued, 1_000).unwrap());
    // Na fila, sendo digitada ou entregue: o mesmo id devolve a mesma mensagem, sem nova entrega.
    assert!(matches!(admit(&conn, &m, State::Queued, 1_100).unwrap(), Admission::Repeat(x) if x.id == id && x.state == State::Queued));
    claim(&conn, id, 1_200).unwrap();
    assert!(matches!(admit(&conn, &m, State::Queued, 1_300).unwrap(), Admission::Repeat(x) if x.state == State::Delivering));
    finish(&conn, id, true, None, 1_400).unwrap();
    // Mesmo depois da janela do texto e de um reinício (o registro está no banco).
    let later = 1_400 + DUPLICATE_WINDOW_MS * 10;
    assert!(matches!(admit(&conn, &m, State::Queued, later).unwrap(), Admission::Repeat(x) if x.state == State::Delivered));
    assert_eq!(head(&conn, "b").unwrap(), None);
}

#[test]
fn com_id_textos_iguais_sao_mensagens_diferentes() {
    let conn = db();
    let mut one = tell("a", "b", "rode os testes de novo");
    one.client_id = Some("r1");
    let mut two = one.clone();
    two.client_id = Some("r2");
    let a = new_id(admit(&conn, &one, State::Queued, 1_000).unwrap());
    let b = new_id(admit(&conn, &two, State::Queued, 1_001).unwrap());
    assert_ne!(a, b, "o pedido legítimo repetido não é descartado pelo texto");
    assert_eq!(queued_for(&conn, "b").unwrap().len(), 2);
}

#[test]
fn o_id_e_por_remetente_e_nao_vale_para_outro_destino() {
    let conn = db();
    let mut m = tell("a", "b", "x");
    m.client_id = Some("same");
    new_id(admit(&conn, &m, State::Queued, 1_000).unwrap());
    let mut other_sender = tell("z", "b", "x");
    other_sender.client_id = Some("same");
    assert!(matches!(admit(&conn, &other_sender, State::Queued, 1_100).unwrap(), Admission::New(_)));
    let mut other_target = tell("a", "c", "x");
    other_target.client_id = Some("same");
    let err = admit(&conn, &other_target, State::Queued, 1_200).unwrap_err();
    assert!(err.contains("same") && err.contains("outro id"), "{err}");
}

#[test]
fn o_reenvio_com_o_mesmo_id_de_uma_que_nao_chegou_volta_para_a_fila() {
    let conn = db();
    let mut m = tell("a", "b", "x");
    m.client_id = Some("r");
    let id = new_id(admit(&conn, &m, State::Queued, 1_000).unwrap());
    claim(&conn, id, 1_100).unwrap();
    finish(&conn, id, false, Some("não apareceu"), 1_200).unwrap();
    match admit(&conn, &m, State::Queued, 1_300).unwrap() {
        Admission::New(again) => assert_eq!((again.id, again.state, again.note), (id, State::Queued, None)),
        other => panic!("{other:?}"),
    }
    // Cancelada pelo usuário: o reenvio não a ressuscita.
    cancel(&conn, id, "cancelada", 1_400).unwrap();
    assert!(matches!(admit(&conn, &m, State::Queued, 1_500).unwrap(), Admission::Repeat(x) if x.state == State::Cancelled));
}

#[test]
fn o_id_do_chamador_e_curto_e_sem_quebra_de_linha() {
    assert_eq!(clean_client_id(None).unwrap(), None);
    assert_eq!(clean_client_id(Some("  ")).unwrap(), None);
    assert_eq!(clean_client_id(Some(" abc ")).unwrap().as_deref(), Some("abc"));
    assert!(clean_client_id(Some("a\nb")).is_err());
    assert!(clean_client_id(Some(&"x".repeat(129))).is_err());
}

#[test]
fn a_fila_respeita_a_ordem_e_o_usuario_reordena() {
    let conn = db();
    let a = new_id(admit(&conn, &tell("x", "t", "um"), State::Queued, 1).unwrap());
    let b = new_id(admit(&conn, &tell("x", "t", "dois"), State::Queued, 2).unwrap());
    let c = new_id(admit(&conn, &tell("x", "t", "três"), State::Queued, 3).unwrap());
    let ids = |conn: &rusqlite::Connection| queued_for(conn, "t").unwrap().iter().map(|m| m.id).collect::<Vec<_>>();
    assert_eq!(ids(&conn), vec![a, b, c]);
    move_by(&conn, c, -1, 10).unwrap();
    assert_eq!(ids(&conn), vec![a, c, b]);
    move_by(&conn, a, 1, 11).unwrap();
    assert_eq!(ids(&conn), vec![c, a, b]);
    // Na ponta, mover não faz nada.
    move_by(&conn, c, -1, 12).unwrap();
    move_by(&conn, b, 1, 12).unwrap();
    assert_eq!(ids(&conn), vec![c, a, b]);
    assert_eq!(head(&conn, "t").unwrap().unwrap().id, c);
    // Uma nova entra no fim.
    let d = new_id(admit(&conn, &tell("x", "t", "quatro"), State::Queued, 13).unwrap());
    assert_eq!(ids(&conn), vec![c, a, b, d]);
}

#[test]
fn reordenar_e_trocar_vizinhos() {
    assert_eq!(reorder(&[1, 2, 3], 3, -1), Some(vec![1, 3, 2]));
    assert_eq!(reorder(&[1, 2, 3], 1, 1), Some(vec![2, 1, 3]));
    assert_eq!(reorder(&[1, 2, 3], 1, -1), None);
    assert_eq!(reorder(&[1, 2, 3], 3, 1), None);
    assert_eq!(reorder(&[1, 2, 3], 9, 1), None);
}

#[test]
fn enviar_agora_passa_na_frente_e_reordenar_desfaz() {
    let conn = db();
    let a = new_id(admit(&conn, &tell("x", "t", "um"), State::Queued, 1).unwrap());
    let b = new_id(admit(&conn, &tell("x", "t", "dois"), State::Queued, 2).unwrap());
    let now = send_now(&conn, b, 5).unwrap();
    assert!(now.force_now);
    let first = head(&conn, "t").unwrap().unwrap();
    assert_eq!((first.id, first.force_now), (b, true));
    move_by(&conn, a, -1, 6).unwrap();
    let first = head(&conn, "t").unwrap().unwrap();
    assert_eq!(first.id, a);
    assert!(queued_for(&conn, "t").unwrap().iter().all(|m| !m.force_now));
}

#[test]
fn so_se_edita_cancela_ou_move_o_que_ainda_espera() {
    let conn = db();
    let id = new_id(admit(&conn, &tell("x", "t", "texto velho"), State::Queued, 1).unwrap());
    let edited = edit(&conn, id, "texto novo", 2).unwrap();
    assert_eq!((edited.text.as_str(), edited.edited_at), ("texto novo", Some(2)));
    assert!(edit(&conn, id, "   ", 3).unwrap_err().contains("cancele"));
    claim(&conn, id, 4).unwrap();
    for err in [
        edit(&conn, id, "tarde", 5).unwrap_err(),
        cancel(&conn, id, "x", 5).unwrap_err(),
        send_now(&conn, id, 5).unwrap_err(),
        move_by(&conn, id, 1, 5).unwrap_err(),
    ] {
        assert!(err.contains("sendo entregue"), "{err}");
    }
    assert!(cancel(&conn, 999, "x", 5).unwrap_err().contains("não existe"));
}

#[test]
fn a_mensagem_editada_e_o_que_sai_da_fila() {
    let conn = db();
    let id = new_id(admit(&conn, &tell("x", "t", "antes"), State::Queued, 1).unwrap());
    edit(&conn, id, "depois", 2).unwrap();
    assert_eq!(claim(&conn, id, 3).unwrap().unwrap().text, "depois");
}

#[test]
fn no_arranque_a_fila_volta_ou_expira() {
    let conn = db();
    let now = 10 * RESUME_MAX_AGE_MS;
    let live = new_id(admit(&conn, &tell("x", "viva", "ainda vale"), State::Queued, now - 60_000).unwrap());
    let gone = new_id(admit(&conn, &tell("x", "fechada", "destino sumiu"), State::Queued, now - 60_000).unwrap());
    let old = new_id(admit(&conn, &tell("x", "viva", "velha demais"), State::Queued, now - RESUME_MAX_AGE_MS - 1).unwrap());
    let typing = new_id(admit(&conn, &tell("x", "viva", "estava sendo digitada"), State::Queued, now - 30_000).unwrap());
    claim(&conn, typing, now - 29_000).unwrap();
    let done = new_id(admit(&conn, &tell("x", "viva", "já entregue"), State::Queued, now - 30_000).unwrap());
    claim(&conn, done, now - 29_000).unwrap();
    finish(&conn, done, true, None, now - 28_000).unwrap();

    let tabs: HashSet<String> = ["viva".to_string()].into_iter().collect();
    assert_eq!(resume(&conn, &tabs, now).unwrap(), vec!["viva".to_string()]);
    let state = |id| get(&conn, id).unwrap().unwrap().state;
    assert_eq!(state(live), State::Queued);
    assert_eq!(state(gone), State::Expired);
    assert_eq!(state(old), State::Expired);
    assert_eq!(state(typing), State::Unconfirmed, "não se digita de novo o que pode ter chegado");
    assert_eq!(state(done), State::Delivered);
    assert!(get(&conn, gone).unwrap().unwrap().note.unwrap().contains("não existe"));
    // Rodar de novo não muda nada.
    assert_eq!(resume(&conn, &tabs, now + 1).unwrap(), vec!["viva".to_string()]);
}

#[test]
fn a_decisao_do_arranque_e_pura() {
    let conn = db();
    let id = new_id(admit(&conn, &tell("x", "t", "oi"), State::Queued, 0).unwrap());
    let msg = get(&conn, id).unwrap().unwrap();
    let live: HashSet<String> = ["t".to_string()].into_iter().collect();
    assert_eq!(resume_decision(&msg, &live, 1_000), Resume::Keep);
    assert!(matches!(resume_decision(&msg, &HashSet::new(), 1_000), Resume::Expire(_)));
    assert!(matches!(resume_decision(&msg, &live, RESUME_MAX_AGE_MS + 1), Resume::Expire(_)));
}

#[test]
fn contagem_por_destino_e_o_que_cada_remetente_tem_pendente() {
    let conn = db();
    admit(&conn, &tell("x", "t1", "a"), State::Queued, 1).unwrap();
    admit(&conn, &tell("x", "t1", "b"), State::Queued, 1).unwrap();
    let c = new_id(admit(&conn, &tell("y", "t2", "c"), State::Queued, 1).unwrap());
    assert_eq!(pending_counts(&conn).unwrap(), vec![("t1".to_string(), 2), ("t2".to_string(), 1)]);
    assert_eq!(pending_from(&conn, "x").unwrap().len(), 2);
    cancel(&conn, c, "x", 2).unwrap();
    assert_eq!(pending_counts(&conn).unwrap(), vec![("t1".to_string(), 2)]);
    assert_eq!(expire_queued_for(&conn, "t1", "fechada", 3).unwrap(), 2);
    assert!(pending_counts(&conn).unwrap().is_empty());
}

#[test]
fn o_ask_direto_nao_entra_no_dedupe_por_texto() {
    let conn = db();
    let ask = NewMessage { kind: "ask", reply: true, ..tell("x", "t", "qual o status?") };
    let id = new_id(admit(&conn, &ask, State::Delivering, 1).unwrap());
    assert!(head(&conn, "t").unwrap().is_none(), "o ask direto não passa pela fila");
    finish(&conn, id, true, None, 2).unwrap();
    assert!(matches!(admit(&conn, &tell("x", "t", "qual o status?"), State::Queued, 3).unwrap(), Admission::New(_)));
}

#[test]
fn os_resolvidos_saem_depois_de_uma_semana_e_a_fila_fica() {
    let conn = db();
    let done = new_id(admit(&conn, &tell("x", "t", "velha"), State::Queued, 0).unwrap());
    claim(&conn, done, 1).unwrap();
    finish(&conn, done, true, None, 2).unwrap();
    let waiting = new_id(admit(&conn, &tell("x", "t", "esperando"), State::Queued, 0).unwrap());
    let week = 8 * 24 * 60 * 60 * 1000;
    assert_eq!(prune(&conn, week).unwrap(), 1);
    assert!(get(&conn, done).unwrap().is_none());
    assert!(get(&conn, waiting).unwrap().is_some());
}

#[test]
fn tipo_e_texto_sao_validados() {
    let conn = db();
    assert!(admit(&conn, &NewMessage { kind: "outro", ..tell("x", "t", "a") }, State::Queued, 1).is_err());
    assert!(admit(&conn, &tell("x", "t", "  "), State::Queued, 1).unwrap_err().contains("vazia"));
    assert!(admit(&conn, &tell("x", "t", "a"), State::Delivered, 1).is_err());
}
