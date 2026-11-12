use std::io::Cursor;

use super::model::*;

// ── Lista do devicectl ──

const DEVICECTL: &str = r#"{"result":{"devices":[
  {"identifier":"7952A8EA-BA88-45C7-A6A5-8329583BE075",
   "connectionProperties":{"pairingState":"paired","transportType":"sameMachine","tunnelState":"connected"},
   "deviceProperties":{"name":"iPhone 17e","osVersionNumber":"27.0"},
   "hardwareProperties":{"deviceType":"iPhone","marketingName":"iPhone 17e","platform":"iOS","reality":"simulated"}},
  {"identifier":"EC4D6C18-E117-53B6-8063-DB1821935BBB",
   "connectionProperties":{"pairingState":"paired","transportType":"localNetwork","tunnelIPAddress":"fdd6:f9d1:22d8::1","tunnelState":"connected"},
   "deviceProperties":{"name":"iPhone de Ton","osVersionNumber":"27.2","developerModeStatus":"enabled"},
   "hardwareProperties":{"deviceType":"iPhone","marketingName":"iPhone 15 Pro Max","platform":"iOS","reality":"physical","serialNumber":"X","udid":"00008110-001234567890001E"}},
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "connectionProperties":{"pairingState":"paired","transportType":"wired","tunnelState":"disconnected"},
   "deviceProperties":{"name":"iPad da sala","osVersionNumber":"26.4","developerModeStatus":"disabled"},
   "hardwareProperties":{"deviceType":"iPad","marketingName":"iPad Air","platform":"iOS","reality":"physical"}},
  {"identifier":"AAAAAAAA-2222-3333-4444-555555555555",
   "connectionProperties":{"pairingState":"unpaired"},
   "deviceProperties":{"name":"Apple Watch"},
   "hardwareProperties":{"deviceType":"appleWatch","platform":"watchOS","reality":"physical"}},
  {"identifier":"BBBBBBBB-2222-3333-4444-555555555555",
   "connectionProperties":{"pairingState":"paired"},
   "deviceProperties":{"name":"Antigo","osVersionNumber":"18.0"},
   "hardwareProperties":{"deviceType":"iPhone","marketingName":"iPhone 12","platform":"iOS","reality":"physical"}}
]}}"#;

#[test]
fn a_lista_so_traz_iphones_e_ipads_fisicos_com_o_transporte() {
    let list = parse_devicectl(DEVICECTL).unwrap();
    let ids: Vec<&str> = list.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["device:EC4D6C18-E117-53B6-8063-DB1821935BBB", "device:BBBBBBBB-2222-3333-4444-555555555555", "device:11111111-2222-3333-4444-555555555555"]);
    let ton = &list[0];
    assert_eq!((ton.name.as_str(), ton.model.as_str(), ton.os.as_str(), ton.family.as_str()), ("iPhone de Ton", "iPhone 15 Pro Max", "27.2", "iphone"));
    assert_eq!(ton.transport, Transport::Wifi);
    assert_eq!(ton.udid.as_deref(), Some("00008110-001234567890001E"));
    assert!(ton.tunnel && ton.paired && ton.ready());
    assert_eq!(ton.tunnel_ip.as_deref(), Some("fdd6:f9d1:22d8::1"));
}

#[test]
fn usb_sem_modo_de_desenvolvedor_e_aparelho_sem_caminho_nao_ficam_prontos() {
    let list = parse_devicectl(DEVICECTL).unwrap();
    let ipad = list.iter().find(|d| d.family == "ipad").unwrap();
    assert_eq!(ipad.transport, Transport::Usb);
    assert_eq!(ipad.developer_mode, Some(false));
    assert!(!ipad.ready());
    let old = list.iter().find(|d| d.name == "Antigo").unwrap();
    assert_eq!(old.transport, Transport::None);
    assert!(!old.ready());
}

#[test]
fn a_lista_nao_expoe_serie_nem_ip_do_tunel_para_a_interface() {
    let list = parse_devicectl(DEVICECTL).unwrap();
    let json = serde_json::to_string(&list).unwrap();
    assert!(!json.contains("serial") && !json.contains("fdd6"), "{json}");
    assert!(json.contains("\"transport\":\"wifi\"") && json.contains("\"developerMode\":true"), "{json}");
}

#[test]
fn json_estranho_do_devicectl_vira_erro() {
    assert!(parse_devicectl("não é json").is_err());
    assert!(parse_devicectl(r#"{"result":{}}"#).is_err());
    assert_eq!(parse_devicectl(r#"{"result":{"devices":[]}}"#).unwrap(), vec![]);
}

#[test]
fn reconhece_aparelho_usb_quando_xcode_omite_reality_e_marketing_name() {
    let json = r#"{"result":{"devices":[
      {"identifier":"12121212-3434-5656-7878-909090909090",
       "connectionProperties":{"pairingState":"paired","transportType":"wired","tunnelState":"disconnected"},
       "deviceProperties":{"name":"iPhone de tonz1n","osVersionNumber":"27.2"},
       "hardwareProperties":{"deviceType":"iPhone","platform":"iOS","productType":"iPhone16,2"}}
    ]}}"#;

    let devices = parse_devicectl(json).unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "iPhone de tonz1n");
    assert_eq!(devices[0].model, "iPhone16,2");
    assert_eq!(devices[0].transport, Transport::Usb);
    assert!(devices[0].ready());
}

