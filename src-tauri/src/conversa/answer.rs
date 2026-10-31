//! Responder a um pedido de aprovação do agente UMA vez só. O pedido pode ser respondido pela pessoa (a tela), pela política
//! do time ou por uma regra dela (`conversa::permission`), e a varredura roda enquanto a pessoa decide: antes, a resposta
//! ia ao agente e só DEPOIS o banco marcava `answered`, então duas respostas juntas chegavam as duas ao agente.
//!
//! Agora a ordem é: (1) a trava do pedido (`gate`), (2) a RESERVA atômica no banco (`claimed_at`, só se `state = 'pending'`
//! e sem reserva vigente), (3) o envio ao agente, (4) `answered`. Quem perde a reserva não envia nada. Se o envio falha, a
//! reserva é devolvida e o pedido segue `pending` para a pessoa. A reserva esquecida (processo que morreu no meio) vence
//! em [`CLAIM_LEASE_MS`]. Quando a PESSOA responde, a decisão dela vence a automática que chega junto: a automática, ao
//! pegar a trava, vê que a pessoa está na fila e desiste (o pedido segue `pending` até a pessoa responder).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use crate::database::DbConnection;

use super::store::{self, RequestRow};

/// Quanto vale a reserva de um pedido antes de ser considerada esquecida.
pub const CLAIM_LEASE_MS: i64 = 30_000;

fn gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(Default::default)
}

fn people() -> &'static Mutex<HashSet<String>> {
    static PEOPLE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PEOPLE.get_or_init(Default::default)
}

/// A pessoa está respondendo este pedido. Enquanto o guarda existir, a decisão automática não envia nada.
pub struct PersonGuard(String);

pub fn enter_person(request_id: &str) -> PersonGuard {
    people().lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.to_string());
    PersonGuard(request_id.to_string())
}

impl Drop for PersonGuard {
    fn drop(&mut self) {
        people().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

fn person_waiting(request_id: &str) -> bool {
    people().lock().unwrap_or_else(|e| e.into_inner()).contains(request_id)
}

/// Responde ao pedido `request_id` com `choice`, chamando `send` (que fala com o agente) UMA vez no máximo.
/// `Ok(true)` = respondeu; `Ok(false)` = não era mais dele (já respondido, reservado por outro, ou a pessoa tem a vez);
/// `Err` = o pedido não existe ou o envio falhou (a reserva volta e o pedido segue pendente).
pub fn answer_core(
    db: &DbConnection,
    request_id: &str,
    choice: &str,
    by: &str,
    why: Option<&str>,
    send: &dyn Fn(&RequestRow, &str) -> Result<(), String>,
) -> Result<bool, String> {
    let person = by == "person";
    // A pessoa entra na fila ANTES de esperar a trava: a automática que ainda não a pegou desiste.
    let _person = person.then(|| enter_person(request_id));
    let gate = gates().lock().unwrap_or_else(|e| e.into_inner()).entry(request_id.to_string()).or_default().clone();
    let result = {
        let _held = gate.lock().unwrap_or_else(|e| e.into_inner());
        run(db, request_id, choice, by, why, send, person)
    };
    // O mapa não cresce: sai quando ninguém mais espera esta trava.
    let mut map = gates().lock().unwrap_or_else(|e| e.into_inner());
    if map.get(request_id).is_some_and(|g| Arc::strong_count(g) <= 2) {
        map.remove(request_id);
    }
    result
}

fn run(db: &DbConnection, request_id: &str, choice: &str, by: &str, why: Option<&str>, send: &dyn Fn(&RequestRow, &str) -> Result<(), String>, person: bool) -> Result<bool, String> {
    if !person && person_waiting(request_id) {
        return Ok(false);
    }
    let now = crate::util::now_ts_ms();
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let row = store::request(&conn, request_id).map_err(|e| e.to_string())?.ok_or("Pedido não encontrado")?;
        if row.state != "pending" || !store::reserve_request(&conn, request_id, now, CLAIM_LEASE_MS).map_err(|e| e.to_string())? {
            return Ok(false);
        }
        row
    };
    if let Err(error) = send(&row, choice) {
        if let Ok(conn) = db.lock() {
            let _ = store::release_request(&conn, request_id);
        }
        return Err(error);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::answer_request_by(&conn, request_id, choice, crate::util::now_ts_ms(), by, why).map_err(|e| e.to_string())
}
