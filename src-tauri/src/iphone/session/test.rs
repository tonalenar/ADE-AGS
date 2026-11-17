//! Testes da sessão do espelhamento que não precisam do aparelho: a espera do agente e a entrega da entrada.

use super::*;

#[test]
fn espera_para_quando_o_espelho_cai_de_vez() {
    // O espelho em `Offline` com erro fatal não volta sozinho. O agente recebe o motivo na hora, sem o prazo inteiro.
    let mut link = Link::default();
    link.state = LinkState::Offline;
    let status: Shared = Arc::new((Mutex::new(Status::of("dev", &link, false, None)), Condvar::new()));
    let erro = Waiter(status).wait(Duration::from_secs(5)).expect_err("o espelho caiu de vez: a espera tem que falhar");
    assert!(erro.starts_with("O espelhamento do aparelho parou"), "{erro}");
}
