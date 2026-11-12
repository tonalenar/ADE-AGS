//! Autocompact de contexto das conversas por protocolo: quando o uso passa do limiar, ao fim do turno a ADE pede a
//! compactação NATIVA do agente, mostra o estado na timeline e segura as mensagens que chegarem enquanto ela roda.
//!
//! Decisões (ver `docs/decisoes/AUTOCOMPACT.md`):
//! - o agente que já compacta sozinho (Claude Code) não é duplicado: a ADE só **garante o limite** (a janela de
//!   auto-compact da sessão, calculada do limiar em %) e **reflete** os eventos dele (`status: compacting` e
//!   `compact_boundary`). Se a flag dele estiver desligada, a ADE assume e manda o `/compact`;
//! - o Codex não compacta no limiar do usuário (o limite próprio dele só se conhece com a janela do modelo): a ADE
//!   mede pelo `thread/tokenUsage/updated` e dispara o `thread/compact/start` no fim do turno;
//! - nunca no meio de um turno, nunca com pedido pendente, e a mesma ponta de contexto só é tentada uma vez;
//! - agente sem medida de contexto ou sem compactação pelo protocolo fica desligado, com o motivo na tela;
//! - terminais (PTY) **nunca** recebem digitação da ADE: ver [`plan_table`].
//!
//! O núcleo (configuração, cálculo, decisão, reducer de eventos) é puro e testado em `autocompact_test.rs`; o resto
//! é cola fina com o banco, a janela e o motor.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::canal::timeline::{Item, ItemKind, ToolStatus};
use crate::database::DbConnection;

use super::store;

/// A configuração, em `settings`: `{"enabled":true,"agents":{"codex":{"enabled":true,"thresholdPct":80}}}`.
pub const SETTING: &str = "chat.autocompact";
/// O limiar padrão (% da janela): o ponto em que o Claude Code compacta sozinho numa janela de 200k
/// (200k − 33k de reserva = 83,5%). Vale para todos os agentes que a ADE compacta.
pub const DEFAULT_PCT: u8 = 83;
pub const MIN_PCT: u8 = 50;
pub const MAX_PCT: u8 = 95;
/// A reserva que o Claude Code deixa antes do fim da janela (a janela de auto-compact menos isto é o ponto em que ele
/// compacta). O mesmo valor que o T3 Code usa para mostrar onde o provedor compacta.
pub const CLAUDE_RESERVE_TOKENS: u64 = 33_000;
const CLAUDE_MIN_WINDOW: u64 = 100_000;
const CLAUDE_MAX_WINDOW: u64 = 1_000_000;
/// Uma compactação «em curso» que não termina (evento perdido, processo caído) deixa de segurar a conversa.
pub const ACTIVE_TTL_MS: i64 = 10 * 60_000;
/// Quantos itens do fim da conversa a decisão lê (o último `usage` e a última compactação estão sempre perto).
const TAIL: i64 = 160;

// ── configuração ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentConfig {
    pub enabled: Option<bool>,
    pub threshold_pct: Option<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub agents: HashMap<String, AgentConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: true, agents: HashMap::new() }
    }
}

/// Lê a configuração. Qualquer lixo volta ao padrão (ligado): a pessoa pediu o autocompact ligado.
pub fn parse_config(raw: Option<&str>) -> Config {
    let Some(value) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else { return Config::default() };
    let Some(object) = value.as_object() else { return Config::default() };
    let enabled = object.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let agents = object
        .get("agents")
        .and_then(Value::as_object)
        .map(|agents| {
            agents
                .iter()
                .map(|(id, cfg)| {
                    let threshold_pct = cfg.get("thresholdPct").and_then(Value::as_u64).map(|n| n.clamp(MIN_PCT as u64, MAX_PCT as u64) as u8);
                    (id.clone(), AgentConfig { enabled: cfg.get("enabled").and_then(Value::as_bool), threshold_pct })
                })
                .collect()
        })
        .unwrap_or_default();
    Config { enabled, agents }
}

impl Config {
    /// Ligado para o agente: o interruptor global manda; o do agente só desliga um agente específico.
    pub fn enabled_for(&self, agent_id: &str) -> bool {
        self.enabled && self.agents.get(agent_id).and_then(|a| a.enabled).unwrap_or(true)
    }

