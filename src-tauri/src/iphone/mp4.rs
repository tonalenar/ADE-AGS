//! Empacota o HEVC do espelho num MP4 (`hvc1`) **sem recodificar**: os quadros são os mesmos bytes que o aparelho
//! mandou. Puro (sem macOS, sem AVFoundation), para poder ser testado em qualquer sistema.
//!
//! O arquivo é escrito em fluxo: o `mdat` (com tamanho de 64 bits, corrigido no fim) vai crescendo no disco e só o
//! índice dos quadros (tamanho, duração, quadro-chave: ~12 bytes por quadro) fica na memória. Ao parar, o `moov`
//! é escrito depois do `mdat` e o tamanho do `mdat` é corrigido. Enquanto não for finalizado o arquivo não toca:
//! quem chama grava num `.part` e só renomeia no fim (ver `recording::FileWriter`).
//!
//! O tempo vem do relógio do RTP do vídeo (24 kHz), então a duração de cada quadro é a diferença entre os horários
//! RTP, não um fps suposto. O aparelho manda menos quadros com a tela parada; o vídeo segura o quadro.

use std::io::{Seek, SeekFrom, Write};

use super::model::ParamSets;

/// O relógio do RTP do vídeo: a escala de tempo da trilha.
pub const TIMESCALE: u32 = 24_000;
/// Um quadro a 30 fps, em ticks: a duração de reserva quando o horário RTP não ajuda.
pub const NOMINAL_FRAME: u32 = 800;
/// Quantos quadros ficam num mesmo bloco (`chunk`) do arquivo.
const CHUNK_SAMPLES: u32 = 30;
/// Nenhum quadro dura mais que isto (o aparelho chega a ficar 11 s calado com a tela parada).
pub const MAX_FRAME_TICKS: u32 = TIMESCALE * 60;

// ── Parâmetros HEVC ─────────────────────────────────────────────────────────

/// O que interessa do SPS (ITU-T H.265, 7.3.2.2) para montar o `hvcC` e o tamanho da trilha.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpsInfo {
    pub profile_space: u8,
    pub tier: bool,
    pub profile_idc: u8,
    pub compat_flags: u32,
    /// `general_constraint_indicator_flags` (48 bits).
    pub constraint_flags: [u8; 6],
    pub level_idc: u8,
    pub chroma_format_idc: u8,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub max_sub_layers: u8,
    pub temporal_id_nesting: bool,
    /// O tamanho codificado (`pic_width_in_luma_samples` × `pic_height_in_luma_samples`).
    pub coded: (u32, u32),
    /// O tamanho depois da janela de conformidade (o que um decodificador mostra).
    pub visible: (u32, u32),
}

/// Tira os bytes de prevenção de emulação (`00 00 03` → `00 00`) do corpo da NAL.
fn unescape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len());
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Result<u32, String> {
        let byte = *self.data.get(self.pos / 8).ok_or("SPS curto demais")?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Ok(u32::from(bit))
    }

    fn bits(&mut self, n: u32) -> Result<u64, String> {
        let mut v = 0u64;
        for _ in 0..n {
            v = (v << 1) | u64::from(self.bit()?);
        }
        Ok(v)
    }

    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.pos += n;
        if self.pos > self.data.len() * 8 {
            return Err("SPS curto demais".into());
        }
        Ok(())
    }

    /// Exp-Golomb sem sinal, `ue(v)`.
    fn ue(&mut self) -> Result<u32, String> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err("SPS inválido".into());
            }
        }
        let rest = self.bits(zeros)?;
        Ok(((1u64 << zeros) - 1 + rest) as u32)
    }
}

