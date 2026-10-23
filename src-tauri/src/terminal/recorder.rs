//! Gravador dos testes por replay (só para desenvolvimento): guarda a saída crua de UMA aba, com o
//! instante de cada pedaço, e devolve uma fixture no formato `ade-replay` v1
//! (`docs/ade-ags/REPLAY_TESTES.md`).
//!
//! Regras:
//! - **Nasce desligado e só liga com o app aberto com `ADE_AGS_REPLAY_RECORD=1`.** Sem isso os
//!   comandos `replay.*` recusam e `observe` é uma leitura atômica e volta.
//! - Grava só a aba pedida, por tempo e tamanho limitados; nada vai para o disco pelo app: a fixture
//!   volta na resposta do `ags replay stop`.
//! - **Nunca devolve um segredo**: se o texto gravado parece ter token, senha ou chave
//!   (`memory::agent::looks_like_secret`), a gravação é descartada inteira.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

/// A variável de ambiente que liga o gravador no processo do app.
pub(crate) const RECORD_ENV: &str = "ADE_AGS_REPLAY_RECORD";
pub(crate) const DEFAULT_SECS: u64 = 120;
pub(crate) const MAX_SECS: u64 = 600;
pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Quanto do scrollback de antes entra como "o que já estava na tela" (o `prelude`).
pub(crate) const DEFAULT_PRELUDE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_PRELUDE_BYTES: usize = 512 * 1024;

/// Uma gravação em andamento.
pub(crate) struct Recording {
    pub tab_id: String,
    pub cols: u16,
    pub rows: u16,
    started: Instant,
    limit: Duration,
    max_bytes: usize,
    bytes: usize,
    prelude: Option<String>,
    chunks: Vec<(u64, Vec<u8>)>,
    /// Passou do tempo ou do tamanho: o resto foi descartado.
    truncated: bool,
}

impl Recording {
    pub(crate) fn new(tab_id: &str, cols: u16, rows: u16, limit: Duration, max_bytes: usize, prelude: Option<String>) -> Self {
        Recording {
            tab_id: tab_id.to_string(),
            cols,
            rows,
            started: Instant::now(),
            limit,
            max_bytes,
            bytes: 0,
            prelude: prelude.map(|text| from_line_start(&text).to_string()).filter(|text| !text.is_empty()),
            chunks: Vec::new(),
            truncated: false,
        }
    }

    /// Guarda o pedaço que chegou `elapsed` depois do início. Pura (o relógio vem de fora).
    pub(crate) fn push(&mut self, elapsed: Duration, chunk: &[u8]) {
        if self.truncated || elapsed > self.limit || self.bytes + chunk.len() > self.max_bytes {
            self.truncated = true;
            return;
        }
        self.bytes += chunk.len();
        self.chunks.push((elapsed.as_millis() as u64, chunk.to_vec()));
    }

    /// Todo o texto gravado, sem escapes: o que o detector de segredo examina.
    pub(crate) fn plain_text(&self) -> String {
        let mut raw = self.prelude.clone().unwrap_or_default();
        for (_, bytes) in &self.chunks {
            raw.push_str(&String::from_utf8_lossy(bytes));
        }
        crate::orchestrator::digest::strip_ansi(&raw)
    }

    pub(crate) fn looks_secret(&self) -> bool {
        crate::memory::agent::looks_like_secret(&self.plain_text())
    }

    /// A fixture: sem checkpoints (quem grava os escreve) e com a origem marcada como gravada. Pura.
    pub(crate) fn fixture(&self, agent: &str, recorded_at: &str, stamp: &str) -> Value {
        let agent = if agent.trim().is_empty() { "desconhecido" } else { agent.trim() };
        let mut chunks: Vec<Value> = Vec::new();
        if let Some(text) = &self.prelude {
            chunks.push(json!({ "atMs": 0, "data": text, "prelude": true }));
        }
        chunks.extend(self.chunks.iter().map(|(at, bytes)| chunk_json(*at, bytes)));
        let duration = self.chunks.last().map(|(at, _)| *at).unwrap_or(0);
        json!({
            "format": "ade-replay",
            "version": 1,
            "id": format!("gravada-{agent}-{stamp}"),
            "agent": agent,
            "title": format!("Gravação de {agent}: descreva a tela antes de commitar"),
            "origin": {
                "kind": "recorded",
                "basis": format!("ags replay start/stop na aba {}", self.tab_id),
                "recordedAt": recorded_at,
                "platform": std::env::consts::OS,
                "tuiVersion": null,
            },
            "terminal": { "cols": self.cols, "rows": self.rows },
            "chunks": chunks,
            "checkpoints": [],
            "recording": { "bytes": self.bytes, "durationMs": duration, "truncated": self.truncated },
        })
    }
}

