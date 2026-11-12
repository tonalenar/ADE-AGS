//! Gravação do vídeo do espelho: o SPS, o MP4 (estrutura conferida por um leitor de caixas escrito aqui) e a thread
//! que escreve. Os quadros são HEVC de verdade, feitos pelo codificador do macOS (`scripts/gerar-fixture-hevc.swift`):
//! os bytes de cada quadro têm de reaparecer, intactos, no `mdat`.

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::model::ParamSets;
use super::mp4::{self, Mp4Writer, Sample, parse_sps};
use super::recording::{FileWriter, Frame, Recording, Writer};

const PORTRAIT: &[u8] = include_bytes!("testdata/hevc-128x256.bin");
const LANDSCAPE: &[u8] = include_bytes!("testdata/hevc-256x128.bin");

struct Clip {
    params: ParamSets,
    /// (horário RTP, quadro-chave, NALs com prefixo de 4 bytes)
    frames: Vec<(u32, bool, Vec<u8>)>,
}

fn clip(bytes: &[u8]) -> Clip {
    assert_eq!(&bytes[..4], b"HEV1");
    let mut at = 4;
    let u32be = |at: &mut usize| {
        let v = u32::from_be_bytes(bytes[*at..*at + 4].try_into().unwrap());
        *at += 4;
        v as usize
    };
    let set = |at: &mut usize| {
        let len = u32be(at);
        let data = bytes[*at..*at + len].to_vec();
        *at += len;
        data
    };
    let params = ParamSets { vps: set(&mut at), sps: set(&mut at), pps: set(&mut at) };
    let count = u32be(&mut at);
    let mut frames = Vec::new();
    for _ in 0..count {
        let ts = u32be(&mut at) as u32;
        let irap = bytes[at] == 1;
        at += 1;
        let len = u32be(&mut at);
        frames.push((ts, irap, bytes[at..at + len].to_vec()));
        at += len;
    }
    Clip { params, frames }
}

fn sample<'a>(clip: &'a Clip, i: usize) -> Sample<'a> {
    let (ts, sync, data) = &clip.frames[i];
    Sample { ts: *ts, sync: *sync, data, params: &clip.params, display: None, previous_duration: None }
}

// ── Um leitor de caixas mínimo ──

#[derive(Debug)]
struct Mp4 {
    bytes: Vec<u8>,
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

/// Os filhos de uma caixa: (tipo, corpo, início do corpo no arquivo).
fn children(bytes: &[u8], mut at: usize, end: usize) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    while at + 8 <= end {
        let mut size = be32(bytes, at) as usize;
        let kind = String::from_utf8_lossy(&bytes[at + 4..at + 8]).into_owned();
        let mut head = 8;
        if size == 1 {
            size = u64::from_be_bytes(bytes[at + 8..at + 16].try_into().unwrap()) as usize;
            head = 16;
        }
        assert!(size >= head && at + size <= end, "caixa {kind} com tamanho {size} fora do arquivo");
        out.push((kind, at + head, at + size));
        at += size;
    }
    assert_eq!(at, end, "sobrou lixo depois da última caixa");
    out
}

impl Mp4 {
    fn find(&self, within: (usize, usize), kind: &str) -> Option<(usize, usize)> {
        children(&self.bytes, within.0, within.1).into_iter().find(|c| c.0 == kind).map(|c| (c.1, c.2))
    }

    fn path(&self, kinds: &[&str]) -> (usize, usize) {
        let mut within = (0, self.bytes.len());
        for kind in kinds {
            within = self.find(within, kind).unwrap_or_else(|| panic!("falta a caixa {kind}"));
        }
        within
    }

    fn stbl(&self) -> (usize, usize) {
        self.path(&["moov", "trak", "mdia", "minf", "stbl"])
    }

