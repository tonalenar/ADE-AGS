//! O que os motores de protocolo mais novos (OpenCode, Antigravity) fazem do mesmo jeito: abrir e
//! fechar o turno no banco, gravar os itens e avisar a janela. O lock do banco só é pego para
//! gravar, nunca durante o I/O com o agente.

use serde_json::json;
use tauri::AppHandle;

use crate::canal::timeline::Item;
use crate::database::DbConnection;

use super::claude_map::{self, TurnResult};
use super::events::emit;
use super::store;

/// Abre o turno `turn` no banco e avisa a janela que o agente está trabalhando.
pub fn begin(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str) {
    if let Ok(conn) = db.lock() {
        let _ = store::upsert_run(&conn, thread_id, turn, "inProgress", Some(crate::util::now_ts_ms()), None, None);
    }
    emit(app, thread_id, "phase", json!({ "phase": "working", "turnId": turn }));
}

/// Grava os itens (um novo vai para o fim; um que já existe fica no lugar) e manda à janela.
pub fn save_items(app: &AppHandle, db: &DbConnection, thread_id: &str, run_id: Option<&str>, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    if let Ok(conn) = db.lock() {
        for item in &items {
            let _ = store::upsert_item(&conn, thread_id, run_id, item);
        }
        let _ = store::touch(&conn, thread_id, crate::util::now_ts_ms());
    }
    for item in items {
        emit(app, thread_id, "item", json!({ "item": item }));
    }
}

/// Fecha o turno: o status e a duração no banco, os pedidos pendentes expiram e o fim do turno
/// entra na timeline.
pub fn finish(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, result: &TurnResult) {
    let now = crate::util::now_ts_ms();
    let expired = db.lock().ok().map(|conn| record_end(&conn, thread_id, turn, result, now));
    for id in expired.unwrap_or_default() {
        emit(app, thread_id, "requestResolved", json!({ "id": id }));
    }
    emit(app, thread_id, "item", json!({ "item": claude_map::turn_end(turn, result, Some(now)) }));
    super::pool::after_turn(app, db, thread_id, result);
}

/// A parte do `finish` que mexe no banco: o status do turno, os pedidos pendentes expirados (devolve os
/// ids) e o `turnEnd` na timeline, com o erro no texto. Separada para testar sem a janela.
pub fn record_end(conn: &rusqlite::Connection, thread_id: &str, turn: &str, result: &TurnResult, now: i64) -> Vec<String> {
    let _ = store::upsert_run(conn, thread_id, turn, claude_map::run_status(result), None, Some(now), result.duration_ms);
    let expired = store::expire_requests(conn, thread_id).unwrap_or_default();
    // Um turno que caiu (ou foi interrompido) com ferramenta sem resultado: o desfecho dela é desconhecido.
    if result.interrupted || result.error.is_some() {
        mark_unknown_outcomes(conn, thread_id, turn, now);
    }
    let _ = store::upsert_item(conn, thread_id, Some(turn), &claude_map::turn_end(turn, result, Some(now)));
    let _ = store::touch(conn, thread_id, now);
    expired
}

/// O código do aviso de ferramenta interrompida, na timeline e na nota ao agente.
pub const TOOL_OUTCOME_UNKNOWN: &str = "TOOL_OUTCOME_UNKNOWN";

