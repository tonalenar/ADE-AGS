//! Testes do Parar com recibo idempotente (Fase 2, contrato §11.11). Sem processo, sem provider e sem relógio:
//! o `execute` é um motor de mentira que conta as chamadas e as interrupções que de fato mandou, e o `agora`
//! é um número.

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use super::api::Interrupted;
use super::stop_receipt::{self, LEASE_MS, Reserved, StopReceipt};
use crate::database::DbConnection;
use crate::harness::receipts::{self, CommandIdentity, MISMATCH, ReceiptState};

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

fn id(request: &str) -> CommandIdentity {
    stop_receipt::identity("ui", request, "t1").unwrap()
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

/// O motor de mentira: `chamadas` conta as vezes em que o Parar chegou ao motor; `interrupcoes`, só as em que
/// ele de fato mandou a interrupção (`Sent`). Um `Pending` (Codex) segura a parada, e `NoTurn` não manda nada.
#[derive(Default)]
struct Motor {
    chamadas: Cell<u32>,
    interrupcoes: Cell<u32>,
}

impl Motor {
    fn responde(&self, answer: Result<Interrupted, String>) -> impl std::future::Future<Output = Result<Interrupted, String>> + '_ {
        self.chamadas.set(self.chamadas.get() + 1);
        if let Ok(Interrupted::Sent) = &answer {
            self.interrupcoes.set(self.interrupcoes.get() + 1);
        }
        async move { answer }
    }
}

fn stop(db: &DbConnection, identity: &CommandIdentity, thread: &str, now: i64, motor: &Motor, answer: Result<Interrupted, String>) -> Result<StopReceipt, String> {
    block_on(stop_receipt::run(db, identity, thread, "dono-1", &|| now, || motor.responde(answer)))
}

fn receipt_state(db: &DbConnection, identity: &CommandIdentity) -> ReceiptState {
    let conn = db.lock().unwrap();
    receipts::lookup(&conn, &identity.kind, &identity.caller_key, &identity.request_id)
        .unwrap()
        .unwrap()
        .state
}

#[test]
fn um_parar_repetido_nao_manda_outra_interrupcao() {
    let db = db();
    let motor = Motor::default();
    let identity = id("p1");
    let first = stop(&db, &identity, "t1", 1_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (first.delivery_state.as_str(), first.outcome.as_deref(), first.replayed, first.sent),
        ("accepted", Some("sent"), false, true)
    );
    let again = stop(&db, &identity, "t1", 2_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (again.delivery_state.as_str(), again.outcome.as_deref(), again.replayed, again.sent),
        ("accepted", Some("sent"), true, false)
    );
    assert!(again.note.is_some());
    assert_eq!(motor.interrupcoes.get(), 1, "o agente recebeu uma interrupção só");
    assert_eq!(motor.chamadas.get(), 1, "a repetição nem chegou ao motor");
}

#[test]
fn um_parar_depois_do_fim_do_turno_devolve_o_recibo_sem_efeito() {
    let db = db();
    let motor = Motor::default();
    // Não há turno: o motor responde `NoTurn` sem mandar nada ao agente.
    let receipt = stop(&db, &id("p2"), "t1", 1_000, &motor, Ok(Interrupted::NoTurn)).unwrap();
    assert_eq!(
        (receipt.delivery_state.as_str(), receipt.outcome.as_deref(), receipt.sent),
        ("accepted", Some("no_turn"), false)
    );
    assert!(receipt.note.as_deref().is_some_and(|note| note.contains("nada")));
    // A repetição, mesmo que o motor respondesse `Sent` agora, não chega a ele e devolve o desfecho gravado.
    let again = stop(&db, &id("p2"), "t1", 2_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (again.outcome.as_deref(), again.replayed, again.sent),
        (Some("no_turn"), true, false)
    );
    assert_eq!(motor.interrupcoes.get(), 0, "nenhuma interrupção saiu para o agente");
    assert_eq!(motor.chamadas.get(), 1);
}

#[test]
fn o_parar_pendente_do_codex_fica_aceito_e_nao_sai_agora() {
    let db = db();
    let motor = Motor::default();
    let identity = id("p3");
    let receipt = stop(&db, &identity, "t1", 1_000, &motor, Ok(Interrupted::Pending)).unwrap();
    assert_eq!(
        (receipt.delivery_state.as_str(), receipt.outcome.as_deref(), receipt.sent),
        ("accepted", Some("deferred"), false)
    );
    assert!(receipt.note.as_deref().is_some_and(|note| note.contains("pendente")));
    assert_eq!(motor.interrupcoes.get(), 0, "o Codex segura a parada até o turno abrir");
    let again = stop(&db, &identity, "t1", 2_000, &motor, Ok(Interrupted::Pending)).unwrap();
    assert_eq!((again.replayed, again.outcome.as_deref()), (true, Some("deferred")));
    assert_eq!(motor.chamadas.get(), 1);
}

