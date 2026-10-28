use std::collections::HashSet;

use super::store::*;

fn db() -> rusqlite::Connection {
    crate::database::test_db()
}

fn tell<'a>(from: &'a str, to: &'a str, text: &'a str) -> NewMessage<'a> {
    NewMessage { client_id: None, kind: "tell", from_tab_id: from, from_name: "Líder", to_tab_id: to, to_name: "QA", text, raw: false, reply: false, ..Default::default() }
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
    assert_eq!(expire_queued_for(&conn, "t1", "fechada", 3).unwrap().len(), 2);
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

// ── Contrato do peer: envelope, chave derivada, recusas, tetos, tombstone ──

fn delivered(conn: &rusqlite::Connection, id: i64, now: i64) {
    claim(conn, id, now).unwrap().unwrap();
    assert!(finish(conn, id, true, None, now).unwrap());
}

fn limited<'a>(from: &'a str, to: &'a str, text: &'a str) -> NewMessage<'a> {
    NewMessage { limits: Some(Limits::for_sender(false)), ..tell(from, to, text) }
}

fn admitted(a: Admission) -> PeerMessage {
    match a {
        Admission::New(m) => m,
        other => panic!("esperava nova, veio {other:?}"),
    }
}

#[test]
fn o_envelope_vira_o_bloco_fixo_e_o_texto_livre_continua_valendo() {
    let env = Envelope { task: Some("revise o diff".into()), constraints: Some("não mexa em testes".into()), expecting: Some("lista de achados".into()) };
    let text = env.text("Líder", Some("é o PR 12")).unwrap();
    assert_eq!(
        text,
        "Líder pediu sua ajuda nisto.\nTarefa: revise o diff\nContexto: é o PR 12\nRestrições: não mexa em testes\nComo é uma boa resposta: lista de achados\nResponda como você mesmo."
    );
    // Sem --task, o texto livre é a tarefa; sem nada, não há tarefa.
    let only = Envelope { expecting: Some("sim ou não".into()), ..Default::default() };
    assert!(only.text("X", Some("pode?")).unwrap().contains("Tarefa: pode?\nRestrições: nenhuma"));
    assert_eq!(only.text("X", None), None);
    assert!(!Envelope::default().is_present() && only.is_present());
}

#[test]
fn a_chave_derivada_normaliza_o_texto_e_inclui_o_envelope() {
    let a = tell("a", "b", "rode   os\n testes ");
    let b = tell("a", "b", "rode os testes");
    assert_eq!(dedupe_key(&a), dedupe_key(&b), "espaços não fazem outra mensagem");
    assert_ne!(dedupe_key(&a), dedupe_key(&tell("z", "b", "rode os testes")), "outro remetente");
    assert_ne!(dedupe_key(&a), dedupe_key(&tell("a", "c", "rode os testes")), "outro destino");
    let env = Envelope { task: Some("t".into()), ..Default::default() };
    let other = Envelope { task: Some("t".into()), constraints: Some("só leitura".into()), ..Default::default() };
    assert_ne!(dedupe_key(&NewMessage { envelope: Some(&env), ..b.clone() }), dedupe_key(&NewMessage { envelope: Some(&other), ..b.clone() }));
    // O mesmo texto com espaços diferentes é repetido pela fila.
    let conn = db();
    new_id(admit(&conn, &a, State::Queued, 1).unwrap());
    assert!(matches!(admit(&conn, &b, State::Queued, 2).unwrap(), Admission::Duplicate(_)));
}

#[test]
fn a_repetida_grava_uma_linha_recusada_com_o_motivo() {
    let conn = db();
    let first = new_id(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 1_000).unwrap());
    assert!(matches!(admit(&conn, &tell("a", "b", "tarefa X"), State::Queued, 2_000).unwrap(), Admission::Duplicate(m) if m.id == first));
    let refused = refusals_from(&conn, "a", 10).unwrap();
    assert_eq!(refused.len(), 1);
    assert_eq!((refused[0].state, refused[0].reason.as_deref(), refused[0].client_id.as_deref()), (State::Refused, Some("duplicate"), None));
    assert!(refused[0].note.as_deref().unwrap().contains("pergunte à pessoa"));
    // A recusa não entra na fila, nem na contagem, nem no que o remetente tem pendente.
    assert_eq!(queued_for(&conn, "b").unwrap().len(), 1);
    assert_eq!(pending_from(&conn, "a").unwrap().len(), 1);
    assert_eq!(pending_counts(&conn).unwrap(), vec![("b".to_string(), 1)]);
}

