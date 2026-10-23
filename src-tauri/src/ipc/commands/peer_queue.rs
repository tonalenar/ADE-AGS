//! A fila de mensagens entre agentes, em movimento: quem digita no terminal do destino, na ordem,
//! uma de cada vez. O estado de cada mensagem fica no banco (`crate::peer_queue::store`); aqui ficam
//! o entregador de cada destino, a retomada no arranque do app, os comandos da interface (listar,
//! editar, reordenar, cancelar, enviar agora) e o `ags peer queue`.
//!
//! Regras que valem para todo caminho que digita uma mensagem de agente:
//! - um destino de cada vez (`delivery_lock`);
//! - a mensagem sai da fila com `store::claim` (`queued` → `delivering`) numa só escrita, então
//!   nunca é digitada duas vezes, nem por duas threads nem depois de um reinício;
//! - o texto é lido do banco na hora da entrega: vale a versão que o usuário editou.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::peers::{caller, delivery_lock, outgoing, spill_to_inbox, stale_note, submit_confirmed};
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

/// O que aconteceu com uma mensagem: entregue já, na fila, repetida, sem confirmação ou cancelada.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Delivery { Now, Queued, Duplicate, Unconfirmed, Cancelled }

/// O resultado de mandar uma mensagem: o que aconteceu e o registro dela.
#[derive(Clone, Debug)]
pub(crate) struct Sent {
    pub delivery: Delivery,
    pub message: PeerMessage,
    /// O mesmo id do chamador já tinha sido usado: é a mesma mensagem, não foi de novo.
    pub repeat: bool,
}

fn now() -> i64 {
    crate::util::now_ts_ms()
}

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let db = super::shared::db(app)?;
    let conn = db.inner().lock().map_err(|e| e.to_string())?;
    f(&conn)
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
    let text = outgoing(&msg.from_name, body, msg.reply, msg.raw);
    match stale_note(waited).filter(|_| !msg.raw) {
        Some(note) => format!("{text}\n{note}"),
        None => text,
    }
}

/// Registra a mensagem. `Err(Sent)` = não vai (mesmo id já usado, ou repetida pelo texto).
fn admit(app: &AppHandle, new: &NewMessage<'_>, initial: State) -> Result<Result<PeerMessage, Sent>, String> {
    let admission = with_db(app, |conn| store::admit(conn, new, initial, now()))?;
    Ok(match admission {
        Admission::New(message) => Ok(message),
        Admission::Repeat(message) => Err(Sent { delivery: Delivery::Duplicate, message, repeat: true }),
        Admission::Duplicate(message) => Err(Sent { delivery: Delivery::Duplicate, message, repeat: false }),
    })
}

