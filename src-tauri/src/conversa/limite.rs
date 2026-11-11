//! O limite de uso no chat, tudo local (nenhuma chamada de rede): o sinal de «esta conta está sem limite», o
//! modelo reserva do projeto e «retomar depois do limite».
//!
//! - **Sinal**: o mesmo que a frota e o pool de contas gravam (`runs::quota`). Aqui só se lê ([`limited_until`]) e,
//!   quando um turno de chat para por limite com a hora de renovação dita pelo agente, se grava (o agente disse
//!   quando volta; um 429 sem hora pode ser passageiro e não marca a conta).
//! - **Modelo reserva**: um turno que para por limite, numa conversa de projeto com reserva configurado
//!   (`project_chat_defaults`), pergunta «continuar com o reserva?». Aceitar troca o modelo (mesmo agente) ou o agente
//!   (`troca`) e reenvia o pedido que ficou sem resposta. Nunca troca sozinho: gasta o limite de outro provedor.
//! - **Retomar depois do limite**: preferência desligada por padrão. Ligada, o turno que parou por limite com a hora
//!   de renovação conhecida agenda uma mensagem de continuação para essa hora (mais uma margem). Quem dispara é o
//!   tick do agendador (`tick`), então sobrevive a reiniciar o app; o que venceu com o app fechado sai ao reabrir,
//!   depois de a pessoa retomar a automação (`missions::automation`). Parar, enviar, concluir ou apagar a conversa
//!   cancela. A decisão é pura (tempo injetado); o relógio de verdade só entra no tick.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::database::DbConnection;
use crate::project_chat_defaults::{ModelChoice, ProjectChatDefaults};
use crate::runs::failure::{classify, FailureKind};

use super::claude_map::TurnResult;
use super::envio::SendMode;
use super::pool::{self, Pending};
use super::store::ThreadRow;
use super::{api, troca, turn};

/// A janela curta dos agentes: sem hora de renovação gravada, vale 5 h depois de observado.
const WINDOW_SECS: i64 = 5 * 3600;
/// Pouco depois da hora dita: a renovação do provedor não é no segundo exato.
pub const MARGIN_SECS: i64 = 60;
/// Passado isto da hora marcada sem conseguir retomar (conversa ocupada, esperando resposta), desiste.
pub const GIVE_UP_SECS: i64 = 6 * 3600;

const RESUME_PREF_KEY: &str = "chat.threads.resume-after-limit";
const PLAN_PREFIX: &str = "chat.limit-resume.";

/// O texto que a continuação manda ao agente.
const RESUME_TEXT: &str = "[Retomada automática depois do limite de uso] O limite renovou. Continue de onde parou.";

// ── O sinal de limite ───────────────────────────────────────────────────────────────────────────────────────

/// Até quando a conta do agente está sem limite (segundos), ou `None` se está livre. `account_id` `None` é a conta
/// principal do sistema. Só lê o que a frota, o pool e os turnos de chat já gravaram.
pub fn limited_until(conn: &rusqlite::Connection, agent_id: &str, account_id: Option<&str>, now: i64) -> Option<i64> {
    let quota = crate::runs::quota::load(conn, &crate::runs::quota::account_key(agent_id, account_id))?;
    if !quota.exhausted_at(now) {
        return None;
    }
    let full_window_reset = [&quota.five_hour, &quota.seven_day]
        .into_iter()
        .flatten()
        .filter(|window| window.utilization_at(now) >= 1.0)
        .filter_map(|window| window.resets_at)
        .max();
    Some(
        quota
            .rejected_until
            .filter(|until| *until > now)
            .or(full_window_reset)
            .unwrap_or(quota.observed_at + WINDOW_SECS),
    )
}

// ── Retomar depois do limite ────────────────────────────────────────────────────────────────────────────────

/// O que ficou agendado numa conversa.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlan {
    pub thread_id: String,
    /// Quando retomar (segundos, já com a margem).
    pub at: i64,
    /// Quando foi agendado (ms): o interruptor da automação compara com o boot do app.
    pub created_at_ms: i64,
}

