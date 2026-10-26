//! A fila de mensagens entre agentes, em movimento: quem digita no terminal do destino, na ordem,
//! uma de cada vez. O estado de cada mensagem fica no banco (`crate::peer_queue::store`); aqui ficam
//! o entregador de cada destino, a retomada no arranque do app, os comandos da interface (listar,
//! editar, reordenar, cancelar, enviar agora) e o `ags peer queue`.
//!
//! Regras que valem para todo caminho que digita uma mensagem de agente:
//! - um destino de cada vez (`delivery_lock`);
//! - a mensagem sai da fila com `store::claim` (`queued` → `delivering`) numa só escrita, então
//!   nunca é digitada duas vezes, nem por duas threads nem depois de um reinício;
//! - o texto é lido do banco na hora da entrega: vale a versão que o usuário editou;
//! - logo antes de tomar a mensagem, o estado do transcript (`canal::busy`) é lido de novo: o
//!   destino que voltou a trabalhar no meio da espera não recebe nada;
//! - "agora" é o relógio do SQLite (`store::db_now`), o mesmo para todo processo que escreve no banco;
//! - a mensagem do entregador que termina `unconfirmed`/`expired` volta ao remetente como aviso
//!   (`store::failure_notice`); a de quem mandou e ficou esperando a resposta (entrega já, `ask`
//!   direto) não, porque o próprio comando já disse que não chegou.
//!
//! Sem lease: só o app entrega (a CLI só pede, pelo IPC), então não há dois entregadores disputando a
//! mesma mensagem; o `claim` numa só escrita e o `delivery_lock` bastam. Ver FILA_DE_MENSAGENS.md.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, delivery_lock, outgoing, outgoing_peer, spill_to_inbox, stale_note, submit_confirmed};
use super::tabs::{pty_id_for_tab, tab_list, wait_until_quiet};
use crate::ipc::protocol::arg_str_opt;
use crate::peer_queue::store::{self, Admission, NewMessage, PeerMessage, State};

/// Quanto o comando de quem envia espera o destino ficar quieto. Passou disso, a mensagem vai
/// para a fila e o remetente segue trabalhando (antes ele ficava preso até 60 s pelo trabalho
/// do outro).
const SENDER_WAIT: Duration = Duration::from_secs(3);
/// Até quando a fila espera o destino terminar o turno antes de entregar mesmo assim.
const QUEUE_MAX_WAIT: Duration = Duration::from_secs(15 * 60);
/// Silêncio que conta como "o destino terminou de escrever".
const QUIET: Duration = Duration::from_millis(1500);
/// De quanto em quanto o entregador olha a fila de novo enquanto espera (pegar "enviar agora",
/// uma reordenação ou um cancelamento sem esperar o turno inteiro do destino).
const WAIT_SLICE: Duration = Duration::from_secs(3);
/// Quanto o entregador espera o terminal do destino existir (no arranque, o PTY nasce depois).
const PTY_WAIT: Duration = Duration::from_secs(120);

/// O que aconteceu com uma mensagem: entregue já, na fila, repetida, sem confirmação, cancelada ou
/// recusada por um teto (aí `Sent::message` é a linha da recusa, com o motivo e a frase).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Delivery { Now, Queued, Duplicate, Unconfirmed, Cancelled, Refused }

/// O resultado de mandar uma mensagem: o que aconteceu e o registro dela.
#[derive(Clone, Debug)]
pub(crate) struct Sent {
    pub delivery: Delivery,
    pub message: PeerMessage,
    /// O mesmo id do chamador já tinha sido usado: é a mesma mensagem, não foi de novo.
    pub repeat: bool,
}

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let db = super::shared::db(app)?;
    let conn = db.inner().lock().map_err(|e| e.to_string())?;
    f(&conn)
}

/// `with_db` com o "agora" do relógio do SQLite: todo prazo da fila se compara com ele.
fn with_db_now<T>(app: &AppHandle, f: impl FnOnce(&Connection, i64) -> Result<T, String>) -> Result<T, String> {
    with_db(app, |conn| {
        let now = store::db_now(conn)?;
        f(conn, now)
    })
}

