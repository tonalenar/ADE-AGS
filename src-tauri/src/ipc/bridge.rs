//! Puente CLI → frontend, para los comandos que el backend no puede resolver solo.
//!
//! Crear o cerrar una tab es estado del frontend (el store de Zustand es la fuente de
//! verdad mientras la app corre; SQLite es su reflejo, escrito con debounce). Si la CLI
//! insertara filas directo en SQLite, la ventana abierta seguiría mostrando lo de antes y
//! el próximo autosave pisaría el cambio.
//!
//! Entonces: se emite un evento a una ventana concreta, se espera su respuesta con un id
//! de correlación, y se devuelve eso a la CLI. Si nadie responde a tiempo se reporta
//! timeout en vez de quedar colgado.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// Cuánto se espera al frontend antes de darlo por no disponible. Generoso a propósito:
/// crear una tab implica montar una terminal y esperar los symlinks de sus skills.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

lazy_static::lazy_static! {
    /// Requests en vuelo, por id de correlación. Se saca la entrada al responder o al
    /// vencer el timeout, así el mapa no crece.
    static ref PENDING: Mutex<HashMap<String, Sender<Value>>> = Mutex::new(HashMap::new());
}

/// Último batimento que el frontend reportó (ver `ui_heartbeat`).
#[derive(Clone, Copy)]
struct LastBeat {
    at: Instant,
    lag_ms: u64,
    hidden: bool,
}

static LAST_BEAT: Mutex<Option<LastBeat>> = Mutex::new(None);
/// Cuántas requests vencieron su timeout desde que arrancó el app.
static TIMEOUTS: AtomicU64 = AtomicU64::new(0);
/// Pior lag reportado desde a última leitura de `window_report` (cada batimento traz o máximo do último segundo).
static LAG_PEAK: AtomicU64 = AtomicU64::new(0);

/// Qué dice el último batimento sobre por qué la ventana no respondió: separa "ventana oculta y
/// estrangulada" de "renderizador ocupado" (plan v2, I1). `since_ms` es hace cuánto llegó.
fn beat_diagnosis(beat: Option<(u64, u64, bool)>) -> String {
    match beat {
        None => "Nenhum batimento da interface foi recebido desde que o app abriu.".to_string(),
        Some((since_ms, lag_ms, hidden)) => format!(
            "Último batimento da interface há {since_ms} ms (lag {lag_ms} ms, janela {}).",
            if hidden { "oculta" } else { "visível" }
        ),
    }
}

/// Por qué la ventana no respondió, a partir del último batimento (plan v2, Fase 1.3, I5).
#[derive(Debug, PartialEq)]
enum Stall {
    /// La interfaz nunca avisó que estaba viva desde que abrió el app.
    NoBeat,
    /// La ventana estaba oculta o minimizada.
    Hidden,
    /// El batimento dejó de llegar con la ventana visible: el renderizador está trabado.
    Frozen { silent_ms: u64 },
    /// Late, pero con atraso grande: algo (una página pesada) ocupa el renderizador.
    Busy { lag_ms: u64 },
    /// Late sin atraso: la interfaz está sana y la acción simplemente no terminó a tiempo.
    Alive,
}

/// El batimento llega una vez por segundo: pasado esto sin noticias, el renderizador no está corriendo.
const STALE_BEAT_MS: u64 = 3_500;
/// Atraso del laço de eventos a partir del cual la interfaz se considera ocupada.
const BUSY_LAG_MS: u64 = 700;

fn classify_stall(beat: Option<(u64, u64, bool)>) -> Stall {
    match beat {
        None => Stall::NoBeat,
        Some((_, _, true)) => Stall::Hidden,
        Some((since_ms, _, false)) if since_ms > STALE_BEAT_MS => Stall::Frozen { silent_ms: since_ms },
        Some((_, lag_ms, false)) if lag_ms >= BUSY_LAG_MS => Stall::Busy { lag_ms },
        Some(_) => Stall::Alive,
    }
}

