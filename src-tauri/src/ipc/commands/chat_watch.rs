//! O laço do vigia do chat: lê o banco (`chat_team::watch_db`), pergunta ao miolo puro (`chat_team::watch`) o
//! que o orquestrador precisa saber e põe os avisos na fila durável dele. Sem LLM, sem cota e sem polling: dorme
//! no barramento das conversas (`chat.changed`: fase, pedido, pedido resolvido, conversa fechada, interruptor) e,
//! quando um prazo está correndo (um pedido que vira bloqueio, um turno que vira «sem progresso»), até esse prazo.
//!
//! Só AVISA: nunca escreve na conversa de um integrante, nunca responde um pedido e nunca interrompe um turno.

use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::conversas::BUS_TOPIC;
use super::peer_queue::{changed, ensure_worker};
use crate::chat_team::{watch, watch_db};
use crate::peer_queue::store;

/// Sem nenhum prazo correndo, o laço só acorda por evento; este teto existe para o laço não ficar preso para sempre
/// se um evento se perder (não é uma varredura: a leitura é barata e idempotente).
const IDLE_RECHECK: Duration = Duration::from_secs(3600);

/// Liga o vigia no arranque do app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        crate::database::wait_until_db_ready();
        run(&app);
    });
}

fn run(app: &AppHandle) {
    let filter = crate::bus::Filter { topics: vec![BUS_TOPIC.into()], ..Default::default() };
    loop {
        // O ponto de partida vem ANTES do `tick`: um evento durante ele não se perde.
        let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
        let timeout = match tick(app) {
            Ok(Some(at)) => until(app, at),
            _ => IDLE_RECHECK,
        };
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let page = crate::bus::wait(after, &filter, 50, left);
            after = page.last_seq;
            if !page.events.is_empty() {
                break;
            }
        }
    }
}

/// Quanto dormir até `at` (ms do relógio do banco).
fn until(app: &AppHandle, at: i64) -> Duration {
    let now = with_conn(app, store::db_now).unwrap_or(at);
    Duration::from_millis((at - now).max(1) as u64).min(IDLE_RECHECK)
}

fn with_conn<T>(app: &AppHandle, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    let db = super::shared::db(app)?;
    let conn = db.inner().lock().map_err(|e| e.to_string())?;
    f(&conn)
}

/// Uma passada: avisa o que venceu e devolve o próximo prazo (ms do relógio do banco), se algum está correndo.
fn tick(app: &AppHandle) -> Result<Option<i64>, String> {
    let (queued, wake) = with_conn(app, |conn| {
        let now = store::db_now(conn)?;
        let mut queued = Vec::new();
        let mut wake: Option<i64> = None;
        for watched in watch_db::gather(conn, now)? {
            let plan = watch::evaluate(&watched.input, now);
            queued.extend(watch_db::queue(conn, &watched, &plan, now)?);
            wake = match (wake, plan.wake_at) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
        }
        Ok((queued, wake))
    })?;
    // O lock do banco já foi solto: acordar o entregador fala com a fila.
    for msg in &queued {
        changed(app, Some(&msg.to_tab_id));
        ensure_worker(app, &msg.to_tab_id);
    }
    Ok(wake)
}
