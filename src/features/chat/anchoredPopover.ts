import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const VIEWPORT_GUTTER = 12;
const TITLEBAR_SAFE_TOP = 48;
const ANCHOR_GAP = 8;

export interface AnchoredPopoverPosition {
  top: number;
  left: number;
  maxHeight: number;
}

/** Calcula a posição no viewport, mantendo uma faixa livre para a titlebar. */
export function positionAnchoredPopover(anchor: DOMRect, panel: Pick<DOMRect, "width" | "height">, viewport: { width: number; height: number }): AnchoredPopoverPosition {
  const viewportMaxHeight = Math.max(0, viewport.height - TITLEBAR_SAFE_TOP - VIEWPORT_GUTTER);
  const above = Math.max(0, anchor.top - TITLEBAR_SAFE_TOP - ANCHOR_GAP);
  const below = Math.max(0, viewport.height - VIEWPORT_GUTTER - anchor.bottom - ANCHOR_GAP);
  const openAbove = above >= panel.height || above >= below;
  const maxHeight = Math.min(viewportMaxHeight, openAbove ? above : below);
  const height = Math.min(panel.height, maxHeight);
  const desiredTop = openAbove ? anchor.top - height - ANCHOR_GAP : anchor.bottom + ANCHOR_GAP;
  const top = Math.min(Math.max(TITLEBAR_SAFE_TOP, desiredTop), Math.max(TITLEBAR_SAFE_TOP, viewport.height - height - VIEWPORT_GUTTER));
  const left = Math.min(Math.max(VIEWPORT_GUTTER, anchor.right - panel.width), Math.max(VIEWPORT_GUTTER, viewport.width - panel.width - VIEWPORT_GUTTER));
  return { top, left, maxHeight };
}

/** Popover em portal, ancorado ao gatilho e contido no viewport. */
export function useAnchoredPopover() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<AnchoredPopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const panelRect = panel.getBoundingClientRect();
      setPosition(positionAnchoredPopover(trigger.getBoundingClientRect(), panelRect, { width: window.innerWidth, height: window.innerHeight }));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel) {
      try { panel.showPopover?.(); } catch { /* Portal ao body é o fallback em WebKit sem Popover API. */ }
      const first = panel.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])");
      (first ?? panel).focus();
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      if ((event.target as Element).closest?.("[data-popup-menu]")) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      try { panel?.hidePopover?.(); } catch { /* Pode já estar fechado pelo navegador. */ }
    };
  }, [open, close]);

  const style = position ? {
    inset: "auto" as const,
    position: "fixed" as const,
    top: position.top,
    left: position.left,
    margin: 0,
    maxHeight: position.maxHeight,
    zIndex: 10000,
    display: "block",
  } : { inset: "auto" as const, position: "fixed" as const, top: 0, left: 0, margin: 0, visibility: "hidden" as const, zIndex: 10000, display: "block" };

  return { open, setOpen, close, triggerRef, panelRef, style };
}
