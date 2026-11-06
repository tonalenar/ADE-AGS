//! A parte pura do espelhamento de iPhone e iPad físicos: a lista do `devicectl`, os quadros que o helper manda,
//! o RTP do vídeo (HEVC, RFC 7798), o recorte da tela e o estado da conexão. Sem CoreDevice, para testar em
//! qualquer sistema.
// Fora do macOS só a lista e o id físico são usados (a sessão é do macOS); o resto existe para os testes.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::io::{self, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// O id de um aparelho físico onde a interface guarda a escolha (o nó do canvas e o painel do chat usam o campo
/// `udid` dos simuladores): `device:<identificador do CoreDevice>`. O identificador não é o UDID.
pub const PHYSICAL_PREFIX: &str = "device:";

pub fn is_physical(id: &str) -> bool {
    id.starts_with(PHYSICAL_PREFIX)
}

/// `device:<id>` → `<id>`, se for um identificador do CoreDevice (um UUID).
pub fn physical_identifier(id: &str) -> Option<&str> {
    let rest = id.strip_prefix(PHYSICAL_PREFIX)?;
    let ok = rest.len() == 36 && rest.chars().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
    ok.then_some(rest)
}

/// Traduz erros comuns do CoreDevice para o próximo passo prático, sem esconder mensagens desconhecidas.
pub fn device_error_help(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("developer mode") || lower.contains("developermode") || lower.contains("modo de desenvolvedor") {
        return "Ative o Modo de Desenvolvedor em Ajustes → Privacidade e Segurança no iPhone e reinicie o aparelho.".into();
    }
    if lower.contains("locked") || lower.contains("lock state") || lower.contains("passcode") || lower.contains("bloqueado") {
        return "Desbloqueie o iPhone e tente de novo; o CoreDevice não consegue capturar ou controlar a tela bloqueada.".into();
    }
    if lower.contains("pair") || lower.contains("trust") || lower.contains("unpaired") || lower.contains("confiar neste computador") {
        return "Desbloqueie o iPhone, confirme “Confiar neste computador” e tente de novo.".into();
    }
    if lower.contains("tunnel") || lower.contains("túnel") || lower.contains("connection") || lower.contains("conect") {
        return "A conexão do CoreDevice caiu. A ADE está aguardando a reconexão; deixe o iPhone desbloqueado e reconecte o USB ou aguarde o Wi‑Fi voltar.".into();
    }
    if lower.contains("xcode")
        || lower.contains("developer directory")
        || lower.contains("active developer path")
        || lower.contains("unable to find utility")
        || lower.contains("xcrun: error")
    {
        return "Instale ou selecione o Xcode 27 neste Mac e tente de novo.".into();
    }
    if lower.contains("helper") || lower.contains("iphone-mirror") {
        return "O helper do espelhamento não está disponível. Reinstale ou recompile a ADE com `bun run build:iphone-mirror`.".into();
    }
    if raw.trim().is_empty() { "O CoreDevice não informou o motivo.".into() } else { raw.trim().to_string() }
}

/// Como o aparelho fala com o Mac agora.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    Usb,
    Wifi,
    /// Conhecido, mas sem caminho agora.
    None,
}

impl Transport {
    pub fn parse(raw: &str) -> Transport {
        match raw.to_ascii_lowercase().as_str() {
            "wired" | "usb" => Transport::Usb,
            "localnetwork" | "local network" | "network" | "wifi" => Transport::Wifi,
            _ => Transport::None,
        }
    }
}

/// Um iPhone ou iPad de verdade que o CoreDevice conhece.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalDevice {
    /// `device:<identificador do CoreDevice>`, usado internamente para abrir o helper.
    pub id: String,
    /// UDID público estável, quando o `devicectl` o informa.
    pub udid: Option<String>,
    pub name: String,
    /// Nome amigável, quando o CoreDevice informa; senão, o `productType` (por exemplo, `iPhone16,2`).
    pub model: String,
    /// `27.2`.
    pub os: String,
    /// `iphone` ou `ipad`.
    pub family: String,
    pub transport: Transport,
    /// O Mac e o aparelho se confiam (a pessoa tocou em "Confiar").
    pub paired: bool,
    /// `Some(false)`: o Modo de Desenvolvedor está desligado; `None`: o aparelho não disse.
    pub developer_mode: Option<bool>,
    /// O túnel do CoreDevice está de pé.
    pub tunnel: bool,
    #[serde(skip)]
    pub tunnel_ip: Option<String>,
}

impl PhysicalDevice {
    /// Dá para tentar espelhar: tem caminho, confia no Mac e não está com o Modo de Desenvolvedor desligado.
    pub fn ready(&self) -> bool {
        self.transport != Transport::None && self.paired && self.developer_mode != Some(false)
    }
}

