import type { Rect } from "@/features/tabs/layout/layoutStore";

/** Espessura do anel invisível em volta da miniatura (fora da vista nativa, que fica por cima do DOM). */
export const FLOAT_RING = 10;
const GAP = 8;
export const FLOAT_MIN_WIDTH = 220;
export const FLOAT_MIN_HEIGHT = 160;
/** Espaço vertical aproximado da dock flutuante quando fica colada embaixo da miniatura. */
export const FLOAT_DOCK_HEIGHT = 44;

/** Caixa onde a miniatura pode ficar, no sistema do shell. */
export type FloatBounds = { left: number; top: number; right: number; bottom: number };

/** Quais lados um arraste puxa. Nenhum lado = mover. */
export type FloatEdges = { left?: boolean; top?: boolean; right?: boolean; bottom?: boolean };

function minDimensions(aspectRatio: number | null | undefined): { minW: number; minH: number } {
  if (!aspectRatio || aspectRatio <= 0) return { minW: FLOAT_MIN_WIDTH, minH: FLOAT_MIN_HEIGHT };
  return {
    minW: aspectRatio >= 1 ? Math.round(FLOAT_MIN_HEIGHT * aspectRatio) : FLOAT_MIN_HEIGHT,
    minH: aspectRatio >= 1 ? FLOAT_MIN_HEIGHT : Math.round(FLOAT_MIN_HEIGHT / aspectRatio),
  };
}

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

