import { invoke } from "@tauri-apps/api/core";

/** Ver `missions::timings` en Rust: las etapas de una misión que se miden. */
export type TimingKind = "boot" | "briefing" | "turn" | "peer_ask";

export interface TimingSpan {
  id: number;
  kind: TimingKind;
  actor: string;
  target: string;
  startedMs: number;
  endedMs: number;
  detail: string;
}

export interface KindTotal {
  kind: TimingKind;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface MissionTimings {
  spans: TimingSpan[];
  summary: { wallMs: number; byKind: KindTotal[]; slowest: TimingSpan[] };
}

export interface AgentBandComparison {
  band: string;
  sampleSize: number;
  medianActiveMs: number | null;
  medianWallMs: number | null;
  medianCostEstimate: number | null;
  timeGainPercent: number | null;
  costGainPercent: number | null;
}

export interface MissionEfficiency {
  activeMs: number | null;
  wallMs: number | null;
  costEstimate: number | null;
  agents: number;
  historyLimit: number;
  historySize: number;
  timeGainPercent: number | null;
  costGainPercent: number | null;
  byAgentBand: AgentBandComparison[];
}

export type NewSpan = Pick<TimingSpan, "kind" | "startedMs" | "endedMs"> & Partial<Pick<TimingSpan, "actor" | "target" | "detail">>;

/** Graba una etapa. Medir nunca puede romper la misión: un fallo se descarta. */
export function recordSpan(missionId: string, span: NewSpan): void {
  if (!(span.endedMs >= span.startedMs && span.startedMs > 0)) return;
  invoke("mission_timing_add", { missionId, span }).catch(() => undefined);
}

export const getTimings = (missionId: string) => invoke<MissionTimings>("mission_timings", { missionId });
export const getMissionEfficiency = (missionId: string) => invoke<MissionEfficiency>("mission_efficiency", { missionId });

/** "1 min 05 s", "12 s", "0,8 s": para mostrar una duración sin ruido. Pura. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Qué parte del total ocupa un tipo de etapa, en porcentaje entero. Pura. */
export function shareOf(totalMs: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return Math.min(100, Math.round((totalMs / wallMs) * 100));
}
