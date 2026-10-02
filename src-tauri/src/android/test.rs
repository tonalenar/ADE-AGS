use super::*;

fn dev(serial: &str, state: &str) -> Device {
    Device { serial: serial.into(), state: state.into(), model: String::new() }
}

#[test]
fn lee_la_lista_de_dispositivos() {
    let out = "* daemon started successfully\nList of devices attached\nemulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR58M123ABC             unauthorized usb:1-1 transport_id:2\n\n";
    let list = parse_devices(out);
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].serial.as_str(), list[0].state.as_str()), ("emulator-5554", "device"));
    assert_eq!(list[0].model, "sdk gphone64 x86 64");
    assert_eq!(list[1].state, "unauthorized");
    assert!(parse_devices("List of devices attached\n\n").is_empty());
}

#[test]
fn elige_el_dispositivo_pedido_o_el_unico_listo() {
    let one = vec![dev("emulator-5554", "device"), dev("X", "offline")];
    assert_eq!(pick_serial(None, &one).unwrap(), "emulator-5554");
    assert_eq!(pick_serial(Some("emulator-5554"), &one).unwrap(), "emulator-5554");
    assert!(pick_serial(Some("X"), &one).unwrap_err().contains("offline"));
    assert!(pick_serial(Some("Z"), &one).unwrap_err().contains("não está conectado"));
    assert!(pick_serial(None, &[]).unwrap_err().contains("Nenhum dispositivo"));
    let two = vec![dev("a", "device"), dev("b", "device")];
    assert!(pick_serial(None, &two).unwrap_err().contains("2 dispositivos"));
}

#[test]
fn lee_el_tamano_y_prefiere_el_override() {
    assert_eq!(parse_size("Physical size: 1080x2400\n"), Some((1080, 2400)));
    assert_eq!(parse_size("Physical size: 1080x2400\nOverride size: 720x1600\n"), Some((720, 1600)));
    assert_eq!(parse_size("nada"), None);
}

#[test]
fn escapa_el_texto_para_input_text() {
    assert_eq!(escape_text("hola mundo").unwrap(), "'hola%smundo'");
    assert_eq!(escape_text("100%").unwrap(), "'100%%'");
    assert_eq!(escape_text("it's").unwrap(), format!("'it'{}''s'", char::from(92)));
    assert_eq!(escape_text("a&b;c").unwrap(), "'a&b;c'");
    assert!(escape_text("").is_err());
    assert!(escape_text("olá").unwrap_err().contains("ASCII"));
}

#[test]
fn las_teclas_con_nombre_y_las_que_no() {
    assert_eq!(keycode("BACK").unwrap(), "4");
    assert_eq!(keycode("home").unwrap(), "3");
    assert_eq!(keycode("recents").unwrap(), "187");
    assert_eq!(keycode("66").unwrap(), "66");
    assert_eq!(keycode("keycode_dpad_center").unwrap(), "KEYCODE_DPAD_CENTER");
    assert!(keycode("explotar").unwrap_err().contains("desconhecida"));
    assert!(keycode("keycode_x; rm").is_err());
}

const XML: &str = r#"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.x" content-desc="" clickable="false" bounds="[0,0][1080,2400]"><node index="0" text="Entrar &amp; criar" resource-id="com.x:id/btn_login" class="android.widget.Button" content-desc="" clickable="true" bounds="[100,200][500,300]" /><node index="1" text="" resource-id="" class="android.widget.ImageView" content-desc="Menu" clickable="true" bounds="[0,0][100,100]" /><node index="2" text="" resource-id="" class="android.view.View" content-desc="" clickable="false" bounds="[0,0][50,50]" /></node></hierarchy>"#;

#[test]
fn el_arbol_deja_lo_que_dice_algo_o_se_toca() {
    let nodes = parse_tree(XML);
    assert_eq!(nodes.len(), 2, "{nodes:?}");
    assert_eq!(nodes[0].text, "Entrar & criar");
    assert_eq!(nodes[0].id, "btn_login");
    assert_eq!(nodes[0].class, "Button");
    assert!(nodes[0].clickable);
    assert_eq!(nodes[0].center(), (300, 250));
    assert_eq!(nodes[1].label(), "Menu");
}

#[test]
fn el_arbol_se_lee_y_se_busca_por_texto() {
    let nodes = parse_tree(XML);
    let text = render_tree(&nodes);
    assert!(text.contains("[0] Button * \"Entrar & criar\" @(300,250) #btn_login"), "{text}");
    assert_eq!(find_node(&nodes, "menu").unwrap().desc, "Menu");
    assert_eq!(find_node(&nodes, "entrar").unwrap().id, "btn_login", "por contenido si no hay exacto");
    assert_eq!(find_node(&nodes, "btn_login").unwrap().text, "Entrar & criar", "por id");
    assert!(find_node(&nodes, "nada").is_none());
    assert!(find_node(&nodes, "  ").is_none());
}

#[test]
fn un_avd_con_un_nombre_raro_no_llega_al_comando() {
    assert!(start_avd("--help").is_err());
    assert!(start_avd("a b; rm").is_err());
    assert!(start_avd("").is_err());
}

#[test]
fn un_paquete_con_caracteres_raros_se_rechaza() {
    assert!(launch("x", "com.a; reboot").is_err());
    assert!(launch("x", "").is_err());
}
