use super::*;

#[test]
fn falha_ao_criar_a_thread_de_puesta_a_punto_nao_derruba_o_boot() {
    let resultado = std::panic::catch_unwind(|| {
        arrancar_com(|_, _| Err(std::io::Error::other("sem recurso")), || {});
    });
    assert!(resultado.is_ok(), "a falha ao criar a thread entrou em pânico em vez de seguir o boot");
}