/// As ferramentas do turno `turn` que ficaram sem resultado viram «desfecho desconhecido» (status de erro, com o
/// código na saída) e a timeline ganha o aviso `toolOutcomeUnknown`, que o PRÓXIMO envio leva ao agente (ver
/// [`crate::conversa::resume::unknown_outcome_note`]). Sem ferramenta pendente, nada muda.
fn mark_unknown_outcomes(conn: &rusqlite::Connection, thread_id: &str, turn: &str, now: i64) {
    use crate::canal::timeline::{ItemKind, ToolStatus};
    let Ok(mut stmt) = conn.prepare("SELECT body FROM chat_item WHERE thread_id = ?1 AND run_id = ?2") else { return };
    let Ok(rows) = stmt.query_map(rusqlite::params![thread_id, turn], |r| r.get::<_, String>(0)) else { return };
    let pending: Vec<Item> = rows
        .filter_map(Result::ok)
        .filter_map(|body| serde_json::from_str::<Item>(&body).ok())
        .filter(|i| i.kind == ItemKind::Tool && i.status == Some(ToolStatus::Running))
        .collect();
    if pending.is_empty() {
        return;
    }
    let mut calls = Vec::new();
    for mut tool in pending {
        calls.push(tool_call_label(&tool));
        tool.status = Some(ToolStatus::Error);
        tool.output = Some(format!("{TOOL_OUTCOME_UNKNOWN}: a conversa parou antes do resultado; a ferramenta pode ter rodado."));
        let _ = store::upsert_item(conn, thread_id, Some(turn), &tool);
    }
    let notice = Item {
        label: Some("toolOutcomeUnknown".into()),
        text: Some(unknown_outcome_text(&calls)),
        ..Item::new(crate::canal::timeline::ItemKind::Notice, format!("n:toolOutcomeUnknown:{turn}"), Some(now))
    };
    let _ = store::upsert_item(conn, thread_id, Some(turn), &notice);
}

/// Pura: «Bash git push», «Edit src/a.rs», só o nome se não houver mais.
pub fn tool_call_label(tool: &Item) -> String {
    let name = tool.name.as_deref().unwrap_or("ferramenta");
    match tool.label.as_deref().or(tool.path.as_deref()).filter(|l| !l.trim().is_empty() && *l != name) {
        Some(what) => format!("{name} {}", crate::canal::event::first_line(what, 160)),
        None => name.to_string(),
    }
}

/// Pura: o texto do aviso, que é também a nota que o agente recebe no próximo envio.
pub fn unknown_outcome_text(calls: &[String]) -> String {
    let list: Vec<String> = calls.iter().take(8).map(|c| format!("`{c}`")).collect();
    let more = calls.len().saturating_sub(8);
    let more = if more > 0 { format!(" e mais {more}") } else { String::new() };
    format!(
        "{TOOL_OUTCOME_UNKNOWN}: a conversa parou com ferramenta sem resultado: {}{more}. Ela pode ter rodado ou não. Só repita se for idempotente; senão confira o estado (git status, o arquivo, o PR) ou pergunte antes.",
        list.join(", ")
    )
}

/// Por que um turno acabou, no vocabulário do aviso «terminou» ao orquestrador. `Timeout` é o watchdog de
/// inatividade (turno aberto esperando o modelo, sem nenhum evento): distinto de `Aborted` (a pessoa ou o app
/// parou) e de `Error` (o agente ou o processo falhou).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Completed,
    Aborted,
    Error,
    MaxTokens,
    Refusal,
    Timeout,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::Completed => "completed",
            StopReason::Aborted => "aborted",
            StopReason::Error => "error",
            StopReason::MaxTokens => "max-tokens",
            StopReason::Refusal => "refusal",
            StopReason::Timeout => "timeout",
        }
    }

    /// Pura: do status do turno em `chat_run` (`completed`/`failed`/`interrupted`), do erro gravado no fim do turno
    /// e de o watchdog ter marcado `TIMEOUT` antes do fim. Um turno que terminou bem vale `completed` mesmo depois
    /// de um TIMEOUT (o modelo voltou).
    pub fn classify(status: &str, error: Option<&str>, timed_out: bool) -> StopReason {
        match status {
            "completed" => StopReason::Completed,
            _ if timed_out => StopReason::Timeout,
            "interrupted" => StopReason::Aborted,
            _ => {
                let lower = error.unwrap_or("").to_lowercase();
                if ["max_tokens", "max tokens", "limite de tokens", "maximum output tokens"].iter().any(|p| lower.contains(p)) {
                    StopReason::MaxTokens
                } else if ["refusal", "refused", "recusou"].iter().any(|p| lower.contains(p)) {
                    StopReason::Refusal
                } else {
                    StopReason::Error
                }
            }
        }
    }
}

