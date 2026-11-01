use super::model::*;

fn device(name: &str, runtime: &str, state: &str) -> Device {
    Device { udid: format!("{name}-{runtime}"), name: name.into(), runtime: runtime.into(), family: family_of(name, runtime).unwrap_or("iphone").into(), state: state.into(), width: 402.0, height: 874.0 }
}

#[test]
fn so_iphone_e_ipad_do_ios_entram_na_lista() {
    assert_eq!(family_of("iPhone 18 Pro Max", "iOS 27.0"), Some("iphone"));
    assert_eq!(family_of("iPad mini (A17 Pro)", "iOS 27.0"), Some("ipad"));
    assert_eq!(family_of("Apple Watch Ultra", "watchOS 13.0"), None);
    assert_eq!(family_of("Apple TV", "tvOS 27.0"), None);
}

#[test]
fn a_lista_poe_iphones_antes_dos_ipads_e_o_ios_mais_novo_primeiro() {
    let mut list = vec![device("iPad (A16)", "iOS 27.0", "shutdown"), device("iPhone Duo", "iOS 27.0", "shutdown"), device("iPhone Duo", "iOS 27.1", "shutdown")];
    sort_devices(&mut list);
    let order: Vec<_> = list.iter().map(|d| (d.name.as_str(), d.runtime.as_str())).collect();
    assert_eq!(order, [("iPhone Duo", "iOS 27.1"), ("iPhone Duo", "iOS 27.0"), ("iPad (A16)", "iOS 27.0")]);
}

#[test]
fn escolher_por_nome_prefere_o_ligado_e_aceita_o_udid() {
    let list = vec![device("iPhone 17", "iOS 27.1", "shutdown"), device("iPhone 17", "iOS 27.0", "booted")];
    assert_eq!(pick(&list, "iphone 17").unwrap().runtime, "iOS 27.0");
    assert_eq!(pick(&list, "iPhone 17-iOS 27.1").unwrap().runtime, "iOS 27.1");
    assert!(pick(&list, "Galaxy").is_err());
}

#[test]
fn os_caracteres_viram_teclas_do_teclado_americano() {
    assert_eq!(char_usage('a'), Some((0x04, false)));
    assert_eq!(char_usage('Z'), Some((0x1d, true)));
    assert_eq!(char_usage('1'), Some((0x1e, false)));
    assert_eq!(char_usage('0'), Some((0x27, false)));
    assert_eq!(char_usage('@'), Some((0x1f, true)));
    assert_eq!(char_usage('.'), Some((0x37, false)));
    assert_eq!(char_usage('?'), Some((0x38, true)));
    assert_eq!(char_usage('é'), None);
    assert!(text_keys("ton@autovale.com").is_ok());
    assert!(text_keys("ação").is_err());
}

#[test]
fn teclas_e_botoes_com_nome() {
    assert_eq!(key_usage("Enter").unwrap(), 0x28);
    assert_eq!(key_usage("backspace").unwrap(), 0x2a);
    assert_eq!(key_usage("x").unwrap(), 0x1b);
    assert!(key_usage("home").is_err());
    assert_eq!(button_source("home").unwrap(), 0);
    assert_eq!(button_source("LOCK").unwrap(), 1);
    assert!(button_source("volume").is_err());
}

#[test]
fn o_toque_vira_proporcao_da_tela() {
    assert_eq!(touch_ratio(150.0, 300.0, 300.0, 600.0), Some((0.5, 0.5)));
    assert_eq!(touch_ratio(-5.0, 700.0, 300.0, 600.0), Some((0.0, 1.0)));
    assert_eq!(touch_ratio(1.0, 1.0, 0.0, 600.0), None);
    assert_eq!(point_ratio(201.0, 437.0, (402.0, 874.0)).unwrap(), (0.5, 0.5));
    assert!(point_ratio(500.0, 10.0, (402.0, 874.0)).is_err());
}

#[test]
fn o_deslizamento_vai_do_comeco_ao_fim_em_passos_iguais() {
    let points = swipe_points((0.5, 0.8), (0.5, 0.2), 3);
    assert_eq!(points.len(), 4);
    assert_eq!(points[0], (0.5, 0.8));
    assert!((points[3].1 - 0.2).abs() < 1e-9);
}

