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

// ── Fila da gravação: teto sem bloquear o produtor ──────────

use super::execution_log::{Destino, Resumo};

fn resumo_texto(ultimo: String, dados: Resumo) -> Option<String> {
    Some(format!("{} omitidos (último: {ultimo})", dados.omitidos))
}

/// Canal de 2 e excedente de atualizações de 2: 4 trabalhos seguem, os outros 6 (chaves novas) são contados. O produtor
/// volta de cada envio (com a fila cheia, bloquear travaria o teste); sem produtor, a fila esvazia e o resumo sai antes
/// de qualquer outro trabalho.
#[test]
fn fila_cheia_nao_bloqueia_o_produtor_e_o_resumo_aparece() {
    let (fila, gravador) = execution_log::fila_com::<String>(2, 2);
    for i in 0..10 {
        assert!(fila.enviar(format!("item-{i}"), Destino::Atualizacao(format!("k{i}"))).is_ok());
    }
    drop(fila);
    let entregues: Vec<String> = (0..4).filter_map(|_| gravador.proximo(resumo_texto)).collect();
    assert_eq!(entregues, ["item-0", "item-1", "item-2", "item-3"]);
    assert_eq!(gravador.proximo(resumo_texto).as_deref(), Some("6 omitidos (último: item-9)"));
}

/// Transição nunca se perde nem sai de ordem; a atualização de chave nova cabe até o teto do excedente.
#[test]
fn trabalho_de_estado_nunca_se_perde_nem_sai_de_ordem() {
    let (fila, gravador) = execution_log::fila_com::<String>(2, 1);
    let envios = [
        ("e0", Destino::Transicao),
        ("b1", Destino::Atualizacao("b1".into())),
        ("e2", Destino::Transicao),
        ("e3", Destino::Transicao),
        ("b4", Destino::Atualizacao("b4".into())),
        ("b5", Destino::Atualizacao("b5".into())),
    ];
    for (texto, destino) in envios {
        assert!(fila.enviar(texto.to_string(), destino).is_ok());
    }
    drop(fila);
    let saida: Vec<String> = (0..5).filter_map(|_| gravador.proximo(resumo_texto)).collect();
    assert_eq!(saida, ["e0", "b1", "e2", "e3", "b4"]);
    assert_eq!(gravador.proximo(resumo_texto).as_deref(), Some("1 omitidos (último: b5)"));
}

/// 10 000 atualizações do mesmo item com a gravação parada: o excedente fica com uma só, a mais recente, e o estado final
/// sai ao destravar. Vale só para atualização de alta frequência; transição não coalesce (ver o teste de transições).
#[test]
fn dez_mil_atualizacoes_do_mesmo_item_deixam_so_a_mais_recente() {
    let (fila, gravador) = execution_log::fila_com::<u32>(2, 2);
    for i in 0..10_000u32 {
        assert!(fila.enviar(i, Destino::Atualizacao("item-1".into())).is_ok());
    }
    assert_eq!(fila.excedente_len(), 1, "uma entrada por chave, com a gravação parada");
    drop(fila);
    let saida: Vec<u32> = (0..3).filter_map(|_| gravador.proximo(|_, _| None)).collect();
    assert_eq!(saida, [0, 1, 9_999], "os dois primeiros foram ao canal; o estado final sai por último");
}

/// Transições que não cabem no canal vão para o excedente, na ordem, sem coalescer e sem perda.
#[test]
fn transicoes_que_nao_cabem_vao_para_o_excedente_sem_perda() {
    let (fila, gravador) = execution_log::fila_com::<String>(1, 1);
    assert!(fila.enviar("primeiro".into(), Destino::Atualizacao("x".into())).is_ok());
    for i in 1..=3 {
        assert!(fila.enviar(format!("pedido-{i}"), Destino::Transicao).is_ok());
    }
    assert!(fila.enviar("resolvido".into(), Destino::Transicao).is_ok());
    assert_eq!(fila.excedente_len(), 4, "toda transição fica no excedente");
    drop(fila);
    let saida: Vec<String> = (0..5).filter_map(|_| gravador.proximo(resumo_texto)).collect();
    assert_eq!(saida, ["primeiro", "pedido-1", "pedido-2", "pedido-3", "resolvido"]);
    assert_eq!(gravador.proximo(resumo_texto), None, "nenhum resumo: nada foi omitido");
}

/// Só a atualização de alta frequência de um item (`item`, `taskItem`) pode coalescer. Toda transição de estado vai para
/// o excedente sem coalescer e sem descartar: pedido, criação, erro, fase, tarefa, meta e fechamento.
#[test]
fn so_atualizacao_de_item_coalesce_e_transicao_nunca() {
    let item = json!({ "item": { "id": "i1" } });
    assert_eq!(execution_log::destino_do_chat("t1", "item", &item), Destino::Atualizacao("chat:t1:item:i1".into()));
    assert_eq!(execution_log::destino_do_chat("t1", "taskItem", &item), Destino::Atualizacao("chat:t1:taskItem:i1".into()));
    let payload = json!({ "id": "p1", "task": { "id": "k1" }, "request": { "id": "p1" } });
    for tipo in ["requestResolved", "created", "error", "task", "request", "phase", "closed", "goal"] {
        assert_eq!(execution_log::destino_do_chat("t1", tipo, &payload), Destino::Transicao, "{tipo} não pode coalescer nem sair");
    }
}