    fn table(&self, kind: &str) -> (usize, usize) {
        let stbl = self.stbl();
        let (start, end) = self.find(stbl, kind).unwrap_or_else(|| panic!("falta {kind}"));
        (start + 4, end) // depois de versão e flags
    }

    fn stsz(&self) -> Vec<u32> {
        let (at, _) = self.table("stsz");
        assert_eq!(be32(&self.bytes, at), 0, "tamanho fixo não é esperado");
        let count = be32(&self.bytes, at + 4) as usize;
        (0..count).map(|i| be32(&self.bytes, at + 8 + 4 * i)).collect()
    }

    fn stco(&self) -> Vec<u64> {
        let (at, _) = self.table("stco");
        let count = be32(&self.bytes, at) as usize;
        (0..count).map(|i| u64::from(be32(&self.bytes, at + 4 + 4 * i))).collect()
    }

    /// (primeiro bloco, amostras por bloco, entrada)
    fn stsc(&self) -> Vec<(u32, u32, u32)> {
        let (at, _) = self.table("stsc");
        let count = be32(&self.bytes, at) as usize;
        (0..count).map(|i| (be32(&self.bytes, at + 4 + 12 * i), be32(&self.bytes, at + 8 + 12 * i), be32(&self.bytes, at + 12 + 12 * i))).collect()
    }

    /// (quantas, duração) — cada entrada do `stts`.
    fn stts(&self) -> Vec<(u32, u32)> {
        let (at, _) = self.table("stts");
        let count = be32(&self.bytes, at) as usize;
        (0..count).map(|i| (be32(&self.bytes, at + 4 + 8 * i), be32(&self.bytes, at + 8 + 8 * i))).collect()
    }

    fn stss(&self) -> Vec<u32> {
        let (at, _) = self.table("stss");
        let count = be32(&self.bytes, at) as usize;
        (0..count).map(|i| be32(&self.bytes, at + 4 + 4 * i)).collect()
    }

    fn entries(&self) -> Vec<(String, usize, usize)> {
        let (start, end) = self.table("stsd");
        let count = be32(&self.bytes, start) as usize;
        let entries = children(&self.bytes, start + 4, end);
        assert_eq!(entries.len(), count);
        entries
    }

    /// Onde cada amostra está no arquivo (offset, tamanho, entrada), seguindo `stsc`, `stco` e `stsz`.
    fn samples(&self) -> Vec<(u64, u32, u32)> {
        let sizes = self.stsz();
        let offsets = self.stco();
        let rows = self.stsc();
        let mut out = Vec::new();
        let mut next = 0;
        for (i, offset) in offsets.iter().enumerate() {
            let chunk = i as u32 + 1;
            let row = rows.iter().rev().find(|r| r.0 <= chunk).expect("o primeiro bloco tem de ter linha no stsc");
            let mut at = *offset;
            for _ in 0..row.1 {
                out.push((at, sizes[next], row.2));
                at += u64::from(sizes[next]);
                next += 1;
            }
        }
        assert_eq!(next, sizes.len(), "o stsc/stco não cobrem todas as amostras");
        out
    }

    /// Largura e altura da trilha (16.16, nos últimos 8 bytes do `tkhd`).
    fn tkhd_size(&self) -> (u32, u32) {
        let (_, end) = self.path(&["moov", "trak", "tkhd"]);
        (be32(&self.bytes, end - 8) >> 16, be32(&self.bytes, end - 4) >> 16)
    }

    fn mdhd(&self) -> (u32, u32) {
        let (at, _) = self.path(&["moov", "trak", "mdia", "mdhd"]);
        (be32(&self.bytes, at + 12), be32(&self.bytes, at + 16)) // escala de tempo, duração
    }

    fn mvhd_duration(&self) -> u32 {
        let (at, _) = self.path(&["moov", "mvhd"]);
        be32(&self.bytes, at + 16)
    }
}

