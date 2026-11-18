//! Testes da tela do agente que não precisam do aparelho (o estado da janela é o único que muda).

use super::*;

#[test]
fn timeout_do_agente_solta_a_tela() {
    // A tela `agent:<device>` nasce visível para a sessão ligar. Se a espera do agente falha, ela sai de vista.
    let device = "dispositivo-teste-timeout";
    state().lock().unwrap().screens.insert(agent_screen(device), (device.to_string(), true));
    drop(AgentLease { device: device.to_string(), kept: false });
    assert!(!state().lock().unwrap().visible(device));
    state().lock().unwrap().screens.remove(&agent_screen(device));
}

#[test]
fn agente_com_sessao_entregue_mantem_a_tela_ate_o_release() {
    let device = "dispositivo-teste-entregue";
    state().lock().unwrap().screens.insert(agent_screen(device), (device.to_string(), true));
    drop(AgentLease { device: device.to_string(), kept: true });
    assert!(state().lock().unwrap().visible(device));
    state().lock().unwrap().screens.remove(&agent_screen(device));
}
