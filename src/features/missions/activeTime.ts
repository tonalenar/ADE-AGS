import { sustainedTabIds } from "@/features/terminal/activity";

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

/** Un tic no vale más que esto: con la app suspendida (o el equipo dormido) no se inventa trabajo. */
export const MAX_TICK_MS = 60_000;

/**
 * Cuánto vale este tic: el tiempo real desde el anterior, no `ACTIVE_TICK_MS` fijo. Con la ventana
 * minimizada el WebView espacia los `setInterval` (hasta uno por minuto) y cada tic sumaba 1 s: el
 * tiempo activo de una misión con la app en segundo plano salía muy por debajo del real. Pura.
 */
export function tickMs(previous: number | undefined, now: number): number {
  if (previous === undefined || now <= previous) return ACTIVE_TICK_MS;
  return Math.min(now - previous, MAX_TICK_MS);
}

/** Suma un tic a cada misión que trabaja. Pura (devuelve un mapa nuevo). */
export function accumulate(pending: ReadonlyMap<string, number>, working: readonly string[], ms: number): Map<string, number> {
  const next = new Map(pending);
  for (const id of working) next.set(id, (next.get(id) ?? 0) + ms);
  return next;
}

export function sampleWorking(tabToMission: Record<string, string>, running: ReadonlySet<string>, now = Date.now()): string[] {
  return missionsWorking(sustainedTabIds(now), tabToMission, running);
}
