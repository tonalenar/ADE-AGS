//! Qué ventana se abre con el event loop, y cuáles esperan a que esa pinte.
//!
//! Crear cada WebView antes de soltar el loop aplaza el primer cuadro de la
//! principal. Tauri ya creó la etiquetada `main`; esa se reposiciona ahora y las
//! demás se guardan hasta que el frontend avisa que el cuadro ya está en pantalla.
//! Si no hay fila `main`, se crea la usada más recientemente y el resto espera igual.

use std::sync::Mutex;
use std::time::Duration;

use crate::database::WindowRow;

/// El plan de un arranque: una ventana ya, el resto después del primer cuadro.
pub fn plan_startup_restore(rows: Vec<WindowRow>) -> (Vec<WindowRow>, Vec<WindowRow>) {
    let mut later = Vec::new();
    let mut primary = Vec::new();
    for row in rows {
        if row.label == "main" && primary.is_empty() {
            primary.push(row);
        } else {
            later.push(row);
        }
    }
    if primary.is_empty()
        && let Some(index) = later
            .iter()
            .enumerate()
            .max_by_key(|(_, row)| row.last_active)
            .map(|(index, _)| index)
    {
        primary.push(later.remove(index));
    }
    (primary, later)
}

/// Las filas que todavía no se convirtieron en WebView.
///
/// `on_primary_frame` (ou o prazo do backend) es el único camino que las suelta. Un aviso que llega antes
/// de `stage` no las descarta: el splash de migración pinta un cuadro antes de que
/// las filas existan.
#[derive(Debug)]
pub struct RestoreGate {
    deferred: Vec<WindowRow>,
    armed: bool,
    released: bool,
}

impl RestoreGate {
    fn idle() -> Self {
        Self {
            deferred: Vec::new(),
            armed: false,
            released: false,
        }
    }

    #[cfg(test)]
    fn hold(rows: Vec<WindowRow>) -> Self {
        Self {
            deferred: rows,
            armed: true,
            released: false,
        }
    }

    fn stage(&mut self, rows: Vec<WindowRow>) {
        if self.released {
            return;
        }
        self.deferred = rows;
        self.armed = true;
    }

    #[cfg(test)]
    fn pending(&self) -> &[WindowRow] {
        &self.deferred
    }

    fn on_primary_frame(&mut self) -> Vec<WindowRow> {
        if !self.armed || self.released {
            return Vec::new();
        }
        self.released = true;
        std::mem::take(&mut self.deferred)
    }

    /// Sem o quadro da principal, o prazo solta as mesmas janelas que `on_primary_frame`.
    fn on_deadline(&mut self, decorrido: Duration, prazo: Duration) -> Vec<WindowRow> {
        if decorrido < prazo {
            return Vec::new();
        }
        self.on_primary_frame()
    }
}

/// Prazo para o primeiro quadro da principal chegar. Passado, as janelas adiadas abrem mesmo sem o front confirmar.
pub const DEFERRED_RESTORE_DEADLINE: Duration = Duration::from_secs(10);

/// Estado de Tauri: las ventanas que el arranque dejó para después del primer cuadro.
pub struct DeferredRestore {
    gate: Mutex<RestoreGate>,
}

impl DeferredRestore {
    pub fn empty() -> Self {
        Self {
            gate: Mutex::new(RestoreGate::idle()),
        }
    }

    pub fn stage(&self, rows: Vec<WindowRow>) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.stage(rows);
        }
    }

    pub fn on_primary_frame(&self) -> Vec<WindowRow> {
        self.gate
            .lock()
            .map(|mut gate| gate.on_primary_frame())
            .unwrap_or_default()
    }

    /// Chamado pelo prazo do backend (ver `arm_deferred_deadline`). Quem cronometra passa o tempo decorrido.
    pub fn on_deadline(&self, decorrido: Duration, prazo: Duration) -> Vec<WindowRow> {
        self.gate
            .lock()
            .map(|mut gate| gate.on_deadline(decorrido, prazo))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(label: &str, last_active: i64) -> WindowRow {
        WindowRow {
            id: label.to_string(),
            label: label.to_string(),
            workspace_id: "default".into(),
            pos_x: None,
            pos_y: None,
            width: None,
            height: None,
            monitor: None,
            is_open: true,
            last_active,
        }
    }

    #[test]
    fn la_restauracion_no_abre_las_otras_antes_del_frame_de_la_principal() {
        let (now, later) =
            plan_startup_restore(vec![row("side", 50), row("main", 1), row("other", 10)]);
        assert_eq!(now.len(), 1, "solo la principal se abre con el event loop");
        assert_eq!(now[0].label, "main");

        let mut gate = RestoreGate::hold(later);
        assert_eq!(gate.pending().len(), 2);
        assert!(gate.pending().iter().all(|row| row.label != "main"));
        assert!(!gate.released);

        let opened = gate.on_primary_frame();
        assert_eq!(opened.len(), 2);
        let mut labels: Vec<_> = opened.iter().map(|row| row.label.as_str()).collect();
        labels.sort();
        assert_eq!(labels, ["other", "side"]);
        assert!(
            gate.on_primary_frame().is_empty(),
            "un segundo aviso no las vuelve a abrir"
        );
        assert!(gate.pending().is_empty());
    }

    #[test]
    fn sin_fila_main_la_mas_reciente_va_primero() {
        let (now, later) = plan_startup_restore(vec![row("a", 2), row("b", 9), row("c", 4)]);
        assert_eq!(now[0].label, "b");
        assert_eq!(later.len(), 2);
        assert!(later.iter().all(|row| row.label != "b"));
    }

    #[test]
    fn un_frame_antes_de_armar_no_pierde_las_ventanas() {
        let mut gate = RestoreGate::idle();
        assert!(gate.on_primary_frame().is_empty());
        assert!(!gate.released);
        gate.stage(vec![row("a", 1), row("b", 2)]);
        assert_eq!(gate.on_primary_frame().len(), 2);
    }

    /// Sem o quadro da principal, o prazo abre as janelas adiadas. Antes do prazo, nada abre.
    #[test]
    fn sem_primeiro_quadro_o_prazo_abre_as_janelas_adiadas() {
        let prazo = DEFERRED_RESTORE_DEADLINE;
        let mut gate = RestoreGate::hold(vec![row("a", 1), row("b", 2)]);
        assert!(
            gate.on_deadline(prazo - Duration::from_millis(1), prazo).is_empty(),
            "antes do prazo nada abre"
        );
        assert_eq!(gate.on_deadline(prazo, prazo).len(), 2, "no prazo, as adiadas abrem sem o quadro");
        assert!(gate.on_primary_frame().is_empty(), "o quadro atrasado não abre de novo");
    }

    /// Se o quadro chega antes do prazo, o prazo depois não reabre nada.
    #[test]
    fn quadro_antes_do_prazo_nao_deixa_o_prazo_reabrir() {
        let prazo = DEFERRED_RESTORE_DEADLINE;
        let mut gate = RestoreGate::hold(vec![row("a", 1)]);
        assert_eq!(gate.on_primary_frame().len(), 1);
        assert!(gate.on_deadline(prazo * 2, prazo).is_empty());
    }
}