fn mux(clips: &[(&Clip, std::ops::Range<usize>)]) -> (mp4::Summary, Mp4) {
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    for (clip, range) in clips {
        for i in range.clone() {
            writer.push(sample(clip, i)).unwrap();
        }
    }
    let (summary, out) = writer.finish(800).unwrap();
    (summary, Mp4 { bytes: out.into_inner() })
}

// ── SPS ──

#[test]
fn o_sps_real_do_codificador_diz_o_tamanho_e_o_perfil() {
    let portrait = clip(PORTRAIT);
    let sps = parse_sps(&portrait.params.sps).unwrap();
    // O codificador de hardware alinha a largura (160) e recorta pela janela de conformidade: o que se vê é 128×256.
    assert_eq!(sps.coded, (160, 256));
    assert_eq!(sps.visible, (128, 256), "a janela de conformidade do SPS entra na conta");
    assert_eq!(sps.chroma_format_idc, 1, "4:2:0");
    assert_eq!((sps.bit_depth_luma_minus8, sps.bit_depth_chroma_minus8), (0, 0), "8 bits");
    assert!(matches!(sps.profile_idc, 1 | 2), "Main ou Main 10, veio {}", sps.profile_idc);
    assert!(sps.level_idc > 0);
    let landscape = parse_sps(&clip(LANDSCAPE).params.sps).unwrap();
    assert_eq!(landscape.visible, (256, 128));
}

#[test]
fn sps_estragado_ou_de_outra_nal_nao_vira_arquivo() {
    let portrait = clip(PORTRAIT);
    assert!(parse_sps(&portrait.params.pps).is_err(), "um PPS não é SPS");
    assert!(parse_sps(&[]).is_err());
    assert!(parse_sps(&portrait.params.sps[..6]).is_err(), "SPS cortado");
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    let broken = ParamSets { sps: portrait.params.sps[..6].to_vec(), ..portrait.params.clone() };
    let (ts, sync, data) = &portrait.frames[0];
    let error = writer.push(Sample { ts: *ts, sync: *sync, data, params: &broken, display: None, previous_duration: None }).unwrap_err();
    assert!(error.contains("SPS"), "{error}");
}

// ── O MP4 ──

#[test]
fn o_mp4_guarda_os_bytes_dos_quadros_sem_recodificar() {
    let portrait = clip(PORTRAIT);
    let (summary, file) = mux(&[(&portrait, 0..portrait.frames.len())]);
    assert_eq!(summary.frames, 24);
    let samples = file.samples();
    assert_eq!(samples.len(), 24);
    for (i, (offset, size, entry)) in samples.iter().enumerate() {
        let original = &portrait.frames[i].2;
        assert_eq!(*size as usize, original.len(), "tamanho do quadro {i}");
        assert_eq!(&file.bytes[*offset as usize..*offset as usize + *size as usize], original.as_slice(), "bytes do quadro {i}");
        assert_eq!(*entry, 1);
    }
    // Os quadros-chave do arquivo são os que o aparelho marcou.
    let sync: Vec<u32> = portrait.frames.iter().enumerate().filter(|(_, f)| f.1).map(|(i, _)| i as u32 + 1).collect();
    assert_eq!(file.stss(), sync);
    assert_eq!(sync[0], 1, "começa num quadro-chave");
}

#[test]
fn o_mp4_fecha_o_mdat_e_poe_o_moov_depois_dele() {
    let portrait = clip(PORTRAIT);
    let (summary, file) = mux(&[(&portrait, 0..portrait.frames.len())]);
    let top = children(&file.bytes, 0, file.bytes.len());
    let kinds: Vec<&str> = top.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(kinds, ["ftyp", "mdat", "moov"], "o moov vem depois do mdat e o tamanho do mdat está certo");
    let payload: usize = portrait.frames.iter().map(|f| f.2.len()).sum();
    let mdat = &top[1];
    assert_eq!(mdat.2 - mdat.1, payload, "o mdat tem só os quadros");
    assert_eq!(summary.bytes as usize, file.bytes.len());
}

