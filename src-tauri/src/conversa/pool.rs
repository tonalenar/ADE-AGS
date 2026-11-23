//! Pool de contas no chat: quando a conta de uma conversa por protocolo esgota o limite, a conversa segue em
//! outra conta do MESMO pool (ver `docs/ade-ags/POOL_FAILOVER.md`). Desligado por padrão; só a pessoa liga.
//!
//! Este arquivo tem a parte PURA (a decisão, o horário de renovação, a volta, o resumo do handoff), com o tempo
//! injetado e sem I/O, e a parte que mexe no app (`after_turn`, `accept`) logo abaixo.

use serde::{Deserialize, Serialize};

use crate::canal::timeline::Item;
use crate::runs::failure::FailureKind;

/// Mais de uma troca por turno não existe: a conversa que esgota a segunda conta para e avisa.
pub const MAX_SWITCHES_PER_HOUR: usize = 3;
const HOUR_SECS: i64 = 3600;
/// A janela curta dos agentes (5 h): o palpite de renovação quando a mensagem não diz a hora.
pub const WINDOW_SECS: i64 = 5 * 3600;

/// O interruptor global. Padrão desligado.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Off,
    Ask,
    Auto,
}

impl Mode {
    pub fn parse(raw: &str) -> Mode {
        match raw.trim() {
            "ask" => Mode::Ask,
            "auto" => Mode::Auto,
            _ => Mode::Off,
        }
    }
}

/// O que a decisão enxerga. `next` já é o resultado de escolher a conta pelo pool (o ruteio existente).
pub struct Input<'a> {
    pub mode: Mode,
    pub kind: FailureKind,
    /// A conversa está ligada a um pool (a pessoa escolheu um). Sem pool não troca.
    pub bound_to_pool: bool,
    /// Este turno já veio de uma troca (a conta nova também esgotou): não encadeia.
    pub switched_this_turn: bool,
    /// Quando (s) foram as trocas desta conversa.
    pub history: &'a [i64],
    pub now: i64,
    pub next: Result<Option<String>, String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nada a fazer (desligado, outro tipo de erro, sem pool).
    Skip,
    /// Quis trocar e não pôde: o motivo vira aviso na timeline.
    Blocked(String),
    /// Pergunta antes. `to` = `None` é a conta principal do agente.
    Ask { to: Option<String> },
    Switch { to: Option<String> },
}

/// O pool que a conversa poderia usar: o primeiro do agente que tem a conta atual e pelo menos
/// outra conta ainda existente como membros (M-1: contas apagadas não contam).
pub fn offer_pool<'a>(
    pools: &'a [crate::accounts::pools::Pool],
    agent_id: &str,
    account: &Option<String>,
    existing_accounts: &std::collections::HashSet<String>,
) -> Option<&'a crate::accounts::pools::Pool> {
    let is_live = |m: &Option<String>| match m {
        None => true,
        Some(id) => existing_accounts.contains(id),
    };
    if !is_live(account) {
        return None;
    }
    pools.iter().find(|p| {
        if p.agent_id != agent_id {
            return false;
        }
        let live_count = p.members.iter().filter(|m| is_live(m)).count();
        live_count > 1 && p.members.contains(account)
    })
}

pub fn decide(input: Input) -> Decision {
    if input.mode == Mode::Off || input.kind != FailureKind::RateLimited || !input.bound_to_pool {
        return Decision::Skip;
    }
    if input.switched_this_turn {
        return Decision::Blocked("a conta nova também esgotou o limite; a conversa ficou parada".into());
    }
    if recent(input.history, input.now).len() >= MAX_SWITCHES_PER_HOUR {
        return Decision::Blocked(format!("a conversa já trocou de conta {MAX_SWITCHES_PER_HOUR} vezes na última hora"));
    }
    match input.next {
        Err(reason) => Decision::Blocked(reason),
        Ok(to) if input.mode == Mode::Auto => Decision::Switch { to },
        Ok(to) => Decision::Ask { to },
    }
}

/// O horário (epoch, s) em que a janela renova, lido do texto do erro via [`crate::runs::failure::parse_reset_at`]
/// (ISO-8601, relógio 12 h / 24 h após «resets» com fuso UTC/GMT/±HH:MM, ou duração relativa).
/// `offset_secs` é o fuso local (usado quando não há fuso ou quando há nome IANA sem tzdb no crate).
/// Sem hora legível, vale a janela de 5 h a partir de agora.
pub fn reset_at(text: &str, now: i64, offset_secs: i64) -> i64 {
    reset_at_known(text, now, offset_secs).unwrap_or(now + WINDOW_SECS)
}

/// Como [`reset_at`], mas só quando a mensagem diz a hora; sem hora legível, `None` (não adivinha a janela de 5 h).
pub fn reset_at_known(text: &str, now: i64, offset_secs: i64) -> Option<i64> {
    crate::runs::failure::parse_reset_at(text, now, offset_secs)
}

/// A conta original já pode voltar? Só com a hora de renovação conhecida e passada.
pub fn can_return(origin_resets_at: Option<i64>, now: i64) -> bool {
    origin_resets_at.is_some_and(|at| at <= now)
}