#[test]
fn a_url_ganha_o_esquema_certo() {
    assert_eq!(normalize_url("localhost:5173/sinistros").unwrap(), "http://localhost:5173/sinistros");
    assert_eq!(normalize_url("192.168.0.4:3000").unwrap(), "http://192.168.0.4:3000");
    assert_eq!(normalize_url("autovale.com.br").unwrap(), "https://autovale.com.br");
    assert_eq!(normalize_url("https://x.dev").unwrap(), "https://x.dev");
    assert!(normalize_url("  ").is_err());
}

#[test]
fn a_regiao_de_toque_e_a_visivel_menos_o_menu_por_cima() {
    let visible = Rect { x: 0.0, y: 0.0, width: 100.0, height: 200.0 };
    let menu = Rect { x: 20.0, y: 0.0, width: 200.0, height: 50.0 };
    let parts = subtract(visible, &[menu]);
    let area: f64 = parts.iter().map(|r| r.width * r.height).sum();
    assert_eq!(area, 100.0 * 200.0 - 80.0 * 50.0);
    assert!(parts.iter().all(|r| !r.contains(50.0, 10.0)), "o ponto sob o menu fica fora");
    assert!(parts.iter().any(|r| r.contains(10.0, 10.0)), "à esquerda do menu ainda toca");
    assert_eq!(subtract(visible, &[Rect { x: 300.0, y: 300.0, width: 5.0, height: 5.0 }]), vec![visible]);
}

#[test]
fn a_arvore_do_ios_sai_do_launchd_sim_do_aparelho() {
    let ps = "  1     0 /sbin/launchd\n 500     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/AAA/data/var/run/launchd_bootstrap.plist\n 501   500 /Runtime/SpringBoard\n 502   501 /Runtime/PosterExtension\n 600     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/BBB/data/var/run/launchd_bootstrap.plist\n 601   600 /Runtime/SpringBoard\n 700     1 /Applications/Outro.app\n";
    let mut tree = process_tree(ps, "AAA");
    tree.sort();
    assert_eq!(tree, vec![500, 501, 502]);
    assert!(process_tree(ps, "CCC").is_empty());
    // O pid do launchd_sim contém o dígito do ppid (1): o comando ainda é lido inteiro.
    let real = "81034     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/AAA/data/var/run/launchd_bootstrap.plist\n81100 81034 /cryptex/SpringBoard\n";
    assert_eq!(process_tree(real, "AAA"), vec![81034, 81100]);
}

#[test]
fn hiberna_so_fora_de_vista_depois_do_prazo() {
    use super::lifecycle::due;
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let later = start + Duration::from_secs(600);
    let ten = Some(Duration::from_secs(600));
    assert!(due(later, start, false, ten));
    assert!(!due(later, start, true, ten), "à vista nunca hiberna");
    assert!(!due(start + Duration::from_secs(599), start, false, ten));
    assert!(!due(later, start, false, None), "nunca = nunca");
}

#[test]
fn acao_recente_do_agente_mantem_prioridade_normal_fora_de_vista() {
    use super::lifecycle::wanted_nice;
    use std::time::Duration;
    assert_eq!(wanted_nice(true, false, Duration::ZERO), 0);
    let grace = super::lifecycle::AGENT_PRIORITY_GRACE;
    assert_eq!(wanted_nice(true, false, grace - Duration::from_nanos(1)), 0);
    assert_eq!(wanted_nice(true, false, grace), 10);
}

#[test]
fn a_prioridade_e_baixa_fora_de_vista_e_normal_quando_se_olha() {
    use super::lifecycle::wanted_nice;
    use std::time::Duration;
    let settled = Duration::from_secs(600);
    assert_eq!(wanted_nice(true, true, settled), 0);
    assert_eq!(wanted_nice(true, false, settled), 10);
    assert_eq!(wanted_nice(true, true, Duration::from_secs(30)), 0, "à vista a prioridade é sempre normal para não engasgar");
    assert_eq!(wanted_nice(false, false, settled), 0, "sem modo leve, sempre normal");
}

