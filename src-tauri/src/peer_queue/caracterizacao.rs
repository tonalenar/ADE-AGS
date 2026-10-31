//! Testes de CARACTERIZAÇÃO da entrega a conversas por protocolo (`thread:<id>`), antes da etapa 2
//! (ver `.plans/conversa-harness/ETAPA2.md`).
//!
//! Cada falha tinha dois testes sobre o mesmo cenário: `hoje_…` (passava e provava o "antes") e `etapa2_…`
//! (`#[ignore]` até a parte correspondente existir). A cada parte entregue, o `etapa2_…` perde o `#[ignore]`
//! e o `hoje_…` sai (o comportamento que ele provava não existe mais); os que restam são as partes por vir.
//!
//! Só o que o `store` alcança entra aqui: `AppHandle` não se simula nos testes. A entrada de hoje de
//! `team::deliver_to_thread` é `begin_direct`, ou seja, `admit(.., Delivering)`; o helper
//! [`como_o_deliver_to_thread_grava`] a repete, e na etapa 2 passa a chamar o ponto de entrada novo.

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

/// O que `deliver_to_thread` grava ao receber uma mensagem para uma conversa: entra na fila (`queued`) e o
/// consumidor da conversa a leva (etapa 2; antes era `begin_direct`, que admitia já como `delivering`).
fn como_o_deliver_to_thread_grava(conn: &rusqlite::Connection, new: &NewMessage<'_>, now: i64) -> Admission {
    admit(conn, new, State::Queued, now).unwrap()
}

fn entregue(conn: &rusqlite::Connection, new: &NewMessage<'_>, now: i64) -> PeerMessage {
    let m = novo(admit(conn, new, State::Queued, now).unwrap());
    claim(conn, m.id, now).unwrap().unwrap();
    assert!(finish(conn, m.id, true, None, now).unwrap());
    get(conn, m.id).unwrap().unwrap()
}

// ── Item 8: a espera é uma fila por destino ──────────────────────────

#[test]
fn a_espera_pelo_turno_da_conversa_e_uma_fila_em_ordem() {
    let conn = db();
    let ids: Vec<PeerMessage> = ["um", "dois", "tres"]
        .iter()
        .enumerate()
        .map(|(i, text)| novo(como_o_deliver_to_thread_grava(&conn, &msg("tell", "thread:lead", "thread:t1", text), 1_000 + i as i64)))
        .collect();
    assert_eq!(head(&conn, "thread:t1").unwrap().map(|m| m.id), Some(ids[0].id), "o consumidor único começa pela mais antiga");
    let positions: Vec<i64> = ids.iter().map(|m| m.position).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "posições estritamente crescentes: {positions:?}");
}

// ── Item 2: o reinício não confunde mais espera com digitação ────────

#[test]
fn o_reinicio_devolve_a_fila_a_mensagem_que_ainda_esperava_o_turno() {
    let conn = db();
    let waiting = novo(como_o_deliver_to_thread_grava(&conn, &msg("ask", "thread:lead", "thread:t1", "rode os testes"), 1_000));
    let live: HashSet<String> = ["thread:lead", "thread:t1"].map(String::from).into();
    let targets = resume(&conn, &live, 2_000).unwrap();
    assert_eq!(get(&conn, waiting.id).unwrap().unwrap().state, State::Queued, "ainda não foi enviada: volta a esperar, não vira unconfirmed");
    assert!(targets.contains(&"thread:t1".to_string()), "e o consumidor do destino é religado");
}

// ── Item 10: ask repetido e "Concluído" legítimo ─────────────────────

#[test]
fn o_ask_repetido_devolve_a_mesma_espera() {
    let conn = db();
    let ask = msg("ask", "thread:lead", "thread:t1", "o build passa?");
    let first = novo(como_o_deliver_to_thread_grava(&conn, &ask, 1_000));
    let second = como_o_deliver_to_thread_grava(&conn, &ask, 2_000);
    assert!(
        matches!(&second, Admission::Joined(m) if m.id == first.id),
        "um ask em andamento por remetente+destino: repetir devolve a mesma espera, {second:?}"
    );
    // Nada de recusa gravada: juntar-se à espera não é uma recusa.
    assert!(refusals_from(&conn, "thread:lead", 10).unwrap().is_empty());
}

#[test]
fn o_concluido_depois_de_novo_pedido_passa() {
    let conn = db();
    entregue(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), 1_000);
    entregue(&conn, &msg("tell", "thread:lead", "thread:t1", "agora faça o item B"), 2_000);
    let again = admit(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), State::Queued, 3_000).unwrap();
    assert!(matches!(again, Admission::New(_)), "o destino falou com o remetente no meio: a conversa andou, não é repetição ({again:?})");
}

#[test]
fn o_concluido_repetido_sem_o_destino_ter_falado_continua_recusado() {
    let conn = db();
    entregue(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), 1_000);
    let again = admit(&conn, &msg("tell", "thread:t1", "thread:lead", "Concluído"), State::Queued, 3_000).unwrap();
    assert!(matches!(again, Admission::Duplicate(_)), "{again:?}");
    assert_eq!(refusals_from(&conn, "thread:t1", 10).unwrap().len(), 1, "a recusa 'duplicate' continua gravada");
}

#[test]
fn o_ask_que_ja_teve_resposta_ou_foi_encerrado_nao_junta_a_proxima_pergunta() {
    let conn = db();
    let ask = msg("ask", "thread:lead", "thread:t1", "o build passa?");
    let first = novo(admit(&conn, &ask, State::Queued, 1_000).unwrap());
    assert!(settle_ask(&conn, first.id, 2_000).unwrap());
    assert!(!settle_ask(&conn, first.id, 2_001).unwrap(), "encerrar duas vezes não muda nada");
    assert!(matches!(admit(&conn, &ask, State::Queued, 3_000).unwrap(), Admission::New(m) if m.id != first.id), "encerrado: a pergunta de novo é nova");
}

#[test]
fn o_ask_cuja_resposta_veio_por_tell_tambem_deixa_de_estar_em_andamento() {
    let conn = db();
    let ask = msg("ask", "thread:lead", "thread:t1", "o build passa?");
    novo(admit(&conn, &ask, State::Queued, 1_000).unwrap());
    entregue(&conn, &msg("tell", "thread:t1", "thread:lead", "passa sim"), 2_000);
    assert!(matches!(admit(&conn, &ask, State::Queued, 3_000).unwrap(), Admission::New(_)), "o integrante já respondeu: é outra pergunta");
}

#[test]
fn texto_diferente_ou_outro_destino_nao_se_juntam_e_o_ask_a_terminal_segue_como_antes() {
    let conn = db();
    novo(admit(&conn, &msg("ask", "thread:lead", "thread:t1", "o build passa?"), State::Queued, 1_000).unwrap());
    assert!(matches!(admit(&conn, &msg("ask", "thread:lead", "thread:t1", "e o lint?"), State::Queued, 2_000).unwrap(), Admission::New(_)));
    assert!(matches!(admit(&conn, &msg("ask", "thread:lead", "thread:t2", "o build passa?"), State::Queued, 2_000).unwrap(), Admission::New(_)));
    // Para um terminal, o `ask` direto (reply) continua pulando o dedupe, como antes.
    novo(admit(&conn, &msg("ask", "lead-tab", "tab-1", "pronto?"), State::Delivering, 1_000).unwrap());
    assert!(matches!(admit(&conn, &msg("ask", "lead-tab", "tab-1", "pronto?"), State::Delivering, 2_000).unwrap(), Admission::New(_)));
}
