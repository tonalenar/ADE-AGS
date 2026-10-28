import type { PanelBounds } from "./ipc";
import { NOTE_HEADER_H, type Box, type Rect, type Viewport } from "@/features/canvas/geometry";

/** Bring the complete node below the toolbar, regardless of saved canvas pan/zoom. */
export function focusGeminiViewport(box: Box, size: { width: number; height: number }): Viewport {
  const width = Math.max(1, size.width - 48);
  const height = Math.max(1, size.height - 160);
  const zoom = Math.min(1, width / box.w, height / box.h);
  return { zoom, x: (size.width - box.w * zoom) / 2 - box.x * zoom,
    y: 80 + (height - box.h * zoom) / 2 - box.y * zoom };
}

/** Native children cannot be clipped by ReactFlow's CSS viewport. */
export function geminiCanvasRect(box: Box, vp: Viewport, size: { width: number; height: number }): Rect | null {
  const rect = { left: box.x * vp.zoom + vp.x + 1, top: (box.y + NOTE_HEADER_H) * vp.zoom + vp.y,
    width: (box.w - 2) * vp.zoom, height: (box.h - NOTE_HEADER_H - 1) * vp.zoom };
  return rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= size.width && rect.top + rect.height <= size.height && rect.width >= 200 && rect.height >= 200 ? rect : null;
}

export function panelBounds(rect: Pick<DOMRect, "x" | "y" | "width" | "height">, scale: number, active: boolean, blocked: boolean): PanelBounds {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale,
    visible: active && !blocked && rect.width >= 100 && rect.height >= 100 };
}

/** Native surfaces cannot be covered by a React z-index. */
export function hasNativeOverlay(root: ParentNode = document): boolean {
  if (document.activeElement?.tagName === "SELECT") return true;
  return Array.from(root.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover], [data-native-overlay]'))
    .some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}
