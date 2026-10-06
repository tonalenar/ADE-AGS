/**
 * Estado del indicador de la pestaña de una misión, derivado de señales reales. Puro, sin React.
 * (Contrato compartido con el backend: si cambia, avisar al orquestador.)
 */
export type MissionIndicatorState = "working" | "waiting" | "needsYou" | "done" | "failed" | "idle";

export interface MissionIndicatorSignals {
  /** Estado de la misión: running | done | failed | cancelled | ... */
  status: string;
  /** Terminales de la misión con salida sostenida. */
  workingAgents: number;
  /** Algún terminal parado esperando aprobación/pregunta/alerta del detector. */
  needsAttention: boolean;
}

const IN_PROGRESS = new Set(["running", "paused", "reviewing", "starting"]);

export function deriveMissionIndicator(s: MissionIndicatorSignals): { state: MissionIndicatorState; workingCount: number } {
  if (s.status === "done") return { state: "done", workingCount: 0 };
  if (s.status === "failed" || s.status === "cancelled") return { state: "failed", workingCount: 0 };
  const workingCount = Math.max(0, Math.floor(s.workingAgents));
  if (s.needsAttention) return { state: "needsYou", workingCount };
  if (workingCount > 0) return { state: "working", workingCount };
  if (IN_PROGRESS.has(s.status)) return { state: "waiting", workingCount: 0 };
  return { state: "idle", workingCount: 0 };
}