/// Lê o SPS (a NAL inteira, com o cabeçalho de 2 bytes).
pub fn parse_sps(nal: &[u8]) -> Result<SpsInfo, String> {
    if nal.len() < 3 || (nal[0] >> 1) & 0x3f != 33 {
        return Err("O SPS do vídeo não é uma NAL de SPS".into());
    }
    let rbsp = unescape(&nal[2..]);
    let mut r = Bits { data: &rbsp, pos: 0 };
    r.skip(4)?; // sps_video_parameter_set_id
    let max_sub_layers = r.bits(3)? as u8 + 1;
    let temporal_id_nesting = r.bit()? == 1;
    // profile_tier_level(1, max_sub_layers_minus1)
    let profile_space = r.bits(2)? as u8;
    let tier = r.bit()? == 1;
    let profile_idc = r.bits(5)? as u8;
    let compat_flags = r.bits(32)? as u32;
    let constraints = r.bits(48)?;
    let mut constraint_flags = [0u8; 6];
    for (i, byte) in constraint_flags.iter_mut().enumerate() {
        *byte = (constraints >> (40 - 8 * i)) as u8;
    }
    let level_idc = r.bits(8)? as u8;
    let sub = usize::from(max_sub_layers) - 1;
    let mut profile_present = [false; 8];
    let mut level_present = [false; 8];
    for i in 0..sub {
        profile_present[i] = r.bit()? == 1;
        level_present[i] = r.bit()? == 1;
    }
    if sub > 0 {
        r.skip(2 * (8 - sub))?;
    }
    for i in 0..sub {
        if profile_present[i] {
            r.skip(88)?;
        }
        if level_present[i] {
            r.skip(8)?;
        }
    }
    r.ue()?; // sps_seq_parameter_set_id
    let chroma_format_idc = r.ue()?;
    if chroma_format_idc > 3 {
        return Err("SPS com formato de cor desconhecido".into());
    }
    if chroma_format_idc == 3 {
        r.bit()?; // separate_colour_plane_flag
    }
    let (width, height) = (r.ue()?, r.ue()?);
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("SPS com tamanho de imagem inválido".into());
    }
    let mut visible = (width, height);
    if r.bit()? == 1 {
        let (left, right, top, bottom) = (r.ue()?, r.ue()?, r.ue()?, r.ue()?);
        let (sub_w, sub_h) = match chroma_format_idc {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        let cut_w = (left + right).saturating_mul(sub_w);
        let cut_h = (top + bottom).saturating_mul(sub_h);
        if cut_w < width && cut_h < height {
            visible = (width - cut_w, height - cut_h);
        }
    }
    let bit_depth_luma_minus8 = r.ue()?;
    let bit_depth_chroma_minus8 = r.ue()?;
    if bit_depth_luma_minus8 > 8 || bit_depth_chroma_minus8 > 8 {
        return Err("SPS com profundidade de cor inválida".into());
    }
    Ok(SpsInfo {
        profile_space,
        tier,
        profile_idc,
        compat_flags,
        constraint_flags,
        level_idc,
        chroma_format_idc: chroma_format_idc as u8,
        bit_depth_luma_minus8: bit_depth_luma_minus8 as u8,
        bit_depth_chroma_minus8: bit_depth_chroma_minus8 as u8,
        max_sub_layers,
        temporal_id_nesting,
        coded: (width, height),
        visible,
    })
}

// ── Caixas ──────────────────────────────────────────────────────────────────

/// Escreve uma caixa: `[tamanho u32]['tipo'][corpo]`.
fn boxed(kind: &[u8; 4], body: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 0];
    out.extend_from_slice(kind);
    body(&mut out);
    let len = out.len() as u32;
    out[..4].copy_from_slice(&len.to_be_bytes());
    out
}