/// A lista de `xcrun devicectl list devices --json-output`: só iPhones e iPads físicos (os simuladores vêm pela
/// lista do Xcode). Os prontos primeiro, depois por nome.
pub fn parse_devicectl(json: &str) -> Result<Vec<PhysicalDevice>, String> {
    let root: Value = serde_json::from_str(json).map_err(|e| format!("devicectl devolveu algo que não é JSON: {e}"))?;
    let list = root.pointer("/result/devices").and_then(Value::as_array).ok_or("devicectl não devolveu a lista de aparelhos.")?;
    let text = |v: &Value, path: &str| v.pointer(path).and_then(Value::as_str).unwrap_or("").to_string();
    let mut out: Vec<PhysicalDevice> = list
        .iter()
        .filter_map(|d| {
            let transport = Transport::parse(&text(d, "/connectionProperties/transportType"));
            let reality = text(d, "/hardwareProperties/reality");
            // Xcode 27.2 omite `reality` de alguns aparelhos físicos no JSON (incluindo iPhones USB pareados).
            // `sameMachine` identifica os simuladores; um transporte USB/rede sem `reality` é físico.
            let physical = reality == "physical" || (reality.is_empty() && transport != Transport::None);
            if !physical || text(d, "/hardwareProperties/platform") != "iOS" {
                return None;
            }
            let family = match text(d, "/hardwareProperties/deviceType").as_str() {
                "iPhone" => "iphone",
                "iPad" => "ipad",
                _ => return None,
            };
            let identifier = text(d, "/identifier");
            if identifier.is_empty() {
                return None;
            }
            let udid = text(d, "/hardwareProperties/udid");
            let marketing_name = text(d, "/hardwareProperties/marketingName");
            let model = if marketing_name.is_empty() {
                let product_type = text(d, "/hardwareProperties/productType");
                if product_type.is_empty() { text(d, "/hardwareProperties/deviceType") } else { product_type }
            } else {
                marketing_name
            };
            let name = text(d, "/deviceProperties/name");
            let developer_mode = match text(d, "/deviceProperties/developerModeStatus").as_str() {
                "enabled" => Some(true),
                "disabled" => Some(false),
                _ => None,
            };
            let tunnel_ip = Some(text(d, "/connectionProperties/tunnelIPAddress")).filter(|s| !s.is_empty());
            Some(PhysicalDevice {
                id: format!("{PHYSICAL_PREFIX}{identifier}"),
                udid: (!udid.is_empty()).then_some(udid),
                name: if name.is_empty() { model.clone() } else { name },
                model,
                os: text(d, "/deviceProperties/osVersionNumber"),
                family: family.into(),
                transport,
                paired: text(d, "/connectionProperties/pairingState") == "paired",
                developer_mode,
                tunnel: text(d, "/connectionProperties/tunnelState") == "connected",
                tunnel_ip,
            })
        })
        .collect();
    out.sort_by(|a, b| b.ready().cmp(&a.ready()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

// ── Os quadros do helper ──

/// O que o helper manda pelo stdout: `[tipo u8][tamanho u32 big-endian][conteúdo]`.
#[derive(Debug, PartialEq)]
pub enum HelperMsg {
    Event(HelperEvent),
    /// Um datagrama recebido do aparelho (RTP ou RTCP), como chegou.
    Datagram(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum HelperEvent {
    Connecting,
    /// O aparelho abriu o espelhamento. `display` = a tela em pixels.
    Started { transport: Transport, display: Option<(u32, u32)> },
    Error { code: String, message: String },
    Stopped,
    /// O HID do aparelho ficou pronto (o que deu para abrir).
    InputReady { touch: bool, buttons: bool, keyboard: bool },
    /// Uma entrada não chegou ao aparelho.
    InputError(String),
    Other(String),
}

/// Maior quadro aceito: um datagrama UDP cabe em 64 KB; um evento, em bem menos.
const MAX_FRAME: usize = 1 << 20;

/// Lê o próximo quadro. `Ok(None)` = o helper fechou o stdout.
pub fn read_msg(r: &mut impl Read) -> io::Result<Option<HelperMsg>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("quadro grande demais do helper: {len} bytes")));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    match head[0] {
        1 => Ok(Some(HelperMsg::Event(parse_event(&body)))),
        2 => Ok(Some(HelperMsg::Datagram(body))),
        other => Err(io::Error::new(io::ErrorKind::InvalidData, format!("tipo de quadro desconhecido do helper: {other}"))),
    }
}

pub fn parse_event(body: &[u8]) -> HelperEvent {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return HelperEvent::Other(String::from_utf8_lossy(body).into_owned());
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match s("event").as_str() {
        "connecting" => HelperEvent::Connecting,
        "started" => {
            let dim = |k: &str| v.pointer(&format!("/display/{k}")).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0);
            HelperEvent::Started { transport: Transport::parse(&s("transport")), display: dim("w").zip(dim("h")) }
        }
        "error" => HelperEvent::Error { code: s("code"), message: s("message") },
        "stopped" => HelperEvent::Stopped,
        "inputReady" => {
            let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
            HelperEvent::InputReady { touch: flag("touch"), buttons: flag("buttons"), keyboard: flag("keyboard") }
        }
        "inputError" => HelperEvent::InputError(s("message")),
        other => HelperEvent::Other(other.to_string()),
    }
}

// ── RTP do vídeo: HEVC (RFC 7798) ──

/// Os tipos de NAL do HEVC que importam aqui.
pub mod nal {
    pub const VPS: u8 = 32;
    pub const SPS: u8 = 33;
    pub const PPS: u8 = 34;
    /// Agregação (vários NALs num pacote) e fragmento (um NAL em vários pacotes).
    pub const AP: u8 = 48;
    pub const FU: u8 = 49;
    /// Informação de conteúdo do payload: embrulha um NAL, um AP ou um FU.
    pub const PACI: u8 = 50;

    pub fn kind(nal: &[u8]) -> u8 {
        nal.first().map(|b| (b >> 1) & 0x3f).unwrap_or(0xff)
    }

    /// Imagem de acesso aleatório (IDR, CRA, BLA): dá para começar a decodificar dela.
    pub fn is_irap(kind: u8) -> bool {
        (16..=21).contains(&kind)
    }

    pub fn is_vcl(kind: u8) -> bool {
        kind <= 31
    }
}

/// Os conjuntos de parâmetros que descrevem o vídeo (o decodificador nasce deles).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParamSets {
    pub vps: Vec<u8>,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
}