    /// O limiar que a pessoa escolheu para o agente, se escolheu.
    pub fn explicit_pct(&self, agent_id: &str) -> Option<u8> {
        self.agents.get(agent_id).and_then(|a| a.threshold_pct)
    }

    /// O limiar em vigor: o escolhido, ou o padrão.
    pub fn effective_pct(&self, agent_id: &str) -> u8 {
        self.explicit_pct(agent_id).unwrap_or(DEFAULT_PCT)
    }
}

pub fn config(db: &DbConnection) -> Config {
    parse_config(crate::database::get_setting(db, SETTING).ok().flatten().as_deref())
}

// ── mecanismo por agente ─────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mechanism {
    /// O agente compacta sozinho; a ADE garante o limite e reflete o evento.
    NativeAuto,
    /// A ADE mede e pede a compactação ao agente (comando nativo dele).
    AdeCommand,
    /// Sem compactação pelo protocolo ou sem medida de contexto: desligado.
    Unsupported,
}

/// O que a ADE manda ao agente para compactar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Uma linha `user` com este texto (o Claude Code executa `/compact`).
    Slash(&'static str),
    /// O pedido `thread/compact/start` do app-server do Codex.
    ThreadCompactStart,
}

/// O comando nativo de cada agente, numa tabela (como `plan_table`): quem acrescenta um agente acrescenta uma linha.
const COMMANDS: [(&str, Command); 2] = [("claude-code", Command::Slash("/compact")), ("codex", Command::ThreadCompactStart)];

pub fn command_for(agent_id: &str) -> Option<Command> {
    COMMANDS.iter().find(|(id, _)| *id == agent_id).map(|(_, command)| *command)
}

/// O mecanismo de uma conversa por protocolo.
pub fn chat_mechanism(agent_id: &str) -> Mechanism {
    match agent_id {
        "claude-code" => Mechanism::NativeAuto,
        "codex" => Mechanism::AdeCommand,
        _ => Mechanism::Unsupported,
    }
}

/// Uma linha da tabela «agente → medida → mecanismo → suportado», que a tela mostra com o motivo traduzido.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub agent_id: &'static str,
    /// `chat` (conversa por protocolo, inclui os times e as conversas-filhas), `tui` (terminal, inclui as missões) ou `fleet`.
    pub surface: &'static str,
    /// De onde vem a medida de contexto (código traduzido na tela).
    pub measure: &'static str,
    pub mechanism: Mechanism,
    /// A ADE gerencia o autocompact deste agente (mede, garante o limite ou dispara).
    pub supported: bool,
    /// A ADE digita no terminal dele. Sempre `false`: terminal com agente nunca recebe digitação da ADE.
    pub ade_types: bool,
    /// O código do motivo (por que é assim), traduzido na tela.
    pub reason: &'static str,
}

const fn row(agent_id: &'static str, surface: &'static str, measure: &'static str, mechanism: Mechanism, supported: bool, reason: &'static str) -> PlanRow {
    PlanRow { agent_id, surface, measure, mechanism, supported, ade_types: false, reason }
}

