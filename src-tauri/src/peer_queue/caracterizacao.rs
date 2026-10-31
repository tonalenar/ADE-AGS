//! Testes de CARACTERIZAÇÃO da entrega a conversas por protocolo (`thread:<id>`), antes da etapa 2
//! (ver `.plans/conversa-harness/ETAPA2.md`).
//!
//! Cada falha tem dois testes sobre o mesmo cenário:
//! - `hoje_…` passa e prova o comportamento atual (o "antes");
//! - `etapa2_…` diz o que deve valer depois e está `#[ignore]` até a fila durável existir (o "depois").
//!   Rode a mão: `cargo test --lib peer_queue::caracterizacao -- --ignored` (hoje todos falham).
//!
//! Só o que o `store` alcança entra aqui: `AppHandle` não se simula nos testes. A entrada de hoje de
//! `team::deliver_to_thread` é `begin_direct`, ou seja, `admit(.., Delivering)`; o helper
//! [`como_o_deliver_to_thread_grava_hoje`] a repete, e na etapa 2 passa a chamar o ponto de entrada novo.

use std::collections::HashSet;

use super::store::*;

fn db() -> rusqlite::Connection {
    crate::database::test_db()
}

fn msg<'a>(kind: &'a str, from: &'a str, to: &'a str, text: &'a str) -> NewMessage<'a> {
    NewMessage { kind, from_tab_id: from, from_name: "Remetente", to_tab_id: to, to_name: "Destino", text, reply: kind == "ask", ..Default::default() }
}

fn novo(a: Admission) -> PeerMessage {
    match a {
        Admission::New(m) => m,
        other => panic!("esperava nova, veio {other:?}"),
    }
}

/// O que `deliver_to_thread` grava hoje ao receber uma mensagem para uma conversa: `begin_direct`,
/// que admite já como `delivering`, esteja a conversa livre ou no meio de um turno.
fn como_o_deliver_to_thread_grava_hoje(conn: &rusqlite::Connection, new: &NewMessage<'_>, now: i64) -> Admission {
    admit(conn, new, State::Delivering, now).unwrap()
}

fn entregue(conn: &rusqlite::Connection, new: &NewMessage<'_>, now: i64) -> PeerMessage {
    let m = novo(admit(conn, new, State::Queued, now).unwrap());
    claim(conn, m.id, now).unwrap().unwrap();
    assert!(finish(conn, m.id, true, None, now).unwrap());
    get(conn, m.id).unwrap().unwrap()
}

// ── Item 8: sem fila por destino ─────────────────────────────────────

#[test]
fn hoje_a_espera_pelo_turno_da_conversa_nao_e_uma_fila() {
    let conn = db();
    let ids: Vec<PeerMessage> = ["um", "dois", "tres"]
        .iter()
        .enumerate()
        .map(|(i, text)| novo(como_o_deliver_to_thread_grava_hoje(&conn, &msg("tell", "thread:lead", "thread:t1", text), 1_000 + i as i64)))
        .collect();
    assert!(ids.iter().all(|m| m.state == State::Delivering), "todas nascem delivering, mesmo sem ninguém digitando");
    assert!(head(&conn, "thread:t1").unwrap().is_none(), "nenhum consumidor da fila as enxerga");
    assert!(ids.iter().all(|m| m.position == 1), "a posição só conta as queued: a ordem fica a cargo de qual thread acordar primeiro");
}

#[test]
#[ignore = "etapa 2: falha até a fila durável existir"]
fn etapa2_a_espera_pelo_turno_da_conversa_e_uma_fila_em_ordem() {
    let conn = db();
    let ids: Vec<PeerMessage> = ["um", "dois", "tres"]
        .iter()
        .enumerate()
        .map(|(i, text)| novo(como_o_deliver_to_thread_grava_hoje(&conn, &msg("tell", "thread:lead", "thread:t1", text), 1_000 + i as i64)))
        .collect();
    assert_eq!(head(&conn, "thread:t1").unwrap().map(|m| m.id), Some(ids[0].id), "o consumidor único começa pela mais antiga");
    let positions: Vec<i64> = ids.iter().map(|m| m.position).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "posições estritamente crescentes: {positions:?}");
}

