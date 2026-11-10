//! Testes do envio com recibo idempotente (Fase 2, contrato §11.7). Sem provider, sem processo e sem
//! relógio: o `execute` é um contador e o `agora` é um número.

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use super::envio::SendError;
use super::send_receipt::{self, LEASE_MS, Reserved, SendReceipt};
use crate::database::DbConnection;
use crate::harness::effects::{self, EffectState};
use crate::harness::receipts::{self, CommandIdentity, MISMATCH, ReceiptState};

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

fn id(request: &str, text: &str) -> CommandIdentity {
    send_receipt::identity("ui", request, "t1", text, &[]).unwrap()
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
}

fn run(db: &DbConnection, identity: &CommandIdentity, now: i64, calls: &Cell<u32>, outcome: Result<(), SendError>) -> Result<SendReceipt, String> {
    block_on(send_receipt::run(db, identity, "t1", "dono-1", &|| now, || {
        calls.set(calls.get() + 1);
        async move { outcome }
    }))
}

fn receipt_state(db: &DbConnection, identity: &CommandIdentity) -> ReceiptState {
    let conn = db.lock().unwrap();
    receipts::lookup(&conn, &identity.kind, &identity.caller_key, &identity.request_id).unwrap().unwrap().state
}

#[test]
fn um_reenvio_identico_devolve_o_recibo_sem_mandar_a_mensagem_de_novo() {
    let db = db();
    let calls = Cell::new(0);
    let identity = id("r1", "oi");
    let first = run(&db, &identity, 1_000, &calls, Ok(())).unwrap();
    assert_eq!((first.delivery_state.as_str(), first.replayed, first.sent), ("accepted", false, true));
    let again = run(&db, &identity, 2_000, &calls, Ok(())).unwrap();
    assert_eq!((again.delivery_state.as_str(), again.replayed, again.sent), ("accepted", true, false));
    assert!(again.note.is_some());
    assert_eq!(calls.get(), 1, "o provider recebeu a mensagem uma vez");
}

#[test]
fn o_mesmo_id_com_texto_diferente_falha_fechado_sem_enviar() {
    let db = db();
    let calls = Cell::new(0);
    run(&db, &id("r1", "oi"), 1_000, &calls, Ok(())).unwrap();
    let error = run(&db, &id("r1", "outra coisa"), 2_000, &calls, Ok(())).unwrap_err();
    assert_eq!(error, MISMATCH);
    assert_eq!(calls.get(), 1);
}

#[test]
fn o_mesmo_id_em_outra_conversa_tambem_falha_fechado() {
    let db = db();
    let calls = Cell::new(0);
    run(&db, &id("r1", "oi"), 1_000, &calls, Ok(())).unwrap();
    let other = send_receipt::identity("ui", "r1", "t2", "oi", &[]).unwrap();
    assert_eq!(run(&db, &other, 2_000, &calls, Ok(())).unwrap_err(), MISMATCH);
}

#[test]
fn chamadores_diferentes_podem_usar_o_mesmo_id() {
    let db = db();
    let calls = Cell::new(0);
    run(&db, &send_receipt::identity("tab:a", "r1", "t1", "oi", &[]).unwrap(), 1_000, &calls, Ok(())).unwrap();
    run(&db, &send_receipt::identity("tab:b", "r1", "t1", "oi", &[]).unwrap(), 1_000, &calls, Ok(())).unwrap();
    assert_eq!(calls.get(), 2);
}

#[test]
fn falha_antes_de_sair_deixa_o_recibo_retryable_e_a_repeticao_envia_uma_vez() {
    let db = db();
    let calls = Cell::new(0);
    let identity = id("r1", "oi");
    let error = run(&db, &identity, 1_000, &calls, Err(SendError::NotSent("a sessão não abriu".into()))).unwrap_err();
    assert_eq!(error, "a sessão não abriu");
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Retryable);
    let retried = run(&db, &identity, 2_000, &calls, Ok(())).unwrap();
    assert_eq!((retried.delivery_state.as_str(), retried.replayed, retried.sent), ("accepted", false, true));
    assert_eq!(calls.get(), 2, "a primeira nunca saiu; a segunda é o único envio");
    assert_eq!(run(&db, &identity, 3_000, &calls, Ok(())).unwrap().replayed, true);
    assert_eq!(calls.get(), 2);
}

#[test]
fn desfecho_desconhecido_nunca_e_repetido_as_cegas() {
    let db = db();
    let calls = Cell::new(0);
    let identity = id("r1", "oi");
    let error = run(&db, &identity, 1_000, &calls, Err(SendError::Unknown("a resposta se perdeu".into()))).unwrap_err();
    assert!(error.contains("a resposta se perdeu"));
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Unknown);
    let again = run(&db, &identity, 2_000, &calls, Ok(())).unwrap();
    assert_eq!((again.delivery_state.as_str(), again.replayed, again.sent), ("unknown", true, false));
    assert!(again.note.unwrap().contains("confira a conversa"));
    assert_eq!(calls.get(), 1);
}

