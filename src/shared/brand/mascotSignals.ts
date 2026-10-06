import { FAILED_WINDOW_MS, type MascotSignals } from "./Mascot";

/** O mínimo que o humor precisa de uma tarefa da frota. */
interface TaskLike {
  status: string;
  endedAt: number | null;
}

/**
 * Os sinais de tempo do mascote, a partir da frota. Puro: o relógio entra como argumento.
 *
 * - `recentFailure`: a tarefa que terminou por último falhou dentro da janela de `FAILED_WINDOW_MS`.
 * - `idleMs`: há quanto tempo o bot está parado, contado do último momento em que algo estava
 *   ativo (`lastBusyAt`) ou de quando a última tarefa terminou, o que for mais recente.
 */
export function mascotSignalsFrom(tasks: readonly TaskLike[], now: number, lastBusyAt: number): MascotSignals {
  let lastEnded: TaskLike | null = null;
  for (const t of tasks) {
    if (t.endedAt != null && (lastEnded?.endedAt == null || t.endedAt > lastEnded.endedAt)) lastEnded = t;
  }
  const endedAt = lastEnded?.endedAt ?? 0;
  const recentFailure = lastEnded?.status === "failed" && now - endedAt < FAILED_WINDOW_MS;
  const lastActive = Math.max(lastBusyAt, endedAt);
  return { recentFailure, idleMs: Math.max(0, now - lastActive) };
}