/// Um quadro completo: as NALs de imagem (sem os conjuntos de parâmetros) e o horário RTP.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessUnit {
    pub ts: u32,
    pub nals: Vec<Vec<u8>>,
    pub irap: bool,
    /// Os conjuntos de parâmetros em vigor, quando este quadro trouxe algum novo.
    pub params: Option<ParamSets>,
}

impl AccessUnit {
    /// As NALs com o tamanho de 4 bytes na frente (o formato que o VideoToolbox lê).
    pub fn avcc(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.nals.iter().map(|n| n.len() + 4).sum());
        for n in &self.nals {
            out.extend_from_slice(&(n.len() as u32).to_be_bytes());
            out.extend_from_slice(n);
        }
        out
    }
}

/// O que um pacote produziu.
#[derive(Debug, Default, PartialEq)]
pub struct Pushed {
    /// Faltou pacote antes deste (o quadro em curso foi descartado).
    pub gap: bool,
    pub unit: Option<AccessUnit>,
}

/// Junta os pacotes RTP do vídeo em quadros. Prende-se ao primeiro SSRC de vídeo que vê; ignora RTCP.
#[derive(Debug, Default)]
pub struct Depacketizer {
    ssrc: Option<u32>,
    last_seq: Option<u16>,
    ts: Option<u32>,
    nals: Vec<Vec<u8>>,
    fu: Option<Vec<u8>>,
    /// O quadro em curso perdeu um pedaço: não sai.
    damaged: bool,
    params: ParamSets,
    params_new: bool,
    /// Quadros descartados por estarem incompletos (para o diagnóstico).
    pub dropped: u64,
    kinds: std::collections::BTreeMap<u8, u64>,
}

/// RTP e RTCP na mesma porta (RFC 5761): o RTCP tem o 2º byte entre 192 e 223.
pub fn is_rtcp(pkt: &[u8]) -> bool {
    pkt.len() >= 8 && pkt[0] >> 6 == 2 && (192..=223).contains(&pkt[1])
}

impl Depacketizer {
    pub fn push(&mut self, pkt: &[u8]) -> Pushed {
        let mut out = Pushed::default();
        if pkt.len() < 12 || pkt[0] >> 6 != 2 || is_rtcp(pkt) {
            return out;
        }
        let padding = pkt[0] & 0x20 != 0;
        let extension = pkt[0] & 0x10 != 0;
        let csrcs = usize::from(pkt[0] & 0x0f);
        let marker = pkt[1] & 0x80 != 0;
        let seq = u16::from_be_bytes([pkt[2], pkt[3]]);
        let ts = u32::from_be_bytes([pkt[4], pkt[5], pkt[6], pkt[7]]);
        let ssrc = u32::from_be_bytes([pkt[8], pkt[9], pkt[10], pkt[11]]);
        if *self.ssrc.get_or_insert(ssrc) != ssrc {
            return out;
        }
        let mut start = 12 + 4 * csrcs;
        if extension {
            if start + 4 > pkt.len() {
                return out;
            }
            start += 4 + 4 * usize::from(u16::from_be_bytes([pkt[start + 2], pkt[start + 3]]));
        }
        let mut end = pkt.len();
        if padding {
            end = end.saturating_sub(usize::from(pkt[pkt.len() - 1]));
        }
        if start + 2 > end {
            return out;
        }

        if let Some(last) = self.last_seq {
            let ahead = seq.wrapping_sub(last);
            if ahead == 0 || ahead >= 0x8000 {
                // Repetido ou atrasado: o quadro dele já foi.
                return out;
            }
            if ahead != 1 {
                out.gap = true;
                self.damaged = true;
                self.fu = None;
            }
        }
        self.last_seq = Some(seq);
        if self.ts != Some(ts) {
            // Quadro novo sem o marcador do anterior: o anterior ficou incompleto.
            if !self.nals.is_empty() || self.fu.is_some() {
                self.dropped += 1;
            }
            self.start_unit(ts);
            // Os pacotes perdidos podem ser o começo deste quadro: na dúvida, ele não sai.
            self.damaged = out.gap;
        }

        self.payload(&pkt[start..end]);

        if marker {
            out.unit = self.finish(ts);
        }
        out
    }

    /// Quantos pacotes de cada tipo de payload chegaram (48 = AP, 49 = FU, 50 = PACI; o resto, NAL simples): para o
    /// diagnóstico.
    pub fn packet_kinds(&self) -> &std::collections::BTreeMap<u8, u64> {
        &self.kinds
    }

    /// O conteúdo de um pacote RTP: NAL simples, agregação (AP), fragmento (FU) ou PACI, que embrulha um dos três.
    fn payload(&mut self, payload: &[u8]) {
        let kind = nal::kind(payload);
        *self.kinds.entry(kind).or_insert(0) += 1;
        match kind {
            nal::PACI => {
                // RFC 7798 §4.4.4: depois do PayloadHdr, A(1) cType(6) PHSsize(5) F0-2(3) Y(1) e PHSsize bytes de PHES.
                // O pacote de dentro reaproveita o PayloadHdr com o tipo trocado por cType e o F pelo A.
                if payload.len() < 4 {
                    self.damaged = true;
                    return;
                }
                let a = payload[2] >> 7;
                let ctype = (payload[2] >> 1) & 0x3f;
                let phs = usize::from(((payload[2] & 1) << 4) | (payload[3] >> 4));
                let start = 4 + phs;
                if start > payload.len() || ctype == nal::PACI {
                    self.damaged = true;
                    return;
                }
                let mut inner = Vec::with_capacity(2 + payload.len() - start);
                inner.push((a << 7) | (ctype << 1) | (payload[0] & 1));
                inner.push(payload[1]);
                inner.extend_from_slice(&payload[start..]);
                // Conta só o de dentro (o PACI já entrou na contagem acima).
                self.payload_inner(&inner);
            }
            _ => self.payload_inner(payload),
        }
    }

