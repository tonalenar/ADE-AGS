use super::*;

#[test]
fn falha_ao_criar_a_thread_de_puesta_a_punto_nao_derruba_o_boot() {
    let resultado = std::panic::catch_unwind(|| {
        arrancar_com(|_, _| Err(std::io::Error::other("sem recurso")), || {}, |_| {});
    });
    assert!(resultado.is_ok(), "a falha ao criar a thread entrou em pânico em vez de seguir o boot");
}

/// Sem a thread, o gate da frota não pode esperar `run()` marcar o sweep.
#[test]
fn falha_ao_criar_a_thread_de_puesta_a_punto_libera_o_sweep() {
    SWEEP_DONE.store(false, Ordering::SeqCst);
    arrancar_com(
        |nome, _| {
            if nome == "startup-housekeeping" {
                Err(std::io::Error::other("sem recurso"))
            } else {
                Ok(())
            }
        },
        || {},
        |_| {},
    );
    assert!(
        SWEEP_DONE.load(Ordering::SeqCst),
        "SWEEP_DONE continua falso e cc-runs-swept não sai"
    );
}

#[test]
fn falha_de_lanzar_emite_aviso_visivel() {
    let fonte = include_str!("../housekeeping.rs");
    assert!(
        fonte.contains("cc-housekeeping-failed"),
        "falta o aviso visível da puesta a punto"
    );
    assert!(
        fonte.contains("emit(SWEPT") || fonte.contains("emit(SWEPT,"),
        "cc-runs-swept tem que sair também quando o lanzar falha"
    );
}
