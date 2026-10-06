import { useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { MASCOT_BODY, MASCOT_FILL, MascotEyes, MascotLimbs, type EyeKind } from "@/shared/brand/Mascot";
import { useReducedMotion } from "@/shared/brand/useReducedMotion";
import type { MissionIndicatorState } from "./missionIndicator";
import "./mission-tab-indicator.css";

/**
 * El bot en miniatura: el MISMO sprite del resto de la app (`MASCOT_BODY`, `MascotLimbs`,
 * `MascotEyes`), a 1px por celda; no hay un dibujo aparte. Cuadrícula de 19×13: el robot ocupa
 * las columnas 0-15 y las 16-18 son para la insignia (Z, !, check, chispas). A este tamaño no hay
 * aura: el estado se lee por la forma y el color de los ojos, y las piernas/bracitos se mueven
 * solo cuando hay una animación.
 */
const BADGE_X = 16;
/** Insignias de 3×3 en las columnas 16-18. */
const BADGE: Partial<Record<MissionIndicatorState, string[]>> = {
  waiting: ["zzz", ".z.", "zzz"],
  needsYou: [".x.", ".x.", "..."],
  done: ["..c", "c.c", ".c."],
};
const SPARKLE = [".s.", "sss", ".s."];

export interface Px { x: number; y: number; k: string }
function pixels(rows: string[], x0: number, y0: number): Px[] {
  const out: Px[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== ".") out.push({ x: x0 + x, y: y0 + y, k: row[x]! });
  });
  return out;
}

/** La forma de los ojos de cada estado: «esperando» (la misión corre pero nadie escribe) duerme,
 *  «falló» hace una X, «concluida» sonríe en chevron, el resto mira de frente. */
export function indicatorEyes(state: MissionIndicatorState): EyeKind {
  switch (state) {
    case "waiting": return "closed";
    case "failed": return "x";
    case "done": return "chevron";
    default: return "block";
  }
}

/** Los píxeles de las insignias de cada estado y la forma de los ojos: pura, para probarla sin DOM. */
export function indicatorPixels(state: MissionIndicatorState): { eyes: EyeKind; badge: Px[]; sparkle: Px[] } {
  const badge = BADGE[state];
  return {
    eyes: indicatorEyes(state),
    badge: badge ? pixels(badge, BADGE_X, 0) : [],
    sparkle: state === "done" ? pixels(SPARKLE, BADGE_X, 4) : [],
  };
}

let pauseInstalled = false;
/** Un solo oyente para todas las pestañas: con la ventana oculta se pausan las animaciones. */
function installPauseOnHidden(): void {
  if (pauseInstalled || typeof document === "undefined") return;
  pauseInstalled = true;
  const apply = () => { document.documentElement.dataset.agsHidden = document.visibilityState === "hidden" ? "1" : "0"; };
  document.addEventListener("visibilitychange", apply);
  apply();
}

export function MissionTabIndicator({ state, workingCount }: { state: MissionIndicatorState; workingCount: number }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const prev = useRef<MissionIndicatorState>(state);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(installPauseOnHidden, []);
  useEffect(() => {
    // Anima una sola vez, al pasar a concluida con la pestaña ya abierta; al montar queda el sello.
    if (state === "done" && prev.current !== "done") setCelebrate(true);
    if (state !== "done") setCelebrate(false);
    prev.current = state;
  }, [state]);

  const label = t(`missions.indicator.${state}`, { count: workingCount });
  const px = indicatorPixels(state);
  const rect = (p: Px) => <rect key={`${p.x},${p.y}`} x={p.x} y={p.y} width="1" height="1" className={`mti-${p.k}`} />;
  const moving = !reduced;
  return (
    <span className="mti" data-state={state} data-motion={moving ? "on" : "still"} data-celebrate={celebrate && moving ? "1" : "0"}
      role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 19 13" width="19" height="13" shapeRendering="crispEdges" aria-hidden="true">
        <g className="mti-bot">
          <MascotLimbs />
          {MASCOT_BODY.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={MASCOT_FILL[r.c]} />)}
          <MascotEyes kind={px.eyes} fill="var(--mti-eye)" />
        </g>
        <g className="mti-badge">{px.badge.map(rect)}</g>
        <g className="mti-sparkle">{px.sparkle.map(rect)}</g>
      </svg>
      {state === "working" && workingCount > 0 && <span className="mti-count" aria-hidden="true">{workingCount}</span>}
    </span>
  );
}