/// O código do aviso de TIMEOUT na timeline.
pub const TURN_TIMEOUT: &str = "turnTimeout";

/// Pura: a marca de TIMEOUT do turno `turn` na timeline. O id é fixo por turno: gravar de novo não duplica.
pub fn timeout_item(turn: &str, idle_ms: i64, now: i64) -> Item {
    let minutes = (idle_ms / 60_000).max(1);
    Item {
        label: Some(TURN_TIMEOUT.into()),
        text: Some(format!("TIMEOUT: nenhum evento do agente há {minutes} min com o turno aberto e nenhuma ferramenta rodando. Nada foi interrompido; o turno segue aberto.")),
        ..Item::new(crate::canal::timeline::ItemKind::Notice, timeout_item_id(turn), Some(now))
    }
}

pub fn timeout_item_id(turn: &str) -> String {
    format!("n:{TURN_TIMEOUT}:{turn}")
}

/// O desfecho de um turno que o processo do agente deixou aberto ao fechar. Fechado de propósito
/// (`killed`: fechar a conversa, trocar o acesso) é interrupção, sem erro. Caiu sozinho não foi a pessoa que
/// parou: vira erro com o motivo (a última linha do stderr, se houver) e o mesmo texto vai ao aviso da janela.
/// Pura.
pub fn dropped(killed: bool, stderr_tail: Option<&str>, agent: &str) -> (TurnResult, Option<String>) {
    if killed {
        return (TurnResult { interrupted: true, ..Default::default() }, None);
    }
    let reason = stderr_tail
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| crate::canal::event::clip(l, 600))
        .unwrap_or_else(|| format!("O processo do {agent} fechou no meio do turno"));
    (TurnResult { error: Some(reason.clone()), ..Default::default() }, Some(reason))
}

/// Pura: a linha do stderr que explica um processo que fechou no meio do turno: a última que NÃO é aviso
/// (`warning:`, `info`, `debug`, `deprecated`…). Antes era a última linha qualquer, e um aviso inofensivo
/// impresso antes de o processo cair virava «o erro» na tela.
pub fn stderr_reason<'a>(lines: impl DoubleEndedIterator<Item = &'a String>) -> Option<String> {
    lines.rev().map(|l| l.trim()).find(|l| !l.is_empty() && !is_noise(l)).map(str::to_string)
}

fn is_noise(line: &str) -> bool {
    let start = line.trim_start_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    ["warn", "info", "debug", "notice", "deprecat"].iter().any(|p| start.starts_with(p))
}

/// A mensagem da pessoa na timeline, gravada ao mandar.
pub fn save_user(app: &AppHandle, db: &DbConnection, thread_id: &str, turn: &str, text: &str) {
    use crate::canal::event::clip;
    use crate::canal::timeline::ItemKind;
    let item = Item { text: Some(clip(text, 20_000)), ..Item::new(ItemKind::User, format!("u:{}", uuid::Uuid::new_v4()), Some(crate::util::now_ts_ms())) };
    save_items(app, db, thread_id, Some(turn), vec![item]);
}

/// Um aviso do app no fio da conversa (ver `ItemKind::Notice`): a retomada que recomeçou sem histórico, a
/// mensagem da fila que foi descartada, uma opção que o agente não aplicou. Persistente: sobrevive ao reinício.
pub fn save_notice(app: &AppHandle, db: &DbConnection, thread_id: &str, code: &str, text: &str) {
    save_items(app, db, thread_id, None, vec![notice_item(code, text, crate::util::now_ts_ms())]);
}

/// Pura: o item de um aviso. O id é único por aviso (duas mensagens descartadas iguais não colapsam).
pub fn notice_item(code: &str, text: &str, now: i64) -> Item {
    use crate::canal::event::clip;
    use crate::canal::timeline::ItemKind;
    Item {
        label: Some(code.to_string()),
        text: Some(clip(text, 20_000)),
        ..Item::new(ItemKind::Notice, format!("n:{code}:{}", uuid::Uuid::new_v4()), Some(now))
    }
}

