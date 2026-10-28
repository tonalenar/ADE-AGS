//! Canal estruturado em paralelo ao terminal: o estado de cada aba de agente lido do transcript
//! que a própria TUI escreve enquanto roda (Claude Code e Codex), e não da tela.
//!
//! A TUI continua sendo a TUI; o ADE só lê o arquivo dela, que cresce a cada evento. Disso sai
//! um estado firme (turno aberto ou encerrado, ferramenta pendente, pergunta com opções, tokens)
//! que vale MAIS que a tela onde existe, e a tela continua valendo onde não existe (outros
//! agentes, sessão ainda sem arquivo, estado velho). Ver `docs/ade-ags/CANAL_ESTRUTURADO.md`.
//!
//! Aqui fica o puro e o estado em memória. Quem roda o laço, emite o evento para a janela e
//! avisa o orquestrador é `ipc/commands/canal.rs`.

pub mod claude;
pub mod codex;
pub mod event;
pub mod pending;
pub mod state;
pub mod tail;
#[cfg(test)]
mod test;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

pub use pending::migrate;
use state::{Phase, TabState};
use tail::Tailer;

/// Os agentes com canal estruturado.
pub fn supported(agent_id: &str) -> bool {
    matches!(agent_id, "claude-code" | "codex")
}

// ── Modo ──────────────────────────────────────────────────────────────

/// Quanto o estado estruturado manda nas decisões.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Só se lê e mostra (`ags tab state`); nada decide por ele.
    Off,
    /// Padrão. Só no sentido seguro: um turno aberto no transcript segura a entrega de mensagens
    /// e as cutucadas mesmo com a tela quieta. Nunca faz o ADE escrever MAIS cedo do que antes.
    Veto,
    /// O transcript manda nos dois sentidos: turno encerrado vence o spinner velho na tela.
    Full,
}

impl Mode {
    pub fn parse(raw: &str) -> Option<Mode> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "0" | "desligado" => Some(Mode::Off),
            "veto" | "on" | "1" => Some(Mode::Veto),
            "full" | "autoritativo" | "2" => Some(Mode::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Veto => "veto",
            Mode::Full => "full",
        }
    }
}

/// A chave em `settings` e a variável de ambiente que escolhem o modo (o ambiente vence).
pub const MODE_SETTING: &str = "canal.modo";
pub const MODE_ENV: &str = "ADE_AGS_CANAL";

static MODE: AtomicU8 = AtomicU8::new(1);

pub fn mode() -> Mode {
    match MODE.load(Ordering::Relaxed) {
        0 => Mode::Off,
        2 => Mode::Full,
        _ => Mode::Veto,
    }
}

pub fn set_mode(mode: Mode) {
    MODE.store(match mode { Mode::Off => 0, Mode::Veto => 1, Mode::Full => 2 }, Ordering::Relaxed);
}

/// Pura: o modo, a partir da variável de ambiente e da configuração salva.
pub fn mode_from(env: Option<&str>, setting: Option<&str>) -> Mode {
    env.and_then(Mode::parse).or_else(|| setting.and_then(Mode::parse)).unwrap_or(Mode::Veto)
}

// ── Uma linha → eventos ────────────────────────────────────────────────

/// Os eventos de uma linha do transcript de `agent_id`, com o carimbo dela (ms), se tiver.
pub fn parse_line(agent_id: &str, line: &[u8]) -> (Option<i64>, Vec<event::Event>) {
    // Filtro barato antes de decodificar: as linhas que importam têm um destes tipos.
    let interesting: &[&[u8]] = match agent_id {
        "claude-code" => &[b"\"type\":\"user\"", b"\"type\":\"assistant\"", b"\"type\":\"system\""],
        "codex" => &[b"\"type\":\"event_msg\"", b"\"type\":\"response_item\""],
        _ => return (None, vec![]),
    };
    if !interesting.iter().any(|needle| line.windows(needle.len()).any(|w| w == *needle)) {
        return (None, vec![]);
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else { return (None, vec![]) };
    let at = value.get("timestamp").and_then(Value::as_str).and_then(event::parse_ts_ms);
    let events = match agent_id {
        "claude-code" => claude::events(&value),
        _ => codex::events(&value),
    };
    (at, events)
}

// ── Onde está o transcript de uma aba ─────────────────────────────────

/// O arquivo do transcript da sessão `session_id`. Só com o id: "o mais novo da pasta" pode ser
/// de outra aba no mesmo cwd, e um estado de outra conversa é pior que nenhum.
pub fn transcript_path(agent_id: &str, cwd: &str, session_id: &str, profile: Option<&Path>) -> Option<PathBuf> {
    if !crate::session::is_safe_session_id(session_id) {
        return None;
    }
    match agent_id {
        "claude-code" => {
            let path = crate::session::claude_project_dir(cwd, profile).join(format!("{session_id}.jsonl"));
            path.is_file().then_some(path)
        }
        "codex" => codex_rollout_by_id(&crate::session::codex_root(profile), session_id),
        _ => None,
    }
}

/// O rollout do Codex com este id: o nome é `rollout-<data>-<id>.jsonl`, então basta listar as
/// pastas de data, sem abrir arquivo nenhum. Os `.jsonl.zst` (sessões antigas compactadas) não
/// crescem mais e ficam de fora.
pub fn codex_rollout_by_id(root: &Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    let mut stack = vec![root.to_path_buf()];
    let mut found: Option<(std::time::SystemTime, PathBuf)> = None;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix)) {
                let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if found.as_ref().is_none_or(|(at, _)| modified > *at) {
                    found = Some((modified, path));
                }
            }
        }
    }
    found.map(|(_, path)| path)
}