/// O registro de uma conversa que trocou de conta (em `settings`, migração aditiva).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Switched {
    /// A conta de onde saiu (`None` = a principal). Só a primeira troca grava: a volta é para ela.
    pub origin: Option<String>,
    pub origin_resets_at: Option<i64>,
    /// As trocas desta conversa (s).
    pub history: Vec<i64>,
    /// Verdadeiro enquanto o turno iniciado por uma troca ainda não concluiu nem houve nova
    /// mensagem explícita da pessoa (substitui a heurística de relógio `CHAIN_SECS` — M-4).
    #[serde(default)]
    pub switched_turn_pending: bool,
}

/// As trocas que ainda contam na última hora.
pub fn recent(history: &[i64], now: i64) -> Vec<i64> {
    history.iter().copied().filter(|at| now.saturating_sub(*at) < HOUR_SECS).collect()
}

/// O texto do handoff: reaproveita `conversa/handoff.rs` (prefixo `[ADE AGS]`, bloco `untrusted_data`,
/// redação de segredos e `END_MARK`) para a tela esconder o contexto e conciliar o balão otimista.
#[cfg(test)]
pub fn handoff_text(items: &[Item], pending: Option<&str>) -> String {
    handoff_text_for(items, "", "anterior", "nova conta", pending)
}

/// Como [`handoff_text`], com o id da conversa e os nomes das contas para situar o agente novo.
pub(super) fn handoff_text_for(
    items: &[Item],
    thread_id: &str,
    from_label: &str,
    to_label: &str,
    pending: Option<&str>,
) -> String {
    let summary = super::handoff::resumo_as(
        super::handoff::Frame::AccountSwitch,
        super::handoff::Input {
            items,
            thread_id,
            from_label,
            to_label,
            strategy: super::handoff::Strategy::Full,
            pending_request: None,
            budget_chars: super::handoff::DEFAULT_BUDGET,
        },
    );
    match pending.map(str::trim).filter(|r| !r.is_empty()) {
        Some(request) => format!("{summary}\n\n{request}"),
        None => summary,
    }
}

// ── A parte que mexe no app ───────────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use tauri::AppHandle;

use crate::database::DbConnection;

use super::{api, store, turn};

const MODE_KEY: &str = "chat.pool.mode";

/// Trava por conversa serializando `on_failure`, `accept`, `before_send` e `switch_manual` (A-2).
/// Sempre adquirida ANTES de `api::send_gate(thread_id)` para evitar inversão de ordem e deadlock.
pub(super) fn pool_gate(thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut map = GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    api::gate_in(&mut map, thread_id)
}

/// O que o pool fez no fim de um turno com erro de limite, para coordenar com `limite::after_turn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolTurnOutcome {
    /// O pool não resolveu nem perguntou troca: `limite::after_turn` pode agendar retomada ou oferecer reserva.
    Unhandled,
    /// O pool trocou de conta ou deixou uma pergunta de troca/adesão (ou outro turno já começou): `limite` não age.
    Handled,
}

/// Pura: `limite::after_turn` só roda depois do pool quando o pool não resolveu nem perguntou a troca.
pub fn should_run_limit_after_pool(outcome: PoolTurnOutcome) -> bool {
    outcome == PoolTurnOutcome::Unhandled
}

fn pool_key(thread: &str) -> String {
    format!("chat.pool.thread.{thread}")
}
fn switched_key(thread: &str) -> String {
    format!("chat.pool.switched.{thread}")
}
fn pending_key(thread: &str) -> String {
    format!("chat.pool.pending.{thread}")
}

/// O interruptor global. Sem valor (ou valor desconhecido) = desligado.
pub fn mode(db: &DbConnection) -> Mode {
    crate::database::get_setting(db, MODE_KEY).ok().flatten().map(|raw| Mode::parse(&raw)).unwrap_or_default()
}

/// Liga a conversa a um pool: só com isso a conversa troca de conta. `None` desliga.
pub fn bind(db: &DbConnection, thread: &str, pool_id: Option<&str>) -> Result<(), String> {
    crate::database::set_setting(db, &pool_key(thread), pool_id.unwrap_or(""))
}

pub(super) fn bound(db: &DbConnection, thread: &str) -> Option<String> {
    crate::database::get_setting(db, &pool_key(thread)).ok().flatten().filter(|id| !id.is_empty())
}

fn load<T: for<'de> Deserialize<'de>>(db: &DbConnection, key: &str) -> Option<T> {
    crate::database::get_setting(db, key).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok())
}

fn save<T: Serialize>(db: &DbConnection, key: &str, value: Option<&T>) {
    let raw = value.and_then(|v| serde_json::to_string(v).ok()).unwrap_or_default();
    let _ = crate::database::set_setting(db, key, &raw);
}

