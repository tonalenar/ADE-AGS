//! O laço da entrega assíncrona do resultado do filho ao pai (contrato §12.9). Sem polling: dorme no barramento
//! (`chat.changed`, `task.changed`, `peer.message`) e, a cada acordar, chama `harness::child_delivery::pump`, que só
//! lê o banco e grava o aviso na fila durável do pai. Quem entrega ao pai é o entregador da fila, que espera o pai
//! ficar livre: esta rotina nunca escreve numa conversa nem num terminal e nunca interrompe um turno.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::peer_queue::{changed, ensure_worker};
use crate::harness::child_delivery;

/// Sem evento nenhum, o laço só confere de hora em hora (um evento perdido não prende uma entrega para sempre). Não é
/// varredura: a leitura é barata e idempotente.
const IDLE_RECHECK: Duration = Duration::from_secs(3600);

/// Um dono por processo para os efeitos de entrega: o lease distingue este app de um que caiu.
fn owner() -> &'static str {
    static OWNER: OnceLock<String> = OnceLock::new();
    OWNER.get_or_init(|| format!("child-delivery:{}", uuid::Uuid::new_v4()))
}

/// Liga o laço no arranque do app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        crate::database::wait_until_db_ready();
        run(&app);
    });
}

fn run(app: &AppHandle) {
    let filter = crate::bus::Filter {
        topics: vec![super::conversas::BUS_TOPIC.into(), "task.changed".into(), "peer.message".into()],
        ..Default::default()
    };
    loop {
        // O ponto de partida vem ANTES da passada: um evento durante ela não se perde.
        let mut after = crate::bus::since(u64::MAX, &filter, 1).last_seq;
        pump_now(app);
        let deadline = Instant::now() + IDLE_RECHECK;
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

/// Uma passada: vê os fins, entrega o que está pronto e acorda o entregador de cada destino. Também roda no fim do
/// boot (depois de `recover_expired` e das varreduras), para o filho que terminou com o app fechado.
pub fn pump_now(app: &AppHandle) {
    let result = (|| {
        let db = super::shared::db(app)?;
        let conn = db.inner().lock().map_err(|error| error.to_string())?;
        child_delivery::pump(&conn, owner(), crate::util::now_ts_ms())
    })();
    match result {
        Ok(report) => {
            // O lock do banco já foi solto: acordar o entregador fala com a fila.
            for message in &report.queued {
                changed(app, Some(&message.to_tab_id));
                ensure_worker(app, &message.to_tab_id);
            }
            if report.failed > 0 {
                eprintln!("[harness] {} entrega(s) de resultado de filho falharam e serão tentadas de novo", report.failed);
            }
        }
        Err(error) => eprintln!("[harness] não foi possível entregar resultados de filhos: {error}"),
    }
}