#[test]
fn a_profundidade_vem_da_mensagem_em_tratamento_e_tem_teto() {
    let conn = db();
    // A pede a B: profundidade 0.
    let ab = admitted(admit(&conn, &limited("A", "B", "faça X"), State::Queued, 1_000).unwrap());
    assert_eq!((ab.depth, ab.parent_id), (0, None));
    delivered(&conn, ab.id, 1_100);
    // B trata a de A e pede a C: 1; C pede a D: 2.
    let bc = admitted(admit(&conn, &limited("B", "C", "parte de X"), State::Queued, 1_200).unwrap());
    assert_eq!((bc.depth, bc.parent_id, bc.answer_of), (1, Some(ab.id), None));
    delivered(&conn, bc.id, 1_300);
    let cd = admitted(admit(&conn, &limited("C", "D", "pedaço"), State::Queued, 1_400).unwrap());
    assert_eq!(cd.depth, 2);
    delivered(&conn, cd.id, 1_500);
    // D pediria a E com 3: recusa, antes de qualquer coisa ir para a fila de E.
    match admit(&conn, &limited("D", "E", "mais um"), State::Queued, 1_600).unwrap() {
        Admission::Refused(r) => {
            assert_eq!((r.reason, r.record.state, r.record.depth), ("depth", State::Refused, 3));
            assert!(r.message.contains("teto: 2") && r.message.contains("pergunte à pessoa"), "{}", r.message);
        }
        other => panic!("{other:?}"),
    }
    assert!(head(&conn, "E").unwrap().is_none());
    // Sem tetos (mensagem do app), não há recusa.
    assert!(matches!(admit(&conn, &tell("D", "E", "mais um"), State::Queued, 1_700).unwrap(), Admission::New(m) if m.depth == 3));
    assert_eq!(MAX_PEER_DEPTH, 2);
}

#[test]
fn responder_a_quem_pediu_nao_aprofunda_e_fecha_o_tratamento() {
    let conn = db();
    let task = new_id(admit(&conn, &limited("Lider", "QA", "rode os testes"), State::Queued, 1_000).unwrap());
    delivered(&conn, task, 1_100);
    assert_eq!(in_treatment(&conn, "QA", 1_200).unwrap().map(|m| m.id), Some(task));
    let answer = admitted(admit(&conn, &limited("QA", "Lider", "passou"), State::Queued, 1_300).unwrap());
    assert_eq!((answer.depth, answer.answer_of), (0, Some(task)));
    delivered(&conn, answer.id, 1_400);
    // Respondida, sai do tratamento; a resposta não é "trabalho" para o Lider.
    assert_eq!(in_treatment(&conn, "QA", 1_500).unwrap(), None);
    assert_eq!(in_treatment(&conn, "Lider", 1_500).unwrap(), None);
    // O vai e volta segue em 0 por quantas rodadas forem.
    let again = admitted(admit(&conn, &limited("Lider", "QA", "agora o lint"), State::Queued, 1_600).unwrap());
    assert_eq!(again.depth, 0);
    // Velha demais (mais que a janela), não conta mais.
    delivered(&conn, again.id, 1_700);
    assert!(in_treatment(&conn, "QA", 1_700 + TREATMENT_WINDOW_MS + 1).unwrap().is_none());
}

#[test]
fn o_fan_out_tem_teto_por_janela_e_respostas_nao_contam() {
    let conn = db();
    let names: Vec<String> = (0..MAX_FANOUT).map(|i| format!("t{i}")).collect();
    for (i, to) in names.iter().enumerate() {
        assert!(matches!(admit(&conn, &limited("A", to, "x"), State::Queued, 1_000 + i as i64).unwrap(), Admission::New(_)));
    }
    match admit(&conn, &limited("A", "t9", "x"), State::Queued, 2_000).unwrap() {
        Admission::Refused(r) => assert!(r.reason == "fanout" && r.message.contains("teto: 5"), "{}", r.message),
        other => panic!("{other:?}"),
    }
    // O orquestrador tem o teto maior.
    let lead = NewMessage { limits: Some(Limits::for_sender(true)), ..tell("A", "t9", "x") };
    assert!(matches!(admit(&conn, &lead, State::Queued, 2_001).unwrap(), Admission::New(_)));
    // Passada a janela, volta a valer.
    assert!(matches!(admit(&conn, &limited("A", "t8", "y"), State::Queued, 2_001 + FANOUT_WINDOW_MS + 10).unwrap(), Admission::New(_)));
    // Uma resposta a quem pediu não conta no teto.
    let conn = db();
    let task = new_id(admit(&conn, &limited("Lider", "B", "faça"), State::Queued, 1).unwrap());
    delivered(&conn, task, 2);
    let helpers: Vec<String> = (0..MAX_FANOUT).map(|i| format!("u{i}")).collect();
    for (i, to) in helpers.iter().enumerate() {
        new_id(admit(&conn, &limited("B", to, "ajuda"), State::Queued, 10 + i as i64).unwrap());
    }
    assert!(matches!(admit(&conn, &limited("B", "Lider", "pronto"), State::Queued, 100).unwrap(), Admission::New(m) if m.answer_of == Some(task)));
}

