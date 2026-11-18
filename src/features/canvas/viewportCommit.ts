import { geminiCanvasRect } from "@/features/desktopApps/geometry";
import { intersects, isLive, terminalRect, type Box, type Rect, type Viewport } from "./geometry";

/** Só re-renderiza o canvas quando o zoom cruza o limiar das terminais vivas. */
export function viewportNeedsRender(prev: Viewport, next: Viewport): boolean {
  return isLive(prev.zoom) !== isLive(next.zoom);
}

export function liveRectsOf(
  nodes: { id: string; box: Box }[],
  vp: Viewport,
  size: { width: number; height: number },
): Record<string, Rect> {
  const rects: Record<string, Rect> = {};
  if (!isLive(vp.zoom) || size.width === 0) return rects;
  for (const node of nodes) {
    const rect = terminalRect(node.box, vp);
    if (intersects(rect, size.width, size.height)) rects[node.id] = rect;
  }
  return rects;
}

/** Retângulos do overlay Gemini; o pan usa o mesmo viewport dos `liveRects`. */
export function desktopRectsOf(
  portals: { id: string; box: Box }[],
  vp: Viewport,
  size: { width: number; height: number },
): Record<string, Rect> {
  const rects: Record<string, Rect> = {};
  for (const portal of portals) {
    const rect = geminiCanvasRect(portal.box, vp, size);
    if (rect) rects[portal.id] = rect;
  }
  return rects;
}
