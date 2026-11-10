//! Testes das falhas de gravação do log de execução (Fase 2, contrato §11.11). Sem app, sem processo e sem
//! relógio: a gravação é uma closure que falha ou passa, o `agora` é um número, e o que sairia para a janela e
//! para o barramento vai para um gravador, na ordem em que sairia.

use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::execution_log::{self, ChatJob, FailedWrite, LogSink, Settled, TreeChanged};
use crate::database::DbConnection;

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

/// Quantas falhas ainda estão abertas (sem gravação posterior).
fn abertas(db: &DbConnection) -> i64 {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT COUNT(*) FROM harness_log_failure WHERE resolved_at IS NULL", [], |row| row.get(0))
        .unwrap()
}

/// Anota, em ordem, o que a fila entregaria à janela e ao barramento.
struct Gravador<'a> {
    saidas: &'a RefCell<Vec<String>>,
}

impl LogSink for Gravador<'_> {
    fn changed(&mut self, changes: Vec<TreeChanged>) {
        self.saidas.borrow_mut().push(format!("arvore:{}", changes.len()));
    }
    fn failed(&mut self, signal: Value) {
        self.saidas.borrow_mut().push(format!("falha:{}", signal["error"].as_str().unwrap_or_default()));
    }
    fn conversation(&mut self, ui: &Value, logged: bool) {
        self.saidas.borrow_mut().push(format!("conversa:{}:{logged}", ui["phase"].as_str().unwrap_or_default()));
    }
}

/// Guarda os sinais de falha inteiros, como a UI e o barramento os recebem.
struct Captura {
    sinais: RefCell<Vec<Value>>,
}

impl LogSink for Captura {
    fn changed(&mut self, _changes: Vec<TreeChanged>) {}
    fn failed(&mut self, signal: Value) {
        self.sinais.borrow_mut().push(signal);
    }
    fn conversation(&mut self, _ui: &Value, _logged: bool) {}
}

fn job<'a>(payload: &'a Value, ui: &'a Value) -> ChatJob<'a> {
    ChatJob { thread_id: "t1", event_type: "phase", payload, ui: Some(ui) }
}

#[test]
fn uma_falha_de_gravacao_vira_sinal_visivel_e_fica_aberta_para_repetir() {
    let db = db();
    let payload = json!({ "phase": "idle" });
    let ui = json!({ "threadId": "t1", "type": "phase", "phase": "idle" });
    let saidas = RefCell::new(Vec::new());
    execution_log::settle_chat_with(&db, &job(&payload, &ui), 1_000, |_| Err("disco cheio".into()), &mut Gravador { saidas: &saidas });
    assert_eq!(*saidas.borrow(), ["falha:disco cheio", "conversa:idle:false"]);
    assert_eq!(abertas(&db), 1, "a falha fica registrada até alguém regravar o evento");
}

#[test]
fn a_conclusao_sai_so_depois_da_tentativa_de_gravacao() {
    let db = db();
    let payload = json!({ "phase": "idle" });
    let ui = json!({ "threadId": "t1", "type": "phase", "phase": "idle" });
    let saidas = RefCell::new(Vec::new());
    execution_log::settle_chat_with(
        &db,
        &job(&payload, &ui),
        1_000,
        |_| {
            saidas.borrow_mut().push("gravou".into());
            Ok(Vec::new())
        },
        &mut Gravador { saidas: &saidas },
    );
    assert_eq!(*saidas.borrow(), ["gravou", "conversa:idle:true"], "a gravação vem antes da conclusão");
    assert_eq!(abertas(&db), 0);
}

#[test]
fn uma_falha_passageira_se_repete_antes_de_virar_falha() {
    let db = db();
    let calls = Cell::new(0);
    let settled = execution_log::persist_settled(&db, |_| {
        calls.set(calls.get() + 1);
        if calls.get() == 1 { Err("database is locked".into()) } else { Ok(Vec::new()) }
    });
    assert!(matches!(settled, Settled::Persisted(_)), "{settled:?}");
    assert_eq!(calls.get(), 2);
    assert_eq!(abertas(&db), 0, "uma falha que passou na repetição não deixa registro");
}

#[test]
fn uma_falha_que_persiste_vira_falha_depois_de_tres_tentativas() {
    let db = db();
    let calls = Cell::new(0);
    let settled = execution_log::persist_settled(&db, |_| {
        calls.set(calls.get() + 1);
        Err("database is locked".into())
    });
    assert_eq!(calls.get(), 3);
    match settled {
        Settled::Failed { error, attempts } => assert_eq!((error.as_str(), attempts), ("database is locked", 3)),
        other => panic!("esperava falha, veio {other:?}"),
    }
}