/** Prende a miniatura dentro da conversa, mantendo a proporção quando um `aspectRatio` está ativo. */
export function clampFloatRect(rect: Rect, b: FloatBounds, aspectRatio: number | null = null): Rect {
  const availW = Math.max(1, b.right - b.left - 2 * GAP);
  const availH = Math.max(1, b.bottom - b.top - 2 * GAP);
  if (!aspectRatio || aspectRatio <= 0) {
    const width = Math.round(Math.max(FLOAT_MIN_WIDTH, Math.min(rect.width, availW)));
    const height = Math.round(Math.max(FLOAT_MIN_HEIGHT, Math.min(rect.height, availH)));
    const left = Math.max(b.left + GAP, Math.min(b.right - GAP - width, rect.left));
    const top = Math.max(b.top + GAP, Math.min(b.bottom - GAP - height, rect.top));
    return { left: Math.round(left), top: Math.round(top), width, height };
  }
  const { minW } = minDimensions(aspectRatio);
  const maxW = Math.max(1, Math.min(availW, availH * aspectRatio));
  const clampedMinW = Math.min(minW, maxW);
  let width = Math.round(Math.max(clampedMinW, Math.min(rect.width, maxW)));
  let height = Math.round(width / aspectRatio);
  if (height > availH) {
    height = Math.max(1, Math.floor(availH));
    width = Math.max(1, Math.round(height * aspectRatio));
  }
  const left = Math.max(b.left + GAP, Math.min(b.right - GAP - width, rect.left));
  const top = Math.max(b.top + GAP, Math.min(b.bottom - GAP - height, rect.top));
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/** Move (sem lados) ou redimensiona pelos lados marcados; o lado oposto fica parado. Mantém `aspectRatio` quando informado. */
export function dragFloatRect(
  start: Rect,
  edges: FloatEdges,
  dx: number,
  dy: number,
  b: FloatBounds,
  aspectRatio: number | null = null,
): Rect {
  if (!edges.left && !edges.top && !edges.right && !edges.bottom) {
    return clampFloatRect({ ...start, left: start.left + dx, top: start.top + dy }, b, aspectRatio);
  }
  if (!aspectRatio || aspectRatio <= 0) {
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

  const anchorRight = start.left + start.width;
  const anchorBottom = start.top + start.height;
  const horizontal = Boolean(edges.left || edges.right);
  const vertical = Boolean(edges.top || edges.bottom);
  const desiredWidth = start.width + (edges.right ? dx : edges.left ? -dx : 0);
  const desiredHeight = start.height + (edges.bottom ? dy : edges.top ? -dy : 0);
  // Projeta na diagonal da proporção para cantos não pularem quando horizontal e vertical mudam juntos.
  const desired = horizontal && vertical
    ? (desiredWidth + desiredHeight / aspectRatio) / (1 + 1 / (aspectRatio * aspectRatio))
    : horizontal
      ? desiredWidth
      : desiredHeight * aspectRatio;

  const maxWByBounds = edges.left ? anchorRight - (b.left + GAP) : (b.right - GAP) - start.left;
  const maxHByBounds = edges.top ? anchorBottom - (b.top + GAP) : (b.bottom - GAP) - start.top;
  const maxW = Math.max(1, Math.min(maxWByBounds, maxHByBounds * aspectRatio));
  const { minW } = minDimensions(aspectRatio);
  const effectiveMinW = Math.min(maxW, start.width < minW ? start.width : minW);

  let width = Math.round(Math.max(effectiveMinW, Math.min(maxW, desired)));
  let height = Math.round(width / aspectRatio);
  if (height > maxHByBounds) {
    height = Math.max(1, Math.floor(maxHByBounds));
    width = Math.max(1, Math.round(height * aspectRatio));
  }
  const left = edges.left ? anchorRight - width : start.left;
  const top = edges.top ? anchorBottom - height : start.top;
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/** Calcula o retângulo padrão da miniatura ancorado ao canto inferior direito da conversa. */
export function defaultFloatRect(
  b: FloatBounds,
  opts: { sourceRect?: Rect | null; aspectRatio?: number | null; currentRect?: Rect | null } = {},
): Rect {
  const mainW = Math.max(1, b.right - b.left);
  const mainH = Math.max(1, b.bottom - b.top);
  const rightPad = 18;
  // Deixa folga na base para a dock flutuante aparecer colada embaixo sem sair da conversa.
  const bottomPad = Math.min(54, Math.max(18, Math.round(mainH * 0.08)));
  const ratio = opts.aspectRatio;
  if (ratio && ratio > 0) {
    const availW = Math.max(160, mainW - rightPad - GAP);
    const availH = Math.max(160, mainH - bottomPad - GAP);
    const maxW = Math.max(1, Math.min(availW, availH * ratio));
    const targetW = ratio < 1
      ? Math.min(340, availW * 0.44, Math.min(520, availH * 0.78) * ratio)
      : Math.min(460, availW * 0.5, Math.min(400, availH * 0.72) * ratio);
    const { minW } = minDimensions(ratio);
    const desiredW = opts.currentRect?.width ?? targetW;
    let width = Math.round(Math.max(Math.min(minW, maxW), Math.min(desiredW, maxW)));
    let height = Math.round(width / ratio);
    if (height > availH) {
      height = Math.max(1, Math.floor(availH));
      width = Math.max(1, Math.round(height * ratio));
    }
    return {
      left: Math.round(Math.max(b.left + GAP, b.right - width - rightPad)),
      top: Math.round(Math.max(b.top + GAP, b.bottom - height - bottomPad)),
      width,
      height,
    };
  }
  const source = opts.sourceRect;
  const fallbackRatio = source && source.width > 0 && source.height > 0 ? source.width / source.height : 4 / 3;
  const maxWidth = Math.max(280, mainW - 24);
  const defaultWidth = Math.min(480, Math.max(320, mainW * 0.48));
  const width = Math.round(Math.min(opts.currentRect?.width ?? defaultWidth, maxWidth));
  const maxHeight = Math.max(220, mainH - bottomPad - GAP);
  const defaultHeight = width / fallbackRatio;
  const height = Math.round(Math.min(opts.currentRect?.height ?? defaultHeight, maxHeight));
  return {
    left: Math.round(Math.max(b.left + GAP, b.right - width - rightPad)),
    top: Math.round(Math.max(b.top + GAP, b.bottom - height - bottomPad)),
    width,
    height,
  };
}

/** Ajusta uma miniatura já posicionada/redimensionada para uma nova proporção (ex.: ao girar ou trocar de aparelho). */
export function fitFloatRectToRatio(current: Rect, b: FloatBounds, aspectRatio: number | null): Rect {
  if (!aspectRatio || aspectRatio <= 0) return clampFloatRect(current, b, null);
  const area = Math.max(FLOAT_MIN_WIDTH * FLOAT_MIN_HEIGHT, current.width * current.height);
  const width = Math.round(Math.sqrt(area * aspectRatio));
  const height = Math.round(width / aspectRatio);
  const cx = current.left + current.width / 2;
  const cy = current.top + current.height / 2;
  return clampFloatRect(
    { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height },
    b,
    aspectRatio,
  );
}
