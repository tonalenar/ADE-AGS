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

// ── iPhone físico: o espelho é o caminho; o devicectl é só a alternativa ──

mod espelho {
    use super::*;
    use crate::iphone::model::LinkState;
    use std::sync::Mutex;

    /// O erro real do `devicectl` neste iPhone (o CoreDevice não oferece a gravação de tela).
    const SEM_CAPACIDADE: &str = "ERROR: The operation couldn't be completed. (CoreDeviceError error 1000.)\n\
        CapabilityName = Screen Recording\n\
        CapabilityFeatureIdentifier = com.apple.coredevice.feature.screenrecording\n\
        DeviceIdentifier = EC4D6C18-E117-53B6-8063-DB1821935BBB";

    #[derive(Default)]
    struct Chamadas {
        espelho: Vec<String>,
        devicectl: Vec<String>,
        parou: Vec<String>,
    }

    struct Falso {
        dir: PathBuf,
        estado: Option<LinkState>,
        /// O espelho falha ao começar (sem quadro, disco…).
        falha_ao_iniciar: Option<String>,
        /// Parar falha (escritor com erro).
        falha_ao_parar: Option<String>,
        chamadas: Arc<Mutex<Chamadas>>,
        contador: std::sync::atomic::AtomicUsize,
    }

    struct Gravacao {
        path: PathBuf,
        falha: Option<String>,
        chamadas: Arc<Mutex<Chamadas>>,
    }

    impl MirrorHandle for Gravacao {
        fn stop(self: Box<Self>) -> Result<(), String> {
            self.chamadas.lock().unwrap().parou.push(self.path.display().to_string());
            match self.falha {
                Some(erro) => Err(erro),
                None => std::fs::write(&self.path, b"mp4").map_err(|e| e.to_string()),
            }
        }
    }

    impl Env for Falso {
        fn recording_path(&self, label: &str, extension: &str) -> Result<PathBuf, String> {
            // Como o relógio do app: cada gravação tem um nome novo.
            let n = self.contador.fetch_add(1, Ordering::Relaxed);
            Ok(self.dir.join(format!("{label}-{n}.{extension}")))
        }

        fn mirror_state(&self, _: &str) -> Option<LinkState> {
            self.estado
        }

        fn start_mirror(&self, device: &str, path: &Path) -> Result<Box<dyn MirrorHandle>, String> {
            self.chamadas.lock().unwrap().espelho.push(device.to_string());
            if let Some(erro) = &self.falha_ao_iniciar {
                return Err(erro.clone());
            }
            Ok(Box::new(Gravacao { path: path.to_path_buf(), falha: self.falha_ao_parar.clone(), chamadas: self.chamadas.clone() }))
        }

        fn start_devicectl(&self, device: &str, _: &Path) -> Result<Backend, String> {
            self.chamadas.lock().unwrap().devicectl.push(device.to_string());
            Err(explain_failure("iphone", exit(1), SEM_CAPACIDADE))
        }
    }