/// O mapa de cada agente que a ADE roda. Fonte da tela e do doc; mudou uma linha, mude `docs/decisoes/AUTOCOMPACT.md`.
pub fn plan_table() -> Vec<PlanRow> {
    use Mechanism::*;
    vec![
        // Conversas por protocolo (modo chat, times, conversas-filhas, missões em conversa).
        row("claude-code", "chat", "resultUsage", NativeAuto, true, "nativeAutoWindow"),
        row("codex", "chat", "tokenUsage", AdeCommand, true, "threadCompact"),
        row("opencode", "chat", "none", Unsupported, false, "acpNoContext"),
        row("antigravity", "chat", "none", Unsupported, false, "acpNoCompact"),
        row("cursor", "chat", "none", Unsupported, false, "noContext"),
        row("local-acp", "chat", "none", Unsupported, false, "acpNoContext"),
        // Terminais (PTY), inclusive os das missões: a ADE nunca digita neles.
        row("claude-code", "tui", "transcriptUsage", NativeAuto, true, "tuiNativeWindow"),
        row("codex", "tui", "transcriptUsage", NativeAuto, true, "tuiNativeMeterOnly"),
        row("gemini-cli", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        row("opencode", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        row("kimi-code", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        row("hermes", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        row("antigravity", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        row("cursor", "tui", "none", Unsupported, false, "tuiNativeUnmeasured"),
        // Frota headless: tarefas curtas, de um turno só, sem sessão para compactar.
        row("claude-code", "fleet", "none", Unsupported, false, "fleetSingleTask"),
        row("codex", "fleet", "none", Unsupported, false, "fleetSingleTask"),
    ]
}

// ── uso de contexto ──────────────────────────────────────────────────────

/// O contexto medido: tokens usados e a janela do modelo. `at`/`id` são do item `usage` de onde saiu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Usage {
    pub used: u64,
    pub window: u64,
    pub at: Option<i64>,
    pub id: String,
}

/// A fração da janela ocupada, em %. `None` sem janela.
pub fn percent(used: u64, window: u64) -> Option<f64> {
    (window > 0).then(|| (used as f64 / window as f64 * 100.0).min(100.0))
}

/// O uso de um item `usage`: só os agentes com medida de contexto. O Claude informa a entrada da chamada
/// (`context_tokens`) e a janela no `result`; sem ela, vale a do modelo (200k, ou 1M com `[1m]`). O Codex precisa
/// do `modelContextWindow` do app-server: sem ele não se inventa a janela.
pub fn usage_of(item: &Item, agent_id: &str, model: Option<&str>) -> Option<Usage> {
    if item.kind != ItemKind::Usage {
        return None;
    }
    let used = item.context_tokens.filter(|n| *n > 0)?;
    let window = match agent_id {
        "claude-code" => item.context_window.filter(|w| *w > 0).unwrap_or_else(|| crate::canal::context::claude_window(model, used)),
        "codex" => item.context_window.filter(|w| *w > 0)?,
        _ => return None,
    };
    Some(Usage { used, window, at: item.at, id: item.id.clone() })
}

/// A janela de auto-compact que o Claude Code recebe para compactar em `pct`% da janela `model_window`: o ponto de
/// compactação dele é a janela menos a reserva. Limitada ao intervalo que o Claude Code aceita.
pub fn claude_window_setting(pct: u8, model_window: u64) -> u32 {
    let target = model_window * u64::from(pct) / 100 + CLAUDE_RESERVE_TOKENS;
    target.clamp(CLAUDE_MIN_WINDOW, CLAUDE_MAX_WINDOW) as u32
}

/// O Claude compacta sozinho? Não, se a flag `autoCompactEnabled` do `.claude.json` é `false` ou se o ambiente
/// traz `DISABLE_AUTO_COMPACT`/`DISABLE_COMPACT`. Só leitura; JSON ilegível conta como padrão (ligado).
pub fn claude_native_auto_on(claude_json: Option<&str>, env_disabled: bool) -> bool {
    if env_disabled {
        return false;
    }
    claude_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|v| v.get("autoCompactEnabled").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// A flag do Claude da conversa, lida do `.claude.json` do perfil (só leitura; nunca `~/.ags`).
fn claude_native_auto_for(db: &DbConnection, row: &store::ThreadRow) -> bool {
    let env = row.account_id.as_deref().and_then(|a| crate::accounts::env_for_account(db, a));
    let dir = env.as_ref().and_then(|e| e.get("CLAUDE_CONFIG_DIR")).map(std::path::PathBuf::from);
    let path = match dir {
        Some(dir) => dir.join(".claude.json"),
        None => dirs::home_dir().unwrap_or_default().join(".claude.json"),
    };
    let truthy = |name: &str| std::env::var(name).is_ok_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"));
    let env_disabled = truthy("DISABLE_AUTO_COMPACT") || truthy("DISABLE_COMPACT") || env.as_ref().is_some_and(|e| e.contains_key("DISABLE_AUTO_COMPACT"));
    claude_native_auto_on(std::fs::read_to_string(path).ok().as_deref(), env_disabled)
}

/// A janela de auto-compact que a ADE passa ao Claude Code da conversa quando a pessoa escolheu um limiar em % para
/// ele (e o autocompact está ligado). `None` = não mexer: o padrão do Claude (≈ o mesmo limiar padrão), ou os tokens que
/// a pessoa fixou em `chat.claude_auto_compact_windows`, que continuam valendo antes. Também `None` quando a janela do
/// modelo não é conhecida (sem `[1m]` no modelo e sem um `result` anterior com a janela): converter % em tokens com a
/// janela errada faria o Claude compactar cedo demais.
pub fn claude_launch_window(db: &DbConnection, row: &store::ThreadRow) -> Option<u32> {
    let cfg = config(db);
    if !cfg.enabled_for("claude-code") {
        return None;
    }
    let pct = cfg.explicit_pct("claude-code")?;
    let known = db
        .lock()
        .ok()
        .and_then(|conn| store::tail_items(&conn, &row.id, TAIL).ok())
        .and_then(|items| items.iter().rev().find_map(|i| i.context_window.filter(|w| *w > 0)));
    let model_window = known.or_else(|| row.model.as_deref().filter(|m| m.to_ascii_lowercase().contains("[1m]")).map(|_| crate::canal::context::CLAUDE_WINDOW_1M))?;
    Some(claude_window_setting(pct, model_window))
}

// ── decisão ──────────────────────────────────────────────────────────────

/// Tudo o que a decisão precisa saber, já lido. Pura.
#[derive(Clone, Debug)]
pub struct Gate {
    /// Global e do agente ligados.
    pub enabled: bool,
    pub mechanism: Mechanism,
    /// O agente compacta sozinho agora (só vale com `NativeAuto`).
    pub native_on: bool,
    pub threshold_pct: u8,
    pub usage: Option<Usage>,
    pub last_compaction_at: Option<i64>,
    pub working: bool,
    pub compacting: bool,
    pub pending_request: bool,
    /// A última ponta de contexto que a ADE já tentou compactar: (id do `usage`, tokens).
    pub last_attempt: Option<(String, u64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    Disabled,
    Unsupported,
    NativeHandles,
    Working,
    Compacting,
    PendingRequest,
    NoMeasure,
    StaleUsage,
    AlreadyAttempted,
    BelowThreshold,
}

/// Compacta agora? `Ok(())` sim; `Err(motivo)` não. Nunca no meio de um turno e nunca com o agente já compactando.
pub fn decide(g: &Gate) -> Result<(), Skip> {
    if !g.enabled {
        return Err(Skip::Disabled);
    }
    if g.mechanism == Mechanism::Unsupported {
        return Err(Skip::Unsupported);
    }
    if g.mechanism == Mechanism::NativeAuto && g.native_on {
        return Err(Skip::NativeHandles);
    }
    if g.working {
        return Err(Skip::Working);
    }
    if g.compacting {
        return Err(Skip::Compacting);
    }
    if g.pending_request {
        return Err(Skip::PendingRequest);
    }
    let usage = g.usage.as_ref().ok_or(Skip::NoMeasure)?;
    // Medida de antes da última compactação: ainda não há uso novo para julgar.
    if let (Some(compacted), Some(at)) = (g.last_compaction_at, usage.at)
        && at <= compacted
    {
        return Err(Skip::StaleUsage);
    }
    if g.last_attempt.as_ref().is_some_and(|(id, used)| *id == usage.id && *used == usage.used) {
        return Err(Skip::AlreadyAttempted);
    }
    if usage.used.saturating_mul(100) < usage.window.saturating_mul(u64::from(g.threshold_pct)) {
        return Err(Skip::BelowThreshold);
    }
    Ok(())
}

// ── eventos da compactação ───────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// O agente compactou sozinho.
    Auto,
    /// A pessoa pediu (`/compact`).
    Manual,
    /// A ADE pediu, pelo autocompact.
    Ade,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Auto => "auto",
            Trigger::Manual => "manual",
            Trigger::Ade => "ade",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Started { trigger: Option<Trigger>, before: Option<u64> },
    Finished { trigger: Option<Trigger>, before: Option<u64>, after: Option<u64>, ok: bool },
    /// A ADE pediu e o agente recusou ou o pedido falhou: fecha o aviso com o motivo.
    Failed { message: String },
    /// O turno acabou: fecha a compactação que ficou aberta.
    TurnEnded { ok: bool },
}

#[derive(Clone, Debug, PartialEq)]
struct Active {
    id: String,
    before: Option<u64>,
    trigger: Trigger,
    started: i64,
}

/// O estado de uma conversa: a compactação em curso.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    active: Option<Active>,
}

impl State {
    /// Há compactação em curso (e não expirou)?
    pub fn is_active(&self, now: i64) -> bool {
        self.active.as_ref().is_some_and(|a| now.saturating_sub(a.started) < ACTIVE_TTL_MS)
    }
}

/// O aviso da timeline: `Notice` `compaction`, com `text` = o gatilho, `context_tokens` = antes e `tokens` = depois.
fn notice(id: &str, status: ToolStatus, trigger: Trigger, before: Option<u64>, after: Option<u64>, at: i64) -> Item {
    Item {
        label: Some("compaction".into()),
        text: Some(trigger.as_str().into()),
        status: Some(status),
        context_tokens: before,
        tokens: after,
        ..Item::new(ItemKind::Notice, id.to_string(), Some(at))
    }
}

/// O reducer: o evento muda o estado e, se for o caso, devolve o aviso a gravar. `new_id` só é chamado quando um aviso
/// novo nasce. Pura.
pub fn reduce(state: &mut State, event: Event, now: i64, new_id: &mut dyn FnMut() -> String) -> Option<Item> {
    match event {
        Event::Started { trigger, before } => {
            // Já compactando (a ADE registrou o pedido e o agente anunciou o começo): o mesmo aviso, sem duplicar.
            if state.is_active(now) {
                return None;
            }
            let trigger = trigger.unwrap_or(Trigger::Auto);
            let id = new_id();
            let item = notice(&id, ToolStatus::Running, trigger, before, None, now);
            state.active = Some(Active { id, before, trigger, started: now });
            Some(item)
        }
        Event::Finished { trigger, before, after, ok } => {
            let status = if ok { ToolStatus::Done } else { ToolStatus::Error };
            Some(match state.active.take() {
                Some(active) => notice(&active.id, status, active.trigger, active.before.or(before), after, now),
                None => notice(&new_id(), status, trigger.unwrap_or(Trigger::Auto), before, after, now),
            })
        }
        Event::Failed { message } => {
            let (id, trigger, before) = match state.active.take() {
                Some(a) => (a.id, a.trigger, a.before),
                None => (new_id(), Trigger::Ade, None),
            };
            Some(Item { output: Some(message), ..notice(&id, ToolStatus::Error, trigger, before, None, now) })
        }
        Event::TurnEnded { ok } => {
            let active = state.active.take()?;
            let status = if ok { ToolStatus::Done } else { ToolStatus::Error };
            Some(notice(&active.id, status, active.trigger, active.before, None, now))
        }
    }
}

// ── cola: estado em memória, eventos e o gatilho do fim do turno ─────────

fn states() -> &'static Mutex<HashMap<String, State>> {
    static STATES: OnceLock<Mutex<HashMap<String, State>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

fn attempts() -> &'static Mutex<HashMap<String, (String, u64)>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, (String, u64)>>> = OnceLock::new();
    ATTEMPTS.get_or_init(Default::default)
}

/// A conversa está compactando agora? O envio direto é recusado (`Busy`) e a fila do composer segura a mensagem.
pub fn is_compacting(thread_id: &str) -> bool {
    states().lock().unwrap_or_else(|e| e.into_inner()).get(thread_id).is_some_and(|s| s.is_active(crate::util::now_ts_ms()))
}

/// O processo da conversa fechou: nada mais a esperar.
pub fn on_closed(thread_id: &str) {
    states().lock().unwrap_or_else(|e| e.into_inner()).remove(thread_id);
}

/// Aplica um evento da compactação: grava e mostra o aviso. Se a conversa não tem turno vivo, avisa quem espera (`ags
/// chat wait`, a fila entre agentes) de que ela voltou a ficar livre.
pub fn on_event(app: &AppHandle, db: &DbConnection, thread_id: &str, event: Event) {
    let closes = !matches!(event, Event::Started { .. });
    let now = crate::util::now_ts_ms();
    let item = {
        let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
        let state = map.entry(thread_id.to_string()).or_default();
        reduce(state, event, now, &mut || format!("n:compaction:{}", uuid::Uuid::new_v4()))
    };
    if let Some(item) = item {
        super::turn::save_items(app, db, thread_id, None, vec![item]);
        if closes && !super::api::status(thread_id).working {
            super::events::emit(app, thread_id, "phase", json!({ "phase": "idle" }));
        }
    }
}

/// A compactação que a ADE decidiu pedir, já registrada (o aviso «Compactando…» já está na timeline).
pub struct Planned {
    agent_id: String,
    /// O contexto medido (% da janela), só para o registro de falha.
    used_pct: Option<f64>,
}

/// O fim de um turno, ANTES de a conversa ficar ociosa para a tela: decide e, se vai compactar, registra a compactação
/// e grava o aviso «Compactando…» já. Assim a fila do composer, que solta a próxima mensagem quando o turno acaba, já
/// encontra a conversa compactando e espera: «espera o turno terminar, compacta, e só depois manda a próxima».
/// Síncrona e barata (uma leitura do banco). `None` = não compacta (o motivo é de `decide`).
pub fn plan(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Option<Planned> {
    let (row, usage) = match decide_for(db, thread_id) {
        Ok(Some(found)) => found,
        _ => return None,
    };
    attempts().lock().unwrap_or_else(|e| e.into_inner()).insert(thread_id.to_string(), (usage.id.clone(), usage.used));
    on_event(app, db, thread_id, Event::Started { trigger: Some(Trigger::Ade), before: Some(usage.used) });
    Some(Planned { used_pct: percent(usage.used, usage.window), agent_id: row.agent_id })
}

/// Pede ao agente a compactação nativa, em segundo plano. Se o pedido falha, o aviso fecha com o erro e a fila segue.
pub fn execute(app: &AppHandle, db: &DbConnection, thread_id: &str, planned: Planned) {
    let (app, db, thread_id) = (app.clone(), db.clone(), thread_id.to_string());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::api::compact_context_inner(&app, &db, &thread_id, None, true).await {
            eprintln!("[autocompact] {thread_id} ({}, {:.0}% do contexto): {error}", planned.agent_id, planned.used_pct.unwrap_or(0.0));
            on_event(&app, &db, &thread_id, Event::Failed { message: error });
        }
    });
}

/// Lê tudo e decide. `Ok(Some)` = compactar (com a conversa e a medida); `Ok(None)` = não, `Err` = falha de leitura.
fn decide_for(db: &DbConnection, thread_id: &str) -> Result<Option<(store::ThreadRow, Usage)>, String> {
    let row = super::api::thread(db, thread_id)?;
    if row.is_side_chat || row.state != "active" {
        return Ok(None);
    }
    let mechanism = chat_mechanism(&row.agent_id);
    if mechanism == Mechanism::Unsupported {
        return Ok(None);
    }
    let cfg = config(db);
    let (items, pending_request) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        (
            store::tail_items(&conn, thread_id, TAIL).map_err(|e| e.to_string())?,
            !store::pending_requests(&conn, thread_id).map_err(|e| e.to_string())?.is_empty(),
        )
    };
    let usage = items.iter().rev().find_map(|item| usage_of(item, &row.agent_id, row.model.as_deref()));
    let last_compaction_at = items
        .iter()
        .rev()
        .find(|i| i.kind == ItemKind::Notice && i.label.as_deref() == Some("compaction") && i.status != Some(ToolStatus::Running))
        .and_then(|i| i.at);
    let gate = Gate {
        enabled: cfg.enabled_for(&row.agent_id),
        mechanism,
        native_on: mechanism == Mechanism::NativeAuto && row.agent_id == "claude-code" && claude_native_auto_for(db, &row),
        threshold_pct: cfg.effective_pct(&row.agent_id),
        usage: usage.clone(),
        last_compaction_at,
        working: super::api::turn_open(thread_id),
        compacting: is_compacting(thread_id),
        pending_request,
        last_attempt: attempts().lock().unwrap_or_else(|e| e.into_inner()).get(thread_id).cloned(),
    };
    Ok(decide(&gate).ok().and_then(|()| usage).map(|usage| (row, usage)))
}
