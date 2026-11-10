//! O núcleo comum dos recibos (`harness::command`). Os testes de cada comando (`send_receipt_test`,
//! `stop_receipt_test`) provam o comportamento de envio e de Parar. Aqui ficam as garantias do que é compartilhado:
//! a chave e o hash do pedido (recibos já gravados dependem deles) e a forma de um comando novo entrar no núcleo.

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::command::{self, ReceiptCommand, Settlement, Spec};
use super::receipts::{self, CommandIdentity, CommandReceipt, ReceiptState};
use crate::conversa::{send_receipt, stop_receipt};
use crate::database::DbConnection;

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
}

#[test]
fn a_chave_e_o_hash_do_pedido_nao_mudam_entre_versoes() {
    // Recibos gravados antes do núcleo comum batem por estes valores: se algum mudar, o mesmo `client_request_id`
    // volta a falhar com `MISMATCH` depois de uma atualização.
    let send = send_receipt::identity("ui", "r1", "t1", "oi", &[]).unwrap();
    assert_eq!(send.kind, "chat_send");
    assert_eq!(send.caller_key, "chat-send:2a10de19e9dd20b0afdd40f052013100c24f08260bdb3c686ba04dce8faa3929");
    assert_eq!(send.request_hash, "9d8d1f4bf4f6e7bda7708d663bb77f9deaa28d8e08b68d6e03996bcfddeccdde");
    let stop = stop_receipt::identity("ui", "p1", "t1").unwrap();
    assert_eq!(stop.kind, "chat_interrupt");
    assert_eq!(stop.caller_key, "chat-interrupt:2a10de19e9dd20b0afdd40f052013100c24f08260bdb3c686ba04dce8faa3929");
    assert_eq!(stop.request_hash, "995ebbeccd56afae36abfb224f5a3effa5adc12d22d392b8fe47497a4d1d1935");
}

/// Um comando de mentira, com o próprio efeito e as próprias respostas. Prova que o núcleo não depende de envio.
struct Eco;

impl ReceiptCommand for Eco {
    type Output = ();
    type Error = String;
    type Reply = (String, bool);
    const SPEC: Spec = Spec { effect_kind: "eco_teste", max_attempts: 2, lease_ms: 1_000, label: "eco" };

    fn settle(result: &Result<(), String>) -> Settlement {
        match result {
            Ok(()) => Settlement::Applied { result_json: None },
            Err(_) => Settlement::NotApplied,
        }
    }

    fn replay(receipt: &CommandReceipt) -> (String, bool) {
        (receipt.state.as_str().to_string(), true)
    }

    fn reply(_identity: &CommandIdentity, state: ReceiptState, result: Result<(), String>) -> Result<(String, bool), String> {
        result.map(|()| (state.as_str().to_string(), false))
    }
}

fn eco(request: &str) -> CommandIdentity {
    command::identity("eco_teste", "eco", "ui", request, &json!({ "x": 1 })).unwrap()
}

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

#[test]
fn um_comando_novo_executa_uma_vez_e_repete_pelo_recibo() {
    let db = db();
    let calls = Cell::new(0);
    let identity = eco("e1");
    let run = |now: i64| {
        block_on(command::run::<Eco, _, _>(&db, &identity, "alvo", "dono", &|| now, || {
            calls.set(calls.get() + 1);
            async { Ok(()) }
        }))
    };
    assert_eq!(run(1_000).unwrap(), ("accepted".to_string(), false));
    assert_eq!(run(2_000).unwrap(), ("accepted".to_string(), true));
    assert_eq!(calls.get(), 1, "o efeito roda uma vez; a repetição vem do recibo");
}

#[test]
fn um_desfecho_que_nao_saiu_deixa_o_recibo_retryable_e_a_repeticao_executa() {
    let db = db();
    let calls = Cell::new(0);
    let identity = eco("e2");
    let failing = block_on(command::run::<Eco, _, _>(&db, &identity, "alvo", "dono", &|| 1_000, || {
        calls.set(calls.get() + 1);
        async { Err("nada saiu".to_string()) }
    }));
    assert_eq!(failing.unwrap_err(), "nada saiu");
    let state = {
        let conn = db.lock().unwrap();
        receipts::lookup(&conn, &identity.kind, &identity.caller_key, &identity.request_id).unwrap().unwrap().state
    };
    assert_eq!(state, ReceiptState::Retryable);
    let retried = block_on(command::run::<Eco, _, _>(&db, &identity, "alvo", "dono", &|| 2_000, || {
        calls.set(calls.get() + 1);
        async { Ok(()) }
    }));
    assert_eq!(retried.unwrap(), ("accepted".to_string(), false));
    assert_eq!(calls.get(), 2, "a primeira nunca saiu; a segunda é o único envio bem-sucedido");
}
