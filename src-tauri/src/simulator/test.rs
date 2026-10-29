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