    fn payload_inner(&mut self, payload: &[u8]) {
        match nal::kind(payload) {
            nal::AP => {
                let mut i = 2;
                while i + 2 <= payload.len() {
                    let size = usize::from(u16::from_be_bytes([payload[i], payload[i + 1]]));
                    i += 2;
                    if size == 0 || i + size > payload.len() {
                        self.damaged = true;
                        break;
                    }
                    self.add(payload[i..i + size].to_vec());
                    i += size;
                }
            }
            nal::FU => {
                if payload.len() < 3 {
                    self.damaged = true;
                } else {
                    let header = payload[2];
                    let (first, last, kind) = (header & 0x80 != 0, header & 0x40 != 0, header & 0x3f);
                    if first {
                        // O cabeçalho do NAL original: F e LayerId do cabeçalho do FU, com o tipo de dentro.
                        self.fu = Some(vec![(payload[0] & 0x81) | (kind << 1), payload[1]]);
                    }
                    match self.fu.as_mut() {
                        Some(fu) => fu.extend_from_slice(&payload[3..]),
                        None => self.damaged = true,
                    }
                    if last {
                        if let Some(done) = self.fu.take() {
                            self.add(done);
                        }
                    }
                }
            }
            // 51 a 63: tipos sem definição no RTP do HEVC. Um quadro com eles fica incompleto, e isso tem de aparecer.
            k if k > nal::PACI => self.damaged = true,
            _ => self.add(payload.to_vec()),
        }
    }

    fn start_unit(&mut self, ts: u32) {
        self.ts = Some(ts);
        self.nals.clear();
        self.fu = None;
        self.damaged = false;
    }

    fn add(&mut self, unit: Vec<u8>) {
        match nal::kind(&unit) {
            nal::VPS => self.set_param(0, unit),
            nal::SPS => self.set_param(1, unit),
            nal::PPS => self.set_param(2, unit),
            k if nal::is_vcl(k) => self.nals.push(unit),
            _ => {} // SEI e afins: o decodificador não precisa
        }
    }

    fn set_param(&mut self, which: usize, unit: Vec<u8>) {
        let slot = match which {
            0 => &mut self.params.vps,
            1 => &mut self.params.sps,
            _ => &mut self.params.pps,
        };
        if *slot != unit {
            *slot = unit;
            self.params_new = true;
        }
    }

    fn finish(&mut self, ts: u32) -> Option<AccessUnit> {
        let nals = std::mem::take(&mut self.nals);
        let damaged = std::mem::replace(&mut self.damaged, false) || self.fu.take().is_some();
        // O próximo pacote, mesmo com o mesmo horário, começa outro quadro.
        self.ts = None;
        if damaged || nals.is_empty() {
            self.dropped += u64::from(damaged);
            return None;
        }
        let complete = !self.params.vps.is_empty() && !self.params.sps.is_empty() && !self.params.pps.is_empty();
        let params = (self.params_new && complete).then(|| {
            self.params_new = false;
            self.params.clone()
        });
        let irap = nals.iter().any(|n| nal::is_irap(nal::kind(n)));
        Some(AccessUnit { ts, nals, irap, params })
    }
}

/// Depois de uma perda, os quadros seguintes dependem do que se perdeu: espera um quadro-chave (IRAP). Pede
/// um ao aparelho (PLI/FIR) a cada `RESEND`; sem resposta em `GIVE_UP`, a sessão é refeita (stream novo começa
/// com quadro-chave). Os tempos são em milissegundos de um relógio qualquer, para testar sem relógio de verdade.
#[derive(Debug, Default)]
pub struct KeyframeGate {
    /// Desde quando espera (`None` = decodificando normal). Começa esperando: o 1º quadro tem de ser IRAP.
    waiting_since: Option<u64>,
    last_ask: Option<u64>,
    started: bool,
}

pub const KEYFRAME_RESEND: Duration = Duration::from_millis(700);
pub const KEYFRAME_GIVE_UP: Duration = Duration::from_millis(2500);
/// Mesmo sem perda, um quadro-chave novo a cada tanto: limita qualquer deriva que a montagem não viu (observado uma
/// vez, com outra sessão do mesmo aparelho ainda fechando). Custa ~1 IDR por intervalo.
pub const KEYFRAME_REFRESH: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum GateAction {
    /// Mandar o quadro ao decodificador.
    Decode,
    /// Descartar (esperando o quadro-chave).
    Drop,
}

impl KeyframeGate {
    /// Um pacote chegou depois de uma perda.
    pub fn on_gap(&mut self, now_ms: u64) {
        if self.waiting_since.is_none() {
            self.waiting_since = Some(now_ms);
            self.last_ask = None;
        }
    }

    /// O decodificador foi (re)criado neste quadro: se ele não é IRAP, os seguintes não têm referência.
    pub fn on_new_decoder(&mut self, unit: &AccessUnit, now_ms: u64) {
        if !unit.irap {
            self.on_gap(now_ms);
        }
    }

    pub fn on_unit(&mut self, unit: &AccessUnit, now_ms: u64) -> GateAction {
        if !self.started {
            self.started = true;
            if !unit.irap {
                self.waiting_since = Some(now_ms);
            }
        }
        if self.waiting_since.is_some() && unit.irap {
            self.waiting_since = None;
            self.last_ask = None;
        }
        if self.waiting_since.is_some() { GateAction::Drop } else { GateAction::Decode }
    }