    fn falso(estado: Option<LinkState>) -> Falso {
        let dir = std::env::temp_dir().join(format!("ade-grav-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Falso { dir, estado, falha_ao_iniciar: None, falha_ao_parar: None, chamadas: Arc::default(), contador: Default::default() }
    }

    const ALVO: &str = "device:EC4D6C18-E117-53B6-8063-DB1821935BBB";

    #[test]
    fn o_caminho_do_iphone_depende_do_estado_do_espelho() {
        assert_eq!(iphone_route(Some(LinkState::Live)), IphoneRoute::Mirror);
        assert_eq!(iphone_route(Some(LinkState::Connecting)), IphoneRoute::MirrorConnecting);
        assert_eq!(iphone_route(Some(LinkState::Reconnecting)), IphoneRoute::MirrorConnecting);
        for estado in [Some(LinkState::Offline), Some(LinkState::Paused), None] {
            assert_eq!(iphone_route(estado), IphoneRoute::Devicectl, "{estado:?}");
        }
    }

    #[test]
    fn o_erro_de_capacidade_ausente_do_devicectl_vira_o_aviso_para_ligar_o_espelho() {
        let mensagem = erro("iphone", exit(1), false, None, SEM_CAPACIDADE);
        assert!(mensagem.starts_with(IPHONE_MIRROR_MARKER), "{mensagem}");
        assert!(mensagem.contains("não aceita gravação de tela pelo devicectl"), "{mensagem}");
        assert!(mensagem.contains("Ligue o espelho"), "{mensagem}");
        assert!(!mensagem.contains("CoreDeviceError"), "o ruído do devicectl não vai para a pessoa: {mensagem}");
        // Só o iPhone: o mesmo texto em outra ferramenta continua com a explicação genérica.
        assert!(!erro("simulator", exit(1), false, None, SEM_CAPACIDADE).starts_with(IPHONE_MIRROR_MARKER));
    }

    #[test]
    fn outros_erros_do_devicectl_continuam_com_a_explicacao_de_antes() {
        // O aparelho bloqueado cita "locked"; a regra nova não pode engolir isso.
        assert!(erro("iphone", exit(1), false, None, "The device is locked.").contains("bloqueado"));
        assert!(erro("iphone", exit(1), false, None, "CapabilityName = Outra Coisa").starts_with("A ferramenta de gravação parou"));
    }

    #[test]
    fn com_o_espelho_ligado_grava_os_quadros_dele_e_nunca_chama_o_devicectl() {
        let env = falso(Some(LinkState::Live));
        let registro = Registry::new();
        let id = registro.start(&env, "iphone", ALVO).unwrap();
        assert_eq!(id, format!("iphone:{ALVO}"));
        assert_eq!(registro.status().as_deref(), Some(id.as_str()));
        let path = registro.stop(&id).unwrap();
        assert!(path.ends_with(".mp4") && Path::new(&path).exists(), "o arquivo é o do escritor: {path}");
        assert_eq!(registro.status(), None, "o estado limpa ao parar");
        let chamadas = env.chamadas.lock().unwrap();
        assert_eq!(chamadas.espelho, [ALVO]);
        assert!(chamadas.devicectl.is_empty());
        assert_eq!(chamadas.parou.len(), 1);
    }

    #[test]
    fn so_uma_gravacao_por_vez_e_a_parada_confere_o_id() {
        let env = falso(Some(LinkState::Live));
        let registro = Registry::new();
        let id = registro.start(&env, "iphone", ALVO).unwrap();
        let erro = registro.start(&env, "iphone", ALVO).unwrap_err();
        assert!(erro.contains("Já existe uma gravação ativa"), "{erro}");
        assert!(registro.stop("iphone:outro").unwrap_err().contains("outra tela"));
        assert_eq!(registro.status().as_deref(), Some(id.as_str()), "a parada errada não derruba a gravação");
        registro.stop(&id).unwrap();
        assert!(registro.stop(&id).unwrap_err().contains("Não há gravação ativa"));
        // Depois de parar, outra pode começar.
        assert!(registro.start(&env, "iphone", ALVO).is_ok());
    }

    #[test]
    fn falha_ao_parar_o_espelho_devolve_o_erro_e_ainda_limpa_o_estado() {
        let mut env = falso(Some(LinkState::Live));
        env.falha_ao_parar = Some("disco cheio".into());
        let registro = Registry::new();
        let id = registro.start(&env, "iphone", ALVO).unwrap();
        assert_eq!(registro.stop(&id).unwrap_err(), "disco cheio");
        assert_eq!(registro.status(), None, "o botão não fica preso em gravando");
        assert!(registro.start(&env, "iphone", ALVO).is_ok(), "dá para gravar de novo");
    }

    #[test]
    fn falha_ao_iniciar_o_espelho_nao_deixa_gravacao_ativa() {
        let mut env = falso(Some(LinkState::Live));
        env.falha_ao_iniciar = Some("O espelho não entregou nenhum quadro".into());
        let registro = Registry::new();
        let erro = registro.start(&env, "iphone", ALVO).unwrap_err();
        assert!(erro.contains("nenhum quadro"), "{erro}");
        assert_eq!(registro.status(), None);
    }

    #[test]
    fn sem_espelho_tenta_o_devicectl_e_o_erro_diz_para_ligar_o_espelho() {
        for estado in [None, Some(LinkState::Paused), Some(LinkState::Offline)] {
            let env = falso(estado);
            let registro = Registry::new();
            let erro = registro.start(&env, "iphone", ALVO).unwrap_err();
            assert!(erro.starts_with(IPHONE_MIRROR_MARKER), "{estado:?}: {erro}");
            assert_eq!(registro.status(), None);
            let chamadas = env.chamadas.lock().unwrap();
            assert_eq!(chamadas.devicectl, [ALVO]);
            assert!(chamadas.espelho.is_empty());
        }
    }

    #[test]
    fn espelho_ainda_conectando_pede_para_esperar_em_vez_de_tentar_o_devicectl() {
        let env = falso(Some(LinkState::Connecting));
        let registro = Registry::new();
        let erro = registro.start(&env, "iphone", ALVO).unwrap_err();
        assert!(erro.contains("ainda está conectando"), "{erro}");
        let chamadas = env.chamadas.lock().unwrap();
        assert!(chamadas.devicectl.is_empty() && chamadas.espelho.is_empty());
    }
}
