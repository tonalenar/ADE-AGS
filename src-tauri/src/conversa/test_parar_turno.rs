//! O Parar que chega enquanto o turno abre, nos motores sem guarda próprio: Claude e OpenCode (contrato §11.11).
//!
//! Sem processo, sem relógio e sem `AppHandle`. A sessão do Claude de teste escreve num receptor; as linhas entram
//! pelas mesmas funções que o laço de leitura usa (`is_turn_line`, `confirm_turn`), e o pedido de controle é
//! respondido pelo próprio teste. O OpenCode guarda o `AppHandle` na sessão, então a corrida dele é provada na
//! camada de decisão (`StopGate`), com a mesma sequência de chamadas que o ACP faz (`opencode.rs`).
//!
//! O que cada teste reproduz: um Parar que chega depois de a mensagem sair e antes de o motor mostrar que o turno
//! roda não pode mandar `interrupt`/`session/cancel` (a captura não prova que pega esse turno), não pode fechar no
//! banco o turno que está abrindo, e não pode se perder: sai no primeiro aviso do turno.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use super::api::{self, Interrupted, NewThread};
use super::claude;
use super::codex_parar::{StopAction, StopGate};
use super::opencode;
use super::store;
use crate::database::DbConnection;

fn banco() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

/// Uma conversa de verdade no banco de teste (a linha do turno tem chave estrangeira para ela).
fn criar_conversa(db: &DbConnection) -> String {
    api::create(
        db,
        NewThread {
            agent_id: "claude-code".into(),
            cwd: "/p".into(),
            workspace_id: None,
            title: "T".into(),
            model: None,
            effort: None,
            access: "ask".into(),
            account_id: None,
            parent_ref: None,
        },
    )
    .unwrap()
    .id
}

fn mensagem(texto: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": texto }] } })
}

/// O que a sessão escreveu até agora, em ordem, já lido.
fn escrito(rx: &mut UnboundedReceiver<String>) -> Vec<Value> {
    std::iter::from_fn(|| rx.try_recv().ok()).map(|line| serde_json::from_str(&line).unwrap()).collect()
}

/// Quantos `interrupt` há nas linhas escritas.
fn interrupts(linhas: &[Value]) -> usize {
    linhas.iter().filter(|m| m["type"] == "control_request" && m["request"]["subtype"] == "interrupt").count()
}

/// O Parar que não pode escrever nada: fica pendente e devolve sem esperar o aviso. Se escrever, o teste falha na
/// hora (sem esperar a resposta que nunca chega).
async fn parar_sem_escrever(thread: &str, rx: &mut UnboundedReceiver<String>) -> Interrupted {
    let stop = api::interrupt(thread);
    tokio::pin!(stop);
    tokio::select! {
        done = &mut stop => done.expect("o Parar pendente não é erro"),
        line = rx.recv() => panic!("o Parar escreveu {line:?} antes do primeiro aviso do turno"),
    }
}

fn status_do_turno(db: &DbConnection, thread: &str, turn: &str) -> String {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT status FROM chat_run WHERE thread_id = ?1 AND id = ?2", [thread, turn], |row| row.get(0))
        .unwrap()
}

// --- Claude -------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn claude_o_parar_logo_depois_de_abrir_o_turno_fica_pendente_e_nao_escreve_nada() {
    let thread = "parar-claude-abrindo";
    let (session, mut rx) = claude::session_for_test(thread);
    let (_turn, opened) = session.send_message(&mensagem("oi")).unwrap();
    assert!(opened, "a primeira mensagem abre o turno");
    assert_eq!(escrito(&mut rx).len(), 1, "só a mensagem saiu");
    assert_eq!(parar_sem_escrever(thread, &mut rx).await, Interrupted::Pending);
    assert!(escrito(&mut rx).is_empty(), "nenhum interrupt antes de o Claude mostrar que o turno roda");
}

#[tokio::test]
async fn claude_o_primeiro_aviso_do_turno_manda_o_interrupt_uma_vez() {
    let thread = "parar-claude-aviso";
    let (session, mut rx) = claude::session_for_test(thread);
    session.send_message(&mensagem("oi")).unwrap();
    escrito(&mut rx);
    assert_eq!(parar_sem_escrever(thread, &mut rx).await, Interrupted::Pending);
    // O Claude começa a rodar a mensagem: a linha `system/status` chega, e a sessão a reconhece como aviso do turno.
    let aviso = json!({ "type": "system", "subtype": "status", "status": "requesting" });
    assert!(claude::is_turn_line(&aviso));
    session.confirm_turn();
    assert_eq!(interrupts(&escrito(&mut rx)), 1, "o Parar pendente sai no primeiro aviso");
    session.confirm_turn();
    assert_eq!(interrupts(&escrito(&mut rx)), 0, "o mesmo Parar não sai de novo");
}

#[tokio::test]
async fn claude_depois_do_aviso_o_parar_manda_o_interrupt_na_hora_e_espera_a_resposta() {
    let thread = "parar-claude-rodando";
    let (session, mut rx) = claude::session_for_test(thread);
    session.send_message(&mensagem("oi")).unwrap();
    session.confirm_turn();
    escrito(&mut rx);
    let parar = tokio::spawn({
        let thread = thread.to_string();
        async move { api::interrupt(&thread).await }
    });
    let line = rx.recv().await.expect("o interrupt sai com o turno rodando");
    let pedido: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(pedido["request"]["subtype"], "interrupt");
    claude::respond_for_test(&session, pedido["request_id"].as_str().unwrap());
    assert_eq!(parar.await.unwrap().unwrap(), Interrupted::Sent);
}