#[test]
fn o_modo_leve_desliga_cada_servico_uma_vez_e_o_caminho_e_seguro() {
    use super::slim;
    let mut seen = std::collections::HashSet::new();
    for label in slim::LABELS {
        assert!(seen.insert(*label), "rótulo repetido: {label}");
        assert!(label.starts_with("com.apple."), "{label}");
    }
    assert_eq!(slim::LABELS.len(), 143);
    // Os que ficam ligados de propósito (sem eles o iOS fica tentando subir de novo, ou quebra quem testa app).
    for keep in ["com.apple.assistantd", "com.apple.gamed", "com.apple.sharingd", "com.apple.apsd", "com.apple.storekitd"] {
        assert!(!seen.contains(keep), "{keep} não pode sair");
    }
    let (file, original) = slim::paths("B3DECAAB-8989-4EF2-B77D-C045E026E198").unwrap();
    assert_eq!(file.to_string_lossy(), "/private/var/tmp/com.apple.CoreSimulator.SimDevice.B3DECAAB-8989-4EF2-B77D-C045E026E198/disabled.plist");
    assert!(original.ends_with("disabled.ade-original.plist"));
    assert!(slim::paths("../../etc").is_none());
    assert!(slim::paths("B3DECAAB-8989-4EF2-B77D-C045E026E19/").is_none());
}

#[test]
fn o_app_em_primeiro_plano_sai_do_launchctl_e_prefere_o_que_nao_e_da_apple() {
    let out = "PID\tStatus\tLabel\n70010\t0\tUIKitApplication:com.apple.mobilesafari[2368][rb-legacy]\n-\t0\tcom.apple.backboardd\n71000\t0\tUIKitApplication:br.com.autovale.app[a1b2][rb-legacy]\n69297\t0\tUIKitApplication:com.apple.Spotlight[231e][rb-legacy]\n";
    assert_eq!(parse_foreground_app(out).as_deref(), Some("br.com.autovale.app"));
    let only_apple = "70010\t0\tUIKitApplication:com.apple.mobilesafari[2368][rb-legacy]\n69297\t0\tUIKitApplication:com.apple.Spotlight[231e][rb-legacy]\n";
    assert_eq!(parse_foreground_app(only_apple).as_deref(), Some("com.apple.mobilesafari"));
    assert_eq!(parse_foreground_app("PID\tStatus\tLabel\n-\t0\tcom.apple.backboardd\n"), None);
    assert_eq!(parse_foreground_app(""), None);
}

#[test]
fn o_cadastro_do_face_id_sai_do_notifyutil() {
    assert!(parse_notify_state("com.apple.BiometricKit.enrollmentChanged 1\n").unwrap());
    assert!(!parse_notify_state("com.apple.BiometricKit.enrollmentChanged 0").unwrap());
    assert!(parse_notify_state("").is_err());
    assert!(parse_notify_state("com.apple.BiometricKit.enrollmentChanged x").is_err());
    assert_eq!(biometric_steps("enroll").unwrap(), (Some(1), Some("com.apple.BiometricKit.enrollmentChanged")));
    assert_eq!(biometric_steps("unenroll").unwrap().0, Some(0));
    assert_eq!(biometric_steps("match").unwrap(), (None, Some("com.apple.BiometricKit_Sim.pearl.match")));
    assert_eq!(biometric_steps("nomatch").unwrap(), (None, Some("com.apple.BiometricKit_Sim.pearl.nomatch")));
    assert_eq!(biometric_steps("state").unwrap(), (None, None));
    assert!(biometric_steps("touch").is_err());
}

#[test]
fn a_localizacao_respeita_as_faixas() {
    assert_eq!(location_arg(-23.55, -46.63).unwrap(), "-23.55,-46.63");
    assert_eq!(location_arg(90.0, 180.0).unwrap(), "90,180");
    assert!(location_arg(90.1, 0.0).is_err());
    assert!(location_arg(0.0, -180.5).is_err());
    assert!(location_arg(f64::NAN, 0.0).is_err());
}

