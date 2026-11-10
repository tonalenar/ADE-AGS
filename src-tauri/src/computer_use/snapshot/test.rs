//! Testes do SnapShot com saídas sintéticas: nenhuma tela real é lida nem fotografada.

use super::*;
use std::ffi::OsString;

fn os(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
}

/// Dois monitores: o principal (1512×982 pt, 3024×1964 px) e um externo (2560×1440). Janelas de sistema e
/// sem app ficam de fora.
const DOIS_MONITORES: &str = r#"{
  "titles": true,
  "displays": [
    {"id": 1, "main": true, "x": 0, "y": 0, "w": 1512, "h": 982, "pixelWidth": 3024, "pixelHeight": 1964},
    {"id": 7, "main": false, "x": 1512, "y": 0, "w": 2560, "h": 1440, "pixelWidth": 2560, "pixelHeight": 1440}
  ],
  "windows": [
    {"id": 101, "app": "Safari", "title": "Página de teste", "layer": 0, "x": 10, "y": 40, "w": 800, "h": 600},
    {"id": 102, "app": "Dock", "title": null, "layer": 20, "x": 0, "y": 900, "w": 1512, "h": 82},
    {"id": 103, "app": "", "title": "sem app", "layer": 0, "x": 0, "y": 0, "w": 300, "h": 300},
    {"id": 104, "app": "Terminal", "title": "   ", "layer": 0, "x": 0, "y": 0, "w": 20, "h": 20}
  ]
}"#;

fn com_tres_telas() -> String {
    r#"{"titles": true, "displays": [
        {"id": 1, "main": true, "x": 0, "y": 0, "w": 1512, "h": 982, "pixelWidth": 3024, "pixelHeight": 1964},
        {"id": 7, "main": false, "x": 1512, "y": 0, "w": 2560, "h": 1440, "pixelWidth": 2560, "pixelHeight": 1440},
        {"id": 9, "main": false, "x": 4072, "y": 0, "w": 1920, "h": 1080, "pixelWidth": 1920, "pixelHeight": 1080}
      ], "windows": []}"#
        .to_string()
}

#[test]
fn lista_separa_a_tela_principal_e_numera_a_secundaria_com_dois_monitores() {
    let list = parse_listing(DOIS_MONITORES).unwrap();
    assert!(list.titles);
    let principal = &list.displays[0];
    assert_eq!((principal.id, principal.main, principal.number, principal.capturable), (1, true, Some(1), true));
    assert_eq!(principal.blocked, None);
    let externo = &list.displays[1];
    assert_eq!((externo.id, externo.main, externo.number, externo.capturable), (7, false, Some(2), true));
    assert_eq!(externo.blocked, None);
    assert_eq!((externo.pixel_width, externo.pixel_height), (2560, 1440));
}

#[test]
fn com_tres_telas_a_secundaria_nao_tem_numero_documentado_e_fica_bloqueada() {
    let list = parse_listing(&com_tres_telas()).unwrap();
    assert_eq!(list.displays[0].number, Some(1), "a principal segue documentada como 1");
    for externo in &list.displays[1..] {
        assert_eq!(externo.number, None, "o macOS não documenta a ordem das secundárias com três telas");
        assert!(!externo.capturable);
        assert_eq!(externo.blocked, Some(Blocked::Numbering));
    }
}

#[test]
fn janelas_de_sistema_pequenas_e_sem_app_ficam_fora_da_lista() {
    let list = parse_listing(DOIS_MONITORES).unwrap();
    let ids: Vec<u32> = list.windows.iter().map(|w| w.id).collect();
    assert_eq!(ids, vec![101]);
    assert!(list.windows[0].capturable);
}

#[test]
fn titulo_longo_e_cortado_e_titulo_so_com_controle_vira_ausencia() {
    let longo = "a".repeat(300);
    let json = DOIS_MONITORES.replace("\"Página de teste\"", &format!("\"{longo}\""));
    let list = parse_listing(&json).unwrap();
    let titulo = list.windows[0].title.clone().unwrap();
    assert_eq!(titulo.chars().count(), MAX_TITLE_CHARS);

    let so_controle = DOIS_MONITORES.replace("\"Página de teste\"", "\"  \\u0007\\u0001  \"");
    let list = parse_listing(&so_controle).unwrap();
    assert_eq!(list.windows[0].title, None, "um título sem texto útil não aparece");
}

#[test]
fn sem_permissao_de_gravacao_as_janelas_so_mostram_o_app_e_a_tela_secundaria_fica_bloqueada() {
    let json = DOIS_MONITORES.replace("\"titles\": true", "\"titles\": false");
    let list = parse_listing(&json).unwrap();
    assert!(!list.titles);
    assert_eq!(list.windows[0].app, "Safari");
    assert_eq!(list.windows[0].title, None, "sem permissão, o título não passa nem se o helper mandar");
    assert!(!list.windows[0].capturable);
    let externo = &list.displays[1];
    assert!(!externo.capturable);
    assert_eq!(externo.blocked, Some(Blocked::Permission));
    assert_eq!(list.displays[0].blocked, None, "a tela principal segue como hoje, sem exigir a lista");
}