/// O pedaço como vai para a fixture: texto quando é UTF-8 válido sozinho, senão os bytes em base64. Pura.
pub(crate) fn chunk_json(at_ms: u64, bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => json!({ "atMs": at_ms, "data": text }),
        Err(_) => json!({ "atMs": at_ms, "b64": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

/// O fim do scrollback começa onde caiu o corte, talvez no meio de um escape: começa na linha seguinte. Pura.
fn from_line_start(text: &str) -> &str {
    match text.find('\n') {
        Some(cut) if cut + 1 < text.len() => &text[cut + 1..],
        _ => text,
    }
}

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static RECORDINGS: LazyLock<Mutex<HashMap<u32, Recording>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn recordings() -> MutexGuard<'static, HashMap<u32, Recording>> {
    RECORDINGS.lock().unwrap_or_else(|e| e.into_inner())
}

/// O app foi aberto com o gravador ligado?
pub(crate) fn enabled() -> bool {
    std::env::var(RECORD_ENV).is_ok_and(|v| v == "1")
}

/// Chamado pela thread que lê o PTY a cada pedaço. Sem gravação ativa, é só uma leitura atômica.
pub fn observe(pty_id: u32, chunk: &[u8]) {
    if ACTIVE.load(Ordering::Relaxed) == 0 {
        return;
    }
    if let Some(recording) = recordings().get_mut(&pty_id) {
        let elapsed = recording.started.elapsed();
        recording.push(elapsed, chunk);
    }
}

/// Começa a gravar o PTY. Erro se já há uma gravação nele.
pub(crate) fn start(pty_id: u32, recording: Recording) -> Result<(), String> {
    let mut map = recordings();
    if map.values().any(|r| r.tab_id == recording.tab_id) || map.contains_key(&pty_id) {
        return Err(format!("A aba {} já está sendo gravada. Pare antes com 'ags replay stop --tab {}'.", recording.tab_id, recording.tab_id));
    }
    map.insert(pty_id, recording);
    ACTIVE.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Para a gravação da aba (mesmo que o PTY já tenha morrido) e a devolve.
pub(crate) fn stop_tab(tab_id: &str) -> Option<Recording> {
    let mut map = recordings();
    let pty = map.iter().find(|(_, r)| r.tab_id == tab_id).map(|(pty, _)| *pty)?;
    let recording = map.remove(&pty)?;
    ACTIVE.fetch_sub(1, Ordering::Relaxed);
    Some(recording)
}

/// As gravações em andamento: `(aba, ms desde o início, bytes, cortada)`.
pub(crate) fn active() -> Vec<(String, u64, usize, bool)> {
    recordings()
        .values()
        .map(|r| (r.tab_id.clone(), r.started.elapsed().as_millis() as u64, r.bytes, r.truncated))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(limit_ms: u64, max_bytes: usize) -> Recording {
        Recording::new("t1", 100, 30, Duration::from_millis(limit_ms), max_bytes, None)
    }

    #[test]
    fn guarda_os_pedacos_com_o_instante_e_corta_no_limite() {
        let mut r = rec(1000, 10);
        r.push(Duration::from_millis(0), b"abc");
        r.push(Duration::from_millis(250), b"\x1b[1mde");
        r.push(Duration::from_millis(300), b"passa do tamanho");
        r.push(Duration::from_millis(400), b"x");
        let f = r.fixture("codex", "2026-10-22T21:00:00-03:00", "20261022-210000");
        assert_eq!(f["chunks"], json!([{ "atMs": 0, "data": "abc" }, { "atMs": 250, "data": "\u{1b}[1mde" }]));
        assert_eq!(f["recording"]["truncated"], true, "depois do corte nada mais entra");
        let mut late = rec(1000, 1000);
        late.push(Duration::from_millis(1001), b"tarde");
        assert_eq!(late.fixture("x", "", "s")["chunks"], json!([]));
    }

    #[test]
    fn utf8_partido_vai_em_base64_e_volta_identico() {
        // "ã" partido entre duas leituras do PTY: nenhum dos pedaços é UTF-8 válido sozinho.
        let bytes = "ã".as_bytes();
        let first = chunk_json(5, &bytes[..1]);
        assert!(first.get("data").is_none());
        let decoded = base64::engine::general_purpose::STANDARD.decode(first["b64"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, &bytes[..1]);
    }

    #[test]
    fn a_fixture_gravada_tem_o_formato_v1_sem_checkpoints() {
        let mut r = Recording::new("aba-7", 120, 40, Duration::from_secs(10), 1024, Some("\x1b[3meio de escape\nlinha inteira\n".into()));
        r.push(Duration::from_millis(10), b"ok");
        let f = r.fixture("opencode", "2026-10-22T21:00:00-03:00", "20261022-210000");
        assert_eq!(f["format"], "ade-replay");
        assert_eq!(f["id"], "gravada-opencode-20261022-210000");
        assert_eq!(f["origin"]["kind"], "recorded");
        assert_eq!(f["terminal"], json!({ "cols": 120, "rows": 40 }));
        assert_eq!(f["checkpoints"], json!([]));
        // O prelude começa na linha seguinte ao corte (o corte pode cair no meio de um escape).
        assert_eq!(f["chunks"][0], json!({ "atMs": 0, "data": "linha inteira\n", "prelude": true }));
    }

    #[test]
    fn texto_com_segredo_e_reconhecido() {
        let mut r = rec(1000, 1024);
        r.push(Duration::from_millis(1), b"\x1b[32mexport\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
        assert!(r.looks_secret());
        let mut clean = rec(1000, 1024);
        clean.push(Duration::from_millis(1), "• Working (5s • esc to interrupt)".as_bytes());
        assert!(!clean.looks_secret());
    }

    #[test]
    fn so_uma_gravacao_por_aba_e_parar_devolve_a_gravacao() {
        start(9_001, Recording::new("aba-rec-teste", 80, 24, Duration::from_secs(5), 1024, None)).unwrap();
        assert!(start(9_002, Recording::new("aba-rec-teste", 80, 24, Duration::from_secs(5), 1024, None)).is_err());
        observe(9_001, b"ola");
        let r = stop_tab("aba-rec-teste").expect("gravando");
        assert_eq!(r.plain_text(), "ola");
        assert!(stop_tab("aba-rec-teste").is_none());
    }
}