/// O que espera a resposta da pessoa («avisar e perguntar»).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// `switch` (a conta esgotou) ou `return` (a original renovou).
    pub kind: String,
    pub to: Option<String>,
    pub to_label: String,
    /// O pedido que ficou sem resposta (só em `switch`).
    pub request: Option<String>,
    /// Só em `join`: o pool a que a conversa passa a pertencer se a pessoa aceitar.
    #[serde(default)]
    pub pool_id: Option<String>,
    /// Só em `fallback`: o agente e o modelo reserva do projeto que a conversa passa a usar se a pessoa aceitar.
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Hora real de renovação (epoch s) extraída do erro, preservada até a pessoa aceitar (M-3).
    #[serde(default)]
    pub resets_at: Option<i64>,
}

/// O que o cartão «Limites de uso» mostra: o pool a que a conversa está ligada e a conta de origem se já trocou.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub pool_name: Option<String>,
    pub origin_label: Option<String>,
}

pub fn state(db: &DbConnection, thread: &str) -> State {
    let pool_name = bound(db, thread).and_then(|id| crate::accounts::pools::load(db).into_iter().find(|p| p.id == id).map(|p| p.name));
    let origin_label = load::<Switched>(db, &switched_key(thread)).map(|s| account_label(db, s.origin.as_deref()));
    State { pool_name, origin_label }
}

pub fn pending(db: &DbConnection, thread: &str) -> Option<Pending> {
    load(db, &pending_key(thread))
}

/// Guarda a pergunta que espera a pessoa (usada também pelo modelo reserva, `limite`).
pub(super) fn set_pending(db: &DbConnection, thread: &str, pending: &Pending) {
    save(db, &pending_key(thread), Some(pending));
}

pub(super) fn account_label(db: &DbConnection, id: Option<&str>) -> String {
    let Some(id) = id else { return "principal".into() };
    db.lock()
        .ok()
        .and_then(|conn| conn.query_row("SELECT name FROM agent_accounts WHERE id = ?1", [id], |r| r.get::<_, String>(0)).ok())
        .unwrap_or_else(|| id.to_string())
}

pub(super) fn local_offset() -> i64 {
    use chrono::Offset;
    chrono::Local::now().offset().fix().local_minus_utc() as i64
}

fn emit_account_changed(app: Option<&AppHandle>, thread_id: &str, to: &Option<String>) {
    if let Some(app) = app {
        super::events::emit(app, thread_id, "thread", serde_json::json!({ "accountId": to }));
    }
}

fn existing_account_ids(db: &DbConnection, agent_id: &str) -> std::collections::HashSet<String> {
    db.lock()
        .ok()
        .and_then(|conn| {
            let mut stmt = conn
                .prepare("SELECT id FROM agent_accounts WHERE agent_id = ?1")
                .ok()?;
            let ids = stmt
                .query_map([agent_id], |r| r.get::<_, String>(0))
                .ok()?
                .filter_map(Result::ok)
                .collect();
            Some(ids)
        })
        .unwrap_or_default()
}

/// Escolhe a próxima conta do pool, reaproveitando o ruteio da frota (login, limite, orçamento, cooldown). A
/// conta atual vai para o cooldown ANTES, para nunca ser a escolhida. Só avança o cursor de `round_robin`
/// quando a escolha dá certo (M-6).
fn pick_next(db: &DbConnection, agent_id: &str, pool_id: &str, current: &Option<String>, now: i64) -> Result<Option<String>, String> {
    crate::runs::pool_failover::cool_down_account(&crate::runs::quota::account_key(agent_id, current.as_deref()), now);
    let roster = crate::runs::roster::snapshot(db, false)?;
    let agent = roster.agent(agent_id).ok_or("agente fora do roster")?;
    crate::accounts::pools::with_pool_pick(db, pool_id, |spec| {
        if spec.agent_id != agent_id {
            return Err("o pool é de outro agente".into());
        }
        let (to, _) = crate::runs::routing::pick_in_pool(agent, spec, now)?;
        if &to == current {
            return Err("não restou outra conta do pool com limite livre".into());
        }
        if let Some(id) = to.as_deref() {
            crate::accounts::ensure_supported_outside_pty(db, id)?;
        }
        Ok(to)
    })
}

/// Limpa a flag de turno encadeado (`switched_turn_pending`) após um turno terminar sem erro de
/// limite ou após uma nova mensagem explícita da pessoa (M-4).
pub(super) fn clear_switched_turn_pending(db: &DbConnection, thread_id: &str) {
    if let Some(mut switched) = load::<Switched>(db, &switched_key(thread_id)) {
        if switched.switched_turn_pending {
            switched.switched_turn_pending = false;
            save(db, &switched_key(thread_id), Some(&switched));
        }
    }
}

/// Anota a conta como esgotada até a hora de renovação (o ruteio da frota e o cartão passam a vê-la assim).
pub(super) fn mark_exhausted(db: &DbConnection, key: &str, resets_at: i64, now: i64) {
    let mut quota = db.lock().ok().and_then(|conn| crate::runs::quota::load(&conn, key)).unwrap_or_default();
    quota.rejected = true;
    quota.rejected_until = Some(resets_at);
    crate::runs::quota::record(db, key, quota, now);
}

