import { activeTabIds } from "@/features/terminal/activity";

/** Cada cuánto se mide y cada cuánto se manda lo acumulado al backend. */
export const ACTIVE_TICK_MS = 1000;
export const ACTIVE_FLUSH_MS = 10_000;

/**
 * Las misiones que están trabajando ahora: en curso y con al menos un agente suyo escribiendo.
 * Con todos los agentes quietos (esperando al usuario) no hay ninguna y el reloj no avanza. Pura.
 */
export function missionsWorking(
  activeTabs: readonly string[],
  tabToMission: Readonly<Record<string, string>>,
  running: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const tab of activeTabs) {
    const mission = tabToMission[tab];
    if (mission && running.has(mission)) out.add(mission);
  }
  return [...out];
}

/** Suma un tic a cada misión que trabaja. Pura (devuelve un mapa nuevo). */
export function accumulate(pending: ReadonlyMap<string, number>, working: readonly string[], ms: number): Map<string, number> {
  const next = new Map(pending);
  for (const id of working) next.set(id, (next.get(id) ?? 0) + ms);
  return next;
}

export function sampleWorking(tabToMission: Record<string, string>, running: ReadonlySet<string>, now = Date.now()): string[] {
  return missionsWorking(activeTabIds(now), tabToMission, running);
}