fn u16be(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn u32be(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn u64be(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// `FullBox`: versão 0 e as flags.
fn full(out: &mut Vec<u8>, flags: u32) {
    u32be(out, flags & 0x00ff_ffff);
}

fn hvcc(sps: &SpsInfo, params: &ParamSets) -> Vec<u8> {
    boxed(b"hvcC", |b| {
        b.push(1);
        b.push((sps.profile_space << 6) | (u8::from(sps.tier) << 5) | (sps.profile_idc & 0x1f));
        u32be(b, sps.compat_flags);
        b.extend_from_slice(&sps.constraint_flags);
        b.push(sps.level_idc);
        u16be(b, 0xF000); // min_spatial_segmentation_idc = 0 (desconhecido)
        b.push(0xFC); // parallelismType = 0
        b.push(0xFC | (sps.chroma_format_idc & 3));
        b.push(0xF8 | (sps.bit_depth_luma_minus8 & 7));
        b.push(0xF8 | (sps.bit_depth_chroma_minus8 & 7));
        u16be(b, 0); // avgFrameRate: desconhecido
        // constantFrameRate = 0, numTemporalLayers, temporalIdNested, lengthSizeMinusOne = 3
        b.push(((sps.max_sub_layers & 7) << 3) | (u8::from(sps.temporal_id_nesting) << 2) | 3);
        b.push(3);
        for (kind, nal) in [(32u8, &params.vps), (33, &params.sps), (34, &params.pps)] {
            b.push(0x80 | kind); // array_completeness = 1
            u16be(b, 1);
            u16be(b, nal.len() as u16);
            b.extend_from_slice(nal);
        }
    })
}

/// A entrada de amostras `hvc1`. `visible` é o que o decodificador mostra; `display` (menor ou igual) é a tela do
/// aparelho sem as bordas de alinhamento, que vira a abertura limpa (`clap`) ancorada no canto superior esquerdo.
fn hvc1(sps: &SpsInfo, params: &ParamSets, display: (u32, u32)) -> Vec<u8> {
    boxed(b"hvc1", |b| {
        b.extend_from_slice(&[0; 6]);
        u16be(b, 1); // data_reference_index
        b.extend_from_slice(&[0; 16]);
        u16be(b, sps.visible.0 as u16);
        u16be(b, sps.visible.1 as u16);
        u32be(b, 0x0048_0000); // 72 dpi
        u32be(b, 0x0048_0000);
        u32be(b, 0);
        u16be(b, 1); // frame_count
        let mut name = [0u8; 32];
        name[0] = 4;
        name[1..5].copy_from_slice(b"HEVC");
        b.extend_from_slice(&name);
        u16be(b, 0x18); // depth
        u16be(b, 0xFFFF); // pre_defined = -1
        b.extend_from_slice(&hvcc(sps, params));
        if display != sps.visible {
            // O centro da abertura, em relação ao centro da imagem, é negativo: a abertura fica no canto superior esquerdo.
            let off_h = i64::from(display.0) - i64::from(sps.visible.0);
            let off_v = i64::from(display.1) - i64::from(sps.visible.1);
            b.extend_from_slice(&boxed(b"clap", |c| {
                u32be(c, display.0);
                u32be(c, 1);
                u32be(c, display.1);
                u32be(c, 1);
                u32be(c, off_h as i32 as u32);
                u32be(c, 2);
                u32be(c, off_v as i32 as u32);
                u32be(c, 2);
            }));
        }
        b.extend_from_slice(&boxed(b"pasp", |c| {
            u32be(c, 1);
            u32be(c, 1);
        }));
    })
}

// ── O escritor ──────────────────────────────────────────────────────────────

/// Um quadro para gravar.
pub struct Sample<'a> {
    /// Horário RTP (24 kHz).
    pub ts: u32,
    /// Quadro-chave: dá para começar a tocar dele.
    pub sync: bool,
    /// As NALs com o tamanho de 4 bytes na frente (`AccessUnit::avcc`).
    pub data: &'a [u8],
    pub params: &'a ParamSets,
    /// A tela do aparelho em pixels, sem as bordas de alinhamento. `None`: o tamanho do SPS.
    pub display: Option<(u32, u32)>,
    /// Duração do quadro anterior, quando o horário RTP não vale (nova conexão = relógio novo do RTP).
    pub previous_duration: Option<u32>,
}

struct Entry {
    params: ParamSets,
    display: (u32, u32),
    sample_entry: Vec<u8>,
}

struct Chunk {
    offset: u64,
    entry: u32,
    count: u32,
}

/// O que ficou gravado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub frames: u64,
    pub duration_ticks: u64,
    /// O tamanho da primeira entrada (o da trilha), em pixels.
    pub display: (u32, u32),
    pub bytes: u64,
}

pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    /// Onde começa o cabeçalho do `mdat`.
    mdat_at: u64,
    /// Próxima posição de escrita.
    pos: u64,
    entries: Vec<Entry>,
    chunks: Vec<Chunk>,
    sizes: Vec<u32>,
    /// A duração de cada quadro; a do último só se sabe ao finalizar.
    durations: Vec<u32>,
    /// Números (a partir de 1) dos quadros-chave.
    sync: Vec<u32>,
    last_ts: u32,
}

impl<W: Write + Seek> Mp4Writer<W> {
    pub fn new(mut out: W) -> Result<Self, String> {
        let start = out.stream_position().map_err(io)?;
        let ftyp = boxed(b"ftyp", |b| {
            b.extend_from_slice(b"isom");
            u32be(b, 512);
            for brand in [b"isom", b"iso2", b"mp41"] {
                b.extend_from_slice(brand);
            }
        });
        out.write_all(&ftyp).map_err(io)?;
        let mdat_at = start + ftyp.len() as u64;
        // `mdat` com tamanho de 64 bits: o tamanho certo entra ao finalizar.
        let mut head = vec![0, 0, 0, 1];
        head.extend_from_slice(b"mdat");
        u64be(&mut head, 16);
        out.write_all(&head).map_err(io)?;
        Ok(Self {
            out,
            mdat_at,
            pos: mdat_at + 16,
            entries: Vec::new(),
            chunks: Vec::new(),
            sizes: Vec::new(),
            durations: Vec::new(),
            sync: Vec::new(),
            last_ts: 0,
        })
    }

