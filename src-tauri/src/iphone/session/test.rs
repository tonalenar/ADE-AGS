//! Testes da sessão do espelhamento que não precisam do aparelho: a espera do agente e a entrega da entrada.

use super::*;

#[test]
fn espera_para_quando_o_espelho_cai_de_vez() {
    // A espera é de 60 s. O espelho cai (Offline) enquanto ela dorme: a espera tem que acordar logo, com o erro, em vez
    // de dormir o prazo inteiro. O teste não espera o relógio: só dá 5 s para a espera acordar e falha se não acordar.
    let status: Shared = Arc::new((Mutex::new(Status::of("dev", &Link::default(), false, None)), Condvar::new()));
    let (resposta, recebida) = mpsc::channel();
    let espera = Waiter(status.clone());
    std::thread::spawn(move || {
        let _ = resposta.send(espera.wait(Duration::from_secs(60)));
    });
    {
        let (lock, changed) = &*status;
        let mut atual = lock.lock().expect("estado");
        atual.state = LinkState::Offline;
        changed.notify_all();
    }
    let erro = recebida
        .recv_timeout(Duration::from_secs(5))
        .expect("a espera tem que acordar com o espelho caído, não no prazo de 60 s")
        .expect_err("o espelho caiu de vez: a espera falha");
    assert!(erro.starts_with("O espelhamento do aparelho parou"), "{erro}");
}

#[test]
fn envio_nao_espera_o_pipe_do_helper() {
    // Um helper que não lê o stdin não pode travar quem manda comandos (antes a escrita era síncrona na thread
    // que decodifica o vídeo, A259). Com a escrita numa thread própria, 4 MB entram na fila sem esperar o pipe.
    let mut child = std::process::Command::new("sleep").arg("30").stdin(std::process::Stdio::piped()).spawn().expect("sleep");
    let stdin = child.stdin.take().expect("stdin do processo");
    let tx = spawn_writer(stdin);
    let (feito, pronto) = mpsc::channel();
    std::thread::spawn(move || {
        for _ in 0..64 {
            let _ = tx.send(vec![b'x'; 64 * 1024]);
        }
        let _ = feito.send(());
    });
    let resultado = pronto.recv_timeout(Duration::from_secs(5));
    let _ = child.kill();
    let _ = child.wait();
    assert!(resultado.is_ok(), "mandar 4 MB a um helper parado não pode travar o envio");
}