#[test]
fn erros_do_coredevice_dizem_o_que_fazer_em_portugues() {
    assert!(device_error_help("Developer Mode is disabled").contains("Modo de Desenvolvedor"));
    assert!(device_error_help("device is locked").contains("Desbloqueie"));
    assert!(device_error_help("pairing is missing").contains("Confiar neste computador"));
    assert!(device_error_help("CoreDevice tunnel disconnected").contains("reconexão"));
    assert!(device_error_help("Xcode developer directory missing").contains("Xcode 27"));
    assert!(device_error_help("xcrun: error: invalid active developer path").contains("Xcode 27"));
    assert!(device_error_help("iphone-mirror helper missing").contains("helper do espelhamento"));
    assert_eq!(device_error_help("erro desconhecido"), "erro desconhecido");
}

#[test]
fn o_id_fisico_so_aceita_um_identificador_do_coredevice() {
    assert!(is_physical("device:EC4D6C18-E117-53B6-8063-DB1821935BBB"));
    assert!(!is_physical("EC4D6C18-E117-53B6-8063-DB1821935BBB"));
    assert_eq!(physical_identifier("device:EC4D6C18-E117-53B6-8063-DB1821935BBB"), Some("EC4D6C18-E117-53B6-8063-DB1821935BBB"));
    assert_eq!(physical_identifier("device:--tunnel"), None);
    assert_eq!(physical_identifier("device:EC4D6C18-E117-53B6-8063-DB1821935BB;"), None);
}

// ── Quadros do helper ──

fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