    fn entry_for(&mut self, params: &ParamSets, display: Option<(u32, u32)>) -> Result<u32, String> {
        let wanted = |entry: &Entry| entry.params == *params && display.is_none_or(|d| d == entry.display);
        if let Some(i) = self.entries.iter().rposition(wanted) {
            return Ok(i as u32 + 1);
        }
        let sps = parse_sps(&params.sps)?;
        // A tela só vale se couber na imagem; senão, o tamanho que o decodificador mostra.
        let display = display
            .filter(|d| d.0 > 0 && d.1 > 0 && d.0 <= sps.visible.0 && d.1 <= sps.visible.1)
            .unwrap_or(sps.visible);
        let sample_entry = hvc1(&sps, params, display);
        self.entries.push(Entry { params: params.clone(), display, sample_entry });
        Ok(self.entries.len() as u32)
    }

    pub fn push(&mut self, s: Sample<'_>) -> Result<(), String> {
        if self.sizes.is_empty() && !s.sync {
            return Err("O primeiro quadro da gravação precisa ser um quadro-chave.".into());
        }
        if s.data.is_empty() || s.data.len() > u32::MAX as usize {
            return Err("Quadro de vídeo vazio ou grande demais.".into());
        }
        let entry = self.entry_for(s.params, s.display)?;
        let last_ts = self.last_ts;
        if let Some(previous) = self.durations.last_mut() {
            let ticks = s.previous_duration.unwrap_or_else(|| {
                let delta = s.ts.wrapping_sub(last_ts) as i32;
                if delta > 0 { delta as u32 } else { NOMINAL_FRAME }
            });
            *previous = ticks.clamp(1, MAX_FRAME_TICKS);
        }
        self.out.write_all(s.data).map_err(io)?;
        match self.chunks.last_mut() {
            Some(chunk) if chunk.entry == entry && chunk.count < CHUNK_SAMPLES => chunk.count += 1,
            _ => self.chunks.push(Chunk { offset: self.pos, entry, count: 1 }),
        }
        self.pos += s.data.len() as u64;
        self.sizes.push(s.data.len() as u32);
        self.durations.push(NOMINAL_FRAME);
        if s.sync {
            self.sync.push(self.sizes.len() as u32);
        }
        self.last_ts = s.ts;
        Ok(())
    }

    /// Escreve o `moov`, acerta o `mdat` e devolve o destino. `last_duration` é quanto o último quadro ficou na tela.
    pub fn finish(mut self, last_duration: u32) -> Result<(Summary, W), String> {
        let Some(last) = self.durations.last_mut() else {
            return Err("Nenhum quadro de vídeo foi gravado.".into());
        };
        *last = last_duration.clamp(1, MAX_FRAME_TICKS);
        let duration: u64 = self.durations.iter().map(|&d| u64::from(d)).sum();
        let display = self.entries[0].display;
        let moov = self.moov(duration, display);
        self.out.write_all(&moov).map_err(io)?;
        let end = self.out.stream_position().map_err(io)?;
        self.out.seek(SeekFrom::Start(self.mdat_at + 8)).map_err(io)?;
        self.out.write_all(&(self.pos - self.mdat_at).to_be_bytes()).map_err(io)?;
        self.out.seek(SeekFrom::Start(end)).map_err(io)?;
        self.out.flush().map_err(io)?;
        Ok((Summary { frames: self.sizes.len() as u64, duration_ticks: duration, display, bytes: end }, self.out))
    }

