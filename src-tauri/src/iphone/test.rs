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
   "hardwareProperties":{"deviceType":"iPhone","marketingName":"iPhone 15 Pro Max","platform":"iOS","reality":"physical","serialNumber":"X"}},
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