#[test]
fn a_duracao_vem_do_relogio_do_rtp_e_o_ultimo_quadro_usa_o_que_foi_dito() {
    let portrait = clip(PORTRAIT);
    let (summary, file) = mux(&[(&portrait, 0..24)]);
    // 23 intervalos de 800 ticks entre os horários + 800 do último = 24 × 800 = 0,8 s.
    assert_eq!(summary.duration_ticks, 24 * 800);
    assert_eq!(file.mdhd(), (24_000, 24 * 800));
    assert_eq!(file.mvhd_duration(), 800, "o filme em milissegundos");
    let total: u64 = file.stts().iter().map(|&(n, d)| u64::from(n) * u64::from(d)).sum();
    assert_eq!(total, summary.duration_ticks, "o stts soma a duração");
    assert_eq!(file.stts(), vec![(24, 800)], "durações iguais viram uma entrada só");
}

#[test]
fn tela_parada_o_quadro_segura_o_tempo_real_entre_os_horarios() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    // O 3º quadro chega 5 s depois do 2º (o aparelho calou com a tela parada).
    let times = [0, 800, 800 + 5 * 24_000, 1_600 + 5 * 24_000, 2_400 + 5 * 24_000, 3_200 + 5 * 24_000];
    for (i, ts) in times.into_iter().enumerate() {
        let mut s = sample(&portrait, i);
        s.ts = ts;
        writer.push(s).unwrap();
    }
    let (summary, out) = writer.finish(800).unwrap();
    let file = Mp4 { bytes: out.into_inner() };
    assert!(file.stts().iter().any(|&(_, d)| d == 5 * 24_000), "o salto de 5 s está no stts: {:?}", file.stts());
    assert_eq!(summary.duration_ticks, u64::from(times[5]) + 800);
}

#[test]
fn horario_rtp_que_da_a_volta_no_u32_nao_estraga_a_duracao() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    let start = u32::MAX - 1_000;
    for i in 0..4usize {
        let mut s = sample(&portrait, i);
        s.sync = i == 0;
        s.ts = start.wrapping_add(i as u32 * 800);
        writer.push(s).unwrap();
    }
    let (summary, _) = writer.finish(800).unwrap();
    assert_eq!(summary.duration_ticks, 4 * 800);
}

#[test]
fn nova_conexao_usa_o_intervalo_informado_em_vez_do_horario_rtp_novo() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    writer.push(sample(&portrait, 0)).unwrap();
    let mut after = sample(&portrait, 12); // um quadro-chave
    after.ts = 7_000_000; // relógio novo, sem relação com o anterior
    after.previous_duration = Some(48_000); // o Mac mediu 2 s
    writer.push(after).unwrap();
    let (summary, _) = writer.finish(800).unwrap();
    assert_eq!(summary.duration_ticks, 48_000 + 800);
}

#[test]
fn o_primeiro_quadro_tem_de_ser_chave() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    let error = writer.push(sample(&portrait, 1)).unwrap_err();
    assert!(error.contains("quadro-chave"), "{error}");
}

#[test]
fn sem_nenhum_quadro_nao_ha_arquivo_para_finalizar() {
    let writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    assert!(writer.finish(800).is_err());
}

