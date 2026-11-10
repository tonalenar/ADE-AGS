//! O Parar de uma conversa Codex que chega antes do `turn/started`.
//!
//! O app-server recusa `turn/interrupt` enquanto o turno não abriu (erro `-32600`, "no active turn to
//! interrupt"; captura em `fixtures/protocolo/codex-interrupt-antes-do-started.json`): o turno seguia
//! rodando e o Parar sumia. Aqui a sessão não tem processo: o que ela escreveria no stdio chega a um
//! receptor, e os avisos do Codex entram pelos mesmos métodos que o laço de leitura usa.

use serde_json::Value;
use tokio::sync::mpsc::UnboundedReceiver;

use super::api;
use super::codex::{session_for_test, Session};

/// O Parar não pode escrever nada antes do aviso: ele fica pendente e devolve `Ok`.
async fn parar_sem_enviar(thread_id: &str, rx: &mut UnboundedReceiver<String>) {
    let stop = api::interrupt(thread_id);
    tokio::pin!(stop);
    tokio::select! {
        done = &mut stop => { done.expect("o Parar pendente não é erro"); }
        line = rx.recv() => panic!("o Parar escreveu {line:?} antes do turn/started"),
    }
}

/// A próxima mensagem que a sessão escreveu, já lida.
fn enviado(rx: &mut UnboundedReceiver<String>) -> Value {
    let line = rx.try_recv().expect("a sessão devia ter escrito o turn/interrupt");
    serde_json::from_str(&line).unwrap()
}

fn nada_enviado(rx: &mut UnboundedReceiver<String>) {
    assert!(rx.try_recv().is_err(), "não devia haver mais nada escrito");
}

fn aberta(thread_id: &str) -> (std::sync::Arc<Session>, UnboundedReceiver<String>) {
    session_for_test(thread_id, "remoto-1")
}

#[tokio::test]
async fn o_parar_com_o_turno_da_resposta_e_antes_do_started_espera_o_aviso() {
    let (session, mut rx) = aberta("parar-resposta");
    // O `turn/start` respondeu com o id do turno; o `turn/started` ainda não chegou.
    session.begin_start();
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));

    parar_sem_enviar("parar-resposta", &mut rx).await;
    nada_enviado(&mut rx);

    session.turn_started("turno-1");
    let msg = enviado(&mut rx);
    assert_eq!(msg["method"], "turn/interrupt");
    assert_eq!(msg["params"]["threadId"], "remoto-1");
    assert_eq!(msg["params"]["turnId"], "turno-1");
    nada_enviado(&mut rx);
}

#[tokio::test]
async fn o_parar_durante_o_turn_start_vale_para_o_turno_que_abrir() {
    let (session, mut rx) = aberta("parar-durante");
    session.begin_start();

    parar_sem_enviar("parar-durante", &mut rx).await;
    nada_enviado(&mut rx);

    // A resposta chega com o id; o aviso vem depois.
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));
    nada_enviado(&mut rx);
    session.turn_started("turno-1");
    assert_eq!(enviado(&mut rx)["params"]["turnId"], "turno-1");
}

#[tokio::test]
async fn o_parar_durante_o_turn_start_com_o_aviso_antes_da_resposta_sai_no_aviso() {
    let (session, mut rx) = aberta("parar-aviso-antes");
    session.begin_start();

    parar_sem_enviar("parar-aviso-antes", &mut rx).await;

    session.turn_started("turno-1");
    assert_eq!(enviado(&mut rx)["params"]["turnId"], "turno-1");
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));
    nada_enviado(&mut rx);
}

#[tokio::test]
async fn o_parar_depois_do_started_sai_na_hora() {
    let (session, mut rx) = aberta("parar-depois");
    session.begin_start();
    session.turn_started("turno-1");
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));

    // Sem servidor para responder, o pedido fica esperando: o que importa é que saiu.
    let stop = api::interrupt("parar-depois");
    tokio::pin!(stop);
    tokio::select! {
        _ = &mut stop => panic!("o Parar devia esperar a resposta do turn/interrupt"),
        line = rx.recv() => {
            let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
            assert_eq!(msg["method"], "turn/interrupt");
            assert_eq!(msg["params"]["turnId"], "turno-1");
        }
    }
}