#[test]
fn conferir_os_tetos_so_le() {
    let conn = db();
    let names: Vec<String> = (0..MAX_FANOUT).map(|i| format!("t{i}")).collect();
    for (i, to) in names.iter().enumerate() {
        new_id(admit(&conn, &limited("A", to, "x"), State::Queued, i as i64).unwrap());
    }
    let msg = limited("A", "z", "x");
    let (reason, _, _) = check_limits(&conn, &msg, 100).unwrap().unwrap();
    assert_eq!(reason, "fanout");
    assert!(refusals_from(&conn, "A", 10).unwrap().is_empty(), "a prévia não grava");
    assert!(check_limits(&conn, &tell("A", "z", "x"), 100).unwrap().is_none(), "sem tetos, sem recusa");
}

#[test]
fn a_recusa_de_politica_fica_gravada_e_nunca_vai() {
    let conn = db();
    let row = record_refusal(&conn, &tell("a", "Fantasma", ""), "unknown_target", "Não enviei: 'Fantasma' não está conectado.", 5).unwrap();
    assert_eq!((row.state, row.reason.as_deref(), row.text.as_str()), (State::Refused, Some("unknown_target"), "(sem texto)"));
    assert!(head(&conn, "Fantasma").unwrap().is_none() && pending_from(&conn, "a").unwrap().is_empty());
    assert!(!State::Refused.can_become(State::Queued), "recusada é final");
    assert_eq!(State::parse("refused"), Some(State::Refused));
}

#[test]
fn admit_roda_numa_transacao_e_dentro_de_outra_vira_savepoint() {
    let conn = db();
    assert!(conn.is_autocommit());
    new_id(admit(&conn, &tell("a", "b", "um"), State::Queued, 1).unwrap());
    assert!(conn.is_autocommit(), "a transação fechou");
    conn.execute_batch("BEGIN").unwrap();
    new_id(admit(&conn, &tell("a", "b", "dois"), State::Queued, 2).unwrap());
    assert!(!conn.is_autocommit());
    conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(queued_for(&conn, "b").unwrap().len(), 1, "o savepoint segue a transação de fora");
    // Um erro desfaz o que a admissão fez.
    let mut bad = tell("a", "c", "x");
    bad.client_id = Some("k");
    new_id(admit(&conn, &bad, State::Queued, 3).unwrap());
    bad.to_tab_id = "d";
    assert!(admit(&conn, &bad, State::Queued, 4).is_err());
    assert!(conn.is_autocommit());
}

#[test]
fn a_chave_do_id_sobrevive_a_limpeza_como_tombstone() {
    let conn = db();
    let mut m = tell("a", "b", "deploy");
    m.client_id = Some("req-deploy");
    let id = new_id(admit(&conn, &m, State::Queued, 0).unwrap());
    delivered(&conn, id, 1);
    let week = 8 * 24 * 60 * 60 * 1000;
    prune(&conn, week).unwrap();
    assert!(get(&conn, id).unwrap().is_none(), "a linha saiu");
    // O mesmo id não roda de novo: é repetição, com o id antigo.
    match admit(&conn, &m, State::Queued, week + 1).unwrap() {
        Admission::Repeat(x) => assert_eq!((x.id, x.state, x.client_id.as_deref()), (id, State::Delivered, Some("req-deploy"))),
        other => panic!("{other:?}"),
    }
    assert_eq!(by_client_id(&conn, "a", Some("req-deploy")).unwrap().map(|x| x.id), Some(id));
    // Para outro destino, o id continua sendo de outra mensagem.
    let mut other = m.clone();
    other.to_tab_id = "c";
    assert!(admit(&conn, &other, State::Queued, week + 2).unwrap_err().contains("outro id"));
    // Depois do TTL do tombstone, a chave volta.
    assert!(matches!(admit(&conn, &m, State::Queued, 1 + KEEP_KEYS_MS + 1).unwrap(), Admission::New(_)));
}

