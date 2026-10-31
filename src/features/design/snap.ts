import type { Box } from "./camera";

/**
 * Mover, redimensionar e alinhar pranchetas: tudo em px de MUNDO, com o limiar de snap medido em px
 * de TELA (8 px, o mesmo em qualquer zoom). Puro.
 */
export const SNAP_SCREEN_PX = 8;
export const MIN_BOARD = 120;
export const MAX_BOARD = 8000;
/** Convenções de layout: 80 px entre pranchetas numa linha. */
export const BOARD_COL_GAP = 80;

/** Uma guia de alinhamento desenhada durante o arrasto (`pos` no eixo, de `from` a `to` no outro). */
export interface Guide { axis: "x" | "y"; pos: number; from: number; to: number }

const edgesX = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const edgesY = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];

/** O menor ajuste (com sinal) que encosta um dos `mine` num dos `theirs`, se couber no limiar. */
function nearest(mine: number[], theirs: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const m of mine) {
    for (const t of theirs) {
      const delta = t - m;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: t };
    }
  }
  return best;
}

function guidesFor(rect: Box, others: Box[], axis: "x" | "y", pos: number): Guide {
  const touching = others.filter((o) => (axis === "x" ? edgesX(o) : edgesY(o)).some((e) => Math.abs(e - pos) < 0.5));
  const all = [rect, ...touching];
  return axis === "x"
    ? { axis, pos, from: Math.min(...all.map((b) => b.y)), to: Math.max(...all.map((b) => b.y + b.h)) }
    : { axis, pos, from: Math.min(...all.map((b) => b.x)), to: Math.max(...all.map((b) => b.x + b.w)) };
}

/** Move `rect` e, com `snap`, encosta as bordas/centro nas das outras pranchetas (8 px de tela). */
export function snapMove(rect: Box, others: Box[], scale: number, snap = true): { x: number; y: number; guides: Guide[] } {
  if (!snap || others.length === 0) return { x: rect.x, y: rect.y, guides: [] };
  const threshold = SNAP_SCREEN_PX / scale;
  const sx = nearest(edgesX(rect), others.flatMap(edgesX), threshold);
  const sy = nearest(edgesY(rect), others.flatMap(edgesY), threshold);
  const moved = { ...rect, x: rect.x + (sx?.delta ?? 0), y: rect.y + (sy?.delta ?? 0) };
  const guides: Guide[] = [];
  if (sx) guides.push(guidesFor(moved, others, "x", sx.at));
  if (sy) guides.push(guidesFor(moved, others, "y", sy.at));
  return { x: moved.x, y: moved.y, guides };
}

export type Corner = "nw" | "ne" | "sw" | "se";

/**
 * Redimensiona pela alça de um canto: o canto oposto fica parado. `dx`/`dy` em px de mundo desde o
 * início do arrasto. Tamanho entre 120 e 8000; `keepAspect` (Shift) mantém a proporção; `snap`
 * (desligado com ⌘/Ctrl) encosta as bordas que se movem nas das outras.
 */
export function resizeFromCorner(start: Box, corner: Corner, dx: number, dy: number,
  opts: { keepAspect?: boolean; snap?: boolean; others?: Box[]; scale?: number; min?: number; max?: number } = {}): Box & { guides: Guide[] } {
  const { keepAspect = false, snap = true, others = [], scale = 1, min = MIN_BOARD, max = MAX_BOARD } = opts;
  const clampSize = (v: number) => Math.min(max, Math.max(min, v));
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (west) left += dx; else right += dx;
  if (north) top += dy; else bottom += dy;

  const guides: Guide[] = [];
  if (snap && others.length > 0) {
    const threshold = SNAP_SCREEN_PX / scale;
    const xs = others.flatMap((o) => [o.x, o.x + o.w]);
    const ys = others.flatMap((o) => [o.y, o.y + o.h]);
    const sx = nearest([west ? left : right], xs, threshold);
    const sy = nearest([north ? top : bottom], ys, threshold);
    if (sx) { if (west) left += sx.delta; else right += sx.delta; }
    if (sy) { if (north) top += sy.delta; else bottom += sy.delta; }
    const now = { x: left, y: top, w: right - left, h: bottom - top };
    if (sx) guides.push(guidesFor(now, others, "x", sx.at));
    if (sy) guides.push(guidesFor(now, others, "y", sy.at));
  }

  let w = clampSize(right - left);
  let h = clampSize(bottom - top);
  if (keepAspect && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    // Manda o eixo que mais mudou; o outro segue a proporção.
    if (Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h) h = clampSize(w / ratio);
    else w = clampSize(h * ratio);
  }
  return { x: west ? start.x + start.w - w : start.x, y: north ? start.y + start.h - h : start.y, w, h, guides };
}

/** O retângulo entre dois pontos, em qualquer ordem. */
export function normalizeRect(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** As caixas que o retângulo de seleção (marquee) toca. */
export function marqueeHits<T extends Box & { id: string }>(rect: Box, items: T[]): string[] {
  if (rect.w <= 0 && rect.h <= 0) return [];
  return items.filter((b) => rect.x < b.x + b.w && b.x < rect.x + rect.w && rect.y < b.y + b.h && b.y < rect.y + rect.h).map((b) => b.id);
}

/** Onde entra uma prancheta nova: à direita da mais à direita, +80 px, no menor y. Vazio: (0, 0). */
export function nextBoardSlot(boards: Box[]): { x: number; y: number } {
  if (boards.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...boards.map((b) => b.x + b.w)) + BOARD_COL_GAP, y: Math.min(...boards.map((b) => b.y)) };
}

/**
 * Pranchetas criadas pelo CLI sem posição caem todas no mesmo ponto. As que repetem o (x, y) de uma
 * anterior vão para o próximo lugar livre; as outras ficam onde estão (a pessoa pode ter arrumado à
 * mão, inclusive sobrepondo de propósito). Devolve a lista exibida e quais ids foram deslocados.
 */
export function unstack<T extends Box & { id: string }>(boards: T[]): { boards: T[]; moved: string[] } {
  const seen = new Set<string>();
  const placed: T[] = [];
  const moved: string[] = [];
  for (const b of boards) {
    const key = `${b.x},${b.y}`;
    if (seen.has(key)) {
      const slot = nextBoardSlot(placed);
      placed.push({ ...b, ...slot });
      moved.push(b.id);
    } else {
      placed.push(b);
    }
    seen.add(key);
    seen.add(`${placed[placed.length - 1].x},${placed[placed.length - 1].y}`);
  }
  return { boards: moved.length > 0 ? placed : boards, moved };
}