// ── Item 2: a falha não chega ao remetente; o reinício confunde espera com digitação ─────────

#[test]
fn hoje_o_reinicio_marca_sem_confirmacao_a_mensagem_que_nunca_foi_enviada_a_conversa() {
    let conn = db();
    let waiting = novo(como_o_deliver_to_thread_grava_hoje(&conn, &msg("ask", "thread:lead", "thread:t1", "rode os testes"), 1_000));
    let live: HashSet<String> = ["thread:lead", "thread:t1"].map(String::from).into();
    resume(&conn, &live, 2_000).unwrap();
    let after = get(&conn, waiting.id).unwrap().unwrap();
    assert_eq!(after.state, State::Unconfirmed);
    assert!(after.note.as_deref().is_some_and(|n| n.contains("digitada")), "o motivo fala em digitação, que não houve: {:?}", after.note);
}

#[test]
#[ignore = "etapa 2: falha até a fila durável existir"]
fn etapa2_o_reinicio_devolve_a_fila_a_mensagem_que_ainda_esperava_o_turno() {
    let conn = db();
    let waiting = novo(como_o_deliver_to_thread_grava_hoje(&conn, &msg("ask", "thread:lead", "thread:t1", "rode os testes"), 1_000));
    let live: HashSet<String> = ["thread:lead", "thread:t1"].map(String::from).into();
    let targets = resume(&conn, &live, 2_000).unwrap();
    assert_eq!(get(&conn, waiting.id).unwrap().unwrap().state, State::Queued, "ainda não foi enviada: volta a esperar, não vira unconfirmed");
    assert!(targets.contains(&"thread:t1".to_string()), "e o consumidor do destino é religado");
}

// ── Item 10: ask repetido e "Concluído" legítimo ─────────────────────

#[test]
fn hoje_o_ask_repetido_enquanto_o_integrante_trabalha_vira_outra_espera() {
    let conn = db();
    let ask = msg("ask", "thread:lead", "thread:t1", "o build passa?");
    let first = novo(como_o_deliver_to_thread_grava_hoje(&conn, &ask, 1_000));
    let second = como_o_deliver_to_thread_grava_hoje(&conn, &ask, 2_000);
    assert!(matches!(&second, Admission::New(m) if m.id != first.id), "reply: true pula o dedupe: {second:?}");
}

#[test]
#[ignore = "etapa 2: falha até a fila durável existir"]
fn etapa2_o_ask_repetido_devolve_a_mesma_espera() {
    let conn = db();
    let ask = msg("ask", "thread:lead", "thread:t1", "o build passa?");
    let first = novo(como_o_deliver_to_thread_grava_hoje(&conn, &ask, 1_000));
    let second = como_o_deliver_to_thread_grava_hoje(&conn, &ask, 2_000);
    assert!(
        matches!(&second, Admission::Duplicate(m) | Admission::Repeat(m) if m.id == first.id),
        "um ask em andamento por remetente+destino: repetir devolve a mesma espera, {second:?}"
    );
}

#[test]
fn hoje_o_concluido_legitimo_depois_de_novo_pedido_e_recusado_como_duplicado() {
    let conn = db();
    entregue(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), 1_000);
    entregue(&conn, &msg("tell", "thread:lead", "thread:t1", "agora faça o item B"), 2_000);
    let again = admit(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), State::Queued, 3_000).unwrap();
    assert!(matches!(again, Admission::Duplicate(_)), "{again:?}");
    assert_eq!(refusals_from(&conn, "thread:t1", 10).unwrap().len(), 1, "e ainda grava a recusa 'duplicate'");
}

#[test]
#[ignore = "etapa 2: falha até a fila durável existir"]
fn etapa2_o_concluido_depois_de_novo_pedido_passa() {
    let conn = db();
    entregue(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), 1_000);
    entregue(&conn, &msg("tell", "thread:lead", "thread:t1", "agora faça o item B"), 2_000);
    let again = admit(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), State::Queued, 3_000).unwrap();
    assert!(matches!(again, Admission::New(_)), "o destino falou com o remetente no meio: a conversa andou, não é repetição ({again:?})");
}
