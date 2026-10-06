export type MissionIndicatorState = "working" | "waiting" | "needsYou" | "done" | "failed" | "idle";

export interface MissionIndicatorSignals {
  status: string;
  /** Terminals belonging to this mission with sustained agent output. */
  workingAgents: number;
  /** A real approval, user prompt, or stalled-agent alert is pending. */
  needsAttention: boolean;
}

/** Mission status wins over stale terminal signals; a running status alone is not activity. */
export function deriveMissionIndicator(signals: MissionIndicatorSignals): {
  state: MissionIndicatorState;
  workingCount: number;
} {
  const workingCount = Number.isFinite(signals.workingAgents) ? Math.max(0, Math.floor(signals.workingAgents)) : 0;
  if (signals.status === "done") return { state: "done", workingCount: 0 };
  if (signals.status === "failed" || signals.status === "cancelled") return { state: "failed", workingCount: 0 };
  if (signals.needsAttention) return { state: "needsYou", workingCount };
  if (workingCount > 0) return { state: "working", workingCount };
  return { state: signals.status === "running" ? "waiting" : "idle", workingCount: 0 };
}