// ── O acompanhamento de uma aba ───────────────────────────────────────

/// O estado de uma aba como sai para a CLI, a janela e as decisões.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tab_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub path: String,
    pub mode: Mode,
    /// A fase que vale (com o prazo de [`state::STALE_OPEN_MS`] aplicado).
    pub phase: Phase,
    /// O turno está aberto no arquivo, mas ele está parado há tempo demais para confiar.
    pub stale: bool,
    /// Quando o arquivo cresceu pela última vez (ms).
    pub grew_at: i64,
    #[serde(flatten)]
    pub state: TabState,
}

impl Snapshot {
    /// A versão curta, para `ags tab list`.
    pub fn brief(&self) -> Value {
        serde_json::json!({
            "phase": self.phase,
            "tools": self.state.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            "question": self.state.question.is_some(),
            "endsWithQuestion": self.state.ends_with_question,
        })
    }
}

/// Lê o transcript de uma aba e mantém o estado dela.
#[derive(Debug)]
pub struct Tracker {
    pub agent_id: String,
    pub session_id: String,
    tailer: Tailer,
    pub state: TabState,
    pub grew_at: i64,
}

impl Tracker {
    pub fn new(agent_id: &str, session_id: &str, path: PathBuf) -> Tracker {
        Tracker { agent_id: agent_id.into(), session_id: session_id.into(), tailer: Tailer::new(path), state: TabState::default(), grew_at: 0 }
    }

    /// Lê o que o arquivo ganhou e aplica. `Err` = o arquivo sumiu ou não abre.
    pub fn feed(&mut self, now: i64) -> std::io::Result<()> {
        let first = self.tailer.offset() == 0 && self.grew_at == 0;
        let batch = self.tailer.poll()?;
        if batch.reset {
            self.state = TabState::default();
        }
        if first || batch.reset {
            // A primeira leitura é do passado: o "cresceu" é a data do arquivo, não agora.
            self.grew_at = std::fs::metadata(self.tailer.path())
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(now);
        } else if !batch.lines.is_empty() {
            self.grew_at = now;
        }
        for line in &batch.lines {
            let (at, events) = parse_line(&self.agent_id, line);
            for event in events {
                self.state.apply(event, at.unwrap_or(now));
            }
        }
        Ok(())
    }

    pub fn snapshot(&self, tab_id: &str, now: i64) -> Snapshot {
        let phase = self.state.effective_phase(self.grew_at, now);
        Snapshot {
            tab_id: tab_id.into(),
            agent_id: self.agent_id.clone(),
            session_id: self.session_id.clone(),
            path: self.tailer.path().to_string_lossy().into_owned(),
            mode: mode(),
            phase,
            stale: phase == Phase::Unknown && self.state.phase == Phase::Working,
            grew_at: self.grew_at,
            state: self.state.clone(),
        }
    }
}

// ── O estado de todas as abas, em memória ─────────────────────────────

fn snapshots() -> &'static Mutex<HashMap<String, Snapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<String, Snapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(Default::default)
}

pub fn publish(snapshot: Snapshot) {
    snapshots().lock().unwrap_or_else(|e| e.into_inner()).insert(snapshot.tab_id.clone(), snapshot);
}

pub fn forget(tab_id: &str) {
    snapshots().lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id);
}

pub fn snapshot(tab_id: &str) -> Option<Snapshot> {
    snapshots().lock().unwrap_or_else(|e| e.into_inner()).get(tab_id).cloned()
}

pub fn all() -> Vec<Snapshot> {
    snapshots().lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect()
}

/// Pura: com este estado e este modo, o destino está ocupado (não se deve digitar nele)?
/// `None` de estado (agente sem canal, sem arquivo) = não se sabe, e quem decide é a tela.
pub fn busy_in(snapshot: Option<&Snapshot>, mode: Mode, now: i64) -> bool {
    match (mode, snapshot) {
        (Mode::Off, _) | (_, None) => false,
        (_, Some(s)) => s.state.effective_phase(s.grew_at, now) == Phase::Working,
    }
}

/// O transcript diz que `tab_id` está no meio de um turno (e o modo deixa isso valer).
pub fn busy(tab_id: &str) -> bool {
    busy_in(snapshot(tab_id).as_ref(), mode(), crate::util::now_ts_ms())
}