/// Pura: quando retomar, ou `None`. Só agenda com a preferência ligada, com falha por limite e com a hora de
/// renovação dita pelo agente (sem hora, a retomada é manual).
pub fn plan_resume(enabled: bool, error: &str, now: i64, offset_secs: i64) -> Option<i64> {
    if !enabled || classify(error) != FailureKind::RateLimited {
        return None;
    }
    pool::reset_at_known(error, now, offset_secs).map(|at| at + MARGIN_SECS)
}

/// O que o tick faz com um plano vencido.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fire {
    /// A conversa sumiu, foi concluída ou o plano envelheceu demais: apaga o plano.
    Drop,
    /// A conversa está ocupada ou espera uma resposta: tenta no próximo tick.
    Wait,
    /// Envia a continuação.
    Send,
}

/// Pura: o que fazer com um plano. `thread` é `None` se a conversa não existe mais.
pub fn fire_decision(thread: Option<&ThreadRow>, working: bool, pending_requests: usize, plan: &ResumePlan, now: i64) -> Fire {
    let Some(thread) = thread else { return Fire::Drop };
    if thread.state != "active" || now - plan.at > GIVE_UP_SECS {
        return Fire::Drop;
    }
    if working || pending_requests > 0 {
        return Fire::Wait;
    }
    Fire::Send
}

fn plan_key(thread_id: &str) -> String {
    format!("{PLAN_PREFIX}{thread_id}")
}

/// A preferência «Retomar depois do limite de uso». Padrão: desligada.
pub fn resume_enabled(db: &DbConnection) -> bool {
    crate::database::get_setting(db, RESUME_PREF_KEY).ok().flatten().as_deref() == Some("on")
}