#[test]
fn a_migracao_reconstroi_a_tabela_antiga_sem_perder_linhas() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE peer_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, kind TEXT NOT NULL, from_tab_id TEXT NOT NULL,
            from_name TEXT NOT NULL, to_tab_id TEXT NOT NULL, to_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
            raw INTEGER NOT NULL DEFAULT 0, reply INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK(state IN ('queued','delivering','delivered','unconfirmed','cancelled','expired')),
            position INTEGER NOT NULL DEFAULT 0, force_now INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER, edited_at INTEGER, note TEXT);
         INSERT INTO peer_messages (client_id, kind, from_tab_id, from_name, to_tab_id, text, state, position, created_at, updated_at)
            VALUES ('r1', 'tell', 'a', 'Líder', 'b', 'antiga', 'queued', 1, 10, 10);",
    )
    .unwrap();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap();
    let old = head(&conn, "b").unwrap().unwrap();
    assert_eq!((old.text.as_str(), old.client_id.as_deref(), old.depth), ("antiga", Some("r1"), 0));
    record_refusal(&conn, &tell("a", "b", "x"), "self", "frase", 20).unwrap();
    // O índice do id do chamador voltou.
    let mut same = tell("a", "b", "antiga");
    same.client_id = Some("r1");
    assert!(matches!(admit(&conn, &same, State::Queued, 30).unwrap(), Admission::Repeat(_)));
}

// ── Faixa 2: falha volta ao remetente, tentativas, relógio do SQLite ───

fn failed_tell(conn: &rusqlite::Connection, from: &str, to: &str, text: &str, at: i64) -> PeerMessage {
    let id = new_id(admit(conn, &tell(from, to, text), State::Queued, at).unwrap());
    claim(conn, id, at + 1).unwrap().unwrap();
    assert!(finish(conn, id, false, Some("O texto foi escrito no terminal do destino, mas não apareceu na tela dele."), at + 2).unwrap());
    get(conn, id).unwrap().unwrap()
}

#[test]
fn a_falha_definitiva_volta_ao_remetente_como_aviso() {
    let conn = db();
    let failed = failed_tell(&conn, "lider", "qa", "rode os testes do backend", 1_000);
    let notice = failure_notice(&conn, &failed, 2_000).unwrap().expect("aviso");
    assert_eq!((notice.kind.as_str(), notice.to_tab_id.as_str(), notice.state, notice.raw), ("notice", "lider", State::Queued, true));
    assert!(notice.text.starts_with("[AGS] Você pediu a QA: \"rode os testes do backend\""), "{}", notice.text);
    assert!(notice.text.contains("(o texto foi escrito no terminal do destino, mas não apareceu na tela dele)"), "{}", notice.text);
    assert!(notice.text.ends_with("Diga isso à pessoa e ofereça o que você mesmo pode fazer."), "{}", notice.text);
    // A mesma falha processada de novo é o mesmo aviso (chave própria por mensagem).
    assert!(failure_notice(&conn, &failed, 2_001).unwrap().is_none());
    // Duas falhas para o mesmo destino, com o mesmo texto, não colapsam: cada uma tem a sua chave.
    let other = failed_tell(&conn, "lider", "qa", "rode os testes do backend", 3_000 + DUPLICATE_WINDOW_MS);
    assert!(failure_notice(&conn, &other, 4_000 + DUPLICATE_WINDOW_MS).unwrap().is_some());
    assert_eq!(queued_for(&conn, "lider").unwrap().len(), 2);
}

#[test]
fn o_aviso_de_falha_nao_gera_aviso_nem_conta_no_fan_out() {
    let conn = db();
    let failed = failed_tell(&conn, "lider", "qa", "tarefa", 1_000);
    let notice = failure_notice(&conn, &failed, 2_000).unwrap().unwrap();
    // O aviso também falhou (a aba do remetente não mostrou): nada de aviso do aviso.
    claim(&conn, notice.id, 2_100).unwrap().unwrap();
    finish(&conn, notice.id, false, None, 2_200).unwrap();
    let notice = get(&conn, notice.id).unwrap().unwrap();
    assert!(failure_notice(&conn, &notice, 2_300).unwrap().is_none());
    // Não conta no fan-out de quem pediu.
    assert_eq!(fanout_since(&conn, "lider", 0).unwrap(), 1, "só o tell original conta");
    // Entregue ou ainda na fila: não há falha a avisar.
    let ok = new_id(admit(&conn, &tell("lider", "qa", "outra"), State::Queued, 3_000).unwrap());
    assert!(failure_notice(&conn, &get(&conn, ok).unwrap().unwrap(), 3_001).unwrap().is_none());
}