#[test]
fn o_tamanho_da_trilha_e_o_da_tela_do_aparelho_e_a_abertura_limpa_corta_as_bordas() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    // Como no aparelho: o vídeo codificado tem bordas de alinhamento à direita e embaixo.
    for i in 0..3 {
        let mut s = sample(&portrait, i);
        s.display = Some((126, 250));
        writer.push(s).unwrap();
    }
    let (summary, out) = writer.finish(800).unwrap();
    let file = Mp4 { bytes: out.into_inner() };
    assert_eq!(summary.display, (126, 250));
    assert_eq!(file.tkhd_size(), (126, 250), "a trilha mostra a tela, sem as bordas");
    let entries = file.entries();
    let (kind, start, end) = &entries[0];
    assert_eq!(kind, "hvc1");
    let inner = children(&file.bytes, start + 78, *end);
    let kinds: Vec<&str> = inner.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(kinds, ["hvcC", "clap", "pasp"]);
    let clap = &inner[1];
    assert_eq!((be32(&file.bytes, clap.1), be32(&file.bytes, clap.1 + 8)), (126, 250), "largura e altura da abertura");
    assert_eq!(be32(&file.bytes, clap.1 + 16) as i32, -2, "o centro da abertura anda 2 px para a esquerda (numerador sobre 2)");
    assert_eq!(be32(&file.bytes, clap.1 + 24) as i32, -6);
}

#[test]
fn tela_maior_que_a_imagem_ou_igual_a_ela_nao_cria_abertura() {
    let portrait = clip(PORTRAIT);
    for display in [Some((128, 256)), Some((4000, 4000)), Some((0, 0)), None] {
        let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
        let mut s = sample(&portrait, 0);
        s.display = display;
        writer.push(s).unwrap();
        let (summary, out) = writer.finish(800).unwrap();
        assert_eq!(summary.display, (128, 256), "{display:?}");
        let file = Mp4 { bytes: out.into_inner() };
        let (_, start, end) = file.entries()[0].clone();
        let kinds: Vec<String> = children(&file.bytes, start + 78, end).into_iter().map(|c| c.0).collect();
        assert_eq!(kinds, ["hvcC", "pasp"], "{display:?}");
    }
}

#[test]
fn o_hvcc_leva_os_conjuntos_de_parametros_e_o_perfil_do_sps() {
    let portrait = clip(PORTRAIT);
    let (_, file) = mux(&[(&portrait, 0..2)]);
    let (_, start, end) = file.entries()[0].clone();
    let hvcc = &children(&file.bytes, start + 78, end)[0];
    assert_eq!(hvcc.0, "hvcC");
    let body = &file.bytes[hvcc.1..hvcc.2];
    let sps = parse_sps(&portrait.params.sps).unwrap();
    assert_eq!(body[0], 1, "versão");
    assert_eq!(body[1] & 0x1f, sps.profile_idc);
    assert_eq!(body[12], sps.level_idc);
    assert_eq!(body[21] & 3, 3, "prefixo de tamanho de 4 bytes");
    assert_eq!(body[22], 3, "três conjuntos: VPS, SPS, PPS");
    let mut at = 23;
    for (kind, set) in [(32u8, &portrait.params.vps), (33, &portrait.params.sps), (34, &portrait.params.pps)] {
        assert_eq!(body[at] & 0x3f, kind);
        assert_eq!(u16::from_be_bytes([body[at + 1], body[at + 2]]), 1);
        let len = u16::from_be_bytes([body[at + 3], body[at + 4]]) as usize;
        assert_eq!(&body[at + 5..at + 5 + len], set.as_slice());
        at += 5 + len;
    }
}

#[test]
fn girar_o_aparelho_no_meio_da_gravacao_abre_outra_entrada_de_amostras() {
    let portrait = clip(PORTRAIT);
    let landscape = clip(LANDSCAPE);
    let (summary, file) = mux(&[(&portrait, 0..13), (&landscape, 0..12)]);
    assert_eq!(summary.frames, 25);
    assert_eq!(summary.display, (128, 256), "a trilha tem o tamanho da primeira entrada");
    let entries = file.entries();
    assert_eq!(entries.len(), 2);
    let samples = file.samples();
    assert!(samples[..13].iter().all(|s| s.2 == 1) && samples[13..].iter().all(|s| s.2 == 2), "cada amostra aponta a entrada do seu tamanho");
    // Os bytes continuam íntegros dos dois lados da troca.
    let (offset, size, _) = samples[13];
    assert_eq!(&file.bytes[offset as usize..(offset + u64::from(size)) as usize], landscape.frames[0].2.as_slice());
    // Um bloco nunca mistura entradas: a troca abre um bloco novo.
    let rows = file.stsc();
    assert!(rows.iter().any(|r| r.2 == 2));
}

