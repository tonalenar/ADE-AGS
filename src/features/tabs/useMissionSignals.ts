import { useEffect, useRef, useState } from "react";

import { sustainedTabIds } from "@/features/terminal/activity";
import { useStallAlerts } from "@/features/missions/stallAlerts";

/** Cada cuánto se relee la actividad: un solo temporizador para todas las pestañas. */
const POLL_MS = 1000;

export interface MissionSignal {
  workingAgents: number;
  needsAttention: boolean;
}

function same(a: Record<string, MissionSignal>, b: Record<string, MissionSignal>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && a[k]!.workingAgents === b[k]!.workingAgents && a[k]!.needsAttention === b[k]!.needsAttention);
}

/** Pura: terminales con salida sostenida por misión + alertas de parado. */
export function missionSignals(
  index: Record<string, string>,
  sustained: string[],
  alerts: Record<string, unknown[] | undefined>,
  missionIds: string[],
): Record<string, MissionSignal> {
  const out: Record<string, MissionSignal> = {};
  for (const id of missionIds) out[id] = { workingAgents: 0, needsAttention: (alerts[id]?.length ?? 0) > 0 };
  for (const tabId of sustained) {
    const m = index[tabId];
    if (m && out[m]) out[m]!.workingAgents += 1;
  }
  return out;
}

/**
 * Señales por misión. Un único intervalo para toda la barra, que solo vuelve a renderizar
 * cuando algún número cambia, y se detiene con la ventana oculta.
 */
export function useMissionSignals(index: Record<string, string>, missionIds: string[]): Record<string, MissionSignal> {
  const alerts = useStallAlerts((s) => s.alerts);
  const [signals, setSignals] = useState<Record<string, MissionSignal>>({});
  const idsKey = missionIds.join("|");
  const latest = useRef({ index, missionIds, alerts });
  latest.current = { index, missionIds, alerts };

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const l = latest.current;
      const next = missionSignals(l.index, sustainedTabIds(), l.alerts, l.missionIds);
      setSignals((prev) => (same(prev, next) ? prev : next));
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [idsKey, index, alerts]);

  return signals;
}