    /// Hora de pedir quadro-chave de novo? Chame a cada pacote; marca o pedido quando diz que sim.
    pub fn should_ask(&mut self, now_ms: u64) -> bool {
        if self.waiting_since.is_none() {
            return false;
        }
        let due = self.last_ask.is_none_or(|t| now_ms.saturating_sub(t) >= KEYFRAME_RESEND.as_millis() as u64);
        if due {
            self.last_ask = Some(now_ms);
        }
        due
    }

    /// Esperou demais: refazer a sessão.
    pub fn gave_up(&self, now_ms: u64) -> bool {
        self.waiting_since.is_some_and(|t| now_ms.saturating_sub(t) >= KEYFRAME_GIVE_UP.as_millis() as u64)
    }

    pub fn waiting(&self) -> bool {
        self.waiting_since.is_some()
    }
}

/// Impede que um quadro dependente de referências perdidas seja usado como foto de agente. O limite é o horário
/// monotônico do IDR que recuperou o vídeo; quadros anteriores continuam recusados mesmo se o VideoToolbox os
/// entregar atrasados. `u64::MAX` representa que ainda não há quadro seguro.
pub struct CaptureFence(AtomicU64);

impl Default for CaptureFence {
    fn default() -> Self {
        Self(AtomicU64::new(u64::MAX))
    }
}

impl CaptureFence {
    pub fn invalidate(&self) {
        self.0.store(u64::MAX, Ordering::Release);
    }

    pub fn on_keyframe(&self, arrived_ns: u64) {
        self.0.store(arrived_ns, Ordering::Release);
    }

    pub fn trusts(&self, frame_ns: u64) -> bool {
        let boundary = self.0.load(Ordering::Acquire);
        boundary != u64::MAX && frame_ns >= boundary
    }
}

// ── A tela: recorte e tamanho ──

/// O vídeo vem com bordas de alinhamento à direita e embaixo (medido: 1296×2816 para uma tela de 1290×2796). O
/// recorte da tela em unidades da camada (`contentsRect`), com a origem embaixo (a do Core Animation no macOS):
/// `(x, y, largura, altura)`. Sem o tamanho da tela, ou com um maior que o vídeo, mostra o vídeo inteiro.
pub fn contents_rect(coded: (u32, u32), display: Option<(u32, u32)>) -> (f64, f64, f64, f64) {
    let (cw, ch) = coded;
    match display {
        Some((dw, dh)) if cw > 0 && ch > 0 && dw > 0 && dh > 0 && dw <= cw && dh <= ch => {
            let (w, h) = (f64::from(dw) / f64::from(cw), f64::from(dh) / f64::from(ch));
            // A tela fica no alto do quadro; com a origem embaixo, o recorte começa em 1 − altura.
            (0.0, 1.0 - h, w, h)
        }
        _ => (0.0, 0.0, 1.0, 1.0),
    }
}

// ── A conexão: ligado, reconectando, sem conexão ──

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    /// Abrindo a primeira vez.
    Connecting,
    /// Quadros chegando.
    Live,
    /// Caiu (o túnel do CoreDevice cai às vezes no Wi-Fi): tentando de novo.
    Reconnecting,
    /// Várias tentativas sem sucesso, ou falta algo no Mac. Segue tentando, mais devagar.
    Offline,
    /// Ninguém olhando: o espelhamento parou para poupar o aparelho.
    Paused,
}

/// Depois de quantas tentativas seguidas sem sucesso a interface passa a dizer "sem conexão".
pub const OFFLINE_AFTER: u32 = 4;
/// Sem nenhum datagrama por este tempo com o espelhamento ligado: caiu.
pub const STALL_AFTER: Duration = Duration::from_secs(3);
/// O helper tem este tempo para abrir o espelhamento.
pub const START_TIMEOUT: Duration = Duration::from_secs(25);
/// Ninguém olhando por este tempo: para o espelhamento.
pub const IDLE_GRACE: Duration = Duration::from_secs(15);

/// O estado da conexão de um aparelho e quanto esperar antes da próxima tentativa.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub state: LinkState,
    /// Tentativas seguidas sem chegar a ligar.
    pub attempt: u32,
    pub transport: Option<Transport>,
    pub display: Option<(u32, u32)>,
    pub error: Option<String>,
}

impl Default for Link {
    fn default() -> Self {
        Link { state: LinkState::Connecting, attempt: 0, transport: None, display: None, error: None }
    }
}

impl Link {
    /// Abriu o helper (de novo).
    pub fn on_spawn(&mut self) {
        self.state = match self.state {
            LinkState::Live | LinkState::Reconnecting => LinkState::Reconnecting,
            LinkState::Offline if self.attempt > 0 => LinkState::Offline,
            _ if self.attempt > 0 => LinkState::Reconnecting,
            _ => LinkState::Connecting,
        };
    }

    pub fn on_started(&mut self, transport: Transport, display: Option<(u32, u32)>) {
        self.state = LinkState::Live;
        self.attempt = 0;
        self.error = None;
        self.transport = Some(transport);
        if display.is_some() {
            self.display = display;
        }
    }

    /// Caiu ou não abriu. Devolve quanto esperar antes de tentar de novo.
    pub fn on_lost(&mut self, reason: impl Into<String>) -> Duration {
        self.attempt = self.attempt.saturating_add(1);
        self.error = Some(reason.into());
        self.state = if self.attempt >= OFFLINE_AFTER { LinkState::Offline } else { LinkState::Reconnecting };
        backoff(self.attempt)
    }

    /// Falta algo que tentar de novo não resolve logo (o helper, o Xcode): "sem conexão" já.
    pub fn on_fatal(&mut self, reason: impl Into<String>) -> Duration {
        self.attempt = self.attempt.max(OFFLINE_AFTER);
        self.error = Some(reason.into());
        self.state = LinkState::Offline;
        Duration::from_secs(30)
    }