#[test]
fn blocos_de_30_quadros_e_o_indice_fica_pequeno() {
    let portrait = clip(PORTRAIT);
    let mut writer = Mp4Writer::new(Cursor::new(Vec::new())).unwrap();
    for n in 0..95u32 {
        let mut s = sample(&portrait, (n % 24) as usize);
        s.sync = n == 0 || n % 24 == 12;
        // Os quadros de referência nos horários continuam andando.
        s.ts = n * 800;
        writer.push(s).unwrap();
    }
    let (_, out) = writer.finish(800).unwrap();
    let file = Mp4 { bytes: out.into_inner() };
    assert_eq!(file.stco().len(), 4, "95 quadros em blocos de 30");
    assert_eq!(file.samples().len(), 95);
    assert_eq!(file.stsc(), vec![(1, 30, 1), (4, 5, 1)]);
}

// ── A thread que escreve ──

/// Um escritor falso: guarda o que recebeu e o que lhe pediram.
#[derive(Default)]
struct Log {
    frames: Vec<(u32, bool)>,
    finished_with: Option<Duration>,
    aborted: bool,
}

struct Fake {
    log: Arc<Mutex<Log>>,
    fail_at: Option<usize>,
    /// Avisa quando o escritor foi descartado (o `abort` chega pelo canal, sem hora marcada).
    discarded: Option<mpsc::Sender<()>>,
}

impl Writer for Fake {
    fn write(&mut self, frame: &Frame) -> Result<(), String> {
        let mut log = self.log.lock().unwrap();
        if self.fail_at == Some(log.frames.len()) {
            return Err("disco cheio".into());
        }
        log.frames.push((frame.ts, frame.irap));
        Ok(())
    }

    fn finish(&mut self, tail: Duration) -> Result<mp4::Summary, String> {
        let mut log = self.log.lock().unwrap();
        log.finished_with = Some(tail);
        Ok(mp4::Summary { frames: log.frames.len() as u64, duration_ticks: 0, display: (1, 1), bytes: 0 })
    }

    fn abort(&mut self) {
        self.log.lock().unwrap().aborted = true;
        if let Some(discarded) = &self.discarded {
            let _ = discarded.send(());
        }
    }
}

fn frame(ts: u32, irap: bool) -> Frame {
    Frame { ts, irap, data: vec![0, 0, 0, 1, 2], params: ParamSets::default(), display: None, arrived: Instant::now(), discontinuity: false }
}

#[test]
fn iniciar_gravar_e_parar_entrega_os_quadros_em_ordem_e_fecha_o_arquivo() {
    let log = Arc::new(Mutex::new(Log::default()));
    let recording = Recording::start(Fake { log: log.clone(), fail_at: None, discarded: None });
    let tap = recording.tap();
    for (i, ts) in [100, 900, 1700].into_iter().enumerate() {
        assert!(tap.push(frame(ts, i == 0)));
    }
    recording.wait_first_frame(Duration::from_secs(5)).unwrap();
    let summary = recording.stop().unwrap();
    assert_eq!(summary.frames, 3);
    let log = log.lock().unwrap();
    assert_eq!(log.frames, vec![(100, true), (900, false), (1700, false)]);
    assert!(log.finished_with.is_some(), "o escritor foi finalizado");
    assert!(!log.aborted);
}