#[test]
fn um_evento_de_conversa_apagada_nao_vira_falha() {
    let db = db();
    let calls = Cell::new(0);
    let settled = execution_log::persist_settled(&db, |_| {
        calls.set(calls.get() + 1);
        Err("FOREIGN KEY constraint failed".into())
    });
    assert!(matches!(settled, Settled::Orphan), "{settled:?}");
    assert_eq!(calls.get(), 1, "uma chave estrangeira não se repete: a conversa sumiu");
    assert_eq!(abertas(&db), 0, "não há o que recuperar");
}

#[test]
fn o_erro_guardado_nao_leva_segredo_do_provedor() {
    let db = db();
    let settled = execution_log::persist_settled(&db, |_| Err("falhou com token sk-abcdefghijklmnop123456".into()));
    let Settled::Failed { error, .. } = settled else {
        panic!("esperava falha");
    };
    assert!(!error.contains("sk-abc"), "{error}");
    assert!(error.contains("[redigido]"), "{error}");
}

#[test]
fn o_sinal_de_falha_leva_o_que_a_tela_e_o_harness_precisam() {
    let db = db();
    let payload = json!({ "phase": "idle" });
    let ui = json!({ "threadId": "t1", "type": "phase", "phase": "idle" });
    let captura = RefCell::new(Captura { sinais: RefCell::new(Vec::new()) });
    execution_log::settle_chat_with(&db, &job(&payload, &ui), 1_000, |_| Err("disco cheio".into()), &mut *captura.borrow_mut());
    let captura = captura.borrow();
    let sinais = captura.sinais.borrow();
    let sinal = &sinais[0];
    assert_eq!(sinal["scope"], "chat");
    assert_eq!(sinal["threadId"], "t1");
    assert_eq!(sinal["eventType"], "phase");
    assert_eq!(sinal["attempts"], 3);
    assert!(sinal["failureId"].as_i64().is_some(), "{sinal}");
}

#[test]
fn o_replay_regrava_o_evento_pendente_e_o_marca_como_resolvido() {
    let db = db();
    let payload = json!({ "phase": "idle" });
    let ui = json!({ "threadId": "t1", "type": "phase", "phase": "idle" });
    let saidas = RefCell::new(Vec::new());
    execution_log::settle_chat_with(&db, &job(&payload, &ui), 1_000, |_| Err("disco cheio".into()), &mut Gravador { saidas: &saidas });
    assert_eq!(abertas(&db), 1);
    let regravados = RefCell::new(Vec::new());
    let changes = execution_log::replay_chat_failures(&db, 2_000, |_, thread, kind, saved| {
        regravados.borrow_mut().push((thread.to_string(), kind.to_string(), saved.clone()));
        Ok(Vec::new())
    });
    assert!(changes.is_empty());
    assert_eq!(*regravados.borrow(), vec![("t1".to_string(), "phase".to_string(), json!({ "phase": "idle" }))]);
    assert_eq!(abertas(&db), 0, "regravado: a linha sai das pendências");
}

#[test]
fn o_replay_que_ainda_falha_mantem_a_pendencia_e_conta_as_tentativas() {
    let db = db();
    let payload = json!({ "phase": "idle" });
    let ui = json!({ "threadId": "t1", "type": "phase", "phase": "idle" });
    let saidas = RefCell::new(Vec::new());
    execution_log::settle_chat_with(&db, &job(&payload, &ui), 1_000, |_| Err("disco cheio".into()), &mut Gravador { saidas: &saidas });
    execution_log::replay_chat_failures(&db, 2_000, |_, _, _, _| Err("disco cheio".into()));
    assert_eq!(abertas(&db), 1);
    let attempts: i64 = db
        .lock()
        .unwrap()
        .query_row("SELECT attempts FROM harness_log_failure", [], |row| row.get(0))
        .unwrap();
    assert_eq!(attempts, 6, "as três da gravação original e as três da repetição");
}

#[test]
fn o_replay_nao_repete_falha_da_frota_que_nao_tem_payload() {
    let db = db();
    let saidas = RefCell::new(Vec::new());
    execution_log::fail_write(
        &db,
        &FailedWrite {
            scope: "fleet",
            thread_id: None,
            task_id: Some("tarefa-1"),
            attempt_id: Some("tentativa-1"),
            event_kind: "toolUse",
            payload_json: None,
            error: "disco cheio",
            attempts: 3,
        },
        1_000,
        &mut Gravador { saidas: &saidas },
    );
    assert_eq!(*saidas.borrow(), ["falha:disco cheio"]);
    assert_eq!(abertas(&db), 1);
    let calls = Cell::new(0);
    execution_log::replay_chat_failures(&db, 2_000, |_, _, _, _| {
        calls.set(calls.get() + 1);
        Ok(Vec::new())
    });
    assert_eq!(calls.get(), 0, "a Frota não guarda payload para repetir: a falha só fica visível");
    assert_eq!(abertas(&db), 1);
}