#[test]
fn pixel_zerado_nao_derruba_a_lista_e_a_tela_segue_conferida_em_pontos() {
    let sem_modo = DOIS_MONITORES.replace("\"pixelWidth\": 2560, \"pixelHeight\": 1440", "\"pixelWidth\": 0, \"pixelHeight\": 0");
    let list = parse_listing(&sem_modo).unwrap();
    let externo = &list.displays[1];
    assert!(externo.capturable, "o tamanho em pontos basta para a conferência");
    let plano = plan_for(&list, &SnapshotTarget::Display { id: 7 }).unwrap();
    assert_eq!(plano, Plan::Display { number: 2, pixels: (0, 0), points: (2560, 1440) });
    assert!(dims_match((2560, 1440), &[(0, 0), (2560, 1440)]));
}

#[test]
fn json_quebrado_sem_tela_principal_ou_com_tela_vazia_vira_erro() {
    assert!(parse_listing("não é json").is_err());
    assert!(parse_listing(r#"{"titles": true, "displays": [], "windows": []}"#).is_err());
    let sem_principal = DOIS_MONITORES.replace("\"main\": true", "\"main\": false");
    assert!(parse_listing(&sem_principal).is_err());
    let tela_zero = DOIS_MONITORES.replace("\"w\": 2560", "\"w\": 0");
    assert!(parse_listing(&tela_zero).is_err());
}

#[test]
fn a_captura_da_tela_principal_mantem_o_comando_de_sempre_sem_numero_de_tela() {
    let args = capture_args(&Plan::Main, Path::new("/sintetico/foto.png"));
    assert_eq!(args, os(&["-x", "-t", "png", "/sintetico/foto.png"]));
}

#[test]
fn a_tela_secundaria_usa_o_numero_documentado_e_a_janela_usa_o_id_com_l() {
    let list = parse_listing(DOIS_MONITORES).unwrap();
    let tela = plan_for(&list, &SnapshotTarget::Display { id: 7 }).unwrap();
    assert_eq!(
        tela,
        Plan::Display { number: 2, pixels: (2560, 1440), points: (2560, 1440) }
    );
    assert_eq!(capture_args(&tela, Path::new("/sintetico/foto.png")), os(&["-x", "-t", "png", "-D", "2", "/sintetico/foto.png"]));

    let janela = plan_for(&list, &SnapshotTarget::Window { id: 101 }).unwrap();
    assert_eq!(janela, Plan::Window { id: 101, app: "Safari".into(), title: Some("Página de teste".into()) });
    assert_eq!(capture_args(&janela, Path::new("/sintetico/foto.png")), os(&["-x", "-o", "-t", "png", "-l", "101", "/sintetico/foto.png"]));
}

#[test]
fn tela_ou_janela_que_sumiram_pedem_para_atualizar_a_lista() {
    let list = parse_listing(DOIS_MONITORES).unwrap();
    let tela = plan_for(&list, &SnapshotTarget::Display { id: 99 }).unwrap_err();
    assert!(tela.contains("Atualize a lista"), "{tela}");
    let janela = plan_for(&list, &SnapshotTarget::Window { id: 999 }).unwrap_err();
    assert!(janela.contains("Atualize a lista"), "{janela}");
}

#[test]
fn tela_secundaria_sem_permissao_ou_com_tres_telas_nao_vira_plano() {
    let sem_permissao = parse_listing(&DOIS_MONITORES.replace("\"titles\": true", "\"titles\": false")).unwrap();
    let erro = plan_for(&sem_permissao, &SnapshotTarget::Display { id: 7 }).unwrap_err();
    assert!(erro.contains("Gravação de Tela"), "{erro}");
    let janela = plan_for(&sem_permissao, &SnapshotTarget::Window { id: 101 }).unwrap_err();
    assert!(janela.contains("Gravação de Tela"), "{janela}");

    let tres = parse_listing(&com_tres_telas()).unwrap();
    let erro = plan_for(&tres, &SnapshotTarget::Display { id: 9 }).unwrap_err();
    assert!(erro.contains("três ou mais telas"), "{erro}");
}

#[test]
fn a_tela_principal_escolhida_pelo_id_vira_o_plano_principal_e_funciona_sem_permissao() {
    let sem_permissao = parse_listing(&DOIS_MONITORES.replace("\"titles\": true", "\"titles\": false")).unwrap();
    assert_eq!(plan_for(&sem_permissao, &SnapshotTarget::Main).unwrap(), Plan::Main);
    assert_eq!(plan_for(&sem_permissao, &SnapshotTarget::Display { id: 1 }).unwrap(), Plan::Main);
}

#[test]
fn a_foto_confere_o_tamanho_em_pixels_ou_em_pontos_e_aceita_a_tela_girada() {
    assert!(dims_match((2560, 1440), &[(2560, 1440), (2560, 1440)]));
    assert!(dims_match((1440, 2560), &[(2560, 1440), (2560, 1440)]), "tela girada");
    assert!(dims_match((1280, 720), &[(2560, 1440), (1280, 720)]), "foto em 1x");
    assert!(!dims_match((3024, 1964), &[(2560, 1440), (2560, 1440)]), "foto da principal não serve para a externa");
}

#[test]
fn o_json_ao_lado_so_existe_para_foto_do_snapshot_dentro_da_pasta_de_capturas() {
    let dir = Path::new("/sintetico/Imagens/ADE AGS");
    let png = dir.join("ADE-AGS_SnapShot_2026-11-10_17-00-00_abc.png");
    assert_eq!(sidecar_for(&png, dir), Some(dir.join("ADE-AGS_SnapShot_2026-11-10_17-00-00_abc.json")));
    assert_eq!(sidecar_for(&dir.join("foto.png"), dir), None, "nome que não é do SnapShot");
    assert_eq!(sidecar_for(Path::new("/outra/ADE-AGS_SnapShot_x.png"), dir), None, "fora da pasta");
    assert_eq!(sidecar_for(&dir.join("sub/ADE-AGS_SnapShot_x.png"), dir), None, "subpasta");
    assert_eq!(sidecar_for(&dir.join("ADE-AGS_SnapShot_x.json"), dir), None, "não é PNG");
}

#[test]
fn os_metadados_da_janela_voltam_pelo_json_e_titulo_longo_e_cortado() {
    let plan = Plan::Window { id: 101, app: "Safari".into(), title: Some("Página de teste".into()) };
    let info = info_for(&plan, "2026-11-10T17:00:00-03:00");
    assert_eq!(info.scope, Scope::Window);
    assert_eq!(info.app.as_deref(), Some("Safari"));
    let json = info_json(&info);
    assert_eq!(parse_info(&json), Some(info.clone()));

    let longo = format!(r#"{{"version":1,"scope":"window","app":"Safari","title":"{}","displayNumber":null,"capturedAt":"x"}}"#, "b".repeat(300));
    let lido = parse_info(&longo).unwrap();
    assert_eq!(lido.title.unwrap().chars().count(), MAX_TITLE_CHARS);
}

#[test]
fn os_metadados_da_tela_principal_dizem_tela_1_e_nao_tem_app() {
    let info = info_for(&Plan::Main, "2026-11-10T17:00:00-03:00");
    assert_eq!(info.scope, Scope::Display);
    assert_eq!(info.display_number, Some(1));
    assert_eq!((info.app, info.title), (None, None));
}

#[test]
fn json_estragado_ou_de_outra_versao_nao_vira_metadado() {
    assert_eq!(parse_info("{nao é json"), None);
    assert_eq!(parse_info(r#"{"version":2,"scope":"window","app":"Safari","title":null,"displayNumber":null,"capturedAt":"x"}"#), None);
    assert_eq!(parse_info(r#"{"version":1,"scope":"qualquer","app":null,"title":null,"displayNumber":1,"capturedAt":"x"}"#), None);
}

#[test]
fn le_o_json_ao_lado_do_png_e_ignora_arquivo_grande_demais() {
    let dir = std::env::temp_dir().join(format!("ade-snapshot-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let png = dir.join("ADE-AGS_SnapShot_teste.png");
    std::fs::write(&png, b"png sintetico").unwrap();
    let info = info_for(&Plan::Window { id: 101, app: "Safari".into(), title: None }, "x");
    std::fs::write(dir.join("ADE-AGS_SnapShot_teste.json"), info_json(&info)).unwrap();
    assert_eq!(read_info(&png, &dir), Some(info));

    // Um JSON válido, mas maior que o teto: a leitura recusa antes de interpretar.
    let inchado = format!(
        r#"{{"version":1,"scope":"window","app":"Safari","title":"{}","displayNumber":null,"capturedAt":"x"}}"#,
        "x".repeat(MAX_INFO_BYTES as usize)
    );
    assert!(parse_info(&inchado).is_some(), "sem o teto, este JSON seria aceito");
    std::fs::write(dir.join("ADE-AGS_SnapShot_grande.png"), b"png").unwrap();
    std::fs::write(dir.join("ADE-AGS_SnapShot_grande.json"), inchado).unwrap();
    assert_eq!(read_info(&dir.join("ADE-AGS_SnapShot_grande.png"), &dir), None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn o_helper_de_listagem_declara_as_chaves_que_o_rust_le() {
    for chave in ["\"displays\"", "\"windows\"", "\"titles\"", "\"pixelWidth\"", "\"pixelHeight\"", "\"layer\"", "\"app\"", "\"title\""] {
        assert!(LIST_SWIFT.contains(chave), "falta {chave} no list.swift");
    }
}
