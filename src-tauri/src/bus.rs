//! El bus de eventos de la ADE: un solo lugar por donde pasa lo que ocurre en la flota y
//! en las misiones, con orden, historia corta y la misma forma para todos.
//!
//! Antes había un canal por cosa (`cc-task-event`, `cc-task-changed`, `cc-mission-changed`,
//! `cc-task-approvals`), cada uno con su formato, sin número de orden y sin historia: quien
//! se suscribía tarde (una ventana nueva, la CLI, un agente lead) no tenía cómo saber qué se
//! perdió. Esos canales siguen existiendo —las pantallas los usan— y ADEMÁS todo pasa por acá.
//!
//! - **Orden**: cada evento tiene un `seq` creciente. "Dame lo que pasó después del 42"
//!   (`since`) alcanza para ponerse al día sin perder ni repetir nada.
//! - **Historia corta**: los últimos [`CAPACITY`] eventos en memoria. No es un log: lo que
//!   hay que conservar ya vive en la base (tareas, `usage_events`, el NDJSON de cada tarea).
//!   Si alguien pide un `seq` que ya salió del buffer, la respuesta lo dice (`truncated`).
//! - **Esperar sin sondear** (`wait`): bloquea hasta que llega algo nuevo o vence el plazo.
//!   Es lo que usan la CLI (`ags events wait`) y el Map Mode.
//! - **Hacia la UI**: un único evento Tauri, [`EVENT`], con el evento entero.
//!
//! Publicar nunca toma el lock de la base: se llama desde lugares que a veces lo tienen
//! tomado, y un `Mutex` no reentrante ahí sería un deadlock.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// El evento Tauri por el que la UI recibe todo el bus.
pub const EVENT: &str = "ade-event";

/// Cuántos eventos se recuerdan. Una misión con varios workers emite unos pocos por segundo
/// (la actividad de las herramientas); 2000 cubren varios minutos de atraso.
pub const CAPACITY: usize = 2000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BusEvent {
    pub seq: u64,
    /// Epoch en milisegundos.
    pub at: i64,
    /// `task.changed`, `task.activity`, `task.rerouted`, `mission.changed`,
    /// `approvals.changed`, `account.failure`, `mission.review`.
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub data: Value,
}

/// Lo que se publica; el `seq` y la hora los pone el bus.
#[derive(Debug, Clone, Default)]
pub struct Publish {
    pub topic: &'static str,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub mission_id: Option<String>,
    pub data: Value,
}

impl Publish {
    pub fn new(topic: &'static str) -> Self {
        Publish { topic, ..Default::default() }
    }
    pub fn task(mut self, id: &str) -> Self {
        self.task_id = Some(id.to_string());
        self
    }
    pub fn run(mut self, id: &str) -> Self {
        self.run_id = Some(id.to_string());
        self
    }
    pub fn mission(mut self, id: &str) -> Self {
        self.mission_id = Some(id.to_string());
        self
    }
    pub fn data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
}

static SEQ: AtomicU64 = AtomicU64::new(0);

lazy_static::lazy_static! {
    static ref RING: (Mutex<VecDeque<BusEvent>>, Condvar) = (Mutex::new(VecDeque::with_capacity(CAPACITY)), Condvar::new());
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lo guarda, despierta a quien espera y (con `app`) se lo manda a la UI. Devuelve su `seq`.
pub fn publish<R: tauri::Runtime>(app: Option<&tauri::AppHandle<R>>, event: Publish) -> u64 {
    let (lock, cvar) = &*RING;
    let stored = {
        let mut ring = lock.lock().unwrap_or_else(|e| e.into_inner());
        // El seq se toma con el lock: así el buffer queda siempre en orden.
        let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        let stored = BusEvent {
            seq,
            at: now_ms(),
            topic: event.topic.to_string(),
            task_id: event.task_id,
            run_id: event.run_id,
            mission_id: event.mission_id,
            data: event.data,
        };
        if ring.len() == CAPACITY {
            ring.pop_front();
        }
        ring.push_back(stored.clone());
        stored
    };
    cvar.notify_all();
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(EVENT, &stored);
    }
    stored.seq
}

/// Qué eventos le interesan a quien pregunta. Vacío = todos.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Prefijos de tópico: `task.` trae `task.changed` y `task.activity`.
    pub topics: Vec<String>,
    pub run_id: Option<String>,
    pub mission_id: Option<String>,
    pub task_id: Option<String>,
}