#[test]
fn a_mensagem_do_provider_nao_vai_para_o_banco() {
    let db = db();
    let calls = Cell::new(0);
    let identity = id("r1", "oi");
    run(&db, &identity, 1_000, &calls, Err(SendError::Unknown("o agente disse SEGREDO-123".into()))).unwrap_err();
    let conn = db.lock().unwrap();
    let error: Option<String> = conn.query_row("SELECT last_error FROM harness_effect", [], |r| r.get(0)).unwrap();
    assert_eq!(error.as_deref(), Some("outcome_unknown"));
    let dump: String = conn
        .query_row(
            "SELECT group_concat(coalesce(result_json,'') || target_ref || request_hash) FROM harness_command_receipt",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!dump.contains("SEGREDO") && !dump.contains("oi "), "{dump}");
}

#[test]
fn queda_depois_de_aceitar_e_antes_de_reclamar_e_recuperavel() {
    let db = db();
    let identity = id("r1", "oi");
    send_receipt::accept(&db, &identity, "t1", 1_000).unwrap();
    // O processo caiu aqui: intenção e efeito pending gravados, nada reclamado nem enviado.
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Prepared);
    let calls = Cell::new(0);
    let done = run(&db, &identity, 5_000, &calls, Ok(())).unwrap();
    assert_eq!((done.delivery_state.as_str(), done.sent), ("accepted", true));
    assert_eq!(calls.get(), 1);
    let rows: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM harness_effect", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "o efeito é um só");
}

#[test]
fn queda_depois_de_reclamar_com_o_lease_vivo_nao_reenvia_e_vencido_vira_unknown() {
    let db = db();
    let identity = id("r1", "oi");
    send_receipt::accept(&db, &identity, "t1", 1_000).unwrap();
    let reserved = send_receipt::reserve(&db, &identity, "dono-morto", 1_000).unwrap();
    assert!(matches!(reserved, Reserved::Owner { .. }));
    // O processo caiu depois do claim: o efeito pode ou não ter saído.
    let calls = Cell::new(0);
    let during = run(&db, &identity, 1_000 + LEASE_MS - 1, &calls, Ok(())).unwrap();
    assert_eq!((during.delivery_state.as_str(), during.replayed), ("submitting", true));
    let after = run(&db, &identity, 1_000 + LEASE_MS, &calls, Ok(())).unwrap();
    assert_eq!((after.delivery_state.as_str(), after.replayed, after.sent), ("unknown", true, false));
    assert_eq!(calls.get(), 0, "nunca repete às cegas");
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Unknown);
    let effect = effects::get(&db.lock().unwrap(), 1).unwrap().unwrap();
    assert_eq!((effect.state, effect.outcome_unknown), (EffectState::Failed, true));
}

#[test]
fn o_dono_que_volta_depois_do_lease_vencido_ainda_conclui_o_recibo() {
    let db = db();
    let identity = id("r1", "oi");
    send_receipt::accept(&db, &identity, "t1", 1_000).unwrap();
    let Reserved::Owner { effect_id } = send_receipt::reserve(&db, &identity, "dono-lento", 1_000).unwrap() else { panic!() };
    let calls = Cell::new(0);
    assert_eq!(run(&db, &identity, 1_000 + LEASE_MS, &calls, Ok(())).unwrap().delivery_state, "unknown");
    // O dono lento termina e prova que o provider aceitou.
    let state = send_receipt::finish(&db, &identity, effect_id, "dono-lento", &Ok(()), 1_000 + LEASE_MS + 5).unwrap();
    assert_eq!(state, ReceiptState::Accepted);
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Accepted);
}

#[test]
fn o_id_vazio_ou_enorme_e_recusado_antes_de_gravar() {
    assert!(send_receipt::identity("ui", "  ", "t1", "oi", &[]).is_err());
    assert!(send_receipt::identity("ui", &"x".repeat(129), "t1", "oi", &[]).is_err());
}

#[test]
fn imagens_diferentes_mudam_o_hash() {
    let a = send_receipt::identity("ui", "r1", "t1", "oi", &[]).unwrap();
    let b = send_receipt::identity("ui", "r1", "t1", "oi", &["/x.png".to_string()]).unwrap();
    assert_ne!(a.request_hash, b.request_hash);
}

#[test]
fn o_recibo_serializa_em_camel_case_sem_nota_vazia() {
    let receipt = SendReceipt { request_id: "r1".into(), delivery_state: "accepted".into(), replayed: false, sent: true, note: None };
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        serde_json::json!({ "requestId": "r1", "deliveryState": "accepted", "replayed": false, "sent": true })
    );
}