/// Chamado no fim de cada turno (`turn::after_turn_hooks`), depois de emitir `phase: "idle"`.
/// Coordena `pool` e `limite` sequencialmente sob `pool_gate(thread_id)` para evitar corrida entre
/// failover de pool, `ResumePlan` e `offer_fallback` (A-2). Turnos sem erro de limite limpam
/// `switched_turn_pending` (M-4) e retornam na hora.
pub fn after_turn_with_limit(app: &AppHandle, db: &DbConnection, thread_id: &str, result: &super::claude_map::TurnResult) {
    let Some(error) = result.error.clone().filter(|_| !result.interrupted) else {
        clear_switched_turn_pending(db, thread_id);
        return;
    };
    if crate::runs::failure::classify(&error) != FailureKind::RateLimited {
        clear_switched_turn_pending(db, thread_id);
        return;
    }
    let result = super::claude_map::TurnResult {
        interrupted: result.interrupted,
        error: result.error.clone(),
        duration_ms: result.duration_ms,
    };
    let (app, db, thread_id) = (app.clone(), db.clone(), thread_id.to_string());
    tauri::async_runtime::spawn(async move {
        let gate = pool_gate(&thread_id);
        let _held = gate.lock().await;
        let outcome = handle_rate_limit(&app, &db, &thread_id, &error).await;
        if should_run_limit_after_pool(outcome) {
            super::limite::after_turn(&app, &db, &thread_id, &result);
        }
    });
}

async fn handle_rate_limit(app: &AppHandle, db: &DbConnection, thread_id: &str, error: &str) -> PoolTurnOutcome {
    // Se outro turno já abriu enquanto esperávamos a trava, não trocamos nem disparamos limite.
    if api::status(thread_id).working {
        return PoolTurnOutcome::Handled;
    }
    if mode(db) == Mode::Off {
        return PoolTurnOutcome::Unhandled;
    }
    if bound(db, thread_id).is_none() {
        return offer_join(app, db, thread_id, error);
    }
    on_failure(app, db, thread_id, error).await
}

pub(super) fn last_request(db: &DbConnection, thread_id: &str) -> Option<String> {
    api::items(db, thread_id).ok().and_then(|items| {
        items
            .iter()
            .rev()
            .filter(|i| i.kind == crate::canal::timeline::ItemKind::User)
            .find_map(|i| i.text.as_deref().and_then(super::handoff::raw_person_text))
    })
}

/// A conversa bateu no limite sem estar num pool. Não troca sozinha (a regra é pool escolhido pela pessoa), mas
/// se a conta dela é de um pool, pergunta se a conversa passa a usá-lo e segue em outra conta.
fn offer_join(app: &AppHandle, db: &DbConnection, thread_id: &str, error: &str) -> PoolTurnOutcome {
    let now = crate::util::now_ts();
    if crate::runs::failure::classify(error) != FailureKind::RateLimited || pending(db, thread_id).is_some() {
        return PoolTurnOutcome::Unhandled;
    }
    let Ok(row) = api::thread(db, thread_id) else { return PoolTurnOutcome::Unhandled };
    let resets_at = reset_at(error, now, local_offset());
    mark_exhausted(db, &crate::runs::quota::account_key(&row.agent_id, row.account_id.as_deref()), resets_at, now);
    let pools = crate::accounts::pools::load(db);
    let existing = existing_account_ids(db, &row.agent_id);
    let Some(pool) = offer_pool(&pools, &row.agent_id, &row.account_id, &existing) else { return PoolTurnOutcome::Unhandled };
    let from = account_label(db, row.account_id.as_deref());
    save(db, &pending_key(thread_id), Some(&Pending {
        kind: "join".into(),
        to: None,
        to_label: pool.name.clone(),
        request: last_request(db, thread_id),
        pool_id: Some(pool.id.clone()),
        agent_id: None,
        model: None,
        resets_at: Some(resets_at),
    }));
    turn::save_notice(app, db, thread_id, "poolOffer", &notice_pool_offer(&from, &pool.name));
    PoolTurnOutcome::Handled
}

pub(super) fn notice_pool_offer(from: &str, pool_name: &str) -> String {
    serde_json::json!({ "from": from, "pool": pool_name }).to_string()
}

pub(super) fn notice_pool_blocked(from: &str, reason: &str, reason_code: Option<&str>) -> String {
    let mut obj = serde_json::json!({ "from": from, "reason": reason });
    if let Some(code) = reason_code {
        obj["reasonCode"] = serde_json::json!(code);
        if code == "hourlyLimit" {
            obj["max"] = serde_json::json!(MAX_SWITCHES_PER_HOUR);
        }
    }
    obj.to_string()
}

pub(super) fn notice_pool_failed(reason: &str) -> String {
    serde_json::json!({ "kind": "failed", "reason": reason }).to_string()
}

pub(super) fn notice_pool_ask(from: &str, to: &str, resets_at: &str) -> String {
    serde_json::json!({ "from": from, "to": to, "resetsAt": resets_at }).to_string()
}