#[test]
fn falha_do_escritor_aparece_ao_esperar_o_primeiro_quadro_e_nada_fica_no_disco() {
    let log = Arc::new(Mutex::new(Log::default()));
    let (discarded, wait) = mpsc::channel();
    let recording = Recording::start(Fake { log: log.clone(), fail_at: Some(0), discarded: Some(discarded) });
    assert!(recording.tap().push(frame(1, true)));
    let error = recording.wait_first_frame(Duration::from_secs(5)).unwrap_err();
    assert_eq!(error, "disco cheio");
    // O escritor foi descartado assim que falhou, não só ao parar.
    wait.recv_timeout(Duration::from_secs(5)).expect("o escritor devia ter descartado o arquivo");
    recording.abort();
    assert!(log.lock().unwrap().aborted);
}

#[test]
fn falha_no_meio_da_gravacao_vira_o_erro_de_parar_e_descarta_o_arquivo() {
    let log = Arc::new(Mutex::new(Log::default()));
    let recording = Recording::start(Fake { log: log.clone(), fail_at: Some(2), discarded: None });
    let tap = recording.tap();
    for (i, ts) in [100, 900, 1700, 2500].into_iter().enumerate() {
        tap.push(frame(ts, i == 0));
    }
    let error = recording.stop().unwrap_err();
    assert_eq!(error, "disco cheio");
    let log = log.lock().unwrap();
    assert!(log.aborted, "o arquivo parcial foi descartado");
    assert!(log.finished_with.is_none(), "um arquivo que falhou não é finalizado");
    assert_eq!(log.frames.len(), 2);
}

#[test]
fn sem_nenhum_quadro_esperar_o_primeiro_acaba_com_um_erro_que_diz_o_que_fazer() {
    let log = Arc::new(Mutex::new(Log::default()));
    let recording = Recording::start(Fake { log, fail_at: None, discarded: None });
    let error = recording.wait_first_frame(Duration::from_millis(1)).unwrap_err();
    assert!(error.contains("nenhum quadro"), "{error}");
    recording.abort();
}

// ── O arquivo de verdade ──

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ade-gravacao-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn real_frame(clip: &Clip, i: usize, at: Instant) -> Frame {
    let (ts, irap, data) = &clip.frames[i];
    Frame { ts: *ts, irap: *irap, data: data.clone(), params: clip.params.clone(), display: Some((126, 250)), arrived: at, discontinuity: false }
}

#[test]
fn o_arquivo_so_aparece_no_destino_depois_de_finalizado() {
    let dest = scratch("gravacao.mp4");
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let portrait = clip(PORTRAIT);
    let mut writer = FileWriter::create(&dest).unwrap();
    assert!(part.exists() && !dest.exists());
    let start = Instant::now();
    for i in 0..portrait.frames.len() {
        writer.write(&real_frame(&portrait, i, start)).unwrap();
    }
    let summary = writer.finish(Duration::from_millis(500)).unwrap();
    assert!(dest.exists() && !part.exists());
    assert_eq!(summary.frames, 24);
    // 23 intervalos de 800 + a cauda de 500 ms (12.000 ticks).
    assert_eq!(summary.duration_ticks, 23 * 800 + 12_000);
    let bytes = std::fs::read(&dest).unwrap();
    assert_eq!(bytes.len() as u64, summary.bytes);
    let file = Mp4 { bytes };
    assert_eq!(file.samples().len(), 24);
    let _ = std::fs::remove_dir_all(dest.parent().unwrap());
}

#[test]
fn cancelar_ou_perder_o_escritor_nao_deixa_arquivo_sem_moov() {
    let portrait = clip(PORTRAIT);
    // Cancelado.
    let dest = scratch("cancelada.mp4");
    let mut writer = FileWriter::create(&dest).unwrap();
    writer.write(&real_frame(&portrait, 0, Instant::now())).unwrap();
    writer.abort();
    assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 0);
    // Derrubado no meio (a thread acabou sem finalizar).
    let dest = scratch("derrubada.mp4");
    let mut writer = FileWriter::create(&dest).unwrap();
    writer.write(&real_frame(&portrait, 0, Instant::now())).unwrap();
    drop(writer);
    assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 0);
    // Um primeiro quadro que não é chave falha e o arquivo parcial é descartado pela thread que escreve.
    let dest = scratch("sem-chave.mp4");
    let recording = Recording::start(FileWriter::create(&dest).unwrap());
    recording.tap().push(real_frame(&portrait, 1, Instant::now()));
    let error = recording.wait_first_frame(Duration::from_secs(5)).unwrap_err();
    assert!(error.contains("quadro-chave"), "{error}");
    let error = recording.stop().unwrap_err();
    assert!(error.contains("quadro-chave"), "{error}");
    assert!(!dest.exists());
    assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 0);
}