/// O turno em andamento de uma conversa e a fila do que chegou durante ele, numa só trava. Decidir «começa
/// agora ou entra na fila» e «qual é o próximo» são decisões sobre o MESMO estado: com duas travas, a mensagem que
/// chegava no instante em que o turno acabava era lida como «há turno», o fim do turno esvaziava a fila e ela
/// ficava encalhada, sem nunca ser enviada.
#[derive(Default)]
pub struct Lane {
    state: std::sync::Mutex<LaneState>,
}

#[derive(Default)]
struct LaneState {
    turn: Option<String>,
    queue: std::collections::VecDeque<String>,
}

/// O que a [`Lane`] decidiu para uma mensagem.
#[derive(Debug, PartialEq, Eq)]
pub enum Admitted {
    /// Havia turno: entrou na fila.
    Queued,
    /// Não havia: este é o turno dela, já reservado.
    Start(String),
}

impl Lane {
    fn state(&self) -> std::sync::MutexGuard<'_, LaneState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn turn(&self) -> Option<String> {
        self.state().turn.clone()
    }

    /// Tira o turno em andamento: quem o tira é quem o fecha.
    pub fn take_turn(&self) -> Option<String> {
        self.state().turn.take()
    }

    /// Começa um turno para `text` se a conversa está livre (reservando-o), senão põe `text` na fila.
    pub fn admit(&self, text: &str) -> Admitted {
        let mut state = self.state();
        if state.turn.is_some() {
            state.queue.push_back(text.to_string());
            return Admitted::Queued;
        }
        let turn_id = uuid::Uuid::new_v4().to_string();
        state.turn = Some(turn_id.clone());
        Admitted::Start(turn_id)
    }

    /// A próxima da fila, com o turno dela já reservado. `None` = fila vazia (o turno segue livre).
    pub fn advance(&self) -> Option<(String, String)> {
        let mut state = self.state();
        let text = state.queue.pop_front()?;
        let turn_id = uuid::Uuid::new_v4().to_string();
        state.turn = Some(turn_id.clone());
        Some((turn_id, text))
    }

    /// Esvazia a fila e devolve o que esperava.
    pub fn drain(&self) -> Vec<String> {
        self.state().queue.drain(..).collect()
    }

    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.state().queue.len()
    }
}

/// Pura: um aviso `queueDropped` por mensagem da fila que não chegou a ser enviada (a conversa foi
/// interrompida ou fechada antes de a vez dela). O texto do item é a mensagem, para a tela mostrá-la como
/// «não enviada» e oferecer reenviar.
pub fn dropped_items(texts: Vec<String>, now: i64) -> Vec<Item> {
    texts.iter().map(|text| notice_item("queueDropped", text, now)).collect()
}

/// Marca, na timeline, cada mensagem da fila descartada: antes elas sumiam, e a pessoa ficava com uma bolha
/// que ninguém respondeu.
pub fn discard_queue(app: &AppHandle, db: &DbConnection, thread_id: &str, texts: Vec<String>) {
    if texts.is_empty() {
        return;
    }
    save_items(app, db, thread_id, None, dropped_items(texts, crate::util::now_ts_ms()));
}

/// Grava o novo acesso da conversa (o agente mudou de modo sozinho) e avisa a janela.
pub fn set_access(app: &AppHandle, db: &DbConnection, thread_id: &str, access: &str) {
    let changed = db.lock().ok().and_then(|conn| {
        let row = store::thread(&conn, thread_id).ok().flatten()?;
        if row.access == access {
            return None;
        }
        let tuning = store::Tuning { model: row.model, effort: row.effort, access: access.to_string() };
        store::set_tuning(&conn, thread_id, &tuning, crate::util::now_ts_ms()).ok()
    });
    if changed.is_some() {
        emit(app, thread_id, "thread", json!({ "access": access }));
    }
}