    pub fn on_paused(&mut self) {
        self.state = LinkState::Paused;
        self.attempt = 0;
    }
}

/// 0,5 s, 1 s, 2 s, 4 s e depois 8 s entre as tentativas.
pub fn backoff(attempt: u32) -> Duration {
    let steps = [500u64, 1000, 2000, 4000];
    Duration::from_millis(steps.get(attempt.saturating_sub(1) as usize).copied().unwrap_or(8000))
}

/// Um erro do helper que tentar de novo logo não resolve.
pub fn is_fatal(code: &str) -> bool {
    matches!(code, "coredevice" | "negotiator")
}

/// O que o código de saída do helper quer dizer, para a interface.
pub fn exit_reason(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(0), _) => "O espelhamento terminou.".into(),
        (Some(2), _) => "O aparelho não está conectado.".into(),
        (Some(3), _) => "Não deu para conectar ao aparelho.".into(),
        (Some(4), _) => "O aparelho está sem túnel do CoreDevice.".into(),
        (Some(6), _) => "O aparelho não abriu o espelhamento.".into(),
        (Some(c), _) => format!("O helper do espelhamento saiu com o código {c}."),
        (None, Some(s)) => format!("O helper do espelhamento caiu (sinal {s})."),
        (None, None) => "O helper do espelhamento saiu.".into(),
    }
}

// ── Entrada: toque, botões, teclado (as linhas que o helper lê no stdin) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchPhase {
    Start,
    Move,
    End,
}

/// De que borda o dedo sai: a de baixo é a barra de início; a de cima, as centrais.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    None,
    Top,
    Bottom,
}

impl Edge {
    fn word(self) -> &'static str {
        match self {
            Edge::None => "none",
            Edge::Top => "top",
            Edge::Bottom => "bottom",
        }
    }
}

fn unit(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

/// Um toque em proporção da tela (0..1, origem no topo, a tela em pé). `second` = o segundo dedo (pinça).
pub fn touch_line(phase: TouchPhase, point: (f64, f64), second: Option<(f64, f64)>, edge: Edge) -> String {
    let word = match phase {
        TouchPhase::Start => "start",
        TouchPhase::Move => "move",
        TouchPhase::End => "end",
    };
    let mut line = format!("touch {word} {:.4} {:.4}", unit(point.0), unit(point.1));
    if let Some((x, y)) = second {
        line.push_str(&format!(" {:.4} {:.4}", unit(x), unit(y)));
    }
    line.push(' ');
    line.push_str(edge.word());
    line
}

/// Os últimos 1,5% da tela contam como a borda: um arrasto que começa ali é o gesto da barra de início (embaixo)
/// ou das centrais (em cima), como no aparelho.
const EDGE_ZONE: f64 = 0.015;

/// Um clique na tela espelhada (coordenadas da view, origem no topo): a proporção e a borda. A view mostra a tela já
/// recortada (sem as bordas de alinhamento do vídeo), então a proporção da view é a da tela.
pub fn view_touch(x: f64, y: f64, width: f64, height: f64) -> Option<((f64, f64), Edge)> {
    let ratio = crate::simulator::model::touch_ratio(x, y, width, height)?;
    let edge = if ratio.1 >= 1.0 - EDGE_ZONE {
        Edge::Bottom
    } else if ratio.1 <= EDGE_ZONE {
        Edge::Top
    } else {
        Edge::None
    };
    Some((ratio, edge))
}

/// Pontos do iOS (os do `shot`) → proporção da tela.
pub fn point_ratio(x: f64, y: f64, size: (f64, f64)) -> Result<(f64, f64), String> {
    if size.0 <= 0.0 || size.1 <= 0.0 {
        return Err("O tamanho da tela do aparelho ainda não é conhecido.".into());
    }
    crate::simulator::model::point_ratio(x, y, size)
}

/// A tela em pontos do iOS: @3x nos iPhones grandes, @2x nos pequenos (até 828 px) e no iPad. A mesma conta do
/// frontend (`iphone/model.ts::physicalScreen`).
pub fn display_points(display: (u32, u32), family: &str) -> (f64, f64) {
    let scale = if family == "ipad" || display.0 <= 828 { 2.0 } else { 3.0 };
    ((f64::from(display.0) / scale).round(), (f64::from(display.1) / scale).round())
}

/// Os botões físicos: página e uso HID. Página 0x0C (consumo): início 0x40, bloquear/lateral 0x30, volume 0xE9/0xEA,
/// mudo 0xE2 (o botão de ação), Siri 0xCF.
pub fn button_usage(name: &str) -> Option<(u16, u16)> {
    let key: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    Some(match key.as_str() {
        "home" | "inicio" => (0x0C, 0x40),
        "lock" | "side" | "power" | "bloquear" | "lateral" => (0x0C, 0x30),
        "volumeup" | "volup" => (0x0C, 0xE9),
        "volumedown" | "voldown" => (0x0C, 0xEA),
        "mute" | "action" | "silenciar" | "mudo" => (0x0C, 0xE2),
        "siri" => (0x0C, 0xCF),
        _ => return None,
    })
}

/// Apertar e soltar um botão.
pub fn button_lines(name: &str) -> Result<[String; 2], String> {
    let (page, code) = button_usage(name)
        .ok_or_else(|| format!("Botão desconhecido: \"{name}\". Use home, lock, volumeUp, volumeDown, mute ou siri."))?;
    Ok([format!("button {page} {code} down"), format!("button {page} {code} up")])
}

/// Um gesto do sistema: de onde a onde o dedo vai, a borda e quanto demora.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gesture {
    pub from: (f64, f64),
    pub to: (f64, f64),
    pub edge: Edge,
    pub ms: u64,
    /// Quanto o dedo fica parado no fim antes de soltar (o alternador de apps pede o dedo parado).
    pub hold_ms: u64,
}