#[test]
fn le_eventos_e_datagramas_do_helper_ate_o_fim() {
    let mut bytes = frame(1, br#"{"event":"connecting","version":"1"}"#);
    bytes.extend(frame(2, &[0x80, 100, 0, 1]));
    bytes.extend(frame(1, br#"{"event":"started","transport":"Local Network","display":{"w":1290,"h":2796}}"#));
    bytes.extend(frame(1, br#"{"event":"error","code":"connect","message":"caiu"}"#));
    let mut r = Cursor::new(bytes);
    assert_eq!(read_msg(&mut r).unwrap(), Some(HelperMsg::Event(HelperEvent::Connecting)));
    assert_eq!(read_msg(&mut r).unwrap(), Some(HelperMsg::Datagram(vec![0x80, 100, 0, 1])));
    assert_eq!(read_msg(&mut r).unwrap(), Some(HelperMsg::Event(HelperEvent::Started { transport: Transport::Wifi, display: Some((1290, 2796)) })));
    assert_eq!(read_msg(&mut r).unwrap(), Some(HelperMsg::Event(HelperEvent::Error { code: "connect".into(), message: "caiu".into() })));
    assert_eq!(read_msg(&mut r).unwrap(), None);
}

#[test]
fn quadro_cortado_ou_gigante_do_helper_e_erro() {
    let mut cut = frame(2, &[1, 2, 3, 4]);
    cut.truncate(7);
    assert!(read_msg(&mut Cursor::new(cut)).is_err());
    let mut huge = vec![2];
    huge.extend_from_slice(&(64u32 << 20).to_be_bytes());
    assert!(read_msg(&mut Cursor::new(huge)).is_err());
    assert!(read_msg(&mut Cursor::new(frame(9, b"x"))).is_err());
}

#[test]
fn started_sem_tela_e_evento_desconhecido_nao_quebram() {
    assert_eq!(parse_event(br#"{"event":"started","transport":"wired"}"#), HelperEvent::Started { transport: Transport::Usb, display: None });
    assert_eq!(parse_event(br#"{"event":"started","display":{"w":0,"h":10}}"#), HelperEvent::Started { transport: Transport::None, display: None });
    assert_eq!(parse_event(br#"{"event":"novo"}"#), HelperEvent::Other("novo".into()));
    assert_eq!(parse_event(b"lixo"), HelperEvent::Other("lixo".into()));
}

// ── RTP / HEVC ──

const SSRC: u32 = 0xd920_998c;

/// Um pacote RTP com a extensão da Apple (perfil 0x9001, 1 palavra), como chega do aparelho.
fn rtp(seq: u16, ts: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
    let mut p = vec![0x90, 100 | if marker { 0x80 } else { 0 }];
    p.extend_from_slice(&seq.to_be_bytes());
    p.extend_from_slice(&ts.to_be_bytes());
    p.extend_from_slice(&SSRC.to_be_bytes());
    p.extend_from_slice(&[0x90, 0x01, 0x00, 0x01, 0xaa, 0xbb, 0xcc, 0xdd]);
    p.extend_from_slice(payload);
    p
}

/// Um NAL de tipo `kind` com corpo `body` (cabeçalho de 2 bytes do HEVC).
fn nal_of(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut n = vec![kind << 1, 1];
    n.extend_from_slice(body);
    n
}

/// Um pacote de agregação (AP) com estes NALs.
fn ap(nals: &[Vec<u8>]) -> Vec<u8> {
    let mut p = vec![nal::AP << 1, 1];
    for n in nals {
        p.extend_from_slice(&(n.len() as u16).to_be_bytes());
        p.extend_from_slice(n);
    }
    p
}

/// Os fragmentos (FU) de um NAL, `parts` pedaços.
fn fus(unit: &[u8], parts: usize) -> Vec<Vec<u8>> {
    let kind = nal::kind(unit);
    let body = &unit[2..];
    let size = body.len().div_ceil(parts);
    body.chunks(size)
        .enumerate()
        .map(|(i, chunk)| {
            let mut header = kind;
            if i == 0 {
                header |= 0x80;
            }
            if (i + 1) * size >= body.len() {
                header |= 0x40;
            }
            let mut p = vec![(unit[0] & 0x81) | (nal::FU << 1), unit[1], header];
            p.extend_from_slice(chunk);
            p
        })
        .collect()
}

fn params() -> Vec<Vec<u8>> {
    vec![nal_of(nal::VPS, b"vps"), nal_of(nal::SPS, b"sps"), nal_of(nal::PPS, b"pps")]
}

#[test]
fn junta_ap_com_parametros_e_idr_em_fragmentos_num_quadro() {
    let mut d = Depacketizer::default();
    let idr = nal_of(20, &[7u8; 3000]);
    let mut seq = 41817u16;
    assert_eq!(d.push(&rtp(seq, 1000, false, &ap(&params()))), Pushed::default());
    let parts = fus(&idr, 3);
    let mut last = Pushed::default();
    for (i, part) in parts.iter().enumerate() {
        seq += 1;
        last = d.push(&rtp(seq, 1000, i + 1 == parts.len(), part));
    }
    let unit = last.unit.expect("quadro");
    assert!(!last.gap);
    assert!(unit.irap);
    assert_eq!(unit.nals, vec![idr.clone()]);
    assert_eq!(unit.params, Some(ParamSets { vps: params()[0].clone(), sps: params()[1].clone(), pps: params()[2].clone() }));
    let avcc = unit.avcc();
    assert_eq!(&avcc[..4], &(idr.len() as u32).to_be_bytes());
    assert_eq!(&avcc[4..], &idr[..]);

    // O quadro seguinte (P, NAL simples) sai sem repetir os parâmetros.
    let p = nal_of(1, b"delta");
    let next = d.push(&rtp(seq + 1, 1400, true, &p)).unit.unwrap();
    assert_eq!((next.irap, next.params.is_none(), next.nals), (false, true, vec![p]));
}

#[test]
fn ignora_rtcp_outro_ssrc_e_pacote_repetido() {
    let mut d = Depacketizer::default();
    let sr = [0x80, 200, 0, 6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(d.push(&sr), Pushed::default());
    let p = nal_of(1, b"a");
    assert!(d.push(&rtp(10, 1, true, &p)).unit.is_some());
    // Repetido: nada.
    assert_eq!(d.push(&rtp(10, 1, true, &p)), Pushed::default());
    // Outro SSRC: nada.
    let mut other = rtp(11, 2, true, &p);
    other[8] ^= 0xff;
    assert_eq!(d.push(&other), Pushed::default());
    // O próximo do nosso SSRC segue sem salto.
    let next = d.push(&rtp(11, 2, true, &p));
    assert!(!next.gap && next.unit.is_some());
}

#[test]
fn perda_no_meio_do_quadro_descarta_o_quadro_e_avisa() {
    let mut d = Depacketizer::default();
    let unit = nal_of(1, &[3u8; 900]);
    let parts = fus(&unit, 3);
    d.push(&rtp(100, 5, false, &parts[0]));
    // Falta o 101.
    let out = d.push(&rtp(102, 5, true, &parts[2]));
    assert!(out.gap);
    assert_eq!(out.unit, None);
    // O quadro seguinte, inteiro, sai.
    let p = nal_of(1, b"ok");
    let next = d.push(&rtp(103, 6, true, &p));
    assert!(!next.gap);
    assert_eq!(next.unit.unwrap().nals, vec![p]);
}

#[test]
fn perda_na_fronteira_descarta_o_quadro_novo_por_cautela() {
    let mut d = Depacketizer::default();
    d.push(&rtp(1, 10, true, &nal_of(1, b"a")));
    // O 2 e o 3 se perderam; o 4 já é de outro horário e pode ter perdido o começo.
    let out = d.push(&rtp(4, 20, true, &nal_of(1, b"b")));
    assert!(out.gap);
    assert_eq!(out.unit, None);
}

#[test]
fn quadro_sem_marcador_e_descartado_quando_o_proximo_comeca() {
    let mut d = Depacketizer::default();
    let unit = nal_of(1, &[3u8; 600]);
    let parts = fus(&unit, 2);
    d.push(&rtp(1, 10, false, &parts[0]));
    // O segundo fragmento chegou sem o marcador (e sem o fim do FU): o quadro 20 começa.
    let p = nal_of(1, b"novo");
    let out = d.push(&rtp(2, 20, true, &p));
    assert!(!out.gap);
    assert_eq!(out.unit.unwrap().nals, vec![p]);
}

#[test]
fn sequencia_que_vira_no_zero_nao_e_perda() {
    let mut d = Depacketizer::default();
    let p = nal_of(1, b"a");
    d.push(&rtp(65535, 1, true, &p));
    let out = d.push(&rtp(0, 2, true, &p));
    assert!(!out.gap && out.unit.is_some());
}

#[test]
fn padding_e_csrc_sao_respeitados() {
    let mut d = Depacketizer::default();
    let p = nal_of(1, b"abc");
    let mut pkt = vec![0xA1, 0x80 | 100, 0, 9, 0, 0, 0, 1];
    pkt.extend_from_slice(&SSRC.to_be_bytes());
    pkt.extend_from_slice(&[1, 2, 3, 4]); // 1 CSRC
    pkt.extend_from_slice(&p);
    pkt.extend_from_slice(&[0, 0, 3]); // 3 bytes de padding
    assert_eq!(d.push(&pkt).unit.unwrap().nals, vec![p]);
}

#[test]
fn pacote_curto_ou_ap_quebrado_nao_derruba() {
    let mut d = Depacketizer::default();
    assert_eq!(d.push(&[0x80, 100, 0]), Pushed::default());
    let mut broken = ap(&params());
    broken.truncate(6);
    assert_eq!(d.push(&rtp(1, 1, true, &broken)).unit, None);
    // Ainda funciona depois.
    assert!(d.push(&rtp(2, 2, true, &nal_of(1, b"x"))).unit.is_some());
}

// ── Espera do quadro-chave ──

fn unit(irap: bool) -> AccessUnit {
    AccessUnit { ts: 0, nals: vec![nal_of(if irap { 20 } else { 1 }, b"x")], irap, params: None }
}

#[test]
fn comeca_esperando_o_idr_e_depois_decodifica_tudo() {
    let mut g = KeyframeGate::default();
    assert_eq!(g.on_unit(&unit(false), 0), GateAction::Drop);
    assert!(g.should_ask(0));
    assert_eq!(g.on_unit(&unit(true), 50), GateAction::Decode);
    assert_eq!(g.on_unit(&unit(false), 66), GateAction::Decode);
    assert!(!g.should_ask(66));
}

#[test]
fn depois_da_perda_pede_quadro_chave_de_tempo_em_tempo_e_desiste() {
    let mut g = KeyframeGate::default();
    assert_eq!(g.on_unit(&unit(true), 0), GateAction::Decode);
    g.on_gap(1000);
    assert!(g.should_ask(1000));
    assert!(!g.should_ask(1300));
    assert!(g.should_ask(1700));
    assert_eq!(g.on_unit(&unit(false), 1800), GateAction::Drop);
    assert!(!g.gave_up(3400));
    assert!(g.gave_up(3500));
    // Chegou o IDR: volta ao normal.
    assert_eq!(g.on_unit(&unit(true), 3501), GateAction::Decode);
    assert!(!g.waiting() && !g.gave_up(9999));
}

#[test]
fn decodificador_novo_espera_um_idr_mesmo_sem_perda() {
    let mut g = KeyframeGate::default();
    assert_eq!(g.on_unit(&unit(true), 0), GateAction::Decode);
    // Os parâmetros mudaram e o decodificador foi refeito num quadro P: sem referência, sairia lixo.
    g.on_new_decoder(&unit(false), 500);
    assert!(g.waiting());
    assert_eq!(g.on_unit(&unit(false), 500), GateAction::Drop);
    assert_eq!(g.on_unit(&unit(true), 540), GateAction::Decode);
    // Refeito já num IDR: segue normal.
    g.on_new_decoder(&unit(true), 600);
    assert!(!g.waiting());
}

#[test]
fn perda_seguida_nao_reinicia_o_relogio_da_espera() {
    let mut g = KeyframeGate::default();
    g.on_unit(&unit(true), 0);
    g.on_gap(100);
    g.on_gap(2000);
    assert!(g.gave_up(2600));
}

#[test]
fn foto_do_espelho_so_e_confiavel_depois_do_quadro_chave_que_recupera_a_sessao() {
    let fence = CaptureFence::default();
    assert!(!fence.trusts(10), "não há quadro confiável antes do primeiro IDR");

    fence.on_keyframe(20);
    assert!(!fence.trusts(19), "um quadro antigo não pode voltar a ser confiável");
    assert!(fence.trusts(20));
    assert!(fence.trusts(21));

    fence.invalidate();
    assert!(!fence.trusts(21), "perda ou falha invalida os quadros até o próximo IDR");
    fence.on_keyframe(45);
    assert!(!fence.trusts(44));
    assert!(fence.trusts(45));
}

// ── Recorte ──

#[test]
fn o_recorte_tira_as_bordas_de_alinhamento_da_direita_e_de_baixo() {
    let (x, y, w, h) = contents_rect((1296, 2816), Some((1290, 2796)));
    assert_eq!(x, 0.0);
    assert!((w - 1290.0 / 1296.0).abs() < 1e-12);
    assert!((h - 2796.0 / 2816.0).abs() < 1e-12);
    // Com a origem embaixo, o recorte começa acima das 20 linhas de borda.
    assert!((y - 20.0 / 2816.0).abs() < 1e-12);
}

#[test]
fn a_medida_da_tela_acompanha_a_orientacao_dos_quadros_do_iphone() {
    assert_eq!(display_for_frame((1290, 2796), (1296, 2816)), (1290, 2796));
    assert_eq!(display_for_frame((1290, 2796), (2816, 1296)), (2796, 1290));
    assert_eq!(display_for_frame((2796, 1290), (1296, 2816)), (1290, 2796));
    assert_eq!(display_for_frame((0, 0), (1296, 2816)), (0, 0));
}

#[test]
fn sem_tela_ou_com_tela_maior_que_o_video_mostra_tudo() {
    assert_eq!(contents_rect((1296, 2816), None), (0.0, 0.0, 1.0, 1.0));
    assert_eq!(contents_rect((1296, 2816), Some((1400, 2796))), (0.0, 0.0, 1.0, 1.0));
    assert_eq!(contents_rect((0, 0), Some((1290, 2796))), (0.0, 0.0, 1.0, 1.0));
    assert_eq!(contents_rect((1290, 2796), Some((1290, 2796))), (0.0, 0.0, 1.0, 1.0));
}

// ── Conexão ──

#[test]
fn a_conexao_vai_de_conectando_a_ligado_e_reconecta_quando_cai() {
    let mut link = Link::default();
    link.on_spawn();
    assert_eq!(link.state, LinkState::Connecting);
    link.on_started(Transport::Wifi, Some((1290, 2796)));
    assert_eq!((link.state, link.transport, link.display), (LinkState::Live, Some(Transport::Wifi), Some((1290, 2796))));
    assert_eq!(link.on_lost("sem quadros"), backoff(1));
    assert_eq!(link.state, LinkState::Reconnecting);
    link.on_spawn();
    assert_eq!(link.state, LinkState::Reconnecting);
    // Ligou de novo: zera as tentativas; a tela conhecida fica.
    link.on_started(Transport::Usb, None);
    assert_eq!((link.state, link.attempt, link.display), (LinkState::Live, 0, Some((1290, 2796))));
}

#[test]
fn depois_de_varias_tentativas_vira_sem_conexao_e_espera_mais() {
    let mut link = Link::default();
    let mut waits = Vec::new();
    for _ in 0..OFFLINE_AFTER + 1 {
        link.on_spawn();
        waits.push(link.on_lost("não abriu"));
    }
    assert_eq!(link.state, LinkState::Offline);
    assert_eq!(waits.iter().map(|d| d.as_millis()).collect::<Vec<_>>(), [500, 1000, 2000, 4000, 8000]);
    // Continua sem conexão enquanto tenta.
    link.on_spawn();
    assert_eq!(link.state, LinkState::Offline);
    assert_eq!(link.error.as_deref(), Some("não abriu"));
}

#[test]
fn falta_do_xcode_e_sem_conexao_ja_e_pausa_zera() {
    let mut link = Link::default();
    link.on_spawn();
    assert_eq!(link.on_fatal("precisa do Xcode").as_secs(), 30);
    assert_eq!(link.state, LinkState::Offline);
    link.on_paused();
    assert_eq!((link.state, link.attempt), (LinkState::Paused, 0));
    link.on_spawn();
    assert_eq!(link.state, LinkState::Connecting);
    assert!(is_fatal("coredevice") && !is_fatal("connect"));
}

#[test]
fn a_saida_do_helper_vira_uma_frase() {
    assert!(exit_reason(Some(2), None).contains("não está conectado"));
    assert!(exit_reason(None, Some(11)).contains("sinal 11"));
    assert!(exit_reason(Some(77), None).contains("77"));
}

// ── Entrada (toque, botões, teclado) ──

#[test]
fn toque_vira_linha_em_proporcao_presa_entre_0_e_1() {
    assert_eq!(touch_line(TouchPhase::Start, (0.5, 0.25), None, Edge::None), "touch start 0.5000 0.2500 none");
    assert_eq!(touch_line(TouchPhase::Move, (1.2, -0.1), None, Edge::Bottom), "touch move 1.0000 0.0000 bottom");
    assert_eq!(touch_line(TouchPhase::End, (0.1, 0.2), Some((0.3, 0.4)), Edge::Top), "touch end 0.1000 0.2000 0.3000 0.4000 top");
    assert_eq!(touch_line(TouchPhase::Move, (f64::NAN, 0.5), None, Edge::None), "touch move 0.0000 0.5000 none");
}

#[test]
fn clique_na_tela_vira_proporcao_e_a_borda_de_baixo_vira_gesto_de_inicio() {
    // A view mostra a tela já recortada (sem as bordas de alinhamento do vídeo): a proporção é a da view.
    assert_eq!(view_touch(215.0, 466.0, 430.0, 932.0), Some(((0.5, 0.5), Edge::None)));
    let (_, edge) = view_touch(215.0, 931.0, 430.0, 932.0).unwrap();
    assert_eq!(edge, Edge::Bottom);
    let (_, edge) = view_touch(215.0, 2.0, 430.0, 932.0).unwrap();
    assert_eq!(edge, Edge::Top);
    assert_eq!(view_touch(10.0, 10.0, 0.0, 932.0), None);
}

#[test]
fn pontos_do_ios_viram_proporcao_da_tela() {
    assert_eq!(point_ratio(215.0, 466.0, (430.0, 932.0)).unwrap(), (0.5, 0.5));
    assert!(point_ratio(500.0, 10.0, (430.0, 932.0)).is_err());
    assert!(point_ratio(10.0, 10.0, (0.0, 0.0)).is_err());
    assert_eq!(display_points((1290, 2796), "iphone"), (430.0, 932.0));
    assert_eq!(display_points((750, 1334), "iphone"), (375.0, 667.0));
    assert_eq!(display_points((1640, 2360), "ipad"), (820.0, 1180.0));
}

#[test]
fn botoes_tem_a_pagina_e_o_uso_hid_e_viram_descer_e_subir() {
    assert_eq!(button_usage("home"), Some((0x0C, 0x40)));
    assert_eq!(button_usage("lock"), Some((0x0C, 0x30)));
    assert_eq!(button_usage("side"), Some((0x0C, 0x30)));
    assert_eq!(button_usage("volumeUp"), Some((0x0C, 0xE9)));
    assert_eq!(button_usage("volume-down"), Some((0x0C, 0xEA)));
    assert_eq!(button_usage("mute"), Some((0x0C, 0xE2)));
    assert_eq!(button_usage("siri"), Some((0x0C, 0xCF)));
    assert_eq!(button_usage("reboot"), None);
    assert_eq!(button_lines("home").unwrap(), ["button 12 64 down", "button 12 64 up"]);
    assert!(button_lines("apagar tudo").is_err());
}

#[test]
fn gestos_do_sistema_saem_da_borda_certa() {
    let cc = gesture("controlCenter").unwrap();
    assert!(cc.from.0 > 0.8 && cc.from.1 < 0.02 && cc.to.1 > 0.3 && cc.edge == Edge::Top);
    let nc = gesture("notificationCenter").unwrap();
    assert!(nc.from.0 < 0.3 && nc.from.1 < 0.02 && nc.edge == Edge::Top);
    let sp = gesture("spotlight").unwrap();
    assert!((sp.from.0 - 0.5).abs() < 0.01 && sp.from.1 > 0.2 && sp.to.1 > sp.from.1 && sp.edge == Edge::None);
    let home = gesture("home").unwrap();
    assert!(home.from.1 > 0.98 && home.to.1 < 0.9 && home.edge == Edge::Bottom);
    assert!(gesture("desligar").is_none());
}

#[test]
fn deslize_vira_inicio_passos_e_fim_com_a_mesma_borda() {
    let lines = swipe_lines((0.8, 0.6), (0.2, 0.6), 4, Edge::None);
    assert_eq!(lines.len(), 6);
    assert_eq!(lines[0], "touch start 0.8000 0.6000 none");
    assert_eq!(lines[1], "touch move 0.6500 0.6000 none");
    assert_eq!(lines[4], "touch move 0.2000 0.6000 none");
    assert_eq!(lines[5], "touch end 0.2000 0.6000 none");
}

#[test]
fn texto_vira_teclas_com_shift_e_recusa_o_que_o_teclado_us_nao_tem() {
    assert_eq!(text_lines("aB").unwrap(), ["key 4 down", "key 4 up", "key 225 down", "key 5 down", "key 5 up", "key 225 up"]);
    assert!(text_lines("ç").is_err());
    assert_eq!(key_lines("enter").unwrap(), ["key 40 down", "key 40 up"]);
}

#[test]
fn recorte_da_foto_tira_as_bordas_do_video() {
    assert_eq!(crop_size((1296, 2816), Some((1290, 2796))), (1290, 2796));
    assert_eq!(crop_size((1296, 2816), None), (1296, 2816));
    assert_eq!(crop_size((1296, 2816), Some((2000, 2796))), (1296, 2816));
}

#[test]
fn agente_no_aparelho_fisico_pede_a_pessoa_menos_quando_ela_disse_sempre() {
    // Olhar nunca pede.
    assert!(!agent_asks("shot", false, false));
    // Tocar, deslizar, tecla e botão: pedem até a pessoa dizer "sempre neste aparelho".
    for action in ["tap", "swipe", "key", "button", "launch", "close", "open"] {
        assert!(agent_asks(action, false, false), "{action}");
        assert!(!agent_asks(action, true, false), "{action}");
        // O "sempre digitar" não libera toque.
        assert!(agent_asks(action, false, true), "{action}");
    }
    assert!(!agent_asks("apps", false, false));
    // Digitar texto no celular de verdade tem confiança própria: o "sempre" dos toques não vale, o "sempre digitar" sim.
    assert!(agent_asks("type", true, false));
    assert!(!agent_asks("type", false, true));
    // O CoreDevice agora cobre apps e URLs; ligar simulador, girar e clipboard seguem fora do iPhone físico.
    assert!(!agent_unsupported("open") && !agent_unsupported("launch") && !agent_unsupported("close"));
    assert!(agent_unsupported("start") && agent_unsupported("rotate") && agent_unsupported("clipboard"));
    assert!(!agent_unsupported("tap") && !agent_unsupported("shot"));
}

#[test]
fn eventos_do_hid_do_helper() {
    assert_eq!(parse_event(br#"{"event":"inputReady","touch":true,"buttons":true,"keyboard":false}"#), HelperEvent::InputReady { touch: true, buttons: true, keyboard: false });
    assert_eq!(parse_event(br#"{"event":"inputReady"}"#), HelperEvent::InputReady { touch: false, buttons: false, keyboard: false });
    assert_eq!(parse_event(br#"{"event":"inputError","message":"O aparelho recusou a entrada.","command":"touch start"}"#), HelperEvent::InputError("O aparelho recusou a entrada.".into()));
}

/// Um pacote PACI (RFC 7798 §4.4.4) que embrulha `inner` (um pacote sem o cabeçalho de 2 bytes, que o PACI reaproveita
/// com o tipo `ctype`), com `phes` bytes de extensão.
fn paci(ctype: u8, inner_body: &[u8], phes: &[u8]) -> Vec<u8> {
    let mut p = vec![50 << 1, 1];
    let phs = phes.len() as u8;
    // A(1) | cType(6) | PHSsize(5) | F0 F1 F2 (3) | Y(1)
    p.push((ctype << 1) | (phs >> 4));
    p.push((phs & 0x0f) << 4);
    p.extend_from_slice(phes);
    p.extend_from_slice(inner_body);
    p
}

#[test]
fn pacote_paci_com_nal_simples_entra_no_quadro_em_vez_de_sumir() {
    let mut d = Depacketizer::default();
    // Um quadro P (tipo 1) inteiro, embrulhado num PACI com 3 bytes de extensão.
    let out = d.push(&rtp(1, 10, true, &paci(1, b"delta", &[9, 9, 9])));
    let unit = out.unit.expect("o quadro do PACI tem de sair");
    assert_eq!(unit.nals, vec![nal_of(1, b"delta")]);
    assert_eq!(d.packet_kinds().get(&50), Some(&1));
}

#[test]
fn pacote_paci_com_fragmento_monta_o_nal() {
    let mut d = Depacketizer::default();
    let unit = nal_of(1, &[5u8; 900]);
    let parts = fus(&unit, 3);
    // O primeiro fragmento vem embrulhado num PACI (sem o cabeçalho de 2 bytes do FU, que o PACI reaproveita).
    d.push(&rtp(1, 20, false, &paci(nal::FU, &parts[0][2..], &[])));
    d.push(&rtp(2, 20, false, &parts[1]));
    let out = d.push(&rtp(3, 20, true, &parts[2]));
    assert_eq!(out.unit.unwrap().nals, vec![unit]);
}

#[test]
fn tipo_de_pacote_desconhecido_vira_quadro_danificado_e_nao_some_calado() {
    let mut d = Depacketizer::default();
    let mut weird = vec![60 << 1, 1];
    weird.extend_from_slice(b"???");
    // O pacote estranho fecha o quadro: não sai (danificado) e conta como descartado.
    assert_eq!(d.push(&rtp(1, 30, true, &weird)).unit, None);
    assert_eq!(d.dropped, 1);
}

// ── Rolagem do trackpad e pinça ──

const VIEW: (f64, f64) = (430.0, 932.0);

#[test]
fn rolagem_com_fases_vira_um_dedo_que_desce_anda_e_solta() {
    let mut s = ScrollDrag::default();
    // Dedos começam no meio; o conteúdo sobe (delta negativo na rolagem natural): o dedo no aparelho sobe junto.
    assert_eq!(s.event(ScrollPhase::Began, false, (200.0, 500.0), (0.0, -10.0), true, VIEW), vec![(TouchPhase::Start, (200.0, 500.0)), (TouchPhase::Move, (200.0, 490.0))]);
    assert_eq!(s.event(ScrollPhase::Changed, false, (0.0, 0.0), (5.0, -20.0), true, VIEW), vec![(TouchPhase::Move, (205.0, 470.0))]);
    // Soltar: o iOS aplica a inércia dele pela velocidade do arrasto.
    assert_eq!(s.event(ScrollPhase::Ended, false, (0.0, 0.0), (0.0, 0.0), true, VIEW), vec![(TouchPhase::End, (205.0, 470.0))]);
    // A inércia do Mac fica de fora (senão o dedo voltaria a descer).
    assert!(s.event(ScrollPhase::None, true, (0.0, 0.0), (0.0, -30.0), true, VIEW).is_empty());
}

#[test]
fn rolagem_horizontal_e_presa_dentro_da_tela() {
    let mut s = ScrollDrag::default();
    s.event(ScrollPhase::Began, false, (420.0, 10.0), (0.0, 0.0), true, VIEW);
    let out = s.event(ScrollPhase::Changed, false, (0.0, 0.0), (50.0, -50.0), true, VIEW);
    assert_eq!(out, vec![(TouchPhase::Move, (429.0, 1.0))]);
}

#[test]
fn roda_do_mouse_vira_um_arrasto_curto_e_mudanca_sem_inicio_comeca_no_cursor() {
    let mut s = ScrollDrag::default();
    let out = s.event(ScrollPhase::None, false, (100.0, 400.0), (0.0, -1.0), false, VIEW);
    assert_eq!(out, vec![(TouchPhase::Start, (100.0, 400.0)), (TouchPhase::Move, (100.0, 388.0)), (TouchPhase::End, (100.0, 388.0))]);
    // Uma mudança que chegou sem o "começou" (o Mac às vezes perde): começa ali mesmo.
    let out = s.event(ScrollPhase::Changed, false, (50.0, 50.0), (0.0, 10.0), true, VIEW);
    assert_eq!(out, vec![(TouchPhase::Start, (50.0, 50.0)), (TouchPhase::Move, (50.0, 60.0))]);
}

#[test]
fn pinca_abre_e_fecha_dois_dedos_em_volta_do_cursor() {
    let mut p = Pinch::default();
    let start = p.event(ScrollPhase::Began, (215.0, 466.0), 0.0, VIEW).unwrap();
    assert_eq!(start.0, TouchPhase::Start);
    let (a, b) = (start.1, start.2);
    assert!((a.1 - 466.0).abs() < 1e-9 && (b.1 - 466.0).abs() < 1e-9 && a.0 < 215.0 && b.0 > 215.0);
    let spread0 = b.0 - a.0;
    // Ampliar 50%: os dedos se afastam na mesma proporção, em volta do mesmo centro.
    let (phase, a2, b2) = p.event(ScrollPhase::Changed, (0.0, 0.0), 0.5, VIEW).unwrap();
    assert_eq!(phase, TouchPhase::Move);
    assert!(((b2.0 - a2.0) - spread0 * 1.5).abs() < 1e-9 && ((a2.0 + b2.0) / 2.0 - 215.0).abs() < 1e-9);
    let (phase, ..) = p.event(ScrollPhase::Ended, (0.0, 0.0), 0.0, VIEW).unwrap();
    assert_eq!(phase, TouchPhase::End);
    assert!(p.event(ScrollPhase::Changed, (0.0, 0.0), 0.1, VIEW).is_none());
}

#[test]
fn toque_com_dois_dedos_vira_linha_com_o_segundo_ponto() {
    assert_eq!(touch_line(TouchPhase::Move, (0.4, 0.5), Some((0.6, 0.5)), Edge::None), "touch move 0.4000 0.5000 0.6000 0.5000 none");
}

#[test]
fn alternador_de_apps_sobe_da_borda_e_segura_antes_de_soltar() {
    let g = gesture("appSwitcher").unwrap();
    assert!(g.from.1 > 0.98 && g.to.1 < 0.8 && g.edge == Edge::Bottom && g.hold_ms >= 300);
    assert_eq!(gesture("home").unwrap().hold_ms, 0);
}

#[test]
fn botao_segurado_desce_e_sobe_em_linhas_separadas() {
    assert_eq!(button_state_line("lock", true).unwrap(), "button 12 48 down");
    assert_eq!(button_state_line("volumeUp", false).unwrap(), "button 12 233 up");
    assert!(button_state_line("formatar", true).is_err());
}

#[test]
fn atalhos_do_teclado_com_command_viram_botoes() {
    // Códigos de tecla do Mac: 126 = seta para cima, 125 = para baixo, 37 = L, 4 = H.
    assert_eq!(shortcut(126, true, false), Some(Shortcut::Button("volumeUp")));
    assert_eq!(shortcut(125, true, false), Some(Shortcut::Button("volumeDown")));
    assert_eq!(shortcut(37, true, false), Some(Shortcut::Button("lock")));
    assert_eq!(shortcut(4, true, true), Some(Shortcut::Home));
    assert_eq!(shortcut(126, false, false), None);
    assert_eq!(shortcut(4, true, false), None);
}

// ── Quando soltar um quadro mostrado (o pool do VideoToolbox reaproveita a superfície) ──

#[test]
fn so_solta_o_quadro_que_a_tela_nao_usa_mais_e_guarda_os_dois_mais_novos() {
    // Do mais velho ao mais novo: em uso pela tela?
    let plan = release_plan(&[false, true, false, true, false], 16);
    // Os dois mais novos ficam sempre; dos outros, só sai o que a tela largou.
    assert_eq!(plan.release, vec![0, 2]);
    assert_eq!(plan.forced, 0);
    // A regra antiga (guardar 3) teria soltado o índice 1, ainda na tela: é o perigo que a conta mostra.
    assert_eq!(plan.unsafe_before, 1);
}

#[test]
fn com_quadros_demais_presos_solta_os_mais_velhos_mesmo_em_uso() {
    let plan = release_plan(&[true; 20], 16);
    assert_eq!(plan.release, vec![0, 1, 2, 3]);
    assert_eq!(plan.forced, 4);
}