impl Filter {
    pub fn matches(&self, e: &BusEvent) -> bool {
        let same = |want: &Option<String>, got: &Option<String>| want.is_none() || want == got;
        (self.topics.is_empty() || self.topics.iter().any(|t| e.topic.starts_with(t.as_str())))
            && same(&self.run_id, &e.run_id)
            && same(&self.mission_id, &e.mission_id)
            && same(&self.task_id, &e.task_id)
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<BusEvent>,
    /// Cursor: o `seq` do último evento **entregue** nesta página (quando ela encheu o `limit`);
    /// se a varredura chegou ao fim do anel, o `seq` global, para não reler o que só não passou no filtro.
    pub last_seq: u64,
    /// Se pidió desde un `seq` que ya salió del buffer: puede faltar algo en el medio.
    pub truncated: bool,
}

fn page_after(ring: &VecDeque<BusEvent>, after: u64, filter: &Filter, limit: usize) -> Page {
    let oldest = ring.front().map(|e| e.seq).unwrap_or(0);
    let truncated = after > 0 && oldest > after.saturating_add(1);
    let head = SEQ.load(Ordering::SeqCst);
    // `limit=0` é só o cursor da cabeça: quem espera começa do que já foi publicado, sem histórico.
    if limit == 0 {
        return Page { events: Vec::new(), last_seq: head, truncated };
    }
    let mut events = Vec::new();
    let mut last_delivered: Option<u64> = None;
    let mut scanned_to = after;
    for event in ring.iter() {
        if event.seq <= after {
            continue;
        }
        scanned_to = event.seq;
        if !filter.matches(event) {
            continue;
        }
        if events.len() >= limit {
            // A página encheu: o cursor fica no último entregue, para a próxima chamada pegar este.
            break;
        }
        last_delivered = Some(event.seq);
        events.push(event.clone());
    }
    let last_seq = if events.len() >= limit {
        last_delivered.unwrap_or(after)
    } else {
        // Varreu o anel inteiro: avança até o fim, inclusive o que não passou no filtro.
        head.max(scanned_to)
    };
    Page { events, last_seq, truncated }
}

/// Lo que pasó después de `after`, hasta `limit` eventos.
pub fn since(after: u64, filter: &Filter, limit: usize) -> Page {
    let ring = RING.0.lock().unwrap_or_else(|e| e.into_inner());
    page_after(&ring, after, filter, limit)
}

/// Como [`since`], pero si todavía no hay nada que cumpla el filtro espera hasta `timeout`.
pub fn wait(after: u64, filter: &Filter, limit: usize, timeout: Duration) -> Page {
    let (lock, cvar) = &*RING;
    let deadline = Instant::now() + timeout;
    let mut ring = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let page = page_after(&ring, after, filter, limit);
        let now = Instant::now();
        if !page.events.is_empty() || now >= deadline {
            return page;
        }
        ring = match cvar.wait_timeout(ring, deadline - now) {
            Ok((guard, _)) => guard,
            Err(e) => e.into_inner().0,
        };
    }
}