pub(super) fn notice_pool_switch(from: &str, to: &str, resets_at: &str) -> String {
    serde_json::json!({ "from": from, "to": to, "resetsAt": resets_at }).to_string()
}

pub(super) fn notice_pool_return(to: &str) -> String {
    serde_json::json!({ "to": to }).to_string()
}

pub(super) fn notice_account_switch(to: &str) -> String {
    serde_json::json!({ "to": to }).to_string()
}

async fn on_failure(app: &AppHandle, db: &DbConnection, thread_id: &str, error: &str) -> PoolTurnOutcome {
    let now = crate::util::now_ts();
    let kind = crate::runs::failure::classify(error);
    let (Some(pool_id), Ok(row)) = (bound(db, thread_id), api::thread(db, thread_id)) else {
        return PoolTurnOutcome::Unhandled;
    };
    let switched: Switched = load(db, &switched_key(thread_id)).unwrap_or_default();
    let resets_at = reset_at(error, now, local_offset());
    if kind == FailureKind::RateLimited {
        mark_exhausted(db, &crate::runs::quota::account_key(&row.agent_id, row.account_id.as_deref()), resets_at, now);
    }
    let chained = switched.switched_turn_pending;
    let hourly_exceeded = recent(&switched.history, now).len() >= MAX_SWITCHES_PER_HOUR;
    let decision = decide(Input {
        mode: mode(db),
        kind,
        bound_to_pool: true,
        switched_this_turn: chained,
        history: &switched.history,
        now,
        next: if kind == FailureKind::RateLimited && !chained && !hourly_exceeded {
            pick_next(db, &row.agent_id, &pool_id, &row.account_id, now)
        } else {
            Ok(None)
        },
    });
    let request = last_request(db, thread_id);
    let from = account_label(db, row.account_id.as_deref());
    match decision {
        Decision::Skip => PoolTurnOutcome::Unhandled,
        Decision::Blocked(why) => {
            let reason_code = if chained {
                Some("chained")
            } else if hourly_exceeded {
                Some("hourlyLimit")
            } else {
                None
            };
            turn::save_notice(app, db, thread_id, "poolBlocked", &notice_pool_blocked(&from, &why, reason_code));
            PoolTurnOutcome::Unhandled
        }
        Decision::Ask { to } => {
            let to_label = account_label(db, to.as_deref());
            save(db, &pending_key(thread_id), Some(&Pending {
                kind: "switch".into(),
                to,
                to_label: to_label.clone(),
                request,
                pool_id: None,
                agent_id: None,
                model: None,
                resets_at: Some(resets_at),
            }));
            turn::save_notice(app, db, thread_id, "poolAsk", &notice_pool_ask(&from, &to_label, &clock(resets_at)));
            PoolTurnOutcome::Handled
        }
        Decision::Switch { to } => {
            if let Err(e) = switch_to(app, db, thread_id, &pool_id, to, request, resets_at, now).await {
                turn::save_notice(app, db, thread_id, "poolBlocked", &notice_pool_failed(&e));
                PoolTurnOutcome::Unhandled
            } else {
                PoolTurnOutcome::Handled
            }
        }
    }
}

pub(super) fn clock(epoch: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_opt(epoch, 0).single().map(|t| t.format("%H:%M").to_string()).unwrap_or_default()
}

/// A troca: fecha o processo parado da conversa, passa a conta (e esquece a sessão, que mora no perfil da conta
/// antiga), envia o handoff e só limpa `pending`/`handoff_key` depois de o envio retornar `Ok`.
/// Deve ser chamada com `pool_gate(thread_id)` já adquirido.
#[allow(clippy::too_many_arguments)]
async fn switch_to(app: &AppHandle, db: &DbConnection, thread_id: &str, _pool_id: &str, to: Option<String>, request: Option<String>, resets_at: i64, now: i64) -> Result<(), String> {
    let row = api::thread(db, thread_id)?;
    let items = api::items(db, thread_id).unwrap_or_default();
    let (from, to_label) = (account_label(db, row.account_id.as_deref()), account_label(db, to.as_deref()));
    let handoff = handoff_text_for(&items, thread_id, &from, &to_label, request.as_deref());
    move_account_inner(Some(app), db, thread_id, &row.account_id, &to, resets_at, now)?;
    api::send_without_pool_before_send(app, db, thread_id, &handoff).await?;
    commit_switch_sent(db, thread_id);
    turn::save_notice(app, db, thread_id, "poolSwitch", &notice_pool_switch(&from, &to_label, &clock(resets_at)));
    Ok(())
}

/// A parte de banco da troca: sem janela, para testar.
/// Preserva `pending` e grava `handoff_key` até que o envio da mensagem de handoff confirme `Ok` (`commit_switch_sent`).
#[cfg(test)]
pub(super) fn move_account(db: &DbConnection, thread_id: &str, from: &Option<String>, to: &Option<String>, resets_at: i64, now: i64) -> Result<(), String> {
    move_account_inner(None, db, thread_id, from, to, resets_at, now)
}

