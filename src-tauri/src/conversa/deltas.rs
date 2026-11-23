//! Junta os deltas de texto do chat estruturado numa janela curta antes de mandá-los à janela.
//!
//! Cada motor recebe o texto token a token; um `app.emit` por token faz o front desserializar e
//! reaplicar o mesmo texto uma vez por listener. Aqui os deltas do mesmo item e do mesmo tipo,
//! seguidos, viram um só, e a fila sai ou quando a janela de [`JANELA`] vence ou antes de
//! qualquer outro evento da conversa (`events::emit`), para a ordem nunca mudar. Nada é gravado:
//! o banco guarda o item completo.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::events::EVENT;

/// A mesma janela do PTY (`terminal::pty_manager::JANELA_LOTE`).
pub const JANELA: Duration = Duration::from_millis(16);

/// Um trecho de texto de um item.
#[derive(Debug, Clone, PartialEq)]
pub struct Entrada {
    pub item_id: String,
    pub kind: String,
    pub text: String,
}

/// A fila de deltas por conversa. Pura.
#[derive(Default)]
pub struct Coalescer {
    fila: HashMap<String, Vec<Entrada>>,
}

impl Coalescer {
    /// Acrescenta um delta. `true` quando abriu uma janela nova (quem chama agenda o escoamento).
    pub fn push(&mut self, thread_id: &str, item_id: &str, kind: &str, delta: &str) -> bool {
        let abriu = !self.fila.contains_key(thread_id);
        let fila = self.fila.entry(thread_id.to_string()).or_default();
        match fila.last_mut() {
            Some(ultima) if ultima.item_id == item_id && ultima.kind == kind => ultima.text.push_str(delta),
            _ => fila.push(Entrada { item_id: item_id.to_string(), kind: kind.to_string(), text: delta.to_string() }),
        }
        abriu
    }

    /// Tira o que está esperando, na ordem de chegada.
    pub fn take(&mut self, thread_id: &str) -> Vec<Entrada> {
        self.fila.remove(thread_id).unwrap_or_default()
    }
}

/// O payload de `cc-chat-thread` de um delta (o mesmo formato de antes da junção).
pub fn payload(thread_id: &str, entrada: &Entrada) -> Value {
    json!({ "threadId": thread_id, "type": "delta", "itemId": entrada.item_id, "delta": entrada.text, "kind": entrada.kind })
}

fn fila() -> &'static Mutex<Coalescer> {
    static FILA: OnceLock<Mutex<Coalescer>> = OnceLock::new();
    FILA.get_or_init(|| Mutex::new(Coalescer::default()))
}

/// Põe um delta na fila e, se abriu a janela, agenda o escoamento para daqui a [`JANELA`].
pub fn emit_delta(app: &AppHandle, thread_id: &str, item_id: &str, delta: &str, kind: &str) {
    let abriu = fila().lock().unwrap_or_else(|e| e.into_inner()).push(thread_id, item_id, kind, delta);
    if abriu {
        let app = app.clone();
        let thread_id = thread_id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(JANELA).await;
            flush(&app, &thread_id);
        });
    }
}

/// Manda agora o que está na fila da conversa. Segura o lock durante o envio: dois escoamentos
/// concorrentes não trocam a ordem.
pub fn flush(app: &AppHandle, thread_id: &str) {
    let mut fila = fila().lock().unwrap_or_else(|e| e.into_inner());
    for entrada in fila.take(thread_id) {
        let _ = app.emit(EVENT, payload(thread_id, &entrada));
    }
}