/// Para la UI: ponerse al día al abrir una vista (el Map Mode) antes de escuchar [`EVENT`].
#[tauri::command]
pub fn bus_since(after: u64, filter: Option<Filter>, limit: Option<usize>) -> Page {
    since(after, &filter.unwrap_or_default(), limit.unwrap_or(500).clamp(1, CAPACITY))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pub_(topic: &'static str, run: &str) -> u64 {
        publish::<tauri::Wry>(None, Publish::new(topic).run(run))
    }

    /// `since(u64::MAX, ..)` é como quem espera pega o `seq` de agora sem ler eventos
    /// (`ags chat wait`, `peer ask` a conversa do time): somar 1 estourava no debug e a thread do
    /// comando morria, e a CLI via só "sem resposta".
    #[test]
    fn pedir_desde_o_maior_seq_nao_estoura() {
        let page = since(u64::MAX, &Filter::default(), 1);
        assert!(page.events.is_empty());
        assert!(!page.truncated);
    }

    #[test]
    fn se_pone_al_dia_desde_un_seq_sin_perder_ni_repetir() {
        let run = format!("r-{}", uuid::Uuid::new_v4());
        let filter = Filter { run_id: Some(run.clone()), ..Default::default() };
        let start = since(0, &filter, 0).last_seq;
        let a = pub_("task.changed", &run);
        let b = pub_("task.activity", &run);
        let page = since(start, &filter, 100);
        assert_eq!(page.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![a, b]);
        // Desde el último visto, nada repetido.
        assert!(since(b, &filter, 100).events.is_empty());
        // Por prefijo de tópico.
        let only = Filter { topics: vec!["task.act".into()], run_id: Some(run), ..Default::default() };
        assert_eq!(since(start, &only, 100).events.len(), 1);
    }

    #[test]
    fn esperar_devuelve_apenas_llega_algo() {
        let run = format!("r-{}", uuid::Uuid::new_v4());
        let filter = Filter { run_id: Some(run.clone()), ..Default::default() };
        let after = since(0, &filter, 0).last_seq;
        let publisher = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            pub_("mission.changed", &run)
        });
        let started = Instant::now();
        let page = wait(after, &filter, 10, Duration::from_secs(5));
        let seq = publisher.join().unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].seq, seq);
        assert!(started.elapsed() < Duration::from_secs(4), "no esperó al plazo entero");
        // Sin nada nuevo, vuelve vacío al vencer.
        assert!(wait(seq, &filter, 10, Duration::from_millis(30)).events.is_empty());
    }

    /// Sobre un buffer propio y no el global: llenar el global en un test expulsaría los
    /// eventos de los otros tests que corren en paralelo.
    /// A223: a página que não cabe no `limit` não pode fazer o cursor pular o que sobrou. 10 eventos com `limit=3`:
    /// 4 chamadas, seguindo `last_seq`, devolvem os 10 na ordem, sem buraco.
    #[test]
    fn cursor_nao_pula_eventos_alem_do_limit() {
        let run = format!("r-{}", uuid::Uuid::new_v4());
        let filter = Filter { run_id: Some(run.clone()), ..Default::default() };
        let mut after = since(0, &filter, 0).last_seq;
        let publicados: Vec<u64> = (0..10).map(|_| pub_("task.changed", &run)).collect();
        let mut lidos = Vec::new();
        for _ in 0..4 {
            let page = since(after, &filter, 3);
            lidos.extend(page.events.iter().map(|e| e.seq));
            after = page.last_seq;
        }
        assert_eq!(lidos, publicados, "um evento ficou para trás entre as páginas");
    }

    /// A página que esgota as correspondências avança o cursor até o fim do anel, para não reler o que só não passou
    /// no filtro (e não marcar `truncated` por isso). Sem isso, um filtro raro reportava perda que não existe.
    #[test]
    fn pagina_que_esgota_as_correspondencias_avanca_ate_o_fim_do_anel() {
        let run = format!("r-{}", uuid::Uuid::new_v4());
        let filter = Filter { run_id: Some(run.clone()), ..Default::default() };
        let after = since(0, &filter, 0).last_seq;
        let mine = pub_("task.changed", &run);
        let other = pub_("task.changed", &format!("{run}-outro"));
        let page = since(after, &filter, 10);
        assert_eq!(page.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![mine]);
        assert!(page.last_seq >= other, "o cursor parou antes de um evento que a varredura já examinou");
    }

    /// `limit=0` é o "cabeça" do anel: quem só quer o cursor (o notificador, os esperadores) começa do que já foi
    /// publicado, sem receber o histórico do filtro.
    #[test]
    fn limite_zero_devolve_a_cabeca_do_anel() {
        let run = format!("r-{}", uuid::Uuid::new_v4());
        let filter = Filter { run_id: Some(run.clone()), ..Default::default() };
        pub_("task.changed", &run);
        let last = pub_("task.changed", &run);
        let page = since(0, &filter, 0);
        assert!(page.events.is_empty());
        assert!(page.last_seq >= last);
    }

    #[test]
    fn avisa_cuando_lo_pedido_ya_salio_del_buffer() {
        let evento = |seq| BusEvent { seq, at: 0, topic: "task.changed".into(), task_id: None, run_id: None, mission_id: None, data: Value::Null };
        let ring: VecDeque<BusEvent> = (50..60).map(evento).collect();
        assert!(page_after(&ring, 10, &Filter::default(), 5).truncated, "faltan del 11 al 49");
        assert!(!page_after(&ring, 49, &Filter::default(), 5).truncated, "el 50 es el siguiente");
        assert!(!page_after(&ring, 0, &Filter::default(), 5).truncated, "desde el principio no se reclama nada");
    }
}