/// Avisa cada remetente (ainda aberto) de que a mensagem dele não chegou, pela fila dele.
fn notify_failures(app: &AppHandle, failed: &[PeerMessage]) {
    let failed: Vec<&PeerMessage> = failed.iter().filter(|m| m.kind != "notice").collect();
    if failed.is_empty() {
        return;
    }
    // Sem a lista das abas não se sabe se o remetente existe: melhor não avisar ninguém.
    let Ok(listed) = tab_list(app) else { return };
    let live = live_ids(&listed);
    for msg in failed {
        if !live.contains(&msg.from_tab_id) {
            continue;
        }
        if let Ok(Some(notice)) = with_db_now(app, |conn, now| store::failure_notice(conn, msg, now)) {
            changed(app, Some(&notice.to_tab_id));
            ensure_worker(app, &notice.to_tab_id);
        }
    }
}

fn live_ids(listed: &Value) -> HashSet<String> {
    listed
        .get("tabs")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Avisa a interface que a fila de um destino mudou (o selo e a lista se atualizam).
fn changed(app: &AppHandle, to: Option<&str>) {
    let _ = app.emit("cc-peer-queue", json!({ "toTabId": to }));
}

/// O `--id` do chamador, se veio (texto ou número).
pub(super) fn client_id_arg(args: &Value) -> Option<String> {
    match args.get("id") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Pura: o que é digitado no terminal do destino. `body` é o texto já tratado (o começo e o
/// caminho, se ele foi para a caixa de entrada). Uma mensagem que esperou ganha o aviso de que pode
/// estar velha; `--raw` não, porque é um comando da TUI (`/compact`) e o aviso o quebraria.
pub(crate) fn compose(msg: &PeerMessage, body: &str, waited: Duration) -> String {
    // O corpo de uma mensagem de par (`tell`/`ask`) vai no envelope de conteúdo não confiável; o que o
    // próprio app escreve (papel, linha da entrega, aviso) vai como sempre.
    let text = if matches!(msg.kind.as_str(), "tell" | "ask") {
        outgoing_peer(&msg.from_name, body, msg.reply, msg.raw)
    } else {
        outgoing(&msg.from_name, body, msg.reply, msg.raw)
    };
    let text = match stale_note(waited).filter(|_| !msg.raw) {
        Some(note) => format!("{text}\n{note}"),
        None => text,
    };
    retry_marked(msg, text)
}

/// Pura: com `attempts > 1` a mensagem já foi tentada (digitada sem confirmação, ou reenviada com o
/// mesmo id) e o destino pode já ter agido nela: o texto entregue começa com `store::RETRY_MARK`.
/// `--raw` não (é um comando da TUI e o aviso o quebraria).
pub(crate) fn retry_marked(msg: &PeerMessage, text: String) -> String {
    if msg.attempts > 1 && !msg.raw { format!("{} {text}", store::RETRY_MARK) } else { text }
}

/// Registra a mensagem. `Err(Sent)` = não vai (mesmo id já usado, ou repetida pelo texto).
fn admit(app: &AppHandle, new: &NewMessage<'_>, initial: State) -> Result<Result<PeerMessage, Sent>, String> {
    let admission = with_db_now(app, |conn, now| store::admit(conn, new, initial, now))?;
    Ok(match admission {
        Admission::New(message) => Ok(message),
        Admission::Repeat(message) => Err(Sent { delivery: Delivery::Duplicate, message, repeat: true }),
        Admission::Duplicate(message) => Err(Sent { delivery: Delivery::Duplicate, message, repeat: false }),
        Admission::Refused(refusal) => Err(Sent { delivery: Delivery::Refused, message: refusal.record, repeat: false }),
    })
}

/// Os tetos, sem gravar nada: `Some((motivo, frase))` se a mensagem seria recusada. Para o `peer ask`
/// recusar antes de esperar o destino ficar quieto (o `admit` confere de novo, na transação).
pub(super) fn refusal_preview(app: &AppHandle, new: &NewMessage<'_>) -> Result<Option<(&'static str, String)>, String> {
    Ok(with_db_now(app, |conn, now| store::check_limits(conn, new, now))?.map(|(reason, message, _)| (reason, message)))
}

/// Grava a recusa de política decidida antes da fila (destino errado, si mesmo, sem tarefa).
pub(super) fn refuse(app: &AppHandle, new: &NewMessage<'_>, reason: &str, message: &str) -> Result<PeerMessage, String> {
    with_db_now(app, |conn, now| store::record_refusal(conn, new, reason, message, now))
}

/// Digita uma mensagem já tomada da fila (`delivering`) e fecha o registro. `Ok(false)` = escrita,
/// mas não apareceu na tela. `notify`: a que não se confirmou volta ao remetente como aviso (só o
/// entregador; quem entrega já devolve o resultado ao próprio remetente).
fn type_claimed(app: &AppHandle, pty: u32, msg: &PeerMessage, notify: bool) -> Result<bool, String> {
    let at = with_db(app, store::db_now).unwrap_or_else(|_| crate::util::now_ts_ms());
    let waited = Duration::from_millis((at - msg.created_at).max(0) as u64);
    // Mensagem longa vai inteira para um arquivo e no terminal só o começo e o caminho. Só o `tell`
    // com cabeçalho: era assim antes da fila (a pergunta e a linha da entrega vão inteiras).
    let body = if msg.kind == "tell" && !msg.raw { spill_to_inbox(&msg.to_tab_id, &msg.text) } else { msg.text.clone() };
    let result = submit_confirmed(pty, &compose(msg, &body, waited));
    let note = match &result {
        Ok(true) => None,
        Ok(false) => Some("O texto foi escrito no terminal do destino, mas não apareceu na tela dele.".to_string()),
        Err(error) => Some(error.clone()),
    };
    let closed = with_db_now(app, |conn, now| store::finish(conn, msg.id, matches!(result, Ok(true)), note.as_deref(), now));
    changed(app, Some(&msg.to_tab_id));
    if notify && !matches!(result, Ok(true)) && matches!(closed, Ok(true))
        && let Ok(Some(done)) = with_db(app, |conn| store::get(conn, msg.id))
    {
        notify_failures(app, &[done]);
    }
    result
}

fn fresh(app: &AppHandle, msg: PeerMessage) -> PeerMessage {
    with_db(app, |conn| store::get(conn, msg.id)).ok().flatten().unwrap_or(msg)
}

/// Entrega já se o destino se aquietar em até `SENDER_WAIT` e não houver outra na frente; senão
/// deixa na fila do destino e o entregador leva quando ele terminar o turno.
pub(super) fn deliver_now_or_queue(app: &AppHandle, pty: u32, new: &NewMessage<'_>) -> Result<Sent, String> {
    let msg = match admit(app, new, State::Queued)? {
        Ok(msg) => msg,
        Err(sent) => return Ok(sent),
    };
    changed(app, Some(&msg.to_tab_id));
    {
        let lock = delivery_lock(&msg.to_tab_id);
        if let Ok(_turn) = lock.try_lock() {
            // Com outras esperando, esta não passa na frente: vai para o fim da fila.
            let first = with_db(app, |conn| store::head(conn, &msg.to_tab_id))?.map(|h| h.id) == Some(msg.id);
            // Com o transcript dizendo que o destino está no meio de um turno (uma ferramenta longa e
            // calada, um diálogo de aprovação), a tela quieta não basta: vai para a fila (ver `canal`).
            // `busy` de novo depois da espera: o destino pode ter aberto um turno nesses segundos.
            if first
                && !crate::canal::busy(&msg.to_tab_id)
                && wait_until_quiet(pty, QUIET, SENDER_WAIT, false)
                && !crate::canal::busy(&msg.to_tab_id)
            {
                let Some(claimed) = with_db_now(app, |conn, now| store::claim(conn, msg.id, now))? else {
                    // O usuário a cancelou nesses segundos.
                    return Ok(Sent { delivery: Delivery::Cancelled, message: fresh(app, msg), repeat: false });
                };
                let confirmed = type_claimed(app, pty, &claimed, false)?;
                let delivery = if confirmed { Delivery::Now } else { Delivery::Unconfirmed };
                return Ok(Sent { delivery, message: fresh(app, claimed), repeat: false });
            }
        }
    }
    ensure_worker(app, &msg.to_tab_id);
    Ok(Sent { delivery: Delivery::Queued, message: msg, repeat: false })
}

/// Põe na fila sem tentar já (a pergunta de um `peer ask` cujo destino está ocupado).
pub(super) fn enqueue(app: &AppHandle, new: &NewMessage<'_>) -> Result<Sent, String> {
    let msg = match admit(app, new, State::Queued)? {
        Ok(msg) => msg,
        Err(sent) => return Ok(sent),
    };
    changed(app, Some(&msg.to_tab_id));
    ensure_worker(app, &msg.to_tab_id);
    Ok(Sent { delivery: Delivery::Queued, message: msg, repeat: false })
}

/// Um `peer ask` com o destino livre digita direto, sem fila: registra a mensagem já como
/// `delivering`. Quem chama precisa estar com o `delivery_lock` do destino. `Err(Sent)` = o mesmo id.
pub(super) fn begin_direct(app: &AppHandle, new: &NewMessage<'_>) -> Result<Result<PeerMessage, Sent>, String> {
    let admitted = admit(app, new, State::Delivering)?;
    if let Ok(msg) = &admitted {
        changed(app, Some(&msg.to_tab_id));
    }
    Ok(admitted)
}

/// Fecha o registro de um `begin_direct`.
pub(super) fn end_direct(app: &AppHandle, msg: &PeerMessage, error: Option<&str>) {
    let _ = with_db_now(app, |conn, now| store::finish(conn, msg.id, error.is_none(), error, now));
    changed(app, Some(&msg.to_tab_id));
}

/// Uma mensagem já registrada com este id do chamador, se houver.
pub(super) fn by_client_id(app: &AppHandle, from: &str, client_id: Option<&str>) -> Result<Option<PeerMessage>, String> {
    // Inclui o tombstone: a chave de um registro que já saiu na limpeza continua valendo.
    with_db(app, |conn| store::by_client_id(conn, from, client_id))
}

// ── O entregador de cada destino ──────────────────────────────────────

/// Os destinos que têm um entregador rodando: no máximo um por destino.
fn workers() -> &'static Mutex<HashSet<String>> {
    static WORKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Liga o entregador da fila de `to`, se ele não está rodando.
pub(super) fn ensure_worker(app: &AppHandle, to: &str) {
    if !workers().lock().unwrap_or_else(|e| e.into_inner()).insert(to.to_string()) {
        return;
    }
    let app = app.clone();
    let to = to.to_string();
    std::thread::spawn(move || run_worker(&app, &to));
}

/// `true` se a fila acabou e o entregador saiu do conjunto. Olha a fila e sai SOB o lock do
/// conjunto: um `ensure_worker` que chegue no meio ou vê o entregador ainda lá (e a mensagem
/// dele já está no banco, então este a pega) ou liga outro depois.
fn retire_if_empty(app: &AppHandle, to: &str) -> bool {
    let mut set = workers().lock().unwrap_or_else(|e| e.into_inner());
    match with_db(app, |conn| store::head(conn, to)) {
        Ok(Some(_)) => false,
        _ => {
            set.remove(to);
            true
        }
    }
}

enum Pty { Found(u32), Closed, Missing }

/// O terminal do destino: existe, a aba foi fechada, ou ainda não tem processo.
fn find_pty(app: &AppHandle, to: &str) -> Pty {
    let deadline = Instant::now() + PTY_WAIT;
    loop {
        if let Ok(listed) = tab_list(app) {
            let rows = listed.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
            let Some(row) = rows.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(to)) else {
                return Pty::Closed;
            };
            let window = row.get("window").and_then(Value::as_str);
            if let Ok(pty) = pty_id_for_tab(app, to, window)
                && crate::terminal::output_total(pty).is_some()
            {
                return Pty::Found(pty);
            }
        }
        if Instant::now() >= deadline {
            return Pty::Missing;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// `Ready(quiet)`: `quiet` = a vez veio do destino quieto (não de "enviar agora" nem do prazo); só aí
/// o entregador relê `canal::busy` logo antes de tomar a mensagem.
enum Turn { Ready(bool), PtyGone, Empty }

/// Espera a vez da próxima mensagem: o destino quieto, o usuário pediu "enviar agora", ou o prazo
/// de `QUEUE_MAX_WAIT` dela acabou (aí vai mesmo assim, como antes).
fn wait_turn(app: &AppHandle, to: &str, pty: u32) -> Turn {
    loop {
        let (head, now) = match with_db_now(app, |conn, now| Ok((store::head(conn, to)?, now))) {
            Ok((Some(head), now)) => (head, now),
            _ => return Turn::Empty,
        };
        if head.force_now {
            return Turn::Ready(false);
        }
        let left = head.created_at + QUEUE_MAX_WAIT.as_millis() as i64 - now;
        if left <= 0 {
            return Turn::Ready(false);
        }
        // `require_output`: um terminal que acabou de nascer (arranque do app) ainda não escreveu
        // nada; quieto assim não é "terminou o turno", é "a TUI nem abriu".
        if wait_until_quiet(pty, QUIET, Duration::from_millis(left as u64).min(WAIT_SLICE), true) {
            // Quieto na tela, mas o transcript diz que o turno segue aberto: espera mais uma fatia.
            // Só segura, nunca solta antes: sem canal (ou estado velho) `busy` é falso. O prazo de
            // `QUEUE_MAX_WAIT` continua valendo.
            if !crate::canal::busy(to) {
                return Turn::Ready(true);
            }
        }
        if crate::terminal::output_total(pty).is_none() {
            return Turn::PtyGone;
        }
    }
}

/// O laço do entregador de um destino: uma mensagem por vez, na ordem da fila, até ela esvaziar.
fn run_worker(app: &AppHandle, to: &str) {
    loop {
        let lock = delivery_lock(to);
        let _turn = lock.lock().unwrap_or_else(|e| e.into_inner());
        if retire_if_empty(app, to) {
            changed(app, Some(to));
            return;
        }
        let pty = match find_pty(app, to) {
            Pty::Found(pty) => pty,
            Pty::Closed => {
                let expired = with_db_now(app, |conn, now| store::expire_queued_for(conn, to, "A aba de destino foi fechada.", now)).unwrap_or_default();
                changed(app, Some(to));
                notify_failures(app, &expired);
                continue;
            }
            // A aba existe mas o terminal não abriu: a fila fica (visível na interface). Uma mensagem
            // nova para ela, ou "enviar agora", liga o entregador de novo.
            Pty::Missing => {
                workers().lock().unwrap_or_else(|e| e.into_inner()).remove(to);
                changed(app, Some(to));
                return;
            }
        };
        let quiet = match wait_turn(app, to, pty) {
            Turn::Ready(quiet) => quiet,
            Turn::PtyGone | Turn::Empty => continue,
        };
        // A próxima é lida de novo: enquanto esperava, o usuário pode ter reordenado ou cancelado.
        let Ok(Some(head)) = with_db(app, |conn| store::head(conn, to)) else { continue };
        // Rechecagem logo antes de agir: o destino que voltou a trabalhar no meio não recebe agora
        // (o laço espera a próxima fatia). "Enviar agora" e o prazo vencido seguem como antes.
        if quiet && !head.force_now && crate::canal::busy(to) {
            continue;
        }
        let Ok(Some(claimed)) = with_db_now(app, |conn, now| store::claim(conn, head.id, now)) else { continue };
        let _ = type_claimed(app, pty, &claimed, true);
    }
}

/// No arranque do app: o que estava sendo digitado vira `unconfirmed` (não se digita de novo), o
/// que esperava uma aba que não existe mais (ou há mais de 1 h) vira `expired`, e o resto volta a
/// andar, com o aviso de atraso na entrega.
pub fn start_resume(app: AppHandle) {
    std::thread::spawn(move || {
        crate::database::wait_until_db_ready();
        // Sem a lista das abas não se sabe quem existe: melhor não expirar nada.
        let Ok(listed) = tab_list(&app) else { return };
        let live = live_ids(&listed);
        // `resume` também enfileira o aviso ao remetente de cada uma que terminou aqui.
        let Ok(targets) = with_db_now(&app, |conn, now| store::resume(conn, &live, now)) else { return };
        for to in &targets {
            ensure_worker(&app, to);
        }
        changed(&app, None);
    });
}

// ── A interface: ver e mexer na fila ──────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCount {
    pub tab_id: String,
    pub count: i64,
}

/// Quantas mensagens esperam cada aba (o selo "N na fila").
#[tauri::command]
pub fn peer_queue_counts(app: AppHandle) -> Result<Vec<QueueCount>, String> {
    let counts = with_db(&app, store::pending_counts)?;
    Ok(counts.into_iter().map(|(tab_id, count)| QueueCount { tab_id, count }).collect())
}

/// O que espera uma aba, na ordem da entrega.
#[tauri::command]
pub fn peer_queue_list(app: AppHandle, tab_id: String) -> Result<Vec<PeerMessage>, String> {
    with_db(&app, |conn| store::queued_for(conn, &tab_id))
}

#[tauri::command]
pub fn peer_queue_edit(app: AppHandle, id: i64, text: String) -> Result<PeerMessage, String> {
    let msg = with_db_now(&app, |conn, now| store::edit(conn, id, &text, now))?;
    changed(&app, Some(&msg.to_tab_id));
    Ok(msg)
}

/// Sobe (`delta` < 0) ou desce (> 0) uma casa. Devolve a fila nova.
#[tauri::command]
pub fn peer_queue_move(app: AppHandle, id: i64, delta: i64) -> Result<Vec<PeerMessage>, String> {
    let list = with_db_now(&app, |conn, now| store::move_by(conn, id, delta.signum(), now))?;
    changed(&app, list.first().map(|m| m.to_tab_id.as_str()));
    Ok(list)
}

#[tauri::command]
pub fn peer_queue_cancel(app: AppHandle, id: i64) -> Result<PeerMessage, String> {
    let msg = with_db_now(&app, |conn, now| store::cancel(conn, id, "Cancelada pelo usuário.", now))?;
    changed(&app, Some(&msg.to_tab_id));
    Ok(msg)
}

/// "Enviar agora": a mensagem vai para a frente e é digitada sem esperar o destino ficar quieto.
#[tauri::command]
pub fn peer_queue_send_now(app: AppHandle, id: i64) -> Result<PeerMessage, String> {
    let msg = with_db_now(&app, |conn, now| store::send_now(conn, id, now))?;
    changed(&app, Some(&msg.to_tab_id));
    ensure_worker(&app, &msg.to_tab_id);
    Ok(msg)
}

// ── `ags peer queue` ─────────────────────────────────────────────────

/// Pura: uma linha da fila para a CLI (sem o texto inteiro).
pub(crate) fn summary(msg: &PeerMessage, now_ms: i64) -> Value {
    let first = msg.text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let preview: String = first.chars().take(120).collect();
    json!({
        "id": msg.id, "clientId": msg.client_id, "kind": msg.kind, "state": msg.state,
        "to": if msg.to_name.is_empty() { &msg.to_tab_id } else { &msg.to_name }, "toTabId": msg.to_tab_id,
        "ageS": ((now_ms - msg.created_at).max(0)) / 1000,
        "preview": preview, "edited": msg.edited_at.is_some(),
    })
}

/// `ags peer queue [list]` (o que você mandou e ainda espera) e `ags peer queue cancel <id>`.
pub(super) fn peer_queue(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let from = caller(args)?;
    let action = arg_str_opt(args, "action").unwrap_or_else(|| "list".into());
    match action.as_str() {
        "list" => {
            let (rows, at) = with_db_now(app, |conn, now| Ok((store::pending_from(conn, &from)?, now)))?;
            Ok(json!({ "messages": rows.iter().map(|m| summary(m, at)).collect::<Vec<_>>() }))
        }
        // As recusas de política que você recebeu (auditoria): motivo, destino, a frase.
        "refused" => {
            let (rows, at) = with_db_now(app, |conn, now| Ok((store::refusals_from(conn, &from, 20)?, now)))?;
            Ok(json!({ "refused": rows.iter().map(|m| {
                let mut line = summary(m, at);
                line["reason"] = json!(m.reason);
                line["message"] = json!(m.note);
                line["depth"] = json!(m.depth);
                line
            }).collect::<Vec<_>>() }))
        }
        "cancel" => {
            let raw = client_id_arg(args).ok_or("Uso: ags peer queue cancel <id>")?;
            let id: i64 = raw.trim().trim_start_matches('#').parse().map_err(|_| "Use o número da mensagem: `ags peer queue cancel 12`.".to_string())?;
            let msg = with_db(app, |conn| store::get(conn, id))?.ok_or_else(|| format!("A mensagem #{id} não existe."))?;
            if msg.from_tab_id != from {
                return Err(format!("A mensagem #{id} não é sua: só quem mandou cancela pela CLI (o usuário cancela qualquer uma na interface)."));
            }
            let (msg, at) = with_db_now(app, |conn, now| Ok((store::cancel(conn, id, "Cancelada pelo remetente.", now)?, now)))?;
            changed(app, Some(&msg.to_tab_id));
            Ok(json!({ "cancelled": true, "message": summary(&msg, at) }))
        }
        other => Err(format!("Ação desconhecida '{other}'. Use: ags peer queue [list|refused|cancel <id>]")),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn msg(raw: bool, reply: bool) -> PeerMessage {
        PeerMessage {
            id: 7, client_id: Some("r1".into()), kind: "tell".into(), from_tab_id: "a".into(), from_name: "Líder".into(),
            to_tab_id: "b".into(), to_name: "QA".into(), text: "\n  rode os testes\nsegunda linha".into(), raw, reply,
            state: State::Queued, position: 1, force_now: false, attempts: 0, created_at: 1_000, updated_at: 1_000,
            delivered_at: None, edited_at: None, note: None, depth: 0, parent_id: None, answer_of: None, reason: None,
        }
    }

    #[test]
    fn a_mensagem_que_esperou_leva_o_aviso_e_o_comando_raw_nao() {
        let quick = compose(&msg(false, false), "oi", Duration::from_secs(2));
        assert!(quick.starts_with("[Mensagem de Líder via ADE AGS] ") && !quick.contains("na fila"), "{quick}");
        assert!(quick.contains("<untrusted_data source=\"peer:Líder\">
oi
</untrusted_data>"), "{quick}");
        let late = compose(&msg(false, false), "oi", Duration::from_secs(300));
        assert!(late.contains("ficou na fila") && late.contains("5 min"), "{late}");
        assert_eq!(compose(&msg(true, false), "/compact", Duration::from_secs(300)), "/compact");
        assert!(compose(&msg(false, true), "?", Duration::ZERO).contains("Responda normalmente"));
        // O que o próprio app escreve (o briefing de papel) não vai como conteúdo não confiável.
        let mut role = msg(false, false);
        role.kind = "role".into();
        assert!(!compose(&role, "Seu papel", Duration::ZERO).contains("untrusted_data"));
    }

    #[test]
    fn a_que_ja_foi_tentada_chega_marcada_como_reenvio() {
        let mut again = msg(false, false);
        again.attempts = 1;
        assert!(!compose(&again, "oi", Duration::ZERO).starts_with(store::RETRY_MARK), "primeira tentativa: sem marca");
        again.attempts = 2;
        let text = compose(&again, "oi", Duration::ZERO);
        assert!(text.starts_with("[reenvio; pode já ter sido recebida] [Mensagem de Líder"), "{text}");
        // `--raw` é um comando da TUI: a marca o quebraria.
        let mut raw = msg(true, false);
        raw.attempts = 3;
        assert_eq!(compose(&raw, "/compact", Duration::ZERO), "/compact");
        assert_eq!(retry_marked(&raw, "/compact".into()), "/compact");
    }

    #[test]
    fn o_resumo_da_cli_mostra_a_primeira_linha_e_a_idade() {
        let line = summary(&msg(false, false), 61_000);
        assert_eq!(line["preview"], "rode os testes");
        assert_eq!(line["ageS"], 60);
        assert_eq!(line["to"], "QA");
        assert_eq!(line["state"], "queued");
        assert_eq!(line["clientId"], "r1");
    }

    #[test]
    fn o_id_do_chamador_vem_como_texto_ou_numero() {
        assert_eq!(client_id_arg(&json!({ "id": "abc" })).as_deref(), Some("abc"));
        assert_eq!(client_id_arg(&json!({ "id": 42 })).as_deref(), Some("42"));
        assert_eq!(client_id_arg(&json!({})), None);
    }
}