#[test]
fn nova_conexao_mede_o_salto_pelo_relogio_do_mac() {
    let dest = scratch("reconectada.mp4");
    let portrait = clip(PORTRAIT);
    let mut writer = FileWriter::create(&dest).unwrap();
    let t0 = Instant::now();
    writer.write(&real_frame(&portrait, 0, t0)).unwrap();
    writer.write(&real_frame(&portrait, 1, t0 + Duration::from_millis(33))).unwrap();
    // O helper caiu e voltou 2 s depois, com o relógio do RTP em outro lugar.
    let mut after = real_frame(&portrait, 12, t0 + Duration::from_millis(2_033));
    after.ts = 9_999_999;
    after.discontinuity = true;
    writer.write(&after).unwrap();
    let summary = writer.finish(Duration::ZERO).unwrap();
    // 800 (ts) + 2.000 ms = 48.000 ticks + o último, que fica no mínimo um quadro (800).
    assert_eq!(summary.duration_ticks, 800 + 48_000 + 800);
    let _ = std::fs::remove_dir_all(dest.parent().unwrap());
}

// ── Sonda local: um MP4 de verdade para o AVFoundation ──

/// Grava os `.mp4` dos quadros sintéticos em `ADE_MP4_OUT` para conferir com `scripts/verificar-mp4.swift` (o
/// AVFoundation abre, mede a duração, decodifica todos os quadros e confere o tamanho). Não toca em aparelho.
///
/// `ADE_MP4_OUT=<pasta> cargo test --lib iphone::test_gravacao::sonda -- --ignored --nocapture`
#[test]
#[ignore = "sonda local: grava os .mp4 em ADE_MP4_OUT para o AVFoundation conferir"]
fn sonda_grava_mp4_de_verdade() {
    let out = PathBuf::from(std::env::var("ADE_MP4_OUT").expect("ADE_MP4_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let portrait = clip(PORTRAIT);
    let landscape = clip(LANDSCAPE);
    type Parte<'a> = (&'a Clip, usize, Option<(u32, u32)>);
    let write = |name: &str, parts: &[Parte], tail_ms: u64| {
        let dest = out.join(name);
        let mut writer = FileWriter::create(&dest).unwrap();
        let t0 = Instant::now();
        let mut n = 0u64;
        for (clip, count, display) in parts {
            for i in 0..*count {
                let mut f = real_frame(clip, i, t0 + Duration::from_millis(n * 33));
                f.display = *display;
                f.discontinuity = i == 0 && n > 0;
                writer.write(&f).unwrap();
                n += 1;
            }
        }
        let summary = writer.finish(Duration::from_millis(tail_ms)).unwrap();
        eprintln!("{name}: {} quadros, {:.3} s, tela {:?}, {} bytes", summary.frames, summary.duration_ticks as f64 / 24_000.0, summary.display, summary.bytes);
    };
    // 24 quadros × 800 ticks (30 fps) = 0,8 s; com a tela recortada como no aparelho.
    write("retrato.mp4", &[(&portrait, 24, Some((126, 250)))], 33);
    // Sem recorte.
    write("retrato-inteiro.mp4", &[(&portrait, 24, None)], 33);
    // Girou no meio: retrato e depois paisagem.
    write("girou.mp4", &[(&portrait, 12, None), (&landscape, 12, None)], 33);
}
