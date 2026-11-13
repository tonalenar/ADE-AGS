import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

// Se cargan con la primera tab de cada tipo que se muestra: el editor (CodeMirror) y el
// navegador pesan más de un megabyte y la mayoría de las sesiones arrancan solo con
// terminales.
const BrowserTab = lazy(() => import("@/features/browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));
const DiffTab = lazy(() => import("@/features/editor/DiffTab").then((m) => ({ default: m.DiffTab })));
const FileTab = lazy(() => import("@/features/editor/FileTab").then((m) => ({ default: m.FileTab })));
const GeminiDesktopTab = lazy(() => import("@/features/desktopApps/GeminiDesktopTab"));
import { focusGroup, placeStyle, usePlacements, type Rect } from "@/features/tabs/layout/layoutStore";
import { viewKey } from "@/features/tabs/layout/layoutTree";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { placeChatBrowserFloat, useChatStore } from "@/features/chat/store";
import { clampFloatRect, FLOAT_BAR, resizeFromTopLeft, type FloatBounds } from "@/features/chat/floatRect";
import { useTranslation } from "react-i18next";
import { BrowserMiniControls } from "@/features/browser/BrowserMiniControls";
import { canvasActions, useActiveBoardKey, useCanvasStore, useWorkMode } from "@/features/canvas/store";
import { comparablePath, type ViewTab } from "@/features/tabs/viewTabs";
import { useChatShell } from "@/app/uiStore";
import { isPageRoute } from "@/features/chat/chatRoutes";

/**
 * Donde se dibujan las tabs de archivo, diff y navegador: encima de las terminales.
 *
 * Una vez abiertas quedan montadas, igual que las terminales, y solo las visibles se ven —
 * una por grupo—: un navegador que se desmonta pierde la página y su estado; un editor, el
 * deshacer y el cursor. Pero se montan recién la primera vez que se muestran — las que se
 * restauran al abrir la app están en la barra sin cargar nada hasta que alguien las mira.
 */
export function ViewTabsHost() {
  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const mode = useWorkMode();
  const boardKey = useActiveBoardKey();
  const portals = useCanvasStore((s) => boardKey ? s.boards[boardKey]?.portals : undefined);
  const desktopRects = useCanvasStore((s) => s.desktopRects);
  const desktop = views.find((v) => v.kind === "desktop");
  useEffect(() => {
    if (mode !== "canvas" || !boardKey || !desktop || activeViewId !== desktop.id) return;
    const { id } = canvasActions.addPortal(boardKey, { kind: "gemini", name: "Gemini Desktop", at: { x: 20, y: 20 } });
    const box = useCanvasStore.getState().boards[boardKey]?.portals[id]?.box;
    if (box && (box.w < 640 || box.h < 420)) canvasActions.moveNode(boardKey,id,{ w: Math.max(box.w,1000), h: Math.max(box.h,700) });
    canvasActions.focusDesktop(boardKey,id);
    useViewTabsStore.getState().showTerminal();
  }, [mode, boardKey, desktop, activeViewId]);
  const keepMountedIds = useViewTabsStore((s) => s.keepMountedIds);
  const floating = useChatStore((s) => s.browserFloating);
  const chatBrowser = useChatStore((s) => s.browser);
  const pathname = useLocation().pathname;
  // O chat não é uma rota: com ele na tela, a vista que ele mostra (o navegador do painel) conta como na tela.
  const chatOn = useChatShell();
  const onWorkspace = pathname.startsWith("/workspace") || (chatOn && !isPageRoute(pathname));
  // Solo las del workspace activo tienen lugar: una de otro nunca se muestra.
  const { visible, focusedItem } = usePlacements();
  const lastRect = useRef(new Map<string, Rect | null>());
  const desktopNode = mode === "canvas" && portals ? Object.entries(portals).find(([, p]) => p.kind === "gemini") : undefined;
  const desktopRect = desktopNode && desktopRects[desktopNode[0]];
  const boardCwd = boardKey?.split("|").slice(1).join("|").split("#m:")[0];
  // No chat só aparece o navegador do painel direito (nunca o Gemini Desktop do canvas).
  const chat = chatOn;
  const floatingBrowserId = chatOn && floating ? chatBrowser?.viewId ?? null : null;
  const floatRect = useChatStore((s) => s.browserFloatRect);
  const floatView = floatingBrowserId ? views.find((v) => v.id === floatingBrowserId) : undefined;
  const placementOf = (view: ViewTab) => {
    if (view.kind === "browser" && view.id === floatingBrowserId && isPageRoute(pathname)) return undefined;
    return view.kind === "desktop" && mode === "canvas" && !chat
      ? (desktopRect && !activeViewId && boardCwd === comparablePath(view.cwd) ? { groupId: "canvas", rect: desktopRect } : undefined)
      : visible.get(viewKey(view.id));
  };

  const [seen, setSeen] = useState<Set<string>>(new Set());
  const visibleIds = views.filter((v) => placementOf(v) !== undefined).map((v) => v.id);
  const unseen = visibleIds.filter((id) => !seen.has(id)).join("|");
  useEffect(() => {
    if (unseen) setSeen((prev) => new Set([...prev, ...unseen.split("|")]));
  }, [unseen]);

  // Un click adentro de la página de un navegador no le llega a la app: el `<iframe>` se lo
  // queda. Lo que sí se nota es que la ventana pierde el foco y queda en ese `<iframe>`, y
  // con eso se sabe a qué grupo fue.
  const placementsRef = useRef(visible);
  placementsRef.current = visible;
  useEffect(() => {
    const onBlur = () => setTimeout(() => {
      const frame = document.activeElement;
      if (frame?.tagName !== "IFRAME") return;
      const key = frame.closest<HTMLElement>("[data-view-key]")?.dataset.viewKey;
      const groupId = key ? placementsRef.current.get(key)?.groupId : undefined;
      if (groupId) focusGroup(groupId);
    }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  if (views.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" }}>
      {views.map((view) => {
        const key = viewKey(view.id);
        const placement = placementOf(view);
        const shown = placement !== undefined;
        const floatingPreview = view.kind === "browser" && view.id === floatingBrowserId;
        if (!shown && !seen.has(view.id) && !keepMountedIds.includes(view.id)) return null;
        if (placement) lastRect.current.set(key, placement.rect);
        const focused = key === focusedItem && onWorkspace;
        return (
          <div
            key={view.id}
            data-view-key={key}
            style={{
              ...placeStyle(lastRect.current.get(key) ?? null),
              ...(floatingPreview ? { zIndex: 30 } : {}),
              visibility: shown ? undefined : "hidden",
              pointerEvents: shown ? "auto" : "none",
            }}
            className={floatingPreview ? "flex flex-col overflow-hidden rounded-2xl border border-gray-200 dark:border-white/12 bg-white dark:bg-surface shadow-2xl" : undefined}
            onPointerDownCapture={() => placement?.groupId && focusGroup(placement.groupId)}
          >
            {floatingPreview && <BrowserFloatGrip />}
            <Suspense fallback={null}>
              {view.kind === "file" && <FileTab view={view} active={shown && onWorkspace} focused={focused} />}
              {view.kind === "diff" && <DiffTab view={view} active={shown && onWorkspace} />}
              {view.kind === "browser" && <BrowserTab view={view} active={focused} floatingPreview={floatingPreview} />}
              {view.kind === "desktop" && <GeminiDesktopTab view={view} active={shown && onWorkspace} canvas={mode === "canvas"} />}
            </Suspense>
          </div>
        );
      })}
      {floatView && floatRect && placementOf(floatView) !== undefined && <BrowserFloatFrame rect={floatRect} />}
    </div>
  );
}

/** Controles da miniatura, no canto da página (abrem um buraco na vista nativa só enquanto aparecem). */
function BrowserFloatGrip() {
  // O mouse sobre a página nativa não chega ao DOM: quem avisa é o motor (`real-browser-mini-hover`).
  const hover = useChatStore((state) => state.browserMiniHover);
  return (
    <div className="group absolute right-2.5 top-2.5 z-40 pointer-events-auto" data-browser-mini-controls data-hover={hover}
      {...(hover ? { "data-over-webview": "" } : {})}>
      <BrowserMiniControls />
    </div>
  );
}

/** A caixa da conversa no sistema do shell, para prender a miniatura dentro dela. */
function floatBounds(el: HTMLElement): FloatBounds | null {
  const shell = el.closest<HTMLElement>("[data-chat-shell]");
  const main = shell?.querySelector<HTMLElement>("main");
  if (!shell || !main) return null;
  const s = shell.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return { left: m.left - s.left, top: m.top - s.top, right: m.right - s.left, bottom: m.bottom - s.top };
}

/**
 * Faixa para mover e alça para redimensionar a miniatura. Ficam ACIMA do retângulo da página: a vista nativa
 * é desenhada por cima do DOM, então nada dentro dela recebe o mouse.
 */
export function BrowserFloatFrame({ rect }: { rect: Rect }) {
  const { t } = useTranslation();
  const drag = useRef<{ pointerId: number; x: number; y: number; rect: Rect; mode: "move" | "resize" } | null>(null);
  const begin = (mode: "move" | "resize") => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const current = useChatStore.getState().browserFloatRect;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: current, mode };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const bounds = floatBounds(event.currentTarget);
    if (!bounds) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    placeChatBrowserFloat(start.mode === "move"
      ? clampFloatRect({ ...start.rect, left: start.rect.left + dx, top: start.rect.top + dy }, bounds)
      : resizeFromTopLeft(start.rect, dx, dy, bounds));
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div data-browser-float-frame className="absolute z-30 flex items-center gap-1 rounded-t-xl border border-b-0 border-gray-200 bg-white/95 px-1 shadow-md backdrop-blur dark:border-white/12 dark:bg-gray-900/95"
      style={{ left: rect.left, top: rect.top - FLOAT_BAR, width: rect.width, height: FLOAT_BAR, pointerEvents: "auto" }}>
      <button type="button" aria-label={t("browser.mini.resize")} title={t("browser.mini.resize")}
        onPointerDown={begin("resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        className="flex size-6 shrink-0 cursor-nwse-resize touch-none items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M2 6V2h4M2 2l8 8M10 6v4H6" />
        </svg>
      </button>
      <div role="separator" aria-label={t("browser.mini.move")} title={t("browser.mini.move")}
        onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        className="flex h-full flex-1 cursor-grab touch-none items-center justify-center active:cursor-grabbing">
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-gray-300 dark:bg-white/25" />
      </div>
      <span className="size-6 shrink-0" aria-hidden="true" />
    </div>
  );
}