#[test]
fn a_aba_fechada_expira_a_fila_e_devolve_as_expiradas() {
    let conn = db();
    let env = Envelope { task: Some("revisar o PR #12".into()), ..Default::default() };
    let text = env.text("Líder", None).unwrap();
    admit(&conn, &NewMessage { envelope: Some(&env), ..tell("lider", "qa", &text) }, State::Queued, 1).unwrap();
    let expired = expire_queued_for(&conn, "qa", "A aba de destino foi fechada.", 5).unwrap();
    assert_eq!(expired.len(), 1);
    let notice = failure_notice(&conn, &expired[0], 6).unwrap().unwrap();
    // No envelope, o começo é a linha da tarefa.
    assert!(notice.text.contains("Você pediu a QA: \"revisar o PR #12\" e não chegou (a aba de destino foi fechada)"), "{}", notice.text);
}

#[test]
fn no_arranque_a_falha_avisa_so_o_remetente_que_ainda_existe() {
    let conn = db();
    let now = 10 * RESUME_MAX_AGE_MS;
    admit(&conn, &tell("lider", "fechada", "pedido 1"), State::Queued, now - 60_000).unwrap();
    admit(&conn, &tell("sumiu", "fechada", "pedido 2"), State::Queued, now - 60_000).unwrap();
    let tabs: HashSet<String> = ["lider".to_string()].into_iter().collect();
    assert_eq!(resume(&conn, &tabs, now).unwrap(), vec!["lider".to_string()], "a fila do remetente anda com o aviso");
    let lider = queued_for(&conn, "lider").unwrap();
    assert_eq!(lider.len(), 1);
    assert!(lider[0].text.contains("\"pedido 1\""));
    assert!(queued_for(&conn, "sumiu").unwrap().is_empty(), "remetente que não existe: nada");
}

#[test]
fn tentativas_contam_no_claim_no_reenvio_e_no_ask_direto() {
    let conn = db();
    let mut m = tell("a", "b", "x");
    m.client_id = Some("r1");
    let id = new_id(admit(&conn, &m, State::Queued, 1).unwrap());
    assert_eq!(claim(&conn, id, 2).unwrap().unwrap().attempts, 1);
    finish(&conn, id, false, None, 3).unwrap();
    // O reenvio com o mesmo id de uma que não se confirmou chega com attempts 2 (marca de reenvio).
    new_id(admit(&conn, &m, State::Queued, 4).unwrap());
    assert_eq!(claim(&conn, id, 5).unwrap().unwrap().attempts, 2);
    // O ask direto nasce na primeira tentativa; o reenvio direto conta 2.
    let mut ask = NewMessage { kind: "ask", reply: true, ..tell("a", "c", "status?") };
    ask.client_id = Some("q1");
    let direct = admitted(admit(&conn, &ask, State::Delivering, 10).unwrap());
    assert_eq!(direct.attempts, 1);
    finish(&conn, direct.id, false, Some("falhou"), 11).unwrap();
    assert_eq!(admitted(admit(&conn, &ask, State::Delivering, 12).unwrap()).attempts, 2);
}

#[test]
fn o_relogio_e_o_do_sqlite() {
    let conn = db();
    let sql = db_now(&conn).unwrap();
    let rust = crate::util::now_ts_ms();
    assert!((sql - rust).abs() < 5_000, "sqlite {sql} x processo {rust}");
    // Gravado e comparado com o mesmo relógio, o dedupe vale (o relógio é injetado nos testes acima).
    let first = new_id(admit(&conn, &tell("a", "b", "mesmo"), State::Queued, sql).unwrap());
    assert!(matches!(admit(&conn, &tell("a", "b", "mesmo"), State::Queued, db_now(&conn).unwrap()).unwrap(), Admission::Duplicate(m) if m.id == first));
}

#[test]
fn o_comeco_da_tarefa_e_uma_linha_curta() {
    assert_eq!(task_gist("\n  rode   os testes\nsegunda"), "rode os testes");
    assert_eq!(task_gist("Líder pediu sua ajuda nisto.\nTarefa: revisar\nRestrições: x"), "revisar");
    let long = "a".repeat(300);
    let gist = task_gist(&long);
    assert_eq!(gist.chars().count(), 120);
    assert!(gist.ends_with('…'));
}
