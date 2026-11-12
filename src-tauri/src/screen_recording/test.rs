use super::*;

fn exit(code: i32) -> ExitInfo {
    ExitInfo {
        code: Some(code),
        signal: None,
    }
}

fn erro(kind: &str, exit: ExitInfo, killed: bool, len: Option<u64>, log: &str) -> String {
    check_output(kind, exit, killed, len, log).expect_err("a gravação devia falhar")
}

#[test]
fn arquivo_com_conteudo_e_sucesso_mesmo_com_saida_nao_zero() {
    assert!(check_output("simulator", exit(1), false, Some(4096), "").is_ok());
}

#[test]
fn falha_do_simulador_desligado_diz_o_motivo_em_vez_da_mensagem_generica() {
    let msg = erro(
        "simulator",
        exit(1),
        false,
        None,
        "No devices are booted.\n",
    );
    assert!(msg.contains("simulador"), "{msg}");
    assert!(!msg.contains("não gerou um vídeo finalizado"), "{msg}");
}

#[test]
fn falha_do_iphone_bloqueado_pede_para_desbloquear() {
    let log = "ERROR: The device is locked. (com.apple.dt.CoreDeviceError error 1000)\n";
    let msg = erro("iphone", exit(1), false, None, log);
    assert!(msg.to_lowercase().contains("desbloqueie"), "{msg}");
}

#[test]
fn falha_do_iphone_sem_conexao_pede_para_reconectar() {
    let log = "ERROR: No devices found matching the provided identifier.\n";
    let msg = erro("iphone", exit(1), false, None, log);
    assert!(msg.to_lowercase().contains("conect"), "{msg}");
}

#[test]
fn permissao_de_gravacao_de_tela_negada_traz_marcador_e_caminho_dos_ajustes() {
    let log = "ERROR:The user declined TCC for application, window, display capture [com.apple.ScreenCaptureKit.SCStreamErrorDomain -3801]\n";
    let msg = erro("desktop", exit(2), false, None, log);
    assert!(
        msg.starts_with("SCREEN_CAPTURE_PERMISSION_REQUIRED:"),
        "{msg}"
    );
    assert!(msg.contains("Privacidade e Segurança"), "{msg}");
    assert!(msg.contains("Gravação de Tela"), "{msg}");
}

#[test]
fn sem_permissao_de_escrita_na_pasta_diz_isso() {
    let log = "Error: The file couldn't be saved: Operation not permitted\n";
    let msg = erro("simulator", exit(1), false, None, log);
    assert!(msg.contains("pasta"), "{msg}");
    assert!(
        !msg.starts_with("SCREEN_CAPTURE_PERMISSION_REQUIRED:"),
        "{msg}"
    );
}

#[test]
fn falha_desconhecida_mostra_o_que_a_ferramenta_escreveu_e_o_codigo() {
    let msg = erro("iphone", exit(3), false, None, "algo estranho aconteceu\n");
    assert!(msg.contains("algo estranho aconteceu"), "{msg}");
    assert!(msg.contains('3'), "{msg}");
}

#[test]
fn falha_sem_nenhuma_saida_ainda_informa_o_codigo() {
    let msg = erro("iphone", exit(70), false, None, "");
    assert!(msg.contains("70"), "{msg}");
}

#[test]
fn processo_morto_por_sinal_informa_o_sinal() {
    let info = ExitInfo {
        code: None,
        signal: Some(2),
    };
    let msg = erro("simulator", info, false, None, "");
    assert!(msg.contains("sinal 2"), "{msg}");
}

#[test]
fn processo_encerrado_a_forca_nao_vira_video_valido() {
    let info = ExitInfo {
        code: None,
        signal: Some(9),
    };
    let msg = erro("simulator", info, true, Some(8192), "");
    assert!(msg.contains("não respondeu"), "{msg}");
}

#[test]
fn video_vazio_continua_sendo_erro_proprio() {
    let msg = erro("simulator", exit(0), false, Some(0), "");
    assert!(msg.contains("vazio"), "{msg}");
}

#[test]
fn saida_zero_sem_arquivo_diz_que_o_arquivo_nao_apareceu() {
    let msg = erro("iphone", exit(0), false, None, "");
    assert!(msg.contains("não criou o arquivo"), "{msg}");
}

// ── Processo supervisionado (só Unix: usa o `sh` como ferramenta de mentira) ─────

#[cfg(unix)]
mod processo {
    use super::*;
    use std::process::Stdio;

    const PRAZO: Duration = Duration::from_secs(10);

    fn sh(script: &str) -> Supervised {
        let mut command = crate::util::spawn::hidden_command("/bin/sh");
        command
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Supervised::new(command.spawn().expect("sh abre"))
    }

    #[test]
    fn ferramenta_que_morre_logo_depois_de_iniciar_vira_erro_com_o_motivo() {
        let process = sh("echo 'No devices are booted.' >&2; exit 164");
        let error = ensure_started("simulator", &process, Some("Recording started"), PRAZO)
            .expect_err("a ferramenta saiu");
        assert!(error.contains("simulador"), "{error}");
    }

    #[test]
    fn ferramenta_viva_depois_do_marcador_conta_como_iniciada() {
        let process = sh("echo 'Recording started'; exec sleep 30");
        assert!(ensure_started("simulator", &process, Some("Recording started"), PRAZO).is_ok());
        let (exit, killed) = process.stop_with_interrupt(PRAZO, 1);
        assert!(!killed);
        assert_eq!(exit.signal, Some(2));
    }

    #[test]
    fn saida_da_ferramenta_fica_no_registro() {
        let process = sh("echo uma; echo duas >&2; exit 3");
        let exit = process.wait_exit(PRAZO).expect("saiu");
        assert_eq!(exit.code, Some(3));
        let log = process.log();
        assert!(log.contains("uma") && log.contains("duas"), "{log}");
    }

    #[test]
    fn ctrl_c_perdido_nao_prende_a_parada_para_sempre() {
        // `trap "" INT` + exec: o `sleep` herda o sinal ignorado, como o simctl antes de instalar o tratador.
        let process = sh("trap '' INT; echo pronto; exec sleep 30");
        assert_eq!(
            process.wait_until(PRAZO, |log| log.contains("pronto")),
            Wait::Matched
        );
        let (exit, killed) = process.stop_with_interrupt(Duration::from_millis(100), 2);
        assert!(killed);
        assert_eq!(exit.signal, Some(9));
    }

    #[test]
    fn registro_guarda_so_o_fim_da_saida() {
        let process = sh(
            "i=0; while [ $i -lt 600 ]; do echo linha-numero-$i-xxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done",
        );
        process.wait_exit(PRAZO).expect("saiu");
        let log = process.log();
        assert!(log.len() <= LOG_LIMIT, "{}", log.len());
        assert!(log.contains("linha-numero-599"), "{log}");
    }
}