/// El texto del timeout: cada causa dice qué hacer (antes un solo mensaje mandaba traer la ventana al frente aunque ya lo estuviera).
fn timeout_message(timeout: Duration, beat: Option<(u64, u64, bool)>) -> String {
    let secs = timeout.as_secs();
    let diagnosis = beat_diagnosis(beat);
    match classify_stall(beat) {
        Stall::Hidden => format!(
            "A janela do ADE AGS está oculta ou minimizada e não respondeu em {secs} s. Peça ao usuário para trazê-la à frente e repita o comando; o navegador do canvas fica quase parado com a janela escondida. {diagnosis}"
        ),
        Stall::Frozen { silent_ms } => format!(
            "A interface do ADE AGS parou de responder há {} s (a janela está visível): o renderizador está travado, provavelmente por uma página pesada. Espere cerca de 30 s e confira com `ags portals`; não reenvie a ordem agora, ela pode ainda estar rodando. {diagnosis}",
            silent_ms / 1000
        ),
        Stall::Busy { lag_ms } => format!(
            "A interface do ADE AGS está ocupada (atraso de {lag_ms} ms) e não terminou em {secs} s, provavelmente por uma página pesada. Espere alguns segundos, leia o estado com `ags portal snapshot <portal>` e só então continue; evite várias ordens seguidas. {diagnosis}"
        ),
        Stall::Alive => format!(
            "A interface do ADE AGS está viva, mas a ação não terminou em {secs} s (navegação lenta ou ação longa). Confira com `ags portal snapshot <portal>` antes de repetir: a ação pode já ter acontecido. {diagnosis}"
        ),
        Stall::NoBeat => format!(
            "O ADE AGS ainda não recebeu nenhum sinal de vida da interface (a janela está abrindo ou travou ao carregar). Espere alguns segundos e repita; se persistir, peça ao usuário para olhar a janela. {diagnosis}"
        ),
    }
}

fn last_beat_snapshot() -> Option<(u64, u64, bool)> {
    let beat = (*LAST_BEAT.lock().ok()?)?;
    Some((beat.at.elapsed().as_millis() as u64, beat.lag_ms, beat.hidden))
}

/// Batimento barato (1/s) del renderizador: guarda el último lag y la visibilidad, y devuelve el
/// contador de timeouts para que el informe del `act` lo muestre.
#[tauri::command]
pub fn ui_heartbeat(lag_ms: Option<u64>, hidden: bool) -> u64 {
    // Sin `lag_ms` es solo una consulta del contador (fin del `act`), no un latido real.
    if let Some(lag_ms) = lag_ms {
        LAG_PEAK.fetch_max(lag_ms, Ordering::Relaxed);
        if let Ok(mut last) = LAST_BEAT.lock() {
            *last = Some(LastBeat { at: Instant::now(), lag_ms, hidden });
        }
    }
    TIMEOUTS.load(Ordering::Relaxed)
}

/// O que o batimento diz da janela agora, para `ags portals` (aceite da Fase 1): `lagPeakMs` é o pior lag desde a
/// leitura anterior (a leitura o zera), `silentMs` há quanto tempo não chega batimento.
pub fn window_report() -> Value {
    let peak = LAG_PEAK.swap(0, Ordering::Relaxed);
    let timeouts = TIMEOUTS.load(Ordering::Relaxed);
    match last_beat_snapshot() {
        Some((silent_ms, lag_ms, hidden)) => serde_json::json!({ "lagPeakMs": peak, "lastLagMs": lag_ms, "hidden": hidden, "silentMs": silent_ms, "timeouts": timeouts }),
        None => serde_json::json!({ "lagPeakMs": peak, "lastLagMs": null, "hidden": null, "silentMs": null, "timeouts": timeouts }),
    }
}

/// Progreso parcial del `act` por portal (plan v2, Fase 1.4): el frontend lo manda tras cada acción, y si la ventana se
/// traba y el puente vence, el error lleva lo que ya se había hecho en vez de perderlo.
static ACT_PROGRESS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// Tope del texto guardado por portal (el frontend ya lo recorta; esto protege el mapa).
const MAX_PROGRESS_BYTES: usize = 8 * 1024;

fn clip_progress(report: &str) -> String {
    if report.len() <= MAX_PROGRESS_BYTES {
        return report.to_string();
    }
    let mut end = MAX_PROGRESS_BYTES;
    while !report.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &report[..end])
}

#[tauri::command]
pub fn portal_act_progress(portal_id: String, report: String) {
    if let Ok(mut all) = ACT_PROGRESS.lock() {
        all.get_or_insert_with(HashMap::new).insert(portal_id, clip_progress(&report));
    }
}

/// Saca (y olvida) el progreso de un portal. `None` si no hubo ninguna acción.
pub fn take_act_progress(portal_id: &str) -> Option<String> {
    let mut all = ACT_PROGRESS.lock().ok()?;
    all.as_mut()?.remove(portal_id).filter(|r| !r.is_empty())
}