fn move_account_inner(app: Option<&AppHandle>, db: &DbConnection, thread_id: &str, from: &Option<String>, to: &Option<String>, resets_at: i64, now: i64) -> Result<(), String> {
    api::close_process(thread_id);
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::set_account(&conn, thread_id, to.as_deref()).map_err(|e| e.to_string())?;
        store::clear_remote_id(&conn, thread_id).map_err(|e| e.to_string())?;
    }
    emit_account_changed(app, thread_id, to);
    let mut switched: Switched = load(db, &switched_key(thread_id)).unwrap_or_default();
    if switched.origin.is_none() && switched.origin_resets_at.is_none() {
        switched.origin = from.clone();
        switched.origin_resets_at = Some(resets_at);
    }
    switched.history = recent(&switched.history, now);
    switched.history.push(now);
    switched.switched_turn_pending = true;
    save(db, &switched_key(thread_id), Some(&switched));
    save(db, &handoff_key(thread_id), Some(&now));
    Ok(())
}

/// Confirma que o envio pós-troca deu `Ok`: limpa o aviso pendente e o marcador de resumo pendente.
pub(super) fn commit_switch_sent(db: &DbConnection, thread_id: &str) {
    save::<Pending>(db, &pending_key(thread_id), None);
    save::<i64>(db, &handoff_key(thread_id), None);
}

/// Pura: valida se `accept` pode rodar agora (nunca no meio de um turno em andamento).
pub fn check_accept(working: bool, pending: Option<Pending>) -> Result<Pending, String> {
    if working {
        return Err("Espere o turno terminar para trocar de conta.".into());
    }
    pending.ok_or_else(|| "Não há nada esperando resposta nesta conversa.".into())
}

/// Parte de banco de `accept` para `"return"` (M-3): volta à conta original, emite `"thread"` com
/// `accountId`, limpa só `pending_key` e mantém `handoff_key` gravado para o resumo seguir com a
/// próxima mensagem da pessoa (em vez de gastar um turno pago só com contexto).
pub(super) fn accept_return_db(app: Option<&AppHandle>, db: &DbConnection, thread_id: &str, now: i64) -> Result<(), String> {
    let _ = return_to_origin_inner(app, db, thread_id, now)?;
    dismiss(db, thread_id);
    Ok(())
}

/// A pessoa aceitou o que foi perguntado («Continuar na conta B» ou «Voltar à conta A»).
pub async fn accept(app: &AppHandle, db: &DbConnection, thread_id: &str) -> Result<(), String> {
    let gate = pool_gate(thread_id);
    let _held = gate.lock().await;
    let pending = check_accept(api::status(thread_id).working, pending(db, thread_id))?;
    let now = crate::util::now_ts();
    let resets_at = pending.resets_at.unwrap_or(now + WINDOW_SECS);
    if pending.kind == "fallback" {
        return super::limite::accept_fallback(app, db, thread_id, pending).await;
    }
    if pending.kind == "join" {
        let pool_id = pending.pool_id.clone().ok_or("O aviso não guardou o pool.")?;
        let row = api::thread(db, thread_id)?;
        let to = pick_next(db, &row.agent_id, &pool_id, &row.account_id, now)?;
        bind(db, thread_id, Some(&pool_id))?;
        return switch_to(app, db, thread_id, &pool_id, to, pending.request, resets_at, now).await;
    }
    if pending.kind == "return" {
        accept_return_db(Some(app), db, thread_id, now)?;
        turn::save_notice(app, db, thread_id, "poolReturn", &notice_pool_return(&pending.to_label));
        return Ok(());
    }
    let pool_id = bound(db, thread_id).ok_or("A conversa não está ligada a um pool.")?;
    let row = api::thread(db, thread_id)?;
    // A escolha pode ter envelhecido desde a pergunta: escolhe de novo, e só segue se ainda houver conta.
    let to = pick_next(db, &row.agent_id, &pool_id, &row.account_id, now)?;
    switch_to(app, db, thread_id, &pool_id, to, pending.request, resets_at, now).await
}

pub fn dismiss(db: &DbConnection, thread_id: &str) {
    save::<Pending>(db, &pending_key(thread_id), None);
}

/// Volta à conta de origem; devolve o contexto para abrir a próxima mensagem.
/// Grava `handoff_key` e preserva `pending` até que o envio confirme `Ok` (`commit_switch_sent` / `commit_before_send`).
fn return_to_origin_inner(app: Option<&AppHandle>, db: &DbConnection, thread_id: &str, now: i64) -> Result<String, String> {
    let switched: Switched = load(db, &switched_key(thread_id)).ok_or("A conversa não trocou de conta.")?;
    if let Some(id) = switched.origin.as_deref() {
        crate::accounts::ensure_supported_outside_pty(db, id)?;
    }
    let row = api::thread(db, thread_id)?;
    let items = api::items(db, thread_id).unwrap_or_default();
    let (from, to_label) = (account_label(db, row.account_id.as_deref()), account_label(db, switched.origin.as_deref()));
    let context = handoff_text_for(&items, thread_id, &from, &to_label, None);
    api::close_process(thread_id);
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::set_account(&conn, thread_id, switched.origin.as_deref()).map_err(|e| e.to_string())?;
        store::clear_remote_id(&conn, thread_id).map_err(|e| e.to_string())?;
    }
    emit_account_changed(app, thread_id, &switched.origin);
    save::<Switched>(db, &switched_key(thread_id), None);
    save(db, &handoff_key(thread_id), Some(&now));
    Ok(context)
}

