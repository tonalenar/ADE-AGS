import { type FailureKey, failureKey } from "@/features/missions/failureClass";
import type { MissionSummary } from "@/features/missions/types";

/** Lo mínimo de una misión que mira el panel del bot. */
export type MissionLike = Pick<MissionSummary, "id" | "title" | "status" | "startedAt" | "endedAt" | "spentUsd"> & {
  activeSeconds?: number | null;
  failureClassification?: MissionSummary["failureClassification"];
  /** Marcación EXPLÍCITA de misión de prueba/E2E. Ausente o `null` = real: nunca se adivina por el título. */
  isTest?: boolean | null;
};

/** Ventana de medición en días: lo reciente pesa más que todo el historial. */
export const SUCCESS_WINDOWS = [7, 30] as const;

/** Cierres de una ventana (o de todo el historial), sin las misiones de prueba. */
export interface RateWindow {
  done: number;
  failed: number;
  cancelled: number;
  /** done / (done + failed) en 0–100, o `null` sin cerradas. Las canceladas no entran en la cuenta: se muestran aparte. */
  successRate: number | null;
}

export interface BotStats {
  total: number;
  done: number;
  running: number;
  failed: number;
  cancelled: number;
  /** Suma de lo que duró cada misión iniciada (las en curso, hasta ahora), en segundos. */
  missionSeconds: number;
  /** La misión más larga, en segundos (0 si no hubo ninguna). */
  longestSeconds: number;
  spentUsd: number;
  /** Porcentaje de las misiones cerradas que terminaron bien (0–100), o `null` sin cerradas. */
  successRate: number | null;
  /** Cuántas misiones fallidas hay por causa; sin clasificar van en `unknown`. Solo claves con al menos una. */
  failuresByClass: Partial<Record<FailureKey, number>>;
  /** Misiones marcadas como prueba/E2E: quedan fuera de `successRate` y de `windows`. */
  testCount: number;
  /** Misma cuenta que `successRate`, solo las que cerraron dentro de los últimos 7 y 30 días. */
  windows: { d7: RateWindow; d30: RateWindow };
}

function rateWindow(missions: MissionLike[]): RateWindow {
  const count = (status: MissionLike["status"]) => missions.filter((m) => m.status === status).length;
  const done = count("done");
  const failed = count("failed");
  const closed = done + failed;
  return { done, failed, cancelled: count("cancelled"), successRate: closed > 0 ? Math.round((done / closed) * 100) : null };
}

/** Cuándo cerró una misión (segundos): su fin, o su inicio si no tiene fin. `null` si nunca arrancó. */
function closedAt(m: MissionLike): number | null {
  return m.endedAt ?? m.startedAt ?? null;
}

/** Las misiones reales (sin marcar como prueba) que cerraron en los últimos `days` días. `now` en segundos. Pura. */
export function inWindow(missions: MissionLike[], now: number, days: number): MissionLike[] {
  const from = now - days * 86_400;
  return missions.filter((m) => {
    const at = closedAt(m);
    return !m.isTest && at !== null && at >= from;
  });
}

/**
 * Cuánto trabajó una misión, en segundos: SOLO el tiempo con algún agente trabajando. Las
 * misiones anteriores a esa medición (`activeSeconds` ausente) caen al reloj de pared, de que
 * arrancó a que terminó (o a `now`). Pura.
 */
export function missionSeconds(m: Pick<MissionLike, "startedAt" | "endedAt" | "activeSeconds">, now: number): number {
  if (m.activeSeconds !== undefined && m.activeSeconds !== null) return Math.max(0, m.activeSeconds);
  if (!m.startedAt) return 0;
  return Math.max(0, (m.endedAt ?? now) - m.startedAt);
}

/** Los números del panel, sacados de las misiones. `now` en segundos. Pura. */
export function botStats(missions: MissionLike[], now: number): BotStats {
  const count = (status: MissionLike["status"]) => missions.filter((m) => m.status === status).length;
  const durations = missions.map((m) => missionSeconds(m, now));
  const real = missions.filter((m) => !m.isTest);
  const all = rateWindow(real);
  return {
    total: missions.length,
    done: count("done"),
    running: count("running"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    missionSeconds: durations.reduce((a, b) => a + b, 0),
    longestSeconds: durations.reduce((a, b) => Math.max(a, b), 0),
    spentUsd: missions.reduce((a, m) => a + (Number.isFinite(m.spentUsd) ? m.spentUsd : 0), 0),
    successRate: all.successRate,
    testCount: missions.length - real.length,
    windows: {
      d7: rateWindow(inWindow(missions, now, 7)),
      d30: rateWindow(inWindow(missions, now, 30)),
    },
    failuresByClass: failuresByClass(missions),
  };
}

/** El rango del bot según su nivel: la "clase" de un RPG de 8 bits. Devuelve la clave i18n. Pura. */
export function rankKey(level: number): string {
  if (level >= 20) return "botPanel.rank.legend";
  if (level >= 12) return "botPanel.rank.boss";
  if (level >= 7) return "botPanel.rank.master";
  if (level >= 4) return "botPanel.rank.hacker";
  if (level >= 2) return "botPanel.rank.apprentice";
  return "botPanel.rank.rookie";
}

export interface Trophy {
  id: string;
  /** Glifo de 8 bits que se dibuja en la insignia. */
  glyph: string;
  unlocked: boolean;
}

/** Las conquistas: hitos reales, sacados de lo que ya pasó. Nada se desbloquea "de regalo". Pura. */
export function trophies(stats: BotStats, xp: number, level: number, busyNow: number): Trophy[] {
  return [
    { id: "firstMission", glyph: "★", unlocked: stats.done >= 1 },
    { id: "tenMissions", glyph: "✦", unlocked: stats.done >= 10 },
    { id: "marathon", glyph: "⌛", unlocked: stats.longestSeconds >= 60 * 60 },
    { id: "squadFull", glyph: "⚡", unlocked: busyNow >= 4 },
    { id: "millionTokens", glyph: "◆", unlocked: xp >= 1_000_000 },
    { id: "hundredMillion", glyph: "♛", unlocked: xp >= 100_000_000 },
    { id: "level5", glyph: "▲", unlocked: level >= 5 },
    { id: "flawless", glyph: "✔", unlocked: stats.done >= 5 && stats.failed === 0 },
  ];
}

/** "1h 05m", "12m 30s", "45s": duración corta, al estilo de un marcador. Pura. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Un número con ceros a la izquierda, como el marcador de una máquina: 000042. Pura. */
export function scoreDigits(n: number, width = 6): string {
  const v = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  const s = String(v);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

/** Las misiones más recientes primero (por inicio, o creación si nunca arrancó). Pura. */
export function recentMissions<T extends MissionLike & { createdAt?: number }>(missions: T[], limit = 12): T[] {
  return [...missions]
    .sort((a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0))
    .slice(0, limit);
}

/** Las misiones fallidas contadas por causa (`access`, `limit`, `model`, `crash`, `timeout`, `unknown`). Pura. */
export function failuresByClass(missions: MissionLike[]): Partial<Record<FailureKey, number>> {
  const out: Partial<Record<FailureKey, number>> = {};
  for (const m of missions) {
    const k = failureKey(m);
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
