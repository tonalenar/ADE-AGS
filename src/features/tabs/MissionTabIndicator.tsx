import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MissionIndicatorState } from "./missionIndicator";
import "./mission-tab-indicator.css";

/**
 * El bot (pixel-art, como el del QG) en miniatura. Cuadrícula de 13×10: el robot ocupa las
 * columnas 0-9 y las 10-12 son para la insignia (Z, !, check, chispas). `b` cuerpo, `d` borde,
 * `e` ojo, `a` antena, `f` llama.
 */
const BOT = [
  "....a.....",
  "....d.....",
  "..bbbbbb..",
  ".bbbbbbbb.",
  ".bebbbbeb.",
  ".bbbbbbbb.",
  "..bbbbbb..",
  "...d..d...",
];
const FLAME = ["...f..f...", "....ff...."];
const SLEEP_EYES = ".bddbbddb.";
/** Insignias de 3×3 en las columnas 10-12. */
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

/** Los píxeles de cada estado: pura, para poder probarla sin DOM. */
export function indicatorPixels(state: MissionIndicatorState): { bot: Px[]; flame: Px[]; badge: Px[]; sparkle: Px[] } {
  const rows = state === "waiting" ? BOT.map((r, i) => (i === 4 ? SLEEP_EYES : r)) : BOT;
  const badge = BADGE[state];
  const lit = state === "working" || state === "needsYou" || state === "done";
  return {
    bot: pixels(rows, 0, 0),
    flame: lit ? pixels(FLAME, 0, 8) : [],
    badge: badge ? pixels(badge, 10, 0) : [],
    sparkle: state === "done" ? pixels(SPARKLE, 10, 4) : [],
  };
}

function motionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
}

/** `true` cuando el sistema pide menos movimiento. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => motionQuery()?.matches ?? false);
  useEffect(() => {
    const mq = motionQuery();
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
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
      <svg viewBox="0 0 13 10" width="18" height="14" shapeRendering="crispEdges" aria-hidden="true">
        <g className="mti-bot">{px.bot.map(rect)}</g>
        <g className="mti-flame">{px.flame.map(rect)}</g>
        <g className="mti-badge">{px.badge.map(rect)}</g>
        <g className="mti-sparkle">{px.sparkle.map(rect)}</g>
      </svg>
      {state === "working" && workingCount > 0 && <span className="mti-count" aria-hidden="true">{workingCount}</span>}
    </span>
  );
}
