import type { Rect } from "@/features/tabs/layout/layoutStore";

/** Espessura do anel invisível em volta da miniatura (fora da vista nativa, que fica por cima do DOM). */
export const FLOAT_RING = 10;
const GAP = 8;
export const FLOAT_MIN_WIDTH = 220;
export const FLOAT_MIN_HEIGHT = 160;

/** Caixa onde a miniatura pode ficar, no sistema do shell. */
export type FloatBounds = { left: number; top: number; right: number; bottom: number };

/** Quais lados um arraste puxa. Nenhum lado = mover. */
export type FloatEdges = { left?: boolean; top?: boolean; right?: boolean; bottom?: boolean };

/**
 * A caixa da conversa no sistema do shell. Procura no documento: a miniatura é desenhada pelo host das
 * vistas, que NÃO fica dentro de `[data-chat-shell]` (por isso `closest` devolvia `null` e o arraste
 * não fazia nada).
 */
export function chatFloatBounds(doc: Document = document): FloatBounds | null {
  const shell = doc.querySelector<HTMLElement>("[data-chat-shell]");
  const main = shell?.querySelector<HTMLElement>("main");
  if (!shell || !main) return null;
  const s = shell.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return { left: m.left - s.left, top: m.top - s.top, right: m.right - s.left, bottom: m.bottom - s.top };
}

/** Prende a miniatura dentro da conversa, sem mudar o tamanho se couber. */
export function clampFloatRect(rect: Rect, b: FloatBounds): Rect {
  const width = Math.round(Math.max(FLOAT_MIN_WIDTH, Math.min(rect.width, b.right - b.left - 2 * GAP)));
  const height = Math.round(Math.max(FLOAT_MIN_HEIGHT, Math.min(rect.height, b.bottom - b.top - 2 * GAP)));
  const left = Math.max(b.left + GAP, Math.min(b.right - GAP - width, rect.left));
  const top = Math.max(b.top + GAP, Math.min(b.bottom - GAP - height, rect.top));
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/** Move (sem lados) ou redimensiona pelos lados marcados; o lado oposto fica parado. */
export function dragFloatRect(start: Rect, edges: FloatEdges, dx: number, dy: number, b: FloatBounds): Rect {
  if (!edges.left && !edges.top && !edges.right && !edges.bottom) {
    return clampFloatRect({ ...start, left: start.left + dx, top: start.top + dy }, b);
  }
  let left = start.left;
  let top = start.top;
  let right = start.left + start.width;
  let bottom = start.top + start.height;
  if (edges.left) left = Math.max(b.left + GAP, Math.min(right - FLOAT_MIN_WIDTH, left + dx));
  if (edges.right) right = Math.min(b.right - GAP, Math.max(left + FLOAT_MIN_WIDTH, right + dx));
  if (edges.top) top = Math.max(b.top + GAP, Math.min(bottom - FLOAT_MIN_HEIGHT, top + dy));
  if (edges.bottom) bottom = Math.min(b.bottom - GAP, Math.max(top + FLOAT_MIN_HEIGHT, bottom + dy));
  return { left: Math.round(left), top: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}