pub(crate) fn save_plan(conn: &rusqlite::Connection, plan: &ResumePlan) -> Result<(), String> {
    let raw = serde_json::to_string(plan).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![plan_key(&plan.thread_id), raw],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn load_plan(conn: &rusqlite::Connection, thread_id: &str) -> Option<ResumePlan> {
    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [plan_key(thread_id)], |row| row.get(0))
        .ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn all_plans(conn: &rusqlite::Connection) -> Vec<ResumePlan> {
    let Ok(mut stmt) = conn.prepare("SELECT value FROM settings WHERE key LIKE ?1 LIMIT 500") else { return Vec::new() };
    let Ok(rows) = stmt.query_map([format!("{PLAN_PREFIX}%")], |row| row.get::<_, String>(0)) else { return Vec::new() };
    rows.filter_map(Result::ok).filter_map(|raw| serde_json::from_str(&raw).ok()).collect()
}

pub(crate) fn drop_plan(conn: &rusqlite::Connection, thread_id: &str) -> bool {
    conn.execute("DELETE FROM settings WHERE key = ?1", [plan_key(thread_id)]).is_ok_and(|rows| rows > 0)
}

/// Cancela a retomada agendada de uma conversa (a pessoa mandou, parou ou concluiu). Sem plano, não faz nada.
pub fn cancel_resume(db: &DbConnection, thread_id: &str) {
    if let Ok(conn) = db.lock() {
        drop_plan(&conn, thread_id);
    }
}

/// O tick do agendador: dispara o que venceu. `gate` pausa o que foi armado antes de o app subir, até a pessoa
/// retomar a automação.
pub(crate) fn tick(app: &AppHandle, gate: crate::missions::automation::Gate, now: i64) {
    let Some(db) = app.try_state::<DbConnection>().map(|state| state.inner().clone()) else { return };
    for plan in due_now(&db, gate, now) {
        let app = app.clone();
        let db = db.clone();
        std::thread::spawn(move || {
            tauri::async_runtime::block_on(fire(&app, &db, &plan, now));
        });
    }
}

/// Os planos vencidos que o tick pode tratar agora (fora da pausa da automação).
pub(crate) fn due_now(db: &DbConnection, gate: crate::missions::automation::Gate, now: i64) -> Vec<ResumePlan> {
    let Ok(conn) = db.lock() else { return Vec::new() };
    all_plans(&conn).into_iter().filter(|plan| plan.at <= now && !gate.pauses(plan.created_at_ms)).collect()
}

async fn fire(app: &AppHandle, db: &DbConnection, plan: &ResumePlan, now: i64) {
    // Um tick só trata um plano de cada vez: o apagar dentro do lock é quem «reivindica» a retomada.
    let (thread, pending) = {
        let Ok(conn) = db.lock() else { return };
        let thread = super::store::thread(&conn, &plan.thread_id).ok().flatten();
        let pending = super::store::pending_requests(&conn, &plan.thread_id).map(|list| list.len()).unwrap_or(0);
        (thread, pending)
    };
    let working = api::status(&plan.thread_id).working;
    match fire_decision(thread.as_ref(), working, pending, plan, now) {
        Fire::Wait => {}
        Fire::Drop => cancel_resume(db, &plan.thread_id),
        Fire::Send => {
            let claimed = db.lock().map(|conn| drop_plan(&conn, &plan.thread_id)).unwrap_or(false);
            if !claimed {
                return;
            }
            turn::save_notice(app, db, &plan.thread_id, "limitResumed", "O limite renovou. Retomando a conversa sozinho.");
            if let Err(error) = api::send_mode(app, db, &plan.thread_id, RESUME_TEXT, SendMode::QueueAfterActive, &[]).await {
                turn::save_notice(app, db, &plan.thread_id, "limitResumeFailed", &format!("Não consegui retomar sozinho: {error}."));
            }
        }
    }
}

// ── O modelo reserva da conversa ────────────────────────────────────────────────────────────────────────────

/// Pura: o modelo reserva do projeto que valeria trocar para, ou `None` se não há reserva ou se a conversa já usa
/// exatamente ele.
pub fn fallback_target(defaults: &ProjectChatDefaults, agent_id: &str, model: Option<&str>) -> Option<ModelChoice> {
    let fallback = defaults.fallback.as_ref()?;
    let same_agent = fallback.agent_id == agent_id;
    let same_model = fallback.model.as_deref() == model || (fallback.model.is_none() && model.is_none());
    (!(same_agent && same_model)).then(|| fallback.clone())
}

fn label_of(choice: &ModelChoice) -> String {
    let agent = crate::agents::agent_def(&choice.agent_id).map(|def| def.label.to_string()).unwrap_or_else(|| choice.agent_id.clone());
    match &choice.model {
        Some(model) => format!("{agent} · {model}"),
        None => agent,
    }
}

/// Pergunta se a conversa segue com o modelo reserva do projeto. Não pergunta de novo enquanto houver uma pergunta
/// pendente, nem com a conversa num pool de contas (o pool já cuida da troca).
fn offer_fallback(app: &AppHandle, db: &DbConnection, row: &ThreadRow, resets_at: Option<i64>) {
    if pool::pending(db, &row.id).is_some() || (pool::mode(db) != pool::Mode::Off && pool::bound(db, &row.id).is_some()) {
        return;
    }
    let Ok(conn) = db.lock() else { return };
    let Some(defaults) = crate::project_chat_defaults::read(&conn, &row.cwd).ok().flatten() else { return };
    let Some(target) = fallback_target(&defaults, &row.agent_id, row.model.as_deref()) else { return };
    // Um reserva que a política do projeto bloqueia, ou que não conversa por protocolo, não é oferta possível.
    if !api::structured_agent(&target.agent_id) || crate::project_chat_policy::ensure_agent_enabled(&conn, &row.cwd, &target.agent_id).is_err() {
        return;
    }
    drop(conn);
    let from = crate::agents::agent_def(&row.agent_id).map(|def| def.label.to_string()).unwrap_or_else(|| row.agent_id.clone());
    let renews = resets_at.map(|at| format!(" (renova {})", pool::clock(at))).unwrap_or_default();
    let to_label = label_of(&target);
    pool::set_pending(
        db,
        &row.id,
        &Pending {
            kind: "fallback".into(),
            to: None,
            to_label: to_label.clone(),
            request: pool::last_request(db, &row.id),
            pool_id: None,
            agent_id: Some(target.agent_id),
            model: target.model,
        },
    );
    turn::save_notice(app, db, &row.id, "fallbackOffer", &format!("O limite de {from} esgotou{renews}. Continuar com o modelo reserva do projeto ({to_label})?"));
}

/// A pessoa aceitou o modelo reserva: troca o modelo (mesmo agente) ou o agente e reenvia o pedido que ficou sem
/// resposta. A política de agentes do projeto vale na troca; o acesso da conversa se mantém (ou cai para
/// Supervisionado, se o agente novo não o tem).
pub(super) async fn accept_fallback(app: &AppHandle, db: &DbConnection, thread_id: &str, pending: Pending) -> Result<(), String> {
    let agent_id = pending.agent_id.clone().ok_or("O aviso não guardou o modelo reserva.")?;
    let row = api::thread(db, thread_id)?;
    if row.agent_id == agent_id {
        api::retune(db, thread_id, pending.model.clone(), row.effort.clone(), row.access.clone())?;
    } else {
        troca::switch_agent(
            app,
            db,
            thread_id,
            troca::Switch { agent_id: agent_id.clone(), model: pending.model.clone(), effort: None, access: row.access.clone(), account_id: None },
        )
        .await?;
    }
    pool::dismiss(db, thread_id);
    turn::save_notice(app, db, thread_id, "fallbackSwitched", &format!("Seguindo com o modelo reserva: {}.", pending.to_label));
    let text = pending.request.clone().filter(|request| !request.trim().is_empty()).unwrap_or_else(|| "Continue de onde parou.".into());
    api::send(app, db, thread_id, &text).await
}

// ── O gancho do fim do turno ────────────────────────────────────────────────────────────────────────────────

/// Chamado no fim de cada turno (ao lado de `pool::after_turn`). Só age se o turno parou por limite.
pub fn after_turn(app: &AppHandle, db: &DbConnection, thread_id: &str, result: &TurnResult) {
    let Some(error) = result.error.clone().filter(|_| !result.interrupted) else { return };
    if classify(&error) != FailureKind::RateLimited {
        return;
    }
    let now = crate::util::now_ts();
    let offset = pool::local_offset();
    let Ok(row) = api::thread(db, thread_id) else { return };
    let known = pool::reset_at_known(&error, now, offset);
    if let Some(at) = known {
        pool::mark_exhausted(db, &crate::runs::quota::account_key(&row.agent_id, row.account_id.as_deref()), at, now);
    }
    if let Some(at) = plan_resume(resume_enabled(db), &error, now, offset) {
        let plan = ResumePlan { thread_id: thread_id.to_owned(), at, created_at_ms: crate::util::now_ts_ms() };
        if db.lock().map_err(|e| e.to_string()).and_then(|conn| save_plan(&conn, &plan)).is_ok() {
            turn::save_notice(app, db, thread_id, "limitResume", &format!("O limite esgotou. Retomo sozinho às {}, quando renovar.", pool::clock(at)));
        }
    }
    offer_fallback(app, db, &row, known);
}

// ── Comandos Tauri ──────────────────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn chat_limit_resume_pref_get(db: State<'_, DbConnection>) -> bool {
    resume_enabled(&db)
}

#[tauri::command]
pub fn chat_limit_resume_pref_set(db: State<'_, DbConnection>, enabled: bool) -> Result<(), String> {
    crate::database::set_setting(&db, RESUME_PREF_KEY, if enabled { "on" } else { "off" })?;
    // Desligar não deixa para trás uma retomada que a pessoa já não quer.
    if !enabled {
        let conn = db.lock().map_err(|error| error.to_string())?;
        for plan in all_plans(&conn) {
            drop_plan(&conn, &plan.thread_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn chat_limit_resume_get(db: State<'_, DbConnection>, thread_id: String) -> Option<ResumePlan> {
    db.lock().ok().and_then(|conn| load_plan(&conn, &thread_id))
}

#[tauri::command]
pub fn chat_limit_resume_cancel(db: State<'_, DbConnection>, thread_id: String) {
    cancel_resume(&db, &thread_id);
}
