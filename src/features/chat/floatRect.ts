import type { Rect } from "@/features/tabs/layout/layoutStore";

/** Altura da faixa de arrastar, desenhada logo acima da miniatura (fora da vista nativa, que fica por cima do DOM). */
export const FLOAT_BAR = 28;
const GAP = 8;
export const FLOAT_MIN_WIDTH = 220;
export const FLOAT_MIN_HEIGHT = 160;

/** Caixa onde a miniatura pode ficar, no sistema do shell. */
export type FloatBounds = { left: number; top: number; right: number; bottom: number };

/** Prende a miniatura (e a faixa acima dela) dentro da conversa, sem mudar o tamanho se couber. */
export function clampFloatRect(rect: Rect, b: FloatBounds): Rect {
  const width = Math.round(Math.max(FLOAT_MIN_WIDTH, Math.min(rect.width, b.right - b.left - 2 * GAP)));
  const height = Math.round(Math.max(FLOAT_MIN_HEIGHT, Math.min(rect.height, b.bottom - b.top - 2 * GAP - FLOAT_BAR)));
  const left = Math.max(b.left + GAP, Math.min(b.right - GAP - width, rect.left));
  const top = Math.max(b.top + GAP + FLOAT_BAR, Math.min(b.bottom - GAP - height, rect.top));
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/** Redimensiona pelo canto superior esquerdo: o canto inferior direito fica parado. */
export function resizeFromTopLeft(start: Rect, dx: number, dy: number, b: FloatBounds): Rect {
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  const width = Math.max(FLOAT_MIN_WIDTH, Math.min(start.width - dx, right - b.left - GAP));
  const height = Math.max(FLOAT_MIN_HEIGHT, Math.min(start.height - dy, bottom - b.top - GAP - FLOAT_BAR));
  return { left: Math.round(right - width), top: Math.round(bottom - height), width: Math.round(width), height: Math.round(height) };
}