/// Central de Controle (de cima, à direita), Central de Notificações (de cima, à esquerda), Busca (para baixo no
/// meio da tela inicial) e início (de baixo para cima, pela barra).
pub fn gesture(name: &str) -> Option<Gesture> {
    let key: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    Some(match key.as_str() {
        "controlcenter" | "centraldecontrole" => Gesture { from: (0.9, 0.005), to: (0.9, 0.45), edge: Edge::Top, ms: 350, hold_ms: 0 },
        "notificationcenter" | "notifications" | "centraldenotificacoes" => Gesture { from: (0.2, 0.005), to: (0.2, 0.6), edge: Edge::Top, ms: 350, hold_ms: 0 },
        "spotlight" | "busca" | "search" => Gesture { from: (0.5, 0.35), to: (0.5, 0.6), edge: Edge::None, ms: 300, hold_ms: 0 },
        "home" | "inicio" => Gesture { from: (0.5, 0.995), to: (0.5, 0.7), edge: Edge::Bottom, ms: 250, hold_ms: 0 },
        "appswitcher" | "apps" | "alternador" => Gesture { from: (0.5, 0.995), to: (0.5, 0.62), edge: Edge::Bottom, ms: 350, hold_ms: 450 },
        _ => return None,
    })
}

/// Um deslize em `steps` passos: o dedo desce, anda e sobe, sempre com a mesma borda.
pub fn swipe_lines(from: (f64, f64), to: (f64, f64), steps: u32, edge: Edge) -> Vec<String> {
    let points = crate::simulator::model::swipe_points(from, to, steps);
    let mut lines = Vec::with_capacity(points.len() + 1);
    lines.push(touch_line(TouchPhase::Start, points[0], None, edge));
    for p in &points[1..] {
        lines.push(touch_line(TouchPhase::Move, *p, None, edge));
    }
    lines.push(touch_line(TouchPhase::End, *points.last().unwrap_or(&to), None, edge));
    lines
}

/// Uso HID do Shift esquerdo.
const SHIFT: u32 = 0xE1;

/// Texto → teclas (teclado US; só ASCII), com Shift quando precisa.
pub fn text_lines(text: &str) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    for (usage, shift) in crate::simulator::model::text_keys(text)? {
        if shift {
            lines.push(format!("key {SHIFT} down"));
        }
        lines.push(format!("key {usage} down"));
        lines.push(format!("key {usage} up"));
        if shift {
            lines.push(format!("key {SHIFT} up"));
        }
    }
    Ok(lines)
}

/// Uma tecla com nome (`enter`, `esc`, `tab`, setas…).
pub fn key_lines(name: &str) -> Result<[String; 2], String> {
    let usage = crate::simulator::model::key_usage(name)?;
    Ok([format!("key {usage} down"), format!("key {usage} up")])
}

/// O tamanho da foto tirada do quadro decodificado: a tela, sem as bordas de alinhamento (direita e embaixo).
pub fn crop_size(coded: (u32, u32), display: Option<(u32, u32)>) -> (u32, u32) {
    match display {
        Some((w, h)) if w > 0 && h > 0 && w <= coded.0 && h <= coded.1 => (w, h),
        _ => coded,
    }
}

/// O que o aparelho físico não faz pelos agentes (a lista de apps, abrir URL, girar e ligar são do simulador).
pub fn agent_unsupported(action: &str) -> bool {
    matches!(action, "open" | "launch" | "close" | "start" | "rotate" | "clipboard" | "tree")
}

/// Um agente no celular de verdade: olhar (`shot`) passa; tocar, deslizar, tecla e botão pedem à pessoa até ela dizer
/// "sempre neste aparelho"; digitar texto pede sempre (não se sabe em que campo o texto cai).
pub fn agent_asks(action: &str, trusted: bool) -> bool {
    match action {
        "shot" => false,
        "type" => true,
        _ => !trusted,
    }
}


// ── Rolagem do trackpad e pinça: viram dedos no digitalizador ──
// O HID de rolagem do CoreDevice é do dial e da Digital Crown (`ScrollTarget.dial/digitalCrown`), não do conteúdo
// do iPhone: a rolagem com dois dedos vira um dedo arrastando, como no simulador.

/// A fase de um evento de rolagem ou de pinça do Mac. `None` = roda do mouse (sem fases).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollPhase {
    None,
    Began,
    Changed,
    Ended,
}

/// Um dedo que segue a rolagem do trackpad. Coordenadas da view (origem no topo).
#[derive(Debug, Default)]
pub struct ScrollDrag {
    finger: Option<(f64, f64)>,
}

/// Quanto um clique da roda do mouse (sem deltas precisos) arrasta, em pontos.
const WHEEL_STEP: f64 = 12.0;

impl ScrollDrag {
    fn clamp(p: (f64, f64), size: (f64, f64)) -> (f64, f64) {
        (p.0.clamp(1.0, (size.0 - 1.0).max(1.0)), p.1.clamp(1.0, (size.1 - 1.0).max(1.0)))
    }