#[test]
fn um_erro_do_motor_deixa_o_recibo_unknown_e_a_repeticao_nao_interrompe_de_novo() {
    let db = db();
    let motor = Motor::default();
    let identity = id("p4");
    let error = stop(&db, &identity, "t1", 1_000, &motor, Err("resposta do agente perdida".into())).unwrap_err();
    assert_eq!(error, "resposta do agente perdida");
    assert_eq!(receipt_state(&db, &identity), ReceiptState::Unknown);
    let again = stop(&db, &identity, "t1", 2_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (again.delivery_state.as_str(), again.outcome.as_deref(), again.replayed, again.sent),
        ("unknown", None, true, false)
    );
    assert!(again.note.is_some_and(|note| note.contains("confira")));
    assert_eq!(motor.chamadas.get(), 1, "um desfecho desconhecido nunca se repete às cegas");
}

#[test]
fn o_mesmo_id_em_outra_conversa_falha_fechado_sem_parar_nada() {
    let db = db();
    let motor = Motor::default();
    stop(&db, &id("p5"), "t1", 1_000, &motor, Ok(Interrupted::Sent)).unwrap();
    let other = stop_receipt::identity("ui", "p5", "t2").unwrap();
    assert_eq!(
        stop(&db, &other, "t2", 2_000, &motor, Ok(Interrupted::Sent)).unwrap_err(),
        MISMATCH
    );
    assert_eq!(motor.interrupcoes.get(), 1);
}

#[test]
fn ids_diferentes_sao_paradas_diferentes_e_escopos_diferentes_podem_usar_o_mesmo_id() {
    let db = db();
    let motor = Motor::default();
    stop(&db, &id("p6a"), "t1", 1_000, &motor, Ok(Interrupted::Sent)).unwrap();
    stop(&db, &id("p6b"), "t1", 2_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(motor.interrupcoes.get(), 2, "um Parar novo é um comando novo");
    let by_tab = stop_receipt::identity("tab:a", "p7", "t1").unwrap();
    let by_other_tab = stop_receipt::identity("tab:b", "p7", "t1").unwrap();
    stop(&db, &by_tab, "t1", 3_000, &motor, Ok(Interrupted::Sent)).unwrap();
    stop(&db, &by_other_tab, "t1", 4_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(motor.interrupcoes.get(), 4, "o escopo de quem chamou faz parte da chave");
}

#[test]
fn um_parar_com_lease_vivo_devolve_submitting_sem_interromper() {
    let db = db();
    let identity = id("p8");
    stop_receipt::accept(&db, &identity, "t1", 1_000).unwrap();
    // O dono 1 reclamou o efeito e ainda não terminou.
    assert!(matches!(
        stop_receipt::reserve(&db, &identity, "dono-1", 1_000).unwrap(),
        Reserved::Owner { .. }
    ));
    let motor = Motor::default();
    let receipt = stop(&db, &identity, "t1", 2_000, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (receipt.delivery_state.as_str(), receipt.replayed, receipt.sent),
        ("submitting", true, false)
    );
    assert_eq!(motor.chamadas.get(), 0, "outro Parar em andamento: esta chamada não toca no motor");
}

#[test]
fn um_lease_vencido_vira_unknown_e_nao_interrompe_de_novo() {
    let db = db();
    let identity = id("p9");
    stop_receipt::accept(&db, &identity, "t1", 1_000).unwrap();
    assert!(matches!(
        stop_receipt::reserve(&db, &identity, "dono-morto", 1_000).unwrap(),
        Reserved::Owner { .. }
    ));
    let motor = Motor::default();
    let receipt = stop(&db, &identity, "t1", 1_000 + LEASE_MS + 1, &motor, Ok(Interrupted::Sent)).unwrap();
    assert_eq!(
        (receipt.delivery_state.as_str(), receipt.replayed, receipt.sent),
        ("unknown", true, false)
    );
    assert_eq!(motor.chamadas.get(), 0, "o dono morto pode ter interrompido: não se repete às cegas");
}

#[test]
fn o_id_do_parar_e_validado_e_obrigatorio_quando_vem() {
    assert!(stop_receipt::identity("ui", "   ", "t1").is_err());
    assert!(stop_receipt::identity("ui", &"x".repeat(129), "t1").is_err());
    assert!(stop_receipt::identity("ui", "a\u{7}b", "t1").is_err());
    assert_eq!(stop_receipt::identity("ui", " p ", "t1").unwrap().request_id, "p");
}