    fn moov(&self, duration: u64, display: (u32, u32)) -> Vec<u8> {
        let movie_duration = (duration * 1000 / u64::from(TIMESCALE)) as u32;
        let now = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) + 2_082_844_800) as u32;
        const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
        let mvhd = boxed(b"mvhd", |b| {
            full(b, 0);
            u32be(b, now);
            u32be(b, now);
            u32be(b, 1000);
            u32be(b, movie_duration);
            u32be(b, 0x0001_0000); // taxa 1.0
            u16be(b, 0x0100); // volume
            b.extend_from_slice(&[0; 10]);
            MATRIX.iter().for_each(|&m| u32be(b, m));
            b.extend_from_slice(&[0; 24]);
            u32be(b, 2); // próximo id de trilha
        });
        let tkhd = boxed(b"tkhd", |b| {
            full(b, 0x0003); // habilitada e no filme
            u32be(b, now);
            u32be(b, now);
            u32be(b, 1);
            u32be(b, 0);
            u32be(b, movie_duration);
            b.extend_from_slice(&[0; 8]);
            u16be(b, 0);
            u16be(b, 0);
            u16be(b, 0);
            u16be(b, 0);
            MATRIX.iter().for_each(|&m| u32be(b, m));
            u32be(b, display.0 << 16);
            u32be(b, display.1 << 16);
        });
        let mdhd = boxed(b"mdhd", |b| {
            full(b, 0);
            u32be(b, now);
            u32be(b, now);
            u32be(b, TIMESCALE);
            u32be(b, duration.min(u64::from(u32::MAX)) as u32);
            u16be(b, 0x55C4); // "und"
            u16be(b, 0);
        });
        let hdlr = boxed(b"hdlr", |b| {
            full(b, 0);
            u32be(b, 0);
            b.extend_from_slice(b"vide");
            b.extend_from_slice(&[0; 12]);
            b.extend_from_slice(b"VideoHandler\0");
        });
        let vmhd = boxed(b"vmhd", |b| {
            full(b, 1);
            b.extend_from_slice(&[0; 8]);
        });
        let dinf = boxed(b"dinf", |b| {
            b.extend_from_slice(&boxed(b"dref", |d| {
                full(d, 0);
                u32be(d, 1);
                d.extend_from_slice(&boxed(b"url ", |u| full(u, 1)));
            }));
        });
        let stbl = self.stbl();
        let minf = boxed(b"minf", |b| {
            b.extend_from_slice(&vmhd);
            b.extend_from_slice(&dinf);
            b.extend_from_slice(&stbl);
        });
        let mdia = boxed(b"mdia", |b| {
            b.extend_from_slice(&mdhd);
            b.extend_from_slice(&hdlr);
            b.extend_from_slice(&minf);
        });
        let trak = boxed(b"trak", |b| {
            b.extend_from_slice(&tkhd);
            b.extend_from_slice(&mdia);
        });
        boxed(b"moov", |b| {
            b.extend_from_slice(&mvhd);
            b.extend_from_slice(&trak);
        })
    }

    fn stbl(&self) -> Vec<u8> {
        let stsd = boxed(b"stsd", |b| {
            full(b, 0);
            u32be(b, self.entries.len() as u32);
            for entry in &self.entries {
                b.extend_from_slice(&entry.sample_entry);
            }
        });
        // Durações iguais seguidas viram uma entrada só.
        let mut runs: Vec<(u32, u32)> = Vec::new();
        for &d in &self.durations {
            match runs.last_mut() {
                Some((count, delta)) if *delta == d => *count += 1,
                _ => runs.push((1, d)),
            }
        }
        let stts = boxed(b"stts", |b| {
            full(b, 0);
            u32be(b, runs.len() as u32);
            for (count, delta) in &runs {
                u32be(b, *count);
                u32be(b, *delta);
            }
        });
        let stss = boxed(b"stss", |b| {
            full(b, 0);
            u32be(b, self.sync.len() as u32);
            self.sync.iter().for_each(|&n| u32be(b, n));
        });
        // Blocos seguidos com a mesma quantidade de amostras e a mesma entrada viram uma linha só.
        let mut stsc_rows: Vec<(u32, u32, u32)> = Vec::new();
        for (i, chunk) in self.chunks.iter().enumerate() {
            if stsc_rows.last().is_none_or(|&(_, count, entry)| (count, entry) != (chunk.count, chunk.entry)) {
                stsc_rows.push((i as u32 + 1, chunk.count, chunk.entry));
            }
        }
        let stsc = boxed(b"stsc", |b| {
            full(b, 0);
            u32be(b, stsc_rows.len() as u32);
            for (first, count, entry) in &stsc_rows {
                u32be(b, *first);
                u32be(b, *count);
                u32be(b, *entry);
            }
        });
        let stsz = boxed(b"stsz", |b| {
            full(b, 0);
            u32be(b, 0);
            u32be(b, self.sizes.len() as u32);
            self.sizes.iter().for_each(|&s| u32be(b, s));
        });
        let wide = self.chunks.last().is_some_and(|c| c.offset > u64::from(u32::MAX));
        let offsets = if wide {
            boxed(b"co64", |b| {
                full(b, 0);
                u32be(b, self.chunks.len() as u32);
                self.chunks.iter().for_each(|c| u64be(b, c.offset));
            })
        } else {
            boxed(b"stco", |b| {
                full(b, 0);
                u32be(b, self.chunks.len() as u32);
                self.chunks.iter().for_each(|c| u32be(b, c.offset as u32));
            })
        };
        boxed(b"stbl", |b| {
            for part in [&stsd, &stts, &stss, &stsc, &stsz, &offsets] {
                b.extend_from_slice(part);
            }
        })
    }
}

fn io(e: std::io::Error) -> String {
    format!("Não consegui escrever o vídeo no disco: {e}")
}