/// Anexa el progreso parcial a un error del puente (tiempo agotado u otro): el agente sabe qué ya se hizo y no lo repite.
pub fn with_partial_progress(error: String, progress: Option<String>) -> String {
    match progress {
        Some(done) => format!("{error}\n\n{done}\n\nO act pode ter continuado depois da queda: confira o estado com `ags portal snapshot <portal>` antes de repetir qualquer um desses passos."),
        None => error,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: String,
    /// Solo la ventana con este label debe atender la request (el evento llega a todas).
    target_label: String,
    command: String,
    args: Value,
}

/// Ventana a la que dirigir la request: la que el usuario pidió por `--window`, o
/// cualquiera abierta si no especificó.
fn resolve_target(app: &AppHandle, requested: Option<&str>) -> Result<String, String> {
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    if labels.is_empty() {
        return Err("O app não tem nenhuma janela aberta".to_string());
    }
    match requested {
        Some(label) => labels
            .into_iter()
            .find(|l| l == label)
            .ok_or_else(|| format!("Não há nenhuma janela com o label '{label}'")),
        // `webview_windows` no garantiza orden, así que se ordena para que dos llamadas
        // seguidas sin `--window` no caigan en ventanas distintas.
        None => {
            let mut sorted = labels;
            sorted.sort();
            Ok(sorted.remove(0))
        }
    }
}

/// Manda una request al frontend y espera su respuesta.
pub fn ask_frontend(
    app: &AppHandle,
    command: &str,
    args: &Value,
    window: Option<&str>,
) -> Result<Value, String> {
    ask_frontend_within(app, command, args, window, RESPONSE_TIMEOUT)
}

/// Igual que `ask_frontend`, con otro tope: lo que el frontend hace para responder puede
/// tardar más que crear una tab (esperar a que cargue una página, por ejemplo).
pub fn ask_frontend_within(
    app: &AppHandle,
    command: &str,
    args: &Value,
    window: Option<&str>,
    timeout: Duration,
) -> Result<Value, String> {
    let target_label = resolve_target(app, window)?;
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = channel();

    PENDING.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), tx);

    let payload = BridgeRequest {
        request_id: request_id.clone(),
        target_label,
        command: command.to_string(),
        args: args.clone(),
    };
    if let Err(e) = app.emit("cc-cli-request", payload) {
        PENDING.lock().ok().and_then(|mut p| p.remove(&request_id));
        return Err(format!("Não foi possível avisar a janela: {e}"));
    }

    let result = rx.recv_timeout(timeout).map_err(|_| {
        let count = TIMEOUTS.fetch_add(1, Ordering::Relaxed) + 1;
        let beat = last_beat_snapshot();
        eprintln!("[bridge] timeout #{count} em '{command}' após {} ms. {}", timeout.as_millis(), beat_diagnosis(beat));
        timeout_message(timeout, beat)
    });

    PENDING.lock().ok().and_then(|mut p| p.remove(&request_id));
    result
}

/// El frontend devuelve acá el resultado de una request del puente.
///
/// `error` viene separado de `data` para que el frontend pueda reportar un fallo de
/// negocio (por ejemplo, "no existe esa tab") sin que el puente tenga que adivinarlo
/// mirando la forma de `data`.
#[tauri::command]
pub fn cli_respond(
    request_id: String,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = PENDING.lock().map_err(|e| e.to_string())?.get(&request_id).cloned();
    let Some(sender) = sender else {
        // Llegó tarde (ya venció el timeout) o duplicada: se ignora en silencio, no es un
        // error del frontend.
        return Ok(());
    };

    let payload = match error {
        Some(msg) => serde_json::json!({ "__error": msg }),
        None => data.unwrap_or(Value::Null),
    };
    let _ = sender.send(payload);
    Ok(())
}