/// O resumo da fila vira uma entrada do log (`log.omitted`) na conversa a que pertencia o último omitido.
#[test]
fn o_resumo_de_omitidos_vira_entrada_do_log() {
    let conn = crate::database::test_db();
    crate::conversa::store::insert_thread(
        &conn,
        "t1",
        "codex",
        "/tmp/p",
        "Título",
        &crate::conversa::store::Tuning { model: None, effort: None, access: "ask".into() },
        None,
        1,
    )
    .unwrap();
    execution_log::record_chat_event(&conn, "t1", "logOmitted", &json!({ "omitidos": 6 })).unwrap();
    let (kind, payload): (String, String) = conn
        .query_row(
            "SELECT kind, payload_json FROM harness_execution_events WHERE thread_id = 't1' AND kind = 'log.omitted'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kind, "log.omitted");
    assert!(payload.contains("\"omitidos\":6"), "{payload}");
}

/// Anota o que o sink de conversa recebe: a publicação de conclusão (com o `logged`) e as árvores que mudaram.
struct Publicacao<'a> {
    saidas: &'a RefCell<Vec<String>>,
}

impl LogSink for Publicacao<'_> {
    fn changed(&mut self, changes: Vec<TreeChanged>) {
        let ids: Vec<String> = changes.iter().map(|c| c.thread_id.clone()).collect();
        self.saidas.borrow_mut().push(format!("arvore:{}", ids.join(",")));
    }
    fn failed(&mut self, _signal: Value) {}
    fn conversation(&mut self, ui: &Value, logged: bool) {
        self.saidas.borrow_mut().push(format!("conversa:{}:{logged}", ui["type"].as_str().unwrap_or_default()));
    }
}

/// Canal cheio com um `requestResolved`, um `error` e um `created` atrás: os três saem ao destravar, com o id, e cada um
/// grava o que deve gravar. O `requestResolved` (conclusão) também sai para o barramento, e o `created` com pai atualiza
/// o cursor da conversa pai. Nenhum deles pode ser omitido.
#[test]
fn requestresolved_error_e_created_sao_gravados_com_id_ao_destravar() {
    let db = db();
    {
        let conn = db.lock().unwrap();
        for id in ["t1", "t2"] {
            crate::conversa::store::insert_thread(
                &conn,
                id,
                "codex",
                "/tmp/p",
                "Título",
                &crate::conversa::store::Tuning { model: None, effort: None, access: "ask".into() },
                None,
                1,
            )
            .unwrap();
        }
    }
    let (fila, gravador) = execution_log::fila_com::<(String, Value)>(1, 1);
    // O canal de 1 fica com a fase; os três seguintes não cabem nele.
    assert!(fila.enviar(("phase".into(), json!({ "phase": "working" })), Destino::Transicao).is_ok());
    assert!(fila.enviar(("requestResolved".into(), json!({ "id": "p1" })), Destino::Transicao).is_ok());
    assert!(fila.enviar(("error".into(), json!({ "message": "falhou" })), Destino::Transicao).is_ok());
    assert!(
        fila.enviar(
            ("created".into(), json!({ "thread": { "id": "t2", "agentId": "codex", "title": "filha", "parentRef": "thread:t1" } })),
            Destino::Transicao,
        )
        .is_ok()
    );
    drop(fila);
    let saidas: Vec<(String, Value)> = (0..4).filter_map(|_| gravador.proximo(|_, _| None)).collect();
    assert_eq!(saidas.iter().map(|(tipo, _)| tipo.as_str()).collect::<Vec<_>>(), ["phase", "requestResolved", "error", "created"]);

    let publicados = RefCell::new(Vec::new());
    for (tipo, payload) in &saidas[1..] {
        // Como o `emit` manda: a conversa do evento é a que o emitiu (o `created` sai da filha), e só a conclusão leva a
        // UI para a publicação; os outros só gravam.
        let conversa = if tipo == "created" { "t2" } else { "t1" };
        let ui = json!({ "threadId": conversa, "type": tipo, "id": payload.get("id") });
        let ui_publicada = (tipo == "requestResolved").then_some(&ui);
        let job = ChatJob { thread_id: conversa, event_type: tipo, payload, ui: ui_publicada };
        execution_log::settle_chat_with(
            &db,
            &job,
            1_000,
            |conn| execution_log::persist_chat_event(conn, conversa, tipo, payload),
            &mut Publicacao { saidas: &publicados },
        );
    }
    assert!(publicados.borrow().contains(&"conversa:requestResolved:true".to_string()), "{:?}", publicados.borrow());
    assert!(publicados.borrow().contains(&"arvore:t2,t1".to_string()), "a criação com pai atualiza o cursor da pai: {:?}", publicados.borrow());

    let conn = db.lock().unwrap();
    let id_do_pedido: String = conn
        .query_row("SELECT entity_id FROM harness_execution_events WHERE kind = 'request.resolved'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(id_do_pedido, "p1");
    for kind in ["turn.error", "thread.created", "child_thread.created"] {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM harness_execution_events WHERE kind = ?1", [kind], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 1, "{kind} tem que estar gravado");
    }
}