#[tokio::test]
async fn o_turno_que_acaba_antes_do_started_leva_o_parar_pendente_embora() {
    let (session, mut rx) = aberta("parar-descartado");
    session.begin_start();
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));
    parar_sem_enviar("parar-descartado", &mut rx).await;

    // O turno terminou sem nunca avisar o início; o próximo turno não herda o Parar.
    session.turn_completed("turno-1");
    session.turn_started("turno-2");
    nada_enviado(&mut rx);
}

#[tokio::test]
async fn o_turn_start_que_falha_leva_o_parar_pendente_embora() {
    let (session, mut rx) = aberta("parar-falhou");
    session.begin_start();
    parar_sem_enviar("parar-falhou", &mut rx).await;

    session.end_start(None);
    session.begin_start();
    session.set_turn(Some("turno-2".into()));
    session.end_start(Some("turno-2"));
    session.turn_started("turno-2");
    nada_enviado(&mut rx);
}

#[tokio::test]
async fn sem_turno_e_sem_turn_start_o_parar_diz_que_nao_ha_o_que_parar() {
    let (session, mut rx) = aberta("parar-sem-turno");
    assert_eq!(api::interrupt("parar-sem-turno").await.unwrap(), api::Interrupted::NoTurn);

    // Também depois de um turno que fechou: o `stop` cai no fechamento do turno órfão do banco.
    session.begin_start();
    session.turn_started("turno-1");
    session.set_turn(Some("turno-1".into()));
    session.end_start(Some("turno-1"));
    session.turn_completed("turno-1");
    assert_eq!(api::interrupt("parar-sem-turno").await.unwrap(), api::Interrupted::NoTurn);
    nada_enviado(&mut rx);
}

#[tokio::test]
async fn o_parar_pendente_reporta_pendente_e_o_enviado_reporta_enviado() {
    let (session, _rx) = aberta("parar-relata");
    session.begin_start();
    assert_eq!(api::interrupt("parar-relata").await.unwrap(), api::Interrupted::Pending);
}

mod gate {
    use super::super::codex_parar::{StopAction, StopGate};

    #[test]
    fn um_parar_velho_nao_cai_no_turno_seguinte() {
        let mut gate = StopGate::default();
        gate.begin_start();
        gate.end_start(Some("t1"));
        assert_eq!(gate.request_stop(Some("t1")), StopAction::Deferred);
        gate.on_completed("t1");
        gate.begin_start();
        gate.end_start(Some("t2"));
        assert!(!gate.on_started("t2"));
    }

    #[test]
    fn o_parar_pendente_de_um_turno_nao_vale_para_outro_id() {
        let mut gate = StopGate::default();
        gate.begin_start();
        gate.end_start(Some("t1"));
        assert_eq!(gate.request_stop(Some("t1")), StopAction::Deferred);
        assert!(!gate.on_started("t2"), "o aviso de outro turno não consome a pendência");
        assert!(gate.on_started("t1"));
        assert!(!gate.on_started("t1"), "a pendência sai uma vez só");
    }

    #[test]
    fn o_parar_so_manda_na_hora_com_o_turno_ja_iniciado() {
        let mut gate = StopGate::default();
        assert_eq!(gate.request_stop(None), StopAction::NoTurn);
        gate.begin_start();
        gate.on_started("t1");
        gate.end_start(Some("t1"));
        assert_eq!(gate.request_stop(Some("t1")), StopAction::Send("t1".into()));
    }

    #[test]
    fn a_queda_do_processo_limpa_a_pendencia() {
        let mut gate = StopGate::default();
        gate.begin_start();
        assert_eq!(gate.request_stop(None), StopAction::Deferred);
        gate.reset();
        assert_eq!(gate.request_stop(None), StopAction::NoTurn);
    }
}