/// O que [`before_send`] preparou para o envio: o texto final e quais chaves só podem ser limpas após `Ok`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PreparedSend {
    pub text: String,
    pub clear_manual_handoff: bool,
    pub clear_pending: bool,
}

impl PreparedSend {
    fn unchanged(text: &str) -> Self {
        Self { text: text.to_string(), clear_manual_handoff: false, clear_pending: false }
    }
}

/// A parte de banco de [`before_send`], sem janela, para testar.
/// Confere `working` sob `pool_gate` e nunca limpa `handoff_key`/`pending` antes de o envio dar `Ok`.
#[cfg(test)]
pub(super) fn prepare_before_send_db(
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    working: bool,
    now: i64,
) -> (PreparedSend, Option<(&'static str, String)>) {
    prepare_before_send_inner(None, db, thread_id, text, working, now)
}

fn prepare_before_send_inner(
    app: Option<&AppHandle>,
    db: &DbConnection,
    thread_id: &str,
    text: &str,
    working: bool,
    now: i64,
) -> (PreparedSend, Option<(&'static str, String)>) {
    if working {
        return (PreparedSend::unchanged(text), None);
    }
    let (manual_text, clear_manual_handoff) = prepare_manual_handoff(db, thread_id, text);
    let mode = mode(db);
    let Some(switched) = load::<Switched>(db, &switched_key(thread_id)).filter(|s| can_return(s.origin_resets_at, now)) else {
        return (PreparedSend { text: manual_text, clear_manual_handoff, clear_pending: false }, None);
    };
    if mode == Mode::Off || bound(db, thread_id).is_none() || pending(db, thread_id).is_some() {
        return (PreparedSend { text: manual_text, clear_manual_handoff, clear_pending: false }, None);
    }
    let label = account_label(db, switched.origin.as_deref());
    if mode == Mode::Ask {
        save(db, &pending_key(thread_id), Some(&Pending {
            kind: "return".into(),
            to: switched.origin,
            to_label: label.clone(),
            request: None,
            pool_id: None,
            agent_id: None,
            model: None,
            resets_at: None,
        }));
        return (
            PreparedSend { text: manual_text, clear_manual_handoff, clear_pending: false },
            Some(("poolReturnAsk", notice_pool_return(&label))),
        );
    }
    match return_to_origin_inner(app, db, thread_id, now) {
        Ok(context) => (
            PreparedSend {
                text: format!("{context}\n\n{manual_text}"),
                clear_manual_handoff: true,
                clear_pending: true,
            },
            Some(("poolReturn", notice_pool_return(&label))),
        ),
        Err(_) => (PreparedSend { text: manual_text, clear_manual_handoff, clear_pending: false }, None),
    }
}

/// Antes de enviar uma mensagem da pessoa (com `pool_gate` já adquirido): confere se há turno em andamento,
/// aplica o resumo de troca manual se pendente e, se a conta original renovou, volta (`Mode::Auto`) ou pergunta (`Mode::Ask`).
/// Só limpa `handoff_key`/`pending` quando [`commit_before_send`] for chamado após o envio dar `Ok`.
pub(super) fn before_send(app: &AppHandle, db: &DbConnection, thread_id: &str, text: &str) -> PreparedSend {
    let working = api::status(thread_id).working;
    let (prepared, notice) = prepare_before_send_inner(Some(app), db, thread_id, text, working, crate::util::now_ts());
    if let Some((code, body)) = notice {
        turn::save_notice(app, db, thread_id, code, &body);
    }
    prepared
}

/// Confirma que o envio preparado por [`before_send`] deu `Ok`: limpa os marcadores pendentes e
/// desmarca `switched_turn_pending` (a pessoa iniciou um novo envio explícito — M-4).
pub(super) fn commit_before_send(db: &DbConnection, thread_id: &str, prepared: &PreparedSend) {
    if prepared.clear_manual_handoff {
        save::<i64>(db, &handoff_key(thread_id), None);
    }
    if prepared.clear_pending {
        save::<Pending>(db, &pending_key(thread_id), None);
    }
    clear_switched_turn_pending(db, thread_id);
}

/// `pool:<nome>` ao criar a conversa: a conta que o pool escolhe agora e o id do pool. Erro claro se o pool não
/// existe ou não tem conta usável (a conversa não nasce presa a uma conta sem limite). Só avança o cursor de
/// `round_robin` se a escolha suceder (M-6).
pub fn resolve_at_create(db: &DbConnection, agent_id: &str, pool_name: &str) -> Result<(Option<String>, String), String> {
    let roster = crate::runs::roster::snapshot(db, false)?;
    let agent = roster.agent(agent_id).ok_or_else(|| format!("'{agent_id}' fora do roster"))?;
    crate::accounts::pools::with_pool_pick(db, pool_name, |spec| {
        let (account, _) = crate::runs::routing::pick_in_pool(agent, spec, crate::util::now_ts())
            .map_err(|e| format!("Pool '{pool_name}': {e}"))?;
        if let Some(id) = account.as_deref() {
            crate::accounts::ensure_supported_outside_pty(db, id)?;
        }
        Ok((account, spec.id.clone()))
    })
}

// ── Troca manual de conta (a pessoa escolhe, em qualquer conversa) ──────────────────────────────────────────

fn handoff_key(thread: &str) -> String {
    format!("chat.account.handoff.{thread}")
}

/// Pura: a troca manual é permitida? Só entre turnos, sem pedido do agente esperando resposta e para uma conta
/// que é do agente da conversa (`None` = a principal, sempre do agente).
pub fn check_manual_switch(working: bool, pending_requests: usize, current: &Option<String>, target: &Option<String>, target_agent: Option<&str>, agent_id: &str) -> Result<(), String> {
    if working {
        return Err("Espere o turno terminar para trocar de conta.".into());
    }
    if pending_requests > 0 {
        return Err("Responda ao pedido do agente antes de trocar de conta.".into());
    }
    if current == target {
        return Err("A conversa já usa esta conta.".into());
    }
    if target.is_some() && target_agent != Some(agent_id) {
        return Err("Esta conta não é do agente da conversa.".into());
    }
    Ok(())
}

/// A parte de banco da troca manual: valida, passa a conta, esquece a sessão e deixa o resumo para a próxima
/// mensagem. Devolve (conta anterior, conta nova). Não conta no teto do pool nem ativa a volta à original.
#[cfg(test)]
pub(super) fn set_account_manual(db: &DbConnection, thread_id: &str, to: &Option<String>, working: bool, now: i64) -> Result<(Option<String>, Option<String>), String> {
    set_account_manual_inner(None, db, thread_id, to, working, now)
}

fn set_account_manual_inner(app: Option<&AppHandle>, db: &DbConnection, thread_id: &str, to: &Option<String>, working: bool, now: i64) -> Result<(Option<String>, Option<String>), String> {
    let row = api::thread(db, thread_id)?;
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let pending = store::pending_requests(&conn, thread_id).map_err(|e| e.to_string())?.len();
        let target_agent: Option<String> = to.as_deref().and_then(|id| conn.query_row("SELECT agent_id FROM agent_accounts WHERE id = ?1", [id], |r| r.get(0)).ok());
        check_manual_switch(working, pending, &row.account_id, to, target_agent.as_deref(), &row.agent_id)?;
    }
    if let Some(id) = to.as_deref() {
        crate::accounts::ensure_supported_outside_pty(db, id)?;
    }
    api::close_process(thread_id);
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::set_account(&conn, thread_id, to.as_deref()).map_err(|e| e.to_string())?;
        store::clear_remote_id(&conn, thread_id).map_err(|e| e.to_string())?;
    }
    emit_account_changed(app, thread_id, to);
    // A escolha da pessoa manda: o pool deixa de querer «voltar à original» e a pergunta pendente perde o sentido.
    save::<Switched>(db, &switched_key(thread_id), None);
    save::<Pending>(db, &pending_key(thread_id), None);
    save(db, &handoff_key(thread_id), Some(&now));
    Ok((row.account_id, to.clone()))
}