#[test]
fn o_bundle_id_so_aceita_caracteres_seguros() {
    assert!(check_bundle("com.apple.mobilesafari").is_ok());
    assert!(check_bundle("br.com.auto-vale.app_2").is_ok());
    for bad in ["", "-x", ".x", "com.x;rm", "com x", "com/x", "çom.x"] {
        assert!(check_bundle(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_aparencia_so_e_light_ou_dark() {
    assert_eq!(appearance_mode("Dark").unwrap(), "dark");
    assert_eq!(appearance_mode("light").unwrap(), "light");
    assert!(appearance_mode("sepia").is_err());
    assert_eq!(parse_appearance("dark\n").unwrap(), "dark");
    assert!(parse_appearance("unsupported").is_err());
}

#[test]
fn girar_anda_um_quarto_de_volta_e_a_mensagem_tem_o_formato_medido() {
    assert_eq!(next_orientation(1, "left").unwrap(), 3);
    assert_eq!(next_orientation(3, "left").unwrap(), 2);
    assert_eq!(next_orientation(1, "right").unwrap(), 4);
    assert_eq!(next_orientation(4, "left").unwrap(), 1);
    assert!(next_orientation(1, "up").is_err());
    assert_eq!(orientation_name(3), "landscapeLeft");
    let msg = orientation_message(0x1234, 4);
    let word = |at: usize| u32::from_ne_bytes(msg[at..at + 4].try_into().unwrap());
    assert_eq!(msg.len(), 80);
    assert_eq!((word(0), word(4), word(8), word(20)), (19, 80, 0x1234, 0x7B));
    assert_eq!((word(24), word(72), word(76)), (50 | 0x20000, 4, 4));
}

/// Prova de verdade num aparelho ligado (não roda no CI): `CC_E2E_SIM_UDID=<udid> cargo test --lib -- --ignored
/// gira_um_aparelho_de_verdade`, com um app que gira aberto (o Safari); a captura fica em paisagem.
#[test]
#[ignore = "precisa de um simulador iOS ligado (CC_E2E_SIM_UDID)"]
fn gira_um_aparelho_de_verdade() {
    let udid = std::env::var("CC_E2E_SIM_UDID").expect("CC_E2E_SIM_UDID");
    assert_eq!(super::ops::rotate(&udid, "left").unwrap(), "landscapeLeft");
    assert_eq!(super::ops::rotate(&udid, "right").unwrap(), "portrait");
}

#[test]
fn em_paisagem_o_toque_volta_para_a_superficie_em_retrato() {
    // O "+" do Safari, medido: na superfície em retrato (0.913, 0.853); na tela em pé, girada para a esquerda (3),
    // aparece em (0.853, 0.087).
    let (x, y) = native_ratio((0.853, 0.087), 3);
    assert!((x - 0.913).abs() < 1e-9 && (y - 0.853).abs() < 1e-9);
    assert_eq!(native_ratio((0.25, 0.1), 1), (0.25, 0.1));
    assert_eq!(native_ratio((0.25, 0.1), 4), (0.1, 0.75));
    assert_eq!(native_ratio((0.25, 0.1), 2), (0.75, 0.9));
    // Os quatro cantos da tela em pé caem nos quatro cantos da superfície.
    for o in 1..=4 {
        let mut corners: Vec<(f64, f64)> = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].iter().map(|c| native_ratio(*c, o)).collect();
        corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(corners, vec![(0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0)], "orientação {o}");
    }
    assert_eq!(display_quarter_turns(3), -1);
    assert_eq!(display_quarter_turns(4), 1);
    assert_eq!(display_quarter_turns(2), 2);
    assert_eq!(display_quarter_turns(1), 0);
    assert_eq!(oriented_size((390.0, 844.0), 4), (844.0, 390.0));
    assert_eq!(oriented_size((390.0, 844.0), 2), (390.0, 844.0));
}

#[test]
fn restauracao_pendente_nao_duplica_worker_e_corrige_decisao_em_voo() {
    use super::lifecycle::{PriorityState, wanted_nice};
    use std::time::Duration;
    let mut state = PriorityState::default();
    let idle = wanted_nice(true, false, Duration::MAX);
    assert_eq!(state.prepare(idle), Some(10));
    // A ação chega enquanto ps aplica o fundo, antes de nice refletir o resultado.
    assert!(state.queue_restore());
    assert!(!state.queue_restore(), "uma thread cobre as ações repetidas");
    state.finish(idle, true);
    let active = wanted_nice(true, false, Duration::ZERO);
    assert_eq!(state.prepare(active), Some(0), "reavalia após I/O, não reaplica decisão antiga");
    assert!(!state.queue_restore());
    state.finish(active, true);
    assert_eq!(state.prepare(active), None);
    state.pending = false;
    assert!(!state.queue_restore(), "já normal, sem trabalho pendente");
    assert_eq!(state.prepare(idle), Some(10));
    state.finish(idle, false);
    assert_eq!(state.nice, 0, "falha não altera a prioridade confirmada");
    assert_eq!(state.applying, None);
}
