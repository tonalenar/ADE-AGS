export interface Viewport { zoom: number; x: number; y: number }
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const INITIAL_VIEWPORT: Viewport = { zoom: 1, x: 0, y: 0 };

export type ViewportAction =
  | { type: "pan"; dx: number; dy: number }
  /** Zoom por um fator, mantendo fixo o ponto (cx, cy) da tela. */
  | { type: "zoomBy"; factor: number; cx: number; cy: number }
  | { type: "zoomTo"; zoom: number; cx: number; cy: number }
  | { type: "set"; viewport: Viewport }
  | { type: "reset" };

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function viewportReducer(v: Viewport, a: ViewportAction): Viewport {
  switch (a.type) {
    case "pan":
      return { ...v, x: v.x + a.dx, y: v.y + a.dy };
    case "zoomBy":
      return viewportReducer(v, { type: "zoomTo", zoom: v.zoom * a.factor, cx: a.cx, cy: a.cy });
    case "zoomTo": {
      const zoom = clamp(a.zoom);
      const k = zoom / v.zoom;
      return { zoom, x: a.cx - (a.cx - v.x) * k, y: a.cy - (a.cy - v.y) * k };
    }
    case "set":
      return a.viewport;
    case "reset":
      return INITIAL_VIEWPORT;
  }
}

export const zoomPercent = (v: Viewport) => `${Math.round(v.zoom * 100)}%`;

/** Enquadra todas as pranchetas na área visível (com margem). */
export function fitViewport(boxes: { x: number; y: number; w: number; h: number }[], width: number, height: number, margin = 48): Viewport {
  if (boxes.length === 0 || width <= 0 || height <= 0) return INITIAL_VIEWPORT;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const zoom = clamp(Math.min((width - margin * 2) / (maxX - minX), (height - margin * 2) / (maxY - minY)));
  return { zoom, x: (width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (height - (maxY - minY) * zoom) / 2 - minY * zoom };
}
