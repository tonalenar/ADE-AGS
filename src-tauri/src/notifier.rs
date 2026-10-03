//! Avisos del sistema operativo para lo que pasa mientras nadie mira la app.
//!
//! Los agentes trabajan solos: una misión termina, falla o se queda esperando una
//! aprobación mientras el usuario está en otra ventana, y antes nada se lo decía. Esto lee
//! el bus de eventos (`crate::bus`) y avisa de lo que pide una persona:
//!
//! - una misión terminó o falló;
//! - un agente espera una aprobación (como mucho un aviso cada [`APPROVAL_GAP`]);
//! - una cuenta llegó a su límite o se le rechazó la credencial.
//!
//! Solo si ninguna ventana de la app tiene el foco: si el usuario está mirándola, ya lo ve,
//! y un aviso encima es ruido. Se apaga con la configuración `notifications.enabled = false`.
//! El idioma lo deja el frontend en `ui.language` (ver `src/i18n/index.ts`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::bus::{self, Filter};
use crate::database::DbConnection;

const APPROVAL_GAP: Duration = Duration::from_secs(30);

/// Lo que se avisa, ya decidido. Separado de cómo se muestra para poder probarlo.
#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
    MissionDone { title: String },
    MissionFailed { title: String },
    ApprovalWaiting { pending: u64 },
    AccountProblem { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lang {
    Pt,
    En,
    Es,
}

impl Lang {
    pub fn parse(raw: Option<&str>) -> Lang {
        match raw.unwrap_or("pt-BR") {
            l if l.starts_with("es") => Lang::Es,
            l if l.starts_with("en") => Lang::En,
            _ => Lang::Pt,
        }
    }
}

/// `(título, cuerpo)` del aviso.
pub fn text(notice: &Notice, lang: Lang) -> (String, String) {
    use Lang::*;
    match (notice, lang) {
        (Notice::MissionDone { title }, Pt) => ("Missão concluída".into(), title.clone()),
        (Notice::MissionDone { title }, En) => ("Mission complete".into(), title.clone()),
        (Notice::MissionDone { title }, Es) => ("Misión terminada".into(), title.clone()),
        (Notice::MissionFailed { title }, Pt) => ("Missão falhou".into(), title.clone()),
        (Notice::MissionFailed { title }, En) => ("Mission failed".into(), title.clone()),
        (Notice::MissionFailed { title }, Es) => ("La misión falló".into(), title.clone()),
        (Notice::ApprovalWaiting { pending }, Pt) => {
            ("Aprovação pendente".into(), format!("{pending} pedido(s) de agente esperando você"))
        }
        (Notice::ApprovalWaiting { pending }, En) => {
            ("Approval needed".into(), format!("{pending} agent request(s) waiting for you"))
        }
        (Notice::ApprovalWaiting { pending }, Es) => {
            ("Aprobación pendiente".into(), format!("{pending} pedido(s) de agentes esperándote"))
        }
        (Notice::AccountProblem { reason }, Pt) => ("Problema numa conta".into(), reason.clone()),
        (Notice::AccountProblem { reason }, En) => ("Account problem".into(), reason.clone()),
        (Notice::AccountProblem { reason }, Es) => ("Problema con una cuenta".into(), reason.clone()),
    }
}

/// Lo que el notificador recuerda entre eventos, para no repetir avisos.
#[derive(Default)]
pub struct State {
    /// El último estado por el que se avisó de cada misión.
    missions: HashMap<String, String>,
    pending: u64,
    last_approval: Option<Instant>,
}

impl State {
    /// Qué avisar por una misión que cambió, con su estado y título actuales.
    pub fn on_mission(&mut self, id: &str, status: &str, title: &str) -> Option<Notice> {
        if !matches!(status, "done" | "failed") || self.missions.get(id).map(String::as_str) == Some(status) {
            return None;
        }
        self.missions.insert(id.to_string(), status.to_string());
        Some(if status == "done" {
            Notice::MissionDone { title: title.to_string() }
        } else {
            Notice::MissionFailed { title: title.to_string() }
        })
    }

    /// Solo cuando la cola CRECE: que se vacíe, o que se conteste una, no es para avisar.
    pub fn on_approvals(&mut self, pending: u64, now: Instant) -> Option<Notice> {
        let grew = pending > self.pending;
        self.pending = pending;
        if !grew || self.last_approval.is_some_and(|at| now.duration_since(at) < APPROVAL_GAP) {
            return None;
        }
        self.last_approval = Some(now);
        Some(Notice::ApprovalWaiting { pending })
    }
}

fn app_focused(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false))
}

