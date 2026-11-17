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
    let pipe = spawn_writer(stdin);
    let (feito, pronto) = mpsc::channel();
    std::thread::spawn(move || {
        for _ in 0..64 {
            pipe.submit(vec![b'x'; 64 * 1024], None);
        }
        let _ = feito.send(());
    });
    let resultado = pronto.recv_timeout(Duration::from_secs(5));
    let _ = child.kill();
    let _ = child.wait();
    assert!(resultado.is_ok(), "mandar 4 MB a um helper parado não pode travar o envio");
}

/// Um stdin que já não aceita nada: o helper caiu e o pipe quebrou.
struct PipeQuebrado;

impl std::io::Write for PipeQuebrado {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe quebrado"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn pipe_quebrado_devolve_erro_e_a_sessao_recusa_depois() {
    // Escrita que falha não pode virar "ok": quem espera a confirmação recebe o erro do pipe.
    let pipe = spawn_writer(PipeQuebrado);
    let (reply, answer) = mpsc::channel();
    pipe.submit(b"tap 1 2\n".to_vec(), Some(reply));
    let primeiro = answer.recv_timeout(Duration::from_secs(5)).expect("a escrita confirma, com erro");
    assert!(primeiro.is_err(), "pipe quebrado não pode virar ok: {primeiro:?}");

    // Depois da falha, a sessão recusa os envios seguintes com erro claro, em vez de aceitar e perder.
    let (reply, answer) = mpsc::channel();
    pipe.submit(b"tap 3 4\n".to_vec(), Some(reply));
    let segundo = answer.recv_timeout(Duration::from_secs(5)).expect("a recusa chega como resposta");
    let erro = segundo.expect_err("depois da falha, o envio é recusado");
    assert!(erro.contains("parou"), "{erro}");
}

#[test]
fn confirmacao_que_nao_chega_vira_erro_no_prazo() {
    // Sem resposta da sessão no prazo, o agente recebe erro: nunca um "ok" sem confirmação.
    let (tx, _rx) = mpsc::channel::<Msg>();
    let input = InputTx(tx);
    let erro = input.send_checked_within(vec!["tap".to_string()], Duration::ZERO).expect_err("sem resposta, não há ok");
    assert!(erro.contains("a tempo"), "{erro}");
}