/// Prepara o resumo pendente da troca manual sem limpar `handoff_key`: quem chama limpa via [`commit_before_send`]
/// somente depois que o envio confirmar `Ok`.
pub(super) fn prepare_manual_handoff(db: &DbConnection, thread_id: &str, text: &str) -> (String, bool) {
    if load::<i64>(db, &handoff_key(thread_id)).is_none() {
        return (text.to_string(), false);
    }
    let items = api::items(db, thread_id).unwrap_or_default();
    if items.is_empty() {
        return (text.to_string(), true);
    }
    let to_label = api::thread(db, thread_id)
        .ok()
        .map(|row| account_label(db, row.account_id.as_deref()))
        .unwrap_or_else(|| "nova conta".into());
    (format!("{}\n\n{text}", handoff_text_for(&items, thread_id, "anterior", &to_label, None)), true)
}

/// A pessoa escolheu a conta da conversa (comando `chat_account_set`): troca entre turnos, serializada em `pool_gate`,
/// e avisa na timeline.
pub async fn switch_manual(app: &AppHandle, db: &DbConnection, thread_id: &str, to: Option<String>) -> Result<(), String> {
    let gate = pool_gate(thread_id);
    let _held = gate.lock().await;
    let working = api::status(thread_id).working;
    let (_, to) = set_account_manual_inner(Some(app), db, thread_id, &to, working, crate::util::now_ts())?;
    turn::save_notice(app, db, thread_id, "accountSwitch", &notice_account_switch(&account_label(db, to.as_deref())));
    Ok(())
}