    /// Um evento de rolagem → os toques a mandar. A direção já vem da preferência do Mac (rolagem natural): o dedo
    /// no aparelho anda com o conteúdo. A inércia do Mac (`momentum`) fica de fora: o iOS aplica a dele quando o dedo
    /// solta.
    pub fn event(&mut self, phase: ScrollPhase, momentum: bool, cursor: (f64, f64), delta: (f64, f64), precise: bool, size: (f64, f64)) -> Vec<(TouchPhase, (f64, f64))> {
        if momentum {
            return Vec::new();
        }
        let scale = if precise { 1.0 } else { WHEEL_STEP };
        let step = |from: (f64, f64)| Self::clamp((from.0 + delta.0 * scale, from.1 + delta.1 * scale), size);
        match phase {
            ScrollPhase::None => {
                let start = Self::clamp(cursor, size);
                let end = step(start);
                vec![(TouchPhase::Start, start), (TouchPhase::Move, end), (TouchPhase::End, end)]
            }
            ScrollPhase::Began | ScrollPhase::Changed => {
                let mut out = Vec::new();
                let from = match self.finger {
                    Some(p) => p,
                    None => {
                        let start = Self::clamp(cursor, size);
                        out.push((TouchPhase::Start, start));
                        start
                    }
                };
                let next = step(from);
                if next != from || out.len() == 1 {
                    out.push((TouchPhase::Move, next));
                }
                self.finger = Some(next);
                out
            }
            ScrollPhase::Ended => self.finger.take().map(|p| vec![(TouchPhase::End, p)]).unwrap_or_default(),
        }
    }
}

/// Dois dedos que seguem a pinça do trackpad, em volta do cursor.
#[derive(Debug, Default)]
pub struct Pinch {
    center: Option<(f64, f64)>,
    scale: f64,
}

/// A distância inicial entre os dedos, em proporção da largura da tela.
const PINCH_START: f64 = 0.2;

impl Pinch {
    fn fingers(&self, size: (f64, f64)) -> ((f64, f64), (f64, f64)) {
        let c = self.center.unwrap_or((size.0 / 2.0, size.1 / 2.0));
        let half = (size.0 * PINCH_START * self.scale / 2.0).clamp(4.0, size.0 / 2.0);
        let clamp = |x: f64| x.clamp(1.0, (size.0 - 1.0).max(1.0));
        ((clamp(c.0 - half), c.1), (clamp(c.0 + half), c.1))
    }

    /// Um evento de pinça (`magnification` = quanto mudou desde o anterior) → a fase e os dois dedos.
    pub fn event(&mut self, phase: ScrollPhase, cursor: (f64, f64), magnification: f64, size: (f64, f64)) -> Option<(TouchPhase, (f64, f64), (f64, f64))> {
        match phase {
            ScrollPhase::Began => {
                self.center = Some(ScrollDrag::clamp(cursor, size));
                self.scale = (1.0 + magnification).max(0.1);
                let (a, b) = self.fingers(size);
                Some((TouchPhase::Start, a, b))
            }
            ScrollPhase::Changed => {
                self.center?;
                self.scale = (self.scale + magnification).max(0.1);
                let (a, b) = self.fingers(size);
                Some((TouchPhase::Move, a, b))
            }
            ScrollPhase::Ended => {
                self.center?;
                let (a, b) = self.fingers(size);
                self.center = None;
                Some((TouchPhase::End, a, b))
            }
            ScrollPhase::None => None,
        }
    }
}


/// Um botão apertado ou solto (para segurar: o lateral segurado chama a Siri, o volume segurado continua).
pub fn button_state_line(name: &str, down: bool) -> Result<String, String> {
    let (page, code) = button_usage(name).ok_or_else(|| format!("Botão desconhecido: \"{name}\"."))?;
    Ok(format!("button {page} {code} {}", if down { "down" } else { "up" }))
}

/// O que um atalho com ⌘ faz no espelho em foco.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shortcut {
    Button(&'static str),
    Home,
}

/// ⌘↑ e ⌘↓ = volume, ⌘L = bloquear (botão lateral), ⌘⇧H = início. `key` = código de tecla do Mac.
pub fn shortcut(key: u16, command: bool, shift: bool) -> Option<Shortcut> {
    if !command {
        return None;
    }
    match (key, shift) {
        (126, _) => Some(Shortcut::Button("volumeUp")),
        (125, _) => Some(Shortcut::Button("volumeDown")),
        (37, false) => Some(Shortcut::Button("lock")),
        (4, true) => Some(Shortcut::Home),
        _ => None,
    }
}


// ── Quando soltar um quadro já mostrado ──

/// O que soltar da fila de quadros mostrados (do mais velho ao mais novo).
#[derive(Debug, Default, PartialEq)]
pub struct ReleasePlan {
    /// Os índices a soltar.
    pub release: Vec<usize>,
    /// Quantos saíram ainda em uso pela tela, por excesso (passaram de `cap`).
    pub forced: usize,
    /// Quantos a regra antiga (guardar só os 3 últimos) teria soltado com a tela ainda usando: o perigo medido.
    pub unsafe_before: usize,
}

/// Os dois quadros mais novos ficam sempre; os outros saem só quando a tela não os usa mais (`IOSurfaceIsInUse`):
/// senão o pool do VideoToolbox escreve o quadro seguinte numa superfície que a GPU ainda compõe, e aparecem blocos
/// de dois quadros misturados. Passando de `cap`, os mais velhos saem mesmo em uso (a memória não cresce sem fim).
pub fn release_plan(in_use: &[bool], cap: usize) -> ReleasePlan {
    const KEEP: usize = 2;
    const OLD_HELD: usize = 3;
    let n = in_use.len();
    let mut plan = ReleasePlan::default();
    let older = n.saturating_sub(KEEP);
    let over = n.saturating_sub(cap);
    for (i, used) in in_use.iter().enumerate().take(older) {
        if i < over {
            plan.release.push(i);
            plan.forced += usize::from(*used);
        } else if !used {
            plan.release.push(i);
        }
    }
    plan.unsafe_before = in_use.iter().take(n.saturating_sub(OLD_HELD)).filter(|u| **u).count();
    plan
}