fn enabled(db: &DbConnection) -> bool {
    crate::database::get_setting(db, "notifications.enabled").ok().flatten().as_deref() != Some("false")
}

fn mission_status(db: &DbConnection, id: &str) -> Option<(String, String)> {
    let conn = db.lock().ok()?;
    conn.query_row("SELECT status, title FROM missions WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()
}

/// Un aviso que pide un agente o una rotina (`ags notify`, un recordatorio): el mismo
/// aviso del sistema que usan las misiones, con las mismas reglas — solo si ninguna ventana
/// tiene el foco y no se apagó en la configuración. Devuelve si se mostró.
pub fn show_custom(app: &AppHandle, title: &str, body: &str) -> bool {
    let Some(db) = app.try_state::<DbConnection>() else { return false };
    if !enabled(&db) || app_focused(app) {
        return false;
    }
    app.notification().builder().title(title).body(body).show().is_ok()
}

/// Arranca el notificador en su propio hilo. Empieza desde lo que se publique de acá en
/// adelante: lo que pasó antes de abrir la app no es noticia.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(db) = app.try_state::<DbConnection>().map(|s| s.inner().clone()) else { return };
        let filter = Filter {
            topics: vec!["mission.changed".into(), "approvals.changed".into(), "account.failure".into()],
            ..Default::default()
        };
        let mut after = bus::since(0, &filter, 0).last_seq;
        let mut state = State::default();
        loop {
            let page = bus::wait(after, &filter, 100, Duration::from_secs(300));
            after = page.last_seq;
            for event in page.events {
                let notice = match event.topic.as_str() {
                    "mission.changed" => event
                        .mission_id
                        .as_deref()
                        .and_then(|id| mission_status(&db, id).and_then(|(status, title)| state.on_mission(id, &status, &title))),
                    "approvals.changed" => {
                        let pending = event.data.get("pending").and_then(|p| p.as_u64()).unwrap_or(0);
                        state.on_approvals(pending, Instant::now())
                    }
                    "account.failure" => event
                        .data
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .map(|reason| Notice::AccountProblem { reason: reason.to_string() }),
                    _ => None,
                };
                let Some(notice) = notice else { continue };
                if !enabled(&db) || app_focused(&app) {
                    continue;
                }
                let lang = Lang::parse(crate::database::get_setting(&db, "ui.language").ok().flatten().as_deref());
                let (title, body) = text(&notice, lang);
                let _ = app.notification().builder().title(title).body(body).show();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_mision_se_avisa_una_vez_por_estado_final() {
        let mut s = State::default();
        assert_eq!(s.on_mission("m", "running", "Demo"), None);
        assert_eq!(s.on_mission("m", "done", "Demo"), Some(Notice::MissionDone { title: "Demo".into() }));
        assert_eq!(s.on_mission("m", "done", "Demo"), None, "no se repite");
        // Un reintento que falla es otra noticia.
        assert_eq!(s.on_mission("m", "failed", "Demo"), Some(Notice::MissionFailed { title: "Demo".into() }));
    }

    #[test]
    fn las_aprobaciones_se_avisan_al_crecer_y_sin_insistir() {
        let mut s = State::default();
        let t0 = Instant::now();
        assert_eq!(s.on_approvals(1, t0), Some(Notice::ApprovalWaiting { pending: 1 }));
        // Otra enseguida: dentro del intervalo, no se insiste.
        assert_eq!(s.on_approvals(2, t0 + Duration::from_secs(5)), None);
        // Contestar una no es noticia.
        assert_eq!(s.on_approvals(1, t0 + Duration::from_secs(40)), None);
        // Una nueva pasado el intervalo, sí.
        assert_eq!(s.on_approvals(2, t0 + Duration::from_secs(45)), Some(Notice::ApprovalWaiting { pending: 2 }));
    }

    #[test]
    fn el_texto_sale_en_el_idioma_de_la_app() {
        let n = Notice::MissionDone { title: "Demo".into() };
        assert_eq!(text(&n, Lang::parse(Some("pt-BR"))).0, "Missão concluída");
        assert_eq!(text(&n, Lang::parse(Some("en"))).0, "Mission complete");
        assert_eq!(text(&n, Lang::parse(Some("es"))).0, "Misión terminada");
        assert_eq!(text(&n, Lang::parse(None)).0, "Missão concluída", "sin dato, el de la app: PT-BR");
    }
}