#[tokio::test]
async fn claude_o_fim_do_turno_leva_o_parar_pendente_junto() {
    let thread = "parar-claude-fim";
    let (session, mut rx) = claude::session_for_test(thread);
    session.send_message(&mensagem("oi")).unwrap();
    escrito(&mut rx);
    assert_eq!(parar_sem_escrever(thread, &mut rx).await, Interrupted::Pending);
    // O turno termina sem o Claude ter mostrado nada (o `result` chegou direto): o Parar pendente morre com ele.
    assert!(session.close_turn().is_some());
    session.confirm_turn();
    assert!(escrito(&mut rx).is_empty(), "um aviso tardio, sem turno, não manda nada");
    assert_eq!(api::interrupt(thread).await.unwrap(), Interrupted::NoTurn);
    assert!(escrito(&mut rx).is_empty());
}

#[tokio::test]
async fn claude_um_envio_que_nao_sai_desfaz_a_abertura_do_turno() {
    let thread = "parar-claude-falha";
    let (session, rx) = claude::session_for_test(thread);
    drop(rx); // o processo caiu: a escrita falha e nada sai
    assert!(session.send_message(&mensagem("oi")).is_err());
    assert!(session.turn().is_none(), "a mensagem não saiu, então o turno não existe");
    assert_eq!(api::interrupt(thread).await.unwrap(), Interrupted::NoTurn);
}

#[test]
fn so_o_que_o_turno_produz_conta_como_aviso_do_turno() {
    for linha in [
        json!({ "type": "system", "subtype": "status", "status": "requesting" }),
        json!({ "type": "stream_event", "event": { "type": "message_start" } }),
        json!({ "type": "assistant", "message": { "role": "assistant", "content": [] } }),
        json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result" }] } }),
    ] {
        assert!(claude::is_turn_line(&linha), "{linha}");
    }
    for linha in [
        json!({ "type": "system", "subtype": "init" }),
        json!({ "type": "system", "subtype": "commands_changed" }),
        json!({ "type": "rate_limit_event" }),
        json!({ "type": "result", "subtype": "success" }),
        json!({ "type": "control_response", "response": { "subtype": "success" } }),
    ] {
        assert!(!claude::is_turn_line(&linha), "{linha}");
    }
}

// --- O fechamento no banco não toca no turno que está abrindo --------------------------------------------------

#[test]
fn o_parar_sem_turno_nao_fecha_o_turno_que_esta_abrindo() {
    let db = banco();
    let thread = criar_conversa(&db);
    let (session, _rx) = claude::session_for_test(&thread);
    let (turn, _) = session.send_message(&mensagem("oi")).unwrap();
    // A linha do turno é gravada logo depois da escrita (`send_user`): entre as duas coisas, um Parar não pode fechá-la.
    store::upsert_run(&db.lock().unwrap(), &thread, &turn, "inProgress", Some(2), None, None).unwrap();
    let fechou = {
        let conn = db.lock().unwrap();
        api::close_idle_orphans(&conn, &thread, 3)
    };
    assert!(fechou.unwrap().is_none(), "com o turno abrindo, o Parar não fecha nada no banco");
    assert_eq!(status_do_turno(&db, &thread, &turn), "inProgress");
}

#[test]
fn sem_agente_vivo_o_parar_fecha_o_turno_orfao_como_antes() {
    let db = banco();
    let thread = criar_conversa(&db);
    store::upsert_run(&db.lock().unwrap(), &thread, "orfao", "inProgress", Some(1), None, None).unwrap();
    let fechou = {
        let conn = db.lock().unwrap();
        api::close_idle_orphans(&conn, &thread, 5)
    };
    assert!(fechou.unwrap().is_some(), "sem agente, o órfão é fechado");
    assert_ne!(status_do_turno(&db, &thread, "orfao"), "inProgress");
}

// --- OpenCode (ACP): a mesma sequência de chamadas de `opencode.rs`, na camada de decisão ---------------------

/// O turno nasce com o id (a fila o reserva), o Parar chega e, por fim, o agente mostra o prompt. O guarda é o mesmo
/// do Codex e do Claude.
#[test]
fn acp_o_cancelamento_so_sai_com_o_primeiro_session_update_do_turno() {
    let mut gate = StopGate::default();
    gate.begin_turn();
    assert_eq!(gate.request_stop(Some("t1")), StopAction::Deferred, "antes de o agente mostrar o prompt, nada de cancelamento");
    assert!(gate.on_started("t1"), "o primeiro `session/update` do turno manda o cancelamento");
    assert!(!gate.on_started("t1"), "e só uma vez");
    assert_eq!(gate.request_stop(Some("t1")), StopAction::Send("t1".into()), "com o prompt rodando, o Parar sai na hora");
}

#[test]
fn acp_o_prompt_que_responde_sem_aviso_descarta_o_parar_pendente() {
    let mut gate = StopGate::default();
    gate.begin_turn();
    assert_eq!(gate.request_stop(Some("t1")), StopAction::Deferred);
    // O `session/prompt` respondeu sem nenhum `session/update` (`end_turn` chama `on_completed`).
    gate.on_completed("t1");
    assert!(!gate.on_started("t1"), "nenhum cancelamento tardio");
    assert_eq!(gate.request_stop(None), StopAction::NoTurn);
}

#[test]
fn acp_so_os_avisos_do_turno_contam_como_inicio_do_prompt() {
    for update in ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"] {
        assert!(opencode::is_turn_update(&json!({ "sessionUpdate": update })), "{update}");
    }
    for update in ["available_commands_update", "config_option_update", "current_mode_update"] {
        assert!(!opencode::is_turn_update(&json!({ "sessionUpdate": update })), "{update}");
    }
}
