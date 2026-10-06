import { useEffect, type RefObject } from "react";

/**
 * O bot em repouso acompanha o cursor: os olhos olham para ele e, quando o cursor está acima, o
 * bracinho daquele lado sobe. Um único ouvinte para todos os bots (e um único requestAnimationFrame
 * por movimento), que só existe enquanto algum bot está registrado.
 */

export interface Look {
  /** Deslocamento dos olhos em unidades do sprite. */
  x: number;
  y: number;
  /** Ângulo dos bracinhos (graus) e se cada um deve aparecer. */
  armL: number;
  armR: number;
  armLOn: boolean;
  armROn: boolean;
}

/** Quanto o cursor "puxa" a olhada: some com a distância (a partir de ~200px já é o máximo). */
const REACH_PX = 200;

/** Para onde olhar dado o vetor do centro do bot até o cursor (em px). Puro. */
export function lookAt(dx: number, dy: number): Look {
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / REACH_PX);
  const up = Math.max(0, -dy / d) * k * 70;
  return {
    x: round((dx / d) * k * 0.7),
    y: round((dy / d) * k * 0.5),
    armL: 6 + (dx < 0 ? up : 0),
    armR: -6 - (dx > 0 ? up : 0),
    armLOn: dx < 0 && up > 8,
    armROn: dx > 0 && up > 8,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const registry = new Set<SVGSVGElement>();
let frame = 0;
let last: { x: number; y: number } | null = null;

function apply(el: SVGSVGElement, cx: number, cy: number) {
  const r = el.getBoundingClientRect();
  const l = lookAt(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2));
  const s = el.style;
  s.setProperty("--look-x", `${l.x}px`);
  s.setProperty("--look-y", `${l.y}px`);
  s.setProperty("--arm-l", `${l.armL}deg`);
  s.setProperty("--arm-r", `${l.armR}deg`);
  s.setProperty("--arm-l-o", l.armLOn ? "1" : "0");
  s.setProperty("--arm-r-o", l.armROn ? "1" : "0");
}

function onMove(e: PointerEvent) {
  last = { x: e.clientX, y: e.clientY };
  if (frame || document.visibilityState === "hidden") return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (last) registry.forEach((el) => apply(el, last!.x, last!.y));
  });
}

function reset(el: SVGSVGElement) {
  for (const v of ["--look-x", "--look-y", "--arm-l", "--arm-r", "--arm-l-o", "--arm-r-o"]) el.style.removeProperty(v);
}

function register(el: SVGSVGElement): () => void {
  if (registry.size === 0) window.addEventListener("pointermove", onMove, { passive: true });
  registry.add(el);
  return () => {
    registry.delete(el);
    reset(el);
    if (registry.size === 0) {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/** Registra o `<svg>` do bot para olhar o cursor enquanto `active` (repouso, com movimento). */
export function useCursorLook(ref: RefObject<SVGSVGElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    return register(el);
  }, [ref, active]);
}
