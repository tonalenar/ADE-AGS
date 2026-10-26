//! Encerramento único da app: a mesma limpeza, uma vez só, venha de onde vier a saída.
//!
//! Há três caminhos que terminam o processo: `RunEvent::Exit` (saída normal pelo Tauri),
//! `window::confirm_exit_all` (o "fechar tudo" do diálogo, que sai com `process::exit` e
//! pula o ciclo de eventos) e o hilo de sinais no Unix (`SIGTERM`/`SIGINT`/`SIGHUP`).
//! Antes, só o primeiro removia o handshake do IPC e matava as sessões PTY; o "fechar
//! tudo" deixava os agentes (e o que eles lançaram) vivos e a CLI apontando para um
//! porto morto.
//!
//! A ordem é a do caminho normal, que é o mais exercitado: primeiro o IPC (só apaga
//! arquivos, não trava), depois as sessões (o `Drop` de cada grupo não roda sozinho,
//! porque o registry é um estático). `Once` garante que uma segunda chamada — por exemplo
//! um sinal chegando durante o "fechar tudo" — não repete nada e espera a primeira acabar
//! antes de seguir para o `exit`.

use std::sync::Once;

static SHUTDOWN: Once = Once::new();

/// Uma etapa da limpeza. Injetável para testar sem processos nem arquivos reais.
pub(crate) type Step<'a> = &'a mut dyn FnMut();

/// Faz a limpeza completa de saída. Chamar mais de uma vez é seguro: só a primeira age.
pub(crate) fn shutdown_once() {
    run_steps_once(
        &SHUTDOWN,
        &mut [&mut || crate::ipc::cleanup(), &mut || crate::terminal::kill_all_sessions()],
    );
}

/// Roda `steps` em ordem na primeira chamada com este `once`; nas seguintes, nada.
/// Devolve `true` só quando esta chamada fez a limpeza.
pub(crate) fn run_steps_once(once: &Once, steps: &mut [Step<'_>]) -> bool {
    let mut ran = false;
    once.call_once(|| {
        for step in steps.iter_mut() {
            step();
        }
        ran = true;
    });
    ran
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_segunda_chamada_nao_repete_a_limpeza() {
        let once = Once::new();
        let log = RefCell::new(Vec::new());
        let mut ipc = || log.borrow_mut().push("ipc");
        let mut pty = || log.borrow_mut().push("pty");
        assert!(run_steps_once(&once, &mut [&mut ipc, &mut pty]));
        assert!(!run_steps_once(&once, &mut [&mut ipc, &mut pty]));
        assert_eq!(*log.borrow(), vec!["ipc", "pty"], "uma vez só e na ordem");
    }

    #[test]
    fn os_tres_caminhos_de_saida_passam_pela_limpeza_unica() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for rel in ["app/run.rs", "app/signals.rs", "window/manager.rs"] {
            let src = std::fs::read_to_string(root.join(rel)).unwrap();
            assert!(src.contains("shutdown_once()"), "{rel} tem que chamar shutdown_once()");
            assert!(!src.contains("kill_all_sessions()"), "{rel} não limpa por conta própria");
            assert!(!src.contains("ipc::cleanup()"), "{rel} não limpa por conta própria");
        }
    }
}