/// Desarma la convención de `__error` que usa `cli_respond` para transportar fallos.
pub fn unwrap_frontend_result(value: Value) -> Result<Value, String> {
    if let Some(msg) = value.get("__error").and_then(|v| v.as_str()) {
        return Err(msg.to_string());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_causa_do_timeout_tem_sua_classe() {
        assert_eq!(classify_stall(None), Stall::NoBeat);
        assert_eq!(classify_stall(Some((400, 0, true))), Stall::Hidden);
        // Oculta ganha de tudo, mesmo com o batimento velho: estrangulada.
        assert_eq!(classify_stall(Some((60_000, 9_000, true))), Stall::Hidden);
        assert_eq!(classify_stall(Some((20_000, 0, false))), Stall::Frozen { silent_ms: 20_000 });
        assert_eq!(classify_stall(Some((900, 1_500, false))), Stall::Busy { lag_ms: 1_500 });
        assert_eq!(classify_stall(Some((900, 40, false))), Stall::Alive);
        // Bordas: 3,5 s ainda é «viva»; o atraso de 700 ms já é «ocupada».
        assert_eq!(classify_stall(Some((STALE_BEAT_MS, 0, false))), Stall::Alive);
        assert_eq!(classify_stall(Some((10, BUSY_LAG_MS, false))), Stall::Busy { lag_ms: BUSY_LAG_MS });
    }

    #[test]
    fn as_mensagens_de_timeout_sao_distintas_e_dizem_o_que_fazer() {
        let t = Duration::from_secs(15);
        let cases = [
            (None, "ainda não recebeu nenhum sinal"),
            (Some((300, 0, true)), "oculta ou minimizada"),
            (Some((30_000, 0, false)), "parou de responder há 30 s"),
            (Some((500, 2_000, false)), "ocupada (atraso de 2000 ms)"),
            (Some((500, 10, false)), "está viva, mas a ação não terminou em 15 s"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (beat, needle) in cases {
            let msg = timeout_message(t, beat);
            assert!(msg.contains(needle), "{needle}: {msg}");
            assert!(seen.insert(msg.chars().take(40).collect::<String>()), "mensagem repetida: {msg}");
        }
        // «Traga à frente» só quando a janela está oculta; com a janela visível o texto não manda isso.
        assert!(timeout_message(t, Some((300, 0, true))).contains("trazê-la à frente"));
        assert!(!timeout_message(t, Some((500, 10, false))).contains("trazê-la à frente"));
        assert!(timeout_message(t, Some((30_000, 0, false))).contains("`ags portals`"));
    }

    #[test]
    fn o_progresso_parcial_se_guarda_se_recorta_e_se_esquece_ao_tirar() {
        assert_eq!(take_act_progress("p-nunca"), None);
        portal_act_progress("p-1".into(), "1. clicou @e3".into());
        portal_act_progress("p-1".into(), "1. clicou @e3\n2. digitou em @e5".into());
        assert_eq!(take_act_progress("p-1").as_deref(), Some("1. clicou @e3\n2. digitou em @e5"));
        assert_eq!(take_act_progress("p-1"), None);
        // Um texto enorme (com acento na borda) se corta sem quebrar o UTF-8.
        portal_act_progress("p-2".into(), "ã".repeat(MAX_PROGRESS_BYTES));
        let clipped = take_act_progress("p-2").unwrap();
        assert!(clipped.len() <= MAX_PROGRESS_BYTES + 4 && clipped.ends_with('…'));
    }

    #[test]
    fn o_erro_do_puente_leva_o_progresso_quando_ha() {
        let err = "A interface parou".to_string();
        assert_eq!(with_partial_progress(err.clone(), None), err);
        let msg = with_partial_progress(err, Some("Ações já feitas (1):\n1. clicou @e3".into()));
        assert!(msg.starts_with("A interface parou") && msg.contains("1. clicou @e3") && msg.contains("ags portal snapshot"));
    }

    #[test]
    fn o_relatorio_da_janela_guarda_o_pior_lag_ate_a_proxima_leitura() {
        ui_heartbeat(Some(900), false);
        ui_heartbeat(Some(120), false);
        let first = window_report();
        assert!(first["lagPeakMs"].as_u64().unwrap() >= 900, "{first}");
        assert_eq!(first["lastLagMs"], 120);
        assert_eq!(first["hidden"], false);
        // A leitura zera o pico: a próxima só vê o que veio depois.
        ui_heartbeat(Some(30), false);
        assert_eq!(window_report()["lagPeakMs"], 30);
    }

    #[test]
    fn diagnostico_sem_batimento() {
        assert!(beat_diagnosis(None).contains("Nenhum batimento"));
    }

    #[test]
    fn diagnostico_diz_ha_quanto_tempo_lag_e_visibilidade() {
        let oculta = beat_diagnosis(Some((4200, 950, true)));
        assert!(oculta.contains("há 4200 ms") && oculta.contains("lag 950 ms") && oculta.contains("oculta"));
        assert!(beat_diagnosis(Some((10, 0, false))).contains("visível"));
    }
}