/// Digita uma mensagem já tomada da fila (`delivering`) e fecha o registro. `Ok(false)` = escrita,
/// mas não apareceu na tela.
fn type_claimed(app: &AppHandle, pty: u32, msg: &PeerMessage) -> Result<bool, String> {
    let waited = Duration::from_millis((now() - msg.created_at).max(0) as u64);
    // Mensagem longa vai inteira para um arquivo e no terminal só o começo e o caminho. Só o `tell`
    // com cabeçalho: era assim antes da fila (a pergunta e a linha da entrega vão inteiras).
    let body = if msg.kind == "tell" && !msg.raw { spill_to_inbox(&msg.to_tab_id, &msg.text) } else { msg.text.clone() };
    let result = submit_confirmed(pty, &compose(msg, &body, waited));
    let note = match &result {
        Ok(true) => None,
        Ok(false) => Some("O texto foi escrito no terminal do destino, mas não apareceu na tela dele.".to_string()),
        Err(error) => Some(error.clone()),
    };
    let _ = with_db(app, |conn| store::finish(conn, msg.id, matches!(result, Ok(true)), note.as_deref(), now()));
    changed(app, Some(&msg.to_tab_id));
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
            if first && !crate::canal::busy(&msg.to_tab_id) && wait_until_quiet(pty, QUIET, SENDER_WAIT, false) {
                let Some(claimed) = with_db(app, |conn| store::claim(conn, msg.id, now()))? else {
                    // O usuário a cancelou nesses segundos.
                    return Ok(Sent { delivery: Delivery::Cancelled, message: fresh(app, msg), repeat: false });
                };
                let confirmed = type_claimed(app, pty, &claimed)?;
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
    let _ = with_db(app, |conn| store::finish(conn, msg.id, error.is_none(), error, now()));
    changed(app, Some(&msg.to_tab_id));
}

/// Uma mensagem já registrada com este id do chamador, se houver.
pub(super) fn by_client_id(app: &AppHandle, from: &str, client_id: Option<&str>) -> Result<Option<PeerMessage>, String> {
    let Some(cid) = store::clean_client_id(client_id)? else { return Ok(None) };
    with_db(app, |conn| {
        conn.query_row(
            "SELECT id FROM peer_messages WHERE from_tab_id = ?1 AND client_id = ?2",
            rusqlite::params![from, cid],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .map_or(Ok(None), |id| store::get(conn, id))
    })
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

enum Turn { Ready, PtyGone, Empty }

/// Espera a vez da próxima mensagem: o destino quieto, o usuário pediu "enviar agora", ou o prazo
/// de `QUEUE_MAX_WAIT` dela acabou (aí vai mesmo assim, como antes).
fn wait_turn(app: &AppHandle, to: &str, pty: u32) -> Turn {
    loop {
        let head = match with_db(app, |conn| store::head(conn, to)) {
            Ok(Some(head)) => head,
            _ => return Turn::Empty,
        };
        if head.force_now {
            return Turn::Ready;
        }
        let left = head.created_at + QUEUE_MAX_WAIT.as_millis() as i64 - now();
        if left <= 0 {
            return Turn::Ready;
        }
        // `require_output`: um terminal que acabou de nascer (arranque do app) ainda não escreveu
        // nada; quieto assim não é "terminou o turno", é "a TUI nem abriu".
        if wait_until_quiet(pty, QUIET, Duration::from_millis(left as u64).min(WAIT_SLICE), true) {
            // Quieto na tela, mas o transcript diz que o turno segue aberto: espera mais uma fatia.
            // Só segura, nunca solta antes: sem canal (ou estado velho) `busy` é falso. O prazo de
            // `QUEUE_MAX_WAIT` continua valendo.
            if !crate::canal::busy(to) {
                return Turn::Ready;
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
                let _ = with_db(app, |conn| store::expire_queued_for(conn, to, "A aba de destino foi fechada.", now()));
                changed(app, Some(to));
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
        match wait_turn(app, to, pty) {
            Turn::Ready => {}
            Turn::PtyGone | Turn::Empty => continue,
        }
        // A próxima é lida de novo: enquanto esperava, o usuário pode ter reordenado ou cancelado.
        let Ok(Some(head)) = with_db(app, |conn| store::head(conn, to)) else { continue };
        let Ok(Some(claimed)) = with_db(app, |conn| store::claim(conn, head.id, now())) else { continue };
        let _ = type_claimed(app, pty, &claimed);
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
        let live: HashSet<String> = listed
            .get("tabs")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default();
        let Ok(targets) = with_db(&app, |conn| store::resume(conn, &live, now())) else { return };
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
    let msg = with_db(&app, |conn| store::edit(conn, id, &text, now()))?;
    changed(&app, Some(&msg.to_tab_id));
    Ok(msg)
}

/// Sobe (`delta` < 0) ou desce (> 0) uma casa. Devolve a fila nova.
#[tauri::command]
pub fn peer_queue_move(app: AppHandle, id: i64, delta: i64) -> Result<Vec<PeerMessage>, String> {
    let list = with_db(&app, |conn| store::move_by(conn, id, delta.signum(), now()))?;
    changed(&app, list.first().map(|m| m.to_tab_id.as_str()));
    Ok(list)
}

#[tauri::command]
pub fn peer_queue_cancel(app: AppHandle, id: i64) -> Result<PeerMessage, String> {
    let msg = with_db(&app, |conn| store::cancel(conn, id, "Cancelada pelo usuário.", now()))?;
    changed(&app, Some(&msg.to_tab_id));
    Ok(msg)
}

/// "Enviar agora": a mensagem vai para a frente e é digitada sem esperar o destino ficar quieto.
#[tauri::command]
pub fn peer_queue_send_now(app: AppHandle, id: i64) -> Result<PeerMessage, String> {
    let msg = with_db(&app, |conn| store::send_now(conn, id, now()))?;
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
            let rows = with_db(app, |conn| store::pending_from(conn, &from))?;
            let at = now();
            Ok(json!({ "messages": rows.iter().map(|m| summary(m, at)).collect::<Vec<_>>() }))
        }
        "cancel" => {
            let raw = client_id_arg(args).ok_or("Uso: ags peer queue cancel <id>")?;
            let id: i64 = raw.trim().trim_start_matches('#').parse().map_err(|_| "Use o número da mensagem: `ags peer queue cancel 12`.".to_string())?;
            let msg = with_db(app, |conn| store::get(conn, id))?.ok_or_else(|| format!("A mensagem #{id} não existe."))?;
            if msg.from_tab_id != from {
                return Err(format!("A mensagem #{id} não é sua: só quem mandou cancela pela CLI (o usuário cancela qualquer uma na interface)."));
            }
            let msg = with_db(app, |conn| store::cancel(conn, id, "Cancelada pelo remetente.", now()))?;
            changed(app, Some(&msg.to_tab_id));
            Ok(json!({ "cancelled": true, "message": summary(&msg, now()) }))
        }
        other => Err(format!("Ação desconhecida '{other}'. Use: ags peer queue [list|cancel <id>]")),
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
            delivered_at: None, edited_at: None, note: None,
        }
    }

    #[test]
    fn a_mensagem_que_esperou_leva_o_aviso_e_o_comando_raw_nao() {
        let quick = compose(&msg(false, false), "oi", Duration::from_secs(2));
        assert!(quick.starts_with("[Mensagem de Líder via ADE AGS] oi") && !quick.contains("na fila"), "{quick}");
        let late = compose(&msg(false, false), "oi", Duration::from_secs(300));
        assert!(late.contains("ficou na fila") && late.contains("5 min"), "{late}");
        assert_eq!(compose(&msg(true, false), "/compact", Duration::from_secs(300)), "/compact");
        assert!(compose(&msg(false, true), "?", Duration::ZERO).contains("Responda normalmente"));
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
