import { invoke } from "@tauri-apps/api/core";

/** Ver `missions::timings` en Rust: las etapas de una misión que se miden. */
export type TimingKind =
  | "boot" | "briefing" | "turn" | "peer_ask" | "peer_message"
  | "orchestrator_stall" | "test"
  | "start_briefing" | "start_activity" | "start_retry" | "start_stalled" | "start_all_working";

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

/** De dónde sale el tiempo activo oficial (ver `missions::active::choose`), por prioridad. */
export type ActiveSource = "mission_active" | "spans" | "wall";

export interface ActiveTime {
  ms: number | null;
  source: ActiveSource | null;
}

export interface MissionTimings {
  /** Tiempo activo oficial: el mismo de la lista, del QG y de `ags mission efficiency`. */
  active: ActiveTime;
  /** Detalle por turno: unión de los spans `turn` y `peer_ask`. */
  turnMs: number | null;
  firstDelegationMs?: number | null;
  firstDelegationSource?: "peer_message" | "span" | null;
  spans: TimingSpan[];
<<<<<<< HEAD
  summary: { wallMs: number; byKind: KindTotal[]; slowest: TimingSpan[]; bottlenecks: Bottleneck[]; testMetrics?: TestStats | null };
=======
  summary: { wallMs: number; byKind: KindTotal[]; slowest: TimingSpan[]; bottlenecks: Bottleneck[] };
  qaWaitMs?: number | null;
>>>>>>> cc/mission-43e18913-c07c-4fcf-8925-fe40e32d
}

export interface Bottleneck {
  agent: string;
  asks: number;
  blockedCallers: number;
  waitingMs: number;
  maxWaitMs: number;
  timeouts: number;
  turnMs: number;
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
  firstDelegationMs?: number | null;
  firstDelegationSource?: "peer_message" | "span" | null;
  /** Tiempo activo oficial (ver `ActiveSource`). */
  activeMs: number | null;
  activeSource: ActiveSource | null;
  /** Detalle por turno: unión de los spans `turn` y `peer_ask`. */
  turnMs: number | null;
  wallMs: number | null;
  costEstimate: number | null;
  agents: number;
  historyLimit: number;
  historySize: number;
  timeGainPercent: number | null;
  costGainPercent: number | null;
  byAgentBand: AgentBandComparison[];
  /** Ausente em missões sem `ags test`. */
  testMetrics?: TestStats | null;
}

/** Testes rodados por `ags test ...` na missão (ver `missions::timings`, kind `test`). */
export interface TestStats {
  /** Tempo gasto de fato rodando testes. */
  timeMs: number;
  /** Comandos de teste registrados (rodados ou reaproveitados). */
  commands: number;
  /** Pulados porque o hash da árvore já estava verde. */
  skippedCache: number;
  /** Pulados porque `ags test affected` só rodou o afetado. */
  skippedAffected: number;
}

/** Valores prontos para exibir "tempo em testes". Pura; `null` se não houve teste. */
export function testStatsView(tests: TestStats | null | undefined, wallMs: number | null): { time: string; share: number | null; skipped: number; affected: number; runs: number } | null {
  if (!tests || tests.commands <= 0) return null;
  return {
    time: formatDuration(tests.timeMs),
    share: wallMs && wallMs > 0 ? shareOf(tests.timeMs, wallMs) : null,
    skipped: Math.max(0, tests.skippedCache),
    affected: Math.max(0, tests.skippedAffected),
    runs: tests.commands,
  };
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

/**
 * El tiempo activo tal como se muestra en TODAS las pantallas: la lista lo recibe en segundos
 * y el resto en ms, así que se trunca a segundos para que un mismo valor se vea igual. Pura.
 */
export function formatActive(ms: number | null): string | null {
  return ms === null ? null : formatDuration(Math.floor(ms / 1000) * 1000);
}

/** Clave i18n de la fuente del tiempo activo (para rotular que no es medición directa). */
export function activeSourceKey(source: ActiveSource | null): string | null {
  return source === null ? null : `missions.efficiency.source.${source}`;
}

/** Qué parte del total ocupa un tipo de etapa, en porcentaje entero. Pura. */
export function shareOf(totalMs: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return Math.min(100, Math.round((totalMs / wallMs) * 100));
}
